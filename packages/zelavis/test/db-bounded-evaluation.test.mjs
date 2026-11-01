// Bounded evaluation: a broad clause is checked per candidate, never read in full
// while a narrow one can drive the query.
//
// Checking a record's manifest has to give exactly the answer the lenses give,
// or the same query answers differently depending on how wide its clauses
// happen to be. So the same seeded data and queries run with a cap of one —
// nearly every clause broad — a cap of eight, and the default, where these
// clauses all fit; every answer must agree. Then a selective query over a wide
// range shows what the bound is for: it reads about the cap, not the range.
import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Stream } from "effect";
import { and, between, edge, equals, gt, gte, lt, lte, or, term, termPrefixQuery } from "../dist/db/index.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { openShardOverKv } from "../dist/db/kv-store.js";

const enc = new TextEncoder();
const run = (body) => Effect.runPromise(Effect.scoped(body));

const rnd = (seed) => () =>
  ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >>> 0) / 0x80000000;

const WORDS = ["atlas", "atlantic", "beacon", "cobalt", "delta", "ember"];
const SCORES = [-5, -1, 0, 1, 2.5, 5, "", "a", "ab", "b", false, true, null];
const REGIONS = ["eu", "us", "ap", "sa"];

const partitionWith = (probeCap) =>
  Effect.map(openShardOverKv("s0", memoryKvEngine(), { probeCap }), (shard) => shard.partition("acme"));

const manifestFor = (rand, count) => {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const words = [...new Set(Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(WORDS)))];
  const scores = [...new Set(Array.from({ length: rand() < 0.2 ? 2 : 1 }, () => pick(SCORES)))];
  return {
    terms: words.map((word) => ["title", word]),
    columns: [...scores.map((score) => ["score", score]), ["region", pick(REGIONS)]],
    measures: [],
    edges: Array.from({ length: Math.floor(rand() * 3) }, () => ["uses", 1 + Math.floor(rand() * count)]),
  };
};

const leaf = (rand, count) => {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const bound = () => ({ value: pick(SCORES), inclusive: rand() < 0.5 });
  switch (Math.floor(rand() * 8)) {
    case 0: return term("title", pick(WORDS));
    case 1: return termPrefixQuery("title", pick(["at", "a", "b", "e", "z"]));
    case 2: return equals("score", pick(SCORES));
    case 3: return equals("region", pick(REGIONS));
    case 4: return { _tag: "Range", column: "score", lower: bound() };
    case 5: return { _tag: "Range", column: "score", upper: bound() };
    case 6: return { _tag: "Range", column: "score", lower: bound(), upper: bound() };
    default: return edge("uses", 1 + Math.floor(rand() * count), rand() < 0.5 ? "outbound" : "inbound");
  }
};

const queryFor = (rand, count, depth = 0) => {
  if (depth >= 2 || rand() < 0.35) return leaf(rand, count);
  const parts = Array.from({ length: 2 + Math.floor(rand() * 2) }, () => queryFor(rand, count, depth + 1));
  return rand() < 0.6 ? and(...parts) : or(...parts);
};

