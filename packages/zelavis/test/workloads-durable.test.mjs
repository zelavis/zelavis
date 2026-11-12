// Durable Workloads (phase 2): jobs are messages to a job entity, schedules are wakes saved before they are due,
// inbound webhooks are saved before they are answered and keyed by the provider's event id, and outbound webhooks
// are outbox messages delivered with an Idempotency-Key. Each is held to what it promises: kept across a stop,
// handled once in the database however often it is delivered, and refused where it should be refused.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import { createMemoryWorkloadsStore, workloadsEndpointGroup } from "../dist/app/workloads/workloads-service.js";
import { serveDurableWorkloads, signBody, verifyTimestampedSignature } from "../dist/app/workloads/durable.js";
import { openNodeDatabase } from "../dist/db/node-host.js";
import { Effect } from "effect";
import { openTemporaryDatabase, temporaryDatabaseDirectory } from "./_database.mjs";

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

const providerResultCode = `
const validRequestId = (id) => typeof id === "string" && /^conversion-[a-z0-9-]{1,40}$/.test(id);
const terminal = (status) => status === "succeeded" || status === "failed";
const reply = (outcome) => ({ reply: { outcome } });
const readRequest = (documents, id) => documents.findById({ collection: "provider-requests", id });

async function applyResult(documents, requestId, status) {
  const current = await readRequest(documents, requestId);
  if (!current) return reply("unknown-request");
  if (current.data.status !== "pending") {
    return reply(status === "pending" || status === current.data.status ? "unchanged" : "conflict");
  }
  if (status === "pending") return reply("pending");
  return {
    writes: [{ _tag: "Update", collection: "provider-requests", id: requestId, expectedVersion: current.version, data: { status } }],
    reply: { outcome: "applied" },
  };
}
`;

