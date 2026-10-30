// A shard a move has cleared keeps the map version that moved the tenant away,
// so a router still holding an older map is told the tenant moved instead of
// being answered from an empty partition, which would read as an empty tenant.
// Calls nobody routed name their shard themselves and are not checked.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Stream } from "effect";
import { makeDatabase, partitionMapFor, shardFor } from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { openShardOverKv } from "../dist/db/kv-store.js";
import { partitionRouter } from "../dist/db/routing.js";

const enc = new TextEncoder();
const manifest = { terms: [], columns: [], measures: [], edges: [] };
const initial = partitionMapFor(["s0", "s1"]);
const allOn = (shard, version) => ({ version, virtualRanges: 256, placements: [{ from: 0, to: 256, shard }] });
const tenant = ["acme", "bravo", "cosmo", "delta"].find((name) => shardFor(initial, name) === "s0");

/** A router that routes every partition to `shard` by a map of `version`, as a caller with its own copy of the map would. */
const routerAt = (shards, shard, version) => partitionRouter({ route: () => ({ shard, version }), shards });

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-relocated-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const openDatabase = (dir, stores) =>
  makeDatabase({
    partitionMap: initial,
    openShard: (shard) => Effect.tap(makeNodeSqliteStore(shard, dir), (store) => Effect.sync(() => stores.set(shard, store))),
  });

const seed = (db) =>
  Effect.gen(function* () {
    const docs = db.forTenant(tenant).documents;
    yield* docs.createCollection({ name: "posts" });
    yield* docs.insert({ collection: "posts", id: "p1", data: { title: "one" } });
    yield* docs.insert({ collection: "posts", id: "p2", data: { title: "two" } });
  });

const titles = (db) =>
  Effect.map(db.forTenant(tenant).documents.findMany({ collection: "posts" }), (docs) => docs.map((doc) => doc.data.title).sort());

/** Every way into a partition a stale router could take: reads, a stream, a write and a nested API. */
const everyDoor = (store) => [
  store.stats,
  store.liveRecords,
  store.read(1),
  store.lookup("doc/posts", "p1"),
  Stream.runCollect(store.events.read()),
  store.events.head,
  store.transact((txn) => txn.put(1, enc.encode("late"), manifest, { namespace: "doc/x", key: "k1" })),
  store.nextSeq,
];

test("a router whose map predates a move is refused at the shard the tenant left, at every door", async (t) => {
  assert.ok(tenant !== undefined, "a tenant the initial map places on s0");
  const dir = tempDir(t);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const stores = new Map();
    const db = yield* openDatabase(dir, stores);
    yield* seed(db);
    yield* db.movement.rebalance(allOn("s1", 2));
    assert.equal(db.shardOf(tenant), "s1");
    assert.deepEqual(yield* titles(db), ["one", "two"], "the current router finds the tenant on its new shard");

    const stale = routerAt(stores, "s0", initial.version).routed(tenant);
    for (const door of everyDoor(stale)) {
      const refused = yield* Effect.flip(door);
      assert.equal(refused._tag, "TenantRelocated");
      assert.deepEqual(
        [refused.partition, refused.shard, refused.mapVersion, refused.routedBy],
        [tenant, "s0", 2, initial.version],
      );
    }

    // A router that knows the move is not refused: it would only be sent here
    // if a later map placed the tenant here again, and then the shard is
    // genuinely where it lives.
    const current = routerAt(stores, "s0", 2).routed(tenant);
    assert.deepEqual(yield* current.liveRecords, []);

    // Nobody routed this call; it named the shard itself.
    assert.deepEqual(yield* stores.get("s0").partition(tenant).liveRecords, []);
    assert.ok(!(yield* stores.get("s0").partitions).includes(tenant), "the marker is not a partition: the shard holds no key of the tenant");
  })));
});

