// A cross-Tenant index answers one question across every Tenant from one
// partition, kept current from each Tenant's log by a cursor per partition that
// is committed with the entries it produced. These tests hold it to the
// Tenants' own documents through writes, deletes, a crash between batches, a
// move, compaction, a Tenant removed and written again, divided Tenants and the
// background refresh.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeDatabase, partitionMapFor, shardFor } from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { openShardOverKv } from "../dist/db/kv-store.js";
import { crossTenantIndexesOver } from "../dist/db/cross-tenant-index.js";
import { StoreError } from "../dist/db/errors.js";

const map = partitionMapFor(["s0", "s1"]);
const allOn = (shard, version) => ({ version, virtualRanges: 256, placements: [{ from: 0, to: 256, shard }] });

/** A database over memory engines; `engines` lets a test reach one, `wrap` lets it stand in front of one. */
const withMemoryDatabase = (body, { wrap, refresh = false } = {}) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const engines = new Map(), stores = new Map();
    const db = yield* makeDatabase({
      partitionMap: map,
      crossTenantRefresh: refresh,
      openShard: (shard) => {
        const engine = memoryKvEngine();
        engines.set(shard, engine);
        return Effect.tap(openShardOverKv(shard, wrap === undefined ? engine : wrap(shard, engine)), store => Effect.sync(() => stores.set(shard, store)));
      },
    });
    return yield* body(db, engines, stores);
  })));

const cars = (db, tenant, rows) =>
  Effect.gen(function* () {
    const docs = db.forTenant(tenant).documents;
    if (!(yield* docs.collectionExists("cars"))) yield* docs.createCollection({ name: "cars" });
    for (const [id, data] of rows) yield* docs.insert({ collection: "cars", id, data });
  });

const define = (db, extra = {}) =>
  db.crossTenantIndexes.define({ name: "cars", collection: "cars", columns: ["color", "price"], ...extra });

