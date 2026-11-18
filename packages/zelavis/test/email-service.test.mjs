import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { createMemorySystemStore, Zelavis, zelavis } from "../dist/index.js";
import { nodeAdapter } from "../dist/adapters/node.js";
import { createLocalSqliteSystemStore } from "../dist/adapters/_sqlite-system-store.js";
import { smtpTransport } from "../dist/adapters/_node-smtp.js";
import { createEmailSubsystem, SmtpFailure } from "../dist/app/email/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runEmailCommand } from "../dist/cli/email-operations.js";
import { runProjectsCommand } from "../dist/cli/projects.js";
import { OWNER, platform } from "./_runtime.mjs";
import { parseMessage, startSmtpServer, testCertificate } from "./_smtp-server.mjs";

const timeouts = { connectMs: 2000, replyMs: 2000, totalMs: 5000 };
const settingsFor = (server, overrides = {}) => ({
  expectedRevision: 0,
  mode: "smtp",
  from: { address: "noreply@mail.example.org", name: "Zelavis" },
  linkBaseUrl: "https://panel.example.org/zelavis",
  smtp: { host: server.host, port: server.port, security: "tls" },
  ...overrides,
});
const eventually = async (check, label, ms = 10_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const run = (effect) => Effect.runPromise(effect);
const subsystem = (store, server, clock, overrides = {}) => createEmailSubsystem({
  store, authority: "platform", send: smtpTransport({ ca: server.ca, timeouts }), now: () => new Date(clock.at), ...overrides,
});
const deliveriesOf = async (email) => (await run(email.outbox.list({ limit: 100 }))).deliveries;

test("settings are revisioned, the password is encrypted at rest and never answered", async (t) => {
  const store = createMemorySystemStore();
  const server = await startSmtpServer(t, { tls: "implicit" });
  const p = await platform(t, { systemStore: store, subsystems: { email: { send: smtpTransport({ ca: server.ca }) } } });
  assert.deepEqual(await p.send("GET", "/email/settings"), { revision: 0, mode: "disabled" });
  const input = settingsFor(server, { smtp: { host: server.host, port: server.port, security: "tls", username: "mailer", password: "smtp secret 1" } });
  const saved = await p.send("PUT", "/email/settings", input);
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.smtp, { host: server.host, port: server.port, security: "tls", username: "mailer", hasPassword: true });
  await assert.rejects(p.send("PUT", "/email/settings", input), (error) => error.status === 409 && error.body.code === "email_settings_conflict");
  const read = await p.send("GET", "/email/settings");
  assert.equal(JSON.stringify(read).includes("smtp secret 1"), false);
  assert.equal(read.smtp.hasPassword, true);
  const raw = await store.get("zelavis.email", "settings");
  assert.equal(JSON.stringify(raw.value).includes("smtp secret 1"), false);
  assert.equal(raw.value.smtp.password.algorithm, "AES-256-GCM");

  // Absent keeps it for the same server and user, "" removes it, a new host asks for it again.
  const kept = await p.send("PUT", "/email/settings", { ...input, expectedRevision: 1, smtp: { ...input.smtp, password: undefined } });
  assert.equal(kept.smtp.hasPassword, true);
  await assert.rejects(p.send("PUT", "/email/settings", { ...input, expectedRevision: 2, smtp: { ...input.smtp, host: "other.example.org", password: undefined } }),
    (error) => error.status === 400 && error.body.code === "invalid_email_settings");
  const removed = await p.send("PUT", "/email/settings", { ...input, expectedRevision: 2, smtp: { host: server.host, port: server.port, security: "tls" } });
  assert.equal(removed.smtp.hasPassword, false);
  assert.equal((await store.get("zelavis.email", "settings")).value.smtp.password, undefined);
});

