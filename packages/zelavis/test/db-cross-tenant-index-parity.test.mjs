// A Project's cross-Tenant indexes through the HTTP routes, the SDK and the CLI: each reaches the same routes the
// way it does on a Platform, through the Project proxy, and each must define, refresh, query, refuse and drop the
// same way with the same answers.
import assert from "node:assert/strict";
import test from "node:test";
import { defineDatabaseService } from "../dist/db/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runCrossTenantIndexesCommand } from "../dist/cli/cross-tenant-indexes.js";
import { openTemporaryDatabase } from "./_database.mjs";

const BASE = "http://zv.test/zelavis";
const PROXY = "/zelavis/api/v1/runtime/projects/p1/proxy/zelavis/api/v1/database/cross-tenant-indexes";

const routeOf = (api, id) => {
  const found = defineDatabaseService(api).api.v1.find((entry) => entry.id === id);
  assert.ok(found, `route ${id} should exist`);
  return found;
};
const call = async (api, id, params = {}, body) => {
  const response = await routeOf(api, id).handler({ service: api, params, query: new URLSearchParams(), body, principal: undefined, headers: {}, request: undefined });
  return { status: response.status ?? 200, body: response.body };
};
const orThrow = (answer) => {
  if (answer.status >= 400) throw Object.assign(new Error(answer.body.error), { status: answer.status });
  return answer.body;
};

/** A Platform whose Project proxy reaches the cross-Tenant index routes and nothing else. */
const platform = (api) => async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  assert.ok(url.pathname.startsWith(PROXY), `unexpected request ${method} ${url.pathname}`);
  const [name, action] = url.pathname.slice(PROXY.length).split("/").filter(Boolean).map(decodeURIComponent);
  const id = name === undefined
    ? (method === "GET" ? "database.crossTenantIndexes.list" : "database.crossTenantIndexes.define")
    : action === undefined
      ? (method === "GET" ? "database.crossTenantIndexes.get" : "database.crossTenantIndexes.drop")
      : `database.crossTenantIndexes.${action}`;
  const answer = await call(api, id, name === undefined ? {} : { name }, body);
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
};

const surfaces = {
  http: (api) => ({
    define: async (definition) => orThrow(await call(api, "database.crossTenantIndexes.define", {}, definition)),
    list: async () => orThrow(await call(api, "database.crossTenantIndexes.list")),
    get: async (name) => orThrow(await call(api, "database.crossTenantIndexes.get", { name })),
    refresh: async (name) => orThrow(await call(api, "database.crossTenantIndexes.refresh", { name })),
    query: async (name, input) => orThrow(await call(api, "database.crossTenantIndexes.query", { name }, input)),
    drop: async (name) => orThrow(await call(api, "database.crossTenantIndexes.drop", { name })),
  }),
  sdk: (api) => createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch: platform(api) }).crossTenantIndexes("p1"),
  cli: (api) => {
    const cli = async (args) => {
      const originalFetch = globalThis.fetch, originalLog = console.log, lines = [];
      globalThis.fetch = platform(api);
      console.log = (line) => lines.push(String(line));
      try { await runCrossTenantIndexesCommand([...args, "--project", "p1", "--url", BASE, "--json"]); } finally { globalThis.fetch = originalFetch; console.log = originalLog; }
      return JSON.parse(lines.join("\n"));
    };
    return {
      define: (definition) => cli(["define", "--definition", JSON.stringify(definition)]),
      list: () => cli(["list"]),
      get: (name) => cli(["get", name]),
      refresh: (name) => cli(["refresh", name]),
      query: (name, input) => cli([
        "query", name,
        ...(input.where ? ["--where", JSON.stringify(input.where)] : []),
        ...(input.orderBy ? ["--order-by", JSON.stringify(input.orderBy)] : []),
        ...(input.tenants ? ["--tenants", input.tenants.join(",")] : []),
        ...(input.limit ? ["--limit", String(input.limit)] : []),
      ]),
      drop: (name) => cli(["drop", name]),
    };
  },
};

/** Without the times, which differ between runs. */
const timeless = (value) => JSON.parse(JSON.stringify(value, (key, entry) =>
  ["createdAt", "refreshedAt", "updatedAt"].includes(key) ? undefined : entry));

test("cross-Tenant indexes: define, refresh, query, refuse and drop come out the same through HTTP, the SDK and the CLI", async (t) => {
  const results = {};
  for (const [name, bind] of Object.entries(surfaces)) {
    // Refreshed only when asked, so every surface's refresh is the one that fills the index.
    const opened = await openTemporaryDatabase(t, { crossTenantRefresh: false });
    const api = opened.api;
    for (const [tenant, rows] of [["acme", [["a1", "red", 9], ["a2", "blue", 5]]], ["bravo", [["b1", "red", 7]]]]) {
      await api.forTenant(tenant).documents.createCollection({ name: "cars" });
      for (const [id, color, price] of rows) await api.forTenant(tenant).documents.insert({ collection: "cars", id, data: { color, price } });
    }
    const surface = bind(api);
    const defined = await surface.define({ name: "cars", collection: "cars", columns: ["color", "price"] });
    const refreshed = await surface.refresh("cars");
    const red = await surface.query("cars", { where: [{ path: "color", value: "red" }], orderBy: [{ path: "price" }] });
    const onlyBravo = await surface.query("cars", { tenants: ["bravo"] });
    const listed = await surface.list();
    const got = await surface.get("cars");
    const undeclared = await surface.query("cars", { where: [{ path: "model", value: "x" }] }).then(() => "accepted", (error) => String(error.message));
    const twice = await surface.define({ name: "cars", collection: "cars" }).then(() => "accepted", (error) => String(error.message));
    const dropped = await surface.drop("cars");
    const missing = await surface.get("cars").then(() => "found", (error) => String(error.message));
    results[name] = timeless({ defined, refreshed, red, onlyBravo, listed, got, undeclared, twice, dropped, missing });
  }
  const http = results.http;
  assert.deepEqual(http.red.matches.map((match) => [match.tenant, match.id, match.data.price]), [["bravo", "b1", 7], ["acme", "a1", 9]]);
  assert.deepEqual(http.onlyBravo.matches.map((match) => match.id), ["b1"]);
  assert.equal(http.refreshed.applied, 3);
  assert.equal(http.listed.indexes.length, 1);
  assert.match(http.undeclared, /does not index "model"/);
  assert.match(http.twice, /already exists/);
  assert.equal(http.dropped.name, "cars");
  assert.match(http.missing, /No cross-Tenant index is named "cars"/);
  assert.deepEqual(results.sdk, http);
  assert.deepEqual(results.cli, http);
});

test("cross-Tenant indexes: reading needs database.inspect, changing them needs database.indexes.manage", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const permissions = (id) => routeOf(api, id).access.permissions;
  for (const id of ["list", "get", "query"]) assert.deepEqual(permissions(`database.crossTenantIndexes.${id}`), ["database.inspect"]);
  for (const id of ["define", "drop", "refresh"]) assert.deepEqual(permissions(`database.crossTenantIndexes.${id}`), ["database.indexes.manage"]);
});

test("cross-Tenant indexes: the CLI refuses what it cannot send", async () => {
  await assert.rejects(() => runCrossTenantIndexesCommand(["list", "--url", BASE]), /need --project/);
  await assert.rejects(() => runCrossTenantIndexesCommand(["define", "--project", "p1", "--url", BASE]), /requires --definition with a JSON object/);
  await assert.rejects(() => runCrossTenantIndexesCommand(["query", "cars", "--project", "p1", "--where", "{}", "--url", BASE]), /--where requires a JSON array/);
});
