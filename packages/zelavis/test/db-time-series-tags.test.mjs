import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeDatabase, partitionMapFor } from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const BASE = Date.UTC(2026, 0, 1);

/**
 * A series fed from document writes, tagged by region and tier.
 *
 * Points reach the series through ingest rather than being written directly,
 * because that is the only way they exist: a series is a projection over the
 * same log, so a test that wrote points by hand would be testing a path no
 * caller has.
 */
const withSeries = (t, body) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-ts-tags-"));
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
            tags: {
              region: event.payload.data.region,
              tier: event.payload.data.tier,
            },
          },
      });
      return yield* body(tenant);
    })),
  );
};

// Two readings a day, an hour apart: distinct instants. Points
// sharing an instant would leave the order of a `desc` query down to a tie
// nothing promises to break one way.
const rows = [
  ["r1", 0, 0, "eu-west", "paid", 10],
  ["r2", 0, 1, "eu-west", "free", 20],
  ["r3", 1, 0, "eu-north", "paid", 30],
  ["r4", 1, 1, "us-east", "free", 40],
  ["r5", 2, 0, "eu-west", "paid", 50],
  ["r6", 2, 1, "us-east", "paid", 60],
  ["r7", 3, 0, "eu-north", "free", 70],
];

const seed = (tenant) =>
  Effect.gen(function* () {
    for (const [id, day, hour, region, tier, value] of rows) {
      yield* tenant.documents.insert({
        collection: "readings",
        id,
        data: { at: BASE + day * DAY + hour * HOUR, region, tier, value },
      });
    }
    const result = yield* tenant.timeSeries.ingest("usage");
    assert.equal(result.points, rows.length, "every reading became a point");
    return tenant.timeSeries.get("usage");
  });

test("a tag narrows a range to the points carrying it", async (t) => {
  await withSeries(t, (tenant) =>
    Effect.gen(function* () {
      const usage = yield* seed(tenant);

      const all = yield* usage.range();
      assert.equal(all.length, 7);

      const euWest = yield* usage.range({ tags: { region: "eu-west" } });
      assert.deepEqual(euWest.map((p) => p.value), [10, 20, 50]);
      assert.ok(euWest.every((p) => p.tags.region === "eu-west"));

      // Ordering and limits still apply to what the filter returned.
      const newest = yield* usage.range({
        tags: { region: "eu-west" }, order: "desc", limit: 2,
      });
      assert.deepEqual(newest.map((p) => p.value), [50, 20]);
    }),
  );
});

test("several tags must all match", async (t) => {
  await withSeries(t, (tenant) =>
    Effect.gen(function* () {
      const usage = yield* seed(tenant);

      const paidEuWest = yield* usage.range({ tags: { region: "eu-west", tier: "paid" } });
      assert.deepEqual(paidEuWest.map((p) => p.value), [10, 50]);

      // A combination nothing carries is empty rather than falling back to
      // either half of it.
      const none = yield* usage.range({ tags: { region: "us-east", tier: "enterprise" } });
      assert.deepEqual(none, []);
    }),
  );
});

test("a tag given several values matches any of them", async (t) => {
  await withSeries(t, (tenant) =>
    Effect.gen(function* () {
      const usage = yield* seed(tenant);

      const european = yield* usage.range({ tags: { region: ["eu-west", "eu-north"] } });
      assert.deepEqual(european.map((p) => p.value), [10, 20, 30, 50, 70]);

      // Any of these regions, and paid: the two rules compose rather than one
      // overriding the other.
      const paidEuropean = yield* usage.range({
        tags: { region: ["eu-west", "eu-north"], tier: "paid" },
      });
      assert.deepEqual(paidEuropean.map((p) => p.value), [10, 30, 50]);

      // One of nothing is nothing, which is what an empty list says.
      assert.deepEqual(yield* usage.range({ tags: { region: [] } }), []);
    }),
  );
});

