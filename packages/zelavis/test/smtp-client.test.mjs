import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Exit } from "effect";

import { buildMimeMessage, sendSmtp, smtpTransport } from "../dist/adapters/_node-smtp.js";
import { createTestCertificate, decodeWords, parseMessage, startSmtpServer } from "./_smtp-server.mjs";

const message = (overrides = {}) => ({
  id: "delivery_0001", from: "noreply@mail.example.org", fromName: "Zelavis", to: "person@example.com",
  subject: "Hello", text: "Plain body", html: "<p>HTML body</p>", date: new Date("2026-11-13T10:00:00Z"), ...overrides,
});
const options = (server, overrides = {}) => ({
  host: server.host, port: server.port, security: "starttls", clientName: "panel.example.org", ca: server.ca,
  timeouts: { connectMs: 2000, replyMs: 2000, totalMs: 5000 }, ...overrides,
});
const send = (server, overrides, envelope = {}) => Effect.runPromiseExit(sendSmtp(options(server, overrides), {
  from: "noreply@mail.example.org", to: "person@example.com", data: buildMimeMessage(message(envelope.message)), ...envelope.fields,
}));
const failure = (exit) => {
  assert.equal(exit._tag, "Failure");
  return exit.cause.reasons.find((reason) => reason._tag === "Fail").error;
};

test("STARTTLS with AUTH PLAIN delivers a multipart message after the upgrade", async (t) => {
  const server = await startSmtpServer(t, { tls: "starttls", requireAuth: { username: "mailer", password: "s3cret pass" } });
  const exit = await send(server, { username: "mailer", password: "s3cret pass" });
  assert.equal(exit._tag, "Success", String(exit.cause));
  assert.equal(exit.value.code, 250);
  const verbs = server.commands.map(({ line, secure }) => `${line.split(" ")[0]}${secure ? "+tls" : ""}`);
  assert.deepEqual(verbs.slice(0, 4), ["EHLO", "STARTTLS", "EHLO+tls", "AUTH+tls"]);
  assert.ok(server.commands.find(({ line }) => line.startsWith("AUTH PLAIN ")));
  assert.equal(server.messages.length, 1);
  const [received] = server.messages;
  assert.equal(received.secure, true);
  assert.equal(received.from, "noreply@mail.example.org");
  assert.equal(received.to, "person@example.com");
  const { headers, parts } = parseMessage(received.data);
  assert.match(headers["content-type"], /^multipart\/alternative; boundary="zv-delivery_0001"$/);
  assert.equal(headers["message-id"], "<delivery_0001@mail.example.org>");
  assert.equal(headers["mime-version"], "1.0");
  assert.equal(headers.from, '"Zelavis" <noreply@mail.example.org>');
  assert.equal(headers.to, "<person@example.com>");
  assert.equal(headers.date, "Fri, 13 Nov 2026 10:00:00 +0000");
  assert.deepEqual(parts.map(({ type, encoding, body }) => [type, encoding, body]), [
    ["text/plain", "base64", "Plain body"], ["text/html", "base64", "<p>HTML body</p>"],
  ]);
  for (const part of parts) for (const line of part.raw.split("\r\n")) assert.ok(line.length <= 76);
});

test("implicit TLS delivers on its own port", async (t) => {
  const server = await startSmtpServer(t, { tls: "implicit" });
  const exit = await send(server, { security: "tls" });
  assert.equal(exit._tag, "Success", String(exit.cause));
  assert.equal(server.messages.length, 1);
  assert.equal(server.commands[0].secure, true);
});

test("an unverified certificate is a TLS failure, never accepted", async (t) => {
  const server = await startSmtpServer(t, { tls: "implicit" });
  const error = failure(await send(server, { security: "tls", ca: undefined }));
  assert.deepEqual([error.kind, error.reason], ["transient", "tls failed"]);
  assert.equal(server.messages.length, 0);
});

test("STARTTLS verifies the configured IP against the certificate before authenticating", async (t) => {
  const certificate = await createTestCertificate("DNS:localhost");
  const server = await startSmtpServer(t, { tls: "starttls", certificate });
  const error = failure(await send(server, { username: "mailer", password: "fixture password" }));
  assert.deepEqual([error.kind, error.reason], ["transient", "tls failed"]);
  assert.deepEqual(server.commands.map(({ line }) => line.split(" ")[0]), ["EHLO", "STARTTLS"]);
  assert.equal(server.messages.length, 0);
});

test("a server without STARTTLS is refused before any credential is sent", async (t) => {
  const server = await startSmtpServer(t, { tls: "starttls", offerStartTls: false, authInClear: true });
  const error = failure(await send(server, { username: "mailer", password: "s3cret pass" }));
  assert.deepEqual([error._tag, error.kind, error.reason], ["SmtpFailure", "permanent", "starttls unavailable"]);
  assert.ok(!server.commands.some(({ line }) => line.startsWith("AUTH")));
  assert.equal(server.messages.length, 0);
});

