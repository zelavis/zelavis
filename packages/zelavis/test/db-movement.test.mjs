import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Deferred, Effect, Fiber } from "effect";
import { makeDatabase, partitionMapFor, shardFor } from "../dist/db/index.js";
import { makeNodeSqliteEngine, makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";
import { openShardOverKv } from "../dist/db/kv-store.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { StoreError } from "../dist/db/errors.js";

const withDatabase = (t, body) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-move-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stores = new Map();
  return Effect.runPromise(
    Effect.scoped(Effect.gen(function* () {
      const db = yield* makeDatabase({
        partitionMap: partitionMapFor(["s0", "s1"]),
        openShard: (shard) =>
          Effect.tap(makeNodeSqliteStore(shard, dir), (store) =>
            Effect.sync(() => stores.set(shard, store))),
      });
      return yield* body(db, stores);
    })),
  );
};

/**
 * A map placing every range on one shard.
 *
 * The bluntest possible change, and the one that guarantees every tenant has to
 * move rather than leaving the test to hope some of them did.
 */
const allOn = (shard, version) => ({
  version,
  virtualRanges: 256,
  placements: [{ from: 0, to: 256, shard }],
});

const seed = (db, tenants) =>
  Effect.gen(function* () {
    for (const tenant of tenants) {
      const docs = db.forTenant(tenant).documents;
      yield* docs.createCollection({ name: "posts" });
      for (let i = 1; i <= 3; i++) {
        yield* docs.insert({
          collection: "posts",
          id: `p${i}`,
          data: { title: `${tenant}-${i}`, state: i === 2 ? "draft" : "live" },
        });
      }
      yield* docs.update({ collection: "posts", id: "p1", data: { title: `${tenant}-edited` } });
    }
  });

const snapshot = (db, tenant) =>
  Effect.gen(function* () {
    const docs = db.forTenant(tenant).documents;
    const found = yield* docs.findMany({ collection: "posts" });
    return {
      collections: (yield* docs.listCollections).map((c) => c.name),
      docs: found
        .map((d) => `${d.id}:${d.data.title}:v${d.version}`)
        .sort(),
      live: (yield* docs.findMany({ collection: "posts", where: [{ path: "state", value: "live" }] }))
        .map((d) => d.id).sort(),
    };
  });

test("a map that would strand records is still refused on its own", async (t) => {
  await withDatabase(t, (db) =>
    Effect.gen(function* () {
      yield* seed(db, ["acme", "bravo", "cosmo", "delta"]);
      const target = allOn("s1", 2);

      const planned = yield* db.movement.plan(target);
      assert.ok(planned.length > 0, "there are ranges to move");
      assert.ok(planned.some((move) => move.tenants.length > 0), "and tenants standing on them");

      // Unchanged behaviour: routing carries no data, so moving a range out
      // from under records would point every read at a shard that has none.
      const refused = yield* Effect.flip(db.topology.update(target));
      assert.equal(refused._tag, "RangeNotEmpty");
      assert.equal(db.partitionMap.version, 1, "and the map in force did not change");
    }),
  );
});

test("a rebalance moves the records, then the routing", async (t) => {
  await withDatabase(t, (db) =>
    Effect.gen(function* () {
      const tenants = ["acme", "bravo", "cosmo", "delta"];
      yield* seed(db, tenants);

      const before = {};
      for (const tenant of tenants) before[tenant] = yield* snapshot(db, tenant);
      const moved = tenants.filter((tenant) => db.shardOf(tenant) !== "s1");
      assert.ok(moved.length > 0, "some tenants started somewhere other than the target");

      const result = yield* db.movement.rebalance(allOn("s1", 2));

      assert.equal(result.map.version, 2);
      assert.deepEqual(result.moves.map((move) => move.tenant).sort(), moved.sort());
      for (const move of result.moves) {
        assert.equal(move.to, "s1");
        assert.ok(move.copied > 0, `${move.tenant} copied nothing`);
        assert.ok(move.removed > 0, `${move.tenant} left its records behind`);
        assert.equal(move.resumed, false);
      }

      // Routing followed the records rather than the other way round.
      for (const tenant of tenants) {
        assert.equal(db.shardOf(tenant), "s1");
        assert.deepEqual(yield* snapshot(db, tenant), before[tenant],
          `${tenant} does not read the same after the move`);
      }

      assert.deepEqual(yield* db.movement.pending, [], "nothing was left half-done");
    }),
  );
});

test("a tenant moved after its log was compacted can still rebuild its lenses from the log on its new shard", async (t) => {
  await withDatabase(t, (db, stores) =>
    Effect.gen(function* () {
      const tenants = ["acme", "bravo", "cosmo", "delta"];
      yield* seed(db, tenants);
      const moved = tenants.filter((tenant) => db.shardOf(tenant) !== "s1");
      assert.ok(moved.length > 0);
      for (const tenant of moved) {
        const cut = yield* stores.get(db.shardOf(tenant)).partition(tenant).compact();
        assert.ok(cut.removed > 0, `${tenant} had history to drop`);
      }
      const before = {};
      for (const tenant of tenants) before[tenant] = yield* snapshot(db, tenant);

      yield* db.movement.rebalance(allOn("s1", 2));

      for (const tenant of moved) {
        const partition = stores.get("s1").partition(tenant);
        assert.ok((yield* partition.snapshotAt) >= (yield* partition.compactedTo), `${tenant}: a snapshot covers what the log lacks`);
        yield* partition.rebuildLenses;
        assert.deepEqual(yield* snapshot(db, tenant), before[tenant], `${tenant} reads the same after the rebuild`);
      }
    }),
  );
});

