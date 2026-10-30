// The export stream through the HTTP route, the SDK and the CLI: each reaches the same route the way it does
// on a Platform, through the Project proxy, and each must page, finish, refuse and report the same way.
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { defineDatabaseService } from "../dist/db/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runProjectsCommand } from "../dist/cli/projects.js";
import { openTemporaryDatabase } from "./_database.mjs";

const BASE = "http://zv.test/zelavis";
const PROXY = "/zelavis/api/v1/runtime/projects/p1/proxy/zelavis/api/v1/database";
const operator = { id: "operator", type: "user", permissions: ["database.backup", "database.inspect", "database.read", "database.write"] };

const route = (api) => defineDatabaseService(api).api.v1.find((entry) => entry.id === "database.tenants.export");
const call = async (api, tenantId, body) => {
  const response = await route(api).handler({ service: api, params: { tenantId }, query: new URLSearchParams(), body, principal: operator, headers: {}, request: undefined });
  return { status: response.status ?? 200, body: response.body };
};
const platform = (api) => async (input, init) => {
  const url = new URL(String(input));
  const match = /\/tenants\/([^/]+)\/export$/.exec(url.pathname);
  assert.ok(url.pathname.startsWith(PROXY) && match && init?.method === "POST", `unexpected request ${init?.method} ${url.pathname}`);
  const answer = await call(api, decodeURIComponent(match[1]), init.body === undefined ? {} : JSON.parse(init.body));
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
};

const seed = async (db) => {
  for (const tenant of ["acme", "globex"]) {
    const handle = db.api.forTenant(tenant);
    await handle.documents.createCollection({ name: "posts" });
    for (const id of ["a", "b", "c", "d", "e"]) await handle.documents.insert({ collection: "posts", id, data: { title: `${tenant}-${id}` } });
  }
  await Effect.runPromise(db.database.topology.subdivision.subdivide("whale", ["a", "b"]));
  for (const [part, ids] of [["a", ["1", "2", "3"]], ["b", ["1"]]]) {
    const handle = db.api.forPart("whale", part);
    await handle.documents.createCollection({ name: "posts" });
    for (const id of ids) await handle.documents.insert({ collection: "posts", id, data: { title: `${part}${id}` } });
  }
};

const surfaces = {
  http: (db) => ({
    page: async (tenantId, cursor, limit) => {
      const answer = await call(db.api, tenantId, { ...(cursor === undefined ? {} : { cursor }), ...(limit === undefined ? {} : { limit }) });
      if (answer.status !== 200) throw Object.assign(new Error(answer.body.error), { status: answer.status });
      return answer.body;
    },
  }),
  sdk: (db) => {
    const client = createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch: platform(db.api) });
    return { page: (tenantId, cursor, limit) => client.projects.exportTenantPage("p1", { tenantId, ...(cursor === undefined ? {} : { cursor }), ...(limit === undefined ? {} : { limit }) }) };
  },
  cli: (db) => ({
    page: async (tenantId, cursor, limit, extra = []) => {
      const originalFetch = globalThis.fetch, originalLog = console.log, lines = [];
      globalThis.fetch = platform(db.api);
      console.log = (line) => lines.push(String(line));
      try {
        await runProjectsCommand(["export-stream", "p1", "--tenant", tenantId, ...(cursor === undefined ? [] : ["--after", cursor]), ...(limit === undefined ? [] : ["--limit", String(limit)]), ...extra, "--url", BASE, "--json"]);
      } finally { globalThis.fetch = originalFetch; console.log = originalLog; }
      return JSON.parse(lines.join("\n"));
    },
  }),
};

/** Everything a client ends with, without what is clock- or run-dependent (`at`, the bodies' timestamps, the cursor's hold name). */
const drain = async (surface, tenantId, limit) => {
  let cursor;
  const entries = [];
  let pages = 0;
  for (;;) {
    const page = await surface.page(tenantId, cursor, limit);
    entries.push(...page.entries.map(({ at, body, manifest, ...rest }) => ({ ...rest, body: typeof body, manifest: typeof manifest })));
    pages += 1;
    cursor = page.cursor;
    if (page.consistent) return { entries, pages, cursor: typeof cursor, parts: page.parts };
    assert.ok(pages < 50);
  }
};

test("the export stream comes out the same through HTTP, the SDK and the CLI, refusals included", async (t) => {
  const results = {};
  for (const [name, bind] of Object.entries(surfaces)) {
    const db = await openTemporaryDatabase(t, { crossTenantRefresh: false });
    await seed(db);
    const surface = bind(db);
    const refused = (tenantId, cursor, limit) => surface.page(tenantId, cursor, limit).then(() => "accepted", (error) => ({ status: error.status, message: String(error.message) }));
    const first = await surface.page("acme", undefined, 2);
    results[name] = {
      acme: await drain(surface, "acme", 2),
      whale: await drain(surface, "whale", 2),
      empty: await drain(surface, "nobody", undefined),
      firstConsistent: first.consistent,
      foreign: await refused("globex", first.cursor),
      malformed: await refused("acme", "nonsense"),
      badLimit: await refused("acme", undefined, 5000),
    };
  }
  const http = results.http;
  assert.ok(http.acme.pages > 1 && http.acme.entries.length >= 6, "small pages take several calls and carry the records");
  assert.equal(http.firstConsistent, false);
  assert.deepEqual(http.whale.parts, ["a", "b"]);
  assert.ok(http.whale.entries.every((entry) => entry.part === "a" || entry.part === "b"), "a divided Tenant's entries name their parts");
  assert.deepEqual(http.empty.entries, []);
  assert.equal(http.foreign.status, 400);
  assert.match(http.foreign.message, /belongs to another Tenant/);
  assert.equal(http.malformed.status, 400);
  assert.equal(http.badLimit.status, 400);
  assert.match(http.badLimit.message, /limit is 1 to 1024/);
  assert.deepEqual(results.sdk, http);
  assert.deepEqual(results.cli, http);
});

test("the CLI collects an export with --until-consistent and refuses what does not fit", async (t) => {
  const db = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  await seed(db);
  const cli = surfaces.cli(db);
  const all = await cli.page("acme", undefined, 2, ["--until-consistent"]);
  assert.equal(all.consistent, true);
  assert.equal(all.entries.length, (await drain(surfaces.http(db), "acme", 2)).entries.length);
  await assert.rejects(() => runProjectsCommand(["export-stream", "p1", "--url", BASE]), /requires --tenant/);
  await assert.rejects(() => runProjectsCommand(["tenants", "p1", "--until-consistent", "--url", BASE]), /--until-consistent is only supported by projects export-stream/);
  await assert.rejects(() => runProjectsCommand(["export-stream", "p1", "--tenant", "acme", "--until-consistent", "--after", "x", "--url", BASE]), /takes no --after/);
});
