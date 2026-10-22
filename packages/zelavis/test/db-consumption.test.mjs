// Consuming the log: time series and projections, cut off at every commit.
//
// A time series writes into the partition whose log it reads, so each batch of
// points commits with the cursor it reached and a run cut off anywhere is
// finished exactly by the next. A projection's `apply` writes wherever it
// likes, so it is applied at least once; what these pin for it is that a
// rebuild cut off never leaves a checkpoint claiming discarded state.
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { makeDatabase, partitionMapFor } from "../dist/db/index.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { openShardOverKv } from "../dist/db/kv-store.js";
import { StoreError } from "../dist/db/errors.js";

const run = (body) => Effect.runPromise(Effect.scoped(body));

/** A database whose engine refuses its `failAt`-th commit once armed, as a crash there would. */
const withDatabase = (body) => {
  const base = memoryKvEngine();
  const faults = { armed: false, commits: 0, failAt: 0 };
  const engine = {
    ...base,
    conditionalWrite: (writes, conditions) =>
      faults.armed && ++faults.commits === faults.failAt
        ? Effect.fail(new StoreError({ op: "test.commit", cause: "cut off" }))
        : base.conditionalWrite(writes, conditions),
  };
  const stores = new Map();
  return run(Effect.gen(function* () {
    const db = yield* makeDatabase({
      partitionMap: partitionMapFor(["s0"]),
      openShard: (shard) => Effect.tap(openShardOverKv(shard, engine), (store) => Effect.sync(() => stores.set(shard, store))),
    });
    const cutAt = (failAt, effect) => Effect.gen(function* () {
      faults.armed = true;
      faults.commits = 0;
      faults.failAt = failAt;
      const exit = yield* Effect.exit(effect);
      faults.armed = false;
      return { exit, reached: faults.commits >= failAt };
    });
    return yield* body({ db, tenant: db.forTenant("acme"), partition: () => stores.get("s0").partition("acme"), cutAt });
  }));
};

const EVENTS = 5;
/** Enough points per event that one ingest is more than one batch. */
const PER_EVENT = 300;

const seedSeries = (tenant) => Effect.gen(function* () {
  yield* tenant.documents.createCollection({ name: "posts" });
  for (let i = 0; i < EVENTS; i++) yield* tenant.documents.insert({ collection: "posts", id: `p${i}`, data: { n: i } });
  yield* tenant.timeSeries.define({
    name: "views",
    source: { collections: ["posts"], eventTypes: ["document.upserted"] },
    map: (event) => Array.from({ length: PER_EVENT }, (_, i) => ({ timestamp: Date.parse(event.timestamp) + i, value: 1 })),
  });
});

/** The definition `seedSeries` gives, restored after a test swaps in a broken one. */
seedSeries.redefine = (tenant) => tenant.timeSeries.define({
  name: "views",
  source: { collections: ["posts"], eventTypes: ["document.upserted"] },
  map: (event) => Array.from({ length: PER_EVENT }, (_, i) => ({ timestamp: Date.parse(event.timestamp) + i, value: 1 })),
});

const stored = (tenant) => Effect.map(tenant.timeSeries.get("views").range({}), (points) => points.length);

test("an ingest cut off at any commit, then run again, stores every point exactly once", async () => {
  for (let failAt = 1; ; failAt++) {
    const reached = await withDatabase(({ tenant, cutAt }) => Effect.gen(function* () {
      yield* seedSeries(tenant);
      const { reached } = yield* cutAt(failAt, tenant.timeSeries.ingest("views"));
      yield* tenant.timeSeries.ingest("views");
      assert.equal(yield* stored(tenant), EVENTS * PER_EVENT, `cut at commit ${failAt}`);
      return reached;
    }));
    if (!reached) break;
  }
});

test("a rebuild cut off at any commit leaves a whole series serving, and the next rebuild clears what it left", async () => {
  // What the partition holds after an uninterrupted ingest and rebuild: no
  // retired or half-built points may outlast recovery from a cut-off one.
  const reference = await withDatabase(({ tenant, partition }) => Effect.gen(function* () {
    yield* seedSeries(tenant);
    yield* tenant.timeSeries.ingest("views");
    yield* tenant.timeSeries.rebuild("views");
    return (yield* partition().stats).records;
  }));

  for (let failAt = 1; ; failAt++) {
    const reached = await withDatabase(({ tenant, partition, cutAt }) => Effect.gen(function* () {
      yield* seedSeries(tenant);
      yield* tenant.timeSeries.ingest("views");
      const { reached } = yield* cutAt(failAt, tenant.timeSeries.rebuild("views"));
      assert.equal(yield* stored(tenant), EVENTS * PER_EVENT, `cut at commit ${failAt}: reads see one whole series`);
      yield* tenant.timeSeries.ingest("views");
      assert.equal(yield* stored(tenant), EVENTS * PER_EVENT, `cut at commit ${failAt}: and an ingest adds nothing twice`);
      yield* tenant.timeSeries.rebuild("views");
      assert.equal(yield* stored(tenant), EVENTS * PER_EVENT, `cut at commit ${failAt}: and a rebuild is whole`);
      assert.equal((yield* partition().stats).records, reference, `cut at commit ${failAt}: nothing left behind`);
      return reached;
    }));
    if (!reached) break;
  }
});