/**
 * A database over in-memory shards whose engines can hold one read open: the
 * next `get` of a key naming "blocker" waits, once armed, until released — a
 * call caught in flight on whichever shard it reached.
 */
const withGatedDatabase = (body, options = {}) => {
  const marker = new TextEncoder().encode("blocker");
  const names = (key) => {
    outer: for (let at = 0; at + marker.length <= key.length; at++) {
      for (let i = 0; i < marker.length; i++) if (key[at + i] !== marker[i]) continue outer;
      return true;
    }
    return false;
  };
  const gate = { armed: false, reached: Deferred.makeUnsafe(), release: Deferred.makeUnsafe() };
  const held = (read) => (key) => gate.armed && names(key)
    ? Effect.suspend(() => {
        gate.armed = false;
        Deferred.doneUnsafe(gate.reached, Effect.void);
        return Effect.andThen(Deferred.await(gate.release), read(key));
      })
    : read(key);
  // Reads go through a snapshot of the engine, so its readers are held too.
  const gated = (base) => ({
    ...base,
    get: held(base.get),
    snapshot: Effect.map(base.snapshot, (reader) => ({ ...reader, get: held(reader.get) })),
  });
  const stores = new Map();
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const db = yield* makeDatabase({
      partitionMap: partitionMapFor(["s0", "s1"]),
      ...options,
      openShard: (shard) =>
        Effect.tap(openShardOverKv(shard, gated(memoryKvEngine())), (store) => Effect.sync(() => stores.set(shard, store))),
    });
    return yield* body(db, stores, gate);
  })));
};

/** Wait, briefly, until a move is on record in this phase. */
const untilPhase = (db, phase) => Effect.gen(function* () {
  for (let tries = 0; tries < 1000; tries++) {
    if ((yield* db.movement.pending).some((move) => move.phase === phase)) return;
    yield* Effect.sleep("2 millis");
  }
  assert.fail(`no move reached ${phase}`);
});

test("a tenant's handle taken before a move reads and writes on the new shard after it", () =>
  withGatedDatabase((db, stores) => Effect.gen(function* () {
    const tenants = ["acme", "bravo", "cosmo", "delta"];
    yield* seed(db, tenants);
    const tenant = tenants.find((name) => db.shardOf(name) === "s0");
    const handle = db.forTenant(tenant);
    const before = yield* snapshot(db, tenant);

    yield* db.movement.rebalance(allOn("s1", 2));

    const found = yield* handle.documents.findMany({ collection: "posts" });
    assert.deepEqual(found.map((d) => `${d.id}:${d.data.title}:v${d.version}`).sort(), before.docs,
      "the old handle reads the moved records, not an emptied shard");
    yield* handle.documents.insert({ collection: "posts", id: "p9", data: { title: "after" } });
    assert.notEqual(yield* stores.get("s1").partition(tenant).lookup("doc/posts", "p9"), undefined, "and writes where the tenant now lives");
    assert.ok(!(yield* stores.get("s0").partitions).includes(tenant));
  })));

test("a read in flight across a move finishes on whole data, and the old shard is cleared only after it", () =>
  withGatedDatabase((db, stores, gate) => Effect.gen(function* () {
    const tenants = ["acme", "bravo", "cosmo", "delta"];
    yield* seed(db, tenants);
    const tenant = tenants.find((name) => db.shardOf(name) === "s0");
    yield* db.forTenant(tenant).documents.insert({ collection: "posts", id: "blocker", data: { title: "held" } });

    gate.armed = true;
    const reader = yield* Effect.forkChild(db.forTenant(tenant).documents.findById({ collection: "posts", id: "blocker" }));
    yield* Deferred.await(gate.reached);
    const moving = yield* Effect.forkChild(db.movement.rebalance(allOn("s1", 2)));

    // Routed, and waiting for the read that reached s0 first.
    yield* untilPhase(db, "routed");
    yield* Effect.sleep("20 millis");
    assert.equal(db.shardOf(tenant), "s1");
    assert.equal(moving.pollUnsafe(), undefined, "the move is still waiting");
    assert.ok((yield* stores.get("s0").partition(tenant).liveRecords).length > 0, "s0 still holds the tenant");

    yield* Deferred.succeed(gate.release, undefined);
    const found = yield* Fiber.join(reader);
    assert.equal(found?.data.title, "held", "the read found its document");
    const [move] = (yield* Fiber.join(moving)).moves;
    assert.ok(move.removed > 0);
    assert.ok(!(yield* stores.get("s0").partitions).includes(tenant), "then s0 was cleared, fence and all");
  })));

