// Joins through references: the identifiers two collections already share.
//
// A related clause is answered by the target's own query and then by the
// postings the referencing field already has, so these pin that it means the
// same as reading both sides by hand — and that it says so when it cannot.
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
const ids = (found) => found.map((document) => document.id);

for (const [engine, open] of engines) {
  const setup = (t, body) => {
    const dir = mkdtempSync(join(tmpdir(), `zv-related-${engine}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const docs = documentsFor(yield* open(dir), "t1");
      yield* docs.createCollection({ name: "authors" });
      yield* docs.createCollection({
        name: "posts", references: [{ name: "author", path: "authorId", collection: "authors" }],
      });
      for (const [id, data] of [
        ["a1", { name: "Ann", country: "fr" }],
        ["a2", { name: "Bo", country: "de" }],
        ["a3", { name: "Cy", country: "fr" }],
      ]) yield* docs.insert({ collection: "authors", id, data });
      for (const [id, data] of [
        ["p1", { authorId: "a1", title: "one" }],
        ["p2", { authorId: "a2", title: "two" }],
        ["p3", { authorId: "a1", title: "three" }],
        ["p4", { authorId: "a3", title: "four" }],
        ["p5", { title: "five" }],
      ]) yield* docs.insert({ collection: "posts", id, data });
      return yield* body(docs);
    })));
  };
  const found = (docs, input) => Effect.map(docs.findMany({ collection: "posts", ...input }), ids);
  const tagOf = (effect) => Effect.map(Effect.flip(effect), (error) => error._tag);
  const french = [{ reference: "author", where: [{ path: "country", value: "fr" }] }];

  test(`${engine}: a related clause answers with the documents whose reference matches`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      assert.deepEqual(yield* found(docs, { related: french }), ["p1", "p3", "p4"]);
      assert.deepEqual(yield* found(docs, { related: [{ reference: "author", id: "a2" }] }), ["p2"]);
      // An id and filters together: the named document must match them too.
      assert.deepEqual(yield* found(docs, {
        related: [{ reference: "author", id: "a2", where: [{ path: "country", value: "fr" }] }],
      }), []);
      assert.deepEqual(yield* found(docs, {
        related: [{ reference: "author", id: "a1", where: [{ path: "country", value: "fr" }] }],
      }), ["p1", "p3"]);
      // With neither, every document naming any author at all.
      assert.deepEqual(yield* found(docs, { related: [{ reference: "author" }] }), ["p1", "p2", "p3", "p4"]);
      // Alongside the collection's own filters and ordering.
      assert.deepEqual(yield* found(docs, {
        related: french, where: [{ path: "title", op: "ne", value: "three" }], orderBy: [{ path: "title" }],
      }), ["p4", "p1"]);
    })));

  test(`${engine}: a page joins the same way, and one nothing can match is empty`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      const pages = [];
      let after;
      for (let i = 0; i < 10; i++) {
        const page = yield* docs.findPage({ collection: "posts", related: french, limit: 2, ...(after === undefined ? {} : { after }) });
        pages.push(ids(page.documents));
        if (page.next === undefined) break;
        after = page.next;
      }
      assert.deepEqual(pages.flat(), ["p1", "p3", "p4"]);

      const none = [{ reference: "author", where: [{ path: "country", value: "zz" }] }];
      assert.deepEqual(yield* found(docs, { related: none }), []);
      const page = yield* docs.findPage({ collection: "posts", related: none });
      assert.deepEqual([page.documents, page.next], [[], undefined]);
      assert.deepEqual(yield* found(docs, { related: [{ reference: "author", id: "gone" }] }), []);
    })));

  test(`${engine}: a reference the collection does not declare is said, not ignored`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      const bogus = [{ reference: "editor", where: [{ path: "country", value: "fr" }] }];
      const error = yield* Effect.flip(docs.findMany({ collection: "posts", related: bogus }));
      assert.equal(error._tag, "UnknownReference");
      assert.deepEqual([error.collection, error.name], ["posts", "editor"]);
      assert.equal(yield* tagOf(docs.findPage({ collection: "posts", related: bogus })), "UnknownReference");
      assert.equal(yield* tagOf(docs.withRelated({ collection: "posts", documents: [], references: ["editor"] })),
        "UnknownReference");
    })));

  test(`${engine}: withRelated resolves what each document names`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      const posts = yield* docs.findMany({ collection: "posts" });
      const resolved = yield* docs.withRelated({ collection: "posts", documents: posts });
      assert.deepEqual(
        resolved.map((entry) => [entry.document.id, entry.related.author?.data.name]),
        [["p1", "Ann"], ["p2", "Bo"], ["p3", "Ann"], ["p4", "Cy"], ["p5", undefined]],
      );
      // Naming which references to resolve, and a document that names none.
      const one = yield* docs.withRelated({
        collection: "posts", documents: posts.slice(4), references: ["author"],
      });
      assert.deepEqual(one.map((entry) => entry.related.author), [undefined]);
      // A collection with no references resolves to nothing rather than failing.
      const authors = yield* docs.findMany({ collection: "authors" });
      const bare = yield* docs.withRelated({ collection: "authors", documents: authors });
      assert.deepEqual(bare.map((entry) => entry.related), [{}, {}, {}]);
    })));
}
