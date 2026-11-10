// Format-migration harness (fix_updates.md WP-2).
//
// Proves the "export with the writer that wrote it, recreate with the current engine" step on data made by a
// released engine. It never opens the data it is given: every run works on throwaway copies.
//
//   node harness.mjs --old-host <dir with node_modules/zelavis@released> [--repo <checkout>] [--seed 1] [--scale 1]
//                    [--from <shards dir of real old data>] [--source-format <layout the released engine writes>]
//
// The source layout is the released engine's own `CURRENT_FORMAT` unless `--source-format` names it (alpha.42 and earlier
// exported none and wrote layout 2).
//
// Without --from it generates seeded data with the released engine: collections with indexes, text, measures and edges,
// updates and deletes, and the history a replay has to carry without judging it again: an index built over existing
// documents (the earlier engine rewrites each), states a constraint added later refuses, deletes whose cascade and
// cleared references are events of their own, a deleted id inserted again, and a collection dropped with its documents.
// With --from it runs the same checks over real data.
//
// What must be identical on the old data and on the migrated data, per Tenant: every answer of the query battery
// (documents with their versions and times, collections, indexes, search, measures, edges), the schemas, the document
// change feed (type, collection, id, revision, timestamp and data of every event, in order) and every point of a time
// series rebuilt from the feed (timestamp, value, tags, fields). Exit code 1 on any difference.
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, symlinkSync, cpSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    "old-host": { type: "string" },
    repo: { type: "string", default: resolve(here, "../../..") },
    seed: { type: "string", default: "1" },
    scale: { type: "string", default: "1" },
    from: { type: "string" },
    "source-format": { type: "string" },
    keep: { type: "boolean", default: false },
  },
});
if (!args["old-host"]) throw new Error("--old-host is required: a directory with the released zelavis installed in node_modules.");

const load = async (root, pkg, file) => import(pathToFileURL(join(root, "node_modules", pkg, file)).href);
const oldDb = await load(args["old-host"], "zelavis", "dist/db/node-host.js");
const oldEffect = await load(args["old-host"], "effect", "dist/index.js");
const oldFx = oldEffect.Effect;
const newDb = await import(pathToFileURL(join(args.repo, "packages/zelavis/dist/db/node-host.js")).href);
const newEffect = await load(args.repo, "effect", "dist/index.js");
const newFx = newEffect.Effect;
const runOld = (e) => oldFx.runPromise(e);
const runNew = (e) => newFx.runPromise(e);

const seed = Number(args.seed);
const scale = Number(args.scale);
const rng = ((a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; })(seed);
const pick = (xs) => xs[Math.floor(rng() * xs.length)];
const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa"];
const sentence = (n) => Array.from({ length: n }, () => pick(words)).join(" ");

const earlierVersion = JSON.parse((await import("node:fs")).readFileSync(join(args["old-host"], "node_modules/zelavis/package.json"), "utf8")).version;
const sourceFormat = args["source-format"] !== undefined ? Number(args["source-format"]) : (await load(args["old-host"], "zelavis", "dist/db/kv-store.js")).CURRENT_FORMAT;
if (!Number.isSafeInteger(sourceFormat)) throw new Error("The released engine exports no CURRENT_FORMAT: name its layout with --source-format.");
console.log(`earlier engine: zelavis ${earlierVersion}, layout ${sourceFormat}`);
const work = mkdtempSync(join(tmpdir(), "zv-format-migration-"));
const log = (...a) => console.log(...a);
const timings = {};
const timed = async (name, f) => { const t = performance.now(); const r = await f(); timings[name] = Math.round(performance.now() - t); return r; };

const proveLayout4 = sourceFormat === 4 && !args.from;
const oldWorkflow = proveLayout4 ? await load(args["old-host"], "effect", "dist/workflow/index.js") : undefined;
const newWorkflow = proveLayout4 ? await load(args.repo, "effect", "dist/workflow/index.js") : undefined;

