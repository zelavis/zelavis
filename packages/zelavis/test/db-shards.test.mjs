import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Exit, Fiber, Scope } from "effect";
import { makeDatabase, mapWithRanges, partitionMapFor, shardFor, shardsOf } from "../dist/db/index.js";
import { openShardOverKv } from "../dist/db/kv-store.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { StoreError } from "../dist/db/errors.js";
import { TOPOLOGY_SHARD } from "../dist/db/index.js";

const TENANTS = ["acme", "bravo", "cosmo", "delta", "echo", "foxtrot"];

const engines = () => {
  const held = new Map();
  return (shard, { origin }) => {
    if (!held.has(shard)) held.set(shard, memoryKvEngine());
    return openShardOverKv(shard, held.get(shard), { origin });
  };
};

const run = (body, options = {}) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const db = yield* makeDatabase({
      partitionMap: partitionMapFor(["s0", "s1"]),
      openShard: engines(),
      ...options,
    });
    return yield* body(db);
  })));

const seed = (db) =>
  Effect.gen(function* () {
    for (const tenant of TENANTS) {
      const docs = db.forTenant(tenant).documents;
      yield* docs.createCollection({ name: "posts" });
      yield* docs.insert({ collection: "posts", id: "p1", data: { title: tenant } });
    }
  });

const titles = (db) =>
  Effect.gen(function* () {
    const out = [];
    for (const tenant of TENANTS) {
      const found = yield* db.forTenant(tenant).documents.findMany({ collection: "posts" });
      out.push(found.map((d) => d.data.title).join(","));
    }
    return out;
  });

const allOn = (shard, version) => ({ version, virtualRanges: 256, placements: [{ from: 0, to: 256, shard }] });

test("mapWithRanges splits, merges and bumps the version", () => {
  const map = { version: 4, virtualRanges: 256, placements: [{ from: 0, to: 256, shard: "s0" }] };
  const next = mapWithRanges(map, [3, 4, 5, 9], "sX");
  assert.equal(next.version, 5);
  assert.deepEqual(next.placements, [
    { from: 0, to: 3, shard: "s0" }, { from: 3, to: 6, shard: "sX" },
    { from: 6, to: 9, shard: "s0" }, { from: 9, to: 10, shard: "sX" },
    { from: 10, to: 256, shard: "s0" },
  ]);
  const again = mapWithRanges(next, [3, 4, 5, 9], "sX");
  assert.deepEqual(again.placements, next.placements);
  assert.equal(again.version, 6);
  for (const tenant of TENANTS) assert.ok(typeof shardFor(next, tenant) === "string");
  assert.throws(() => mapWithRanges(map, [256], "sX"), RangeError);
});

test("a shard opens at runtime, takes ranges, and closes only once nothing names it", async () => {
  await run((db) =>
    Effect.gen(function* () {
      yield* seed(db);
      const before = yield* titles(db);
      yield* db.shards.open("s2");
      assert.deepEqual(yield* db.shards.list, ["s0", "s1", "s2"]);
      yield* db.movement.rebalance(allOn("s2", 2));
      assert.deepEqual(yield* titles(db), before);
      const refused = yield* Effect.flip(db.shards.close("s2"));
      assert.equal(refused._tag, "ShardInUse");
      yield* db.movement.rebalance(allOn("s0", 3));
      assert.deepEqual(yield* titles(db), before);
      yield* db.shards.close("s2");
      assert.deepEqual(yield* db.shards.list, ["s0", "s1"]);
      // A shard the map still names is not closable, however it was opened.
      const fixed = yield* Effect.flip(db.shards.close("s0"));
      assert.equal(fixed._tag, "ShardInUse");
    }));
});

test("a failing beforeRouting leaves routing and the moves; resume finishes", async () => {
  await run((db) =>
    Effect.gen(function* () {
      yield* seed(db);
      const before = yield* titles(db);
      yield* db.shards.open("s2");
      const version = db.topology.current().version;
      const failed = yield* Effect.flip(db.movement.rebalance(allOn("s2", version + 1), {
        beforeRouting: Effect.fail(new StoreError({ op: "test", cause: "not yet" })),
      }));
      assert.equal(failed._tag, "StoreError");
      assert.equal(db.topology.current().version, version);
      assert.ok((yield* db.movement.pending).length > 0);
      yield* db.movement.resume;
      assert.equal((yield* db.movement.pending).length, 0);
      assert.deepEqual(shardsOf(db.topology.current()), ["s2"]);
      assert.deepEqual(yield* titles(db), before);
    }));
});