test("a move whose old shard is still in use past its deadline stops routed, and a resume clears it", () =>
  withGatedDatabase((db, stores, gate) => Effect.gen(function* () {
    const tenants = ["acme", "bravo", "cosmo", "delta"];
    yield* seed(db, tenants);
    const tenant = tenants.find((name) => db.shardOf(name) === "s0");
    yield* db.forTenant(tenant).documents.insert({ collection: "posts", id: "blocker", data: { title: "held" } });

    gate.armed = true;
    const reader = yield* Effect.forkChild(db.forTenant(tenant).documents.findById({ collection: "posts", id: "blocker" }));
    yield* Deferred.await(gate.reached);
    const stopped = yield* Effect.flip(db.movement.rebalance(allOn("s1", 2)));
    assert.equal(stopped._tag, "PlacementInUse");
    assert.deepEqual([stopped.shard, stopped.partition, stopped.calls], ["s0", tenant, 1]);

    // Routed and writable on its new shard; the old one intact and fenced.
    assert.equal((yield* db.movement.pending)[0].phase, "routed");
    assert.equal(db.shardOf(tenant), "s1");
    yield* db.forTenant(tenant).documents.insert({ collection: "posts", id: "p9", data: { title: "after" } });
    assert.ok((yield* stores.get("s0").partition(tenant).liveRecords).length > 0);
    assert.equal((yield* Effect.flip(stores.get("s0").partition(tenant).writable))._tag, "TenantMoving");

    yield* Deferred.succeed(gate.release, undefined);
    assert.equal((yield* Fiber.join(reader))?.data.title, "held");
    const [resumed] = yield* db.movement.resume;
    assert.equal(resumed.resumed, true);
    assert.ok(resumed.removed > 0);
    assert.ok(!(yield* stores.get("s0").partitions).includes(tenant));
    assert.deepEqual(yield* db.movement.pending, []);
    assert.equal((yield* db.forTenant(tenant).documents.findById({ collection: "posts", id: "p9" }))?.data.title, "after");
  }), { drainTimeout: "30 millis" }));

test("the shard a tenant left stops holding it, and stops claiming it", async (t) => {
  await withDatabase(t, (db, stores) =>
    Effect.gen(function* () {
      const tenants = ["acme", "bravo", "cosmo", "delta"];
      yield* seed(db, tenants);
      const from = tenants.find((tenant) => db.shardOf(tenant) === "s0");
      assert.ok(from !== undefined, "a tenant to move off s0");

      yield* db.movement.rebalance(allOn("s1", 2));

      // Not just unreachable: gone, fence included. A shard that kept the
      // records would go on growing, one that kept the occupancy marker would
      // tell the next placement decision it is still occupied, and one that
      // kept a fence would keep a partition for every tenant that ever left.
      // Nothing can still arrive: the move waited for every call that reached
      // s0 before routing moved.
      assert.deepEqual(yield* stores.get("s0").partition(from).liveRecords, [], `s0 still holds records for ${from}`);
      assert.ok(!(yield* stores.get("s0").partitions).includes(from), `s0 holds no key of ${from}`);

      // The fence is the source's alone: the copy takes writes the moment
      // routing points at it.
      assert.equal(yield* stores.get("s1").partition(from).writable, undefined);
      yield* db.forTenant(from).documents.insert({ collection: "posts", id: "after", data: { title: "after" } });

      const targets = yield* db.scatter.targets();
      assert.ok(targets.every((target) => target.shard === "s1"),
        "every tenant is reported on the shard that now holds it");
      assert.deepEqual(targets.map((target) => target.tenant).sort(), tenants);
    }),
  );
});

test("a fenced tenant refuses every kind of write and none of the reads", async (t) => {
  await withDatabase(t, (db, stores) =>
    Effect.gen(function* () {
      yield* seed(db, ["acme", "bravo", "cosmo", "delta"]);
      const tenant = ["acme", "bravo", "cosmo", "delta"].find((t2) => db.shardOf(t2) === "s0");

      // Stand the tenant behind the fence by hand. A real move only fences for
      // the last catch-up, which is too short to catch in the act, so the state
      // is set up rather than raced for.
      const source = stores.get("s0").partition(tenant);
      const enc = new TextEncoder();
      const held = yield* source.stats;
      yield* source.fence({ from: "s0", to: "s1" });

      const docs = db.forTenant(tenant).documents;
      const refused = yield* Effect.flip(
        docs.insert({ collection: "posts", id: "p9", data: { title: "late" } }));
      assert.equal(refused._tag, "TenantMoving");
      assert.equal(refused.tenant, tenant);
      assert.equal(refused.to, "s1");

      // Every write, not just inserts: an update or a delete landing on the
      // shard being left would be just as lost.
      assert.equal((yield* Effect.flip(
        docs.update({ collection: "posts", id: "p1", data: { title: "late" } })))._tag,
        "TenantMoving");
      assert.equal((yield* Effect.flip(
        docs.delete({ collection: "posts", id: "p1" })))._tag, "TenantMoving");
      assert.equal((yield* Effect.flip(docs.createCollection({ name: "other" })))._tag,
        "TenantMoving");

      // The store refuses it, not the documents layer: whatever writes the
      // partition around documents — time series points, projection
      // checkpoints, a restore — is refused just the same, and nothing it tried
      // is left behind.
      assert.equal((yield* Effect.flip(source.nextSeq))._tag, "TenantMoving");
      assert.equal((yield* Effect.flip(source.transact((txn) =>
        txn.put(held.nextSeq + 1, enc.encode("{}"), { terms: [], columns: [], measures: [], edges: [] }))))._tag,
        "TenantMoving");
      assert.deepEqual(yield* source.stats, held, "nothing was written behind the fence");

      // Reads are untouched. The source still holds the data and nothing is
      // changing it, so taking the tenant offline for reading would buy nothing.
      const found = yield* docs.findMany({ collection: "posts" });
      assert.equal(found.length, 3);

      // A tenant that is not moving is not affected by one that is.
      const other = ["acme", "bravo", "cosmo", "delta"].find((t2) => t2 !== tenant);
      yield* db.forTenant(other).documents.insert({
        collection: "posts", id: "p9", data: { title: "fine" },
      });
    }),
  );
});

