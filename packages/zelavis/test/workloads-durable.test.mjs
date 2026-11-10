// Durable Workloads (phase 2): jobs are messages to a job entity, schedules are wakes saved before they are due,
// inbound webhooks are saved before they are answered and keyed by the provider's event id, and outbound webhooks
// are outbox messages delivered with an Idempotency-Key. Each is held to what it promises: kept across a stop,
// handled once in the database however often it is delivered, and refused where it should be refused.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createMemoryWorkloadsStore, workloadsEndpointGroup } from "../dist/app/workloads/workloads-service.js";
import { serveDurableWorkloads, signBody, verifyTimestampedSignature } from "../dist/app/workloads/durable.js";
import { Effect } from "effect";
import { openTemporaryDatabase } from "./_database.mjs";

const wait = (millis) => new Promise((resolve) => setTimeout(resolve, millis));
const until = async (condition, what, millis = 8000) => {
  for (const started = Date.now(); !(await condition()); await wait(20)) assert.ok(Date.now() - started < millis, what);
};
const route = (group, id) => group.api.v1.find((entry) => entry.id === id).handler;

const open = async (t) => {
  const { api } = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  const store = createMemoryWorkloadsStore([]);
  const group = workloadsEndpointGroup({ store, database: api });
  const create = async (body) => {
    const answer = await route(group, "workloads.create")({ body });
    if (answer.status !== 201) throw new Error(answer.body.error ?? JSON.stringify(answer.body));
    return answer.body;
  };
  return { api, store, group, create };
};

/** A handler that records what it handled as a document keyed by the message, so a repeat would be a conflict. */
const recording = `export default async function handle(message, { state }) {
  return {
    writes: [{ _tag: "Insert", collection: "done", id: message.messageKey, data: { tag: message.tag, payload: message.payload } }],
    state: { seen: (state?.seen ?? 0) + 1 },
    reply: { ok: true },
  };
}`;
const recorded = async (api, tenant = "acme") => (await api.forTenant(tenant).documents.findMany({ collection: "done" }));

test("a job run is kept in its Tenant's mailbox and handled once; a primary key makes a resend the same run", async (t) => {
  const { api, group, create } = await open(t);
  for (const tenant of ["acme", "globex"]) await api.forTenant(tenant).documents.createCollection({ name: "done" });
  const job = await create({ type: "job", name: "resize", tenant: "acme", code: recording });
  const run = (body) => route(group, "workloads.run")({ params: { id: job.id }, body });

  // Kept before anything is serving: the mailbox is the queue.
  const first = (await run({ input: { image: "a.png" }, primaryKey: "run-1" })).body;
  assert.equal(first.duplicate, false);
  assert.equal((await run({ input: { image: "a.png" }, primaryKey: "run-1" })).body.duplicate, true);
  assert.equal((await api.forTenant("acme").entities.mailbox({ type: "job", id: "resize" })).messages.length, 1);
  assert.equal((await run({ tenantId: "globex", input: {} })).body.message.status, "pending", "a run may name another Tenant");
  assert.equal((await run({ input: "not an object" })).status, 400);

  const serving = serveDurableWorkloads(api, group.context);
  t.after(() => serving.stop());
  await until(async () => (await recorded(api)).length === 1, "the run is handled");
  await until(async () => (await api.forTenant("globex").entities.state({ type: "job", id: "resize" }))?.processed === 1, "the other Tenant's run is handled in its own mailbox");
  const [document] = await recorded(api);
  assert.deepEqual(document.data.payload, { image: "a.png" });
  assert.equal((await api.forTenant("acme").entities.message({ type: "job", id: "resize", messageKey: "run-1" })).status, "processed");
  assert.equal((await recorded(api)).length, 1, "handled once");
});