/** Every entry as `tenant/id:color:price`, sorted: what the index says. */
const indexed = (db, where) =>
  Effect.gen(function* () {
    const out = [];
    let after;
    for (;;) {
      const page = yield* db.crossTenantIndexes.query({ index: "cars", limit: 1000, ...(where ? { where } : {}), ...(after ? { after } : {}) });
      out.push(...page.matches.map((m) => `${m.tenant}${m.part ? `#${m.part}` : ""}/${m.id}:${m.data.color}:${m.data.price}`));
      if (page.next === undefined) return out.sort();
      after = page.next;
    }
  });

/** The same, read from the Tenants themselves: what the index must agree with. */
const truth = (db, tenants) =>
  Effect.gen(function* () {
    const out = [];
    for (const tenant of tenants) {
      const docs = db.forTenant(tenant).documents;
      if (!(yield* docs.collectionExists("cars"))) continue;
      for (const d of yield* docs.findMany({ collection: "cars" })) out.push(`${tenant}/${d.id}:${d.data.color}:${d.data.price}`);
    }
    return out.sort();
  });

test("one query reads every Tenant's documents, filtered, ordered and paged, and says whose each is", () =>
  withMemoryDatabase((db) => Effect.gen(function* () {
    yield* cars(db, "acme", [["a1", { color: "red", price: 9000 }], ["a2", { color: "blue", price: 5000 }]]);
    yield* cars(db, "bravo", [["b1", { color: "red", price: 7000 }]]);
    yield* cars(db, "cosmo", [["c1", { color: "red", price: 12000 }], ["c2", { color: "red", price: 3000 }]]);
    yield* db.forTenant("delta").documents.createCollection({ name: "boats" });
    yield* db.forTenant("delta").documents.insert({ collection: "boats", id: "x", data: { color: "red", price: 1 } });

    const summary = yield* define(db);
    assert.deepEqual([summary.name, summary.collection, summary.columns, summary.partitions], ["cars", "cars", ["color", "price"], 0]);
    const [refreshed] = yield* db.crossTenantIndexes.refresh();
    assert.equal(refreshed.applied, 5);
    assert.deepEqual(refreshed.failures, []);

    const page = yield* db.crossTenantIndexes.query({
      index: "cars", where: [{ path: "color", value: "red" }, { path: "price", op: "lt", value: 10000 }],
      orderBy: [{ path: "price" }], limit: 2,
    });
    assert.deepEqual(page.matches.map((m) => [m.tenant, m.id, m.data.price]), [["cosmo", "c2", 3000], ["bravo", "b1", 7000]]);
    assert.ok(page.next !== undefined, "a third match follows");
    assert.ok(page.refreshedAt !== undefined);
    const rest = yield* db.crossTenantIndexes.query({
      index: "cars", where: [{ path: "color", value: "red" }, { path: "price", op: "lt", value: 10000 }],
      orderBy: [{ path: "price" }], limit: 2, after: page.next,
    });
    assert.deepEqual(rest.matches.map((m) => [m.tenant, m.id]), [["acme", "a1"]]);
    assert.equal(rest.next, undefined);

    const onlyAcme = yield* db.crossTenantIndexes.query({ index: "cars", tenants: ["acme"], orderBy: [{ path: "price" }] });
    assert.deepEqual(onlyAcme.matches.map((m) => m.id), ["a2", "a1"]);
    assert.equal(onlyAcme.matches[0].version, 1);

    const list = yield* db.crossTenantIndexes.list;
    assert.equal(list.length, 1);
    assert.equal(list[0].partitions, 4, "every Tenant partition is followed, those without the collection too");
  })));

test("updates and deletes reach the index at the next refresh, and a refresh with nothing new applies nothing", () =>
  withMemoryDatabase((db) => Effect.gen(function* () {
    yield* cars(db, "acme", [["a1", { color: "red", price: 1 }], ["a2", { color: "blue", price: 2 }]]);
    yield* define(db);
    yield* db.crossTenantIndexes.refresh("cars");
    const docs = db.forTenant("acme").documents;
    yield* docs.update({ collection: "cars", id: "a1", data: { color: "green" } });
    yield* docs.delete({ collection: "cars", id: "a2" });
    yield* cars(db, "bravo", [["b1", { color: "red", price: 3 }]]);
    yield* db.crossTenantIndexes.refresh("cars");
    assert.deepEqual(yield* indexed(db), yield* truth(db, ["acme", "bravo"]));
    assert.deepEqual(yield* indexed(db), ["acme/a1:green:1", "bravo/b1:red:3"]);

    const again = yield* db.crossTenantIndexes.refresh("cars");
    assert.deepEqual([again[0].applied, again[0].rederived, again[0].removed], [0, 0, 0]);
  })));

test("a query may only filter and order by declared columns, and text search uses the declared analyzer", () =>
  withMemoryDatabase((db) => Effect.gen(function* () {
    yield* cars(db, "acme", [["a1", { color: "red", price: 1, title: "Fast red roadster" }]]);
    yield* cars(db, "bravo", [["b1", { color: "blue", price: 2, title: "Slow blue van" }]]);
    yield* define(db, { analyzer: { fields: ["title"], version: 1, fold: true } });
    yield* db.crossTenantIndexes.refresh();

    const refused = yield* Effect.flip(db.crossTenantIndexes.query({ index: "cars", where: [{ path: "title", value: "x" }] }));
    assert.deepEqual([refused._tag, refused.collection, refused.path], ["UnindexedField", "cars", "title"]);
    const unordered = yield* Effect.flip(db.crossTenantIndexes.query({ index: "cars", orderBy: [{ path: "title" }] }));
    assert.equal(unordered._tag, "UnindexedField");

    const found = yield* db.crossTenantIndexes.query({ index: "cars", search: "roadster" });
    assert.deepEqual(found.matches.map((m) => `${m.tenant}/${m.id}`), ["acme/a1"]);

    const missing = yield* Effect.flip(db.crossTenantIndexes.query({ index: "nope" }));
    assert.equal(missing._tag, "CrossTenantIndexNotFound");
    const twice = yield* Effect.flip(define(db));
    assert.equal(twice._tag, "CrossTenantIndexExists");
    const bad = yield* Effect.flip(db.crossTenantIndexes.define({ name: "zv_x", collection: "cars" }));
    assert.equal(bad._tag, "InvalidCrossTenantIndex");
  })));

test("a refresh cut off between batches repeats nothing and skips nothing", async () => {
  let failOn = Infinity;
  let writes = 0;
  await withMemoryDatabase((db) => Effect.gen(function* () {
    const rows = Array.from({ length: 700 }, (_, i) => [`k${i}`, { color: i % 2 === 0 ? "red" : "blue", price: i }]);
    yield* cars(db, "acme", rows);
    yield* define(db);
    // Each batch of entries is one commit on the global shard (identifiers for
    // new entries are allocated in small commits of their own): fail the second batch.
    writes = 0;
    failOn = 2;
    const crashed = yield* Effect.exit(db.crossTenantIndexes.refresh("cars"));
    failOn = Infinity;
    // The pass reports the partition it could not finish, or dies with it.
    if (crashed._tag === "Success") assert.ok(crashed.value[0].failures.length > 0 || crashed.value[0].applied < 700);
    const partial = yield* indexed(db);
    assert.ok(partial.length > 0 && partial.length < 700, `some but not all entries landed (${partial.length})`);

    const resumed = yield* db.crossTenantIndexes.refresh("cars");
    assert.equal(resumed[0].rederived, 0, "carried on from the committed cursor");
    assert.equal(resumed[0].applied, 700 - partial.length, "exactly what the cut-off pass had not applied");
    assert.deepEqual(yield* indexed(db), yield* truth(db, ["acme"]));
  }), {
    wrap: (shard, engine) => !["s0", "s1"].includes(shard) ? engine : {
      ...engine,
      conditionalWrite: (batch, conditions) => Effect.suspend(() => {
        if (batch.length > 4) writes += 1;
        return writes === failOn ? Effect.die(new Error("injected crash between batches")) : engine.conditionalWrite(batch, conditions);
      }),
    },
  });
});

test("a moved Tenant is followed on its new shard from where its cursor was", () =>
  withMemoryDatabase((db) => Effect.gen(function* () {
    const tenant = ["acme", "bravo", "cosmo", "delta"].find((name) => shardFor(map, name) === "s0");
    yield* cars(db, tenant, [["m1", { color: "red", price: 1 }]]);
    yield* define(db);
    yield* db.crossTenantIndexes.refresh();
    yield* db.movement.rebalance(allOn("s1", 2));
    yield* cars(db, tenant, [["m2", { color: "blue", price: 2 }]]);
    const [after] = yield* db.crossTenantIndexes.refresh();
    assert.deepEqual([after.applied, after.rederived, after.removed], [1, 0, 0]);
    assert.deepEqual(yield* indexed(db), [`${tenant}/m1:red:1`, `${tenant}/m2:blue:2`]);
  })));

test("a Tenant compacted past its cursor is derived again from its records, deletions included", () =>
  withMemoryDatabase((db) => Effect.gen(function* () {
    yield* cars(db, "acme", [["a1", { color: "red", price: 1 }], ["a2", { color: "red", price: 2 }]]);
    yield* cars(db, "bravo", [["b1", { color: "red", price: 3 }]]);
    yield* define(db);
    yield* db.crossTenantIndexes.refresh();
    const docs = db.forTenant("acme").documents;
    yield* docs.delete({ collection: "cars", id: "a2" });
    yield* docs.update({ collection: "cars", id: "a1", data: { color: "blue" } });
    yield* cars(db, "acme", [["a3", { color: "red", price: 4 }]]);
    yield* db.maintenance.compact();

    const [result] = yield* db.crossTenantIndexes.refresh();
    assert.equal(result.rederived, 1, "only the compacted Tenant");
    assert.deepEqual(yield* indexed(db), yield* truth(db, ["acme", "bravo"]));
    assert.deepEqual(yield* indexed(db), ["acme/a1:blue:1", "acme/a3:red:4", "bravo/b1:red:3"]);
  })));

test("a removed Tenant leaves the index, and one removed and written again between refreshes is not read by its old cursor", () =>
  withMemoryDatabase((db) => Effect.gen(function* () {
    yield* cars(db, "acme", [["a1", { color: "red", price: 1 }], ["a2", { color: "red", price: 2 }]]);
    yield* cars(db, "bravo", [["b1", { color: "red", price: 3 }]]);
    yield* define(db);
    yield* db.crossTenantIndexes.refresh();

    yield* db.dropTenant("bravo");
    const [gone] = yield* db.crossTenantIndexes.refresh();
    assert.equal(gone.removed, 1);
    assert.deepEqual(yield* indexed(db), ["acme/a1:red:1", "acme/a2:red:2"]);

    // Removed and written again before the index looks: positions start over,
    // so the old cursor would point into a different log.
    yield* db.dropTenant("acme");
    yield* cars(db, "acme", [["n1", { color: "blue", price: 9 }]]);
    const [again] = yield* db.crossTenantIndexes.refresh();
    assert.equal(again.rederived, 1);
    assert.deepEqual(yield* indexed(db), ["acme/n1:blue:9"]);
  })));

test("plugins' service: Tenants are never indexed, and divided Tenants are indexed part by part", () =>
  withMemoryDatabase((db) => Effect.gen(function* () {
    yield* cars(db, "service:secrets", [["s1", { color: "red", price: 1 }]]);
    yield* db.topology.subdivision.subdivide("whale", ["a", "b"]);
    for (const part of ["a", "b"]) {
      const docs = db.forPart("whale", part).documents;
      yield* docs.createCollection({ name: "cars" });
      yield* docs.insert({ collection: "cars", id: `w${part}`, data: { color: "red", price: 5 } });
    }
    yield* define(db);
    yield* db.crossTenantIndexes.refresh();
    assert.deepEqual(yield* indexed(db), ["whale#a/wa:red:5", "whale#b/wb:red:5"]);
    const parts = yield* db.crossTenantIndexes.query({ index: "cars", tenants: ["whale"] });
    assert.deepEqual(parts.matches.map((m) => [m.tenant, m.part]).sort(), [["whale", "a"], ["whale", "b"]]);
  })));

test("the background refresh picks up a write shortly after it commits", () =>
  withMemoryDatabase((db) => Effect.gen(function* () {
    yield* define(db);
    yield* cars(db, "acme", [["a1", { color: "red", price: 1 }]]);
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((yield* indexed(db)).length === 1) break;
      yield* Effect.sleep("10 millis");
    }
    assert.deepEqual(yield* indexed(db), ["acme/a1:red:1"]);
    const [summary] = yield* db.crossTenantIndexes.list;
    assert.ok(summary.refreshedAt !== undefined);
  }), { refresh: { debounce: "1 millis", sweepInterval: "1 hour" } }));

test("an index outlives a restart, and dropping it removes everything it held", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-cti-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const open = (body) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const stores = new Map();
    const db = yield* makeDatabase({
      partitionMap: map,
      crossTenantRefresh: false,
      openShard: (shard) => Effect.tap(makeNodeSqliteStore(shard, dir), (store) => Effect.sync(() => stores.set(shard, store))),
    });
    return yield* body(db, stores);
  })));
  await open((db) => Effect.gen(function* () {
    yield* cars(db, "acme", [["a1", { color: "red", price: 1 }]]);
    yield* define(db);
    yield* db.crossTenantIndexes.refresh();
  }));
  await open((db, stores) => Effect.gen(function* () {
    assert.deepEqual((yield* db.crossTenantIndexes.list).map((index) => index.name), ["cars"]);
    const persisted = yield* db.crossTenantIndexes.get("cars");
    assert.ok(persisted.refreshedAt, "successful refresh status survives reopening without a new pass");
    assert.equal(persisted.partitions, 1);
    assert.deepEqual(yield* indexed(db), ["acme/a1:red:1"], "entries are kept, before any refresh");
    yield* cars(db, "acme", [["a2", { color: "blue", price: 2 }]]);
    const [result] = yield* db.crossTenantIndexes.refresh();
    assert.deepEqual([result.applied, result.rederived], [1, 0], "carried on from the stored cursor");

    const dropped = yield* db.crossTenantIndexes.drop("cars");
    assert.equal(dropped.name, "cars");
    assert.ok(dropped.entries > 0);
    for (const store of stores.values()) assert.ok(!(yield* store.partitions).includes("zv.cti.cars"), "every index placement is gone");
    assert.equal((yield* Effect.flip(db.crossTenantIndexes.drop("cars")))._tag, "CrossTenantIndexNotFound");
  }));
});

