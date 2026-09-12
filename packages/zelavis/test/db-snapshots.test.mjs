// A snapshot: state as of a position, so a rebuild survives compaction.
//
// `reindexLenses` re-derives the lenses from the stored manifests, and works
// whatever happened to the log. `rebuildLenses` re-derives them from the log
// itself, which is the operation that catches a manifest that is wrong rather
// than trusting it — and compaction used to take it away for good. These pin
// that a snapshot gives it back, and that it is honest about when it cannot.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { documentsFor, equals } from "../dist/db/index.js";
import { makeMemoryStore } from "../dist/db/engines/memory-kv.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const engines = [
  ["memory", () => makeMemoryStore("acme")],
  ["sqlite", (dir) => makeNodeSqliteStore("acme", dir)],
];

for (const [engine, open] of engines) {
  const setup = (t, body) => {
    const dir = mkdtempSync(join(tmpdir(), `zv-snapshot-${engine}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* open(dir);
      const docs = documentsFor(store, "t1");
      yield* docs.createCollection({ name: "items" });
      for (let i = 0; i < 5; i++) {
        yield* docs.insert({ collection: "items", id: `d${i}`, data: { price: i, kind: i % 2 ? "odd" : "even" } });
      }
      return yield* body({ store, docs });
    })));
  };
  const ids = (found) => found.map((document) => document.id);
  const answers = (docs) => Effect.gen(function* () {
    return {
      even: ids(yield* docs.findMany({ collection: "items", where: [{ path: "kind", value: "even" }] })),
      ordered: ids(yield* docs.findMany({ collection: "items", orderBy: [{ path: "price", direction: "desc" }] })),
      dear: ids(yield* docs.findMany({ collection: "items", where: [{ path: "price", op: "gte", value: 3 }] })),
    };
  });

  test(`${engine}: a rebuild after compaction works from a snapshot, and says so when it cannot`, (t) =>
    setup(t, ({ store, docs }) => Effect.gen(function* () {
      const before = yield* answers(docs);
      assert.deepEqual(before.even, ["d0", "d2", "d4"]);

      // Without a snapshot, a cut log leaves only the reindex.
      assert.equal(yield* store.snapshotAt, 0);
      const cut = yield* store.compact();
      assert.ok(cut.removed > 0, "there was history to drop");
      const refused = yield* Effect.flip(store.rebuildLenses);
      assert.equal(refused._tag, "LogCompacted");
      assert.deepEqual(yield* answers(docs), before, "and the store still answers as it did");

      // Reindexing still works, because it reads state rather than history.
      yield* store.reindexLenses;
      assert.deepEqual(yield* answers(docs), before);
    })));

  test(`${engine}: a snapshot taken before the cut carries the rebuild through it`, (t) =>
    setup(t, ({ store, docs }) => Effect.gen(function* () {
      const before = yield* answers(docs);
      const snapshot = yield* store.snapshot;
      assert.ok(snapshot.records >= 6, `a record per document, plus the collection: ${snapshot.records}`);
      assert.equal(yield* store.snapshotAt, snapshot.position);

      yield* store.compact();
      const rebuilt = yield* store.rebuildLenses;
      assert.ok(rebuilt >= snapshot.records, "the rebuild restored what the snapshot held");
      assert.deepEqual(yield* answers(docs), before);
    })));

  test(`${engine}: a rebuild replays only what the snapshot does not cover`, (t) =>
    setup(t, ({ store, docs }) => Effect.gen(function* () {
      const snapshot = yield* store.snapshot;
      // Written after it: the rebuild has to take these from the log.
      yield* docs.insert({ collection: "items", id: "late", data: { price: 9, kind: "even" } });
      yield* docs.update({ collection: "items", id: "d1", data: { price: 100 } });
      yield* docs.delete({ collection: "items", id: "d0" });
      const before = yield* answers(docs);
      assert.deepEqual(before.even, ["d2", "d4", "late"]);

      const rebuilt = yield* store.rebuildLenses;
      assert.equal(rebuilt, snapshot.records + 3, "the snapshot's records, and the three events after it");
      assert.deepEqual(yield* answers(docs), before);
    })));

  test(`${engine}: a snapshot older than the cut is refused rather than trusted`, (t) =>
    setup(t, ({ store, docs }) => Effect.gen(function* () {
      yield* store.snapshot;
      yield* docs.insert({ collection: "items", id: "late", data: { price: 9, kind: "odd" } });
      const before = yield* answers(docs);

      // The cut reaches past what the snapshot covers, so the events between
      // them are gone and the rebuild would be missing that insert.
      yield* store.compact();
      const refused = yield* Effect.flip(store.rebuildLenses);
      assert.equal(refused._tag, "LogCompacted");

      // A fresh snapshot covers the cut, and the rebuild works again.
      const taken = yield* store.snapshot;
      assert.ok(taken.position >= (yield* store.compactedTo));
      yield* store.rebuildLenses;
      assert.deepEqual(yield* answers(docs), before);
    })));

  test(`${engine}: a second snapshot replaces the first`, (t) =>
    setup(t, ({ store, docs }) => Effect.gen(function* () {
      const first = yield* store.snapshot;
      yield* docs.insert({ collection: "items", id: "late", data: { price: 9, kind: "even" } });
      yield* docs.update({ collection: "items", id: "late", data: { price: 10 } });
      const second = yield* store.snapshot;
      assert.ok(second.position > first.position, "the newer snapshot covers more of the log");
      assert.equal(second.records, first.records + 1);

      // Only one snapshot is kept, so a rebuild sees the newer copy of a
      // record the older one also held — and needs nothing from the log.
      const before = yield* answers(docs);
      yield* store.compact();
      assert.equal(yield* store.rebuildLenses, second.records);
      assert.deepEqual(yield* answers(docs), before);
      assert.equal((yield* docs.findById({ collection: "items", id: "late" })).data.price, 10);
    })));
}
