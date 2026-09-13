import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { documentsFor, stem, porterStemmer } from "../dist/db/index.js";
import { makeMemoryStore } from "../dist/db/engines/memory-kv.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

// Unit tests for the Porter Stemmer and language dispatcher
test("porter stemmer and language dispatch", () => {
  // Inflectional variations reduce to common base
  assert.equal(stem("connect", "en"), "connect");
  assert.equal(stem("connecting", "en"), "connect");
  assert.equal(stem("connections", "en"), "connect");
  assert.equal(stem("connection", "en"), "connect");
  assert.equal(stem("connected", "en"), "connect");

  assert.equal(stem("developer", "english"), "develop");
  assert.equal(stem("development", "english"), "develop");
  assert.equal(stem("developing", "english"), "develop");
  assert.equal(stem("develops", "english"), "develop");

  assert.equal(porterStemmer("jumps"), "jump");
  assert.equal(porterStemmer("jumping"), "jump");
  assert.equal(porterStemmer("jumped"), "jump");

  assert.equal(porterStemmer("cats"), "cat");
  assert.equal(porterStemmer("ponies"), "poni");
  assert.equal(porterStemmer("ties"), "ti");

  // Short words (length <= 2) remain unchanged
  assert.equal(stem("at", "en"), "at");
  assert.equal(stem("in", "en"), "in");
  assert.equal(stem("go", "en"), "go");

  // Undefined or unrecognized language returns word as-is
  assert.equal(stem("connecting", undefined), "connecting");
  assert.equal(stem("connecting", "fr"), "connecting");
  assert.equal(stem("connecting", "unknown"), "connecting");
});

const engines = [
  ["memory", () => makeMemoryStore("acme")],
  ["sqlite", (dir) => makeNodeSqliteStore("acme", dir)],
];

const STEMMED_ANALYZER = {
  fields: ["title", "body"],
  version: 1,
  language: "en",
  stopWords: ["the", "and"],
};

const STEMMED_ROWS = [
  ["1", { title: "Connecting with clients", body: "Software engineering and development", tier: "free" }],
  ["2", { title: "Client connection established", body: "Network systems and operational tools", tier: "paid" }],
  ["3", { title: "Disconnected user", body: "Failure in database connectivity", tier: "paid" }],
  ["4", { title: "Running fast", body: "Athletic runners jumping hurdles", tier: "free" }],
];

