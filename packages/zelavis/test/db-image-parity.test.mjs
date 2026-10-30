// Database images through the HTTP routes, the SDK and the CLI: each reaches the same routes the way it does on a
// Platform, through the Project proxy, and each must write, list and refuse the same way.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defineDatabaseService } from "../dist/db/index.js";
import { openNodeDatabase } from "../dist/db/node-host.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runProjectsCommand } from "../dist/cli/projects.js";

const BASE = "http://zv.test/zelavis";
const PROXY = "/zelavis/api/v1/runtime/projects/p1/proxy/zelavis/api/v1/database";
const operator = { id: "operator", type: "user", permissions: ["database.backup", "database.inspect"] };

const routeOf = (api, id) => defineDatabaseService(api).api.v1.find((entry) => entry.id === id);
const call = async (api, id, body) => {
  const response = await routeOf(api, id).handler({ service: api, params: {}, query: new URLSearchParams(), body, principal: operator, headers: {}, request: undefined });
  return { status: response.status ?? 200, body: response.body };
};
const platform = (api) => async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.pathname, `${PROXY}/maintenance/images`, `unexpected request ${url.pathname}`);
  const answer = init?.method === "POST"
    ? await call(api, "database.images.create", JSON.parse(init.body))
    : await call(api, "database.images.list");
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
};

const surfaces = {
  http: (api) => ({
    create: async (name, engine) => {
      const answer = await call(api, "database.images.create", { ...(name === undefined ? {} : { name }), ...(engine === undefined ? {} : { engine }) });
      if (answer.status !== 200) throw Object.assign(new Error(answer.body.error), { status: answer.status });
      return answer.body;
    },
    list: async () => (await call(api, "database.images.list")).body.images,
  }),
  sdk: (api) => {
    const client = createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch: platform(api) });
    return {
      create: (name, engine) => client.projects.createDatabaseImage("p1", { name, ...(engine === undefined ? {} : { engine }) }),
      list: () => client.projects.databaseImages("p1"),
    };
  },
  cli: (api) => {
    const cli = async (args) => {
      const originalFetch = globalThis.fetch, originalLog = console.log, lines = [];
      globalThis.fetch = platform(api);
      console.log = (line) => lines.push(String(line));
      try { await runProjectsCommand([...args, "--url", BASE, "--json"]); } finally { globalThis.fetch = originalFetch; console.log = originalLog; }
      return JSON.parse(lines.join("\n"));
    };
    return {
      create: async (name, engine) => (await cli(["create-image", "p1", name, ...(engine === undefined ? [] : ["--storage", engine])])).image,
      list: async () => (await cli(["images", "p1"])).images,
    };
  },
};

test("database images come out the same through HTTP, the SDK and the CLI, refusals included", async (t) => {
  const results = {};
  for (const [name, bind] of Object.entries(surfaces)) {
    const root = mkdtempSync(join(tmpdir(), "zv-image-parity-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const opened = await openNodeDatabase({ directory: join(root, "shards"), crossTenantRefresh: false });
    t.after(() => opened.close());
    await opened.api.forTenant("acme").documents.createCollection({ name: "posts" });
    await opened.api.forTenant("acme").documents.insert({ collection: "posts", id: "a", data: { title: "a" } });
    const surface = bind(opened.api);
    const refused = (imageName, engine) => surface.create(imageName, engine).then(() => "accepted", (error) => ({ status: error.status, message: String(error.message).replace(/\s+/g, " ") }));
    const first = await surface.create("nightly");
    results[name] = {
      first: { name: first.name, engine: first.engine, shards: first.shards.map((entry) => entry.shard).sort(), keysPositive: first.keys > 0 && first.bytes > 0 },
      listed: (await surface.list()).map((entry) => entry.name),
      taken: await refused("nightly"),
      badName: await refused(".hidden"),
      badEngine: await refused("other", "libsql-remote"),
    };
  }
  const http = results.http;
  assert.equal(http.first.engine, "sqlite");
  assert.ok(http.first.shards.length >= 2 && http.first.keysPositive);
  assert.deepEqual(http.listed, ["nightly"]);
  assert.match(http.taken.message, /already exists/);
  assert.match(http.badName.message, /image name is 1 to 64/);
  assert.match(http.badEngine.message, /local engine/);
  assert.deepEqual(results.sdk, http);
  assert.deepEqual(results.cli, http);
});

test("a host that writes no images says so", async () => {
  const { runtimeApiFor } = await import("../dist/db/runtime-api.js");
  const { makeDatabase, partitionMapFor } = await import("../dist/db/index.js");
  const { Effect } = await import("effect");
  const { memoryKvEngine } = await import("../dist/db/engines/memory-kv.js");
  const { openShardOverKv } = await import("../dist/db/kv-store.js");
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const db = yield* makeDatabase({ partitionMap: partitionMapFor(["s0"]), crossTenantRefresh: false, openShard: (shard) => openShardOverKv(shard, memoryKvEngine()) });
    const api = runtimeApiFor(db);
    assert.deepEqual(yield* Effect.promise(() => api.images.list()), []);
    const answer = yield* Effect.promise(() => call(api, "database.images.create", { name: "x" }));
    assert.equal(answer.status, 400);
    assert.match(answer.body.error, /cannot write database images/);
  })));
});