test("a copy that does not match its source stops the move with TenantMoveFailed, leaving routing and the source as they were", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-move-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    // The target miscounts its records: what a copy that came up short shows.
    const db = yield* makeDatabase({
      partitionMap: partitionMapFor(["s0", "s1"]),
      openShard: (shard) => Effect.map(makeNodeSqliteStore(shard, dir), (store) => shard !== "s1" ? store : {
        ...store,
        partition: (name) => {
          const partition = store.partition(name);
          return { ...partition, stats: Effect.map(partition.stats, (stats) => ({ ...stats, records: stats.records + 1 })) };
        },
      }),
    });
    const tenants = ["acme", "bravo", "cosmo", "delta"];
    yield* seed(db, tenants);
    const tenant = tenants.find((name) => db.shardOf(name) === "s0");
    const before = yield* snapshot(db, tenant);

    // A failure the caller can see, not a defect: Effect.flip would rethrow one.
    const failure = yield* Effect.flip(db.movement.rebalance(allOn("s1", 2)));
    assert.equal(failure._tag, "TenantMoveFailed");
    assert.deepEqual([failure.from, failure.to], ["s0", "s1"]);
    assert.match(failure.reason, /records at position/);

    assert.equal(db.shardOf(tenant), "s0", "routing has not moved");
    assert.deepEqual(yield* snapshot(db, tenant), before, "the source is intact");
    const late = yield* Effect.flip(db.forTenant(tenant).documents.insert({
      collection: "posts", id: "late", data: { title: "late" },
    }));
    assert.equal(late._tag, "TenantMoving", "and it stays fenced until the move is resumed");
  })));
});

test("an interrupted move is resumed rather than repaired", async (t) => {
  await withDatabase(t, (db, stores) =>
    Effect.gen(function* () {
      const tenants = ["acme", "bravo", "cosmo", "delta"];
      yield* seed(db, tenants);
      const tenant = tenants.find((t2) => db.shardOf(t2) === "s0");
      const before = yield* snapshot(db, tenant);

      // Start a move and stop after the copy, which is the state a crash
      // between copying and routing leaves behind.
      const enc = new TextEncoder();
      const topologyStore = stores.get("zv.topology").partition("zv.topology");
      const record = {
        tenant, from: "s0", to: "s1", phase: "copying",
        startedAt: new Date().toISOString(), map: allOn("s1", 2),
      };
      yield* stores.get("s0").partition(tenant).fence({ from: "s0", to: "s1" });
      const moveSeq = yield* topologyStore.nextSeq;
      yield* topologyStore.transact((txn) =>
        txn.put(moveSeq, enc.encode(JSON.stringify(record)),
          { terms: [], columns: [["zv.move", " move"]], measures: [], edges: [] },
          { namespace: "zv.move", key: tenant }));

      const outstanding = yield* db.movement.pending;
      assert.equal(outstanding.length, 1);
      assert.equal(outstanding[0].phase, "copying");

      // A map change on top of an unfinished move would fence a tenant twice
      // and route it once, so it is refused until the move is settled.
      const blocked = yield* Effect.flip(db.movement.rebalance(allOn("s1", 3)));
      assert.equal(blocked._tag, "PartitionMapInvalid");
      assert.match(blocked.reason, /have not finished/);

      const finished = yield* db.movement.resume;
      assert.equal(finished.length, 1);
      // A resume never takes the unfenced path: it has no record of the
      // identifier mapping or the log position the interrupted copy reached, so
      // it fences first and copies again from the start.
      assert.equal(finished[0].resumed, true);
      assert.equal(finished[0].rounds, 0, "a resumed copy does not chase a moving target");
      assert.equal(db.shardOf(tenant), "s1");
      assert.deepEqual(yield* snapshot(db, tenant), before);
      assert.deepEqual(yield* db.movement.pending, []);

      // And the fence came off with it.
      yield* db.forTenant(tenant).documents.insert({
        collection: "posts", id: "p9", data: { title: "after" },
      });
    }),
  );
});

/** A move record as an interrupted rebalance leaves it: copying, routing unmoved. */
const recordCopyingMove = (stores, tenant) => Effect.gen(function* () {
  const topologyStore = stores.get("zv.topology").partition("zv.topology");
  const record = { tenant, from: "s0", to: "s1", phase: "copying", startedAt: new Date().toISOString(), map: allOn("s1", 2) };
  const seq = yield* topologyStore.nextSeq;
  yield* topologyStore.transact((txn) =>
    txn.put(seq, new TextEncoder().encode(JSON.stringify(record)),
      { terms: [], columns: [["zv.move", " move"]], measures: [], edges: [] },
      { namespace: "zv.move", key: tenant }));
});

