// Windowed resolution: a page after a cursor, or the first few matches, costs
// about what it returns rather than the whole match.
//
// Reading a window of identifiers at a time must give exactly the answer the
// whole match gives, cut at the same place. So seeded data spread over several
// sealed segments — sealed and live tiers, updates and tombstones in play —
// and seeded queries run at windows of one, eight and 4096 identifiers, paged
// through at random sizes; every page must be the whole answer's next slice.
// Then counted reads show what the window is for: a page deep into a large
// collection reads about the cap and the page.
import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Stream } from "effect";
import { and, documentsFor, edge, equals, or, partitionKeys, Tag, term, termPrefixQuery } from "../dist/db/index.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { openShardOverKv } from "../dist/db/kv-store.js";

const enc = new TextEncoder();
const run = (body) => Effect.runPromise(Effect.scoped(body));
const ids = (stream) => Effect.map(Stream.runCollect(stream), (chunk) => [...chunk].map(Number));

const rnd = (seed) => () =>
  ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >>> 0) / 0x80000000;

const WORDS = ["atlas", "atlantic", "beacon", "cobalt", "delta", "ember"];
const SCORES = [-5, -1, 0, 1, 2.5, 5, "", "a", "ab", "b", false, true, null];
const REGIONS = ["eu", "us", "ap", "sa"];

const partitionWith = (probeCap, engine = memoryKvEngine()) =>
  Effect.map(openShardOverKv("s0", engine, { probeCap }), (shard) => shard.partition("acme"));

const manifestFor = (rand, seqs) => {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const words = [...new Set(Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(WORDS)))];
  return {
    terms: words.map((word) => ["title", word]),
    columns: [["score", pick(SCORES)], ["region", pick(REGIONS)]],
    measures: [],
    edges: Array.from({ length: Math.floor(rand() * 3) }, () => ["uses", pick(seqs)]),
  };
};

const leaf = (rand, seqs) => {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const bound = () => ({ value: pick(SCORES), inclusive: rand() < 0.5 });
  switch (Math.floor(rand() * 8)) {
    case 0: return term("title", pick(WORDS));
    case 1: return termPrefixQuery("title", pick(["at", "a", "b", "e", "z"]));
    case 2: return equals("score", pick(SCORES));
    case 3: return equals("region", pick(REGIONS));
    case 4: return { _tag: "Range", column: "score", lower: bound() };
    case 5: return { _tag: "Range", column: "score", lower: bound(), upper: bound() };
    case 6: return equals("region", pick(REGIONS));
    default: return edge("uses", pick(seqs), rand() < 0.5 ? "outbound" : "inbound");
  }
};

const queryFor = (rand, seqs, depth = 0) => {
  if (depth >= 2 || rand() < 0.35) return leaf(rand, seqs);
  const parts = Array.from({ length: 2 + Math.floor(rand() * 2) }, () => queryFor(rand, seqs, depth + 1));
  return rand() < 0.6 ? and(...parts) : or(...parts);
};

test("every window and page size gives the whole answer's slices, in order", () => run(Effect.gen(function* () {
  const rand = rnd(20261022);
  // Identifiers across four segments, with runs and long gaps between them:
  // dense enough in the first two that the shared values are sealed into blobs
  // (a value needs 64 postings in a segment), while the rare ones stay live.
  const seqs = [...new Set([
    ...Array.from({ length: 700 }, (_, i) => i + 1),
    ...Array.from({ length: 300 }, (_, i) => 65_400 + i),
    ...Array.from({ length: 200 }, () => 1 + Math.floor(rand() * 250_000)),
  ])].sort((a, b) => a - b);
  const manifests = new Map(seqs.map((seq) => [seq, manifestFor(rand, seqs)]));
  const stores = [yield* partitionWith(1), yield* partitionWith(8), yield* partitionWith(4096)];
  const apply = (f) => Effect.forEach(stores, (store) => store.transact(f), { discard: true });

  const half = Math.floor(seqs.length / 2);
  for (const seq of seqs.slice(0, half)) yield* apply((txn) => txn.put(seq, enc.encode("{}"), manifests.get(seq)));
  // Sealed blobs, then live writes, updates and retractions over them.
  const seals = yield* Effect.forEach(stores, (store) => store.sealPostings);
  assert.ok(seals.every((seal) => seal.segments > 0), "the shared values are sealed, so blobs and their tombstones are in play");
  for (const seq of seqs.slice(half)) yield* apply((txn) => txn.put(seq, enc.encode("{}"), manifests.get(seq)));
  for (let i = 0; i < 200; i++) {
    const seq = seqs[Math.floor(rand() * seqs.length)];
    if (rand() < 0.5) {
      yield* apply((txn) => txn.retract(seq));
      continue;
    }
    // Drawn once, outside the callback: every store must hold the same data.
    const changed = manifestFor(rand, seqs);
    yield* apply((txn) => txn.put(seq, enc.encode("{}"), changed));
  }

  for (let q = 0; q < 120; q++) {
    const query = queryFor(rand, seqs);
    const whole = yield* ids(stores[2].resolve(query));
    for (const store of stores) {
      const label = `query ${q}: ${JSON.stringify(query)}`;
      assert.deepEqual(yield* ids(store.resolve(query, {})), whole, `${label}, from the start`);
      // Paged through at a random size, each page from the last identifier.
      const size = 1 + Math.floor(rand() * 60);
      const paged = [];
      let after;
      for (;;) {
        const page = yield* ids(store.resolve(query, { ...(after === undefined ? {} : { after }), limit: size }));
        assert.ok(page.length <= size, label);
        if (page.length === 0) break;
        paged.push(...page);
        after = page.at(-1);
      }
      assert.deepEqual(paged, whole, `${label}, paged by ${size}`);
      // From an arbitrary point, held or not.
      const from = Math.floor(rand() * 260_000);
      assert.deepEqual(yield* ids(store.resolve(query, { after: from })), whole.filter((seq) => seq > from), `${label}, after ${from}`);
    }
  }
})));

