// Durable entities through the JS runtime API, the HTTP routes, the SDK and the CLI: one scenario, each against a
// database of its own, has to come out the same — sends and duplicates, mailbox pages, state, cancelling, a message
// read back once a handler has processed it, and the refusals. The SDK and the CLI reach the routes as an App client
// does, through the Project's data route, as the caller's own Tenant.
import assert from "node:assert/strict";
import test from "node:test";
import { defineDatabaseService } from "../dist/db/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runEntitiesCommand } from "../dist/cli/entities.js";
import { serveEntityWorkloads, createMemoryWorkloadsStore } from "../dist/app/workloads/workloads-service.js";
import { openTemporaryDatabase } from "./_database.mjs";
import { fakePlatform, routeTable, runCli, steady } from "./_platform.mjs";

const app = { id: "app", type: "service", permissions: ["database.read", "database.write"], metadata: { tenantId: "acme" } };
const BASE = "http://zv.test/zelavis";
const DATA = "/zelavis/api/v1/runtime/projects/p1/data";

const surfaces = {
  js: (api) => api.forTenant("acme").entities,
  http: (api) => {
    const call = fakePlatform({ prefix: DATA, principal: app, routes: routeTable([{ basePath: "", api: defineDatabaseService(api).api, context: api }]) });
    const answered = async (method, path, body) => {
      const response = await call(`http://zv.test${DATA}${path}`, body === undefined ? { method } : { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error);
      return value;
    };
    const at = (type, id, rest) => `/entities/${encodeURIComponent(type)}/${encodeURIComponent(id)}/${rest}`;
    return {
      send: ({ type, id, ...body }) => answered("POST", at(type, id, "messages"), body),
      message: ({ type, id, messageKey }) => answered("GET", at(type, id, `messages/${encodeURIComponent(messageKey)}`)),
      cancel: ({ type, id, messageKey }) => answered("POST", at(type, id, `messages/${encodeURIComponent(messageKey)}/cancel`), {}),
      state: ({ type, id }) => answered("GET", at(type, id, "state")),
      mailbox: ({ type, id, limit }) => answered("GET", `${at(type, id, "mailbox")}${limit === undefined ? "" : `?limit=${limit}`}`),
      list: ({ type }) => answered("GET", `/entities/${type}/list`),
    };
  },
  sdk: (api) => createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis",
    fetch: fakePlatform({ prefix: DATA, principal: app, routes: routeTable([{ basePath: "", api: defineDatabaseService(api).api, context: api }]) }) }).data("p1").entities,
  cli: (api) => {
    const fetchImplementation = fakePlatform({ prefix: DATA, principal: app, routes: routeTable([{ basePath: "", api: defineDatabaseService(api).api, context: api }]) });
    const cli = (args) => runCli(runEntitiesCommand, [...args, "--project", "p1", "--url", BASE, "--json"], fetchImplementation).then(JSON.parse);
    return {
      send: ({ type, id, tag, payload, primaryKey }) => cli(["send", type, id, "--tag", tag, "--data", JSON.stringify(payload), ...(primaryKey === undefined ? [] : ["--primary-key", primaryKey])]),
      message: ({ type, id, messageKey }) => cli(["message", type, id, messageKey]),
      cancel: ({ type, id, messageKey }) => cli(["cancel", type, id, messageKey]),
      state: ({ type, id }) => cli(["state", type, id]),
      mailbox: ({ type, id, limit }) => cli(["mailbox", type, id, ...(limit === undefined ? [] : ["--limit", String(limit)])]),
      list: ({ type }) => cli(["list", type]),
    };
  },
};

const outcome = async (run) => {
  // A refusal is compared by its kind: the JS error is the tagged error itself, the others its HTTP rendering.
  try { return { answer: steady(await run()) }; } catch (error) {
    const text = String(error?.body?.error ?? error?.message ?? "");
    return { refused: error?._tag ?? (/InvalidEntityMessage|entity type|payload/.test(text) ? "InvalidEntityMessage" : text) };
  }
};
/** Generated message keys differ per database; what they are is not what the surfaces must agree on. */
const keyless = (value) => JSON.parse(JSON.stringify(value, (key, entry) => (key === "messageKey" && typeof entry === "string" && entry.length === 36 ? "<generated>" : key === "next" ? "<cursor>" : entry)));

