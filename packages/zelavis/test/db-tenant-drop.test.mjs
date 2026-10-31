// Removing a Tenant: what the database does, and the same removal through the HTTP route, the SDK and the CLI.
import assert from "node:assert/strict";
import test from "node:test";
import { defineDatabaseService } from "../dist/db/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runProjectsCommand } from "../dist/cli/projects.js";
import { openTemporaryDatabase, temporaryDatabaseDirectory } from "./_database.mjs";
import { openNodeDatabase } from "../dist/db/node-host.js";

const operator = { id: "operator", type: "user", permissions: ["database.inspect", "database.read", "database.write", "database.drop"] };
const BASE = "http://zv.test/zelavis";
const PROXY = "/zelavis/api/v1/runtime/projects/p1/proxy/zelavis/api/v1/database";

const route = (api) => defineDatabaseService(api).api.v1.find((entry) => entry.id === "database.tenants.drop");
const call = async (api, tenantId, body, principal = operator) => {
  const response = await route(api).handler({ service: api, params: { tenantId }, query: new URLSearchParams(), body, principal, headers: {}, request: undefined });
  return { status: response.status ?? 200, body: response.body };
};
const platform = (api) => async (input, init) => {
  const url = new URL(String(input));
  const match = /\/tenants\/([^/]+)$/.exec(url.pathname);
  assert.ok(url.pathname.startsWith(PROXY) && match && init?.method === "DELETE", `unexpected request ${init?.method} ${url.pathname}`);
  const answer = await call(api, decodeURIComponent(match[1]), JSON.parse(init.body));
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
};

const seed = async (api) => {
  for (const tenant of ["acme", "globex", "zelavis-app", "service:thing"]) {
    const db = api.forTenant(tenant);
    await db.documents.createCollection({ name: "posts" });
    for (const id of ["a", "b", "c"]) await db.documents.insert({ collection: "posts", id, data: { title: `${tenant}-${id}` } });
  }
};

test("dropping a Tenant removes it and its history and touches no other", async (t) => {
  const api = (await openTemporaryDatabase(t)).api;
  await seed(api);
  const before = (await api.forTenant("globex").documents.findMany({ collection: "posts" })).map((d) => `${d.id}:${d.version}`).sort();

  const removed = await api.dropTenant("acme");
  assert.equal(removed.tenant, "acme");
  assert.ok(removed.records >= 3, "it reports how many records it held");
  assert.ok(!(await api.tenants()).includes("acme"), "it no longer holds anything, so it is no longer listed");
  assert.deepEqual(await api.forTenant("acme").documents.listCollections(), []);
  assert.deepEqual((await api.forTenant("globex").documents.findMany({ collection: "posts" })).map((d) => `${d.id}:${d.version}`).sort(), before, "another Tenant is untouched");

  // A Tenant written to afterwards starts from nothing, and is not fenced by the removal that emptied it.
  await api.forTenant("acme").documents.createCollection({ name: "posts" });
  const again = await api.forTenant("acme").documents.insert({ collection: "posts", id: "a", data: { title: "fresh" } });
  assert.equal(again.version, 1);
  assert.deepEqual((await api.forTenant("acme").documents.findMany({ collection: "posts" })).map((d) => d.data.title), ["fresh"]);
});

test("a Tenant that cannot be removed is refused, and nothing is removed", async (t) => {
  const api = (await openTemporaryDatabase(t)).api;
  await seed(api);
  for (const [tenant, reason] of [["zv.global", /reserved/], ["zv.topology", /reserved/], ["nobody", /holds nothing/]]) {
    await assert.rejects(() => api.dropTenant(tenant), (error) => error._tag === "TenantNotDroppable" && reason.test(error.reason), tenant);
  }
  assert.equal((await api.forTenant("acme").documents.findMany({ collection: "posts" })).length, 3);
});