/** An engine that counts what it reads: every get, and every entry a scan yields. */
const counting = () => {
  const base = memoryKvEngine();
  const counter = { reads: 0, records: 0 };
  const recordTag = partitionKeys("acme").tag(Tag.Record);
  const isRecord = (key) => key.length > recordTag.length && recordTag.every((byte, i) => key[i] === byte);
  const engine = {
    ...base,
    get: (key) => {
      counter.reads += 1;
      if (isRecord(key)) counter.records += 1;
      return base.get(key);
    },
    scan: (prefix, options) => Stream.tap(base.scan(prefix, options), (entry) => Effect.sync(() => {
      counter.reads += 1;
      if (isRecord(entry.key)) counter.records += 1;
    })),
  };
  return { engine, counter };
};

test("a page deep into a large match reads about the cap and the page, not the match", () => run(Effect.gen(function* () {
  const { engine, counter } = counting();
  const store = yield* partitionWith(64, engine);
  const manifest = { terms: [], columns: [["kind", "post"]], measures: [], edges: [] };
  const COUNT = 20_000;
  for (let first = 1; first <= COUNT; first += 500) {
    yield* store.transact((txn) => Effect.forEach(
      Array.from({ length: 500 }, (_, i) => first + i),
      (seq) => txn.put(seq, enc.encode("{}"), manifest),
      { discard: true },
    ));
    if (first === 10_001) yield* store.sealPostings;
  }

  counter.reads = 0;
  const page = yield* ids(store.resolve(equals("kind", "post"), { after: 15_000, limit: 10 }));
  assert.deepEqual(page, Array.from({ length: 10 }, (_, i) => 15_001 + i));
  const paged = counter.reads;
  assert.ok(paged < 200, `the page read ${paged} keys`);

  // The same answer resolved whole reads every live posting, which is what the
  // window saves.
  counter.reads = 0;
  const whole = yield* ids(store.resolve(equals("kind", "post")));
  assert.equal(whole.length, COUNT);
  assert.ok(counter.reads > paged * 20, `resolving the whole match read ${counter.reads} against the page's ${paged}`);
})));

test("findMany with a limit and a deep findPage read the documents they return, not the collection", () => run(Effect.gen(function* () {
  const { engine, counter } = counting();
  const store = yield* partitionWith(64, engine);
  const docs = documentsFor(store, "acme");
  yield* docs.createCollection({ name: "posts" });
  const COUNT = 3_000;
  for (let first = 0; first < COUNT; first += 300) {
    yield* docs.write({
      operations: Array.from({ length: 300 }, (_, i) => ({
        _tag: "Insert", collection: "posts", id: `p${String(first + i).padStart(5, "0")}`, data: { n: first + i },
      })),
    });
  }

  counter.reads = 0;
  counter.records = 0;
  const few = yield* docs.findMany({ collection: "posts", limit: 5 });
  assert.equal(few.length, 5);
  assert.ok(counter.records < 20, `findMany read ${counter.records} records for five documents`);

  let cursor;
  for (let read = 0; read < 2_500; read += 500) {
    cursor = (yield* docs.findPage({ collection: "posts", limit: 500, ...(cursor === undefined ? {} : { after: cursor }) })).next;
  }
  counter.reads = 0;
  counter.records = 0;
  const deep = yield* docs.findPage({ collection: "posts", limit: 10, after: cursor });
  assert.deepEqual(deep.documents.map((doc) => doc.data.n), Array.from({ length: 10 }, (_, i) => 2_500 + i));
  assert.ok(counter.records < 25, `the deep page read ${counter.records} records`);
  assert.ok(counter.reads < 600, `the deep page read ${counter.reads} keys in all`);
})));