const outboxWrite = {
  idempotencyKey: "migration-receipt",
  operations: [{ _tag: "Update", collection: "users", id: "u1", data: { migrationProof: true } }],
  emit: [
    { id: "migration-pending", topic: "migration-test", payload: { pending: true } },
    { id: "migration-acknowledged", topic: "migration-test", payload: { pending: false } },
  ],
};
const runWorkflow = async (database, { Effect, Layer, Schema }, { Activity, Workflow }) => {
  const workflow = Workflow.make("MigrationProof", {
    payload: { id: Schema.String }, success: Schema.String, idempotencyKey: ({ id }) => id,
  });
  let runs = 0;
  const worker = workflow.toLayer(() => Activity.make({
    name: "record", success: Schema.String,
    execute: Effect.sync(() => {
      runs += 1;
      return "recorded";
    }),
  }));
  const result = await Effect.runPromise(Effect.scoped(workflow.execute({ id: "migration-proof" }).pipe(
    Effect.provide(Layer.provideMerge(worker, database.workflowEngine)),
  )));
  assert.equal(result, "recorded");
  return runs;
};

// 1. Source data: real (--from) or generated by the released engine.
let sourceDir = join(work, "source");
if (args.from) {
  cpSync(args.from, sourceDir, { recursive: true });
} else {
  await timed("generate", async () => {
    const db = await oldDb.openNodeDatabase({ directory: sourceDir });
    for (const tenant of ["tenant-a", "tenant-b", "tenant-empty"]) {
      const d = db.database.forTenant(tenant).documents;
      if (tenant === "tenant-empty") continue;
      await runOld(d.createCollection({ name: "users", indexes: [{ name: "by_email", fields: [{ path: "email" }], unique: true }, { name: "by_age", fields: [{ path: "age" }] }] }));
      await runOld(d.createCollection({
        name: "posts",
        indexes: [{ name: "by_author", fields: [{ path: "author" }] }, { name: "by_views", fields: [{ path: "views", direction: "desc" }] }],
        analyzer: { fields: ["title", "body"], version: 1, fold: true },
        measures: [{ name: "views", path: "views" }],
        edges: [{ name: "wrote", path: "author", collection: "users" }],
      }));
      const users = [];
      for (let i = 0; i < 40 * scale; i++) {
        const id = `u${i}`;
        users.push(id);
        await runOld(d.insert({ collection: "users", id, data: { name: sentence(2), email: `${id}@${tenant}.test`, age: 18 + Math.floor(rng() * 60) } }));
      }
      const posts = [];
      for (let i = 0; i < 160 * scale; i++) {
        const id = `p${i}`;
        posts.push(id);
        await runOld(d.insert({ collection: "posts", id, data: { title: sentence(4), body: sentence(30), views: Math.floor(rng() * 1000), author: pick(users), tags: [pick(words), pick(words)] } }));
      }
      for (const id of posts.filter(() => rng() < 0.25)) await runOld(d.update({ collection: "posts", id, data: { views: Math.floor(rng() * 5000) } }));
      const deleted = posts.filter(() => rng() < 0.1);
      for (const id of deleted) await runOld(d.delete({ collection: "posts", id }));
      const living = posts.filter((id) => !deleted.includes(id));
      // An index built over existing documents: the earlier engine puts each document again, unchanged, as events of their own.
      await runOld(d.createIndex({ collection: "posts", name: "by_title", fields: [{ path: "title" }] }));
      // States a constraint added later refuses: two users share a handle and one is under age before the index and the check exist.
      await runOld(d.update({ collection: "users", id: "u1", data: { handle: "dup" } }));
      await runOld(d.update({ collection: "users", id: "u2", data: { handle: "dup", age: 10 } }));
      await runOld(d.update({ collection: "users", id: "u2", data: { handle: "second", age: 30 } }));
      await runOld(d.createIndex({ collection: "users", name: "by_handle", fields: [{ path: "handle" }], unique: true }));
      await runOld(d.addCheck({ collection: "users", name: "adult", where: [{ path: "age", op: "gte", value: 18 }] }));
      // Deletes whose effects are events of their own: a cascade and a cleared reference.
      await runOld(d.createCollection({ name: "comments", references: [{ name: "post", path: "post", collection: "posts", onDelete: "cascade" }] }));
      await runOld(d.createCollection({ name: "likes", references: [{ name: "post", path: "post", collection: "posts", onDelete: "set-null" }] }));
      for (let i = 0; i < 30 * scale; i++) {
        await runOld(d.insert({ collection: "comments", id: `c${i}`, data: { post: pick(living), text: sentence(5) } }));
        await runOld(d.insert({ collection: "likes", id: `l${i}`, data: { post: pick(living) } }));
      }
      for (const id of living.slice(0, 5 * scale)) await runOld(d.delete({ collection: "posts", id }));
      // A deleted id inserted again: a new record, whose revisions start over.
      if (deleted.length > 0) await runOld(d.insert({ collection: "posts", id: deleted[0], data: { title: sentence(4), body: sentence(30), views: 7, author: pick(users), tags: [] } }));
      // A collection dropped with its documents: its history is counted, not carried.
      await runOld(d.createCollection({ name: "drafts" }));
      for (let n = 0; n < 10; n++) await runOld(d.insert({ collection: "drafts", id: `d${n}`, data: { n } }));
      await runOld(d.dropCollection({ name: "drafts" }));
      // A time series is derived from the event log: its definition is code (registered at run time, never stored) and its points are
      // written without identity by ingesting events. The comparison below rebuilds it on both sides from the whole log.
      const series = db.database.forTenant(tenant).timeSeries;
      await runOld(series.define({ name: "post-views", map: (event) => event.type === "document.upserted" && event.collection === "posts" && typeof event.payload.data?.views === "number"
        ? { timestamp: event.timestamp, value: event.payload.data.views, tags: { collection: "posts" } } : null }));
      await runOld(series.ingest("post-views"));
      const schemas = db.database.forTenant(tenant).schemas;
      const fields = [{ name: "title", field: { _tag: "TextField", label: "Title", required: false } }];
      await runOld(schemas.save({ collection: "posts", version: 1, fields, activate: false }));
      await runOld(schemas.save({ collection: "posts", version: 2, fields, activate: false }));
      await runOld(schemas.activate("posts", 2));
      if (proveLayout4) {
        const api = db.database.forTenant(tenant);
        await runOld(api.documents.write(outboxWrite));
        await runOld(api.outbox.remove({ ids: ["migration-acknowledged"] }));
        await runOld(api.entities.send({ type: "migration-job", id: "pending", tag: "run", payload: { n: 1 } }));
        await runOld(api.aggregates.define({
          name: "migration-total", collection: "posts", operations: [{ name: "views", measure: "views", op: "sum" }],
        }));
        await runOld(api.aggregates.refresh("migration-total"));
      }
    }
    await runOld(db.database.global.documents.createCollection({ name: "settings" }));
    await runOld(db.database.global.documents.insert({ collection: "settings", id: "site", data: { theme: "dark" } }));
    if (proveLayout4) {
      assert.equal(await runWorkflow(db.database, oldEffect, oldWorkflow), 1);
      await runOld(db.database.crossTenantIndexes.define({ name: "migration-posts", collection: "posts", columns: ["views"] }));
      const [index] = await runOld(db.database.crossTenantIndexes.refresh("migration-posts"));
      assert.deepEqual(index.failures, []);
    }
    await db.close();
  });
}

