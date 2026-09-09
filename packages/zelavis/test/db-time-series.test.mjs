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
  const dir = mkdtempSync(join(tmpdir(), "zv-ts-"));
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

// Each post carries its own day offset and view count, so points land in
// distinct buckets without depending on wall-clock time.
const viewsSeries = {
  name: "views",
  description: "views per post",
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

const seed = (documents, rows) =>
  Effect.forEach(rows, (row, i) =>
    documents.insert({ collection: "posts", id: `p${i}`, data: row }), { discard: true });

test("time series: ingest maps events to points, range and aggregate read them", async (t) => {
  await withTenant(t, ({ documents, timeSeries }) =>
    Effect.gen(function* () {
      yield* documents.createCollection({ name: "posts" });
      yield* timeSeries.define(viewsSeries);

      yield* seed(documents, [
        { day: 0, views: 10, region: "eu" },
        { day: 1, views: 20, region: "eu" },
        { day: 2, views: 30, region: "us" },
        { day: 3, views: 40, region: "us" },
      ]);

      const first = yield* timeSeries.ingest("views");
      assert.equal(first.points, 4, "one point per mapped event");

      const all = yield* timeSeries.get("views").range();
      assert.deepEqual(all.map((p) => p.value), [10, 20, 30, 40], "ascending by default");
      assert.deepEqual(all[0].tags, { region: "eu" }, "tags are kept");

      const desc = yield* timeSeries.get("views").range({ order: "desc", limit: 2 });
      assert.deepEqual(desc.map((p) => p.value), [40, 30], "order and limit");

      const windowed = yield* timeSeries
        .get("views")
        .range({ start: BASE + DAY, end: BASE + 2 * DAY });
      assert.deepEqual(windowed.map((p) => p.value), [20, 30], "bounded range");

      const ts = timeSeries.get("views");
      assert.equal(yield* ts.aggregate({ op: "sum" }), 100);
      assert.equal(yield* ts.aggregate({ op: "count" }), 4);
      assert.equal(yield* ts.aggregate({ op: "avg" }), 25);
      assert.equal(yield* ts.aggregate({ op: "min" }), 10);
      assert.equal(yield* ts.aggregate({ op: "max" }), 40);
      assert.equal(
        yield* ts.aggregate({ op: "sum", start: BASE + DAY, end: BASE + 2 * DAY }),
        50, "aggregate respects the window");

      const listed = yield* timeSeries.list;
      assert.deepEqual(listed.map((s) => s.name), ["views"]);
      assert.equal(listed[0].bucket, "day", "day buckets by default");
    }),
  );
});

test("time series: ingest is incremental and rebuild replaces points", async (t) => {
  await withTenant(t, ({ documents, timeSeries }) =>
    Effect.gen(function* () {
      yield* documents.createCollection({ name: "posts" });
      yield* timeSeries.define(viewsSeries);
      yield* seed(documents, [{ day: 0, views: 10, region: "eu" }]);

      assert.equal((yield* timeSeries.ingest("views")).points, 1);
      assert.equal((yield* timeSeries.ingest("views")).points, 0, "checkpoint prevents replay");
      assert.equal((yield* timeSeries.get("views").range()).length, 1, "no duplicate points");

      yield* documents.insert({ collection: "posts", id: "later", data: { day: 5, views: 50, region: "us" } });
      assert.equal((yield* timeSeries.ingest("views")).points, 1, "only the new event");
      assert.equal(yield* timeSeries.get("views").aggregate({ op: "sum" }), 60);

      // A rebuild discards points and replays, rather than appending again.
      const rebuilt = yield* timeSeries.rebuild("views");
      assert.equal(rebuilt.points, 2);
      const after = yield* timeSeries.get("views").range();
      assert.deepEqual(after.map((p) => p.value), [10, 50], "points replaced, not duplicated");

      const missing = yield* timeSeries.ingest("absent").pipe(
        Effect.as("ingested"),
        Effect.catchTag("TimeSeriesNotFound", () => Effect.succeed("missing")),
      );
      assert.equal(missing, "missing");
    }),
  );
});

test("time series: points do not feed back into the event log", async (t) => {
  await withTenant(t, ({ documents, timeSeries, events, projections }) =>
    Effect.gen(function* () {
      yield* documents.createCollection({ name: "posts" });
      yield* timeSeries.define(viewsSeries);
      yield* seed(documents, [{ day: 0, views: 10, region: "eu" }]);

      const before = yield* events.read();
      yield* timeSeries.ingest("views");
      const after = yield* events.read();
      assert.deepEqual(
        after.map((e) => e.eventId),
        before.map((e) => e.eventId),
        "writing points appends no domain events",
      );

      // Ingesting repeatedly cannot amplify: a series is not its own source.
      yield* timeSeries.ingest("views");
      yield* timeSeries.ingest("views");
      assert.equal((yield* timeSeries.get("views").range()).length, 1);

      // The internal projection stays out of the projection listing.
      assert.deepEqual(yield* projections.list, []);
    }),
  );
});

test("time series: hour buckets and wide ranges both resolve correctly", async (t) => {
  await withTenant(t, ({ documents, timeSeries }) =>
    Effect.gen(function* () {
      yield* documents.createCollection({ name: "posts" });
      yield* timeSeries.define({ ...viewsSeries, name: "hourly", bucket: "hour" });

      yield* seed(documents, [
        { day: 0, views: 1, region: "eu" },
        { day: 10, views: 2, region: "eu" },
        // Far enough out that the range spans more buckets than are worth naming,
        // which must fall back to a scan rather than return nothing.
        { day: 900, views: 3, region: "eu" },
      ]);
      yield* timeSeries.ingest("hourly");

      const narrow = yield* timeSeries.get("hourly").range({ start: BASE, end: BASE + DAY });
      assert.deepEqual(narrow.map((p) => p.value), [1], "narrow range uses buckets");

      const wide = yield* timeSeries
        .get("hourly")
        .range({ start: BASE, end: BASE + 1000 * DAY });
      assert.deepEqual(wide.map((p) => p.value), [1, 2, 3], "wide range falls back to a scan");

      assert.equal(yield* timeSeries.get("hourly").aggregate({ op: "count" }), 3);
    }),
  );
});