test("SMTP mode needs a sender, a valid link base and a server", async (t) => {
  const p = await platform(t);
  const server = { host: "127.0.0.1", port: 465 };
  const refused = async (body) => assert.rejects(p.send("PUT", "/email/settings", body),
    (error) => error.status === 400 && error.body.code === "invalid_email_settings");
  await refused(settingsFor(server, { linkBaseUrl: undefined }));
  await refused(settingsFor(server, { linkBaseUrl: "http://example.com" }));
  await refused(settingsFor(server, { linkBaseUrl: "https://panel.example.org/?next=x" }));
  await refused(settingsFor(server, { linkBaseUrl: "https://panel.example.org/#x" }));
  await refused(settingsFor(server, { from: { address: "a@b.example\r\nBcc: c@d.example" } }));
  await refused(settingsFor(server, { from: { address: "a@b.example", name: "Ops\r\nBcc: x" } }));
  await refused({ ...settingsFor(server), unknown: true });
  assert.equal((await p.send("PUT", "/email/settings", settingsFor(server))).linkBaseUrl, "https://panel.example.org/zelavis");
  assert.equal((await p.send("PUT", "/email/settings", settingsFor(server, { expectedRevision: 1, linkBaseUrl: "http://127.0.0.1:3000/zelavis" }))).revision, 2);
  const tooLarge = await p.through("http://localhost/zelavis/api/v1/email/settings", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...settingsFor(server), pad: "x".repeat(9000) }),
  });
  assert.equal(tooLarge.status, 413);
});

test("a test send is queued, delivered to the server and listed without its content", async (t) => {
  const server = await startSmtpServer(t, { tls: "implicit", requireAuth: { username: "mailer", password: "smtp pw" } });
  const p = await platform(t, { subsystems: { email: { send: smtpTransport({ ca: server.ca, timeouts }) } } });
  await assert.rejects(p.send("POST", "/email/test", { to: "person@example.com" }), (error) => error.status === 409 && error.body.code === "email_disabled");
  await p.send("PUT", "/email/settings", settingsFor(server, { smtp: { host: server.host, port: server.port, security: "tls", username: "mailer", password: "smtp pw" } }));
  await assert.rejects(p.send("POST", "/email/test", { to: "not an address" }), (error) => error.status === 400);
  const queued = await p.send("POST", "/email/test", { to: "person@example.com" });
  assert.match(queued.id, /^[A-Za-z0-9_-]{24}$/);
  await eventually(() => server.messages.length === 1, "the message");
  const { headers, parts } = parseMessage(server.messages[0].data);
  assert.equal(headers["message-id"], `<${queued.id}@mail.example.org>`);
  assert.equal(headers.subject, "Zelavis test email");
  assert.match(parts[0].body, /test message from Zelavis/);
  const page = await eventually(async () => {
    const listed = await p.send("GET", "/email/deliveries");
    return listed.deliveries[0]?.state === "delivered" ? listed : undefined;
  }, "the delivered state");
  assert.deepEqual(Object.keys(page.deliveries[0]).sort(), ["attempts", "createdAt", "id", "kind", "state", "to", "updatedAt"]);
  assert.deepEqual([page.deliveries[0].id, page.deliveries[0].to, page.deliveries[0].kind, page.deliveries[0].attempts], [queued.id, "person@example.com", "test", 1]);
  await assert.rejects(p.send("GET", "/email/deliveries?limit=0"), { status: 400 });
  await assert.rejects(p.send("GET", "/email/deliveries?after=../x"), { status: 400 });
});

