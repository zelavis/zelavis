// A local SMTP submission server for tests: STARTTLS on a plain port or TLS from the first byte, optional AUTH PLAIN,
// and a hook that replaces any reply. It records every command (and whether it arrived over TLS) and every message.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer, TLSSocket } from "node:tls";
import { promisify } from "node:util";

const run = promisify(execFile);
let certificate;

export async function createTestCertificate(subjectAltName) {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-smtp-cert-"));
  try {
    const keyFile = join(directory, "key.pem"), certFile = join(directory, "cert.pem");
    await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1",
      "-subj", "/CN=localhost", "-addext", `subjectAltName=${subjectAltName}`]);
    return { key: await readFile(keyFile, "utf8"), cert: await readFile(certFile, "utf8") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** One self-signed certificate for localhost and 127.0.0.1, made once per test process. */
export function testCertificate() {
  certificate ??= createTestCertificate("DNS:localhost,IP:127.0.0.1");
  return certificate;
}

/**
 * Starts a server and closes it after the test.
 * - `tls`: "starttls" (plain port, offers STARTTLS unless `offerStartTls: false`) or "implicit".
 * - `requireAuth`: `{ username, password }`; AUTH PLAIN is offered only over TLS.
 * - `reply(command)`: a reply line to send instead of the usual one, `null` to send nothing, or undefined.
 */
export async function startSmtpServer(t, options = {}) {
  const { key, cert } = options.certificate ?? await testCertificate();
  const commands = [];
  const messages = [];
  const sockets = new Set();
  let connections = 0;
  const serve = (initial, startSecure) => {
    connections++;
    let socket = initial;
    let secure = startSecure;
    let buffer = "";
    let data;
    let envelope = {};
    sockets.add(initial);
    const send = (line) => { if (!socket.destroyed) socket.write(`${line}\r\n`); };
    const answer = (command, usual) => {
      const custom = options.reply?.(command);
      if (custom === null) return;
      send(custom ?? usual);
    };
    const onLine = (line) => {
      commands.push({ line, secure });
      const verb = line.split(" ", 1)[0].toUpperCase();
      if (verb === "EHLO") {
        const lines = ["250-fixture"];
        if (options.tls !== "implicit" && !secure && options.offerStartTls !== false) lines.push("250-STARTTLS");
        if (secure || options.authInClear) lines.push("250-AUTH LOGIN PLAIN");
        lines.push("250 8BITMIME");
        const custom = options.reply?.(line);
        if (custom === null) return;
        socket.write(`${custom ?? lines.join("\r\n")}\r\n`);
      } else if (verb === "STARTTLS") {
        const custom = options.reply?.(line);
        if (custom === null) return;
        send(custom ?? "220 ready");
        if (custom !== undefined) return;
        socket.removeAllListeners("data");
        const upgraded = new TLSSocket(socket, { isServer: true, key, cert });
        sockets.add(upgraded);
        socket = upgraded;
        secure = true;
        buffer = "";
        upgraded.on("data", onData);
        upgraded.on("error", () => upgraded.destroy());
      } else if (verb === "AUTH") {
        const token = line.split(" ")[2] ?? "";
        const [, username, password] = Buffer.from(token, "base64").toString("utf8").split("\u0000");
        const ok = !options.requireAuth || (username === options.requireAuth.username && password === options.requireAuth.password);
        answer(line, ok ? "235 accepted" : "535 rejected");
        envelope.authenticated = ok;
      } else if (verb === "MAIL") {
        if (options.requireAuth && !envelope.authenticated) return answer(line, "530 authentication required");
        envelope.from = /<(.*)>/.exec(line)?.[1];
        answer(line, "250 ok");
      } else if (verb === "RCPT") {
        envelope.to = /<(.*)>/.exec(line)?.[1];
        answer(line, "250 ok");
      } else if (verb === "DATA") {
        const custom = options.reply?.(line);
        if (custom === null) return;
        send(custom ?? "354 go ahead");
        if (custom === undefined) data = "";
      } else if (verb === "QUIT") {
        send("221 bye");
        socket.end();
      } else {
        answer(line, "502 unknown");
      }
    };
    const onData = (chunk) => {
      buffer += chunk.toString("latin1");
      for (;;) {
        if (data !== undefined) {
          const end = buffer.indexOf("\r\n.\r\n");
          const startEnd = data === "" && buffer.startsWith(".\r\n") ? 0 : -1;
          if (end < 0 && startEnd < 0) return;
          const body = startEnd === 0 ? "" : buffer.slice(0, end + 2);
          buffer = buffer.slice(startEnd === 0 ? 3 : end + 5);
          data = undefined;
          const unstuffed = body.replace(/(^|\r\n)\.\./g, "$1.");
          const custom = options.reply?.("<data>");
          if (custom === undefined || custom?.startsWith("250")) messages.push({ ...envelope, data: unstuffed, secure });
          if (custom !== null) send(custom ?? "250 queued");
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        onLine(line);
      }
    };
    initial.on("data", onData);
    initial.on("error", () => initial.destroy());
    initial.on("close", () => sockets.delete(initial));
    const greeting = options.reply?.("<greeting>");
    if (greeting !== null) send(greeting ?? "220 fixture ESMTP");
  };
  const server = options.tls === "implicit"
    ? createTlsServer({ key, cert }, (socket) => serve(socket, true))
    : createServer((socket) => serve(socket, false));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = () => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  });
  t.after(close);
  return {
    host: "127.0.0.1",
    port: server.address().port,
    ca: cert,
    commands,
    messages,
    get connections() { return connections; },
    close,
  };
}

/** The decoded parts and headers of a message the fixture received. */
export function parseMessage(data) {
  const [head] = data.split("\r\n\r\n", 1);
  const headers = Object.fromEntries(head.replace(/\r\n /g, " ").split("\r\n").map((line) => {
    const colon = line.indexOf(":");
    return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
  }));
  const boundary = /boundary="([^"]+)"/.exec(headers["content-type"] ?? "")?.[1];
  const parts = boundary ? data.split(`--${boundary}`).slice(1, -1).map((part) => {
    const [partHead, ...rest] = part.replace(/^\r\n/, "").split("\r\n\r\n");
    return { type: /content-type: ([^;\r\n]+)/i.exec(partHead)?.[1], encoding: /content-transfer-encoding: (\S+)/i.exec(partHead)?.[1],
      raw: rest.join("\r\n\r\n"), body: Buffer.from(rest.join("\r\n\r\n").replace(/\r\n/g, ""), "base64").toString("utf8") };
  }) : [];
  return { headers, parts };
}

/** RFC 2047 encoded words back to text. */
export function decodeWords(value) {
  return value.replace(/=\?UTF-8\?B\?([^?]*)\?=\s*/gi, (_, encoded) => Buffer.from(encoded, "base64").toString("utf8")).trim();
}