test("removing a Tenant comes out the same through HTTP, the SDK and the CLI, refusals included", async (t) => {
  const results = {};
  const surfaces = {
    http: (api) => async (tenantId, confirm) => {
      const answer = await call(api, tenantId, confirm === undefined ? {} : { confirm });
      if (answer.status !== 200) throw new Error(answer.body.error);
      return { tenant: answer.body.tenant };
    },
    sdk: (api) => {
      const client = createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch: platform(api) });
      return async (tenantId, confirm) => ({ tenant: (await client.projects.deleteTenant("p1", { tenantId, confirm })).tenant });
    },
    cli: (api) => async (tenantId, confirm) => {
      const originalFetch = globalThis.fetch, originalLog = console.log, lines = [];
      globalThis.fetch = platform(api);
      console.log = (line) => lines.push(String(line));
      try { await runProjectsCommand(["delete-tenant", "p1", "--tenant", tenantId, ...(confirm === undefined ? [] : ["--confirm", confirm]), "--url", BASE, "--json"]); }
      finally { globalThis.fetch = originalFetch; console.log = originalLog; }
      return { tenant: JSON.parse(lines.join("\n")).tenant };
    },
  };
  for (const [name, bind] of Object.entries(surfaces)) {
    const api = (await openTemporaryDatabase(t)).api;
    await seed(api);
    const remove = bind(api);
    const outcome = async (tenantId, confirm) => remove(tenantId, confirm).then((value) => value, (error) => ({ refused: /confirm/.test(String(error.message)) ? "unconfirmed" : /holds nothing/.test(String(error.message)) ? "holds nothing" : /reserved/.test(String(error.message)) ? "reserved" : /App's own/.test(String(error.message)) ? "the App's own" : /plugin/.test(String(error.message)) ? "a plugin's" : String(error.message) }));
    results[name] = {
      unconfirmed: await outcome("acme", undefined),
      wrongConfirm: await outcome("acme", "globex"),
      reserved: await outcome("zv.global", "zv.global"),
      appOwn: await outcome("zelavis-app", "zelavis-app"),
      plugin: await outcome("service:thing", "service:thing"),
      removed: await outcome("acme", "acme"),
      again: await outcome("acme", "acme"),
      left: (await api.tenants()).filter((tenant) => !tenant.startsWith("zv.")).sort(),
    };
  }
  assert.deepEqual(results.http, {
    unconfirmed: { refused: "unconfirmed" }, wrongConfirm: { refused: "unconfirmed" }, reserved: { refused: "reserved" },
    appOwn: { refused: "the App's own" }, plugin: { refused: "a plugin's" },
    removed: { tenant: "acme" }, again: { refused: "holds nothing" }, left: ["globex", "service:thing", "zelavis-app"],
  });
  assert.deepEqual(results.sdk, results.http);
  assert.deepEqual(results.cli, { ...results.http, unconfirmed: results.cli.unconfirmed, wrongConfirm: results.cli.wrongConfirm });
  // The CLI refuses a missing or wrong confirmation itself, before any request, and says how to repeat it.
  assert.match(JSON.stringify(results.cli.unconfirmed), /unconfirmed|--confirm/);
});

test("a caller cannot remove its own Tenant", async (t) => {
  const api = (await openTemporaryDatabase(t)).api;
  await seed(api);
  const answer = await call(api, "acme", { confirm: "acme" }, { ...operator, metadata: { tenantId: "acme" } });
  assert.equal(answer.status, 400);
  assert.match(answer.body.error, /own Tenant/);
  assert.equal((await api.forTenant("acme").documents.findMany({ collection: "posts" })).length, 3);
});

test("a divided Tenant is removed with every part and stays divided, empty", async (t) => {
  const opened = await openTemporaryDatabase(t);
  const { api, database } = opened;
  const { Effect } = await import("effect");
  await Effect.runPromise(database.topology.subdivision.subdivide("whale", ["a", "b", "c"]));
  for (const [part, count] of [["a", 2], ["b", 3]]) {
    const handle = api.forPart("whale", part);
    await handle.documents.createCollection({ name: "posts" });
    for (let n = 0; n < count; n++) await handle.documents.insert({ collection: "posts", id: `p${n}`, data: { n } });
  }
  await seed(api);
  const removed = await api.dropTenant("whale");
  assert.equal(removed.tenant, "whale");
  assert.equal(removed.shard, undefined);
  assert.deepEqual(removed.parts.map((entry) => entry.part), ["a", "b"], "only the parts that held anything are named");
  assert.equal(removed.records, removed.parts.reduce((sum, entry) => sum + entry.records, 0));
  assert.ok(!(await api.partitions()).some((key) => key.startsWith("whale")), "no part holds anything");
  assert.deepEqual(api.partsOf("whale"), ["a", "b", "c"], "the division is routing and stays");
  assert.equal((await api.forTenant("acme").documents.findMany({ collection: "posts" })).length, 3, "another Tenant is untouched");
  await assert.rejects(() => api.dropTenant("whale"), (error) => error._tag === "TenantNotDroppable" && /holds nothing/.test(error.reason));
});

test("a removal cut off after it began removing is finished when the database next opens", async (t) => {
  const directory = temporaryDatabaseDirectory(t);
  const { Effect } = await import("effect");
  const first = await openNodeDatabase({ directory, shards: ["shard-0", "shard-1"] });
  await seed(first.api);
  // What a crash between the fence and the last removal batch leaves: the partition fenced for removal, records still there.
  const shard = first.database.shardOf("acme");
  await first.close();
  const { makeNodeSqliteStore } = await import("../dist/db/engines/node-sqlite.js");
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* makeNodeSqliteStore(shard, directory);
    yield* store.partition("acme").fence({ from: shard, to: "removed" });
  })));
  const second = await openNodeDatabase({ directory, shards: ["shard-0", "shard-1"] });
  try {
    assert.ok(!(await second.api.tenants()).includes("acme"), "the removal was finished at open");
    assert.equal((await second.api.forTenant("globex").documents.findMany({ collection: "posts" })).length, 3, "another Tenant is untouched");
    await second.api.forTenant("acme").documents.createCollection({ name: "posts" });
    assert.equal((await second.api.forTenant("acme").documents.insert({ collection: "posts", id: "a", data: {} })).version, 1, "and the Tenant starts again from nothing");
  } finally { await second.close(); }
});