test("a transient failure retries on the schedule; a permanent one fails at once", async (t) => {
  let refusals = 2;
  const server = await startSmtpServer(t, { tls: "implicit", reply: (line) => line.startsWith("RCPT") && refusals-- > 0 ? "451 later" : undefined });
  const clock = { at: Date.parse("2026-11-13T10:00:00Z") };
  const email = subsystem(createMemorySystemStore(), server, clock);
  await run(email.settings.update(settingsFor(server)));
  await run(email.outbox.enqueue({ to: "person@example.com", kind: "test", subject: "Retry", text: "t", html: "<p>t</p>" }));
  await email.runOnce();
  let [delivery] = await deliveriesOf(email);
  assert.deepEqual([delivery.state, delivery.attempts, delivery.lastError, delivery.nextAttemptAt], ["queued", 1, "SMTP 451", "2026-11-13T10:01:00.000Z"]);
  clock.at += 30_000;
  await email.runOnce();
  assert.equal((await deliveriesOf(email))[0].attempts, 1, "not due yet");
  clock.at += 30_000;
  await email.runOnce();
  [delivery] = await deliveriesOf(email);
  assert.deepEqual([delivery.state, delivery.attempts, delivery.nextAttemptAt], ["queued", 2, "2026-11-13T10:06:00.000Z"]);
  clock.at += 5 * 60_000;
  await email.runOnce();
  [delivery] = await deliveriesOf(email);
  assert.deepEqual([delivery.state, delivery.attempts, delivery.nextAttemptAt, delivery.lastError], ["delivered", 3, undefined, undefined]);
  assert.equal(server.messages.length, 1);

  const refusing = await startSmtpServer(t, { tls: "implicit", reply: (line) => line.startsWith("RCPT") ? "550 no such user" : undefined });
  const failing = subsystem(createMemorySystemStore(), refusing, clock);
  await run(failing.settings.update(settingsFor(refusing)));
  await run(failing.outbox.enqueue({ to: "gone@example.com", kind: "test", subject: "Gone", text: "t", html: "" }));
  await failing.runOnce();
  [delivery] = await deliveriesOf(failing);
  assert.deepEqual([delivery.state, delivery.attempts, delivery.lastError], ["failed", 1, "SMTP 550"]);
});

test("the sixth transient failure is final", async (t) => {
  const server = await startSmtpServer(t, { tls: "implicit", reply: (line) => line.startsWith("MAIL") ? "421 busy" : undefined });
  const clock = { at: Date.parse("2026-11-13T10:00:00Z") };
  const email = subsystem(createMemorySystemStore(), server, clock);
  await run(email.settings.update(settingsFor(server)));
  await run(email.outbox.enqueue({ to: "person@example.com", kind: "test", subject: "Busy", text: "t", html: "" }));
  const waits = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    await email.runOnce();
    const [delivery] = await deliveriesOf(email);
    if (delivery.nextAttemptAt) {
      waits.push(Date.parse(delivery.nextAttemptAt) - clock.at);
      clock.at = Date.parse(delivery.nextAttemptAt);
    }
  }
  const [delivery] = await deliveriesOf(email);
  assert.deepEqual(waits, [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000]);
  assert.deepEqual([delivery.state, delivery.attempts, delivery.lastError], ["failed", 6, "SMTP 421"]);
});

test("a queued delivery survives a restart and is sent once the runtime is back", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-email-restart-"));
  const filename = join(directory, "system.sqlite");
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const server = await startSmtpServer(t, { tls: "implicit" });
  // The first runtime cannot reach its server.
  const down = () => Effect.fail(new SmtpFailure({ kind: "transient", reason: "connection failed" }));
  const first = runtime = await zelavis({ systemStore: createLocalSqliteSystemStore({ filename }), resolvePrincipal: () => OWNER, subsystems: { email: { send: down } } });
  const call = (runtime, method, path, body) => runtime.fetch(new Request(`http://localhost/zelavis/api/v1${path}`, {
    method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  })).then(async (response) => ({ status: response.status, body: await response.json() }));
  assert.equal((await call(first, "PUT", "/email/settings", settingsFor(server))).status, 200);
  const { body: { id } } = await call(first, "POST", "/email/test", { to: "person@example.com" });
  await eventually(async () => (await call(first, "GET", "/email/deliveries")).body.deliveries[0]?.lastError === "connection failed", "the failed attempt");
  await first.close();
  assert.equal(server.messages.length, 0);

  const later = () => new Date(Date.now() + 2 * 60_000);
  const second = runtime = await zelavis({ systemStore: createLocalSqliteSystemStore({ filename }), resolvePrincipal: () => OWNER, subsystems: { email: { send: smtpTransport({ ca: server.ca, timeouts }), now: later } } });
  const delivery = await eventually(async () => {
    const [entry] = (await call(second, "GET", "/email/deliveries")).body.deliveries;
    return entry?.state === "delivered" ? entry : undefined;
  }, "the delivered state after restarting with the same database file");
  assert.deepEqual([delivery.id, delivery.state, delivery.attempts], [id, "delivered", 2]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(server.messages.length, 1);
});

