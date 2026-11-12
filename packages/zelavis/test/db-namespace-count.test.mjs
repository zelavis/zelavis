import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Exit } from "effect";
import { asSeq, documentsFor } from "../dist/db/index.js";
import { memoryKvEngine, makeMemoryStore } from "../dist/db/engines/memory-kv.js";
import { openShardOverKv } from "../dist/db/kv-store.js";

const bytes = new TextEncoder().encode("{}");
const manifest = { terms: [], columns: [], measures: [], edges: [] };
const put = (txn, seq, namespace, key) => txn.put(asSeq(seq), bytes, manifest, { namespace, key });

test("collection counts do not scan identifiers, even for large or empty collections", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const engine = memoryKvEngine();
  let scans = 0;
  const shard = yield* openShardOverKv("shard", { ...engine, scan: (...args) => { scans += 1; return engine.scan(...args); } });
  const docs = documentsFor(shard.partition("acme"), "acme");
  yield* docs.createCollection({ name: "rows" });
  yield* docs.createCollection({ name: "empty" });
  yield* docs.write({ operations: Array.from({ length: 1000 }, (_, n) => ({ _tag: "Insert", collection: "rows", id: `r${n}`, data: {} })) });
  scans = 0;
  assert.equal(yield* docs.count({ collection: "rows" }), 1000);
  assert.equal(yield* docs.count({ collection: "empty" }), 0);
  assert.equal(scans, 0, "count reads one namespace counter, with no posting scan");
  yield* docs.write({ operations: [
    { _tag: "Delete", collection: "rows", id: "r0" },
    { _tag: "Insert", collection: "rows", id: "fresh", data: {} },
    { _tag: "Delete", collection: "rows", id: "fresh" },
    { _tag: "Upsert", collection: "rows", id: "r1", data: { changed: true } },
  ] });
  assert.equal(yield* docs.count({ collection: "rows" }), 999);
  const failed = yield* Effect.exit(docs.write({ operations: [
    { _tag: "Insert", collection: "rows", id: "rollback", data: {} },
    { _tag: "Insert", collection: "rows", id: "r1", data: {} },
  ] }));
  assert.ok(Exit.isFailure(failed));
  assert.equal(yield* docs.count({ collection: "rows" }), 999);
}))));

test("namespace counters survive identity changes, rollback, snapshot replay, reindex and copying", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const shard = yield* makeMemoryStore("source");
  const store = shard.partition("acme");
  yield* store.transact(txn => Effect.gen(function* () {
    yield* put(txn, 1, "a", "one");
    yield* put(txn, 2, "a", "two");
    yield* put(txn, 3, "b", "three");
  }));
  assert.equal(yield* store.namespaceSize("a"), 2);
  assert.equal(yield* store.namespaceSize("b"), 1);
  yield* store.transact(txn => Effect.gen(function* () {
    yield* put(txn, 1, "b", "moved");
    yield* txn.retract(asSeq(2));
    yield* txn.retract(asSeq(2)); // repeated retract does not decrement twice
    yield* put(txn, 4, "b", "temporary");
    yield* txn.retract(asSeq(4));
  }));
  assert.equal(yield* store.namespaceSize("a"), 0);
  assert.equal(yield* store.namespaceSize("b"), 2);
  yield* Effect.exit(store.transact(txn => Effect.andThen(put(txn, 5, "b", "rolled-back"), Effect.fail("abort"))));
  assert.equal(yield* store.namespaceSize("b"), 2);
  yield* store.reindexLenses;
  assert.equal(yield* store.namespaceSize("a"), 0);
  assert.equal(yield* store.namespaceSize("b"), 2);
  yield* store.rebuildLenses;
  assert.equal(yield* store.namespaceSize("b"), 2);
  yield* store.snapshot;
  yield* store.transact(txn => txn.retract(asSeq(1)));
  yield* store.rebuildLenses;
  assert.equal(yield* store.namespaceSize("b"), 1);
  const copied = (yield* makeMemoryStore("destination")).partition("acme");
  yield* copied.seed(store);
  assert.equal(yield* copied.namespaceSize("a"), 0);
  assert.equal(yield* copied.namespaceSize("b"), 1);
}))));
