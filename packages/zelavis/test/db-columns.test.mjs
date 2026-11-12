// Declared columns: a collection that names the fields it queries indexes only
// those, so a wide document stops writing an index entry per field.
//
// What these pin: queries on declared fields answer as before; an equality, a
// range or an order on any other field is refused rather than run as a scan;
// filters evaluated per document still work; references must read an indexed
// field; changing the columns rewrites the documents under the new choice; and
// a declared collection writes and stores less.
import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Stream } from "effect";
import { makeDatabase, partitionMapFor } from "../dist/db/index.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { openShardOverKv } from "../dist/db/kv-store.js";

const run = (body) => Effect.runPromise(Effect.scoped(body));

/** A database whose data shard counts the key-value operations it commits. */
const withDatabase = (body) => {
  const tally = { ops: 0 };
  let data;
  return run(Effect.gen(function* () {
    const db = yield* makeDatabase({
      partitionMap: partitionMapFor(["s0"]),
      openShard: (shard) => {
        if (shard !== "s0") return openShardOverKv(shard, memoryKvEngine());
        const base = memoryKvEngine();
        data = {
          ...base,
          conditionalWrite: (writes, conditions) => Effect.tap(base.conditionalWrite(writes, conditions),
            (accepted) => Effect.sync(() => { if (accepted) tally.ops += writes.length; })),
        };
        return openShardOverKv(shard, data);
      },
    });
    const storedBytes = Effect.gen(function* () {
      let bytes = 0;
      yield* Stream.runForEach(data.scan(new Uint8Array(0)), (entry) => Effect.sync(() => {
        bytes += entry.key.length + entry.value.length;
      }));
      return bytes;
    });
    return yield* body({ docs: db.forTenant("acme").documents, tally, storedBytes });
  }));
};

const post = (i) => ({
  title: `Post ${i}`, status: i % 2 === 0 ? "live" : "draft", views: i,
  author: { id: `u${i % 3}`, name: `User ${i % 3}` },
  a: 1, b: 2, c: 3, d: 4, e: 5, f: "six", g: true, h: null,
});

const seed = (docs, columns) => Effect.gen(function* () {
  yield* docs.createCollection({ name: "posts", ...(columns === undefined ? {} : { columns }) });
  for (let i = 0; i < 6; i++) yield* docs.insert({ collection: "posts", id: `p${i}`, data: post(i) });
});

const ids = (found) => found.map((doc) => doc.id).sort();

test("declared fields answer equality, ranges and order; others are refused rather than scanned", () =>
  withDatabase(({ docs }) => Effect.gen(function* () {
    yield* seed(docs, ["status", "views", "author"]);
    assert.deepEqual(ids(yield* docs.findMany({ collection: "posts", where: [{ path: "status", value: "live" }] })),
      ["p0", "p2", "p4"]);
    assert.deepEqual(ids(yield* docs.findMany({ collection: "posts", where: [{ path: "views", op: "gte", value: 4 }] })),
      ["p4", "p5"]);
    // A field covers everything below it.
    assert.deepEqual(ids(yield* docs.findMany({ collection: "posts", where: [{ path: "author.id", value: "u1" }] })),
      ["p1", "p4"]);
    const ordered = yield* docs.findPage({ collection: "posts", orderBy: [{ path: "views", direction: "desc" }], limit: 2 });
    assert.deepEqual(ordered.documents.map((doc) => doc.id), ["p5", "p4"]);

    for (const [what, read] of [
      ["equality", docs.findMany({ collection: "posts", where: [{ path: "title", value: "Post 1" }] })],
      ["range", docs.findMany({ collection: "posts", where: [{ path: "a", op: "gt", value: 0 }] })],
      ["order", docs.findMany({ collection: "posts", orderBy: [{ path: "title" }] })],
      ["page order", docs.findPage({ collection: "posts", orderBy: [{ path: "title" }] })],
    ]) {
      // A failure the caller can see, not a defect: Effect.flip would rethrow one.
      const refused = yield* Effect.flip(read);
      assert.equal(refused._tag, "UnindexedField", what);
    }

    // Evaluated per document, so it needs no postings and still works.
    assert.deepEqual(ids(yield* docs.findMany({
      collection: "posts", where: [{ path: "status", value: "live" }, { path: "title", op: "ne", value: "Post 2" }],
    })), ["p0", "p4"]);
    assert.deepEqual((yield* docs.modalities({ collection: "posts" })).columns.fields, ["author", "status", "views"]);
  })));

