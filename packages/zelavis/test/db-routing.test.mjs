// A tenant's store goes, call by call, to where routing places the tenant as
// the call starts, and holds a lease on that placement until the call is done.
// That is what lets a move clear the shard it routed a tenant off — fence and
// all — once nothing that reached it before routing moved is still running.
import assert from "node:assert/strict";
import test from "node:test";
import { Deferred, Effect, Fiber, Option, Stream } from "effect";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { openShardOverKv } from "../dist/db/kv-store.js";
import { partitionRouter } from "../dist/db/routing.js";

const enc = new TextEncoder();
const run = (body) => Effect.runPromise(Effect.scoped(body));
const manifest = { terms: [], columns: [], measures: [], edges: [] };

/** Two shards and a routing answer the test can change. */
const setup = Effect.gen(function* () {
  const shards = new Map([
    ["s0", yield* openShardOverKv("s0", memoryKvEngine())],
    ["s1", yield* openShardOverKv("s1", memoryKvEngine())],
  ]);
  const placement = { acme: "s0" };
  const router = partitionRouter({ shardOf: (partition) => placement[partition] ?? "s0", shards });
  return { shards, placement, router };
});

const put = (store, seq, body) =>
  store.transact((txn) => txn.put(seq, enc.encode(body), manifest, { namespace: "doc/x", key: `k${seq}` }));
const body = (store, seq) => Effect.map(store.read(seq), (found) => found && new TextDecoder().decode(found.bytes));

test("every call goes to where the partition is routed when it starts, so a store is never bound to a shard", () => run(Effect.gen(function* () {
  const { shards, placement, router } = yield* setup;
  const acme = router.routed("acme");
  yield* put(acme, 1, "on s0");
  placement.acme = "s1";
  yield* put(acme, 1, "on s1");
  assert.equal(yield* body(acme, 1), "on s1");
  assert.equal(yield* body(shards.get("s0").partition("acme"), 1), "on s0", "the earlier call went to s0");
  assert.equal(acme.generation, shards.get("s1").generation);
})));

test("a call in flight holds its placement: draining waits for it, or reports it past the deadline", () => run(Effect.gen(function* () {
  const { router, placement } = yield* setup;
  const acme = router.routed("acme");
  const entered = Deferred.makeUnsafe();
  const release = Deferred.makeUnsafe();
  const call = yield* Effect.forkChild(acme.transact((txn) => Effect.gen(function* () {
    yield* Deferred.succeed(entered, undefined);
    yield* Deferred.await(release);
    return yield* txn.put(1, enc.encode("late"), manifest, { namespace: "doc/x", key: "k1" });
  })));
  yield* Deferred.await(entered);

  // Routing moves while the call runs; it still holds s0.
  placement.acme = "s1";
  const refused = yield* Effect.flip(router.drained("s0", "acme", "20 millis"));
  assert.equal(refused._tag, "PlacementInUse");
  assert.deepEqual([refused.shard, refused.partition, refused.calls], ["s0", "acme", 1]);

  const waiting = yield* Effect.forkChild(router.drained("s0", "acme", "5 seconds"));
  yield* Effect.sleep("10 millis");
  assert.equal(waiting.pollUnsafe(), undefined, "still waiting while the call runs");
  yield* Deferred.succeed(release, undefined);
  yield* Fiber.join(call);
  yield* Fiber.join(waiting);
  yield* router.drained("s0", "acme", "1 millis");
  yield* router.drained("s1", "acme", "1 millis");
})));

test("a stream holds its placement until it ends", () => run(Effect.gen(function* () {
  const { router, placement } = yield* setup;
  const acme = router.routed("acme");
  for (let seq = 1; seq <= 3; seq++) yield* put(acme, seq, `r${seq}`);
  const pulled = Deferred.makeUnsafe();
  const release = Deferred.makeUnsafe();
  const reading = yield* Effect.forkChild(Stream.runForEach(acme.records, ({ seq }) =>
    Number(seq) === 1 ? Effect.andThen(Deferred.succeed(pulled, undefined), Deferred.await(release)) : Effect.void));
  yield* Deferred.await(pulled);
  placement.acme = "s1";
  assert.equal((yield* Effect.flip(router.drained("s0", "acme", "20 millis")))._tag, "PlacementInUse");
  yield* Deferred.succeed(release, undefined);
  yield* Fiber.join(reading);
  yield* router.drained("s0", "acme", "1 millis");
})));

test("upkeep visits a partition only where routing places it, under a lease", () => run(Effect.gen(function* () {
  const { router, placement } = yield* setup;
  assert.deepEqual(yield* router.placed("s0", "acme", (store) => Effect.succeed(store.partition)), Option.some("acme"));
  placement.acme = "s1";
  assert.deepEqual(yield* router.placed("s0", "acme", () => Effect.die("must not run")), Option.none());

  const entered = Deferred.makeUnsafe();
  const release = Deferred.makeUnsafe();
  const upkeep = yield* Effect.forkChild(router.placed("s1", "acme", () =>
    Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(release))));
  yield* Deferred.await(entered);
  placement.acme = "s0";
  assert.equal((yield* Effect.flip(router.drained("s1", "acme", "20 millis")))._tag, "PlacementInUse");
  yield* Deferred.succeed(release, undefined);
  yield* Fiber.join(upkeep);
  yield* router.drained("s1", "acme", "1 millis");
})));

test("an operation runs against one placement, under one lease, however routing changes while it runs", () => run(Effect.gen(function* () {
  const { shards, placement, router } = yield* setup;
  const store = router.routed("acme");
  const moved = Deferred.makeUnsafe();
  const resume = Deferred.makeUnsafe();
  const api = router.operations({
    // Takes something in one call and relies on it in the next — the way an
    // insert takes an identifier and then writes it.
    twoSteps: Effect.gen(function* () {
      yield* put(store, 1, "first");
      yield* Deferred.succeed(moved, undefined);
      yield* Deferred.await(resume);
      yield* put(store, 2, "second");
    }),
    // Run from inside another operation, it joins that one's placement.
    nested: (inner) => inner,
    sync: () => [1, 2, 3],
    handle: () => ({ read: (seq) => body(store, seq) }),
  }, "acme");

  const running = yield* Effect.forkChild(api.nested(api.twoSteps));
  yield* Deferred.await(moved);
  placement.acme = "s1";
  const busy = yield* Effect.flip(router.drained("s0", "acme", "20 millis"));
  assert.equal(busy.calls, 1, "one lease for the whole operation, nested one included");
  yield* Deferred.succeed(resume, undefined);
  yield* Fiber.join(running);

  const s0 = shards.get("s0").partition("acme");
  assert.deepEqual([yield* body(s0, 1), yield* body(s0, 2)], ["first", "second"], "both steps on the placement it started on");
  assert.equal(yield* body(shards.get("s1").partition("acme"), 2), undefined);
  yield* router.drained("s0", "acme", "1 millis");

  // Plain values pass through; objects a function hands back are operations too.
  assert.deepEqual(api.sync(), [1, 2, 3]);
  yield* put(store, 2, "on s1");
  assert.equal(yield* api.handle().read(2), "on s1", "a new operation routes afresh");
})));