// 2. Query battery: the same questions asked of the old engine and of the restored data.
const battery = (documents, run) => async (collections) => {
  const out = {};
  const ask = async (label, f) => { try { out[label] = await run(f()); } catch (cause) { out[label] = { error: cause?._tag ?? String(cause?.message ?? cause) }; } };
  // A migration keeps each document's version, times and expiry, so they are compared as well as its data.
  const shape = (docs) => docs.map((x) => ({ id: x.id, data: x.data, version: x.version, createdAt: x.createdAt, updatedAt: x.updatedAt, expiresAt: x.expiresAt ?? null }));
  for (const c of collections) {
    const name = c.name;
    await ask(`${name}:all`, () => oldOrNewMap(documents.findMany({ collection: name }), shape));
    await ask(`${name}:meta`, () => oldOrNewMap(documents.listCollections, (list) => list.filter((x) => x.name === name).map((x) => ({ name: x.name, surface: x.surface, createdAt: x.createdAt, indexes: x.indexes?.map?.((i) => i.name), checks: x.checks, references: x.references, analyzer: x.analyzer, measures: x.measures, edges: x.edges }))));
    if (name === "users") {
      await ask("users:age>=40", () => oldOrNewMap(documents.findMany({ collection: "users", where: [{ path: "age", op: "gte", value: 40 }], orderBy: [{ path: "age" }] }), shape));
      await ask("users:email=u3", () => oldOrNewMap(documents.findMany({ collection: "users", where: [{ path: "email", op: "eq", value: `u3@${"x"}` }] }), shape));
    }
    if (name === "posts") {
      await ask("posts:views-top", () => oldOrNewMap(documents.findMany({ collection: "posts", orderBy: [{ path: "views", direction: "desc" }], limit: 15 }), shape));
      await ask("posts:author", () => oldOrNewMap(documents.findMany({ collection: "posts", where: [{ path: "author", op: "eq", value: "u7" }] }), shape));
      await ask("posts:search", () => oldOrNewMap(documents.findMany({ collection: "posts", search: "alpha bravo" }), shape));
      await ask("posts:sum-views", () => documents.summarize({ collection: "posts", measure: "views", op: "sum" }));
      await ask("posts:linked", () => oldOrNewMap(documents.findMany({ collection: "users", linked: { collection: "posts", id: "p1", edge: "wrote" } }), shape));
    }
  }
  return out;
};
const oldOrNewMap = (effect, f) => effect.pipe ? { _map: f, effect } : effect;

