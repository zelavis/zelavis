// Aggregations that care about when, not only how much.
//
// `collect` answers in posting order -- the order points were written -- which
// is invisible to sum, avg, min and max. It is not invisible to first, last,
// delta and rate, which are defined by the window's endpoints. So the series
// below is seeded deliberately out of order: every one of these tests would
// still pass on unsorted points if the days happened to be written in sequence.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeDatabase, partitionMapFor } from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const DAY = 86_400_000;
const BASE = Date.UTC(2026, 0, 1);

const withTenant = (t, body) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-ts-ops-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* makeDatabase({
          partitionMap: partitionMapFor(["only"]),
          openShard: (shard) => makeNodeSqliteStore(shard, dir),
        });
        return yield* body(db.forTenant("acme"), db);
      }),
    ),
  );
};

const viewsSeries = {
  name: "views",
  source: { collections: ["posts"], eventTypes: ["document.upserted"] },
  map: (event) =>
    event.payload.data.views === undefined
      ? null
      : {
          timestamp: BASE + event.payload.data.day * DAY,
          value: event.payload.data.views,
          tags: { region: event.payload.data.region },
        },
};

// Days 0..3 hold 10, 20, 30, 40 -- written middle, last, first, second, so
// posting order and time order disagree.
const SCRAMBLED = [
  { day: 2, views: 30, region: "us" },
  { day: 3, views: 40, region: "us" },
  { day: 0, views: 10, region: "eu" },
  { day: 1, views: 20, region: "eu" },
];

const seeded = (tenant, rows = SCRAMBLED) =>
  Effect.gen(function* () {
    yield* tenant.documents.createCollection({ name: "posts" });
    yield* tenant.timeSeries.define(viewsSeries);
    yield* Effect.forEach(
      rows,
      (row, i) => tenant.documents.insert({ collection: "posts", id: `p${i}`, data: row }),
      { discard: true },
    );
    yield* tenant.timeSeries.ingest("views");
    return tenant.timeSeries.get("views");
  });

test("time series: the endpoints are the window's earliest and latest, not its first written", async (t) => {
  await withTenant(t, (tenant) =>
    Effect.gen(function* () {
      const views = yield* seeded(tenant);

      // Written first was day 2 at 30; the window starts at day 0 with 10.
      assert.equal(yield* views.aggregate({ op: "first" }), 10);
      assert.equal(yield* views.aggregate({ op: "last" }), 40);
      assert.equal(yield* views.aggregate({ op: "delta" }), 30);

      // Three days between the endpoints, in seconds.
      assert.equal(yield* views.aggregate({ op: "rate" }), 30 / ((3 * DAY) / 1000));

      // The value folds are unchanged by any of this.
      assert.equal(yield* views.aggregate({ op: "sum" }), 100);
      assert.equal(yield* views.aggregate({ op: "count" }), 4);
    }),
  );
});

test("time series: a window narrows the endpoints with it", async (t) => {
  await withTenant(t, (tenant) =>
    Effect.gen(function* () {
      const views = yield* seeded(tenant);
      const window = { start: BASE + DAY, end: BASE + 2 * DAY };

      // Bounds are closed on both sides, so this is days 1 and 2.
      assert.equal(yield* views.aggregate({ op: "first", ...window }), 20);
      assert.equal(yield* views.aggregate({ op: "last", ...window }), 30);
      assert.equal(yield* views.aggregate({ op: "delta", ...window }), 10);
      assert.equal(yield* views.aggregate({ op: "count", ...window }), 2);
    }),
  );
});

test("time series: a quantile interpolates between the values it falls between", async (t) => {
  await withTenant(t, (tenant) =>
    Effect.gen(function* () {
      const views = yield* seeded(tenant);
      const at = (p) => views.aggregate({ op: "quantile", p });

      // Sorted: 10, 20, 30, 40. The median falls between 20 and 30.
      assert.equal(yield* at(0.5), 25);
      assert.equal(yield* at(0), 10, "the smallest");
      assert.equal(yield* at(1), 40, "the largest");
      assert.equal(yield* at(0.25), 17.5);
      // A quantile sorts by value, so the scrambled write order cannot matter.
      assert.equal(yield* at(0.75), 32.5);
    }),
  );
});

test("time series: an empty window says zero, and a single point spans no time", async (t) => {
  await withTenant(t, (tenant) =>
    Effect.gen(function* () {
      const views = yield* seeded(tenant);
      const empty = { start: BASE + 40 * DAY, end: BASE + 50 * DAY };
      for (const op of ["first", "last", "delta", "rate", "sum", "avg", "min", "max"]) {
        assert.equal(yield* views.aggregate({ op, ...empty }), 0, `${op} over nothing`);
      }
      assert.equal(yield* views.aggregate({ op: "count", ...empty }), 0);

      // One point: it is both endpoints, so the change is nothing and the rate
      // divides no time rather than dividing by zero.
      const one = { start: BASE, end: BASE };
      assert.equal(yield* views.aggregate({ op: "first", ...one }), 10);
      assert.equal(yield* views.aggregate({ op: "last", ...one }), 10);
      assert.equal(yield* views.aggregate({ op: "delta", ...one }), 0);
      assert.equal(yield* views.aggregate({ op: "rate", ...one }), 0);
    }),
  );
});

test("time series: the endpoints narrow by tag as well as by time", async (t) => {
  await withTenant(t, (tenant) =>
    Effect.gen(function* () {
      const views = yield* seeded(tenant);
      // eu is days 0 and 1; us is days 2 and 3.
      assert.equal(yield* views.aggregate({ op: "first", tags: { region: "eu" } }), 10);
      assert.equal(yield* views.aggregate({ op: "last", tags: { region: "eu" } }), 20);
      assert.equal(yield* views.aggregate({ op: "first", tags: { region: "us" } }), 30);
      assert.equal(yield* views.aggregate({ op: "delta", tags: { region: "us" } }), 10);
    }),
  );
});

test("time series: a quantile without a usable fraction is a mistake in the call", async (t) => {
  await withTenant(t, (tenant) =>
    Effect.gen(function* () {
      const views = yield* seeded(tenant);
      for (const p of [undefined, -0.1, 1.5, Number.NaN]) {
        // A defect, not a failure of the error channel: `aggregate` promises a
        // number, so there is no error for this to arrive as.
        const outcome = yield* Effect.exit(
          views.aggregate({ op: "quantile", ...(p === undefined ? {} : { p }) }),
        );
        assert.equal(outcome._tag, "Failure", `p of ${String(p)} should not be accepted`);
      }
    }),
  );
});