test("a job that fails is retried with a pause, and entity workloads cannot take a job's entity type", async (t) => {
  const { api, group, create } = await open(t);
  await assert.rejects(Promise.resolve(create({ type: "entity", name: "job" })), /entity type of job workloads/);
  const flaky = await create({ type: "job", name: "flaky", tenant: "acme", code: `let calls = 0;
export default async function handle(message) { if (++calls === 1) throw new Error("first attempt fails"); return { reply: { calls } }; }` });
  await route(group, "workloads.run")({ params: { id: flaky.id }, body: { primaryKey: "k" } });
  const serving = serveDurableWorkloads(api, group.context);
  t.after(() => serving.stop());
  await until(async () => (await api.forTenant("acme").entities.message({ type: "job", id: "flaky", messageKey: "k" }))?.attempts === 1, "the first attempt fails");
  const message = await api.forTenant("acme").entities.message({ type: "job", id: "flaky", messageKey: "k" });
  assert.equal(message.status, "pending");
  assert.match(message.lastError, /first attempt fails/);
  await until(async () => (await api.forTenant("acme").entities.message({ type: "job", id: "flaky", messageKey: "k" }))?.status === "processed", "the retry runs after its pause");
});

test("a schedule's next wake is saved before it is due, survives a stop, and a missed run fires once", async (t) => {
  const { api, group, create } = await open(t);
  await api.forTenant("acme").documents.createCollection({ name: "done" });
  await assert.rejects(Promise.resolve(create({ type: "schedule", name: "bad", schedule: "not a cron" })), /cron expression/);
  const schedule = await create({ type: "schedule", name: "tick", schedule: "* * * * * *", tenant: "acme", code: recording });
  assert.equal(schedule.type, "schedule");

  let serving = serveDurableWorkloads(api, group.context);
  const entities = api.forTenant("acme").entities;
  await until(async () => ((await entities.state({ type: "schedule", id: "tick" }))?.processed ?? 0) >= 2, "it fires on its schedule", 10_000);
  const fires = (await recorded(api)).map((document) => document.data.payload.fireAt);
  assert.equal(new Set(fires).size, fires.length, "every fire is its own wake");

  await until(async () => {
    const waiting = (await entities.mailbox({ type: "schedule", id: "tick" })).messages;
    return waiting.length === 1 && Date.parse(waiting[0].deliverAt) - Date.now() > 300;
  }, "the next wake is kept ahead of its time");
  await serving.stop();
  const pending = (await entities.mailbox({ type: "schedule", id: "tick" })).messages;
  assert.equal(pending.length, 1, "the next wake is already kept while nothing is running");
  assert.ok(pending[0].deliverAt, "with the time it is due");
  const before = (await entities.state({ type: "schedule", id: "tick" })).processed;
  await wait(3200); // three fires missed
  serving = serveDurableWorkloads(api, group.context);
  t.after(() => serving.stop());
  await until(async () => (await entities.state({ type: "schedule", id: "tick" })).processed > before, "the missed wake fires on return");
  await wait(300);
  assert.equal((await entities.state({ type: "schedule", id: "tick" })).processed - before <= 2, true, "three missed fires are one, not three");

  // Disabling withdraws the wake.
  await route(group, "workloads.update")({ params: { id: schedule.id }, body: { enabled: false } });
  await until(async () => (await entities.mailbox({ type: "schedule", id: "tick" })).messages.length === 0, "a disabled schedule has no wake left");
});