// The two engines have separate Effect runtimes, so each side maps its own result.
const answer = async (runner, documents, collections) => {
  const run = async (x) => (x && x._map ? x._map(await runner(x.effect)) : runner(x));
  return battery(documents, run)(collections);
};

const open = async (dbModule, directory) => dbModule.openNodeDatabase({ directory });
const tenantsOf = async (db, runner) => runner(db.database.tenants);

const layout4Answers = async (database, run, migrated) => {
  const state = {};
  for (const tenant of ["tenant-a", "tenant-b"]) {
    const api = database.forTenant(tenant);
    const messages = [];
    let after;
    for (;;) {
      const page = await run(api.outbox.read({ after, topic: "migration-test" }));
      messages.push(...page.messages.map(({ cursor: _cursor, ...message }) => message));
      if (!page.more) break;
      after = page.cursor;
    }
    assert.deepEqual(messages.map(({ id }) => id), ["migration-pending"]);
    const { checkpoint, ...aggregate } = await run(api.aggregates.get("migration-total"));
    assert.ok(aggregate.results?.views);
    if (migrated) assert.equal(checkpoint, undefined);
    else assert.equal(typeof checkpoint, "string");
    const entities = await run(api.entities.list({ type: "migration-job" }));
    assert.equal(entities.entities[0]?.pending, 1);
    state[tenant] = { messages, aggregate, entities };
  }
  const matches = [];
  let after;
  for (;;) {
    const page = await run(database.crossTenantIndexes.query({ index: "migration-posts", limit: 1000, after }));
    matches.push(...page.matches);
    if (!page.next) break;
    after = page.next;
  }
  assert.ok(matches.length > 0);
  matches.sort((a, b) => a.tenant.localeCompare(b.tenant) || a.id.localeCompare(b.id));
  const workflows = await run(database.workflowExecutions());
  assert.deepEqual(workflows.map(({ workflow, complete, activities }) => [workflow, complete, activities]), [["MigrationProof", true, 1]]);
  return { tenants: state, matches, workflows };
};

// 3. Old side: answers, asked of a copy so the source is never opened in place.
const oldCopy = join(work, "old-copy");
cpSync(sourceDir, oldCopy, { recursive: true });
const oldAnswers = {};
const oldSchemas = {};
let tenants, oldGlobal, oldLayout4Answers;
await timed("old-answers", async () => {
  const old = await open(oldDb, oldCopy);
  tenants = await tenantsOf(old, runOld);
  for (const t of tenants) {
    const documents = old.database.forTenant(t).documents;
    const collections = await runOld(documents.listCollections);
    oldAnswers[t] = await answer(runOld, documents, collections);
    oldSchemas[t] = await runOld(old.database.forTenant(t).schemas.listCollections);
  }
  if (!args.from) {
    oldGlobal = await runOld(old.database.global.documents.findById({ collection: "settings", id: "site" }));
    assert.equal(oldGlobal?.data.theme, "dark");
  }
  if (proveLayout4) oldLayout4Answers = await layout4Answers(old.database, runOld, false);
  await old.close();
});

