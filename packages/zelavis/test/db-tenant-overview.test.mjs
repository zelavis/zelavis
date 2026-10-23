// The Tenants of a Project's database, listed and created through the HTTP routes, the SDK and the CLI: each
// reaches the same routes the way it does on a Platform, through the Project proxy, and each has to see the same
// Tenants with the same counts, create a Tenant the same way, and be refused the same way for a repeat.
import assert from "node:assert/strict";
import test from "node:test";
import { defineDatabaseService } from "../dist/db/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runProjectsCommand } from "../dist/cli/projects.js";
import { openTemporaryDatabase } from "./_database.mjs";

const operator = { id: "operator", type: "user", permissions: ["database.inspect", "database.read", "database.write"] };
const BASE = "http://zv.test/zelavis";
const PROXY = "/zelavis/api/v1/runtime/projects/p1/proxy/zelavis/api/v1/database";

const routeOf = (api, id) => {
  const found = defineDatabaseService(api).api.v1.find((entry) => entry.id === id);
  assert.ok(found, `route ${id} should exist`);
  return found;
};
const call = async (api, id, body, query = new URLSearchParams()) => {
  const response = await routeOf(api, id).handler({ service: api, params: {}, query, body, principal: operator, headers: {}, request: undefined });
  return { status: response.status ?? 200, body: response.body };
};

/** A Platform whose Project proxy reaches the two routes under test and nothing else. */
const platform = (api) => async (input, init) => {
  const url = new URL(String(input));
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  const answer = url.pathname === `${PROXY}/tenants/overview` && (init?.method ?? "GET") === "GET"
    ? await call(api, "database.tenants.overview")
    : url.pathname === `${PROXY}/documents/collections` && init?.method === "POST"
      ? await call(api, "database.collections.create", body)
      : assert.fail(`unexpected request ${init?.method} ${url.pathname}`);
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
};

const surfaces = {
  http: (api) => ({
    list: async () => (await call(api, "database.tenants.overview")).body.tenants,
    create: async (tenantId, table) => {
      const answer = await call(api, "database.collections.create", { tenantId, name: table, surface: "database", metadata: { kind: "table" } });
      if (answer.status >= 400) throw new Error(answer.body.error);
      return answer.body;
    },
  }),
  sdk: (api) => {
    const client = createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch: platform(api) });
    return { list: () => client.projects.tenants("p1"), create: (tenantId, table) => client.projects.createTenant("p1", { tenantId, table }) };
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
      list: async () => (await cli(["tenants", "p1"])).tenants,
      create: async (tenantId, table) => (await cli(["create-tenant", "p1", "--tenant", tenantId, "--table", table])),
    };
  },
};

const shape = (tenants) => tenants.map(({ tenantId, tables, records }) => ({ tenantId, tables, records })).sort((a, b) => a.tenantId.localeCompare(b.tenantId));

test("tenants: listing and creating come out the same through HTTP, the SDK and the CLI", async (t) => {
  const results = {};
  for (const [name, bind] of Object.entries(surfaces)) {
    const api = (await openTemporaryDatabase(t)).api;
    const surface = bind(api);
    const acme = api.forTenant("acme");
    await acme.documents.createCollection({ name: "posts" });
    for (const id of ["a", "b", "c"]) await acme.documents.insert({ collection: "posts", id, data: { title: id } });
    await api.forTenant("emptied").documents.createCollection({ name: "tmp" });
    await api.forTenant("emptied").documents.dropCollection({ name: "tmp" });

    const before = shape(await surface.list());
    await surface.create("globex", "orders");
    const refused = await surface.create("globex", "orders").then(() => "accepted", (error) => String(error.message ?? error));
    const after = shape(await surface.list());
    const detail = (await surface.list()).find((entry) => entry.tenantId === "acme");
    results[name] = { before, after, refused, shard: typeof detail.shard, bytesPositive: detail.bytes > 0 };
  }
  // Records are what the partition stores, so a table's own definition counts beside its three documents.
  assert.deepEqual(results.http.before.map(({ tenantId, tables }) => ({ tenantId, tables })), [{ tenantId: "acme", tables: 1 }, { tenantId: "emptied", tables: 0 }]);
  assert.ok(results.http.before[0].records >= 3, "acme holds at least its three documents");
  assert.equal(results.http.before[1].records, 0, "a Tenant with every table dropped holds no records");
  assert.deepEqual(results.http.after.map((entry) => entry.tenantId), ["acme", "emptied", "globex"]);
  assert.equal(results.http.after.find((entry) => entry.tenantId === "globex").tables, 1);
  assert.match(results.http.refused, /already exists/);
  assert.equal(results.http.shard, "string"); assert.equal(results.http.bytesPositive, true);
  assert.deepEqual(results.sdk, results.http);
  assert.deepEqual(results.cli, results.http);
});

test("tenants: an unknown flag combination is refused by the CLI", async () => {
  await assert.rejects(() => runProjectsCommand(["tenants", "p1", "--table", "x", "--url", BASE]), /--table is only supported by projects create-tenant/);
  await assert.rejects(() => runProjectsCommand(["create-tenant", "p1", "--tenant", "x", "--url", BASE]), /requires --tenant <id> and --table <name>/);
});
