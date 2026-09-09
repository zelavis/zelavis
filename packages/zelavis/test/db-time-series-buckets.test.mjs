import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { coverBuckets, makeDatabase, partitionMapFor } from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const DAY = 86_400_000;
const BASE = Date.UTC(2026, 0, 1);
const FACTOR = 8;
const LEVELS = 5;

/** Every base bucket a set of blocks claims, with duplicates kept so overlap shows. */
const expand = (blocks) => {
  const out = [];
  for (const [level, block] of blocks) {
    const width = FACTOR ** level;
    for (let i = 0; i < width; i++) out.push(block * width + i);
  }
  return out;
};

test("a cover is exactly the range, with nothing missing and nothing extra", () => {
  // Brute force, because this is the one part of the scheme whose failure is
  // silent: a cover reaching too far returns points outside the range, and one
  // falling short drops points inside it — both look like data, not an error.
  for (let first = -40; first <= 40; first++) {
    for (let span = 1; span <= 200; span++) {
      const last = first + span - 1;
      const covered = expand(coverBuckets(first, last)).sort((a, b) => a - b);
      const wanted = [];
      for (let b = first; b <= last; b++) wanted.push(b);
      assert.deepEqual(covered, wanted, `cover of [${first}, ${last}] is wrong`);
    }
  }
});

test("a cover of a long range stays small", () => {
  const clauses = (first, last) => coverBuckets(first, last).length;

  // The case the fallback used to catch: a range far wider than the old
  // 400-bucket limit, which now costs a couple of dozen clauses instead of a
  // scan of the whole series.
  assert.ok(clauses(0, 3650) <= 30, `ten years of days took ${clauses(0, 3650)} clauses`);
  assert.ok(clauses(0, 36_500) <= 40, `a century took ${clauses(0, 36_500)} clauses`);
  assert.ok(clauses(1, 36_501) <= 80, "and an unaligned century is still bounded");

  // The worst case is edges at every level: at most FACTOR - 1 blocks per level
  // on each side, plus whole blocks of the top level in the middle.
  let worst = 0;
  for (let first = 0; first < 64; first++) {
    for (let span = 1; span <= 5000; span += 7) {
      worst = Math.max(worst, clauses(first, first + span - 1));
    }
  }
  assert.ok(worst <= 2 * (FACTOR - 1) * LEVELS + 5000 / FACTOR ** (LEVELS - 1) + 2,
    `worst observed cover was ${worst} clauses`);
});

test("a short range still names its own buckets", () => {
  assert.deepEqual(coverBuckets(5, 5), [[0, 5]]);
  // Aligned and exactly one block wide: one clause at the next level up.
  assert.deepEqual(coverBuckets(8, 15), [[1, 1]]);
  // One short of aligned, so it cannot use the coarse block.
  assert.deepEqual(coverBuckets(8, 14).length, 7);
});

test("a cover works below the epoch, where the indices go negative", () => {
  for (let first = -300; first <= -100; first += 7) {
    for (const span of [1, 8, 9, 64, 100]) {
      const last = first + span - 1;
      const covered = expand(coverBuckets(first, last)).sort((a, b) => a - b);
      const wanted = [];
      for (let b = first; b <= last; b++) wanted.push(b);
      assert.deepEqual(covered, wanted, `cover of [${first}, ${last}] is wrong`);
    }
  }
});

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
        bucket: "day",
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

/** One reading a day for two years — well past the old 400-bucket limit. */
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

      // Every window here spans more than the 400 buckets that used to force a
      // scan, and each has to come back exact — the bounds are still applied to
      // what the buckets return, so a cover that reached too far would show up
      // as the wrong count.
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

test("the bounds are still exact at the edges of a coarse block", async (t) => {
  await withSeries(t, (tenant) =>
    Effect.gen(function* () {
      const usage = yield* seed(tenant);

      // A coarse block covers eight days at level one and 512 at level three;
      // asking for a window that ends inside one must not return the rest of it.
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
        bucket: "day",
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