test("a move cut off after its copy carries on from the target's head instead of copying again", async (t) => {
  await withDatabase(t, (db, stores) =>
    Effect.gen(function* () {
      const tenants = ["acme", "bravo", "cosmo", "delta"];
      yield* seed(db, tenants);
      const tenant = tenants.find((name) => db.shardOf(name) === "s0");
      // The state a crash after the seed leaves: a finished copy on the target,
      // a move on record, the source still taking writes.
      yield* stores.get("s1").partition(tenant).seed(stores.get("s0").partition(tenant));
      yield* recordCopyingMove(stores, tenant);
      yield* db.forTenant(tenant).documents.insert({ collection: "posts", id: "p9", data: { title: "written meanwhile" } });
      const before = yield* snapshot(db, tenant);

      const [result] = yield* db.movement.resume;
      assert.equal(result.resumed, true);
      assert.equal(result.copied, 0, "the copy was carried on, not made again");
      assert.ok(result.caughtUp > 0, "from the target's head, through what the source took since");
      assert.equal(db.shardOf(tenant), "s1");
      assert.deepEqual(yield* snapshot(db, tenant), before);
      yield* db.forTenant(tenant).documents.insert({ collection: "posts", id: "p10", data: { title: "after" } });
    }),
  );
});

test("a seed cut off part way is thrown away and copied again", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-move-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let failAt = 0;
  let commits = 0;
  const stores = new Map();
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const db = yield* makeDatabase({
      partitionMap: partitionMapFor(["s0", "s1"]),
      openShard: (shard) => Effect.tap(
        Effect.flatMap(makeNodeSqliteEngine(shard, dir), (engine) => openShardOverKv(shard, shard !== "s1" ? engine : {
          ...engine,
          conditionalWrite: (writes, conditions) =>
            failAt > 0 && ++commits === failAt
              ? Effect.fail(new StoreError({ op: "test.commit", cause: "cut off" }))
              : engine.conditionalWrite(writes, conditions),
        })),
        (store) => Effect.sync(() => stores.set(shard, store)),
      ),
    });
    const tenant = ["acme", "bravo", "cosmo", "delta"].find((name) => db.shardOf(name) === "s0");
    const docs = db.forTenant(tenant).documents;
    yield* docs.createCollection({ name: "posts" });
    // Enough for the seed to take more than one batch.
    for (let first = 0; first < 800; first += 200) {
      yield* docs.write({ operations: Array.from({ length: 200 }, (_, i) => ({
        _tag: "Insert", collection: "posts", id: `p${first + i}`,
        data: { title: `post ${first + i}`, a: i, b: `b${i % 9}`, c: i % 2 === 0, d: first },
      })) });
    }
    const before = yield* snapshot(db, tenant);
    const source = stores.get("s0").partition(tenant);
    const target = stores.get("s1").partition(tenant);
    commits = 0;
    failAt = 2;
    assert.equal((yield* Effect.exit(target.seed(source)))._tag, "Failure");
    failAt = 0;
    assert.equal((yield* target.stats).seeding, true);
    yield* recordCopyingMove(stores, tenant);

    const [result] = yield* db.movement.resume;
    assert.ok(result.copied >= 800, `the copy was made again from the start (${result.copied} records)`);
    assert.equal(db.shardOf(tenant), "s1");
    assert.deepEqual(yield* snapshot(db, tenant), before);
  })));
});

test("a copy interrupted halfway is not restored alongside its own wreckage", async (t) => {
  await withDatabase(t, (db, stores) =>
    Effect.gen(function* () {
      const tenants = ["acme", "bravo", "cosmo", "delta"];
      yield* seed(db, tenants);
      const tenant = tenants.find((t2) => db.shardOf(t2) === "s0");
      const before = yield* snapshot(db, tenant);

      // Put half a copy on the target, as an attempt that died mid-restore
      // would. Resuming has to discard it: replaying the rest alongside would
      // leave a tenant that is partly the old copy and looks whole.
      const partial = yield* db.forTenant(tenant).backups.exportTenant;
      const target = stores.get("s1").partition(tenant);
      const enc = new TextEncoder();
      for (const event of partial.events.slice(0, 2)) {
        const seq = yield* target.nextSeq;
        yield* target.transact((txn) =>
          txn.put(seq, new Uint8Array(Buffer.from(event.body, "base64")),
            event.manifest, event.identity));
      }
      void enc;

      const result = yield* db.movement.rebalance(allOn("s1", 2));
      const move = result.moves.find((m) => m.tenant === tenant);
      assert.ok(move !== undefined);

      assert.deepEqual(yield* snapshot(db, tenant), before,
        "the tenant reads as it did, not as a mixture of two copies");
    }),
  );
});

test("a rebalance with nothing standing in the way is an ordinary map change", async (t) => {
  await withDatabase(t, (db) =>
    Effect.gen(function* () {
      const result = yield* db.movement.rebalance(allOn("s1", 2));
      assert.deepEqual(result.moves, [], "no tenants, so nothing to relocate");
      assert.equal(result.map.version, 2);
      assert.equal(shardFor(db.partitionMap, "anything"), "s1");
    }),
  );
});

