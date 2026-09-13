// Operations that answer with a series or distribution rather than a number:
// windows (tumbling & sliding), moving windows, histograms, and interpolation.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeDatabase, partitionMapFor, defineDatabaseService } from "../dist/db/index.js";
import { makeMemoryStore } from "../dist/db/engines/memory-kv.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";
import { openTemporaryDatabase } from "./_database.mjs";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const BASE = Date.UTC(2026, 0, 1);

const engines = [
  ["memory", (_dir, shard) => makeMemoryStore(shard)],
  ["sqlite", (dir, shard) => makeNodeSqliteStore(shard, dir)],
];

const viewsSeries = {
  name: "views",
  source: { collections: ["posts"], eventTypes: ["document.upserted"] },
  map: (event) =>
    event.payload.data.views === undefined
      ? null
      : {
          timestamp: BASE + event.payload.data.day * DAY + (event.payload.data.hour ?? 0) * HOUR,
          value: event.payload.data.views,
          tags: { region: event.payload.data.region },
        },
};

// Days 0, 1, 3, 4 (notice day 2 is missing, providing an empty gap for fill/interpolation)
// Values:
// Day 0: 10 (eu)
// Day 1: 20 (eu)
// Day 3: 40 (us)
// Day 4: 50 (us)
const ROWS = [
  { day: 0, views: 10, region: "eu" },
  { day: 1, views: 20, region: "eu" },
  { day: 3, views: 40, region: "us" },
  { day: 4, views: 50, region: "us" },
];

