import { connect as connectTcp, isIP, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { SmtpFailure } from "../app/email/errors.js";
import type { EmailTransportMessage, EmailTransportSettings } from "../app/email/contracts.js";

/**
 * SMTP submission, the small subset a runtime needs to hand one message to its operator's mail server.
 *
 * `tls` connects with TLS from the first byte; `starttls` connects in the clear, requires the server to offer
 * `STARTTLS` and upgrades before anything else is said, so credentials and content never cross in the clear.
 * Certificates are always verified (`ca` exists for tests). Replies are bounded (a line, a reply, the bytes held
 * between reads), every step has a deadline, and nothing the server says is kept: a failure is recorded as one of a
 * few fixed words or `SMTP <code>`, so neither the password nor a message body can reach a log through it.
 */

export interface SmtpOptions {
  readonly host: string;
  readonly port: number;
  readonly security: "starttls" | "tls";
  readonly username?: string;
  readonly password?: string;
  readonly clientName: string;
  /** Extra trusted certificates, for tests. Verification is never turned off. */
  readonly ca?: string | Buffer;
  readonly timeouts?: { readonly connectMs?: number; readonly replyMs?: number; readonly totalMs?: number };
}

export interface SmtpEnvelope {
  readonly from: string;
  readonly to: string;
  readonly data: Uint8Array;
}

const LINE_LIMIT = 1000;
const REPLY_LINE_LIMIT = 100;
/** Bytes a server may send ahead of what the client has read. */
const HELD_LIMIT = 64 * 1024;
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EPIPE", "ECONNABORTED"]);

type SocketEvent = { readonly data: Buffer } | { readonly closed: true } | { readonly error: unknown };

interface Connection {
  socket: Socket | TLSSocket;
  readonly sockets: Array<Socket | TLSSocket>;
  events: Queue.Queue<SocketEvent>;
  buffer: Buffer;
  held: number;
}

const transient = (reason: string, code?: number) => new SmtpFailure({ kind: "transient", reason, ...(code === undefined ? {} : { code }) });
const permanent = (reason: string, code?: number) => new SmtpFailure({ kind: "permanent", reason, ...(code === undefined ? {} : { code }) });
const replyFailure = (code: number) => code >= 400 && code < 500 ? transient(`SMTP ${code}`, code) : permanent(`SMTP ${code}`, code);

const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;

/** Takes events from `socket` into a fresh queue; the previous socket's queue, if any, is no longer read. */
const listen = (connection: Connection, socket: Socket | TLSSocket) => Effect.map(Queue.unbounded<SocketEvent>(), (events) => {
  connection.socket = socket;
  connection.events = events;
  connection.held = 0;
  socket.on("data", (data: Buffer) => {
    connection.held += data.length;
    if (connection.held > HELD_LIMIT) {
      socket.destroy();
      Queue.offerUnsafe(events, { error: new Error("held limit") });
      return;
    }
    Queue.offerUnsafe(events, { data });
  });
  socket.on("error", (error) => Queue.offerUnsafe(events, { error }));
  socket.on("close", () => Queue.offerUnsafe(events, { closed: true }));
});

/** Resolves once `event` fires; an error first fails with the words for that stage. */
const settle = (socket: Socket | TLSSocket, event: "connect" | "secureConnect", tlsStage: boolean) =>
  Effect.callback<void, SmtpFailure>((resume) => {
    const done = () => { cleanup(); resume(Effect.void); };
    const failed = (error: unknown) => {
      cleanup();
      const code = errorCode(error);
      resume(Effect.fail(!tlsStage || (code !== undefined && NETWORK_CODES.has(code)) ? transient("connection failed") : transient("tls failed")));
    };
    const cleanup = () => { socket.off(event, done); socket.off("error", failed); };
    socket.once(event, done);
    socket.once("error", failed);
    return Effect.sync(cleanup);
  });

const readLine = (connection: Connection): Effect.Effect<string, SmtpFailure> => Effect.gen(function* () {
  for (;;) {
    const end = connection.buffer.indexOf(0x0a);
    if (end >= 0) {
      const line = connection.buffer.subarray(0, end);
      connection.buffer = connection.buffer.subarray(end + 1);
      if (line.length > LINE_LIMIT + 1) return yield* transient("connection failed");
      return line.toString("latin1").replace(/\r$/u, "");
    }
    if (connection.buffer.length > LINE_LIMIT) return yield* transient("connection failed");
    const event = yield* Queue.take(connection.events);
    if (!("data" in event)) return yield* transient("connection failed");
    connection.held -= event.data.length;
    connection.buffer = connection.buffer.length === 0 ? event.data : Buffer.concat([connection.buffer, event.data]);
  }
});

interface Reply { readonly code: number; readonly lines: readonly string[] }

const readReply = (connection: Connection, replyMs: number): Effect.Effect<Reply, SmtpFailure> => Effect.gen(function* () {
  const lines: string[] = [];
  for (;;) {
    const line = yield* readLine(connection);
    const parsed = /^([2-5]\d\d)([ -]|$)(.*)$/u.exec(line);
    if (!parsed || (lines.length > 0 && Number(parsed[1]) !== Number(/^\d{3}/u.exec(lines[0])?.[0]))) {
      return yield* transient("connection failed");
    }
    lines.push(line);
    if (lines.length > REPLY_LINE_LIMIT) return yield* transient("connection failed");
    if (parsed[2] !== "-") return { code: Number(parsed[1]), lines: lines.map((entry) => entry.slice(4)) };
  }
}).pipe(Effect.timeoutOrElse({ duration: replyMs, orElse: () => Effect.fail(transient("timeout")) }));

const write = (connection: Connection, data: string | Uint8Array) => Effect.callback<void, SmtpFailure>((resume) => {
  connection.socket.write(data, (error) => resume(error ? Effect.fail(transient("connection failed")) : Effect.void));
});

/** Sends one command and requires a reply in `expected`; anything else fails as that reply's code. */
const command = (connection: Connection, replyMs: number, line: string, expected: readonly number[]) => Effect.gen(function* () {
  yield* write(connection, `${line}\r\n`);
  const reply = yield* readReply(connection, replyMs);
  if (!expected.includes(reply.code)) return yield* replyFailure(reply.code);
  return reply;
});

const capabilities = (reply: Reply) => new Set(reply.lines.slice(1).map((line) => line.trim().toUpperCase()));
const offersAuthPlain = (offered: ReadonlySet<string>) =>
  [...offered].some((line) => /^AUTH[ =]/u.test(line) && line.slice(5).split(/\s+/u).includes("PLAIN"));

/** Lines beginning with a dot get another, so none ends the message early. */
export function dotStuff(data: Uint8Array): Buffer {
  const text = Buffer.from(data).toString("latin1").replace(/\r?\n/gu, "\r\n");
  const stuffed = text.replace(/(^|\r\n)\./gu, "$1..");
  return Buffer.from(stuffed.endsWith("\r\n") ? stuffed : `${stuffed}\r\n`, "latin1");
}

const envelopeAddress = (value: string) => {
  if (!/^[^\s<>\x00-\x1f\x7f]+@[^\s<>\x00-\x1f\x7f]+$/u.test(value) || value.length > 254) {
    throw new TypeError("An envelope address must be a bare address without spaces, brackets or control characters.");
  }
  return value;
};

/** Submits one message; resolves with the server's final reply code once it accepted the message. */
export function sendSmtp(options: SmtpOptions, envelope: SmtpEnvelope): Effect.Effect<{ readonly code: number }, SmtpFailure> {
  const connectMs = options.timeouts?.connectMs ?? 10_000;
  const replyMs = options.timeouts?.replyMs ?? 30_000;
  const totalMs = options.timeouts?.totalMs ?? 60_000;
  const host = options.host.replace(/^\[(.*)\]$/u, "$1");
  const servername = isIP(host) === 0 ? host : undefined;
  const tlsOptions = { host, rejectUnauthorized: true, ...(servername ? { servername } : {}), ...(options.ca === undefined ? {} : { ca: options.ca }) };
  const program = Effect.gen(function* () {
    const from = yield* Effect.try({ try: () => envelopeAddress(envelope.from), catch: () => permanent("invalid message") });
    const to = yield* Effect.try({ try: () => envelopeAddress(envelope.to), catch: () => permanent("invalid message") });
    const events = yield* Queue.unbounded<SocketEvent>();
    const connection = yield* Effect.acquireRelease(
      Effect.sync((): Connection => {
        const socket = options.security === "tls"
          ? connectTls({ port: options.port, ...tlsOptions })
          : connectTcp({ host, port: options.port });
        return { socket, sockets: [socket], events, buffer: Buffer.alloc(0), held: 0 };
      }),
      (connection) => Effect.sync(() => { for (const socket of connection.sockets) socket.destroy(); }),
    );
    yield* listen(connection, connection.socket);
    yield* settle(connection.socket, options.security === "tls" ? "secureConnect" : "connect", options.security === "tls").pipe(
      Effect.timeoutOrElse({ duration: connectMs, orElse: () => Effect.fail(transient("timeout")) }),
    );
    const greeting = yield* readReply(connection, replyMs);
    if (greeting.code !== 220) return yield* replyFailure(greeting.code);
    let offered = capabilities(yield* command(connection, replyMs, `EHLO ${options.clientName}`, [250]));
    if (options.security === "starttls") {
      if (!offered.has("STARTTLS")) return yield* permanent("starttls unavailable");
      yield* command(connection, replyMs, "STARTTLS", [220]);
      // Anything the server sent after its 220 arrived in the clear and must not be read as if it came over TLS.
      if (connection.buffer.length > 0) return yield* transient("tls failed");
      const plain = connection.socket;
      plain.removeAllListeners("data");
      plain.removeAllListeners("error");
      plain.removeAllListeners("close");
      const secure = connectTls({ socket: plain, ...tlsOptions });
      connection.sockets.push(secure);
      yield* listen(connection, secure);
      yield* settle(secure, "secureConnect", true).pipe(
        Effect.timeoutOrElse({ duration: connectMs, orElse: () => Effect.fail(transient("timeout")) }),
      );
      offered = capabilities(yield* command(connection, replyMs, `EHLO ${options.clientName}`, [250]));
    }
    if (options.username !== undefined) {
      if (!offersAuthPlain(offered)) return yield* permanent("auth unavailable");
      const token = Buffer.from(`\u0000${options.username}\u0000${options.password ?? ""}`, "utf8").toString("base64");
      yield* command(connection, replyMs, `AUTH PLAIN ${token}`, [235]);
    }
    yield* command(connection, replyMs, `MAIL FROM:<${from}>`, [250]);
    yield* command(connection, replyMs, `RCPT TO:<${to}>`, [250, 251]);
    yield* command(connection, replyMs, "DATA", [354]);
    yield* write(connection, dotStuff(envelope.data));
    yield* write(connection, ".\r\n");
    const accepted = yield* readReply(connection, replyMs);
    if (accepted.code !== 250) return yield* replyFailure(accepted.code);
    // The message is accepted; the goodbye is a courtesy whose answer changes nothing.
    yield* write(connection, "QUIT\r\n");
    return { code: accepted.code };
  });
  return Effect.scoped(program).pipe(Effect.timeoutOrElse({ duration: totalMs, orElse: () => Effect.fail(transient("timeout")) }));
}

const HEADER_UNSAFE = /[\x00-\x1f\x7f]/u;

/** One header value in RFC 2047 encoded words, split on character boundaries, folded onto continuation lines. */
function encodeWords(value: string): string {
  if (/^[\x20-\x7e]*$/u.test(value) && !/=\?/u.test(value)) return value;
  const words: string[] = [];
  let chunk = "";
  for (const character of value) {
    if (Buffer.byteLength(chunk + character, "utf8") > 39) {
      words.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk !== "") words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`).join("\r\n ");
}

const base64Lines = (value: string) => (Buffer.from(value, "utf8").toString("base64").match(/.{1,76}/gu) ?? []).join("\r\n");

/** RFC 5322 date in UTC. */
const messageDate = (date: Date) => date.toUTCString().replace(/GMT$/u, "+0000");

/**
 * A `multipart/alternative` message with a text and an HTML part, each base64. Every header value is checked for
 * control characters first: a line break in a subject or a name would be a header of the sender's choosing.
 */
export function buildMimeMessage(message: {
  readonly id: string; readonly from: string; readonly fromName?: string; readonly to: string;
  readonly subject: string; readonly text: string; readonly html: string; readonly date: Date;
}): Uint8Array {
  for (const value of [message.id, message.from, message.fromName ?? "", message.to, message.subject]) {
    if (HEADER_UNSAFE.test(value)) throw new TypeError("Email header values must not contain control characters.");
  }
  envelopeAddress(message.from);
  envelopeAddress(message.to);
  if (!/^[A-Za-z0-9_-]+$/u.test(message.id)) throw new TypeError("A message id must be a token.");
  const domain = message.from.slice(message.from.lastIndexOf("@") + 1);
  const name = message.fromName?.trim();
  const from = !name ? `<${message.from}>`
    : /^[\x20-\x7e]*$/u.test(name) ? `"${name.replace(/(["\\])/gu, "\\$1")}" <${message.from}>`
      : `${encodeWords(name)} <${message.from}>`;
  const boundary = `zv-${message.id}`;
  const lines = [
    `From: ${from}`,
    `To: <${message.to}>`,
    `Subject: ${encodeWords(message.subject)}`,
    `Date: ${messageDate(message.date)}`,
    `Message-ID: <${message.id}@${domain}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(message.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(message.html),
    `--${boundary}--`,
    "",
  ];
  return Buffer.from(lines.join("\r\n"), "latin1");
}

/** The transport the Node adapter gives every runtime's email worker. */
export function smtpTransport(defaults: Pick<SmtpOptions, "ca" | "timeouts"> = {}) {
  return (settings: EmailTransportSettings, message: EmailTransportMessage): Effect.Effect<void, SmtpFailure> => Effect.gen(function* () {
    const data = yield* Effect.try({
      try: () => buildMimeMessage({
        id: message.id, from: message.from.address, ...(message.from.name ? { fromName: message.from.name } : {}),
        to: message.to, subject: message.subject, text: message.text, html: message.html, date: message.date,
      }),
      catch: () => permanent("invalid message"),
    });
    yield* sendSmtp({ ...settings, ...defaults }, { from: message.from.address, to: message.to, data });
  });
}