test("a move whose routing already landed is finished, not copied again", async (t) => {
  await withDatabase(t, (db, stores) =>
    Effect.gen(function* () {
      const tenants = ["acme", "bravo", "cosmo", "delta"];
      yield* seed(db, tenants);
      const tenant = tenants.find((t2) => db.shardOf(t2) === "s0");
      const before = yield* snapshot(db, tenant);

      // Take a real move all the way to routed, then put the record back as a
      // process that died during cleanup would have left it: routing moved,
      // source not yet emptied.
      const enc = new TextEncoder();
      const topologyStore = stores.get("zv.topology").partition("zv.topology");
      const writeMove = (record) =>
        Effect.gen(function* () {
          const existing = yield* topologyStore.lookup("zv.move", tenant);
          const seq = existing ?? (yield* topologyStore.nextSeq);
          yield* topologyStore.transact((txn) =>
            txn.put(seq, enc.encode(JSON.stringify(record)),
              { terms: [], columns: [["zv.move", " move"]], measures: [], edges: [] },
              { namespace: "zv.move", key: tenant }));
        });

      yield* db.movement.rebalance(allOn("s1", 2));
      assert.equal(db.shardOf(tenant), "s1");

      // Re-open the wound: the cleanup is undone by hand so the resume has a
      // routed move to finish.
      yield* writeMove({
        tenant, from: "s0", to: "s1", phase: "routed",
        startedAt: new Date().toISOString(), map: allOn("s1", 2),
      });

      const finished = yield* db.movement.resume;
      assert.equal(finished.length, 1);
      assert.equal(finished[0].resumed, true, "it was picked up rather than started");
      assert.equal(finished[0].copied, 0, "a routed move does not copy anything again");

      // Routing did not move a second time, and the tenant still reads the same.
      assert.equal(db.partitionMap.version, 2, "the map was applied once, not twice");
      assert.equal(db.shardOf(tenant), "s1");
      assert.deepEqual(yield* snapshot(db, tenant), before);
      assert.deepEqual(yield* db.movement.pending, []);
    }),
  );
});

test("SQLite reopening finishes routed movement cleanup without recopying or changing history", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-move-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const initial = partitionMapFor(["s0", "s1"]);
  const tenant = ["acme", "bravo", "cosmo", "delta"].find((name) => shardFor(initial, name) === "s0");
  assert.ok(tenant !== undefined);
  let cleanupInterrupted = false;
  const openAt = (interruptCleanup, body) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const stores = new Map();
    let db;
    db = yield* makeDatabase({
      partitionMap: initial,
      openShard: (shard) => Effect.map(makeNodeSqliteStore(shard, dir), (store) => {
        stores.set(shard, store);
        if (!interruptCleanup || shard !== "s0") return store;
        return {
          ...store,
          drop: (partition) => Effect.suspend(() => {
            if (db?.partitionMap.version === 2) {
              cleanupInterrupted = true;
              return Effect.die(new Error("injected interruption before source cleanup"));
            }
            return store.drop(partition);
          }),
        };
      }),
    });
    return yield* body(db, stores);
  })));
  let before;
  let routedEvents;
  await openAt(true, (db, stores) => Effect.gen(function* () {
    yield* seed(db, [tenant]);
    before = yield* snapshot(db, tenant);
    const history = (yield* db.forTenant(tenant).events.read()).events;
    const interrupted = yield* Effect.exit(db.movement.rebalance(allOn("s1", 2)));
    assert.equal(interrupted._tag, "Failure");
    assert.equal(cleanupInterrupted, true, "the injected cleanup interruption was reached");
    assert.equal(db.partitionMap.version, 2);
    assert.equal(db.shardOf(tenant), "s1");
    assert.equal((yield* db.movement.pending)[0].phase, "routed");
    assert.ok((yield* stores.get("s0").partition(tenant).liveRecords).length > 0, "source cleanup has not happened");
    routedEvents = (yield* db.forTenant(tenant).events.read()).events;
    // Physical event identities change when copied to another shard.
    const logicalHistory = (events) => events.map(({ cursor, eventId, ...event }) => event);
    assert.deepEqual(logicalHistory(routedEvents), logicalHistory(history));
  }));
  // The scope above closes every SQLite handle before any is reopened.
  await openAt(false, (db, stores) => Effect.gen(function* () {
    assert.equal(db.partitionMap.version, 2, "persisted routing outranks the original map");
    assert.equal((yield* db.movement.pending)[0].phase, "routed");
    assert.deepEqual(yield* snapshot(db, tenant), before);
    assert.deepEqual((yield* db.forTenant(tenant).events.read()).events, routedEvents);
    // The fence outlived the process that set it, until the move is finished.
    assert.equal((yield* Effect.flip(stores.get("s0").partition(tenant).writable))._tag, "TenantMoving");
    const results = yield* db.movement.resume;
    assert.equal(results.length, 1);
    assert.equal(results[0].resumed, true);
    assert.equal(results[0].copied, 0);
    assert.ok(results[0].removed > 0, "the real source records were cleaned up");
    assert.deepEqual(yield* stores.get("s0").partition(tenant).liveRecords, [], "no records are left on the source");
    assert.ok(!(yield* stores.get("s0").partitions).includes(tenant), "nor anything else, fence included: a restart holds no call that could still arrive");
    assert.equal(db.partitionMap.version, 2);
    assert.deepEqual(yield* snapshot(db, tenant), before);
    assert.deepEqual((yield* db.forTenant(tenant).events.read()).events, routedEvents);
    assert.deepEqual(yield* db.movement.pending, []);
  }));
  await openAt(false, (db, stores) => Effect.gen(function* () {
    assert.equal(db.partitionMap.version, 2);
    assert.equal(stores.has("s0"), false, "completed moves no longer require opening the retired source");
    assert.deepEqual(yield* db.movement.pending, []);
    assert.deepEqual(yield* db.movement.resume, [], "completed cleanup stays completed after another restart");
    assert.deepEqual(yield* snapshot(db, tenant), before);
    assert.deepEqual((yield* db.forTenant(tenant).events.read()).events, routedEvents);
  }));
});

