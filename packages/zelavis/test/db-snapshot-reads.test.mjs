// A read of several steps answers from one snapshot of its shard: what it
// resolved and what it then reads are the same moment, however many writes
// land between its steps. Writes, and the beliefs a partition keeps about
// itself, never read a snapshot.
import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Stream } from "effect";
import { documentsFor, partitionKeys } from "../dist/db/index.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { openShardOverKv } from "../dist/db/kv-store.js";
import { encodeFence } from "../dist/db/codec.js";

const run = (body) => Effect.runPromise(Effect.scoped(body));

/**
 * A memory engine whose snapshots run `during` once, at their first scan —
 * a write landing in the middle of a read that has already begun.
 */
const interrupting = () => {
  const base = memoryKvEngine();
  const hook = { during: undefined };
  const engine = {
    ...base,
    snapshot: Effect.map(base.snapshot, (reader) => ({
      ...reader,
      scan: (prefix, options) => Stream.unwrap(Effect.suspend(() => {
        const during = hook.during;
        hook.during = undefined;
        return Effect.as(during ?? Effect.void, reader.scan(prefix, options));
      })),
    })),
  };
  return { engine, hook };
};

test("a document read sees one moment, even with a write landing between its steps", () => run(Effect.gen(function* () {
  const { engine, hook } = interrupting();
  const store = (yield* openShardOverKv("s0", engine)).partition("acme");
  const docs = documentsFor(store, "acme");
  yield* docs.createCollection({ name: "posts", columns: ["state"] });
  for (const id of ["a", "b", "c"]) yield* docs.insert({ collection: "posts", id, data: { state: "live", title: id } });

  // Once the read has begun: b leaves the set, d joins it, c changes title.
  hook.during = docs.write({ operations: [
    { _tag: "Update", collection: "posts", id: "b", data: { state: "draft" } },
    { _tag: "Insert", collection: "posts", id: "d", data: { state: "live", title: "d" } },
    { _tag: "Update", collection: "posts", id: "c", data: { title: "c changed" } },
  ] });
  const during = yield* docs.findMany({ collection: "posts", where: [{ path: "state", value: "live" }] });
  assert.equal(hook.during, undefined, "the write landed while the read ran");
  assert.deepEqual(during.map((doc) => `${doc.id}:${doc.data.title}`).sort(), ["a:a", "b:b", "c:c"],
    "every step of the read answered from the moment it began");

  const after = yield* docs.findMany({ collection: "posts", where: [{ path: "state", value: "live" }] });
  assert.deepEqual(after.map((doc) => `${doc.id}:${doc.data.title}`).sort(), ["a:a", "c:c changed", "d:d"]);
})));

test("inside a read, writes still see the shard as it is, and a nested read joins the snapshot", () => run(Effect.gen(function* () {
  const store = (yield* openShardOverKv("s0", memoryKvEngine())).partition("acme");
  const docs = documentsFor(store, "acme");
  yield* docs.createCollection({ name: "posts" });
  yield* docs.insert({ collection: "posts", id: "a", data: { n: 1 } });

  yield* store.reading(Effect.gen(function* () {
    // A write that depends on the current version: checked against the shard
    // as it is, not the snapshot, so it succeeds twice in a row.
    yield* docs.update({ collection: "posts", id: "a", data: { n: 2 }, expectedVersion: 1 });
    yield* docs.update({ collection: "posts", id: "a", data: { n: 3 }, expectedVersion: 2 });
    const seen = yield* store.read(yield* store.lookup("doc/posts", "a"));
    assert.equal(JSON.parse(new TextDecoder().decode(seen.bytes)).data.n, 1, "reads inside stay on the snapshot");
  }));
  assert.equal((yield* docs.findById({ collection: "posts", id: "a" })).data.n, 3);
})));

test("a read in a snapshot never keeps a stale fence as the partition's belief", () => run(Effect.gen(function* () {
  const engine = memoryKvEngine();
  // A fresh handle, holding no belief about the fence yet.
  const store = (yield* openShardOverKv("s0", engine)).partition("acme");

  // A fence that lands after the snapshot was taken, written around the
  // handle: the first time it asks, it has to read the fence.
  const outcome = yield* store.reading(Effect.gen(function* () {
    yield* engine.write([{ op: "put", key: partitionKeys("acme").meta("fence"), value: encodeFence({ from: "s0", to: "s1" }) }]);
    return yield* Effect.flip(store.writable);
  }));
  assert.equal(outcome._tag, "TenantMoving", "the fence is read from the shard as it is");
  assert.equal((yield* Effect.flip(store.writable))._tag, "TenantMoving", "and kept as it is afterwards");
})));