test("an inbound webhook is verified, saved before it is answered, and keyed by the provider's event id", async (t) => {
  const { api, group, create } = await open(t);
  await api.forTenant("acme").documents.createCollection({ name: "done" });
  const secret = "whsec_0123456789abcdef";
  await create({ type: "webhook", name: "github", tenant: "acme", secret, eventIdHeader: "x-github-delivery", code: recording });
  const webhook = route(group, "workloads.webhooks.receive");
  const post = async (event, { sign = true, delivery = "d-1", signature } = {}) => {
    const body = JSON.stringify(event);
    const headers = { "content-type": "application/json", authorization: "Bearer must-not-be-kept" };
    if (delivery !== null) headers["x-github-delivery"] = delivery;
    if (sign) headers["x-hub-signature-256"] = signature ?? await Effect.runPromise(signBody(secret, body));
    return webhook({ params: { projectId: "default", name: "github" }, request: new Request("http://zelavis.local/hook", { method: "POST", headers, body }) });
  };

  const unsigned = await post({ action: "opened" }, { sign: false });
  assert.equal(unsigned.status, 401);
  assert.equal((await post({ action: "opened" }, { signature: "sha256=" + "0".repeat(64) })).status, 401, "a wrong signature");
  assert.equal((await post({ action: "opened" }, { delivery: null })).status, 400, "no event id to keep it by");
  assert.equal((await webhook({ params: { projectId: "default", name: "nope" }, request: new Request("http://zelavis.local/x", { method: "POST", body: "{}" }) })).status, 404);

  // Saved before it is answered: nothing is serving, and the event is already in the mailbox.
  const first = await post({ action: "opened" });
  assert.equal(first.status, 202);
  assert.equal(first.body.duplicate, false);
  const mailbox = await api.forTenant("acme").entities.mailbox({ type: "webhook", id: "github" });
  assert.equal(mailbox.messages.length, 1);
  assert.equal(mailbox.messages[0].messageKey, "d-1");
  assert.deepEqual(mailbox.messages[0].payload.body, { action: "opened" });
  assert.equal(mailbox.messages[0].payload.headers.authorization, undefined, "credentials are not kept");
  assert.equal(mailbox.messages[0].payload.headers["x-hub-signature-256"], undefined, "nor the signature");

  const retry = await post({ action: "opened" });
  assert.equal(retry.status, 202);
  assert.equal(retry.body.duplicate, true, "the provider's retry is the same event");
  await post({ action: "closed" }, { delivery: "d-2" });

  const serving = serveDurableWorkloads(api, group.context);
  t.after(() => serving.stop());
  await until(async () => (await recorded(api)).length === 2, "both events are handled");
  await wait(150);
  assert.equal((await recorded(api)).length, 2, "each event once");
  const read = (await route(group, "workloads.list")({ query: new URLSearchParams({ projectId: "default" }) })).body.workloads[0];
  assert.equal(read.secret, undefined, "the secret is never read back");
  assert.equal(read.secretSet, true);
});

test("an outbound webhook delivers outbox messages at least once with a stable Idempotency-Key", async (t) => {
  const { api, group, create } = await open(t);
  const received = [];
  let answers = [500, 200];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received.push({ headers: request.headers, body: JSON.parse(body), raw: body });
      response.statusCode = answers.shift() ?? 200;
      response.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const secret = "outbound-secret-123456";
  const hook = await create({ type: "webhook", name: "orders", tenant: "acme", url: `http://127.0.0.1:${server.address().port}/in`, secret });
  assert.equal(hook.secret, undefined);
  await assert.rejects(Promise.resolve(create({ type: "webhook", name: "x", url: "ftp://example.com" })), /http or https/);

  const emitted = await api.forTenant("acme").outbox.emit({ topic: "webhook.orders", payload: { order: 7 } });
  await api.forTenant("acme").outbox.emit({ topic: "other.topic", payload: {} });
  const serving = serveDurableWorkloads(api, group.context);
  t.after(() => serving.stop());
  await until(() => received.length >= 2, "a failed delivery is tried again", 10_000);
  assert.equal(received[0].headers["idempotency-key"], emitted.id);
  assert.equal(received[1].headers["idempotency-key"], emitted.id, "the retry carries the same key");
  assert.deepEqual(received[1].body.payload, { order: 7 });
  assert.equal(received[1].headers["x-zelavis-signature"], await Effect.runPromise(signBody(secret, received[1].raw)));
  await until(async () => (await api.forTenant("acme").outbox.read({ topic: "webhook.orders" })).messages.length === 0, "a delivered message is removed from the outbox");
  await wait(200);
  assert.equal(received.length, 2, "delivered once it was acknowledged");
  assert.equal((await api.forTenant("acme").outbox.read({ topic: "other.topic" })).messages.length, 1, "other topics are not touched");
  const logs = (await route(group, "workloads.logs")({ query: new URLSearchParams({ projectId: "default" }) })).body.logs;
  assert.deepEqual(logs.map((log) => log.status).sort(), ["completed", "failed"]);
});