test("a moved tenant keeps its graph links, including ones written during the move", async (t) => {
  await withDatabase(t, (db) =>
    Effect.gen(function* () {
      // Every shard already holds records, so the target hands the moved ones
      // identifiers of its own, and an edge carried as it was would name
      // something else there.
      const tenants = ["acme", "bravo", "cosmo", "delta"];
      yield* seed(db, tenants);
      const tenant = tenants.find((name) => db.shardOf(name) === "s0");
      const docs = () => db.forTenant(tenant).documents;
      yield* docs().createCollection({ name: "people" });
      yield* docs().createCollection({
        name: "teams",
        edges: [{ name: "members", path: "members", collection: "people" }],
      });
      for (let i = 0; i < 100; i++) {
        yield* docs().insert({ collection: "people", id: `u${i}`, data: { n: i } });
      }
      yield* docs().insert({ collection: "teams", id: "before", data: { members: ["u1", "u2"] } });

      // Teams written while the move runs reach the target by the catch-up
      // rather than the copy.
      const moving = yield* Effect.forkChild(db.movement.rebalance(allOn("s1", 2)));
      const accepted = [];
      for (let i = 0; i < 100; i++) {
        const outcome = yield* Effect.result(
          docs().insert({ collection: "teams", id: `during${i}`, data: { members: [`u${i}`] } }));
        if (outcome._tag === "Success") accepted.push(i);
      }
      yield* Fiber.join(moving);
      assert.equal(db.shardOf(tenant), "s1");
      assert.ok(accepted.length > 0, "some writes landed during the move");

      const members = (team) => Effect.map(
        docs().findMany({ collection: "people", linked: { collection: "teams", id: team, edge: "members" } }),
        (found) => found.map((doc) => doc.id).sort(),
      );
      assert.deepEqual(yield* members("before"), ["u1", "u2"]);
      for (const i of accepted) {
        assert.deepEqual(yield* members(`during${i}`), [`u${i}`], `team during${i}`);
      }
    }),
  );
});

test("a move keeps identifiers and log positions: cursors, checkpoints and event ids carry on", async (t) => {
  await withDatabase(t, (db, stores) =>
    Effect.gen(function* () {
      const tenants = ["acme", "bravo", "cosmo", "delta"];
      yield* seed(db, tenants);
      const tenant = tenants.find((name) => db.shardOf(name) === "s0");
      const titles = [];
      const register = (api) => api.projections.register({
        name: "titles",
        source: { collections: ["posts"], eventTypes: ["document.upserted"] },
        apply: (event) => Effect.sync(() => titles.push(event.payload.data.title)),
      });

      const before = db.forTenant(tenant);
      yield* register(before);
      yield* before.projections.run("titles");
      const seen = titles.length;
      const read = yield* before.events.read({ limit: 1000 });
      const seq = yield* stores.get("s0").partition(tenant).lookup("doc/posts", "p1");

      yield* db.movement.rebalance(allOn("s1", 2));
      assert.equal(db.shardOf(tenant), "s1");

      const after = db.forTenant(tenant);
      assert.equal(yield* stores.get("s1").partition(tenant).lookup("doc/posts", "p1"), seq,
        "the document has the identifier it had");
      assert.deepEqual((yield* after.events.read({ limit: 1000 })).events.map((event) => event.eventId),
        read.events.map((event) => event.eventId), "and its events the ids they had");

      // A cursor taken on the old shard continues on the new one.
      assert.deepEqual((yield* after.events.read({ after: read.cursor })).events, []);
      yield* after.documents.insert({ collection: "posts", id: "p9", data: { title: "after the move" } });
      assert.deepEqual((yield* after.events.read({ after: read.cursor })).events.map((event) => event.documentId), ["p9"]);

      // So does the projection's checkpoint, which moved with the tenant.
      yield* register(after);
      assert.equal((yield* after.projections.run("titles")).applied, 1);
      assert.deepEqual(titles.slice(seen), ["after the move"]);
    }),
  );
});

