// A hold on a partition's log: a reader that copies records and then follows the log is not cut off by
// a compaction pass it never saw. These tests hold `compact` to the lowest live hold, a hold to its
// time and its bounds, and a branch whose source is compacted while it is copied to coming out whole.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Cause, Deferred, Effect, Exit, Fiber, Stream } from "effect";
import { makeDatabase, partitionMapFor, shardFor } from "../dist/db/index.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { makeNodeSqliteEngine } from "../dist/db/engines/node-sqlite.js";
import { openShardOverKv } from "../dist/db/kv-store.js";
import { StoreError } from "../dist/db/errors.js";

const map = partitionMapFor(["s0", "s1"]);

/** A database over memory engines, with each shard's store at hand and an optional engine in front. */
const withDatabase = (body, { wrap, drainTimeout } = {}) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const shards = new Map();
    const db = yield* makeDatabase({
      partitionMap: map,
      crossTenantRefresh: false,
      ...(drainTimeout === undefined ? {} : { drainTimeout }),
      openShard: (shard) => {
        const engine = memoryKvEngine();
        return Effect.tap(openShardOverKv(shard, wrap === undefined ? engine : wrap(shard, engine)), (store) =>
          Effect.sync(() => shards.set(shard, store)));
      },
    });
    return yield* body(db, shards);
  })));

/** The same over SQLite files in `dir`, so a second open finds what the first left. */
const onDisk = (dir, body, { wrap } = {}) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const shards = new Map();
    const db = yield* makeDatabase({
      partitionMap: map,
      crossTenantRefresh: false,
      openShard: (shard) => Effect.flatMap(makeNodeSqliteEngine(shard, dir), (engine) =>
        Effect.tap(openShardOverKv(shard, wrap === undefined ? engine : wrap(shard, engine)), (store) =>
          Effect.sync(() => shards.set(shard, store)))),
    });
    return yield* body(db, shards);
  })));


const msg = (exit) => (Exit.isFailure(exit) ? `${Cause.squash(exit.cause)._tag} ${JSON.stringify(Cause.squash(exit.cause))}` : "ok");

const seedPosts = (tenant, ids) => Effect.gen(function* () {
  yield* tenant.documents.createCollection({ name: "posts", columns: ["title", "rank"] });
  for (const [at, id] of ids.entries()) yield* tenant.documents.insert({ collection: "posts", id, data: { title: id, rank: at } });
});
const posts = (tenant) => Effect.map(tenant.documents.findMany({ collection: "posts" }), (docs) =>
  Object.fromEntries(docs.map((doc) => [doc.id, `${doc.data.title}@${doc.version}`]).sort(([a], [b]) => (a < b ? -1 : 1))));

const names = Array.from({ length: 64 }, (_, at) => `t${at}`);
const first = names[0];
const other = names.find((name) => shardFor(map, name) !== shardFor(map, first));

test("compact goes as far as the lowest live hold and says where it was held", () =>
  withDatabase((db, shards) => Effect.gen(function* () {
    const tenant = db.forTenant(first);
    yield* seedPosts(tenant, ["p1", "p2", "p3"]);
    const store = shards.get(db.shardOf(first)).partition(first);
    const head = (yield* store.stats).head;
    assert.ok(head >= 4);
    assert.deepEqual(yield* store.holdLog({ id: "reader", position: 2, ttlMillis: 60_000 }), { position: 2 });
    assert.deepEqual(yield* store.compact({ keep: 0 }), { removed: 2, compactedTo: 2, heldAt: 2 });
    assert.deepEqual(yield* store.compact({ keep: 0 }), { removed: 0, compactedTo: 2, heldAt: 2 }, "nothing more while held");
    yield* store.releaseLog("reader");
    const freed = yield* store.compact({ keep: 0 });
    assert.equal(freed.compactedTo, head);
    assert.equal(freed.heldAt, undefined);
  })));