test("every cap gives the answer the lenses give", () => run(Effect.gen(function* () {
  const rand = rnd(20261021);
  const count = 300;
  const stores = [yield* partitionWith(1), yield* partitionWith(8), yield* partitionWith(4096)];
  const manifests = Array.from({ length: count }, () => manifestFor(rand, count));
  const apply = (f) => Effect.forEach(stores, (store) => store.transact(f), { discard: true });

  for (let seq = 1; seq <= 200; seq++) {
    yield* apply((txn) => txn.put(seq, enc.encode(`{"n":${seq}}`), manifests[seq - 1]));
  }
  // Sealed blobs, then live writes, updates and retractions over them: tombstones in play.
  const seals = yield* Effect.forEach(stores, (store) => store.sealPostings);
  assert.ok(seals.every((seal) => seal.segments > 0), `sealed ${JSON.stringify(seals)}`);
  for (let seq = 201; seq <= count; seq++) {
    yield* apply((txn) => txn.put(seq, enc.encode(`{"n":${seq}}`), manifests[seq - 1]));
  }
  for (let i = 0; i < 40; i++) {
    const seq = 1 + Math.floor(rand() * count);
    if (rand() < 0.5) {
      yield* apply((txn) => txn.retract(seq));
    } else {
      const manifest = manifestFor(rand, count);
      yield* apply((txn) => txn.put(seq, enc.encode(`{"n":${seq}}`), manifest));
    }
  }

  const resolved = (store, query) => Effect.map(Stream.runCollect(store.resolve(query)), (c) => [...c].map(Number));
  const ordered = (store, where, direction) =>
    Effect.map(store.ordered({ column: "score", where, direction, limit: 1000 }), (page) =>
      page.rows.map((row) => [Number(row.seq), row.value]));

  for (let i = 0; i < 150; i++) {
    const query = queryFor(rand, count);
    const label = JSON.stringify(query);
    const exact = yield* resolved(stores[2], query);
    for (const store of stores.slice(0, 2)) {
      assert.deepEqual(yield* resolved(store, query), exact, `resolve ${label}`);
    }
    if (i % 3 === 0) {
      const direction = rand() < 0.5 ? "asc" : "desc";
      const rows = yield* ordered(stores[2], query, direction);
      const extent = yield* stores[2].extent("score", query);
      for (const store of stores.slice(0, 2)) {
        assert.deepEqual(yield* ordered(store, query, direction), rows, `ordered ${label}`);
        assert.deepEqual(yield* store.extent("score", query), extent, `extent ${label}`);
      }
    }
  }
})));

test("a selective query over a wide range reads about the cap, not the range", () => run(Effect.gen(function* () {
  const counted = (probeCap) => Effect.gen(function* () {
    const base = memoryKvEngine();
    const reads = { scanned: 0 };
    const engine = {
      ...base,
      scan: (prefix, options) => Stream.tap(base.scan(prefix, options), () => Effect.sync(() => { reads.scanned += 1; })),
    };
    const store = (yield* openShardOverKv("s0", engine, { probeCap })).partition("acme");
    for (let seq = 1; seq <= 2000; seq++) {
      yield* store.transact((txn) => txn.put(seq, enc.encode("{}"), {
        terms: [], measures: [], edges: [],
        columns: [["createdAt", seq], ["status", seq % 400 === 0 ? "rare" : "common"]],
      }));
    }
    reads.scanned = 0;
    const found = [...(yield* Stream.runCollect(store.resolve(and(equals("status", "rare"), gt("createdAt", 0)))))].map(Number);
    return { found, scanned: reads.scanned };
  });

  const bounded = yield* counted(64);
  const full = yield* counted(1_000_000);
  assert.deepEqual(bounded.found, [400, 800, 1200, 1600, 2000]);
  assert.deepEqual(full.found, bounded.found);
  assert.ok(full.scanned >= 2000, `read in full, the range costs every posting (${full.scanned})`);
  assert.ok(bounded.scanned < 200, `bounded, it costs about the cap (${bounded.scanned})`);
})));

test("an ordered read with a broad filter checks rows instead of reading the filter", () => run(Effect.gen(function* () {
  const store = yield* partitionWith(4);
  for (let seq = 1; seq <= 50; seq++) {
    yield* store.transact((txn) => txn.put(seq, enc.encode("{}"), {
      terms: [], measures: [], edges: [],
      columns: [["price", seq], ["region", seq % 5 === 0 ? "ap" : "eu"]],
    }));
  }
  // "eu" is far past the cap, so the filter is checked row by row.
  const page = yield* store.ordered({ column: "price", where: equals("region", "eu"), direction: "desc", limit: 3 });
  assert.deepEqual(page.rows.map((row) => Number(row.seq)), [49, 48, 47]);
  const narrow = yield* store.ordered({ column: "price", where: and(equals("region", "ap"), lte("price", 20)), limit: 10 });
  assert.deepEqual(narrow.rows.map((row) => Number(row.seq)), [5, 10, 15, 20]);
  assert.deepEqual(yield* store.extent("price", or(equals("region", "ap"), between("price", 1, 2))), { min: 1, max: 50 });
  assert.deepEqual(yield* store.extent("price", and(gte("price", 10), lt("price", 13), equals("region", "eu"))), { min: 11, max: 12 });
})));