test("two workers over one store send a delivery once", async (t) => {
  const store = createMemorySystemStore();
  const server = await startSmtpServer(t, { tls: "implicit" });
  const clock = { at: Date.now() };
  const one = subsystem(store, server, clock);
  const two = subsystem(store, server, clock);
  await run(one.settings.update(settingsFor(server)));
  for (let index = 0; index < 4; index++) {
    await run(one.outbox.enqueue({ to: `person${index}@example.com`, kind: "test", subject: "Once", text: "t", html: "" }));
  }
  await Promise.all([one.runOnce(), two.runOnce(), one.runOnce(), two.runOnce()]);
  assert.equal(server.messages.length, 4);
  assert.deepEqual(server.messages.map(({ to }) => to).sort(), ["person0@example.com", "person1@example.com", "person2@example.com", "person3@example.com"]);
  assert.ok((await deliveriesOf(two)).every((delivery) => delivery.state === "delivered" && delivery.attempts === 1));
  assert.deepEqual((await store.page("zelavis.email.due", { limit: 10 })).records, []);
});

test("a caller's message id yields at most one delivery and is answered back", async (t) => {
  const store = createMemorySystemStore();
  const server = await startSmtpServer(t, { tls: "implicit" });
  const clock = { at: Date.now() };
  const email = subsystem(store, server, clock);
  await run(email.settings.update(settingsFor(server)));
  const message = { id: "k1", to: "person@example.com", kind: "test", subject: "Once", text: "t", html: "" };
  assert.deepEqual(await run(email.outbox.enqueue(message)), { id: "k1" });
  assert.deepEqual(await run(email.outbox.enqueue(message)), { id: "k1" });
  assert.equal((await deliveriesOf(email)).length, 1);
  await email.runOnce();
  assert.equal(server.messages.length, 1);
  // Delivered and still retained: the same id is still the same delivery.
  assert.deepEqual(await run(email.outbox.enqueue(message)), { id: "k1" });
  assert.equal((await deliveriesOf(email)).length, 1);
  assert.equal((await run(email.outbox.enqueue({ ...message, id: undefined, to: "other@example.com" }))).id.length, 24);
  assert.equal((await deliveriesOf(email)).length, 2);
  await assert.rejects(run(email.outbox.enqueue({ ...message, id: "a b" })), { _tag: "EmailSettingsInvalid" });
  await assert.rejects(run(email.outbox.enqueue({ ...message, id: "x".repeat(65) })), { _tag: "EmailSettingsInvalid" });
});

test("a claim written without its delivery is completed by the next enqueue of that id", async (t) => {
  const store = createMemorySystemStore();
  const server = await startSmtpServer(t, { tls: "implicit" });
  const clock = { at: Date.now() };
  const email = subsystem(store, server, clock);
  await run(email.settings.update(settingsFor(server)));
  // The enqueuer stopped after claiming the id and before writing the delivery.
  const key = `${String(clock.at).padStart(15, "0")}-crashedDeliveryAAAA`;
  await store.setIfAbsent("zelavis.email.outbox.ids", "k2", { key });
  assert.equal((await deliveriesOf(email)).length, 0);
  const message = { id: "k2", to: "person@example.com", kind: "test", subject: "Once", text: "t", html: "" };
  assert.deepEqual(await run(email.outbox.enqueue(message)), { id: "k2" });
  assert.deepEqual(await run(email.outbox.enqueue(message)), { id: "k2" });
  assert.equal((await deliveriesOf(email)).length, 1);
  assert.ok(await store.get("zelavis.email.outbox", key));
  await email.runOnce();
  assert.equal(server.messages.length, 1);
});

