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
const app = { id: "app", type: "service", permissions: ["database.read", "database.write", "database.define"], metadata: { tenantId: "acme" } };
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
    const required = route.access?.permissions ?? [];
    if (required.some((permission) => !principal.permissions.includes(permission))) {
      return { status: 403, body: { error: "Permission denied." } };
    }
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
  await acme.documents.createCollection({ name: "posts", measures: [{ name: "score", path: "score" }] });
  await acme.documents.insert({ collection: "authors", id: "ann", data: { name: "Ann" } });
  for (const [id, score] of [["a", 1], ["b", 2], ["c", 3]]) await acme.documents.insert({ collection: "posts", id, data: { title: `post ${id}`, score, authorId: "ann" } });
};

/** A response with what differs run to run taken out: times, and ids the database generates. */
const steady = (value) => JSON.parse(JSON.stringify(value, (key, entry) => (/(^|[a-z])(At|Time|timestamp|createdAt|updatedAt)$/.test(key) || key === "at" ? undefined : entry)));

/** One scenario step: the same call in each form. `cli` is the argument list, `sdk` the client call, `http` the route. */
const steps = [
  { name: "changes", http: ["POST", "/events/read", { collection: "posts", limit: 2 }], sdk: (d) => d.events.read({ collection: "posts", limit: 2 }), cli: ["changes", "--data", JSON.stringify({ collection: "posts", limit: 2 })] },
  { name: "changes bad limit", http: ["POST", "/events/read", { limit: 0 }], sdk: (d) => d.events.read({ limit: 0 }), cli: ["changes", "--data", JSON.stringify({ limit: 0 })] },
  { name: "changes foreign Tenant refused", http: ["POST", "/events/read", { tenantId: "other" }], sdk: (d) => d.events.read({ tenantId: "other" }), cli: ["changes", "--data", JSON.stringify({ tenantId: "other" })] },
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
  { name: "covariance", http: ["POST", "/documents/posts/covariance", {"measure":"score","with":"score"}], sdk: (d) => d.documents.covariance("posts", {"measure":"score","with":"score"}), cli: ["covariance", "posts", "--data", JSON.stringify({"measure":"score","with":"score"})] },
  { name: "measure histogram", http: ["POST", "/documents/posts/histogram", {"measure":"score","boundaries":[0,2,4]}], sdk: (d) => d.documents.histogram("posts", {"measure":"score","boundaries":[0,2,4]}), cli: ["histogram", "posts", "--data", JSON.stringify({"measure":"score","boundaries":[0,2,4]})] },
  { name: "invalid histogram", http: ["POST", "/documents/posts/histogram", {"measure":"score","bins":0}], sdk: (d) => d.documents.histogram("posts", {"measure":"score","bins":0}), cli: ["histogram", "posts", "--data", JSON.stringify({"measure":"score","bins":0})] },
  { name: "summarized", http: ["POST", "/documents/posts/summarize", { measure: "score", op: "sum" }], sdk: (d) => d.documents.summarize("posts", { measure: "score", op: "sum" }), cli: ["summarize", "posts", "--data", JSON.stringify({ measure: "score", op: "sum" })] },
  { name: "aggregate defined", http: ["POST", "/aggregates", {"name": "totals", "collection": "posts", "operations": [{"name": "sum", "op": "sum", "measure": "score"}, {"name": "spread", "op": "histogram", "measure": "score", "bins": 2}]}], sdk: (d) => d.aggregates.define({"name": "totals", "collection": "posts", "operations": [{"name": "sum", "op": "sum", "measure": "score"}, {"name": "spread", "op": "histogram", "measure": "score", "bins": 2}]}), cli: ["define-aggregate", "--data", JSON.stringify({"name": "totals", "collection": "posts", "operations": [{"name": "sum", "op": "sum", "measure": "score"}, {"name": "spread", "op": "histogram", "measure": "score", "bins": 2}]})] },
  { name: "aggregate defined again", http: ["POST", "/aggregates", {"name": "totals", "collection": "posts", "operations": [{"name": "sum", "op": "sum", "measure": "score"}, {"name": "spread", "op": "histogram", "measure": "score", "bins": 2}]}], sdk: (d) => d.aggregates.define({"name": "totals", "collection": "posts", "operations": [{"name": "sum", "op": "sum", "measure": "score"}, {"name": "spread", "op": "histogram", "measure": "score", "bins": 2}]}), cli: ["define-aggregate", "--data", JSON.stringify({"name": "totals", "collection": "posts", "operations": [{"name": "sum", "op": "sum", "measure": "score"}, {"name": "spread", "op": "histogram", "measure": "score", "bins": 2}]})] },
  { name: "aggregate refreshed", http: ["POST", "/aggregates/totals/refresh"], sdk: (d) => d.aggregates.refresh("totals"), cli: ["refresh-aggregate", "totals"] },
  { name: "aggregates listed", http: ["GET", "/aggregates"], sdk: (d) => d.aggregates.list(), cli: ["aggregates"] },
  { name: "aggregate read", http: ["GET", "/aggregates/totals"], sdk: (d) => d.aggregates.get("totals"), cli: ["get-aggregate", "totals"] },
  { name: "aggregate dropped", http: ["DELETE", "/aggregates/totals"], sdk: (d) => d.aggregates.drop("totals"), cli: ["drop-aggregate", "totals"] },
  { name: "aggregate missing", http: ["GET", "/aggregates/totals"], sdk: (d) => d.aggregates.get("totals"), cli: ["get-aggregate", "totals"] },
  { name: "import planned", http: ["POST", "/documents/posts/imports/plan", {"format": "csv", "text": "id,score,title\nq1,9,imported one\nq2,8,imported two", "types": {"score": "integer"}}], sdk: (d) => d.imports.plan("posts", {"format": "csv", "text": "id,score,title\nq1,9,imported one\nq2,8,imported two", "types": {"score": "integer"}}), cli: ["import-plan", "posts", "--data", JSON.stringify({"format": "csv", "text": "id,score,title\nq1,9,imported one\nq2,8,imported two", "types": {"score": "integer"}})] },
  { name: "import with problems", http: ["POST", "/documents/posts/imports/plan", {"format": "csv", "text": "id,score\nq1,nine", "types": {"score": "integer"}}], sdk: (d) => d.imports.plan("posts", {"format": "csv", "text": "id,score\nq1,nine", "types": {"score": "integer"}}), cli: ["import-plan", "posts", "--data", JSON.stringify({"format": "csv", "text": "id,score\nq1,nine", "types": {"score": "integer"}})] },
  { name: "import refused", http: ["POST", "/documents/posts/imports/run", {"format": "csv", "text": "id,score\nq1,nine", "types": {"score": "integer"}, "importId": "bad"}], sdk: (d) => d.imports.run("posts", {"format": "csv", "text": "id,score\nq1,nine", "types": {"score": "integer"}, "importId": "bad"}), cli: ["import-run", "posts", "--data", JSON.stringify({"format": "csv", "text": "id,score\nq1,nine", "types": {"score": "integer"}, "importId": "bad"})] },
  { name: "import run", http: ["POST", "/documents/posts/imports/run", {"format": "csv", "text": "id,score,title\nq1,9,imported one\nq2,8,imported two", "types": {"score": "integer"}, "importId": "parity"}], sdk: (d) => d.imports.run("posts", {"format": "csv", "text": "id,score,title\nq1,9,imported one\nq2,8,imported two", "types": {"score": "integer"}, "importId": "parity"}), cli: ["import-run", "posts", "--data", JSON.stringify({"format": "csv", "text": "id,score,title\nq1,9,imported one\nq2,8,imported two", "types": {"score": "integer"}, "importId": "parity"})] },
  { name: "import run again", http: ["POST", "/documents/posts/imports/run", {"format": "csv", "text": "id,score,title\nq1,9,imported one\nq2,8,imported two", "types": {"score": "integer"}, "importId": "parity"}], sdk: (d) => d.imports.run("posts", {"format": "csv", "text": "id,score,title\nq1,9,imported one\nq2,8,imported two", "types": {"score": "integer"}, "importId": "parity"}), cli: ["import-run", "posts", "--data", JSON.stringify({"format": "csv", "text": "id,score,title\nq1,9,imported one\nq2,8,imported two", "types": {"score": "integer"}, "importId": "parity"})] },
  { name: "import verified", http: ["POST", "/documents/posts/imports/verify", {"format": "csv", "text": "id,score,title\nq1,9,imported one\nq2,8,imported two", "types": {"score": "integer"}}], sdk: (d) => d.imports.verify("posts", {"format": "csv", "text": "id,score,title\nq1,9,imported one\nq2,8,imported two", "types": {"score": "integer"}}), cli: ["import-verify", "posts", "--data", JSON.stringify({"format": "csv", "text": "id,score,title\nq1,9,imported one\nq2,8,imported two", "types": {"score": "integer"}})] },
  { name: "summarized by group", http: ["POST", "/documents/posts/summarize-by", { measure: "score", op: "sum", groupBy: "authorId" }], sdk: (d) => d.documents.summarizeBy("posts", { measure: "score", op: "sum", groupBy: "authorId" }), cli: ["summarize-by", "posts", "--data", JSON.stringify({ measure: "score", op: "sum", groupBy: "authorId" })] },
  { name: "traversed", http: ["POST", "/documents/posts/traverse", { id: "a", edge: "author" }], sdk: (d) => d.documents.traverse("posts", { id: "a", edge: "author" }), cli: ["traverse", "posts", "--data", JSON.stringify({ id: "a", edge: "author" })] },
  { name: "related", http: ["POST", "/documents/posts/related", { documents: [] }], sdk: (d) => d.documents.related("posts", { documents: [] }), cli: ["related", "posts", "--data", JSON.stringify({ documents: [] })] },
  { name: "analyzer set", http: ["POST", "/documents/posts/analyzer", { analyzer: { fields: ["title"] } }], sdk: (d) => d.collections.setAnalyzer("posts", { fields: ["title"] }), cli: ["set-analyzer", "posts", "--data", JSON.stringify({ fields: ["title"] })] },
  { name: "spatial set", http: ["POST", "/documents/posts/geometry", { spatial: { field: "where" } }], sdk: (d) => d.collections.setSpatial("posts", { field: "where" }), cli: ["set-spatial", "posts", "--data", JSON.stringify({ field: "where" })] },
  { name: "embedding set", http: ["POST", "/documents/posts/embedding", { embedding: { field: "vector", dimension: 3, metric: "cosine" } }], sdk: (d) => d.collections.setEmbedding("posts", { field: "vector", dimension: 3, metric: "cosine" }), cli: ["set-embedding", "posts", "--data", JSON.stringify({ field: "vector", dimension: 3, metric: "cosine" })] },
  { name: "schemas listed", http: ["GET", "/schemas/collections"], sdk: (d) => d.schemas.list(), cli: ["schemas"] },
  { name: "schema saved", http: ["POST", "/schemas/posts", { version: 1, fields: [{ name: "title", field: { _tag: "TextField", label: "Title", required: true } }] }], sdk: (d) => d.schemas.save("posts", { version: 1, fields: [{ name: "title", field: { _tag: "TextField", label: "Title", required: true } }] }), cli: ["save-schema", "posts", "--data", JSON.stringify({ version: 1, fields: [{ name: "title", field: { _tag: "TextField", label: "Title", required: true } }] })] },
  { name: "schema activated", http: ["POST", "/schemas/posts/activate", { version: 1 }], sdk: (d) => d.schemas.activate("posts", 1), cli: ["activate-schema", "posts", "1"] },
  { name: "vector schema saved", http: ["POST", "/schemas/posts", { version: 2, fields: [{ name: "title", field: { _tag: "VectorField", label: "Title", required: false, model: "m", modelVersion: "1", dimension: 3, metric: "cosine" } }] }], sdk: (d) => d.schemas.save("posts", { version: 2, fields: [{ name: "title", field: { _tag: "VectorField", label: "Title", required: false, model: "m", modelVersion: "1", dimension: 3, metric: "cosine" } }] }), cli: ["save-schema", "posts", "--data", JSON.stringify({ version: 2, fields: [{ name: "title", field: { _tag: "VectorField", label: "Title", required: false, model: "m", modelVersion: "1", dimension: 3, metric: "cosine" } }] })] },
  { name: "vector schema refused", http: ["POST", "/schemas/posts/activate", { version: 2 }], sdk: (d) => d.schemas.activate("posts", 2), cli: ["activate-schema", "posts", "2"] },
  { name: "schema activations listed", http: ["GET", "/schemas/collections/activations"], sdk: (d) => d.schemas.activations(), cli: ["schema-activations"] },
  { name: "schema activations resumed", http: ["POST", "/schemas/collections/activations/resume", {}], sdk: (d) => d.schemas.resumeActivations(), cli: ["resume-schema-activations"] },
  { name: "schema export", http: ["POST", "/schemas/collections/export", {}], sdk: (d) => d.schemas.export({}), cli: ["export-schema", "--data", JSON.stringify({})] },
  { name: "schema types", http: ["POST", "/schemas/collections/types", {}], sdk: (d) => d.schemas.types({}), cli: ["schema-types", "--data", JSON.stringify({})] },
  { name: "schema import dry run", http: ["POST", "/schemas/collections/import", {"bundle":{"format":"zelavis.logical-schema","version":1,"schemas":[{"collection":"imported","version":1,"active":false,"fields":[]}]}}], sdk: (d) => d.schemas.import({"bundle":{"format":"zelavis.logical-schema","version":1,"schemas":[{"collection":"imported","version":1,"active":false,"fields":[]}]}}), cli: ["import-schema", "--data", JSON.stringify({"bundle":{"format":"zelavis.logical-schema","version":1,"schemas":[{"collection":"imported","version":1,"active":false,"fields":[]}]}})] },
  { name: "schema imported", http: ["POST", "/schemas/collections/import", {"bundle":{"format":"zelavis.logical-schema","version":1,"schemas":[{"collection":"imported","version":1,"active":true,"fields":[]}]},"dryRun":false,"activate":true}], sdk: (d) => d.schemas.import({"bundle":{"format":"zelavis.logical-schema","version":1,"schemas":[{"collection":"imported","version":1,"active":true,"fields":[]}]},"dryRun":false,"activate":true}), cli: ["import-schema", "--data", JSON.stringify({"bundle":{"format":"zelavis.logical-schema","version":1,"schemas":[{"collection":"imported","version":1,"active":true,"fields":[]}]},"dryRun":false,"activate":true})] },
  { name: "schema import invalid", http: ["POST", "/schemas/collections/import", {"bundle":{"format":"sql","version":1,"schemas":[]}}], sdk: (d) => d.schemas.import({"bundle":{"format":"sql","version":1,"schemas":[]}}), cli: ["import-schema", "--data", JSON.stringify({"bundle":{"format":"sql","version":1,"schemas":[]}})] },
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
  assert.match(results.http.find((entry) => entry.step === "vector schema refused").refused, /was not activated: document .* not a vector/);
  // The scenario is not all refusals: most of what it does is accepted, which is what makes agreeing worth something.
  const accepted = results.http.filter((entry) => entry.answer !== undefined).map((entry) => entry.step);
  for (const name of ["exists", "health", "rewrite", "index created", "index dropped", "check added", "reference added", "schema saved", "schema activated", "vector schema saved", "schema activations listed", "schema activations resumed", "valid data", "series listed", "covariance", "measure histogram", "summarized", "aggregate defined", "aggregate refreshed", "aggregate read", "aggregate dropped", "import planned", "import with problems", "import run", "import run again", "import verified"]) {
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

test("search statistics, hybrid ranking and operator scatter agree through HTTP, SDK and CLI", async (t) => {
  const inputs = [
    { name: "statistics", action: "search-statistics", body: { search: "car" } },
    { name: "synonym", action: "query", body: { search: "automobile" } },
    { name: "phrase", action: "query", body: { search: '"red car"' } },
    { name: "hybrid", action: "query", body: { search: "car", where: [{ path: "live", value: true }], similar: { field: "e", vector: [1, 0], approximate: false }, hybrid: { text: 2, vector: 1, depth: 10 } } },
    { name: "global scores", action: "query", body: { search: "car", statistics: { documents: 10, length: 30, frequencies: { car: 5 } } } },
    { name: "scatter", action: "scatter", body: { search: "car", tenants: ["acme", "other"], limit: 10 } },
    ...[null, [], { depth: 0 }, { vector: -1 }, { text: "1" }, { k: null }].map((hybrid, i) => ({ name: `bad hybrid ${i}`, action: "query", body: { search: "car", hybrid }, refused: true })),
    ...[null, [], {}, { documents: 1, length: 1, frequencies: { car: 2 } }, { documents: 1, length: -1, frequencies: {} }].map((statistics, i) => ({ name: `bad statistics ${i}`, action: "query", body: { search: "car", statistics }, refused: true })),
    { name: "statistics needs words", action: "search-statistics", body: {}, refused: true },
    { name: "statistics cannot choose another Tenant", action: "search-statistics", body: { search: "car", tenantId: "other" }, refused: true },
    { name: "scatter bad limit", action: "scatter", body: { tenants: ["acme"], limit: 0 }, refused: true },
    { name: "scatter bad Tenant list", action: "scatter", body: { tenants: "acme" }, refused: true },
  ];
  const results = {};
  for (const surface of ["http", "sdk", "cli"]) {
    const { api } = await openTemporaryDatabase(t);
    for (const tenant of ["acme", "other"]) {
      const docs = api.forTenant(tenant).documents;
      await docs.createCollection({ name: "items", analyzer: { fields: ["body"], version: 1, phrases: true, synonyms: [["car", "automobile"]] }, embedding: { field: "e", dimension: 2, metric: "cosine", version: 1 } });
      for (const [id, body, e, live] of [["a", "red car", [1, 0], true], ["b", "blue automobile", [0, 1], true], ["c", "red bicycle", [0.8, 0.2], false]]) {
        await docs.insert({ collection: "items", id, data: { body, e, live } });
      }
    }
    const data = createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch: platform(api) }).data("p1");
    results[surface] = [];
    for (const input of inputs) {
      const run = surface === "http" ? async () => {
        const response = await dispatch(api, input.action === "scatter" ? operator : app, "POST", `/documents/items/${input.action}`, { body: input.body });
        if (response.status >= 400) throw new Error(response.body.error);
        return response.body;
      } : surface === "sdk" ? async () => input.action === "query" ? { documents: await data.documents.query("items", input.body) }
        : input.action === "scatter" ? data.documents.scatter("items", input.body) : data.documents.searchStatistics("items", input.body)
        : () => runCli(api, runDataCommand, [input.action, "items", "--project", "p1", "--data", JSON.stringify(input.body)]);
      results[surface].push(await outcome(run));
    }
    assert.equal((await dispatch(api, app, "POST", "/documents/items/scatter", { body: {} })).status, 403);
  }
  for (const [i, input] of inputs.entries()) {
    const expected = results.http[i];
    if (input.refused) {
      assert.ok(expected.refused, input.name);
      for (const surface of ["sdk", "cli"]) assert.ok(results[surface][i].refused?.includes(expected.refused), `${input.name}: ${surface}`);
    } else {
      assert.ok(expected.answer, `${input.name}: ${JSON.stringify(expected)}`);
      for (const surface of ["sdk", "cli"]) assert.deepEqual(results[surface][i], expected, `${input.name}: ${surface}`);
    }
  }
  assert.equal(results.http[0].answer.documents, 2);
  assert.equal(results.http[1].answer.documents.length, 2);
  assert.deepEqual(results.http[2].answer.documents.map((doc) => doc.id), ["a"]);
  assert.ok(results.http[3].answer.documents.every((doc) => doc.data.live && doc.score > 0));
  assert.equal(results.http[5].answer.rows.length, 4);
});