test("a hold is only raised, refused below the compaction point, bounded, and ends with its time", () =>
  withDatabase((db, shards) => Effect.gen(function* () {
    const tenant = db.forTenant(first);
    yield* seedPosts(tenant, ["p1", "p2", "p3"]);
    const store = shards.get(db.shardOf(first)).partition(first);
    yield* store.holdLog({ id: "a", position: 3, ttlMillis: 60_000 });
    assert.deepEqual(yield* store.holdLog({ id: "a", position: 1, ttlMillis: 60_000 }), { position: 3 }, "asking lower keeps the higher");
    assert.deepEqual(yield* store.holdLog({ id: "a", position: 4, ttlMillis: 60_000 }), { position: 4 });

    for (const bad of [{ id: "", position: 1, ttlMillis: 10 }, { id: "x", position: -1, ttlMillis: 10 }, { id: "x", position: 1, ttlMillis: 0 }, { id: "x", position: 1, ttlMillis: 11 * 60_000 }]) {
      assert.match(msg(yield* Effect.exit(store.holdLog(bad))), /StoreError/);
    }
    for (let at = 0; at < 63; at++) yield* store.holdLog({ id: `fill${at}`, position: 4, ttlMillis: 60_000 });
    assert.match(msg(yield* Effect.exit(store.holdLog({ id: "one-too-many", position: 4, ttlMillis: 60_000 }))), /64 holds/);
    for (let at = 0; at < 63; at++) yield* store.releaseLog(`fill${at}`);
    yield* store.releaseLog("a");

    yield* store.holdLog({ id: "short", position: 2, ttlMillis: 5 });
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
    const compacted = yield* store.compact({ keep: 0 });
    assert.ok(compacted.compactedTo > 2 && compacted.heldAt === undefined, "an expired hold keeps nothing");
    assert.match(msg(yield* Effect.exit(store.holdLog({ id: "late", position: 1, ttlMillis: 1000 }))), /LogCompacted/);
  })));

test("a source compacted while it is branched is held where it was, and the branch comes out whole", () => {
  const gate = { started: Effect.runSync(Deferred.make()), go: Effect.runSync(Deferred.make()), fired: false };
  const target = shardFor(map, other);
  return withDatabase((db, shards) => Effect.gen(function* () {
    const source = db.forTenant(first);
    yield* seedPosts(source, ["p1", "p2", "p3"]);
    yield* source.documents.update({ collection: "posts", id: "p1", data: { title: "again", rank: 0 } });
    const store = shards.get(db.shardOf(first)).partition(first);
    const before = yield* posts(source);

    const branching = yield* Effect.forkChild(db.branchTenant(first, other));
    yield* Deferred.await(gate.started);
    // The records are copied and the branch's first batch is waiting: compaction would cut everything.
    yield* source.documents.insert({ collection: "posts", id: "p4", data: { title: "p4", rank: 3 } });
    const rows = yield* db.maintenance.compact({ keep: 0 });
    const row = rows.find((entry) => entry.partition === first);
    assert.equal(row?.compactedTo, 0, "the log was not cut past the branch's hold");
    assert.equal(row?.heldAt, 0);
    assert.equal(yield* store.compactedTo, 0);

    yield* Deferred.succeed(gate.go, undefined);
    yield* Fiber.join(branching);
    assert.deepEqual(yield* posts(db.forTenant(other)), before, "the branch is the source as of its branch point");
    const freed = yield* store.compact({ keep: 0 });
    assert.ok(freed.compactedTo > 0 && freed.heldAt === undefined, "the hold ended with the branch");
  }), {
    wrap: (shard, engine) => ({
      ...engine,
      conditionalWrite: (writes, conditions) =>
        shard === target && !gate.fired && writes.some((write) => Buffer.from(write.key).includes(other))
          ? Effect.flatMap(Effect.sync(() => { gate.fired = true; }), () =>
              Effect.flatMap(Deferred.succeed(gate.started, undefined), () =>
                Effect.flatMap(Deferred.await(gate.go), () => engine.conditionalWrite(writes, conditions))))
          : engine.conditionalWrite(writes, conditions),
    }),
  });
});
