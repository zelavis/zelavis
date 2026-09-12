// Documents written before a change in how values are indexed, and the pass
// that repairs them.
//
// A reindex re-derives postings from the stored manifests, so it cannot fix a
// manifest that holds the wrong values. Writing each document back can, and
// this pins that it does — and that nothing else has to change for it to.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { asSeq, documentsFor } from "../dist/db/index.js";
import { makeMemoryStore } from "../dist/db/engines/memory-kv.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const engines = [
  ["memory", () => makeMemoryStore("acme")],
  ["sqlite", (dir) => makeNodeSqliteStore("acme", dir)],
];
const enc = new TextEncoder();
const ids = (found) => found.map((document) => document.id);

for (const [engine, open] of engines) {
  test(`${engine}: a rewrite repairs documents whose postings were written as text`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), `zv-rewrite-${engine}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* open(dir);
      const docs = documentsFor(store, "t1");
      yield* docs.createCollection({ name: "items" });
      yield* docs.insert({ collection: "items", id: "new", data: { price: 5 } });

      // As documents were written before the typed scalar lens: the value in
      // the document is a number, and the posting for it is text.
      const seq = yield* store.nextSeq;
      const stamp = "2020-01-01T00:00:00.000Z";
      yield* store.transact((txn) =>
        txn.put(
          asSeq(seq),
          enc.encode(JSON.stringify({
            id: "old", collection: "items", data: { price: 5 },
            createdAt: stamp, updatedAt: stamp, version: 1,
          })),
          {
            terms: [],
            columns: [["zv.collection/t1", "items"], ["t1/items.price", "5"]],
            measures: [], edges: [],
          },
          { namespace: "doc/t1/items", key: "old" },
        ));

      const matching = (value) =>
        Effect.map(docs.findMany({ collection: "items", where: [{ path: "price", value }] }), ids);
      assert.deepEqual(yield* matching(5), ["new"], "the old document is missed by a typed equality");
      assert.deepEqual(yield* matching("5"), ["old"], "and answers the text it was indexed as");
      // Text sorts after every number, so it is misplaced as well as missed.
      assert.deepEqual(ids(yield* docs.findMany({ collection: "items", orderBy: [{ path: "price" }] })),
        ["new", "old"]);

      // A reindex derives the same postings from the same manifest.
      yield* store.reindexLenses;
      assert.deepEqual(yield* matching(5), ["new"]);

      assert.deepEqual(yield* docs.rewrite(), { collections: 1, documents: 2 });
      assert.deepEqual((yield* matching(5)).sort(), ["new", "old"]);
      assert.deepEqual(yield* matching("5"), [], "and no longer as text");

      yield* docs.createCollection({ name: "other" });
      assert.deepEqual(yield* docs.rewrite({ collection: "items" }), { collections: 1, documents: 2 });
      assert.deepEqual(yield* docs.rewrite(), { collections: 2, documents: 2 });
      const missing = yield* Effect.flip(docs.rewrite({ collection: "nowhere" }));
      assert.equal(missing._tag, "CollectionNotFound");
    })));
  });
}
