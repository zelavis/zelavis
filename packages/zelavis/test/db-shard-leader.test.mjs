import assert from "node:assert/strict";
import test from "node:test";
import { Clock, Deferred, Effect, Stream, SubscriptionRef } from "effect";
import { followPartitions, GLOBAL_TENANT, makeDatabase, mapWithRanges, openShardOverKv, partitionMapFor, virtualRangeFor } from "../dist/db/index.js";
import { replicaSide } from "../dist/db/shard-replicas.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";

const run = (effect) => Effect.runPromise(Effect.scoped(effect));
const waitFor = (check, matches) => Effect.gen(function* () {
  for (;;) {
    const value = yield* check;
    if (matches(value)) return value;
    yield* Effect.sleep("5 millis");
  }
}).pipe(Effect.timeout("10 seconds"));

const insert = (db, tenant, id) => db.forTenant(tenant).documents.insert({ collection: "notes", id, data: { tenant, id } });

const setup = Effect.gen(function* () {
  const stores = new Map();
  const base = partitionMapFor(["s0", "s1"]);
  // Put the reserved App partition's virtual range on s1 too so the filter is what keeps it out.
  const partitionMap = mapWithRanges(base, [virtualRangeFor(base, GLOBAL_TENANT)], "s1");
  const db = yield* makeDatabase({
    partitionMap,
    openShard: (shard) => openShardOverKv(shard, memoryKvEngine()).pipe(Effect.tap((store) => Effect.sync(() => stores.set(shard, store)))),
  });
  const candidates = Array.from({ length: 32 }, (_, index) => `tenant-${index}`);
  const left = candidates.find((tenant) => db.shardOf(tenant) === "s0");
  const right = candidates.find((tenant) => db.shardOf(tenant) === "s1");
  assert.equal(db.shardOf("service:x"), "s1");
  for (const tenant of [left, right, "service:x"]) {
    yield* db.forTenant(tenant).documents.createCollection({ name: "notes" });
    yield* insert(db, tenant, "initial");
  }
  yield* db.topology.placement.declare("plans", "replicated");
  yield* db.global.documents.createCollection({ name: "plans" });
  yield* db.global.documents.insert({ collection: "plans", id: "pro", data: { seats: 25 } });
  yield* db.replication.refresh;
  const primary = stores.get("s1");
  assert.ok((yield* primary.partition(GLOBAL_TENANT).stats).records > 0);
  const target = yield* openShardOverKv("s1.replica", memoryKvEngine());
  const side = yield* replicaSide(target);
  const leader = db.shardLeaderFor("s1");
  return { db, left, right, primary, target, side, leader };
});

const follow = ({ target, side, leader }) => Effect.gen(function* () {
  const turn = yield* SubscriptionRef.make(undefined);
  yield* Effect.forkScoped(followPartitions(leader, side, {
    timeoutMillis: 50,
    turns: (value) => SubscriptionRef.set(turn, value),
  }));
  const initial = yield* waitFor(SubscriptionRef.get(turn), (value) => value?.level && value.resynced);
  return { target, turn, initial };
});

const contents = (store, partition) => Effect.gen(function* () {
  const source = store.partition(partition);
  return { head: (yield* source.stats).head, records: yield* source.scanRecords({ limit: 100 }) };
});

test("following a shard copies its Tenants and nothing else", () => run(Effect.gen(function* () {
  const fixture = yield* setup;
  const { right, primary, target, leader } = fixture;
  yield* follow(fixture);
  const expected = [right, "service:x"].sort();
  assert.deepEqual((yield* target.partitions).sort(), expected);
  for (const partition of expected) {
    assert.deepEqual(yield* contents(target, partition), yield* contents(primary, partition));
  }
  assert.equal((yield* target.partition(GLOBAL_TENANT).stats).incarnation, undefined);
  // A raw page of only reserved entries still offers a continuation.
  const page = yield* leader.partitions({ after: right, limit: 1 });
  assert.deepEqual(page, { partitions: [], next: GLOBAL_TENANT });
})));

test("a write on the shard reaches the copy, a write elsewhere does not", () => run(Effect.gen(function* () {
  const fixture = yield* setup;
  const { db, left, right, primary, target } = fixture;
  yield* follow(fixture);
  const before = (yield* target.partition(right).stats).head;
  yield* insert(db, left, "elsewhere");
  yield* insert(db, right, "on-shard");
  yield* waitFor(target.partition(right).stats, ({ head }) => head > before);
  assert.deepEqual(yield* contents(target, right), yield* contents(primary, right));
  assert.equal((yield* target.partition(left).stats).incarnation, undefined);
})));

test("a Tenant moved off the shard is dropped from the copy; one moved on is copied", () => run(Effect.gen(function* () {
  const fixture = yield* setup;
  const { db, left, right, primary, target } = fixture;
  yield* follow(fixture);
  const current = db.topology.current();
  const away = mapWithRanges(current, [virtualRangeFor(current, right)], "s0");
  const next = mapWithRanges(away, [virtualRangeFor(current, left)], "s1");
  yield* db.movement.rebalance(next);
  const expected = [left, "service:x"].sort();
  yield* waitFor(target.partitions, (partitions) => partitions.length === expected.length && expected.every((p) => partitions.includes(p)));
  assert.deepEqual(yield* contents(target, left), yield* contents(primary, left));
  assert.equal((yield* target.partition(right).stats).incarnation, undefined);
})));