test("a database with no index holds nothing of them", () =>
  withMemoryDatabase((db, engines) => Effect.gen(function* () {
    yield* cars(db, "acme", [["a1", { color: "red", price: 1 }]]);
    assert.deepEqual(yield* db.crossTenantIndexes.list, []);
    const global = yield* openShardOverKv("zv.global", engines.get("zv.global"));
    assert.ok(!(yield* global.partitions).some((partition) => partition.startsWith("zv.cti")));
  })));

test("refresh failures survive reopening and retain the last successful full-refresh time", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "zv-cti-status-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let lastSuccess;
  const open = body => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const stores = new Map();
    const db = yield* makeDatabase({ partitionMap: map, crossTenantRefresh: false,
      openShard: shard => Effect.tap(makeNodeSqliteStore(shard, directory), store => Effect.sync(() => stores.set(shard, store))),
    });
    return yield* body(db, stores);
  })));
  await open((db, stores) => Effect.gen(function* () {
    yield* cars(db, "acme", [["a", { color: "red", price: 1 }]]);
    let fail = false;
    const index = yield* crossTenantIndexesOver({ globalShard: stores.get("zv.global"), shards: stores,
      tenantsOn: shard => shard.partitions,
      routed: partition => {
        const store = stores.get(db.shardOf(partition)).partition(partition);
        return { ...store, stats: fail ? Effect.fail(new StoreError({ op: "test.read", cause: "source unavailable" })) : store.stats };
      },
    });
    yield* index.api.define({ name: "cars", collection: "cars" });
    yield* index.api.refresh();
    lastSuccess = (yield* index.api.get("cars")).refreshedAt;
    fail = true;
    const [refused] = yield* index.api.refresh();
    assert.deepEqual(refused.failures, [{ partition: "acme", error: "StoreError" }]);
    assert.equal((yield* index.api.get("cars")).refreshedAt, lastSuccess);
  }));
  await open(db => Effect.gen(function* () {
    const status = yield* db.crossTenantIndexes.get("cars");
    assert.equal(status.refreshedAt, lastSuccess);
    assert.deepEqual(status.failures, [{ partition: "acme", error: "StoreError" }]);
    yield* db.crossTenantIndexes.refresh();
    assert.deepEqual((yield* db.crossTenantIndexes.get("cars")).failures, []);
  }));
});