test("a tenant can be written while it is being moved", async (t) => {
  await withDatabase(t, (db) =>
    Effect.gen(function* () {
      const tenants = ["acme", "bravo", "cosmo", "delta"];
      yield* seed(db, tenants);
      const tenant = tenants.find((t2) => db.shardOf(t2) === "s0");

      // Enough that the copy is not over before the first concurrent write
      // gets a turn.
      const docs = () => db.forTenant(tenant).documents;
      for (let i = 0; i < 200; i++) {
        yield* docs().insert({ collection: "posts", id: `bulk${i}`, data: { title: `b${i}` } });
      }

      const accepted = [];
      let refused = 0;

      // The move runs while writes keep arriving. Before this change every one
      // of them would have been refused: the fence went on before the copy and
      // stayed on until routing moved.
      const moving = yield* Effect.forkChild(db.movement.rebalance(allOn("s1", 2)));

      for (let i = 0; i < 400; i++) {
        const outcome = yield* Effect.result(
          docs().insert({ collection: "posts", id: `live${i}`, data: { title: `w${i}` } }));
        if (outcome._tag === "Success") accepted.push(`live${i}`);
        else {
          assert.equal(outcome.failure._tag, "TenantMoving");
          refused += 1;
        }
      }

      const result = yield* Fiber.join(moving);
      const move = result.moves.find((m) => m.tenant === tenant);
      assert.ok(move !== undefined, "the tenant moved");

      assert.ok(accepted.length > 0,
        "every write was refused, so the move still takes the tenant offline");

      // The ones that were accepted are on the shard the tenant now lives on —
      // which is the whole claim: writes taken during the copy are not lost
      // behind it.
      const found = yield* docs().findMany({ collection: "posts" });
      const ids = new Set(found.map((doc) => doc.id));
      const missing = accepted.filter((id) => !ids.has(id));
      assert.deepEqual(missing, [],
        `${missing.length} of ${accepted.length} writes accepted during the move were lost`);

      assert.equal(db.shardOf(tenant), "s1");
      assert.ok(move.settled <= move.copied,
        "the fenced part of the move is smaller than the unfenced part");
      t.diagnostic(
        `copied ${move.copied}, caught up ${move.caughtUp} over ${move.rounds} rounds, ` +
        `settled ${move.settled} behind the fence; ${accepted.length} writes accepted, ` +
        `${refused} refused`);
    }),
  );
});

test("a Tenant removed while a read is in flight refuses writes at once, waits for the read, then removes", () =>
  withGatedDatabase((db, stores, gate) => Effect.gen(function* () {
    const tenants = ["acme", "bravo", "cosmo", "delta"];
    yield* seed(db, tenants);
    const tenant = tenants[0];
    const shard = db.shardOf(tenant);
    yield* db.forTenant(tenant).documents.insert({ collection: "posts", id: "blocker", data: { title: "held" } });

    gate.armed = true;
    const reader = yield* Effect.forkChild(db.forTenant(tenant).documents.findById({ collection: "posts", id: "blocker" }));
    yield* Deferred.await(gate.reached);
    const removing = yield* Effect.forkChild(db.dropTenant(tenant));
    yield* Effect.sleep("20 millis");

    assert.equal(removing.pollUnsafe(), undefined, "the removal is waiting for the read");
    assert.equal((yield* Effect.flip(db.forTenant(tenant).documents.insert({ collection: "posts", id: "late", data: { title: "late" } })))._tag, "TenantMoving", "a write is refused from the moment removal began");
    assert.ok((yield* stores.get(shard).partition(tenant).liveRecords).length > 0, "nothing is removed yet");
    assert.ok((yield* snapshot(db, "bravo")).docs.length === 3, "another Tenant is untouched");

    yield* Deferred.succeed(gate.release, undefined);
    assert.equal((yield* Fiber.join(reader))?.data.title, "held", "the read finished on whole data");
    const removed = yield* Fiber.join(removing);
    assert.ok(removed.records > 0 && removed.tenant === tenant);
    assert.ok(!(yield* stores.get(shard).partitions).includes(tenant), "then the partition is gone, fence and all");
    assert.ok(!(yield* db.tenants).includes(tenant));
    // Written to again, it starts from nothing and is not fenced.
    yield* db.forTenant(tenant).documents.createCollection({ name: "posts" });
    assert.equal((yield* db.forTenant(tenant).documents.insert({ collection: "posts", id: "p1", data: { title: "fresh" } })).version, 1);
  })));

test("a removal whose Tenant is still in use past the deadline leaves it fenced and whole, and repeating it removes it", () =>
  withGatedDatabase((db, stores, gate) => Effect.gen(function* () {
    const tenants = ["acme", "bravo", "cosmo", "delta"];
    yield* seed(db, tenants);
    const tenant = tenants[0];
    const shard = db.shardOf(tenant);
    yield* db.forTenant(tenant).documents.insert({ collection: "posts", id: "blocker", data: { title: "held" } });

    gate.armed = true;
    const reader = yield* Effect.forkChild(db.forTenant(tenant).documents.findById({ collection: "posts", id: "blocker" }));
    yield* Deferred.await(gate.reached);
    const stopped = yield* Effect.flip(db.dropTenant(tenant));
    assert.equal(stopped._tag, "PlacementInUse");
    assert.equal(stopped.calls, 1);
    assert.ok((yield* stores.get(shard).partition(tenant).liveRecords).length > 0, "nothing was removed");
    assert.equal((yield* Effect.flip(db.forTenant(tenant).documents.insert({ collection: "posts", id: "late", data: { title: "late" } })))._tag, "TenantMoving", "it stays fenced");

    yield* Deferred.succeed(gate.release, undefined);
    assert.equal((yield* Fiber.join(reader))?.data.title, "held");
    const removed = yield* db.dropTenant(tenant);
    assert.ok(removed.records > 0);
    assert.ok(!(yield* db.tenants).includes(tenant));
  }), { drainTimeout: "30 millis" }));