const scenario = async (api, entities) => {
  const record = {};
  const first = await entities.send({ type: "order", id: "o-1", tag: "placed", payload: { total: 12 } });
  record.first = await outcome(async () => first);
  record.keyed = await outcome(() => entities.send({ type: "order", id: "o-1", tag: "paid", payload: { amount: 12 }, primaryKey: "pay-1" }));
  record.duplicate = await outcome(() => entities.send({ type: "order", id: "o-1", tag: "paid", payload: { amount: 12 }, primaryKey: "pay-1" }));
  record.third = await outcome(() => entities.send({ type: "order", id: "o-1", tag: "shipped", payload: {}, primaryKey: "ship-1" }));
  record.mailbox = await outcome(() => entities.mailbox({ type: "order", id: "o-1", limit: 2 }));
  record.cancel = await outcome(() => entities.cancel({ type: "order", id: "o-1", messageKey: "ship-1" }));
  record.cancelAgain = await outcome(() => entities.cancel({ type: "order", id: "o-1", messageKey: "ship-1" }));
  record.state = await outcome(() => entities.state({ type: "order", id: "o-1" }));
  record.list = await outcome(() => entities.list({ type: "order" }));
  record.badType = await outcome(() => entities.send({ type: "Order!", id: "o-1", tag: "placed", payload: {} }));
  record.badPayload = await outcome(() => entities.send({ type: "order", id: "o-1", tag: "placed", payload: [] }));

  // An entity workload processes what is owed; each surface then reads the same outcome.
  const store = createMemoryWorkloadsStore([]);
  await store.save({ id: "entity_order", projectId: "p1", type: "entity", name: "order", enabled: true, createdAt: "", updatedAt: "v1",
    code: "export default async function handle(message, { state }) { const total = (state?.total ?? 0) + (message.payload.total ?? message.payload.amount ?? 0); return { state: { total }, reply: { total } }; }" });
  const serving = serveEntityWorkloads(api, store);
  try {
    for (let tries = 0; ((await api.forTenant("acme").entities.state({ type: "order", id: "o-1" })).pending) > 0; tries++) {
      assert.ok(tries < 300, "the entity workload processes the mailbox");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally { await serving.stop(); }
  record.processed = await outcome(() => entities.message({ type: "order", id: "o-1", messageKey: "pay-1" }));
  record.after = await outcome(() => entities.state({ type: "order", id: "o-1" }));
  record.missing = await outcome(() => entities.message({ type: "order", id: "o-1", messageKey: "nope" }));
  return keyless(record);
};

test("durable entities come out the same through JS, HTTP, the SDK and the CLI", { timeout: 120_000 }, async (t) => {
  const results = {};
  for (const [name, surface] of Object.entries(surfaces)) {
    const opened = await openTemporaryDatabase(t, { crossTenantRefresh: false });
    results[name] = await scenario(opened.api, surface(opened.api));
  }
  assert.equal(results.js.duplicate.answer.duplicate, true);
  assert.deepEqual(results.js.after.answer.state, { total: 24 }, "placed and paid, the shipment cancelled");
  assert.equal(results.js.processed.answer.status, "processed");
  assert.deepEqual(results.js.processed.answer.reply, { total: 24 });
  assert.ok(results.js.badType.refused);
  for (const name of ["http", "sdk", "cli"]) {
    for (const step of Object.keys(results.js)) {
      // Refused everywhere; the CLI refuses a payload that is not an object before sending it.
      if (["missing", "badType", "badPayload"].includes(step)) { assert.ok(results[name][step].refused, `${name}: ${step} is refused`); continue; }
      assert.deepEqual(results[name][step], results.js[step], `${name}: ${step}`);
    }
    assert.ok(results[name].missing.refused, `${name}: a missing message is refused (404)`);
  }
});