test("the retention sweep releases a caller id with its delivery and an orphaned claim", async (t) => {
  const store = createMemorySystemStore();
  const server = await startSmtpServer(t, { tls: "implicit" });
  const clock = { at: Date.now() };
  const email = subsystem(store, server, clock);
  await run(email.settings.update(settingsFor(server)));
  const message = { id: "k3", to: "person@example.com", kind: "test", subject: "Once", text: "t", html: "" };
  await run(email.outbox.enqueue(message));
  await store.setIfAbsent("zelavis.email.outbox.ids", "orphan", { key: `${String(clock.at).padStart(15, "0")}-neverWrittenAAAAA` });
  await email.runOnce();
  assert.ok(await store.get("zelavis.email.outbox.ids", "k3"));
  clock.at += 31 * 24 * 60 * 60_000;
  await email.runOnce();
  assert.equal(await store.get("zelavis.email.outbox.ids", "k3"), undefined);
  assert.equal(await store.get("zelavis.email.outbox.ids", "orphan"), undefined);
  assert.equal((await deliveriesOf(email)).length, 0);
  // Released: the id can be used again, as a new delivery.
  assert.deepEqual(await run(email.outbox.enqueue(message)), { id: "k3" });
  assert.equal((await deliveriesOf(email)).length, 1);
});

test("the outbox holds at most 1000 waiting deliveries", async (t) => {
  const hold = () => Effect.never;
  const p = await platform(t, { subsystems: { email: { send: hold } } });
  await p.send("PUT", "/email/settings", settingsFor({ host: "127.0.0.1", port: 465 }));
  for (let index = 0; index < 1000; index++) {
    await Effect.runPromise(p.runtime.email.enqueue({ to: `p${index}@example.com`, kind: "test", subject: "Hold", text: "", html: "" }));
  }
  await assert.rejects(p.send("POST", "/email/test", { to: "one.more@example.com" }),
    (error) => error.status === 429 && error.body.code === "email_outbox_full");
});

test("email routes need the runtime's settings permission", async (t) => {
  const p = await platform(t);
  p.as(undefined);
  for (const [method, path, body] of [["GET", "/email/settings"], ["PUT", "/email/settings", { expectedRevision: 0, mode: "disabled" }],
    ["POST", "/email/test", { to: "a@b.example" }], ["GET", "/email/deliveries"]]) {
    await assert.rejects(p.send(method, path, body), { status: 401 });
  }
  p.as({ id: "customer", type: "user", roles: ["customer"], permissions: ["projects.create"] });
  await assert.rejects(p.send("GET", "/email/settings"), { status: 403 });
  // A Project's settings grant is not the Platform's.
  p.as({ id: "delegate", type: "user", grants: [{ permission: "project.settings.manage", scope: { type: "project", projectId: "one" } }] });
  await assert.rejects(p.send("GET", "/email/settings"), { status: 403 });
  for (const [method, path, body] of [["GET", "settings"], ["PUT", "settings", { expectedRevision: 0, mode: "disabled" }],
    ["POST", "test", { to: "a@b.example" }], ["GET", "deliveries"]]) {
    await assert.rejects(p.send(method, `/runtime/projects/two/email/${path}`, body), { status: 403 });
    // This Platform has no Project manager; exact authority reaches that check.
    await assert.rejects(p.send(method, `/runtime/projects/one/email/${path}`, body), { status: 503 });
  }
});

