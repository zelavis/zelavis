// Branching a Tenant through the HTTP route, the SDK and the CLI: each reaches
// the same route the way it does on a Platform, through the Project proxy, and
// each must branch, refuse and report the same way.
import assert from "node:assert/strict";
import test from "node:test";
import { defineDatabaseService } from "../dist/db/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runProjectsCommand } from "../dist/cli/projects.js";
import { openTemporaryDatabase } from "./_database.mjs";

const BASE = "http://zv.test/zelavis";
const PROXY = "/zelavis/api/v1/runtime/projects/p1/proxy/zelavis/api/v1/database";

const route = (api) => defineDatabaseService(api).api.v1.find((entry) => entry.id === "database.tenants.branch");
const call = async (api, tenantId, body) => {
  const response = await route(api).handler({ service: api, params: { tenantId }, query: new URLSearchParams(), body, principal: undefined, headers: {}, request: undefined });
  return { status: response.status ?? 200, body: response.body };
};
const platform = (api) => async (input, init) => {
  const url = new URL(String(input));
  const match = /\/tenants\/([^/]+)\/branch$/.exec(url.pathname);
  assert.ok(url.pathname.startsWith(PROXY) && match && init?.method === "POST", `unexpected request ${init?.method} ${url.pathname}`);
  const answer = await call(api, decodeURIComponent(match[1]), JSON.parse(init.body));
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
};

const seed = async (api) => {
  for (const tenant of ["acme", "globex", "initech", "zelavis-app"]) {
    const db = api.forTenant(tenant);
    await db.documents.createCollection({ name: "posts" });
    for (const id of ["a", "b"]) await db.documents.insert({ collection: "posts", id, data: { title: `${tenant}-${id}` } });
    await db.outbox.emit({ topic: "mail", payload: { tenant }, id: `${tenant}-owed` });
  }
};

const surfaces = {
  http: (api) => async (tenantId, into, outbox) => {
    const answer = await call(api, tenantId, { ...(into === undefined ? {} : { into }), ...(outbox === undefined ? {} : { outbox }) });
    if (answer.status !== 200) throw Object.assign(new Error(answer.body.error), { status: answer.status });
    return answer.body;
  },
  sdk: (api) => {
    const client = createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch: platform(api) });
    return (tenantId, into, outbox) => client.projects.branchTenant("p1", { tenantId, into, ...(outbox === undefined ? {} : { outbox }) });
  },
  cli: (api) => async (tenantId, into, outbox) => {
    const originalFetch = globalThis.fetch, originalLog = console.log, lines = [];
    globalThis.fetch = platform(api);
    console.log = (line) => lines.push(String(line));
    try { await runProjectsCommand(["branch-tenant", "p1", "--tenant", tenantId, ...(into === undefined ? [] : ["--to", into]), ...(outbox === undefined ? [] : ["--outbox", outbox]), "--url", BASE, "--json"]); }
    finally { globalThis.fetch = originalFetch; console.log = originalLog; }
    return JSON.parse(lines.join("\n"));
  },
};

test("branching a Tenant comes out the same through HTTP, the SDK and the CLI, refusals included", async (t) => {
  const results = {};
  for (const [name, bind] of Object.entries(surfaces)) {
    const api = (await openTemporaryDatabase(t, { crossTenantRefresh: false })).api;
    await seed(api);
    const branch = bind(api);
    const outcome = (tenantId, into, outbox) => branch(tenantId, into, outbox).then(
      ({ tenant, into: made, records, events, cursor }) => ({ tenant, into: made, records, events, cursor: typeof cursor }),
      (error) => ({ refused: String(error.message) }),
    );
    results[name] = {
      made: await outcome("acme", "acme-copy"),
      occupied: await outcome("acme", "globex"),
      appOwn: await outcome("zelavis-app", "app-copy"),
      intoApp: await outcome("acme", "zelavis-app"),
      empty: await outcome("nobody", "nobody-copy"),
      copied: await outcome("initech", "initech-copy", "copy"),
      documents: (await api.forTenant("acme-copy").documents.findMany({ collection: "posts" })).map((doc) => `${doc.id}:${doc.data.title}`).sort(),
      messages: {
        left: (await api.forTenant("acme-copy").outbox.read()).messages.map((message) => message.id),
        copied: (await api.forTenant("initech-copy").outbox.read()).messages.map((message) => message.id),
      },
    };
  }
  const http = results.http;
  assert.equal(http.made.tenant, "acme");
  assert.equal(http.made.into, "acme-copy");
  assert.ok(http.made.records > 0 && http.made.events > 0);
  assert.equal(http.made.cursor, "string");
  assert.deepEqual(http.documents, ["a:acme-a", "b:acme-b"]);
  assert.equal(http.copied.into, "initech-copy");
  assert.deepEqual(http.messages, { left: [], copied: ["initech-owed"] }, "the outbox stays with the source unless copied");
  assert.match(http.occupied.refused, /cannot be branched into "globex": "globex" already holds data/);
  assert.match(http.appOwn.refused, /App's own Tenant/);
  assert.match(http.intoApp.refused, /App's own Tenant/);
  assert.match(http.empty.refused, /"nobody" holds nothing/);
  assert.deepEqual(results.sdk, http);
  assert.deepEqual(results.cli, http);
});

test("each surface says what a branch needs before it asks", async (t) => {
  const api = (await openTemporaryDatabase(t, { crossTenantRefresh: false })).api;
  const answer = await call(api, "acme", {});
  assert.equal(answer.status, 400);
  assert.match(answer.body.error, /needs \{ "into"/);
  await assert.rejects(() => runProjectsCommand(["branch-tenant", "p1", "--tenant", "acme", "--url", BASE]), /requires --tenant <id> and --to <new id>/);
  await assert.rejects(() => runProjectsCommand(["tenants", "p1", "--to", "x", "--url", BASE]), /--to is only supported by projects branch-tenant/);
  await assert.rejects(() => runProjectsCommand(["branch-tenant", "p1", "--tenant", "acme", "--to", "x", "--outbox", "keep", "--url", BASE]), /--outbox is leave or copy/);
  const badOutbox = await call(api, "acme", { into: "x", outbox: "keep" });
  assert.equal(badOutbox.status, 400);
  assert.match(badOutbox.body.error, /"outbox" is "leave" or "copy"/);
  assert.deepEqual(route(api).access.permissions, ["database.restore"]);
});
