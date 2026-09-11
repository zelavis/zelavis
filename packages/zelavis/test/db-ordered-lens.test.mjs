// The ordered lens: ranges, pages in either direction, and extents.
//
// Equality answers "which objects hold this value". An order answers the rest:
// everything above a price, the next page of a sorted list, the latest date.
// Every engine runs the same assertions, because the lens is only as ordered as
// the engine's byte order and the store's reading of it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Schema, Stream } from "effect";
import { and, asSeq, between, equals, gt, gte, lt, lte, or, Query } from "../dist/db/index.js";
import { makeMemoryStore, memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { metaKey, Tag } from "../dist/db/keys.js";
import { openStoreOverKv } from "../dist/db/kv-store.js";
import { engineAvailable } from "./_engine-available.mjs";

const enc = new TextEncoder();
const engines = [
  ["memory", true, async () => makeMemoryStore("acme")],
  ["sqlite", true, async (dir) => (await import("../dist/db/engines/node-sqlite.js")).makeNodeSqliteStore("acme", dir)],
  ["libsql", engineAvailable("libsql"),
    async (dir) => (await import("../dist/db/engines/libsql.js")).makeLibsqlStore("acme", { directory: dir })],
  ["lmdb", engineAvailable("lmdb"), async (dir) => (await import("../dist/db/engines/lmdb.js")).makeLmdbStore("acme", dir)],
  ["rocksdb-js", engineAvailable("@harperfast/rocksdb-js"),
    async (dir) => (await import("../dist/db/engines/rocksdb-js.js")).makeRocksdbJsStore("acme", dir)],
];

// Thirty objects, prices 0..10 with repeats, split across two regions.
const COUNT = 30;
const priceOf = (seq) => (seq * 7) % 11;
const regionOf = (seq) => (seq % 2 === 1 ? "eu" : "us");

const manifest = (ordered, columns = []) => ({ terms: [], columns: [...columns, ...ordered], measures: [], edges: [] });
const putPrice = (store, seq, price) =>
  store.transact((txn) => txn.put(asSeq(seq), enc.encode(`{"seq":${seq}}`),
    manifest([["price", price]], [["region", regionOf(seq)]])));
const seed = (store) => Effect.forEach(Array.from({ length: COUNT }, (_, i) => i + 1),
  (seq) => putPrice(store, seq, priceOf(seq)), { discard: true });
const resolved = (store, query) => Effect.map(Stream.runCollect(store.resolve(query)), (c) => [...c].map(Number));
const where = (predicate) => Array.from({ length: COUNT }, (_, i) => i + 1).filter(predicate);

/** Every row of an ordered read, one page at a time. */
const readAll = (store, input) => Effect.gen(function* () {
  const rows = [];
  let after;
  for (let pages = 0; pages < 1000; pages++) {
    const page = yield* store.ordered({ ...input, ...(after === undefined ? {} : { after }) });
    rows.push(...page.rows.map((row) => [Number(row.seq), row.value]));
    if (page.next === undefined) return rows;
    after = page.next;
  }
  throw new Error("an ordered read never ended");
});

const expected = (direction, keep = () => true) => {
  const rows = where(keep).map((seq) => [seq, priceOf(seq)]);
  rows.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return direction === "desc" ? rows.reverse() : rows;
};

for (const [engine, available, open] of engines) {
  const skip = available ? false : `${engine} is not installed`;
  const withStore = async (t, body) => {
    const dir = mkdtempSync(join(tmpdir(), `zv-ordered-${engine}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const make = await open(dir);
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      return yield* body(yield* make);
    })));
  };

  test(`${engine}: a range query answers from the ordered lens, alone and intersected`, { skip }, (t) =>
    withStore(t, (store) => Effect.gen(function* () {
      yield* seed(store);
      assert.deepEqual(yield* resolved(store, gt("price", 7)), where((s) => priceOf(s) > 7));
      assert.deepEqual(yield* resolved(store, gte("price", 7)), where((s) => priceOf(s) >= 7));
      assert.deepEqual(yield* resolved(store, lt("price", 3)), where((s) => priceOf(s) < 3));
      assert.deepEqual(yield* resolved(store, lte("price", 3)), where((s) => priceOf(s) <= 3));
      assert.deepEqual(yield* resolved(store, between("price", 3, 6)), where((s) => priceOf(s) >= 3 && priceOf(s) <= 6));
      assert.deepEqual(yield* resolved(store, and(equals("region", "eu"), between("price", 3, 6))),
        where((s) => regionOf(s) === "eu" && priceOf(s) >= 3 && priceOf(s) <= 6));
      assert.deepEqual(yield* resolved(store, or(lt("price", 2), gt("price", 9))),
        where((s) => priceOf(s) < 2 || priceOf(s) > 9));
      assert.deepEqual(yield* resolved(store, gt("price", 100)), []);
    })));

  test(`${engine}: ordered pages return every row once, in order, in both directions`, { skip }, (t) =>
    withStore(t, (store) => Effect.gen(function* () {
      yield* seed(store);
      assert.deepEqual(yield* readAll(store, { column: "price", limit: 4 }), expected("asc"));
      assert.deepEqual(yield* readAll(store, { column: "price", direction: "desc", limit: 4 }), expected("desc"));
      // Bounds and a filter narrow the read, and cursors continue inside them.
      const narrowed = {
        column: "price", limit: 2,
        lower: { value: 3, inclusive: true }, upper: { value: 8, inclusive: false },
        where: equals("region", "eu"),
      };
      const keep = (s) => regionOf(s) === "eu" && priceOf(s) >= 3 && priceOf(s) < 8;
      assert.deepEqual(yield* readAll(store, narrowed), expected("asc", keep));
      assert.deepEqual(yield* readAll(store, { ...narrowed, direction: "desc" }), expected("desc", keep));
    })));

  test(`${engine}: updates move a value, retracts remove it, and reindex and rebuild restore the lens`, { skip }, (t) =>
    withStore(t, (store) => Effect.gen(function* () {
      yield* seed(store);
      yield* putPrice(store, 1, 50);
      yield* store.transact((txn) => txn.retract(asSeq(2)));
      const check = Effect.gen(function* () {
        assert.deepEqual(yield* resolved(store, gt("price", 40)), [1]);
        assert.ok(!(yield* resolved(store, lte("price", 10))).includes(1), "the old value was left behind");
        assert.ok(!(yield* resolved(store, gte("price", 0))).includes(2), "a retracted object is still ordered");
        const all = yield* readAll(store, { column: "price", limit: 7 });
        assert.equal(all.length, COUNT - 1);
      });
      yield* check;
      yield* store.reindexLenses;
      yield* check;
      yield* store.rebuildLenses;
      yield* check;
    })));

  test(`${engine}: ranges, pages, equality and extent agree across sealed and live postings`, { skip }, (t) =>
    withStore(t, (store) => Effect.gen(function* () {
      yield* seed(store);
      yield* store.sealPostings;
      // After the seal: move a sealed value, remove one, add a live one, and
      // write one again unchanged, which puts its posting in both tiers.
      yield* putPrice(store, 1, 50);
      yield* store.transact((txn) => txn.retract(asSeq(2)));
      yield* putPrice(store, 31, 4);
      yield* putPrice(store, 3, priceOf(3));
      const current = new Map(Array.from({ length: COUNT }, (_, i) => [i + 1, priceOf(i + 1)]));
      current.set(1, 50);
      current.delete(2);
      current.set(31, 4);
      const rows = [...current].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      const seqsWhere = (keep) => rows.filter(([, price]) => keep(price)).map(([seq]) => seq).sort((a, b) => a - b);
      const check = Effect.gen(function* () {
        assert.deepEqual(yield* readAll(store, { column: "price", limit: 4 }), rows);
        assert.deepEqual(yield* readAll(store, { column: "price", direction: "desc", limit: 4 }), [...rows].reverse());
        assert.deepEqual(yield* resolved(store, between("price", 3, 6)), seqsWhere((p) => p >= 3 && p <= 6));
        assert.deepEqual(yield* resolved(store, equals("price", 4)), seqsWhere((p) => p === 4));
        assert.deepEqual(yield* resolved(store, gt("price", 40)), [1]);
        assert.deepEqual(yield* store.extent("price"),
          { min: Math.min(...current.values()), max: Math.max(...current.values()) });
      });
      yield* check;
      // A second seal folds the tombstones and the live postings into the blobs.
      yield* store.sealPostings;
      yield* check;
    })));

  test(`${engine}: extent is a column's lowest and highest value, filtered or not`, { skip }, (t) =>
    withStore(t, (store) => Effect.gen(function* () {
      assert.deepEqual(yield* store.extent("price"), {});
      yield* seed(store);
      assert.deepEqual(yield* store.extent("price"), { min: 0, max: 10 });
      const eu = where((s) => regionOf(s) === "eu").map(priceOf);
      assert.deepEqual(yield* store.extent("price", equals("region", "eu")),
        { min: Math.min(...eu), max: Math.max(...eu) });
    })));
}

test("values of different kinds order as one sequence: booleans, numbers, strings, then null", () =>
  Effect.runPromise(Effect.gen(function* () {
    const store = yield* makeMemoryStore("acme");
    const values = ["b", 2.5, null, true, -1, "a", false, 0];
    yield* Effect.forEach(values, (value, i) =>
      store.transact((txn) => txn.put(asSeq(i + 1), enc.encode("{}"), manifest([["v", value]]))), { discard: true });
    const page = yield* store.ordered({ column: "v" });
    assert.deepEqual(page.rows.map((row) => row.value), [false, true, -1, 0, 2.5, "a", "b", null]);
    assert.deepEqual(yield* resolved(store, gte("v", "a")), [1, 6]);
    // One bound keeps a range within its kind: numbers below zero, not false or true.
    assert.deepEqual(yield* resolved(store, lt("v", 0)), [5]);
    assert.deepEqual(yield* resolved(store, gt("v", 0)), [2]);
    // Two bounds of different kinds span every kind between them, null included.
    assert.deepEqual(yield* resolved(store, between("v", 2.5, null)), [1, 2, 3, 6]);
    // Null is not a value to take the extent of.
    assert.deepEqual(yield* store.extent("v"), { min: false, max: "b" });
  })));

test("a cursor continues only the read it came from", () =>
  Effect.runPromise(Effect.gen(function* () {
    const store = yield* makeMemoryStore("acme");
    const other = yield* makeMemoryStore("globex");
    yield* seed(store);
    yield* seed(other);
    const { next } = yield* store.ordered({ column: "price", limit: 3 });
    assert.ok(next !== undefined);
    const failure = (effect) => Effect.map(Effect.flip(effect), (error) => error._tag);
    assert.equal(yield* failure(other.ordered({ column: "price", after: next })), "ForeignCursor");
    assert.equal(yield* failure(store.ordered({ column: "price", direction: "desc", after: next })), "CursorMismatch");
    assert.equal(yield* failure(store.ordered({ column: "region", after: next })), "CursorMismatch");
    assert.equal(yield* failure(store.ordered({ column: "price", after: "not-a-cursor" })), "CursorMismatch");
  })));

test("a range query is data: it round-trips through its schema", () => {
  const query = and(equals("region", "eu"), between("price", 3, 6), gt("name", "m"));
  const decoded = Schema.decodeUnknownSync(Query)(JSON.parse(JSON.stringify(query)));
  assert.deepEqual(decoded, query);
});

test("a store written in an older layout is re-indexed when it opens", () =>
  Effect.runPromise(Effect.gen(function* () {
    const engine = memoryKvEngine();
    yield* seed(yield* openStoreOverKv("acme", engine));
    // An older layout: no format marker, and a posting under the retired equality tag.
    yield* engine.write([
      { op: "delete", key: metaKey("format") },
      { op: "put", key: Uint8Array.of(Tag.Column, 1, 2, 3), value: new Uint8Array(0) },
    ]);
    const reopened = yield* openStoreOverKv("acme", engine);
    const stray = [...(yield* Stream.runCollect(engine.scan(Uint8Array.of(Tag.Column))))];
    assert.equal(stray.length, 0, "the retired lens was left behind");
    assert.deepEqual(yield* resolved(reopened, between("price", 3, 6)), where((s) => priceOf(s) >= 3 && priceOf(s) <= 6));
    assert.deepEqual(yield* resolved(reopened, equals("region", "eu")), where((s) => regionOf(s) === "eu"));
  })));