test("a filter composes with a time window rather than replacing it", async (t) => {
  await withSeries(t, (tenant) =>
    Effect.gen(function* () {
      const usage = yield* seed(tenant);

      const window = { start: BASE + DAY, end: BASE + 2 * DAY + HOUR };
      assert.deepEqual((yield* usage.range(window)).map((p) => p.value), [30, 40, 50, 60]);

      const filtered = yield* usage.range({ ...window, tags: { tier: "paid" } });
      assert.deepEqual(filtered.map((p) => p.value), [30, 50, 60],
        "inside the window and carrying the tag");

      // The bounds are exact: a point on the same day but outside
      // the window does not come back because it matched the tag.
      const narrow = yield* usage.range({
        start: BASE + 2 * DAY, end: BASE + 2 * DAY + HOUR, tags: { tier: "paid" },
      });
      assert.deepEqual(narrow.map((p) => p.value), [50, 60]);
    }),
  );
});

test("aggregates read the same filter", async (t) => {
  await withSeries(t, (tenant) =>
    Effect.gen(function* () {
      const usage = yield* seed(tenant);

      assert.equal(yield* usage.aggregate({ op: "sum" }), 280);
      assert.equal(yield* usage.aggregate({ op: "sum", tags: { region: "eu-west" } }), 80);
      assert.equal(yield* usage.aggregate({ op: "count", tags: { region: "eu-west" } }), 3);
      assert.equal(yield* usage.aggregate({ op: "avg", tags: { tier: "paid" } }), 37.5);
      assert.equal(yield* usage.aggregate({ op: "min", tags: { tier: "free" } }), 20);
      assert.equal(yield* usage.aggregate({ op: "max", tags: { tier: "free" } }), 70);

      // A filter matching nothing aggregates to nothing rather than to the
      // whole series.
      assert.equal(yield* usage.aggregate({ op: "sum", tags: { region: "moon" } }), 0);
      assert.equal(yield* usage.aggregate({ op: "count", tags: { region: "moon" } }), 0);

      // And a filter plus a window narrows both ways.
      assert.equal(
        yield* usage.aggregate({
          op: "sum", start: BASE, end: BASE + DAY + HOUR, tags: { tier: "paid" },
        }),
        40,
      );
    }),
  );
});

test("an empty filter is no filter", async (t) => {
  await withSeries(t, (tenant) =>
    Effect.gen(function* () {
      const usage = yield* seed(tenant);
      assert.equal((yield* usage.range({ tags: {} })).length, 7);
      assert.equal(yield* usage.aggregate({ op: "count", tags: {} }), 7);
    }),
  );
});

test("a tag is scoped to its series", async (t) => {
  await withSeries(t, (tenant) =>
    Effect.gen(function* () {
      const usage = yield* seed(tenant);

      // A second series over the same documents, using the same tag name for
      // something else. Sharing a posting list would make each answer with the
      // other's points.
      yield* tenant.timeSeries.define({
        name: "errors",
        map: (event) =>
          event.type !== "document.upserted" ? null : {
            timestamp: event.payload.data.at,
            value: 1,
            tags: { region: `${event.payload.data.region}-mirror` },
          },
      });
      yield* tenant.timeSeries.ingest("errors");

      assert.equal((yield* usage.range({ tags: { region: "eu-west" } })).length, 3);
      const errors = tenant.timeSeries.get("errors");
      assert.equal((yield* errors.range({ tags: { region: "eu-west" } })).length, 0);
      assert.equal((yield* errors.range({ tags: { region: "eu-west-mirror" } })).length, 3);
      assert.equal((yield* usage.range({ tags: { region: "eu-west-mirror" } })).length, 0);
    }),
  );
});

test("a filter composes with a window far wider than the data", async (t) => {
  await withSeries(t, (tenant) =>
    Effect.gen(function* () {
      const usage = yield* seed(tenant);

      // A window reaching well outside the data on both sides, intersected with
      // the tag: the same set operation whatever the window's width.
      const wide = { start: BASE - 1000 * DAY, end: BASE + 1000 * DAY };
      assert.equal((yield* usage.range(wide)).length, 7);

      const filtered = yield* usage.range({ ...wide, tags: { region: "eu-west" } });
      assert.deepEqual(filtered.map((p) => p.value), [10, 20, 50]);
      assert.equal(yield* usage.aggregate({ op: "sum", ...wide, tags: { region: "eu-west" } }), 80);
    }),
  );
});
