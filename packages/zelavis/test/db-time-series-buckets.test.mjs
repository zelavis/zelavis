// A window is one range over the points' own instants.
//
// The cover of buckets these tests were written against is gone: a point
// carries its instant in the ordered lens, and a window is a range over it.
// What must not change is the answers, so every test below is the one that
// stood before, asserting the same counts and the same edges.
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

const withSeries = (t, body) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-ts-buckets-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Effect.runPromise(
    Effect.scoped(Effect.gen(function* () {
      const db = yield* makeDatabase({
        partitionMap: partitionMapFor(["s0"]),
        openShard: (shard) => makeNodeSqliteStore(shard, dir),
      });
      const tenant = db.forTenant("acme");
      yield* tenant.documents.createCollection({ name: "readings" });
      yield* tenant.timeSeries.define({
        name: "usage",
        map: (event) =>
          event.type !== "document.upserted" ? null : {
            timestamp: event.payload.data.at,
            value: event.payload.data.value,
          },
      });
      return yield* body(tenant);
    })),
  );
};

/** One reading a day for two years, so a window spans far more than one read. */
const SPAN_DAYS = 730;

const seed = (tenant) =>
  Effect.gen(function* () {
    for (let day = 0; day < SPAN_DAYS; day++) {
      yield* tenant.documents.insert({
        collection: "readings",
        id: `r${day}`,
        data: { at: BASE + day * DAY, value: day },
      });
    }
    const result = yield* tenant.timeSeries.ingest("usage");
    assert.equal(result.points, SPAN_DAYS);
    return tenant.timeSeries.get("usage");
  });

test("a range far wider than one bucket level returns exactly its points", async (t) => {
  await withSeries(t, (tenant) =>
    Effect.gen(function* () {
      const usage = yield* seed(tenant);

      // Every window here is wide, and each has to come back exact: a range
      // that reached too far would show up as the wrong count.
      for (const [from, to] of [[0, 729], [0, 500], [17, 606], [400, 729], [123, 456]]) {
        const points = yield* usage.range({
          start: BASE + from * DAY,
          end: BASE + to * DAY,
        });
        assert.equal(points.length, to - from + 1, `range ${from}..${to} returned ${points.length}`);
        assert.equal(points[0].value, from);
        assert.equal(points[points.length - 1].value, to);
      }
    }),
  );
});

test("the bounds are exact where a coarse block used to end", async (t) => {
  await withSeries(t, (tenant) =>
    Effect.gen(function* () {
      const usage = yield* seed(tenant);

      // These bounds fell inside a coarse block under the old scheme, where the
      // window had to be trimmed afterwards. They are exact by construction now.
      const points = yield* usage.range({
        start: BASE + 3 * DAY,
        end: BASE + 517 * DAY + DAY - 1,
      });
      assert.equal(points.length, 515);
      assert.equal(points[0].value, 3);
      assert.equal(points[points.length - 1].value, 517);

      assert.equal(yield* usage.aggregate({ op: "count", start: BASE + 3 * DAY, end: BASE + 517 * DAY }), 515);
    }),
  );
});

test("a range reaching outside the data returns what there is", async (t) => {
  await withSeries(t, (tenant) =>
    Effect.gen(function* () {
      const usage = yield* seed(tenant);

      const wide = yield* usage.range({
        start: BASE - 5000 * DAY,
        end: BASE + 5000 * DAY,
      });
      assert.equal(wide.length, SPAN_DAYS, "a range wider than the series is still the series");

      const before = yield* usage.range({
        start: BASE - 5000 * DAY,
        end: BASE - 1,
      });
      assert.deepEqual(before, [], "and one entirely outside it is empty");
    }),
  );
});

test("a filter and a wide range compose", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-ts-buckets-tags-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await Effect.runPromise(
    Effect.scoped(Effect.gen(function* () {
      const db = yield* makeDatabase({
        partitionMap: partitionMapFor(["s0"]),
        openShard: (shard) => makeNodeSqliteStore(shard, dir),
      });
      const tenant = db.forTenant("acme");
      yield* tenant.documents.createCollection({ name: "readings" });
      yield* tenant.timeSeries.define({
        name: "usage",
        map: (event) =>
          event.type !== "document.upserted" ? null : {
            timestamp: event.payload.data.at,
            value: event.payload.data.value,
            tags: { parity: event.payload.data.value % 2 === 0 ? "even" : "odd" },
          },
      });
      for (let day = 0; day < SPAN_DAYS; day++) {
        yield* tenant.documents.insert({
          collection: "readings", id: `r${day}`, data: { at: BASE + day * DAY, value: day },
        });
      }
      yield* tenant.timeSeries.ingest("usage");

      const usage = tenant.timeSeries.get("usage");
      const evens = yield* usage.range({
        start: BASE, end: BASE + 729 * DAY, tags: { parity: "even" },
      });
      assert.equal(evens.length, 365);
      assert.ok(evens.every((p) => p.value % 2 === 0));
    })),
  );
});