test("the relocation outlives a restart of the shard it was left on", async (t) => {
  const dir = tempDir(t);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const db = yield* openDatabase(dir, new Map());
    yield* seed(db);
    yield* db.movement.rebalance(allOn("s1", 2));
  })));

  // A fresh process, opening only the shard a stale caller would reach.
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const s0 = yield* makeNodeSqliteStore("s0", dir);
    const stale = routerAt(new Map([["s0", s0]]), "s0", 1).routed(tenant);
    const refused = yield* Effect.flip(stale.liveRecords);
    assert.equal(refused._tag, "TenantRelocated");
    assert.equal(refused.mapVersion, 2);
  })));
});

test("a tenant moved away and back is served again, and each shard answers for the move that left it", async (t) => {
  const dir = tempDir(t);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const stores = new Map();
    const db = yield* openDatabase(dir, stores);
    yield* seed(db);
    yield* db.movement.rebalance(allOn("s1", 2));
    // The copy back onto s0 is not routed, so the marker there does not stand in its way.
    yield* db.movement.rebalance(allOn("s0", 3));
    assert.equal(db.shardOf(tenant), "s0");
    assert.deepEqual(yield* titles(db), ["one", "two"]);
    yield* db.forTenant(tenant).documents.insert({ collection: "posts", id: "p3", data: { title: "three" } });
    assert.deepEqual(yield* titles(db), ["one", "three", "two"]);

    const leftS1 = yield* Effect.flip(routerAt(stores, "s1", 2).routed(tenant).liveRecords);
    assert.deepEqual([leftS1._tag, leftS1.shard, leftS1.mapVersion], ["TenantRelocated", "s1", 3]);

    // s0 still remembers the first move. A router at version 1 was right that
    // the tenant lives on s0, but cannot know that what it finds there is the
    // tenant's data rather than a copy in progress, so it is sent to refresh.
    const leftS0 = yield* Effect.flip(routerAt(stores, "s0", 1).routed(tenant).liveRecords);
    assert.deepEqual([leftS0._tag, leftS0.mapVersion], ["TenantRelocated", 2]);
    assert.equal((yield* routerAt(stores, "s0", 3).routed(tenant).liveRecords).length > 0, true);
  })));
});

test("a relocation's version only rises, and must be a positive integer", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const shard = yield* openShardOverKv("s0", memoryKvEngine());
    yield* shard.relocate("acme", 5);
    yield* shard.relocate("acme", 3);
    const refused = yield* Effect.flip(routerAt(new Map([["s0", shard]]), "s0", 4).routed("acme").stats);
    assert.deepEqual([refused._tag, refused.mapVersion], ["TenantRelocated", 5], "a lower version does not replace a higher one");

    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const failure = yield* Effect.flip(shard.relocate("bravo", bad));
      assert.deepEqual([failure._tag, failure.op], ["StoreError", "relocate"]);
    }
  }))));

test("a removal cut off after the relocation is recorded refuses stale routers, and repeating it finishes", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const engine = memoryKvEngine();
    let failAfter = Infinity;
    const failing = {
      ...engine,
      conditionalWrite: (writes, conditions) =>
        Effect.suspend(() => {
          if (failAfter-- <= 0) return Effect.die(new Error("injected crash between batches"));
          return engine.conditionalWrite(writes, conditions);
        }),
    };
    const shard = yield* openShardOverKv("s0", failing);
    const store = shard.partition("acme");
    yield* store.transact((txn) => txn.put(1, enc.encode("kept"), manifest, { namespace: "doc/x", key: "k1" }));

    // The relocation's own batch lands; the first removal batch does not.
    failAfter = 1;
    const crashed = yield* Effect.exit(shard.relocate("acme", 2));
    assert.equal(crashed._tag, "Failure");
    failAfter = Infinity;

    assert.equal((yield* store.liveRecords).length, 1, "nothing was removed yet");
    const refused = yield* Effect.flip(routerAt(new Map([["s0", shard]]), "s0", 1).routed("acme").liveRecords);
    assert.equal(refused._tag, "TenantRelocated", "no stale router reads the partition while it is being removed");

    assert.equal(yield* shard.relocate("acme", 2), 1);
    assert.deepEqual(yield* store.liveRecords, []);
    assert.ok(!(yield* shard.partitions).includes("acme"));
  }))));