test("an App runtime requires its own Project's settings grant", async (t) => {
  let principal;
  const app = await zelavis({
    role: "project", systemStore: createMemorySystemStore(), resolvePrincipal: () => principal,
    subsystems: { auth: false, database: false }, serviceContext: { platform: { metadata: { projectId: "app-one" } } },
  });
  t.after(() => app.close());
  const get = () => app.fetch(new Request("http://localhost/zelavis/api/v1/email/settings"));
  principal = { id: "x", type: "user", grants: [{ permission: "project.settings.manage", scope: { type: "project", projectId: "app-two" } }] };
  assert.equal((await get()).status, 403);
  principal = { id: "x", type: "user", grants: [{ permission: "project.settings.manage", scope: { type: "project", projectId: "app-one" } }] };
  assert.equal((await get()).status, 200);
});

test("JS, HTTP and CLI give the same email answers", async (t) => {
  const server = await startSmtpServer(t, { tls: "implicit" });
  const p = await platform(t, { subsystems: { email: { send: smtpTransport({ ca: server.ca, timeouts }) } } });
  const viaHttp = await p.send("GET", "/email/settings");
  assert.deepEqual(await p.client.email.settings(), viaHttp);
  assert.deepEqual(await p.cli(runEmailCommand, ["settings"]), viaHttp);
  const sdkSaved = await p.client.email.setSettings(settingsFor(server));
  assert.equal(sdkSaved.revision, 1);
  const cliSaved = await p.cli(runEmailCommand, ["set-settings", "--data", JSON.stringify(settingsFor(server, { expectedRevision: 1 }))]);
  assert.deepEqual({ ...cliSaved, updatedAt: undefined }, { ...sdkSaved, revision: 2, updatedAt: undefined });
  await assert.rejects(p.client.email.setSettings(settingsFor(server)), (error) => error.status === 409);
  await assert.rejects(p.cli(runEmailCommand, ["set-settings", "--data", JSON.stringify(settingsFor(server))]), (error) => error.status === 409);
  const fromSdk = await p.client.email.sendTest("sdk@example.com");
  const fromCli = await p.cli(runEmailCommand, ["test", "cli@example.com"]);
  assert.match(fromSdk.id, /^[A-Za-z0-9_-]{24}$/);
  assert.match(fromCli.id, /^[A-Za-z0-9_-]{24}$/);
  await eventually(() => server.messages.length === 2, "both messages");
  const listed = await eventually(async () => {
    const page = await p.client.email.deliveries({ limit: 1 });
    return page.next ? page : undefined;
  }, "a paged listing");
  assert.equal(listed.deliveries.length, 1);
  const rest = await p.cli(runEmailCommand, ["deliveries", "--limit", "1", "--after", listed.next]);
  assert.deepEqual(rest.deliveries.map(({ id }) => id), [listed.deliveries[0].id === fromSdk.id ? fromCli.id : fromSdk.id]);
  assert.deepEqual(await p.client.email.deliveries({ limit: 1, after: listed.next }), await p.send("GET", `/email/deliveries?limit=1&after=${listed.next}`));
});

