import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { aggregatesFor, documentsFor } from "../dist/db/index.js";
import { covarianceOf, histogramOf } from "../dist/db/measure-statistics.js";
import { makeMemoryStore } from "../dist/db/engines/memory-kv.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";
import { makeLmdbStore } from "../dist/db/engines/lmdb.js";
import { makeRocksdbJsStore } from "../dist/db/engines/rocksdb-js.js";
import { engineAvailable } from "./_engine-available.mjs";

const engines = [
  ["memory", () => makeMemoryStore("stats"), true],
  ["sqlite", dir => makeNodeSqliteStore("stats", dir), true],
  ["lmdb", dir => makeLmdbStore("stats", dir), engineAvailable("lmdb")],
  ["rocksdb", dir => makeRocksdbJsStore("stats", dir), engineAvailable("@harperfast/rocksdb-js")],
];
const rows = [["a", { x: 1, y: 2, region: "eu" }], ["b", { x: 2, y: 4, region: "eu" }], ["c", { x: 3, y: 6, region: "us" }], ["d", { y: 5 }], ["e", { x: 4, y: null }], ["f", { x: 0, y: 0 }]];
for (const [name, open, available] of engines) test(`${name}: covariance and histogram read measure values without payloads and share a snapshot`, { skip: available ? false : "optional engine unavailable" }, t => {
  const dir = mkdtempSync(join(tmpdir(), "zv-measure-stats-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = (yield* open(dir)).partition("acme");
    let forbidPayloads = false, inject = false, docs;
    const wrapped = { ...store,
      read: seq => forbidPayloads && Number(seq) > 1 ? Effect.die(new Error("aggregate read a document payload")) : store.read(seq),
      measure: column => Effect.tap(store.measure(column), () => {
        if (!inject) return Effect.void;
        inject = false;
        return docs.update({ collection: "rows", id: "a", data: { y: 200 } });
      }),
    };
    docs = documentsFor(wrapped, "acme");
    yield* docs.createCollection({ name: "rows", measures: [{ name: "x", path: "x" }, { name: "y", path: "y" }] });
    yield* docs.write({ operations: rows.map(([id, data]) => ({ _tag: "Insert", collection: "rows", id, data })) });
    forbidPayloads = true;
    assert.deepEqual(yield* docs.covariance({ collection: "rows", measure: "x", with: "y" }), { value: 2.5, documents: 4 });
    assert.equal((yield* docs.covariance({ collection: "rows", measure: "x", with: "y", sample: true })).value, 10 / 3);
    assert.deepEqual(yield* docs.covariance({ collection: "rows", measure: "x", with: "y", where: [{ path: "region", value: "eu" }] }), { value: 0.5, documents: 2 });
    const histogram = yield* docs.histogram({ collection: "rows", measure: "x", boundaries: [0, 2, 4] });
    assert.deepEqual(histogram, { buckets: [{ lower: 0, upper: 2, count: 2 }, { lower: 2, upper: 4, count: 3 }], documents: 5, underflow: 0, overflow: 0, min: 0, max: 4, sum: 10, avg: 2 });
    const narrow = yield* docs.histogram({ collection: "rows", measure: "x", boundaries: [1, 3] });
    assert.deepEqual([narrow.buckets[0].count, narrow.underflow, narrow.overflow], [3, 1, 1]);
    assert.equal((yield* Effect.flip(docs.histogram({ collection: "rows", measure: "x", bins: 0 })))._tag, "InvalidMeasureQuery");
    assert.equal((yield* Effect.flip(docs.covariance({ collection: "rows", measure: "x", with: "missing" })))._tag, "UnknownMeasure");
    forbidPayloads = false;
    inject = true;
    assert.equal((yield* docs.covariance({ collection: "rows", measure: "x", with: "y" })).value, 2.5, "both measure vectors use the pre-write snapshot");
    assert.equal((yield* docs.covariance({ collection: "rows", measure: "x", with: "y" })).value, -22.25);
  })));
});

