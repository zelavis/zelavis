/**
 * Search past single words: phrases answered from word-pair postings,
 * synonyms, relevance that means the same across partitions, and hybrid
 * text/vector/structured ranking — each held to an exact baseline computed
 * here from the documents themselves.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { makeDatabase, partitionMapFor } from "../dist/db/index.js";
import { makeMemoryStore } from "../dist/db/engines/memory-kv.js";

const run = (body) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const db = yield* makeDatabase({ partitionMap: partitionMapFor(["s0", "s1"]), openShard: (shard) => makeMemoryStore(shard) });
  return yield* body(db);
})));

const words = ["quick", "brown", "fox", "lazy", "dog", "jumps", "over", "red", "car", "automobile", "fast", "slow"];
/** Deterministic text: a seeded walk over the vocabulary. */
const sentence = (n) => {
  let state = n * 7919 + 13;
  const out = [];
  for (let i = 0; i < 6 + (n % 5); i++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out.push(words[state % words.length]);
  }
  return out.join(" ");
};
const tokens = (text) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
const hasPhrase = (text, phrase) => {
  const t = tokens(text), p = tokens(phrase);
  for (let i = 0; i + p.length <= t.length; i++) if (p.every((w, j) => t[i + j] === w)) return true;
  return false;
};
const ids = (docs) => docs.map((doc) => doc.id).sort();

test("phrases are answered from word-pair postings, exactly", () => run((db) => Effect.gen(function* () {
  const { documents } = db.forTenant("acme");
  yield* documents.createCollection({ name: "notes", analyzer: { fields: ["body"], version: 1, phrases: true } });
  const texts = new Map();
  for (let n = 0; n < 300; n++) {
    texts.set(`n${n}`, sentence(n));
    yield* documents.insert({ collection: "notes", id: `n${n}`, data: { body: sentence(n) } });
  }
  for (const phrase of ["quick fox", "fox quick", "lazy dog jumps", "red car", "brown"]) {
    const found = yield* documents.findMany({ collection: "notes", search: `"${phrase}"` });
    const expected = [...texts].filter(([, text]) => hasPhrase(text, phrase)).map(([id]) => id).sort();
    assert.deepEqual(ids(found), expected, `"${phrase}"`);
  }
  // Order matters: a pair posting is the two words in that order.
  const forward = yield* documents.findMany({ collection: "notes", search: '"quick fox"' });
  const backward = yield* documents.findMany({ collection: "notes", search: '"fox quick"' });
  assert.notDeepEqual(ids(forward), ids(backward));
  // Without pairs posted, the same phrases still answer the same (checked per document).
  yield* documents.analyze({ collection: "notes", analyzer: { fields: ["body"], version: 2 } });
  for (const phrase of ["quick fox", "lazy dog jumps"]) {
    const found = yield* documents.findMany({ collection: "notes", search: `"${phrase}"` });
    assert.deepEqual(ids(found), [...texts].filter(([, text]) => hasPhrase(text, phrase)).map(([id]) => id).sort());
  }
})));

test("synonyms widen the query, never what is stored", () => run((db) => Effect.gen(function* () {
  const { documents } = db.forTenant("acme");
  yield* documents.createCollection({ name: "ads", analyzer: { fields: ["title"], version: 1, synonyms: [["car", "automobile", "auto"]] } });
  yield* documents.insert({ collection: "ads", id: "a", data: { title: "red car for sale" } });
  yield* documents.insert({ collection: "ads", id: "b", data: { title: "vintage automobile" } });
  yield* documents.insert({ collection: "ads", id: "c", data: { title: "bicycle" } });
  assert.deepEqual(ids(yield* documents.findMany({ collection: "ads", search: "auto" })), ["a", "b"]);
  assert.deepEqual(ids(yield* documents.findMany({ collection: "ads", search: "car" })), ["a", "b"]);
  const scored = yield* documents.findMany({ collection: "ads", search: "automobile" });
  assert.ok(scored.every((doc) => doc.score > 0), "a synonym's match is scored as the word's");
  // Changing synonyms rewrites nothing and takes effect at once.
  yield* documents.analyze({ collection: "ads", analyzer: { fields: ["title"], version: 2 } });
  assert.deepEqual(ids(yield* documents.findMany({ collection: "ads", search: "auto" })), []);
  const refused = yield* documents.analyze({
    collection: "ads", analyzer: { fields: ["title"], version: 3, synonyms: [["car", "motor car"]] },
  }).pipe(Effect.flip);
  assert.equal(refused._tag, "InvalidConstraint");
  assert.match(refused.reason, /"motor car" is not one word/);
})));

test("dictionary names cannot become inherited BM25 statistics", () => run((db) => Effect.gen(function* () {
  for (const tenant of ["a", "b"]) {
    const docs = db.forTenant(tenant).documents;
    yield* docs.createCollection({ name: "notes", analyzer: { fields: ["body"], version: 1 } });
    yield* docs.insert({ collection: "notes", id: "n", data: { body: "constructor" } });
  }
  const scattered = yield* db.scatter.findMany({ collection: "notes", tenants: ["a", "b"], search: "constructor" });
  assert.equal(scattered.rows.length, 2);
  assert.ok(scattered.rows.every(row => Number.isFinite(row.document.score) && row.document.score > 0));
  const local = yield* db.forTenant("a").documents.findMany({ collection: "notes", search: "constructor", statistics: { documents: 2, length: 2, frequencies: {} } });
  assert.ok(Number.isFinite(local[0].score));
})));