// 4. The shipped migration, then the same questions of what it produced.
const { migrateDataLayout } = await import(pathToFileURL(join(args.repo, "packages/zelavis/dist/adapters/_node-data-migration.js")).href);
const earlierPlatform = join(work, "earlier-platform");
mkdirSync(earlierPlatform);
symlinkSync(join(args["old-host"], "node_modules/zelavis/dist"), join(earlierPlatform, "dist"));
symlinkSync(join(args["old-host"], "node_modules"), join(earlierPlatform, "node_modules"));
let report;
await timed("migrate", async () => {
  report = await runNew(migrateDataLayout({ sourceShards: sourceDir, sourceFormat, workDirectory: join(work, "migration"), oldNode: process.execPath,
    oldPlatform: earlierPlatform, exportWorker: join(args.repo, "packages/zelavis/dist/adapters/_data-export-worker.js") }));
});
log("migration report:", JSON.stringify({ ...report, shardsDirectory: undefined }));
// Without --from the generated history is known: every Tenant's log is whole, and the dropped collection's events
// (10 puts and 10 retractions in each of the 2 Tenants) are counted, not carried.
let differences = 0;
if (!args.from && !(report.tenantsWithoutHistory === 0 && report.eventsOfDroppedCollections === 40)) {
  differences++;
  log(`DIFF report: expected tenantsWithoutHistory 0 and eventsOfDroppedCollections 40, got ${report.tenantsWithoutHistory} and ${report.eventsOfDroppedCollections}`);
}
const newAnswers = {};
await timed("new-answers", async () => {
  const fresh = await open(newDb, report.shardsDirectory);
  for (const t of tenants) {
    const documents = fresh.database.forTenant(t).documents;
    const collections = await runNew(documents.listCollections);
    newAnswers[t] = await answer(runNew, documents, collections);
    const schemas = await runNew(fresh.database.forTenant(t).schemas.listCollections);
    newAnswers[t]["__schemas"] = schemas.map((x) => [x.collection, x.versions ?? x.version, x.activeVersion ?? x.active]);
    oldAnswers[t]["__schemas"] = oldSchemas[t].map((x) => [x.collection, x.versions ?? x.version, x.activeVersion ?? x.active]);
  }
  const newTenants = await runNew(fresh.database.tenants);
  if (JSON.stringify(newTenants) !== JSON.stringify(tenants)) {
    differences += 1;
    log("TENANT LIST DIFFERS", tenants, newTenants);
  }
  if (!args.from) {
    const global = await runNew(fresh.database.global.documents.findById({ collection: "settings", id: "site" }));
    assert.deepEqual(global, oldGlobal, "App-wide documents are carried with their metadata");
  }
  if (proveLayout4) {
    assert.deepEqual(await layout4Answers(fresh.database, runNew, true), oldLayout4Answers);
    assert.equal(await runWorkflow(fresh.database, newEffect, newWorkflow), 0, "the completed activity must not execute again");
    for (const tenant of tenants) {
      const api = fresh.database.forTenant(tenant);
      const read = () => runNew(api.documents.findById({ collection: "users", id: "u1" }));
      const before = await read();
      await runNew(api.documents.write(outboxWrite));
      assert.deepEqual(await read(), before, "a replayed idempotency key must not write the document again");
    }
    log("layout 4 durable state, workflow replay, and rebuilt cross-Tenant index match");
  }
  await fresh.close();
});

// 5. The change history: the document change feed, and a time series rebuilt from it, on the old data and on the migrated data.
// The definition is run-time code the app registers again; both sides derive their points from their whole log with it.
const mapper = (event) => event.type === "document.upserted" && event.collection === "posts" && typeof event.payload.data?.views === "number"
  ? { timestamp: event.timestamp, value: event.payload.data.views, tags: { collection: "posts" } } : null;