test("a projection rebuild cut off after its reset leaves no checkpoint, so the next run starts from the beginning", () =>
  withDatabase(({ tenant }) => Effect.gen(function* () {
    yield* tenant.documents.createCollection({ name: "posts" });
    for (let i = 0; i < EVENTS; i++) yield* tenant.documents.insert({ collection: "posts", id: `p${i}`, data: { n: i } });
    // Idempotent, as the contract asks: keyed by the event's own id.
    const seen = new Set();
    let resetDies = false;
    yield* tenant.projections.register({
      name: "seen",
      source: { collections: ["posts"], eventTypes: ["document.upserted"] },
      apply: (event) => Effect.sync(() => { seen.add(event.eventId); }),
      reset: () => resetDies ? Effect.die(new Error("cut off during reset")) : Effect.sync(() => seen.clear()),
    });
    assert.equal((yield* tenant.projections.run("seen")).applied, EVENTS);

    resetDies = true;
    assert.equal((yield* Effect.exit(tenant.projections.rebuild("seen")))._tag, "Failure");
    resetDies = false;
    seen.clear();
    assert.equal((yield* tenant.projections.run("seen")).applied, EVENTS, "replayed from the start");
    assert.equal(seen.size, EVENTS);
  })));

test("ingest, rebuild and a projection run are refused with TenantMoving while the tenant is fenced", () =>
  withDatabase(({ tenant, partition }) => Effect.gen(function* () {
    yield* seedSeries(tenant);
    yield* tenant.projections.register({ name: "noop", apply: () => Effect.void });
    yield* partition().fence({ from: "s0", to: "s1" });
    for (const [name, refused] of [
      ["ingest", tenant.timeSeries.ingest("views")],
      ["rebuild", tenant.timeSeries.rebuild("views")],
      ["projection run", tenant.projections.run("noop")],
      ["projection rebuild", tenant.projections.rebuild("noop")],
    ]) {
      // A failure, not a defect: Effect.flip would rethrow a defect.
      const failure = yield* Effect.flip(refused);
      assert.equal(failure._tag, "TenantMoving", name);
      assert.equal(failure.to, "s1", name);
    }
    assert.equal(yield* stored(tenant), 0, "and nothing was written");
  })));

test("a mapper that fails names the event, writes nothing of its batch, and ingesting again after the fix stores every point once", () =>
  withDatabase(({ tenant }) => Effect.gen(function* () {
    yield* seedSeries(tenant);
    // The fourth event is the bad one: the first batch (three events, 900
    // points) is not yet full, so nothing is committed before it fails.
    let calls = 0;
    yield* tenant.timeSeries.define({
      name: "views",
      source: { collections: ["posts"], eventTypes: ["document.upserted"] },
      map: (event) => {
        calls += 1;
        if (calls === 4) return { timestamp: "not a time", value: 1 };
        return Array.from({ length: PER_EVENT }, (_, i) => ({ timestamp: Date.parse(event.timestamp) + i, value: 1 }));
      },
    });
    const failure = yield* Effect.flip(tenant.timeSeries.ingest("views"));
    assert.equal(failure._tag, "TimeSeriesMapFailed");
    assert.equal(failure.series, "views");
    assert.match(failure.eventId, /^acme:/);
    assert.match(failure.reason, /Invalid time series timestamp/);
    assert.equal(yield* stored(tenant), 0, "nothing of the failed batch was written");

    yield* seedSeries.redefine(tenant);
    yield* tenant.timeSeries.ingest("views");
    assert.equal(yield* stored(tenant), EVENTS * PER_EVENT);
  })));

test("a point the reads could not parse back is refused when it is mapped, not when it is read", () =>
  withDatabase(({ tenant }) => Effect.gen(function* () {
    yield* seedSeries(tenant);
    for (const [bad, reason] of [
      [{ value: Number.NaN }, /finite number/],
      [{ value: 1, tags: { region: 7 } }, /tags must all be strings/],
    ]) {
      yield* tenant.timeSeries.define({
        name: "views",
        source: { collections: ["posts"], eventTypes: ["document.upserted"] },
        map: (event) => ({ timestamp: Date.parse(event.timestamp), ...bad }),
      });
      const failure = yield* Effect.flip(tenant.timeSeries.ingest("views"));
      assert.equal(failure._tag, "TimeSeriesMapFailed");
      assert.match(failure.reason, reason);
    }
    assert.equal(yield* stored(tenant), 0);
  })));