test("numeric aggregate edges: empty/singleton, translated covariance, bounds and overflow", () => {
  assert.deepEqual(covarianceOf([], true), { documents: 0, value: 0 });
  assert.deepEqual(covarianceOf([[1, 2]], true), { documents: 1, value: 0 });
  assert.equal(covarianceOf([[1e12 + 1, 1e12 + 2], [1e12 + 2, 1e12 + 4], [1e12 + 3, 1e12 + 6]], false).value, 4 / 3);
  assert.deepEqual(histogramOf([], {}).buckets, [{ lower: 0, upper: 0, count: 0 }]);
  assert.deepEqual(histogramOf([5, 5], {}).buckets, [{ lower: 5, upper: 5, count: 2 }]);
  for (const options of [{ boundaries: [1, 1] }, { boundaries: [2, 1] }, { boundaries: [0, 1], bins: 2 }, { bins: 257 }, { bins: 1.5 }, { min: 2, max: 1 }]) {
    assert.throws(() => histogramOf([], options), error => error._tag === "InvalidMeasureQuery");
  }
  assert.throws(() => histogramOf([Number.MAX_VALUE, Number.MAX_VALUE], {}), error => error._tag === "InvalidMeasureQuery");
  assert.throws(() => covarianceOf([[Number.MAX_VALUE, 1], [-Number.MAX_VALUE, -1]], false), error => error._tag === "InvalidMeasureQuery");
});

test("a materialized aggregate publishes its results with the checkpoint they were computed at, and retries when the source moves", t => {
  const dir = mkdtempSync(join(tmpdir(), "zv-aggregates-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const definition = { name: "totals", collection: "rows", operations: [
    { name: "sum", op: "sum", measure: "x" },
    { name: "byRegion", op: "sum", measure: "x", groupBy: "region" },
    { name: "cov", op: "covariance", measure: "x", with: "y" },
    { name: "spread", op: "histogram", measure: "x", boundaries: [0, 2, 4] },
  ] };
  const session = (body) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = (yield* makeNodeSqliteStore("stats", dir)).partition("acme");
    // Writes during refresh: a number of them, or one on every measure read while "always".
    let inject = 0, written = 0, docs;
    const wrapped = { ...store, measure: column => Effect.tap(store.measure(column), () => {
      if (inject === 0) return Effect.void;
      if (inject !== "always") inject -= 1;
      written += 1;
      return docs.update({ collection: "rows", id: "a", data: { x: 9 + written } });
    }) };
    docs = documentsFor(wrapped, "acme");
    return yield* body({ docs, aggregates: aggregatesFor(wrapped, docs, "acme"), store, injectWrites: n => { inject = n; } });
  })));
  return session(({ docs, aggregates, store, injectWrites }) => Effect.gen(function* () {
    yield* docs.createCollection({ name: "rows", measures: [{ name: "x", path: "x" }, { name: "y", path: "y" }] });
    yield* docs.write({ operations: rows.map(([id, data]) => ({ _tag: "Insert", collection: "rows", id, data })) });
    const defined = yield* aggregates.define(definition);
    assert.equal(defined.results, undefined, "defining computes nothing");
    assert.equal((yield* Effect.flip(aggregates.define(definition)))._tag, "AggregateRefused", "a definition is immutable");
    assert.equal((yield* Effect.flip(aggregates.define({ ...definition, name: "bad", operations: [{ name: "h", op: "histogram", measure: "x", bins: 0 }] })))._tag, "AggregateRefused");
    const head = yield* store.events.head;
    const refreshed = yield* aggregates.refresh("totals");
    assert.equal(refreshed.checkpoint, head, "the checkpoint is the source log head the results were computed at");
    assert.equal(refreshed.results.sum.value, 10);
    assert.deepEqual(refreshed.results.cov, { value: 2.5, documents: 4 });
    assert.deepEqual(refreshed.results.spread.buckets.map(b => b.count), [2, 3]);
    // A write lands while the first attempt computes: that attempt is not published, the retry is.
    injectWrites(1);
    const raced = yield* aggregates.refresh("totals");
    assert.equal(raced.results.sum.value, 19, "the published result includes the write that raced the first attempt");
    // Writes that keep landing exhaust the bounded retries rather than publishing a stale answer.
    injectWrites("always");
    assert.equal((yield* Effect.flip(aggregates.refresh("totals")))._tag, "AggregateChanged");
    injectWrites(0);
    assert.equal((yield* aggregates.get("totals")).results.sum.value, 19, "a refused refresh leaves the last published result");
  })).then(() => session(({ aggregates }) => Effect.gen(function* () {
    // Results and checkpoint survive a reopen; drop removes them.
    const reopened = yield* aggregates.get("totals");
    assert.equal(reopened.results.sum.value, 19);
    assert.equal(typeof reopened.checkpoint, "string");
    assert.deepEqual((yield* aggregates.list).map(a => a.name), ["totals"]);
    yield* aggregates.drop("totals");
    assert.equal((yield* Effect.flip(aggregates.get("totals")))._tag, "AggregateNotFound");
    assert.equal((yield* Effect.flip(aggregates.refresh("totals")))._tag, "AggregateNotFound");
  })));
});