test("the background refresh never keeps a process alive that left its database open", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "zv-cti-exit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // The child defines an index, writes so a refresh is pending, and ends without
  // closing anything: the sweep and the debounce must not hold it.
  const script = `
    const { openNodeDatabase } = await import(${JSON.stringify(new URL("../dist/db/node-host.js", import.meta.url).href)});
    const { api } = await openNodeDatabase({ directory: ${JSON.stringify(directory)}, shards: ["shard-0"] });
    await api.forTenant("acme").documents.createCollection({ name: "cars" });
    await api.crossTenantIndexes.define({ name: "cars", collection: "cars" });
    await api.forTenant("acme").documents.insert({ collection: "cars", id: "a1", data: { color: "red" } });
  `;
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve("still running after 20s"); }, 20_000);
    child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exit, 0, stderr);
});


test("derived index placements are spread across shards, bounded pages merge their order and bind cursor identity", () =>
  withMemoryDatabase((db, _engines, stores) => Effect.gen(function* () {
    for (let tenant = 0; tenant < 8; tenant++) {
      yield* cars(db, `tenant${tenant}`, Array.from({ length: 50 }, (_, row) => [`r${row}`, { color: row % 2 ? "blue" : "red", price: (row * 7 + tenant) % 17 }]));
    }
    const definition = yield* define(db);
    assert.deepEqual(definition.shards, ["s0", "s1"]);
    yield* db.crossTenantIndexes.refresh();
    const counts = [];
    for (const shard of definition.shards) counts.push(yield* stores.get(shard).partition("zv.cti.cars").namespaceSize("doc/entries"));
    assert.ok(counts.every(count => count > 0), `both placements hold entries: ${counts}`);
    assert.equal(counts.reduce((sum, count) => sum + count), 400);
    const found = [], keys = new Set();
    let after, firstCursor;
    do {
      const page = yield* db.crossTenantIndexes.query({ index: "cars", orderBy: [{ path: "price" }], limit: after ? 37 : 151, ...(after ? { after } : {}) });
      found.push(...page.matches);
      for (const match of page.matches) keys.add(`${match.tenant}/${match.id}`);
      after = page.next;
      firstCursor ??= after;
    } while (after);
    assert.equal(found.length, 400);
    assert.equal(keys.size, 400);
    assert.deepEqual(found.map(match => match.data.price), found.map(match => match.data.price).sort((a, b) => a - b));
    assert.equal((yield* Effect.flip(db.crossTenantIndexes.query({ index: "cars", where: [{ path: "color", value: "red" }], after: firstCursor })))._tag, "CursorMismatch");
    yield* db.crossTenantIndexes.drop("cars");
    yield* define(db);
    yield* db.crossTenantIndexes.refresh();
    assert.equal((yield* Effect.flip(db.crossTenantIndexes.query({ index: "cars", orderBy: [{ path: "price" }], after: firstCursor })))._tag, "CursorMismatch");
    assert.equal((yield* Effect.flip(db.crossTenantIndexes.define({ name: "bad", collection: "cars", shards: ["missing"] })))._tag, "InvalidCrossTenantIndex");
  })));