async function providerRecoveryFixture(t, { holdFirstAcknowledgment = false } = {}) {
  const directory = temporaryDatabaseDirectory();
  const tenantId = "acme";
  const requestId = "conversion-one";
  const topic = "webhook.provider-submit";
  const secret = "test-provider-result-secret";
  const store = createMemoryWorkloadsStore([]);
  const submissions = [];
  const statusRequests = [];
  const conversions = new Map();
  let acceptedConversions = 0;
  let heldResponse;
  let mismatchNextStatus = false;
  let opened;
  let group;
  let serving;

  const provider = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/submit") {
      request.setEncoding("utf8");
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        let envelope;
        try {
          envelope = JSON.parse(body);
        } catch {
          response.writeHead(400).end();
          return;
        }
        const key = request.headers["idempotency-key"];
        if (key !== requestId || envelope?.id !== key || envelope.topic !== topic || envelope.payload?.requestId !== key) {
          response.writeHead(400).end();
          return;
        }
        submissions.push({ envelope, key });
        if (!conversions.has(key)) {
          acceptedConversions += 1;
          conversions.set(key, "pending");
          if (holdFirstAcknowledgment) {
            heldResponse = response;
            return;
          }
        }
        response.writeHead(202).end();
      });
      return;
    }
    const lookup = /^\/status\/(conversion-[a-z0-9-]{1,40})$/.exec(request.url);
    if (request.method === "GET" && lookup) {
      const id = lookup[1];
      statusRequests.push(id);
      const status = conversions.get(id);
      if (status !== undefined) {
        const answer = { requestId: mismatchNextStatus ? "conversion-other" : id, status };
        mismatchNextStatus = false;
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
        return;
      }
    }
    response.writeHead(404).end();
  });

  const stop = async () => {
    await serving?.stop();
    serving = undefined;
  };
  t.after(async () => {
    try {
      await stop();
    } finally {
      try {
        await opened?.close();
      } finally {
        heldResponse?.destroy();
        if (provider.listening) {
          await new Promise((resolve, reject) => {
            provider.close((error) => error ? reject(error) : resolve());
            provider.closeAllConnections();
          });
        }
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
  await new Promise((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", () => {
      provider.off("error", reject);
      resolve();
    });
  });
  const origin = `http://127.0.0.1:${provider.address().port}`;
  const openDatabase = async () => {
    opened = await openNodeDatabase({ directory, shards: ["shard-0", "shard-1"], crossTenantRefresh: false });
    group = workloadsEndpointGroup({ store, database: opened.api });
  };
  await openDatabase();
  const tenant = () => opened.api.forTenant(tenantId);
  await tenant().documents.createCollection({ name: "provider-requests" });
  const create = async (body) => {
    const answer = await route(group, "workloads.create")({ body: { tenant: tenantId, ...body } });
    assert.equal(answer.status, 201, JSON.stringify(answer.body));
    return answer.body;
  };
  await create({ type: "webhook", name: "provider-submit", url: `${origin}/submit` });
  await create({ type: "webhook", name: "provider-result", secret, code: `${providerResultCode}
export default async function handle(message, { documents }) {
  const result = message.payload.body;
  if (typeof result?.id !== "string" || !/^event-[a-z0-9-]{1,40}$/.test(result.id) ||
      !validRequestId(result.requestId) || !terminal(result.status)) return reply("invalid-result");
  return applyResult(documents, result.requestId, result.status);
}` });
  const checkJob = await create({ type: "job", name: "provider-check", code: `${providerResultCode}
export default async function handle({ payload: { requestId } }, { documents }) {
  if (!validRequestId(requestId)) return reply("invalid-result");
  const current = await readRequest(documents, requestId);
  if (!current) return reply("unknown-request");
  if (current.data.status !== "pending") return reply("unchanged");

  let result;
  try {
    const response = await fetch(${JSON.stringify(origin + "/status/")} + requestId, {
      signal: AbortSignal.timeout(1000), redirect: "error",
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error("Unexpected provider HTTP status");
    }
    result = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) return reply("invalid-result");
    throw new Error("Provider status unavailable");
  }
  if (result?.requestId !== requestId || !(result.status === "pending" || terminal(result.status))) {
    return reply("invalid-result");
  }
  return applyResult(documents, requestId, result.status);
}` });

  const message = (type, id, messageKey) => tenant().entities.message({ type, id, messageKey });
  return {
    requestId,
    submissions,
    statusRequests,
    get acceptedConversions() { return acceptedConversions; },
    mismatchStatusOnce: () => { mismatchNextStatus = true; },
    finishConversion: (status) => {
      assert.equal(conversions.get(requestId), "pending");
      conversions.set(requestId, status);
    },
    start: () => {
      assert.equal(serving, undefined);
      serving = serveDurableWorkloads(opened.api, group.context);
    },
    stop,
    reopen: async () => {
      assert.equal(serving, undefined);
      heldResponse?.destroy();
      heldResponse = undefined;
      await opened.close();
      opened = undefined;
      await openDatabase();
    },
    submit: () => tenant().documents.write({
      operations: [{ _tag: "Insert", collection: "provider-requests", id: requestId, data: { status: "pending" } }],
      emit: [{ id: requestId, topic, payload: { requestId } }],
      idempotencyKey: requestId,
    }),
    owed: async () => (await tenant().outbox.read({ topic })).messages.map(({ id }) => id),
    read: (id = requestId) => tenant().documents.findById({ collection: "provider-requests", id }),
    message,
    expectReply: async (type, id, key, outcome) => {
      let result;
      await until(async () => {
        result = await message(type, id, key);
        return result !== undefined && result.status !== "pending";
      }, `waiting for ${type} ${id} message ${key}`);
      assert.equal(result.status, "processed", result.lastError);
      assert.deepEqual(result.reply, { outcome });
    },
    postResult: async (event, validSignature = true) => {
      const body = JSON.stringify(event);
      const signature = validSignature ? await Effect.runPromise(signBody(secret, body)) : "sha256=" + "0".repeat(64);
      return route(group, "workloads.webhooks.receive")({
        params: { projectId: "default", name: "provider-result" },
        request: new Request("http://zelavis.local/provider-result", {
          method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body,
        }),
      });
    },
    check: async (attempt) => (await route(group, "workloads.run")({
      params: { id: checkJob.id },
      body: { input: { requestId }, primaryKey: `check-${requestId}-${attempt}` },
    })).body,
  };
}

test("a provider acknowledgment leaves a request pending until a verified result commits", async (t) => {
  const fixture = await providerRecoveryFixture(t);
  const { requestId } = fixture;
  const receipt = await fixture.submit();
  const pending = await fixture.read();
  assert.equal(pending.data.status, "pending");
  assert.deepEqual(await fixture.submit(), receipt);
  assert.deepEqual(await fixture.owed(), [requestId]);

  fixture.start();
  await until(async () => (await fixture.owed()).length === 0, "provider accepted the outbox submission");
  assert.deepEqual(await fixture.read(), pending);
  await fixture.stop();
  fixture.finishConversion("succeeded");

  const unverified = { id: "event-unverified", requestId, status: "succeeded" };
  assert.equal((await fixture.postResult(unverified, false)).status, 401);
  assert.equal(await fixture.message("webhook", "provider-result", unverified.id), undefined);
  const invalid = { id: "event-invalid", requestId, status: "done" };
  const unknown = { id: "event-unknown", requestId: "conversion-unknown", status: "succeeded" };
  const completed = { id: "event-complete", requestId, status: "succeeded" };
  for (const event of [invalid, unknown, completed]) {
    const answer = await fixture.postResult(event);
    assert.equal(answer.status, 202);
    assert.deepEqual(answer.body, { received: true, duplicate: false, messageKey: event.id });
  }
  const replay = await fixture.postResult(completed);
  assert.equal(replay.status, 202);
  assert.deepEqual(replay.body, { received: true, duplicate: true, messageKey: completed.id });
  assert.equal((await fixture.message("webhook", "provider-result", completed.id)).status, "pending");
  assert.deepEqual(await fixture.read(), pending);

  fixture.start();
  await fixture.expectReply("webhook", "provider-result", invalid.id, "invalid-result");
  await fixture.expectReply("webhook", "provider-result", unknown.id, "unknown-request");
  await fixture.expectReply("webhook", "provider-result", completed.id, "applied");
  assert.equal(await fixture.read(unknown.requestId), undefined);
  const result = await fixture.read();
  assert.equal(result.data.status, "succeeded");
  assert.equal(result.version, pending.version + 1);
  assert.equal(fixture.acceptedConversions, 1);
});

test("a lost submission acknowledgment and a missed callback recover after reopen", async (t) => {
  const fixture = await providerRecoveryFixture(t, { holdFirstAcknowledgment: true });
  const { requestId } = fixture;
  await fixture.submit();
  const pending = await fixture.read();
  fixture.start();
  await until(() => fixture.acceptedConversions === 1, "provider accepted the submission with its response held");
  await fixture.stop();
  assert.deepEqual(await fixture.owed(), [requestId]);
  await fixture.reopen();
  assert.deepEqual(await fixture.owed(), [requestId]);
  assert.deepEqual(await fixture.read(), pending);

  fixture.start();
  await until(async () => (await fixture.owed()).length === 0, "redelivery after reopen was acknowledged");
  assert.deepEqual(fixture.submissions.map(({ key }) => key), [requestId, requestId]);
  assert.deepEqual(fixture.submissions[0].envelope, fixture.submissions[1].envelope);
  assert.equal(fixture.acceptedConversions, 1);
  assert.deepEqual(await fixture.read(), pending);

  fixture.mismatchStatusOnce();
  const mismatched = await fixture.check(1);
  await fixture.expectReply("job", "provider-check", mismatched.message.messageKey, "invalid-result");
  assert.deepEqual(await fixture.read(), pending);
  const waiting = await fixture.check(2);
  await fixture.expectReply("job", "provider-check", waiting.message.messageKey, "pending");
  assert.deepEqual(await fixture.read(), pending);

  fixture.finishConversion("succeeded");
  const recovered = await fixture.check(3);
  const retry = await fixture.check(3);
  assert.equal(recovered.duplicate, false);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.message.messageKey, recovered.message.messageKey);
  await fixture.expectReply("job", "provider-check", recovered.message.messageKey, "applied");
  assert.deepEqual(fixture.statusRequests, [requestId, requestId, requestId]);
  const result = await fixture.read();
  assert.equal(result.data.status, "succeeded");
  assert.equal(result.version, pending.version + 1);

  for (const [status, outcome] of [["succeeded", "unchanged"], ["failed", "conflict"]]) {
    const event = { id: `event-late-${status}`, requestId, status };
    assert.equal((await fixture.postResult(event)).status, 202);
    await fixture.expectReply("webhook", "provider-result", event.id, outcome);
    assert.deepEqual(await fixture.read(), result);
  }
  assert.equal(fixture.submissions.length, 2);
  assert.equal(fixture.acceptedConversions, 1);
});
