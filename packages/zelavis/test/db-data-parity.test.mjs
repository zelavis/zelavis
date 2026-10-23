// The database operations that were HTTP-only, now in all three forms: each one through the HTTP route, the SDK and the
// CLI, against a database of its own seeded the same way, has to answer the same, refusals included. A fake Platform hands
// the SDK's and the CLI's requests to the database service's own route handlers, so nothing in between answers for them.
import assert from "node:assert/strict";
import test from "node:test";
import { defineDatabaseService } from "../dist/db/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runDataCommand } from "../dist/cli/data.js";
import { runProjectsCommand } from "../dist/cli/projects.js";
import { openTemporaryDatabase } from "./_database.mjs";

/** An App client: data authority, confined to its own Tenant. */
const app = { id: "app", type: "service", permissions: ["database.read", "database.write"], metadata: { tenantId: "acme" } };
/** An operator: inspect authority, as the Project proxy carries it. */
const operator = { id: "operator", type: "user", permissions: ["database.inspect", "database.read"], metadata: { tenantId: "acme" } };
const BASE = "http://zv.test/zelavis";
const DATA = "/zelavis/api/v1/runtime/projects/p1/data";
const PROXY = "/zelavis/api/v1/runtime/projects/p1/proxy/zelavis/api/v1/database";

/** The database service's own handler for a request, found by method and path template. */
const dispatch = async (api, principal, method, path, { query = new URLSearchParams(), body } = {}) => {
  for (const route of defineDatabaseService(api).api.v1) {
    if (route.method !== method) continue;
    const names = [];
    const pattern = new RegExp(`^${route.path.replace(/:([A-Za-z]+)/g, (_, name) => { names.push(name); return "([^/]+)"; })}$`);
    const match = pattern.exec(path);
    if (!match) continue;
    const params = Object.fromEntries(names.map((name, at) => [name, decodeURIComponent(match[at + 1])]));
    const response = await route.handler({ service: api, params, query, body, principal, headers: {}, request: undefined });
    return { status: response.status ?? 200, body: response.body };
  }
  assert.fail(`no route ${method} ${path}`);
};

const platform = (api) => async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  const through = url.pathname.startsWith(DATA) ? [app, url.pathname.slice(DATA.length)] : url.pathname.startsWith(PROXY) ? [operator, url.pathname.slice(PROXY.length)] : assert.fail(`unexpected request ${url.pathname}`);
  const answer = await dispatch(api, through[0], method, through[1], { query: url.searchParams, body });
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
};

const seed = async (api) => {
  const acme = api.forTenant("acme");
  await acme.documents.createCollection({ name: "authors" });
  await acme.documents.createCollection({ name: "posts" });
  await acme.documents.insert({ collection: "authors", id: "ann", data: { name: "Ann" } });
  for (const [id, score] of [["a", 1], ["b", 2], ["c", 3]]) await acme.documents.insert({ collection: "posts", id, data: { title: `post ${id}`, score, authorId: "ann" } });
};

/** A response with what differs run to run taken out: times, and ids the database generates. */
const steady = (value) => JSON.parse(JSON.stringify(value, (key, entry) => (/(^|[a-z])(At|Time|timestamp|createdAt|updatedAt)$/.test(key) || key === "at" ? undefined : entry)));