test("abandon returns the source to service and drops the copy", async () => {
  await run((db) =>
    Effect.gen(function* () {
      yield* seed(db);
      const before = yield* titles(db);
      yield* db.shards.open("s2");
      const version = db.topology.current().version;
      yield* Effect.flip(db.movement.rebalance(allOn("s2", version + 1), {
        beforeRouting: Effect.fail(new StoreError({ op: "test", cause: "no" })),
      }));
      const undone = yield* db.movement.abandon("s2");
      assert.ok(undone.length > 0);
      assert.equal((yield* db.movement.pending).length, 0);
      assert.equal(db.topology.current().version, version);
      assert.deepEqual(yield* titles(db), before);
      for (const tenant of TENANTS) {
        yield* db.forTenant(tenant).documents.insert({ collection: "posts", id: "p2", data: { title: "again" } });
      }
      assert.deepEqual(yield* db.shards.list, ["s0", "s1", "s2"]);
      yield* db.shards.close("s2");
    }));
});

test("an interrupted abandon is finished when the database opens", async () => {
  const open = engines();
  const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const db = yield* makeDatabase({ partitionMap: partitionMapFor(["s0", "s1"]), openShard: open });
    yield* seed(db);
    yield* db.shards.open("s2");
    yield* Effect.flip(db.movement.rebalance(allOn("s2", 2), {
      beforeRouting: Effect.fail(new StoreError({ op: "test", cause: "no" })),
    }));
    return Exit.void;
  })));
  void outcome;
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const db = yield* makeDatabase({ partitionMap: partitionMapFor(["s0", "s1"]), openShard: open });
    assert.ok((yield* db.movement.pending).length > 0);
    yield* db.movement.abandon("s2");
    assert.equal((yield* db.movement.pending).length, 0);
    assert.deepEqual(yield* titles(db), TENANTS);
  })));
});

test("an abandon cut off after it recorded abandoning is finished by a resume", async () => {
  const held = new Map();
  let armed = false;
  let blocked;
  const reached = new Promise((resolve) => { blocked = resolve; });
  const decoder = new TextDecoder();
  const openShard = (shard, { origin }) => {
    if (!held.has(shard)) held.set(shard, memoryKvEngine());
    const engine = held.get(shard);
    const wrapped = shard !== TOPOLOGY_SHARD ? engine : {
      ...engine,
      conditionalWrite: (writes, conditions) => Effect.tap(engine.conditionalWrite(writes, conditions), () => {
        const seen = armed && writes.some((write) => write.op === "put" && decoder.decode(write.value).includes('"phase":"abandoning"'));
        if (!seen) return Effect.void;
        armed = false;
        blocked();
        return Effect.never;
      }),
    };
    return openShardOverKv(shard, wrapped, { origin });
  };
  const open = (scope) => Effect.runPromise(makeDatabase({ partitionMap: partitionMapFor(["s0", "s1"]), openShard }).pipe(Scope.provide(scope)));
  let scope = await Effect.runPromise(Scope.make());
  let db = await open(scope);
  await Effect.runPromise(seed(db));
  await Effect.runPromise(db.shards.open("s2"));
  await Effect.runPromise(Effect.flip(db.movement.rebalance(allOn("s2", 2), {
    beforeRouting: Effect.fail(new StoreError({ op: "test", cause: "no" })),
  })));
  armed = true;
  const fiber = Effect.runFork(db.movement.abandon("s2"));
  await reached;
  await Effect.runPromise(Scope.close(scope, Exit.void));
  await Effect.runPromise(Fiber.interrupt(fiber));

  scope = await Effect.runPromise(Scope.make());
  db = await open(scope);
  const pending = await Effect.runPromise(db.movement.pending);
  assert.ok(pending.some((move) => move.phase === "abandoning"), "the cut-off undo is on record");
  await Effect.runPromise(db.movement.resume);
  assert.equal((await Effect.runPromise(db.movement.pending)).length, 0);
  assert.deepEqual(await Effect.runPromise(titles(db)), TENANTS);
  for (const tenant of TENANTS) {
    await Effect.runPromise(db.forTenant(tenant).documents.insert({ collection: "posts", id: "p9", data: { title: "later" } }));
  }
  await Effect.runPromise(Scope.close(scope, Exit.void));
});