const feedShape = (e) => ({ type: e.type, collection: e.collection, documentId: e.documentId, revision: e.revision, timestamp: e.timestamp, payload: e.payload });
// `range` orders by time only and many points share a millisecond, so the points are put in one total order before they are compared.
const pointShape = (points) => points.map((p) => ({ timestamp: p.timestamp, value: p.value, tags: p.tags ?? null, fields: p.fields ?? null }))
  .map((p) => [p, JSON.stringify(p)]).sort((a, b) => (a[0].timestamp < b[0].timestamp ? -1 : a[0].timestamp > b[0].timestamp ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([p]) => p);
const historyNote = {};
await timed("history", async () => {
  const old = await open(oldDb, oldCopy);
  const fresh = await open(newDb, report.shardsDirectory);
  for (const t of tenants) {
    // Layout 2 returns an array with a cursor on the last event; layout 4 returns a page and advances even across
    // empty pages. The migration only replays document events from collections that still exist.
    const live = new Set((await runOld(old.database.forTenant(t).documents.listCollections)).map((c) => c.name));
    const before = [];
    for (let last; ;) {
      const page = await runOld(old.database.forTenant(t).events.read({ ...(last ? { after: last } : {}), limit: 1000 }));
      const events = sourceFormat === 2 ? page : page.events;
      before.push(...events.filter((e) => e.documentId !== undefined && live.has(e.collection)).map(feedShape));
      if (sourceFormat === 2 ? events.length === 0 : !page.more) break;
      last = sourceFormat === 2 ? events.at(-1).cursor : page.cursor;
    }
    const after = [];
    let cursor;
    for (;;) {
      const page = await runNew(fresh.database.forTenant(t).events.read({ ...(cursor ? { after: cursor } : {}), limit: 1000 }));
      after.push(...page.events.filter((e) => e.documentId !== undefined).map(feedShape));
      cursor = page.cursor;
      if (!page.more) break;
    }
    oldAnswers[t].__feed = before;
    newAnswers[t].__feed = after;

    const oldSeries = old.database.forTenant(t).timeSeries;
    await runOld(oldSeries.define({ name: "post-views", map: mapper }));
    await runOld(oldSeries.rebuild("post-views"));
    const newSeries = fresh.database.forTenant(t).timeSeries;
    await runNew(newSeries.define({ name: "post-views", map: mapper }));
    await runNew(newSeries.rebuild("post-views"));
    oldAnswers[t].__series = pointShape(await runOld(oldSeries.get("post-views").range({ limit: 10_000_000 })));
    newAnswers[t].__series = pointShape(await runNew(newSeries.get("post-views").range({ limit: 10_000_000 })));
    historyNote[t] = { feedEventsOld: before.length, feedEventsNew: after.length, pointsOld: oldAnswers[t].__series.length, pointsNew: newAnswers[t].__series.length };
  }
  await old.close(); await fresh.close();
});
log("history (document feed events and post-views points, old and migrated):", JSON.stringify(historyNote));

// 6. Compare.
for (const t of tenants) {
  const keys = new Set([...Object.keys(oldAnswers[t]), ...Object.keys(newAnswers[t])]);
  for (const k of [...keys].sort()) {
    const a = JSON.stringify(oldAnswers[t][k]);
    const b = JSON.stringify(newAnswers[t][k]);
    if (a !== b) {
      differences++;
      log(`DIFF ${t} ${k}\n   old: ${String(a).slice(0, 200)}\n   new: ${String(b).slice(0, 200)}`);
      const x = oldAnswers[t][k], y = newAnswers[t][k];
      if (Array.isArray(x) && Array.isArray(y)) {
        const at = x.findIndex((element, index) => JSON.stringify(element) !== JSON.stringify(y[index]));
        const first = at < 0 ? x.length : at;
        log(`   lengths ${x.length} and ${y.length}; first difference at ${first}\n   old[${first}]: ${String(JSON.stringify(x[first])).slice(0, 400)}\n   new[${first}]: ${String(JSON.stringify(y[first])).slice(0, 400)}`);
      }
    }
  }
}
log("timings ms:", JSON.stringify(timings), "rss MB:", Math.round(process.memoryUsage().rss / 1048576));
log(differences === 0 ? "RESULT: identical answers on old and restored data" : `RESULT: ${differences} difference(s)`);
if (!args.keep) rmSync(work, { recursive: true, force: true }); else log("kept:", work);
process.exit(differences === 0 ? 0 : 1);