/** One scenario step: the same call in each form. `cli` is the argument list, `sdk` the client call, `http` the route. */
const steps = [
  { name: "exists", http: ["GET", "/documents/collections/posts/exists"], sdk: (d) => d.collections.exists("posts").then((exists) => ({ exists })), cli: ["exists", "posts"] },
  { name: "does not exist", http: ["GET", "/documents/collections/nope/exists"], sdk: (d) => d.collections.exists("nope").then((exists) => ({ exists })), cli: ["exists", "nope"] },
  { name: "health", http: ["GET", "/health"], sdk: (d) => d.health(), cli: ["health"] },
  { name: "rewrite", http: ["POST", "/maintenance/documents/rewrite", {}], sdk: (d) => d.collections.rewrite(), cli: ["rewrite"] },
  { name: "rewrite one", http: ["POST", "/maintenance/documents/rewrite", { collection: "posts" }], sdk: (d) => d.collections.rewrite("posts"), cli: ["rewrite", "posts"] },
  { name: "index created", http: ["POST", "/documents/posts/indexes", { name: "by_score", fields: [{ path: "score" }] }], sdk: (d) => d.indexes.create("posts", { name: "by_score", fields: [{ path: "score" }] }), cli: ["create-index", "posts", "--data", JSON.stringify({ name: "by_score", fields: [{ path: "score" }] })] },
  { name: "index dropped", http: ["DELETE", "/documents/posts/indexes/by_score"], sdk: (d) => d.indexes.drop("posts", "by_score"), cli: ["drop-index", "posts", "by_score"] },
  { name: "index dropped again", http: ["DELETE", "/documents/posts/indexes/by_score"], sdk: (d) => d.indexes.drop("posts", "by_score"), cli: ["drop-index", "posts", "by_score"] },
  { name: "check added", http: ["POST", "/documents/posts/checks", { name: "positive", where: [{ path: "score", op: "gte", value: 0 }] }], sdk: (d) => d.checks.add("posts", { name: "positive", where: [{ path: "score", op: "gte", value: 0 }] }), cli: ["add-check", "posts", "--data", JSON.stringify({ name: "positive", where: [{ path: "score", op: "gte", value: 0 }] })] },
  { name: "check dropped", http: ["DELETE", "/documents/posts/checks/positive"], sdk: (d) => d.checks.drop("posts", "positive"), cli: ["drop-check", "posts", "positive"] },
  { name: "reference added", http: ["POST", "/documents/posts/references", { name: "author", path: "authorId", collection: "authors" }], sdk: (d) => d.references.add("posts", { name: "author", path: "authorId", collection: "authors" }), cli: ["add-reference", "posts", "--data", JSON.stringify({ name: "author", path: "authorId", collection: "authors" })] },
  { name: "reference dropped", http: ["DELETE", "/documents/posts/references/author"], sdk: (d) => d.references.drop("posts", "author"), cli: ["drop-reference", "posts", "author"] },
  { name: "summarized", http: ["POST", "/documents/posts/summarize", { measure: "score", op: "sum" }], sdk: (d) => d.documents.summarize("posts", { measure: "score", op: "sum" }), cli: ["summarize", "posts", "--data", JSON.stringify({ measure: "score", op: "sum" })] },
  { name: "summarized by group", http: ["POST", "/documents/posts/summarize-by", { measure: "score", op: "sum", groupBy: "authorId" }], sdk: (d) => d.documents.summarizeBy("posts", { measure: "score", op: "sum", groupBy: "authorId" }), cli: ["summarize-by", "posts", "--data", JSON.stringify({ measure: "score", op: "sum", groupBy: "authorId" })] },
  { name: "traversed", http: ["POST", "/documents/posts/traverse", { id: "a", edge: "author" }], sdk: (d) => d.documents.traverse("posts", { id: "a", edge: "author" }), cli: ["traverse", "posts", "--data", JSON.stringify({ id: "a", edge: "author" })] },
  { name: "related", http: ["POST", "/documents/posts/related", { documents: [] }], sdk: (d) => d.documents.related("posts", { documents: [] }), cli: ["related", "posts", "--data", JSON.stringify({ documents: [] })] },
  { name: "analyzer set", http: ["POST", "/documents/posts/analyzer", { analyzer: { fields: ["title"] } }], sdk: (d) => d.collections.setAnalyzer("posts", { fields: ["title"] }), cli: ["set-analyzer", "posts", "--data", JSON.stringify({ fields: ["title"] })] },
  { name: "spatial set", http: ["POST", "/documents/posts/geometry", { spatial: { field: "where" } }], sdk: (d) => d.collections.setSpatial("posts", { field: "where" }), cli: ["set-spatial", "posts", "--data", JSON.stringify({ field: "where" })] },
  { name: "embedding set", http: ["POST", "/documents/posts/embedding", { embedding: { field: "vector", dimension: 3, metric: "cosine" } }], sdk: (d) => d.collections.setEmbedding("posts", { field: "vector", dimension: 3, metric: "cosine" }), cli: ["set-embedding", "posts", "--data", JSON.stringify({ field: "vector", dimension: 3, metric: "cosine" })] },
  { name: "schemas listed", http: ["GET", "/schemas/collections"], sdk: (d) => d.schemas.list(), cli: ["schemas"] },
  { name: "schema saved", http: ["POST", "/schemas/posts", { version: 1, fields: [{ name: "title", field: { _tag: "TextField", label: "Title", required: true } }] }], sdk: (d) => d.schemas.save("posts", { version: 1, fields: [{ name: "title", field: { _tag: "TextField", label: "Title", required: true } }] }), cli: ["save-schema", "posts", "--data", JSON.stringify({ version: 1, fields: [{ name: "title", field: { _tag: "TextField", label: "Title", required: true } }] })] },
  { name: "schema activated", http: ["POST", "/schemas/posts/activate", { version: 1 }], sdk: (d) => d.schemas.activate("posts", 1), cli: ["activate-schema", "posts", "1"] },
  { name: "schema versions", http: ["GET", "/schemas/posts"], sdk: (d) => d.schemas.versions("posts"), cli: ["schema-versions", "posts"] },
  { name: "valid data", http: ["POST", "/schemas/posts/validate", { data: { title: "x" } }], sdk: (d) => d.schemas.validate("posts", { title: "x" }), cli: ["validate-schema", "posts", "--data", JSON.stringify({ title: "x" })] },
  { name: "invalid data", http: ["POST", "/schemas/posts/validate", { data: {} }], sdk: (d) => d.schemas.validate("posts", {}), cli: ["validate-schema", "posts", "--data", "{}"] },
  { name: "series listed", http: ["GET", "/timeseries/series"], sdk: (d) => d.timeseries.list(), cli: ["series"] },
  { name: "series range", http: ["POST", "/timeseries/latency/range", {}], sdk: (d) => d.timeseries.range("latency"), cli: ["series-range", "latency"] },
  { name: "series aggregate", http: ["POST", "/timeseries/latency/aggregate", { op: "avg" }], sdk: (d) => d.timeseries.aggregate("latency", { op: "avg" }), cli: ["series-aggregate", "latency", "--data", JSON.stringify({ op: "avg" })] },
  { name: "series windows", http: ["POST", "/timeseries/latency/windows", { interval: 60000 }], sdk: (d) => d.timeseries.windows("latency", { interval: 60000 }), cli: ["series-windows", "latency", "--data", JSON.stringify({ interval: 60000 })] },
  { name: "series moving", http: ["POST", "/timeseries/latency/moving", { window: 3 }], sdk: (d) => d.timeseries.moving("latency", { window: 3 }), cli: ["series-moving", "latency", "--data", JSON.stringify({ window: 3 })] },
  { name: "series histogram", http: ["POST", "/timeseries/latency/histogram", {}], sdk: (d) => d.timeseries.histogram("latency"), cli: ["series-histogram", "latency"] },
  { name: "series interpolate", http: ["POST", "/timeseries/latency/interpolate", { step: 1000 }], sdk: (d) => d.timeseries.interpolate("latency", { step: 1000 }), cli: ["series-interpolate", "latency", "--data", JSON.stringify({ step: 1000 })] },
  { name: "series ingest", http: ["POST", "/timeseries/latency/ingest", {}], sdk: (d) => d.timeseries.ingest("latency"), cli: ["series-ingest", "latency"] },
];