test("a reference must read an indexed field, at creation and when added", () =>
  withDatabase(({ docs }) => Effect.gen(function* () {
    yield* docs.createCollection({ name: "users" });
    const atCreation = yield* Effect.flip(docs.createCollection({
      name: "posts", columns: ["status"],
      references: [{ name: "author", path: "author.id", collection: "users" }],
    }));
    assert.equal(atCreation._tag, "InvalidConstraint");
    assert.match(atCreation.reason, /author\.id/);

    yield* docs.createCollection({ name: "posts", columns: ["status"] });
    const added = yield* Effect.flip(docs.addReference({ from: "posts", name: "author", path: "author.id", collection: "users" }));
    assert.equal(added._tag, "InvalidConstraint");

    yield* docs.setColumns({ collection: "posts", columns: ["status", "author.id"] });
    yield* docs.addReference({ from: "posts", name: "author", path: "author.id", collection: "users" });
    const narrowed = yield* Effect.flip(docs.setColumns({ collection: "posts", columns: ["status"] }));
    assert.equal(narrowed._tag, "InvalidConstraint", "columns cannot be narrowed out from under a reference");
  })));

test("changing the columns rewrites the documents, so a field added answers for every document", () =>
  withDatabase(({ docs }) => Effect.gen(function* () {
    yield* seed(docs, ["status"]);
    assert.equal((yield* Effect.flip(docs.findMany({ collection: "posts", where: [{ path: "title", value: "Post 3" }] })))._tag,
      "UnindexedField");

    const widened = yield* docs.setColumns({ collection: "posts", columns: ["title", "status"] });
    assert.deepEqual(widened, { columns: ["status", "title"], documents: 6 });
    assert.deepEqual(ids(yield* docs.findMany({ collection: "posts", where: [{ path: "title", value: "Post 3" }] })), ["p3"]);

    const every = yield* docs.setColumns({ collection: "posts", columns: null });
    assert.deepEqual(every, { columns: null, documents: 6 });
    assert.deepEqual(ids(yield* docs.findMany({ collection: "posts", where: [{ path: "f", value: "six" }] })),
      ["p0", "p1", "p2", "p3", "p4", "p5"]);
    assert.equal((yield* docs.modalities({ collection: "posts" })).columns.fields, "all-json-scalars");

    assert.equal((yield* Effect.flip(docs.setColumns({ collection: "posts", columns: ["ok", "bad..path"] })))._tag,
      "InvalidConstraint");
    assert.equal((yield* Effect.flip(docs.setColumns({ collection: "missing", columns: [] })))._tag, "CollectionNotFound");
  })));

test("a collection that declares its columns writes and stores less for the same documents", async () => {
  const measure = (columns) => withDatabase(({ docs, tally, storedBytes }) => Effect.gen(function* () {
    yield* docs.createCollection({ name: "posts", ...(columns === undefined ? {} : { columns }) });
    const before = tally.ops;
    for (let i = 0; i < 50; i++) yield* docs.insert({ collection: "posts", id: `p${i}`, data: post(i) });
    return { ops: tally.ops - before, bytes: yield* storedBytes };
  }));
  const every = await measure(undefined);
  const declared = await measure(["status", "views"]);
  assert.ok(declared.ops < every.ops * 0.7, `declared wrote ${declared.ops} operations against ${every.ops}`);
  assert.ok(declared.bytes < every.bytes * 0.85, `declared stored ${declared.bytes} bytes against ${every.bytes}`);
});