test("a credential the server does not offer to take is refused, not sent", async (t) => {
  const server = await startSmtpServer(t, { tls: "implicit", reply: (line) => line.startsWith("EHLO") ? "250 fixture" : undefined });
  const error = failure(await send(server, { security: "tls", username: "mailer", password: "pw" }));
  assert.deepEqual([error.kind, error.reason], ["permanent", "auth unavailable"]);
  assert.ok(!server.commands.some(({ line }) => line.startsWith("AUTH")));
});

test("4xx replies are transient and 5xx permanent, each with its code", async (t) => {
  const busy = await startSmtpServer(t, { tls: "implicit", reply: (line) => line.startsWith("RCPT") ? "451 try later" : undefined });
  const transient = failure(await send(busy, { security: "tls" }));
  assert.deepEqual([transient.kind, transient.code, transient.reason], ["transient", 451, "SMTP 451"]);
  const refused = await startSmtpServer(t, { tls: "implicit", reply: (line) => line.startsWith("RCPT") ? "550 no such user" : undefined });
  const permanent = failure(await send(refused, { security: "tls" }));
  assert.deepEqual([permanent.kind, permanent.code, permanent.reason], ["permanent", 550, "SMTP 550"]);
  assert.equal(busy.messages.length + refused.messages.length, 0);
});

test("a silent server times out as a transient failure within the reply deadline", async (t) => {
  const server = await startSmtpServer(t, { tls: "implicit", reply: (line) => line.startsWith("MAIL") ? null : undefined });
  const started = Date.now();
  const error = failure(await send(server, { security: "tls", timeouts: { connectMs: 2000, replyMs: 300, totalMs: 5000 } }));
  assert.deepEqual([error.kind, error.reason], ["transient", "timeout"]);
  assert.ok(Date.now() - started < 2000);
});

test("a refused connection is transient", async (t) => {
  const server = await startSmtpServer(t, { tls: "implicit" });
  await server.close();
  const error = failure(await send(server, { security: "tls" }));
  assert.deepEqual([error.kind, error.reason], ["transient", "connection failed"]);
});

test("dot-stuffing keeps a line that starts with a dot", async (t) => {
  const server = await startSmtpServer(t, { tls: "implicit" });
  const data = new TextEncoder().encode("Subject: x\r\n\r\n.hidden line\r\n..two dots\r\nend\r\n");
  const exit = await Effect.runPromiseExit(sendSmtp(options(server, { security: "tls" }), { from: "a@b.example", to: "c@d.example", data }));
  assert.equal(exit._tag, "Success", String(exit.cause));
  assert.equal(server.messages[0].data, "Subject: x\r\n\r\n.hidden line\r\n..two dots\r\nend\r\n");
});

test("a non-ASCII subject is encoded as RFC 2047 words and decodes back", async (t) => {
  const server = await startSmtpServer(t, { tls: "implicit" });
  const subject = "Überprüfung — 確認してください, a long subject that needs several encoded words to fit";
  const exit = await send(server, { security: "tls" }, { message: { subject, fromName: "Zélavis Ops" } });
  assert.equal(exit._tag, "Success", String(exit.cause));
  const { headers } = parseMessage(server.messages[0].data);
  assert.match(headers.subject, /^=\?UTF-8\?B\?/);
  assert.equal(decodeWords(headers.subject).replace(/ /g, ""), subject.replace(/ /g, ""));
  for (const line of server.messages[0].data.split("\r\n\r\n")[0].split("\r\n")) assert.ok(line.length <= 78, line);
  assert.equal(decodeWords(headers.from.replace(/ <.*$/, "")), "Zélavis Ops");
});

test("header injection is refused before connecting", async (t) => {
  const server = await startSmtpServer(t, { tls: "implicit" });
  assert.throws(() => buildMimeMessage(message({ subject: "Hi\r\nBcc: victim@example.com" })), /control characters/);
  assert.throws(() => buildMimeMessage(message({ to: "a@b.example>\r\nRCPT TO:<c@d.example" })));
  const transport = smtpTransport({ ca: server.ca });
  const exit = await Effect.runPromiseExit(transport({ host: server.host, port: server.port, security: "tls", clientName: "x.example" }, {
    id: "delivery_0002", from: { address: "a@b.example" }, to: "c@d.example", subject: "Hi\r\nBcc: v@e.example", text: "", html: "", date: new Date(),
  }));
  assert.deepEqual([failure(exit).kind, failure(exit).reason], ["permanent", "invalid message"]);
  assert.equal(server.connections, 0);
  assert.equal(Exit.isFailure(exit), true);
});