for (const [engine, open] of engines) {
  const setupStemmed = (t, body) => {
    const dir = mkdtempSync(join(tmpdir(), `zv-search-lang-${engine}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* open(dir);
      const docs = documentsFor(store, "t1");
      yield* docs.createCollection({ name: "articles", analyzer: STEMMED_ANALYZER });
      for (const [id, data] of STEMMED_ROWS) yield* docs.insert({ collection: "articles", id, data });
      return yield* body(docs, store);
    })));
  };

  const found = (docs, input) =>
    Effect.map(docs.findMany({ collection: "articles", ...input }), (all) => all.map((d) => d.id).sort());

  test(`${engine}: language-aware stemming matches inflections during search`, (t) =>
    setupStemmed(t, (docs) => Effect.gen(function* () {
      // Query "connect" matches "Connecting" (doc 1) and "connection" (docs 2, 3)
      assert.deepEqual(yield* found(docs, { search: "connect" }), ["1", "2", "3"]);
      assert.deepEqual(yield* found(docs, { search: "connecting" }), ["1", "2", "3"]);
      assert.deepEqual(yield* found(docs, { search: "connections" }), ["1", "2", "3"]);
      assert.deepEqual(yield* found(docs, { search: "connected" }), ["1", "2", "3"]);

      // Query "develop" matches "development" (doc 1)
      assert.deepEqual(yield* found(docs, { search: "develop" }), ["1"]);
      assert.deepEqual(yield* found(docs, { search: "developer" }), ["1"]);
      assert.deepEqual(yield* found(docs, { search: "developing" }), ["1"]);

      // Query "runner" matches "running" and "runners" (doc 4)
      assert.deepEqual(yield* found(docs, { search: "runner" }), ["4"]);
      assert.deepEqual(yield* found(docs, { search: "running" }), ["4"]);
      assert.deepEqual(yield* found(docs, { search: "jump" }), ["4"]);
      assert.deepEqual(yield* found(docs, { search: "jumping" }), ["4"]);
    })));

  test(`${engine}: highlights preserve original word casing and inflections when stemming is active`, (t) =>
    setupStemmed(t, (docs) => Effect.gen(function* () {
      const res = yield* docs.findMany({ collection: "articles", search: "connect", highlight: true });
      assert.ok(res.length >= 2);

      const doc1 = res.find((d) => d.id === "1");
      const doc2 = res.find((d) => d.id === "2");
      // "Connecting" in title should be highlighted with its original capitalization
      assert.ok(doc1?.highlights?.title?.[0]?.includes("<mark>Connecting</mark>"));
      // "connection" in title should be highlighted
      assert.ok(doc2?.highlights?.title?.[0]?.includes("<mark>connection</mark>"));
    })));

  test(`${engine}: boolean operators AND, OR, NOT and negation -term`, (t) =>
    setupStemmed(t, (docs) => Effect.gen(function* () {
      // Explicit AND
      assert.deepEqual(yield* found(docs, { search: "connect AND client" }), ["1", "2"]);
      assert.deepEqual(yield* found(docs, { search: "connect && client" }), ["1", "2"]);

      // Explicit OR
      assert.deepEqual(yield* found(docs, { search: "runner OR software" }), ["1", "4"]);
      assert.deepEqual(yield* found(docs, { search: "network || athletic" }), ["2", "4"]);

      // NOT operator (excludes documents containing the negated word)
      assert.deepEqual(yield* found(docs, { search: "connect NOT established" }), ["1", "3"]);
      assert.deepEqual(yield* found(docs, { search: "connect -established" }), ["1", "3"]);
      assert.deepEqual(yield* found(docs, { search: "connect !established" }), ["1", "3"]);

      // Pure negation excludes from all candidates
      assert.deepEqual(yield* found(docs, { search: "-established" }), ["1", "3", "4"]);
      assert.deepEqual(yield* found(docs, { search: "NOT established" }), ["1", "3", "4"]);
    })));

  test(`${engine}: grouping with parentheses and operator precedence`, (t) =>
    setupStemmed(t, (docs) => Effect.gen(function* () {
      // (runner OR client) with where filter on tier
      assert.deepEqual(
        yield* found(docs, { search: "runner OR client", where: [{ path: "tier", value: "free" }] }),
        ["1", "4"],
      );

      // (runner OR client) AND (engineering OR network)
      assert.deepEqual(
        yield* found(docs, { search: "(runner OR client) AND (engineering OR network)" }),
        ["1", "2"],
      );

      // (runner OR software) AND -jumping
      // doc 1 has software and no jumping -> matches
      // doc 4 has runner and jumping -> excluded by -jumping
      assert.deepEqual(
        yield* found(docs, { search: "(runner OR software) AND -jumping" }),
        ["1"],
      );

      // (software OR network) AND client
      assert.deepEqual(
        yield* found(docs, { search: "(software OR network) AND client" }),
        ["1", "2"],
      );
    })));

  test(`${engine}: field scoping with title: and body:`, (t) =>
    setupStemmed(t, (docs) => Effect.gen(function* () {
      // "software" is only in body of doc 1
      assert.deepEqual(yield* found(docs, { search: "body:software" }), ["1"]);
      assert.deepEqual(yield* found(docs, { search: "title:software" }), []);

      // "client" is in title of doc 1 and doc 2
      assert.deepEqual(yield* found(docs, { search: "title:client" }), ["1", "2"]);
      assert.deepEqual(yield* found(docs, { search: "body:client" }), []);

      // Field scoping combined with boolean logic
      assert.deepEqual(
        yield* found(docs, { search: "title:connect AND body:software" }),
        ["1"],
      );
      assert.deepEqual(
        yield* found(docs, { search: "title:connect AND body:network" }),
        ["2"],
      );

      // Field scoping with phrase
      assert.deepEqual(
        yield* found(docs, { search: 'title:"connecting with clients"' }),
        ["1"],
      );
      assert.deepEqual(
        yield* found(docs, { search: 'body:"connecting with clients"' }),
        [],
      );

      // Field scoping with prefix
      assert.deepEqual(yield* found(docs, { search: "title:run*" }), ["4"]);
      assert.deepEqual(yield* found(docs, { search: "body:hurd*" }), ["4"]);

      // Field scoping with fuzzy
      assert.deepEqual(yield* found(docs, { search: "title:clinet~1" }), ["1", "2"]);
    })));

  test(`${engine}: search language works consistently in findPage pagination`, (t) =>
    setupStemmed(t, (docs) => Effect.gen(function* () {
      // Search with boolean expression in findPage
      const page = yield* docs.findPage({
        collection: "articles",
        search: "connect NOT established",
        limit: 1,
      });
      assert.equal(page.documents.length, 1);
      assert.ok(page.next);

      const rest = yield* docs.findPage({
        collection: "articles",
        search: "connect NOT established",
        limit: 10,
        after: page.next,
      });
      const allIds = [...page.documents.map((d) => d.id), ...rest.documents.map((d) => d.id)].sort();
      assert.deepEqual(allIds, ["1", "3"]);
    })));
}