test("an outbound webhook goes on delivering after its Tenant is removed and written again", async (t) => {
  const { api, group, create } = await open(t);
  const received = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => { received.push(JSON.parse(body).payload); response.statusCode = 200; response.end("{}"); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  await create({ type: "webhook", name: "orders", tenant: "acme", url: `http://127.0.0.1:${server.address().port}/in`, secret: "outbound-secret-123456" });
  const serving = serveDurableWorkloads(api, group.context);
  t.after(() => serving.stop());
  // Enough messages that the runner's cursor stands past where the next life's first message will be.
  for (let order = 1; order <= 6; order++) await api.forTenant("acme").outbox.emit({ topic: "webhook.orders", payload: { order } });
  await until(() => received.length === 6, "the first life's messages are delivered");

  await api.dropTenant("acme");
  await api.forTenant("acme").outbox.emit({ topic: "webhook.orders", payload: { order: "again" } });
  await until(() => received.some((payload) => payload.order === "again"), "the new life's message is delivered, not skipped by the old cursor");
});

test("a timestamped signature covers its time and the body, and a stale or altered one is refused", async (t) => {
  const { api, group, create } = await open(t);
  const secret = "whsec_timestamped_0123456789";
  await create({ type: "webhook", name: "pay", tenant: "acme", secret, signatureScheme: "timestamped" });
  await assert.rejects(Promise.resolve(create({ type: "webhook", name: "bad", signatureScheme: "nope" })), /hmac/);
  const webhook = route(group, "workloads.webhooks.receive");
  const sign = async (body, seconds) => `t=${seconds},v1=${(await Effect.runPromise(signBody(secret, `${seconds}.${body}`))).slice("sha256=".length)}`;
  const post = async (body, header) => webhook({ params: { projectId: "default", name: "pay" },
    request: new Request("http://zelavis.local/pay", { method: "POST", headers: header === undefined ? {} : { "stripe-signature": header }, body }) });
  const body = JSON.stringify({ id: "evt_1", type: "charge.succeeded" });
  const nowSeconds = Math.floor(Date.now() / 1000);
  assert.equal((await post(body, await sign(body, nowSeconds))).status, 202);
  assert.equal((await post(body, await sign(body, nowSeconds))).body.duplicate, true);
  assert.equal((await post(body, undefined)).status, 401, "no signature");
  assert.equal((await post(body.replace("evt_1", "evt_2"), await sign(body, nowSeconds))).status, 401, "an altered body");
  const stale = await sign(body, nowSeconds - 3600);
  assert.equal((await post(body, stale)).status, 401, "a replayed request, an hour old, is refused");
  assert.equal((await post(body, `t=${nowSeconds},v1=${"0".repeat(64)},v1=${(await sign(body, nowSeconds)).split("v1=")[1]}`)).body.duplicate, true,
    "any one of several v1 values may match, as when a provider rotates its secret");
  assert.equal(await Effect.runPromise(verifyTimestampedSignature(secret, body, "t=abc,v1=00", Date.now())), false);
});

test("nothing polls: an outbox emit delivers at once, a new definition takes effect at once, and waiting messages find their handler", async (t) => {
  const { api, group, create } = await open(t);
  const received = [];
  const server = createServer((request, response) => { request.resume(); received.push(request.headers["idempotency-key"]); response.end("{}"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  // A safety net of an hour: whatever happens below happens because something was told, not because something looked.
  const serving = serveDurableWorkloads(api, group.context, { safetyMillis: 3_600_000 });
  t.after(() => serving.stop());
  await wait(100);

  await create({ type: "webhook", name: "orders", tenant: "acme", url: `http://127.0.0.1:${server.address().port}/in` });
  const emitted = await api.forTenant("acme").outbox.emit({ topic: "webhook.orders", payload: { n: 1 } });
  await until(() => received.includes(emitted.id), "the message is delivered when it is committed", 3000);
  const withWrite = await api.forTenant("acme").documents.write({ operations: [], emit: [{ topic: "webhook.orders", payload: { n: 2 } }] });
  assert.ok(withWrite);
  await until(() => received.length === 2, "so is one emitted with a write", 3000);

  await api.forTenant("acme").documents.createCollection({ name: "done" });
  await api.forTenant("acme").entities.send({ type: "late", id: "x", tag: "said", payload: {} });
  await wait(150);
  assert.equal((await api.forTenant("acme").entities.state({ type: "late", id: "x" })).pending, 1, "no handler yet, so it waits");
  await create({ type: "entity", name: "late", code: recording });
  await until(async () => (await api.forTenant("acme").entities.state({ type: "late", id: "x" })).processed === 1, "the new handler takes it without anyone polling", 3000);
});
