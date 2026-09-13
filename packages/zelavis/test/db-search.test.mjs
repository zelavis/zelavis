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

  test(`${engine}: BM25 relevance scores and orders search results by relevance`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      // Document "b" ("Brown bread and butter") has length 3 and contains "brown" once.
      // Document "a" ("The Quick Brown Fox jumps over the lazy dog") has length 7 and contains "brown" once.
      // Under BM25 length normalization, shorter document "b" is more concentrated on "brown" and ranks first.
      const ranked = yield* docs.findMany({ collection: "posts", search: "brown" });
      assert.equal(ranked.length, 2);
      assert.equal(ranked[0].id, "b");
      assert.equal(ranked[1].id, "a");
      assert.ok(typeof ranked[0].score === "number" && ranked[0].score > 0);
      assert.ok(typeof ranked[1].score === "number" && ranked[1].score > 0);
      assert.ok(ranked[0].score >= ranked[1].score, "shorter document with same term count scores higher");

      // Term frequency boost: inserting a document with multiple occurrences
      yield* docs.insert({
        collection: "posts",
        id: "repeat",
        data: { title: "Brown brown brown", body: "brown fox", tier: "paid" },
      });
      const repeated = yield* docs.findMany({ collection: "posts", search: "brown" });
      assert.equal(repeated[0].id, "repeat", "multiple term occurrences rank highest");
      assert.ok(repeated[0].score > repeated[1].score);

      // Explicit orderBy overrides score ranking while preserving search filter
      const explicit = yield* docs.findMany({
        collection: "posts",
        search: "brown",
        orderBy: [{ path: "tier", direction: "asc" }],
      });
      assert.deepEqual(explicit.map((d) => d.data.tier), ["free", "paid", "paid"]);
    })));

  test(`${engine}: phrase search matches consecutive words in analyzed fields`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      // Document "a" has title "The Quick Brown Fox" -> tokens: quick, brown, fox.
      // Document "inverted" has "Fox brown quick" -> tokens: fox, brown, quick.
      yield* docs.insert({
        collection: "posts",
        id: "inverted",
        data: { title: "Fox brown quick", body: "lazy dog", tier: "free" },
      });

      // Unquoted search matches both because both contain "quick", "brown", "fox"
      assert.deepEqual(yield* found(docs, { search: "quick brown fox" }), ["a", "inverted"]);

      // Quoted phrase matches only "a" where "quick brown fox" appears in that exact order
      assert.deepEqual(yield* found(docs, { search: '"quick brown fox"' }), ["a"]);
      assert.deepEqual(yield* found(docs, { search: '"quick brown"' }), ["a"]);
      assert.deepEqual(yield* found(docs, { search: '"brown quick"' }), ["inverted"]);
      assert.deepEqual(yield* found(docs, { search: '"fox quick"' }), [], "separated words do not match phrase");

      // Quoted phrase on "inverted"
      assert.deepEqual(yield* found(docs, { search: '"fox brown"' }), ["inverted"]);

      // Phrase search in findPage
      const page = yield* docs.findPage({ collection: "posts", search: '"quick brown fox"' });
      assert.equal(page.documents.length, 1);
      assert.equal(page.documents[0].id, "a");

      const emptyPage = yield* docs.findPage({ collection: "posts", search: '"brown quick fox"' });
      assert.equal(emptyPage.documents.length, 0);
    })));

  test(`${engine}: prefix search matches terms beginning with prefix using * or prefix option`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      // Prefix with asterisk
      assert.deepEqual(yield* found(docs, { search: "bro*" }), ["a", "b"]);
      assert.deepEqual(yield* found(docs, { search: "coff*" }), ["c"]);
      assert.deepEqual(yield* found(docs, { search: "qui*" }), ["a", "c"]);

      // Intersected prefix and exact word
      assert.deepEqual(yield* found(docs, { search: "quick bro*" }), ["a"]);
      assert.deepEqual(yield* found(docs, { search: "quick cof*" }), ["c"]);
      assert.deepEqual(yield* found(docs, { search: "quick xyz*" }), []);

      // Programmatic prefix option
      assert.deepEqual(yield* found(docs, { search: "bro", prefix: true }), ["a", "b"]);
      assert.deepEqual(yield* found(docs, { search: "coff", prefix: true }), ["c"]);

      // Prefix in findPage
      const page = yield* docs.findPage({ collection: "posts", search: "bro*" });
      assert.deepEqual(page.documents.map((d) => d.id).sort(), ["a", "b"]);
    })));

  test(`${engine}: fuzzy search matches typos within edit distance using ~ or fuzzy option`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      // Damerau-Levenshtein distance 1 transposition: "brwon" -> "brown"
      assert.deepEqual(yield* found(docs, { search: "brwon~" }), ["a", "b"]);

      // Distance 1 substitution: "quik" -> "quick"
      assert.deepEqual(yield* found(docs, { search: "quik~1" }), ["a", "c"]);

      // Distance 1 insertion/deletion: "coffe" -> "coffee"
      assert.deepEqual(yield* found(docs, { search: "coffe~1" }), ["c"]);

      // Distant typo exceeding edit distance fails to match
      assert.deepEqual(yield* found(docs, { search: "banana~1" }), []);
      assert.deepEqual(yield* found(docs, { search: "brwooonnn~1" }), []);

      // Programmatic fuzzy option
      assert.deepEqual(yield* found(docs, { search: "brwon", fuzzy: true }), ["a", "b"]);
      assert.deepEqual(yield* found(docs, { search: "quik", fuzzy: 1 }), ["a", "c"]);

      // Multi-word with fuzzy
      assert.deepEqual(yield* found(docs, { search: "quick brwon~" }), ["a"]);

      // Exact match ranks higher than fuzzy match due to distance discounting
      yield* docs.insert({
        collection: "posts",
        id: "exact-match",
        data: { title: "Super coffee", body: "hot beverage" },
      });
      yield* docs.insert({
        collection: "posts",
        id: "typo-match",
        data: { title: "Super coffe", body: "hot beverage" },
      });
      const ranked = yield* docs.findMany({ collection: "posts", search: "coffee~1" });
      const exactIdx = ranked.findIndex((d) => d.id === "exact-match");
      const typoIdx = ranked.findIndex((d) => d.id === "typo-match");
      assert.ok(exactIdx !== -1 && typoIdx !== -1);
      assert.ok(exactIdx < typoIdx, "exact match ranks higher than fuzzy typo match");
      assert.ok(ranked[exactIdx].score > ranked[typoIdx].score);

      // Distance 2 matches two edits like "caffe" -> "coffee"
      yield* docs.insert({
        collection: "posts",
        id: "two-edits",
        data: { title: "Super caffe", body: "hot beverage" },
      });
      const dist2Matches = yield* found(docs, { search: "coffee~2" });
      assert.ok(dist2Matches.includes("two-edits"));

      // Fuzzy in findPage
      const page = yield* docs.findPage({ collection: "posts", search: "brwon~" });
      assert.deepEqual(page.documents.map((d) => d.id).sort(), ["a", "b"]);
    })));

  test(`${engine}: highlights matching terms and phrases in returned documents`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      // Basic highlight with default <mark>...</mark>
      const results = yield* docs.findMany({ collection: "posts", search: "brown", highlight: true });
      assert.equal(results.length, 2);
      const docA = results.find((d) => d.id === "a");
      const docB = results.find((d) => d.id === "b");
      assert.ok(docA?.highlights);
      assert.ok(docB?.highlights);
      // Case preservation: "The Quick Brown Fox" -> "Brown" is highlighted keeping capital B
      assert.deepEqual(docA.highlights.title, ["The Quick <mark>Brown</mark> Fox"]);
      assert.deepEqual(docB.highlights.title, ["<mark>Brown</mark> bread"]);

      // Custom highlight tags
      const custom = yield* docs.findMany({
        collection: "posts",
        search: "brown",
        highlight: { preTag: "<em>", postTag: "</em>" },
      });
      const customA = custom.find((d) => d.id === "a");
      assert.deepEqual(customA?.highlights?.title, ["The Quick <em>Brown</em> Fox"]);

      // Highlights on prefix match
      const prefixHl = yield* docs.findMany({ collection: "posts", search: "qui*", highlight: true });
      const prefixA = prefixHl.find((d) => d.id === "a");
      assert.ok(prefixA?.highlights?.title?.[0]?.includes("<mark>Quick</mark>"));

      // Highlights on fuzzy match
      const fuzzyHl = yield* docs.findMany({ collection: "posts", search: "brwon~", highlight: true });
      const fuzzyB = fuzzyHl.find((d) => d.id === "b");
      assert.ok(fuzzyB?.highlights?.title?.[0]?.includes("<mark>Brown</mark>"));

      // Long text snippet truncation with ellipses
      yield* docs.insert({
        collection: "posts",
        id: "long-doc",
        data: {
          title: "Short Title",
          body: "The quick brown fox jumps over the lazy sleeping dog and then takes a very long rest under a big green tree in the middle of a sunny park.",
        },
      });
      const snippetRes = yield* docs.findMany({
        collection: "posts",
        search: "tree",
        highlight: { snippetLength: 50 },
      });
      const longDoc = snippetRes.find((d) => d.id === "long-doc");
      assert.ok(longDoc?.highlights?.body);
      const snippet = longDoc.highlights.body[0];
      assert.ok(snippet.includes("<mark>tree</mark>"));
      assert.ok(snippet.startsWith("...") || snippet.endsWith("..."), "snippet is bounded with ellipses");

      // Highlights in findPage
      const page = yield* docs.findPage({ collection: "posts", search: "brown", highlight: true });
      assert.ok(page.documents.length > 0);
      assert.ok(page.documents[0].highlights);
    })));
}