test("an App's email settings, queue and server are its own", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-app-email-"));
  // The App runtime is its own process; it trusts the fixture's certificate the way an operator's CA would be trusted.
  const { cert } = await testCertificate();
  const caFile = join(root, "smtp-ca.pem");
  await writeFile(caFile, cert);
  const previousCa = process.env.NODE_EXTRA_CA_CERTS;
  process.env.NODE_EXTRA_CA_CERTS = caFile;
  const bootstrapToken = "native-app-email-bootstrap-token";
  const zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: root, projects: { previewHost: false } }), bootstrap: { token: bootstrapToken } });
  t.after(async () => {
    await zv.close();
    if (previousCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS; else process.env.NODE_EXTRA_CA_CERTS = previousCa;
    await rm(root, { recursive: true, force: true });
  });
  const origin = "http://app-email-platform.test";
  const through = (input, init) => zv.fetch(new Request(input, init));
  const client = (token) => createZelavisClient({ baseUrl: origin, fetch: through, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });
  const password = "password for the app email owner";
  const bootstrapped = await client().auth.bootstrap.claim({ bootstrapToken, username: "owner", password });
  const owner = client(bootstrapped.tokens.accessToken);
  const project = await owner.projects.create({ id: "mail-app", name: "Mail App", recipeName: "@zelavis/app" });
  await owner.projects.create({ id: "other-app", name: "Other", recipeName: "@zelavis/app", start: false });

  const appServer = await startSmtpServer(t, { tls: "implicit" });
  const platformServer = await startSmtpServer(t, { tls: "implicit" });
  await owner.email.setSettings(settingsFor(platformServer));
  const appSettings = await owner.projects.setEmailSettings(project.id, settingsFor(appServer, { from: { address: "app@shop.example.org" } }));
  assert.equal(appSettings.revision, 1, "the App's revisions are its own");
  assert.deepEqual(await owner.projects.emailSettings(project.id), appSettings);
  assert.equal((await owner.email.settings()).from.address, "noreply@mail.example.org");

  const { id } = await owner.projects.sendTestEmail(project.id, "customer@example.com");
  await eventually(() => appServer.messages.length === 1, "the App's message", 20_000);
  assert.equal(parseMessage(appServer.messages[0].data).headers["message-id"], `<${id}@shop.example.org>`);
  const appDeliveries = await eventually(async () => {
    const page = await owner.projects.emailDeliveries(project.id, { limit: 10 });
    return page.deliveries[0]?.state === "delivered" ? page : undefined;
  }, "the App's delivered state");
  assert.deepEqual(appDeliveries.deliveries.map((delivery) => delivery.id), [id]);
  assert.deepEqual((await owner.email.deliveries()).deliveries, []);
  assert.equal(platformServer.messages.length, 0);

  // A grant on one Project reaches only that Project's email.
  const { token } = await owner.auth.serviceAccounts.create({
    name: "Other settings", grants: [{ permission: "project.settings.manage", scope: { type: "project", projectId: "other-app" } }],
  });
  const delegate = client(token);
  await assert.rejects(delegate.projects.emailSettings(project.id), { status: 403 });
  await assert.rejects(delegate.projects.sendTestEmail(project.id, "x@example.com"), { status: 403 });
  await assert.rejects(delegate.email.settings(), { status: 403 });

  const cli = async (args) => {
    const originalFetch = globalThis.fetch, originalLog = console.log, lines = [];
    // Only the CLI's own requests come here; the Platform's forward to the App leaves through the real fetch.
    globalThis.fetch = (request, init) => new URL(request instanceof Request ? request.url : String(request)).origin === origin
      ? through(request, init) : originalFetch(request, init);
    console.log = (...parts) => lines.push(parts.join(" "));
    try {
      await runProjectsCommand([...args, "--url", `${origin}/zelavis`, "--token", bootstrapped.tokens.accessToken, "--json"]);
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalLog;
    }
    return JSON.parse(lines.join("\n"));
  };
  assert.deepEqual(await cli(["email-settings", project.id]), appSettings);
  assert.deepEqual((await cli(["email-deliveries", project.id, "--limit", "5"])).deliveries.map((delivery) => delivery.id), [id]);
  const fromCli = await cli(["send-test-email", project.id, "cli@example.com"]);
  await eventually(() => appServer.messages.length === 2, "the CLI's message", 20_000);
  assert.match(fromCli.id, /^[A-Za-z0-9_-]{24}$/);
  const disabled = await cli(["set-email-settings", project.id, "--data", JSON.stringify({ expectedRevision: 1, mode: "disabled" })]);
  assert.deepEqual([disabled.revision, disabled.mode], [2, "disabled"]);
});