test("turns report when the copy is level", () => run(Effect.gen(function* () {
  const { db, right, primary, target, side, leader } = yield* setup;
  const waiting = yield* Deferred.make();
  const copied = yield* Deferred.make();
  const recording = {
    ...leader,
    feed: (request) => request.cursor === undefined ? leader.feed(request)
      : Effect.andThen(Deferred.succeed(waiting, undefined), leader.feed(request)),
  };
  const head = (yield* primary.partition(right).stats).head;
  yield* Effect.forkScoped(followPartitions(recording, side, {
    timeoutMillis: 1000,
    turns: (turn) => Effect.gen(function* () {
      if (!turn.resynced && turn.level && (yield* target.partition(right).stats.pipe(Effect.orDie)).head > head) {
        yield* Deferred.succeed(copied, turn);
      }
    }),
  }));
  yield* Deferred.await(waiting).pipe(Effect.timeout("5 seconds"));
  assert.equal((yield* target.partition(right).stats).head, head);
  yield* insert(db, right, "steady");
  const afterLastWrite = yield* Clock.currentTimeMillis;
  const turn = yield* Deferred.await(copied).pipe(Effect.timeout("5 seconds"));
  assert.ok(turn.asked <= afterLastWrite);
})));

test("listing an unopened shard fails with a typed error, then following retries the listing", () => run(Effect.gen(function* () {
  const { db, target, side } = yield* setup;
  const leader = db.shardLeaderFor("s2");
  const failure = yield* Effect.flip(leader.partitions({ limit: 10 }));
  assert.equal(failure._tag, "StoreError");
  assert.equal(failure.op, "shard-leader.partitions");
  const attempted = yield* SubscriptionRef.make(false);
  const blocked = {
    ...leader,
    partitions: (request) => Effect.tapError(leader.partitions(request), () => SubscriptionRef.set(attempted, true)),
  };
  const synced = yield* SubscriptionRef.make(false);
  yield* Effect.forkScoped(followPartitions(blocked, side, {
    timeoutMillis: 50,
    turns: ({ level, resynced }) => SubscriptionRef.set(synced, level && resynced),
  }));
  yield* waitFor(SubscriptionRef.get(attempted), Boolean);
  assert.equal(yield* SubscriptionRef.get(synced), false);
  yield* db.shards.open("s2");
  yield* waitFor(SubscriptionRef.get(synced), Boolean);
  assert.deepEqual(yield* target.partitions, []);
})));

test("a partial feed page or capped partition pass cannot report a level turn", () => run(Effect.gen(function* () {
  // A synthetic log makes the real follower exercise its 64 batches of 512 without writing 32,768 fixture records.
  const end = 64 * 512 + 2;
  let leaderHead = 1;
  let copyHead = 1;
  const partition = "p";
  const stats = (head) => ({ head, compactedTo: 0, incarnation: partition });
  const source = {
    stats: Effect.sync(() => stats(leaderHead)),
    events: { read: ({ from, after, limit }) => {
      const start = from ?? (after + 1);
      return Stream.fromIterable(Array.from({ length: Math.min(limit, leaderHead - start + 1) }, (_, index) => start + index));
    } },
  };
  const store = {
    stats: Effect.sync(() => stats(copyHead)),
    events: {
      head: Effect.sync(() => copyHead),
      followAll: (positions) => Effect.sync(() => { copyHead = positions.at(-1); }),
    },
  };
  const side = {
    routed: () => store,
    shardFor: () => ({ partition: () => store }),
    partitionsPage: () => Effect.succeed({ partitions: [partition] }),
    changed: () => Effect.void,
    remove: () => Effect.die(new Error("the partition stays on the leader")),
    writes: yield* SubscriptionRef.make(0),
    declare: () => Effect.void,
  };
  const answer = (cursor, partitions, more = false, resync = false) => ({ cursor, partitions, more, resync, declarations: 0 });
  const leader = {
    declarations: Effect.succeed({ placements: { version: 0 }, subdivisions: { version: 0 } }),
    source: () => Effect.succeed(source),
    partitions: () => Effect.sync(() => ({ partitions: [{ partition, head: leaderHead }] })),
    feed: ({ cursor }) => Effect.suspend(() => {
      switch (cursor) {
        case undefined: return Effect.succeed(answer("initial", [], false, true));
        case "initial":
          leaderHead = end;
          return Effect.succeed(answer("first-page", [], true));
        case "first-page": return Effect.succeed(answer("burst", [partition]));
        case "burst": return Effect.succeed(answer("quiet", []));
        default: return Effect.never;
      }
    }),
  };
  const observed = [];
  const reported = yield* Deferred.make();
  yield* Effect.forkScoped(followPartitions(leader, side, {
    turns: (turn) => Effect.gen(function* () {
      observed.push([turn.level, copyHead]);
      if (observed.length === 4) yield* Deferred.succeed(reported, undefined);
    }),
  }));
  yield* Deferred.await(reported).pipe(Effect.timeout("5 seconds"));
  assert.deepEqual(observed, [[true, 1], [false, 1], [false, 64 * 512], [true, end]]);
})));