test("derived placements support composite, geometry and exact vector queries", () =>
  withMemoryDatabase((db) => Effect.gen(function* () {
    for (const [tenant, price, color, lon, vector] of [["acme", 3, "red", 13.4, [1, 0]], ["bravo", 2, "blue", 13.41, [0, 1]], ["cosmo", 1, "red", 14.0, [0.9, 0.1]]]) {
      yield* cars(db, tenant, [["a", { price, color, location: { type: "Point", coordinates: [lon, 52.5] }, vector }]]);
    }
    yield* define(db, {
      spatial: { fields: ["location"], resolution: 7, version: 1 },
      embedding: { field: "vector", dimension: 2, metric: "cosine", version: 1 },
      indexes: [{ name: "color_price", fields: [{ path: "color" }, { path: "price", direction: "desc" }] }],
    });
    yield* db.crossTenantIndexes.refresh();
    const composite = yield* db.crossTenantIndexes.query({ index: "cars", orderBy: [{ path: "color" }, { path: "price", direction: "desc" }] });
    assert.deepEqual(composite.matches.map(match => match.tenant), ["bravo", "acme", "cosmo"]);
    const geometry = yield* db.crossTenantIndexes.query({ index: "cars", geometry: { field: "location", near: [13.4, 52.5], radius: 2000 }, limit: 1 });
    assert.deepEqual(geometry.matches.map(match => match.tenant), ["acme"]);
    assert.equal(geometry.matches[0].distance, 0);
    const nearby = yield* db.crossTenantIndexes.query({ index: "cars", geometry: { field: "location", near: [13.4, 52.5], radius: 2000 }, limit: 1, after: geometry.next });
    assert.deepEqual(nearby.matches.map(match => match.tenant), ["bravo"]);
    const similar = yield* db.crossTenantIndexes.query({ index: "cars", similar: { field: "vector", vector: [1, 0] }, limit: 1 });
    assert.deepEqual(similar.matches.map(match => match.tenant), ["acme"]);
    const second = yield* db.crossTenantIndexes.query({ index: "cars", similar: { field: "vector", vector: [1, 0] }, limit: 1, after: similar.next });
    assert.deepEqual(second.matches.map(match => match.tenant), ["cosmo"]);
    assert.equal((yield* Effect.flip(db.crossTenantIndexes.define({ name: "unique", collection: "cars", indexes: [{ name: "unique_price", fields: [{ path: "price" }], unique: true }] })))._tag, "InvalidCrossTenantIndex");
  })));

