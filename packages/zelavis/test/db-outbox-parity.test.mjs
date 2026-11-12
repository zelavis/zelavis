// The outbox through the JS API, the HTTP routes, the SDK and the CLI: one
// scenario, each against a database of its own, has to come out the same —
// the same messages, pages, cursors' effect, removals and refusals.
//
// The SDK and the CLI reach the routes as an App client does, through the
// Project's data route; the fake Platform here hands each request to the
// database service's own handler, as the caller's own Tenant.
import assert from "node:assert/strict";
import test from "node:test";
import { defineDatabaseService } from "../dist/db/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runDataCommand } from "../dist/cli/data.js";
import { openTemporaryDatabase } from "./_database.mjs";

/** An App client: data authority, confined to its own Tenant. */
const app = { id: "app", type: "service", permissions: ["database.read", "database.write"], metadata: { tenantId: "acme" } };
const BASE = "http://zv.test/zelavis";
const DATA_PATH = /^\/zelavis\/api\/v1\/runtime\/projects\/p1\/data(\/.*)$/;

/** What the database service answers for one request. */
const answer = async (api, method, path, { query = new URLSearchParams(), body } = {}) => {
  const route = defineDatabaseService(api).api.v1.find((candidate) => candidate.method === method && candidate.path === path);
  assert.ok(route, `no route ${method} ${path}`);
  const response = await route.handler({ service: api, params: {}, query, body, principal: app, headers: {}, request: undefined });
  return { status: response.status ?? 200, body: response.body };
};

const platform = (api) => async (input, init) => {
  const url = new URL(String(input));
  const match = DATA_PATH.exec(url.pathname);
  assert.ok(match, `unexpected request ${url.pathname}`);
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  const response = await answer(api, method, match[1], { query: url.searchParams, body });
  return new Response(JSON.stringify(response.body), { status: response.status, headers: { "content-type": "application/json" } });
};

const surfaces = {
  js: (api) => {
    const acme = api.forTenant("acme");
    return {
      write: (input) => acme.documents.write(input),
      emit: (input) => acme.outbox.emit(input),
      read: (options = {}) => acme.outbox.read(options),
      remove: (ids) => acme.outbox.remove({ ids }),
    };
  },
  http: (api) => {
    const answered = async (method, path, init) => {
      const response = await answer(api, method, path, init);
      if (response.status >= 400) throw new Error(response.body.error);
      return response.body;
    };
    return {
      write: async (input) => (await answered("POST", "/documents/write", { body: input })).written,
      emit: (input) => answered("POST", "/outbox/messages", { body: input }),
      read: (options = {}) => answered("GET", "/outbox/messages", {
        query: new URLSearchParams(Object.entries(options).map(([name, value]) => [name, String(value)])),
      }),
      remove: (ids) => answered("POST", "/outbox/messages/remove", { body: { ids } }),
    };
  },
  sdk: (api) => {
    const data = createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch: platform(api) }).data("p1");
    return {
      write: (input) => data.documents.write(input),
      emit: (input) => data.outbox.emit(input),
      read: (options) => data.outbox.read(options),
      remove: (ids) => data.outbox.remove(ids),
    };
  },
  cli: (api) => {
    const cli = async (args) => {
      const originalFetch = globalThis.fetch;
      const originalLog = console.log;
      const lines = [];
      globalThis.fetch = platform(api);
      console.log = (line) => lines.push(String(line));
      try {
        await runDataCommand([...args, "--project", "p1", "--url", BASE, "--json"]);
      } finally {
        globalThis.fetch = originalFetch;
        console.log = originalLog;
      }
      return JSON.parse(lines.join("\n"));
    };
    return {
      write: async (input) => (await cli([
        "write", "--operations", JSON.stringify(input.operations),
        ...(input.emit === undefined ? [] : ["--emit", JSON.stringify(input.emit)]),
      ])).written,
      emit: (input) => cli([
        "outbox-emit", input.topic, ...(input.id === undefined ? [] : [input.id]),
        "--data", JSON.stringify(input.payload),
        ...(input.idempotencyKey === undefined ? [] : ["--idempotency-key", input.idempotencyKey]),
      ]),
      read: (options = {}) => cli([
        "outbox", ...(options.topic === undefined ? [] : [options.topic]),
        ...(options.after === undefined ? [] : ["--after", options.after]),
        ...(options.limit === undefined ? [] : ["--limit", String(options.limit)]),
      ]),
      remove: (ids) => cli(["outbox-remove", "--ids", ids.join(",")]),
    };
  },
};

/** A page without what differs run to run: the time and the opaque cursors. */
const shape = (page) => ({
  messages: page.messages.map(({ emittedAt, cursor, ...message }) => message),
  more: page.more,
});

