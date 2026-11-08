import assert from "node:assert/strict";
import test from "node:test";
import { Cause, Effect, Exit } from "effect";
import { openShardOverKv, openShardReaderOverKv } from "../dist/db/kv-store.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { RoutedBy } from "../dist/db/store.js";
import { documentsFor } from "../dist/db/documents.js";

const run = (effect) => Effect.runPromise(Effect.scoped(effect));

test("a reader never writes and never claims", () => run(Effect.gen(function* () {
  const raw = memoryKvEngine();
  let writes = 0;
  const engine = { ...raw, write: (batch) => { writes++; return raw.write(batch); },
    conditionalWrite: (batch, conditions) => { writes++; return raw.conditionalWrite(batch, conditions); } };
  const writer = yield* openShardOverKv("s", engine);
  const docs = documentsFor(writer.partition("t"), "t");
  yield* docs.createCollection({ name: "notes" });
  yield* docs.write({ operations: ["a", "b"].map(id => ({ _tag: "Insert", collection: "notes", id, data: { id } })) });
  const before = writes;
  const reader = yield* openShardReaderOverKv("s", engine);
  const read = documentsFor(reader.partition("t"), "t");
  assert.equal((yield* read.findMany({ collection: "notes" })).length, 2);
  yield* read.listCollections;
  const error = yield* Effect.flip(reader.partition("t").reserve(10));
  assert.equal(error._tag, "StoreError");
  assert.equal(error.op, "reader.reserve");
  assert.equal(writes, before);
  const next = yield* openShardOverKv("s", engine);
  assert.equal(next.generation, writer.generation + 1);
})));

test("a reader sees new data and relocation after its first read", () => run(Effect.gen(function* () {
  const engine = memoryKvEngine();
  const writer = yield* openShardOverKv("s", engine);
  const reader = yield* openShardReaderOverKv("s", engine);
  const read = documentsFor(reader.partition("t"), "t");
  assert.equal(yield* read.collectionExists("notes"), false);
  const docs = documentsFor(writer.partition("t"), "t");
  yield* docs.createCollection({ name: "notes" });
  yield* docs.write({ operations: [{ _tag: "Insert", collection: "notes", id: "a", data: {} }] });
  assert.equal(yield* read.collectionExists("notes"), true);
  assert.equal(yield* Effect.provideService(read.collectionExists("notes"), RoutedBy, 6), true);
  yield* writer.relocate("t", 7);
  const exit = yield* Effect.exit(Effect.provideService(read.collectionExists("notes"), RoutedBy, 6));
  assert.ok(Exit.isFailure(exit));
  const defect = Cause.squash(exit.cause);
  assert.equal(defect._tag, "TenantRelocated");
  assert.equal(defect.mapVersion, 7);
  assert.equal(yield* Effect.provideService(read.collectionExists("notes"), RoutedBy, 7), false);
})));

test("a reader refuses an engine its writer never opened", () => run(Effect.gen(function* () {
  const error = yield* Effect.flip(openShardReaderOverKv("s", memoryKvEngine()));
  assert.equal(error._tag, "StoreError");
  assert.equal(error.op, "reader.open");
})));

test("a reader's relocation belief and data share the same snapshot", () => run(Effect.gen(function* () {
  const engine = memoryKvEngine();
  const writer = yield* openShardOverKv("s", engine);
  const docs = documentsFor(writer.partition("t"), "t");
  yield* docs.createCollection({ name: "notes" });
  const reader = yield* openShardReaderOverKv("s", engine);
  const store = reader.partition("t");
  const read = documentsFor(store, "t");
  const beforeMove = yield* store.reading(Effect.gen(function* () {
    assert.equal(yield* read.collectionExists("notes"), true);
    yield* writer.relocate("t", 7);
    return yield* Effect.provideService(read.collectionExists("notes"), RoutedBy, 6);
  }));
  assert.equal(beforeMove, true);
  const afterMove = yield* Effect.exit(Effect.provideService(read.collectionExists("notes"), RoutedBy, 6));
  assert.equal(Cause.squash(afterMove.cause)._tag, "TenantRelocated");
})));