for (const recover of ["resume", "remove"]) test(`a cut-off derivation refuses queries durably and recovers by ${recover}`, () =>
  withMemoryDatabase((db, _engines, stores) => Effect.gen(function* () {
    yield* cars(db, "acme", Array.from({ length: 700 }, (_, n) => [`r${n}`, { price: n, color: "red" }]));
    let fail = false, scans = 0;
    const open = () => crossTenantIndexesOver({ globalShard: stores.get("zv.global"), shards: stores,
      tenantsOn: shard => shard.partitions,
      routed: partition => {
        const store = stores.get(db.shardOf(partition)).partition(partition);
        return { ...store, scanIdentities: input => Effect.suspend(() => {
          if (fail && ++scans > 1) return Effect.fail(new StoreError({ op: "injected.scan", cause: "interrupted" }));
          return store.scanIdentities(input);
        }) };
      },
    });
    let index = yield* open();
    yield* index.api.define({ name: "cars", collection: "cars" });
    yield* index.api.refresh();
    yield* db.forTenant("acme").documents.delete({ collection: "cars", id: "r0" });
    yield* db.maintenance.compact();
    fail = true;
    const [failed] = yield* index.api.refresh();
    assert.equal(failed.failures.length, 1);
    assert.equal((yield* Effect.flip(index.api.query({ index: "cars" })))._tag, "CrossTenantIndexRefreshing");
    index = yield* open(); // Reads the durable marker, without retaining any process state.
    assert.equal((yield* Effect.flip(index.api.query({ index: "cars" })))._tag, "CrossTenantIndexRefreshing");
    fail = false;
    if (recover === "remove") yield* db.dropTenant("acme");
    yield* index.api.refresh();
    const page = yield* index.api.query({ index: "cars", limit: 1000 });
    assert.equal(page.matches.length, recover === "resume" ? 699 : 0);
    assert.ok(!page.matches.some(match => match.id === "r0"));
  })));