const scenario = async (surface) => {
  const outcomes = [];
  const step = async (name, run) => {
    try {
      outcomes.push({ name, result: await run() });
    } catch (error) {
      outcomes.push({ name, refused: error?._tag ?? error?.message ?? String(error) });
    }
  };
  await step("written with a message", async () => (await surface.write({
    operations: [{ _tag: "Insert", collection: "orders", id: "o1", data: { total: 10 } }],
    emit: [{ topic: "order.placed", payload: { order: "o1" }, id: "m1" }],
  })).map((entry) => `${entry._tag}:${entry.document.id}`));
  await step("emitted on its own", () => surface.emit({ topic: "note", payload: { n: 1 }, id: "m2" }));
  await step("emitted twice under one id", () => surface.emit({ topic: "note", payload: { n: 2 }, id: "m2" }));
  await step("not a message", () => surface.emit({ topic: "", payload: {} }));
  await step("emitted idempotently", () => surface.emit({ topic: "note", payload: { n: 3 }, idempotencyKey: "k" }));
  await step("and replayed", () => surface.emit({ topic: "note", payload: { n: 3 }, idempotencyKey: "k" }));
  await step("read whole", async () => shape(await surface.read()));
  await step("read by topic", async () => shape(await surface.read({ topic: "note" })));
  await step("read a page, then on from its cursor", async () => {
    const first = await surface.read({ limit: 1 });
    return [shape(first), shape(await surface.read({ after: first.cursor }))];
  });
  await step("removed", () => surface.remove(["m1", "nope"]));
  await step("read after removal", async () => shape(await surface.read()));
  return outcomes;
};

const REFUSALS = {
  "emitted twice under one id": ["MessageExists", 'The outbox already holds a message with id "m2".'],
  "not a message": ["InvalidMessage", "Not a message: a topic must be 1 to 256 characters."],
};

test("outbox: writes with messages, emits, pages, removals and refusals come out the same through JS, HTTP, the SDK and the CLI", async (t) => {
  const runs = {};
  for (const [name, bind] of Object.entries(surfaces)) {
    const { api } = await openTemporaryDatabase(t);
    await api.forTenant("acme").documents.createCollection({ name: "orders" });
    runs[name] = await scenario(bind(api));
  }

  const byStep = Object.fromEntries(runs.js.map((outcome) => [outcome.name, outcome]));
  assert.deepEqual(byStep["written with a message"].result, ["Inserted:o1"]);
  assert.deepEqual(byStep["emitted on its own"].result, { id: "m2" });
  assert.deepEqual(byStep["emitted idempotently"].result, { id: "idempotent:k" });
  assert.deepEqual(byStep["and replayed"].result, { id: "idempotent:k" });
  assert.deepEqual(byStep["read whole"].result.messages.map((message) => message.id), ["m1", "m2", "idempotent:k"]);
  assert.deepEqual(byStep["read by topic"].result.messages.map((message) => message.id), ["m2", "idempotent:k"]);
  assert.deepEqual(byStep["read a page, then on from its cursor"].result.map((page) => page.messages.map((message) => message.id)), [["m1"], ["m2", "idempotent:k"]]);
  assert.deepEqual(byStep.removed.result, { removed: 1 });
  assert.deepEqual(byStep["read after removal"].result.messages.map((message) => message.id), ["m2", "idempotent:k"]);

  for (const [name, outcomes] of Object.entries(runs)) {
    assert.deepEqual(outcomes.map((outcome) => outcome.name), runs.js.map((outcome) => outcome.name));
    for (const [index, outcome] of outcomes.entries()) {
      const refusal = REFUSALS[outcome.name];
      if (refusal !== undefined) {
        assert.deepEqual(outcome, { name: outcome.name, refused: name === "js" ? refusal[0] : refusal[1] }, `${name}: ${outcome.name}`);
      } else {
        assert.deepEqual(outcome, runs.js[index], `${name}: ${outcome.name}`);
      }
    }
  }
});

test("outbox: the SDK reads with a GET, so a client allowed only to read data can consume messages", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const requests = [];
  const record = platform(api);
  const data = createZelavisClient({
    baseUrl: "http://zv.test", rootPath: "/zelavis",
    fetch: (input, init) => {
      requests.push({ method: init?.method ?? "GET", url: String(input) });
      return record(input, init);
    },
  }).data("p1");
  await data.outbox.emit({ topic: "t", payload: {}, id: "m1" });
  await data.outbox.read({ topic: "t", limit: 5 });
  assert.equal(requests.at(-1).method, "GET");
  assert.match(requests.at(-1).url, /\/data\/outbox\/messages\?limit=5&topic=t$/);
});