for (const [engine, open] of engines) {
  const withTenant = (t, body) => {
    const dir = mkdtempSync(join(tmpdir(), `zv-ts-series-${engine}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const db = yield* makeDatabase({
            partitionMap: partitionMapFor(["s0"]),
            openShard: (shard) => open(dir, shard),
          });
          const tenant = db.forTenant("acme");
          yield* tenant.documents.createCollection({ name: "posts" });
          yield* tenant.timeSeries.define(viewsSeries);
          for (let i = 0; i < ROWS.length; i++) {
            yield* tenant.documents.insert({ collection: "posts", id: `p${i}`, data: ROWS[i] });
          }
          yield* tenant.timeSeries.ingest("views");
          return yield* body(tenant, db);
        }),
      ),
    );
  };

  test(`${engine}: windows tumbling buckets group points into time intervals`, async (t) => {
    await withTenant(t, (tenant) =>
      Effect.gen(function* () {
        const views = tenant.timeSeries.get("views");

        // Tumbling windows with interval = DAY, default fill "none"
        const daily = yield* views.windows({ interval: DAY, op: "avg" });
        // Day 0, 1, 3, 4 are present; day 2 is omitted
        assert.equal(daily.length, 4);
        assert.deepEqual(daily.map((b) => b.value), [10, 20, 40, 50]);
        assert.deepEqual(daily.map((b) => b.count), [1, 1, 1, 1]);

        // Interval = 2 * DAY
        // Window 0 [BASE, BASE + 2*DAY): day 0 (10) and day 1 (20) -> avg 15, count 2
        // Window 1 [BASE + 2*DAY, BASE + 4*DAY): day 3 (40) -> avg 40, count 1
        // Window 2 [BASE + 4*DAY, BASE + 6*DAY): day 4 (50) -> avg 50, count 1
        const twoDay = yield* views.windows({ interval: 2 * DAY, op: "avg" });
        assert.equal(twoDay.length, 3);
        assert.deepEqual(twoDay.map((b) => b.value), [15, 40, 50]);
        assert.deepEqual(twoDay.map((b) => b.count), [2, 1, 1]);
      }),
    );
  });

  test(`${engine}: windows sliding windows step forward by less than the interval`, async (t) => {
    await withTenant(t, (tenant) =>
      Effect.gen(function* () {
        const views = tenant.timeSeries.get("views");

        // 2-day window sliding every 1 day
        // Window at day 0 [0, 2): days 0 and 1 -> avg 15, count 2
        // Window at day 1 [1, 3): day 1 -> avg 20, count 1
        // Window at day 2 [2, 4): day 3 -> avg 40, count 1
        // Window at day 3 [3, 5): days 3 and 4 -> avg 45, count 2
        // Window at day 4 [4, 6): day 4 -> avg 50, count 1
        const sliding = yield* views.windows({ interval: 2 * DAY, step: DAY, op: "avg" });
        assert.equal(sliding.length, 5);
        assert.deepEqual(sliding.map((b) => b.value), [15, 20, 40, 45, 50]);
        assert.deepEqual(sliding.map((b) => b.count), [2, 1, 1, 2, 1]);
      }),
    );
  });

  test(`${engine}: windows fill policies handle gaps with zero, previous, or linear interpolation`, async (t) => {
    await withTenant(t, (tenant) =>
      Effect.gen(function* () {
        const views = tenant.timeSeries.get("views");

        // Gaps filled with zero: day 2 has count 0 and value 0
        const zeroFilled = yield* views.windows({ interval: DAY, fill: "zero" });
        assert.equal(zeroFilled.length, 5);
        assert.deepEqual(zeroFilled.map((b) => b.value), [10, 20, 0, 40, 50]);
        assert.deepEqual(zeroFilled.map((b) => b.count), [1, 1, 0, 1, 1]);

        // Gaps filled with previous: day 2 carries forward day 1's value (20)
        const prevFilled = yield* views.windows({ interval: DAY, fill: "previous" });
        assert.equal(prevFilled.length, 5);
        assert.deepEqual(prevFilled.map((b) => b.value), [10, 20, 20, 40, 50]);
        assert.deepEqual(prevFilled.map((b) => b.count), [1, 1, 0, 1, 1]);

        // Gaps filled with linear interpolation: day 2 is midway between day 1 (20) and day 3 (40) -> 30
        const linearFilled = yield* views.windows({ interval: DAY, fill: "linear" });
        assert.equal(linearFilled.length, 5);
        assert.deepEqual(linearFilled.map((b) => b.value), [10, 20, 30, 40, 50]);
        assert.deepEqual(linearFilled.map((b) => b.count), [1, 1, 0, 1, 1]);
      }),
    );
  });

  test(`${engine}: windows narrow by tags and custom time boundaries`, async (t) => {
    await withTenant(t, (tenant) =>
      Effect.gen(function* () {
        const views = tenant.timeSeries.get("views");

        // Filtered by tag region: "eu" (days 0 and 1)
        const eu = yield* views.windows({ interval: DAY, tags: { region: "eu" } });
        assert.equal(eu.length, 2);
        assert.deepEqual(eu.map((b) => b.value), [10, 20]);

        // Bound to window [BASE, BASE + 2*DAY]
        const bounded = yield* views.windows({
          interval: DAY,
          start: BASE,
          end: BASE + 2 * DAY,
          fill: "zero",
        });
        assert.equal(bounded.length, 3);
        assert.deepEqual(bounded.map((b) => b.value), [10, 20, 0]);
      }),
    );
  });

  test(`${engine}: moving window averages over point counts or time durations`, async (t) => {
    await withTenant(t, (tenant) =>
      Effect.gen(function* () {
        const views = tenant.timeSeries.get("views");

        // Rolling 2-point average:
        // Point 0 (10): avg(10) = 10
        // Point 1 (20): avg(10, 20) = 15
        // Point 2 (40): avg(20, 40) = 30
        // Point 3 (50): avg(40, 50) = 45
        const byCount = yield* views.moving({ window: { count: 2 }, op: "avg" });
        assert.equal(byCount.length, 4);
        assert.deepEqual(byCount.map((p) => p.value), [10, 15, 30, 45]);
        assert.equal(byCount[0].tags.region, "eu");
        assert.equal(byCount[3].tags.region, "us");

        // Rolling time duration of 2 days:
        // Point 0 (day 0, 10): window [day -2, day 0] -> points [10] -> avg 10
        // Point 1 (day 1, 20): window [day -1, day 1] -> points [10, 20] -> avg 15
        // Point 2 (day 3, 40): window [day 1, day 3] -> points [20, 40] -> avg 30
        // Point 3 (day 4, 50): window [day 2, day 4] -> points [40, 50] -> avg 45
        const byTime = yield* views.moving({ window: { time: 2 * DAY }, op: "avg" });
        assert.equal(byTime.length, 4);
        assert.deepEqual(byTime.map((p) => p.value), [10, 15, 30, 45]);
      }),
    );
  });

  test(`${engine}: histogram calculates value distribution and summary statistics`, async (t) => {
    await withTenant(t, (tenant) =>
      Effect.gen(function* () {
        const views = tenant.timeSeries.get("views");

        // 4 values: 10, 20, 40, 50. Min = 10, Max = 50, Sum = 120, Avg = 30
        const hist = yield* views.histogram({ bins: 2 });
        assert.equal(hist.count, 4);
        assert.equal(hist.min, 10);
        assert.equal(hist.max, 50);
        assert.equal(hist.sum, 120);
        assert.equal(hist.avg, 30);
        assert.equal(hist.buckets.length, 2);
        // Bin 0 [10, 30): 10, 20 -> count 2
        assert.equal(hist.buckets[0].lower, 10);
        assert.equal(hist.buckets[0].upper, 30);
        assert.equal(hist.buckets[0].count, 2);
        // Bin 1 [30, 50]: 40, 50 -> count 2
        assert.equal(hist.buckets[1].lower, 30);
        assert.equal(hist.buckets[1].upper, 50);
        assert.equal(hist.buckets[1].count, 2);

        // Custom boundaries: [0, 25, 60]
        const boundedHist = yield* views.histogram({ boundaries: [0, 25, 60] });
        assert.equal(boundedHist.buckets.length, 2);
        assert.equal(boundedHist.buckets[0].count, 2); // 10, 20
        assert.equal(boundedHist.buckets[1].count, 2); // 40, 50

        // Custom step
        const stepped = yield* views.histogram({ step: 20, min: 10, max: 50 });
        assert.equal(stepped.buckets.length, 2);
        assert.equal(stepped.buckets[0].count, 2);
        assert.equal(stepped.buckets[1].count, 2);

        // Empty window returns zero counts
        const empty = yield* views.histogram({ start: BASE + 100 * DAY, end: BASE + 101 * DAY });
        assert.equal(empty.count, 0);
        assert.deepEqual(empty.buckets, []);
      }),
    );
  });

  test(`${engine}: interpolate resamples series points onto a regular time grid`, async (t) => {
    await withTenant(t, (tenant) =>
      Effect.gen(function* () {
        const views = tenant.timeSeries.get("views");

        // Linear interpolation across days 0..4 stepping by 1 day:
        // Day 0: 10
        // Day 1: 20
        // Day 2 (interpolated between day 1=20 and day 3=40): 30
        // Day 3: 40
        // Day 4: 50
        const linear = yield* views.interpolate({ step: DAY, method: "linear" });
        assert.equal(linear.length, 5);
        assert.deepEqual(linear.map((p) => p.value), [10, 20, 30, 40, 50]);

        // Previous (step-after / forward-fill):
        // Day 2 carries 20
        const prev = yield* views.interpolate({ step: DAY, method: "previous" });
        assert.equal(prev.length, 5);
        assert.deepEqual(prev.map((p) => p.value), [10, 20, 20, 40, 50]);

        // Next (step-before / backward-fill):
        // Day 2 takes 40
        const next = yield* views.interpolate({ step: DAY, method: "next" });
        assert.equal(next.length, 5);
        assert.deepEqual(next.map((p) => p.value), [10, 20, 40, 40, 50]);
      }),
    );
  });
}

const call = (route, { service, params = {}, query = "", body } = {}) =>
  route.handler({
    service,
    params,
    query: new URLSearchParams(query),
    body,
    headers: {},
    request: undefined,
  });

const routeOf = (service, id) => {
  const routes = [
    ...service.api.v1,
    ...service.services.flatMap((nested) => nested.api.v1),
  ];
  const found = routes.find((route) => route.id === id);
  assert.ok(found, `route ${id} should exist`);
  return found;
};

test("time series HTTP service: windows, moving, histogram, interpolate, and tags are callable over HTTP", async (t) => {
  const { api, database } = await openTemporaryDatabase(t);
  const tenant = database.forTenant("acme");
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* tenant.documents.createCollection({ name: "posts" });
      yield* tenant.timeSeries.define(viewsSeries);
      for (let i = 0; i < ROWS.length; i++) {
        yield* tenant.documents.insert({ collection: "posts", id: `p${i}`, data: ROWS[i] });
      }
      yield* tenant.timeSeries.ingest("views");
    }),
  );

  const service = defineDatabaseService(api);

  // 1. POST /timeseries/:series/windows
  const windowsRes = await call(routeOf(service, "database.timeseries.windows"), {
    service: api,
    params: { series: "views" },
    body: { tenantId: "acme", interval: DAY, fill: "linear" },
  });
  assert.equal(windowsRes.body.buckets.length, 5);
  assert.deepEqual(windowsRes.body.buckets.map((b) => b.value), [10, 20, 30, 40, 50]);

  // 2. POST /timeseries/:series/moving
  const movingRes = await call(routeOf(service, "database.timeseries.moving"), {
    service: api,
    params: { series: "views" },
    body: { tenantId: "acme", window: { count: 2 } },
  });
  assert.equal(movingRes.body.points.length, 4);
  assert.deepEqual(movingRes.body.points.map((p) => p.value), [10, 15, 30, 45]);

  // 3. POST /timeseries/:series/histogram
  const histRes = await call(routeOf(service, "database.timeseries.histogram"), {
    service: api,
    params: { series: "views" },
    body: { tenantId: "acme", bins: 2 },
  });
  assert.equal(histRes.body.count, 4);
  assert.equal(histRes.body.buckets.length, 2);

  // 4. POST /timeseries/:series/interpolate
  const interpRes = await call(routeOf(service, "database.timeseries.interpolate"), {
    service: api,
    params: { series: "views" },
    body: { tenantId: "acme", step: DAY, method: "linear" },
  });
  assert.equal(interpRes.body.points.length, 5);
  assert.deepEqual(interpRes.body.points.map((p) => p.value), [10, 20, 30, 40, 50]);

  // 5. POST /timeseries/:series/range with tags over HTTP
  const rangeRes = await call(routeOf(service, "database.timeseries.range"), {
    service: api,
    params: { series: "views" },
    body: { tenantId: "acme", tags: { region: "eu" } },
  });
  assert.equal(rangeRes.body.points.length, 2);
  assert.deepEqual(rangeRes.body.points.map((p) => p.value), [10, 20]);

  // 6. POST /timeseries/:series/aggregate with tags over HTTP
  const aggRes = await call(routeOf(service, "database.timeseries.aggregate"), {
    service: api,
    params: { series: "views" },
    body: { tenantId: "acme", op: "sum", tags: { region: "eu" } },
  });
  assert.equal(aggRes.body.value, 30);
});
