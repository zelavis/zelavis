// How many documents a collection holds, through the JS API, the HTTP route, the SDK and the CLI: each against a
// database of its own, with the same documents written and removed, has to give the same counts and the same refusal.
// The SDK and the CLI reach the route as an App client does, through the Project's data route.
import assert from "node:assert/strict";
import test from "node:test";
import { defineDatabaseService } from "../dist/db/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runDataCommand } from "../dist/cli/data.js";
import { openTemporaryDatabase } from "./_database.mjs";

const app = { id: "app", type: "service", permissions: ["database.read", "database.write"], metadata: { tenantId: "acme" } };
const BASE = "http://zv.test/zelavis";
const COUNT_PATH = /^\/zelavis\/api\/v1\/runtime\/projects\/p1\/data\/documents\/collections\/([^/]+)\/count$/;

const route = (api) => defineDatabaseService(api).api.v1.find((entry) => entry.id === "database.collections.count");
const answer = async (api, collection) => {
  const response = await route(api).handler({ service: api, params: { collection }, query: new URLSearchParams(), body: undefined, principal: app, headers: {}, request: undefined });
  return { status: response.status ?? 200, body: response.body };
};
const platform = (api) => async (input) => {
  const match = COUNT_PATH.exec(new URL(String(input)).pathname);
  assert.ok(match, `unexpected request ${input}`);
  const response = await answer(api, decodeURIComponent(match[1]));
  return new Response(JSON.stringify(response.body), { status: response.status, headers: { "content-type": "application/json" } });
};

const surfaces = {
  js: (api) => (collection) => api.forTenant("acme").documents.count(collection),
  http: (api) => async (collection) => {
    const response = await answer(api, collection);
    if (response.status !== 200) throw new Error(response.body.error);
    return response.body.count;
  },
  sdk: (api) => {
    const data = createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch: platform(api) }).data("p1");
    return (collection) => data.collections.count(collection);
  },
  cli: (api) => async (collection) => {
    const originalFetch = globalThis.fetch, originalLog = console.log, lines = [];
    globalThis.fetch = platform(api);
    console.log = (line) => lines.push(String(line));
    try { await runDataCommand(["count", collection, "--project", "p1", "--url", BASE, "--json"]); } finally { globalThis.fetch = originalFetch; console.log = originalLog; }
    return JSON.parse(lines.join("\n")).count;
  },
};

test("a collection's document count follows inserts, removals and other collections and Tenants, past a query window", async (t) => {
  const api = (await openTemporaryDatabase(t)).api;
  const acme = api.forTenant("acme");
  await acme.documents.createCollection({ name: "posts" });
  await acme.documents.createCollection({ name: "notes" });
  assert.equal(await acme.documents.count("posts"), 0, "a new collection holds no documents, though its definition is a record");
  const TOTAL = 4500; // more than one window of identifiers and more than a clause is read to
  for (let at = 0; at < TOTAL; at += 500) {
    await acme.documents.write({ operations: Array.from({ length: 500 }, (_, i) => ({ _tag: "Insert", collection: "posts", id: `p${at + i}`, data: { title: `post ${at + i}` } })) });
  }
  await acme.documents.insert({ collection: "notes", id: "n1", data: { title: "other collection" } });
  await api.forTenant("globex").documents.createCollection({ name: "posts" });
  await api.forTenant("globex").documents.insert({ collection: "posts", id: "g1", data: { title: "other tenant" } });
  assert.equal(await acme.documents.count("posts"), TOTAL);
  await acme.documents.update({ collection: "posts", id: "p1", data: { title: "revised" } });
  assert.equal(await acme.documents.count("posts"), TOTAL, "an update is not a new document");
  for (const id of ["p2", "p3", "p4000"]) await acme.documents.delete({ collection: "posts", id });
  assert.equal(await acme.documents.count("posts"), TOTAL - 3);
  assert.equal(await acme.documents.count("notes"), 1);
  await assert.rejects(() => acme.documents.count("missing"), (error) => error._tag === "CollectionNotFound");
});

test("counting comes out the same through JS, HTTP, the SDK and the CLI, a missing collection included", async (t) => {
  const results = {};
  for (const [name, bind] of Object.entries(surfaces)) {
    const api = (await openTemporaryDatabase(t)).api;
    const acme = api.forTenant("acme");
    await acme.documents.createCollection({ name: "posts" });
    const count = bind(api);
    const outcome = (collection) => count(collection).then((value) => value, (error) => ({ refused: /not found|exist|NotFound/i.test(String(error.message ?? error._tag)) || error._tag === "CollectionNotFound" ? "no such collection" : String(error.message) }));
    const seen = [await outcome("posts")];
    for (const id of ["a", "b", "c"]) await acme.documents.insert({ collection: "posts", id, data: { title: id } });
    seen.push(await outcome("posts"));
    await acme.documents.delete({ collection: "posts", id: "b" });
    seen.push(await outcome("posts"), await outcome("missing"));
    results[name] = seen;
  }
  assert.deepEqual(results.js, [0, 3, 2, { refused: "no such collection" }]);
  for (const name of ["http", "sdk", "cli"]) assert.deepEqual(results[name], results.js, name);
});
