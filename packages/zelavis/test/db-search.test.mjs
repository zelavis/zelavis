// Search: text becomes terms by a rule the collection declares, and a query
// is analyzed the same way before it asks.
//
// The terms already written are what a search reads, so these pin both halves:
// what analysis produces, and that a change to it rewrites what was produced
// under the old rule. Deletion matters as much as matching — a term left
// behind by a deleted document is a row that no longer exists.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { documentsFor } from "../dist/db/index.js";
import { makeMemoryStore } from "../dist/db/engines/memory-kv.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const engines = [
  ["memory", () => makeMemoryStore("acme")],
  ["sqlite", (dir) => makeNodeSqliteStore("acme", dir)],
];

const ANALYZER = {
  fields: ["title", "body"],
  version: 1,
  stopWords: ["the", "and"],
};

const ROWS = [
  ["a", { title: "The Quick Brown Fox", body: "jumps over the lazy dog", tier: "free" }],
  ["b", { title: "Brown bread", body: "and butter", tier: "paid" }],
  ["c", { title: "Café life", body: "a quick coffee", tier: "paid" }],
  ["d", { title: "Nothing here", body: "", tier: "free" }],
];

for (const [engine, open] of engines) {
  const setup = (t, body, { analyzer = ANALYZER } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), `zv-search-${engine}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* open(dir);
      const docs = documentsFor(store, "t1");
      yield* docs.createCollection({ name: "posts", ...(analyzer === undefined ? {} : { analyzer }) });
      for (const [id, data] of ROWS) yield* docs.insert({ collection: "posts", id, data });
      return yield* body(docs, store);
    })));
  };
  const found = (docs, input) =>
    Effect.map(docs.findMany({ collection: "posts", ...input }), (all) => all.map((d) => d.id).sort());
  const tagOf = (effect) => Effect.map(Effect.flip(effect), (error) => error._tag);

  test(`${engine}: a search reads the terms the analyzer produced`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      // Folded, so case does not matter, and every analyzed field counts.
      assert.deepEqual(yield* found(docs, { search: "brown" }), ["a", "b"]);
      assert.deepEqual(yield* found(docs, { search: "BROWN" }), ["a", "b"]);
      assert.deepEqual(yield* found(docs, { search: "quick" }), ["a", "c"], "title or body, either counts");

      // Every word must appear: the words are intersected.
      assert.deepEqual(yield* found(docs, { search: "quick brown" }), ["a"]);
      assert.deepEqual(yield* found(docs, { search: "quick bread" }), []);

      // Stop words are dropped from the text and from the query alike.
      assert.deepEqual(yield* found(docs, { search: "the" }), [], "a query of only stop words asks for nothing");
      assert.deepEqual(yield* found(docs, { search: "the brown" }), ["a", "b"]);

      // Accents are normalized, not stripped: café is not cafe.
      assert.deepEqual(yield* found(docs, { search: "café" }), ["c"]);
      assert.deepEqual(yield* found(docs, { search: "cafe" }), []);

      // A search is one more set, so it intersects with ordinary filters.
      assert.deepEqual(yield* found(docs, { search: "brown", where: [{ path: "tier", value: "paid" }] }), ["b"]);
      assert.deepEqual(yield* found(docs, { search: "missing" }), []);
    })));

  test(`${engine}: a page searches the same way, and an unanalyzed collection says so`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      const page = yield* docs.findPage({ collection: "posts", search: "brown", limit: 1 });
      assert.equal(page.documents.length, 1);
      assert.ok(page.next, "a searched page continues like any other");
      const walked = [...page.documents.map((d) => d.id)];
      const rest = yield* docs.findPage({ collection: "posts", search: "brown", limit: 1, after: page.next });
      walked.push(...rest.documents.map((d) => d.id));
      assert.deepEqual(walked.sort(), ["a", "b"]);

      const empty = yield* docs.findPage({ collection: "posts", search: "the" });
      assert.deepEqual([empty.documents, empty.next], [[], undefined]);

      // A collection nobody declared an analyzer for has no terms, and saying
      // "no matches" would be a lie about an unasked question.
      yield* docs.createCollection({ name: "plain" });
      assert.equal(yield* tagOf(docs.findMany({ collection: "plain", search: "brown" })), "UnanalyzedCollection");
      assert.equal(yield* tagOf(docs.findPage({ collection: "plain", search: "brown" })), "UnanalyzedCollection");
    })));

  test(`${engine}: terms follow the document through updates and deletes`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      // The old terms go with the old version, or a search answers with a
      // document that no longer says what it matched on.
      yield* docs.update({ collection: "posts", id: "b", data: { title: "Green bread" } });
      assert.deepEqual(yield* found(docs, { search: "brown" }), ["a"]);
      assert.deepEqual(yield* found(docs, { search: "green" }), ["b"]);

      yield* docs.delete({ collection: "posts", id: "a" });
      assert.deepEqual(yield* found(docs, { search: "brown" }), []);
      assert.deepEqual(yield* found(docs, { search: "quick" }), ["c"]);
    })));

  test(`${engine}: changing the analyzer rewrites what was written under the old one`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      assert.deepEqual(yield* found(docs, { search: "the" }), [], "a stop word, for now");

      // Keep the same words, stop dropping "the", and raise the version.
      const changed = yield* docs.analyze({
        collection: "posts",
        analyzer: { fields: ["title", "body"], version: 2, stopWords: [] },
      });
      assert.equal(changed.documents, ROWS.length, "every document was written back");
      assert.deepEqual(yield* found(docs, { search: "the" }), ["a"], "and the term exists now");

      // Narrowing the analyzed fields takes the body's terms away with it.
      yield* docs.analyze({ collection: "posts", analyzer: { fields: ["title"], version: 3 } });
      assert.deepEqual(yield* found(docs, { search: "brown" }), ["a", "b"], "titles still match");
      assert.deepEqual(yield* found(docs, { search: "butter" }), [], "bodies are no longer analyzed");

      const invalid = yield* Effect.flip(docs.analyze({
        collection: "posts", analyzer: { fields: [], version: 4 },
      }));
      assert.equal(invalid._tag, "InvalidConstraint");
      assert.equal(yield* tagOf(docs.analyze({
        collection: "nowhere", analyzer: { fields: ["title"], version: 1 },
      })), "CollectionNotFound");
    })));

  test(`${engine}: sealing leaves a search answering as it did`, (t) =>
    setup(t, (docs, store) => Effect.gen(function* () {
      const before = yield* found(docs, { search: "brown" });
      yield* store.sealPostings;
      assert.deepEqual(yield* found(docs, { search: "brown" }), before);
      // A write after the seal lands in the live tier beside the blobs.
      yield* docs.insert({ collection: "posts", id: "e", data: { title: "Brown study", body: "" } });
      assert.deepEqual(yield* found(docs, { search: "brown" }), ["a", "b", "e"]);
      yield* docs.delete({ collection: "posts", id: "b" });
      assert.deepEqual(yield* found(docs, { search: "brown" }), ["a", "e"], "a tombstone removes it from a blob");
    })));
}