test("a ranked scatter orders matches as one partition holding all of them would", () => run((db) => Effect.gen(function* () {
  const tenants = ["t1", "t2", "t3", "t4"];
  const analyzer = { fields: ["body"], version: 1 };
  const all = db.forTenant("everything");
  yield* all.documents.createCollection({ name: "notes", analyzer });
  for (const tenant of tenants) yield* db.forTenant(tenant).documents.createCollection({ name: "notes", analyzer });
  for (let n = 0; n < 200; n++) {
    const data = { body: sentence(n) };
    yield* all.documents.insert({ collection: "notes", id: `n${n}`, data });
    yield* db.forTenant(tenants[n % tenants.length]).documents.insert({ collection: "notes", id: `n${n}`, data });
  }
  assert.ok(new Set(tenants.map((tenant) => db.shardOf(tenant))).size > 1, "the tenants span shards");
  let differed = 0;
  for (const search of ["fox", "quick dog", "red car fast"]) {
    const baseline = yield* all.documents.findMany({ collection: "notes", search });
    const scattered = yield* db.scatter.findMany({ collection: "notes", tenants, search, limit: 25 });
    assert.deepEqual(scattered.rows.map((row) => row.document.score), baseline.slice(0, 25).map((doc) => doc.score), `${search}: the same scores in the same order`);
    const baselineIds = new Map(baseline.map((doc) => [doc.id, doc.score]));
    for (const row of scattered.rows) assert.equal(row.document.score, baselineIds.get(row.document.id), `${search}: ${row.document.id} scores as it would in one partition`);
    // Merging each tenant's own scores instead would not be the same order:
    // a tenant's corpus is smaller, so its idf and lengths are its own.
    const naive = [];
    for (const tenant of tenants) naive.push(...(yield* db.forTenant(tenant).documents.findMany({ collection: "notes", search })));
    naive.sort((a, b) => b.score - a.score);
    if (naive.slice(0, 25).map((doc) => doc.id).join() !== baseline.slice(0, 25).map((doc) => doc.id).join()) differed += 1;
  }
  assert.ok(differed > 0, "local scores merged would have ranked differently");
})));

test("hybrid search fuses text and vector ranks exactly as the baseline does, under a structured filter", () => run((db) => Effect.gen(function* () {
  const { documents } = db.forTenant("acme");
  yield* documents.createCollection({
    name: "items",
    analyzer: { fields: ["body"], version: 1 },
    embedding: { field: "e", dimension: 4, metric: "euclidean", version: 1 },
  });
  const data = new Map();
  for (let n = 0; n < 400; n++) {
    const value = { body: sentence(n), color: n % 3 === 0 ? "red" : "blue", e: [Math.sin(n), Math.cos(n), (n % 7) / 7, (n % 11) / 11] };
    data.set(`i${n}`, value);
    yield* documents.insert({ collection: "items", id: `i${n}`, data: value });
  }
  const probe = [0.3, -0.2, 0.5, 0.1];
  const where = [{ path: "color", value: "red" }];
  const k = 60, depth = 50;
  // The baseline: BM25 ranks from a text-only read, exact distances computed here, fused here.
  const text = (yield* documents.findMany({ collection: "items", search: "quick fox", where })).slice(0, depth);
  const distance = (a, b) => Math.hypot(...a.map((x, i) => x - b[i]));
  const vector = [...data].filter(([, v]) => v.color === "red")
    .sort(([a, x], [b, y]) => distance(x.e, probe) - distance(y.e, probe) || (a < b ? -1 : 1)).slice(0, depth).map(([id]) => id);
  const textRank = new Map(text.map((doc, at) => [doc.id, at + 1]));
  const vectorRank = new Map(vector.map((id, at) => [id, at + 1]));
  const fusedScore = (id, wt, wv) => (textRank.has(id) ? wt / (k + textRank.get(id)) : 0) + (vectorRank.has(id) ? wv / (k + vectorRank.get(id)) : 0);
  const baseline = (wt, wv) => [...new Set([...textRank.keys(), ...vectorRank.keys()])]
    .sort((a, b) => fusedScore(b, wt, wv) - fusedScore(a, wt, wv) || (textRank.get(a) ?? Infinity) - (textRank.get(b) ?? Infinity)
      || (vectorRank.get(a) ?? Infinity) - (vectorRank.get(b) ?? Infinity) || (a < b ? -1 : 1));

  for (const [wt, wv] of [[1, 1], [2, 0.5], [0, 1]]) {
    const hybrid = yield* documents.findMany({
      collection: "items", search: "quick fox", where,
      similar: { field: "e", vector: probe, approximate: false },
      hybrid: { text: wt, vector: wv, k, depth }, limit: 20,
    });
    const expected = baseline(wt, wv).slice(0, 20);
    assert.deepEqual(hybrid.map((doc) => doc.id), expected, `weights ${wt}/${wv}`);
    assert.ok(hybrid.every((doc) => doc.data.color === "red"), "the structured filter holds on both rankings");
    for (const doc of hybrid) assert.equal(doc.score, fusedScore(doc.id, wt, wv));
  }
  // Approximate similarity keeps most of the exact answer.
  const approximate = yield* documents.findMany({
    collection: "items", search: "quick fox", where, similar: { field: "e", vector: probe, approximate: true },
    hybrid: { k, depth }, limit: 20,
  });
  const exact = new Set(baseline(1, 1).slice(0, 20));
  const recall = approximate.filter((doc) => exact.has(doc.id)).length / 20;
  assert.ok(recall >= 0.8, `recall@20 ${recall}`);
})));