const runCli = async (api, command, args) => {
  const originalFetch = globalThis.fetch, originalLog = console.log, lines = [];
  globalThis.fetch = platform(api);
  console.log = (line) => lines.push(String(line));
  try { await command([...args, "--url", BASE, "--json"]); } finally { globalThis.fetch = originalFetch; console.log = originalLog; }
  return JSON.parse(lines.join("\n"));
};

/** What a step came to: its answer, or that it was refused and what the database said. */
const outcome = async (run) => {
  try { return { answer: steady(await run()) }; }
  catch (error) { return { refused: String(error?.body?.error ?? error?.message ?? error) }; }
};

test("the database operations that were HTTP-only come out the same through HTTP, the SDK and the CLI, refusals included", async (t) => {
  const results = { http: [], sdk: [], cli: [] };
  for (const surface of Object.keys(results)) {
    const api = (await openTemporaryDatabase(t)).api;
    await seed(api);
    const client = createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch: platform(api) }).data("p1");
    for (const step of steps) {
      const run = surface === "http"
        ? async () => { const answer = await dispatch(api, app, step.http[0], step.http[1], { body: step.http[2] }); if (answer.status >= 400) throw Object.assign(new Error(answer.body.error), { body: answer.body }); return answer.body; }
        : surface === "sdk" ? () => step.sdk(client) : () => runCli(api, runDataCommand, [...step.cli, "--project", "p1"]);
      results[surface].push({ step: step.name, ...(await outcome(run)) });
    }
  }
  // A refusal is the same refusal; the CLI and the SDK may say it with a prefix, never a different sentence.
  const agree = (left, right) => left.answer !== undefined ? assert.deepEqual(right.answer, left.answer, `${left.step}`) : assert.ok(right.refused?.includes(left.refused), `${left.step}: ${right.refused} should carry ${left.refused}`);
  for (const [at, http] of results.http.entries()) { agree(http, results.sdk[at]); agree(http, results.cli[at]); }
  // The scenario is not all refusals: most of what it does is accepted, which is what makes agreeing worth something.
  const accepted = results.http.filter((entry) => entry.answer !== undefined).map((entry) => entry.step);
  for (const name of ["exists", "health", "rewrite", "index created", "index dropped", "check added", "reference added", "schema saved", "schema activated", "valid data", "series listed"]) {
    assert.ok(accepted.includes(name), `${name} should be accepted, not refused`);
  }
});

test("the operator's system views come out the same through HTTP, the SDK and the CLI", async (t) => {
  const results = {};
  for (const surface of ["http", "sdk", "cli"]) {
    const api = (await openTemporaryDatabase(t)).api;
    await seed(api);
    const client = createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch: platform(api) });
    const http = async (path, query = new URLSearchParams()) => steady((await dispatch(api, operator, "GET", path, { query })).body);
    const views = surface === "http" ? await http("/maintenance/system/views") : surface === "sdk" ? steady(await client.projects.systemViews("p1")) : steady(await runCli(api, runProjectsCommand, ["system-views", "p1"]));
    const rows = surface === "http" ? await http("/maintenance/system/views/collections", new URLSearchParams({ limit: "10" }))
      : surface === "sdk" ? steady(await client.projects.systemView("p1", "collections", { limit: 10 }))
        : steady(await runCli(api, runProjectsCommand, ["system-views", "p1", "--view", "collections", "--limit", "10"]));
    results[surface] = { views, rows };
  }
  assert.ok(results.http.views.views.length > 0 && results.http.rows.rows.length === 2, JSON.stringify(results.http));
  assert.deepEqual(results.sdk, results.http);
  assert.deepEqual(results.cli, results.http);
});
