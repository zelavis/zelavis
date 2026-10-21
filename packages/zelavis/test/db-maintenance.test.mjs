// Upkeep that stays bounded: batches of a fixed size, a partition that refuses
// to be read from half an index, and a snapshot that does not stop the writer.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Stream } from "effect";
import { equals, makeDatabase, partitionKeys, partitionMapFor, Tag, term, u64Bytes } from "../dist/db/index.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { makeNodeSqliteEngine, makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";
import { openShardOverKv } from "../dist/db/kv-store.js";

const enc = new TextEncoder();
const run = (body) => Effect.runPromise(Effect.scoped(body));
const seqs = (store, query) => Effect.map(Stream.runCollect(store.resolve(query)), (c) => [...c].map(Number));

/** Writes per batch the store promises not to exceed by more than one record's worth. */
const SEAL_BATCH = 4096;

const post = (seq) => ({
  terms: [["kind", "post"], ["tag", `t${seq % 50}`]],
  columns: [["region", `r${seq % 4}`], ["n", seq], ["even", seq % 2 === 0], ["label", `l${seq % 7}`]],
  measures: [["n", seq]],
  edges: seq > 1 ? [["follows", seq - 1]] : [],
});

const answers = (store) => Effect.all({
  kind: seqs(store, term("kind", "post")),
  tag: seqs(store, term("tag", "t7")),
  region: seqs(store, equals("region", "r2")),
});

test("every piece of upkeep writes in bounded batches, and leaves the answers as they were", () => run(Effect.gen(function* () {
  const base = memoryKvEngine();
  let largest = 0;
  let counting = false;
  const engine = {
    ...base,
    conditionalWrite: (writes, conditions) => {
      if (counting) largest = Math.max(largest, writes.length);
      return base.conditionalWrite(writes, conditions);
    },
  };
  const store = (yield* openShardOverKv("s0", engine)).partition("acme");
  // Some 30,000 postings: one batch of all of them is what this rules out.
  for (let seq = 1; seq <= 4000; seq++) {
    yield* store.transact((txn) => txn.put(seq, enc.encode("{}"), post(seq), { namespace: "doc/posts", key: `p${seq}` }));
  }
  const before = yield* answers(store);

  for (const [name, work] of [
    ["seal", store.sealPostings],
    ["snapshot", store.snapshot],
    ["reindex", store.reindexLenses],
    ["rebuild", store.rebuildLenses],
    ["compact", store.compact({ keep: 0 })],
    ["snapshot again", store.snapshot],
  ]) {
    largest = 0;
    counting = true;
    yield* work;
    counting = false;
    assert.ok(largest <= SEAL_BATCH + 64, `${name} wrote a batch of ${largest}`);
    assert.deepEqual(yield* answers(store), before, `${name} left the answers as they were`);
  }
})));

test("a partition marked mid-rebuild refuses reads and writes until it is finished, and opening finishes it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-maintenance-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const open = (body) => run(Effect.gen(function* () {
    const db = yield* makeDatabase({
      partitionMap: partitionMapFor(["only"]),
      openShard: (shard) => makeNodeSqliteStore(shard, dir),
    });
    return yield* body(db);
  }));

  await open((db) => Effect.gen(function* () {
    const docs = db.forTenant("acme").documents;
    yield* docs.createCollection({ name: "posts" });
    for (let i = 0; i < 20; i++) yield* docs.insert({ collection: "posts", id: `p${i}`, data: { n: i } });
  }));

  // What a rebuild cut off by a crash leaves: the mark, and its work undone.
  await run(Effect.gen(function* () {
    const engine = yield* makeNodeSqliteEngine("only", dir);
    yield* engine.write([{ op: "put", key: partitionKeys("acme").meta("lenses"), value: u64Bytes(1) }]);
    const store = (yield* openShardOverKv("only", engine)).partition("acme");
    const refusedRead = yield* Effect.flip(store.lookup("doc/posts", "p1"));
    assert.equal(refusedRead._tag, "LensesRebuilding");
    assert.equal(refusedRead.operation, "rebuild");
    const refusedWrite = yield* Effect.flip(store.nextSeq);
    assert.equal(refusedWrite._tag, "LensesRebuilding");
  }));

  await open((db) => Effect.gen(function* () {
    // Opening finished the rebuild before anything read.
    const found = yield* db.forTenant("acme").documents.findMany({ collection: "posts", where: [{ path: "n", op: "gte", value: 15 }] });
    assert.deepEqual(found.map((doc) => doc.id).sort(), ["p15", "p16", "p17", "p18", "p19"]);
    yield* db.forTenant("acme").documents.insert({ collection: "posts", id: "after", data: { n: 99 } });
  }));
});

test("a snapshot lets the writer in while it copies, and still records one moment", { timeout: 20_000 }, () => run(Effect.gen(function* () {
  const base = memoryKvEngine();
  const keys = partitionKeys("acme");
  let store;
  let interloper = false;
  // The first time the snapshot starts copying records, a write goes through
  // the same partition. A snapshot that held the writer for the copy would
  // wait on itself here, and the test would time out.
  const engine = {
    ...base,
    scan: (prefix, options) => {
      const copying = prefix.length === keys.tag(Tag.Record).length
        && prefix.every((byte, i) => byte === keys.tag(Tag.Record)[i]);
      if (!copying || !interloper) return base.scan(prefix, options);
      interloper = false;
      return Stream.unwrap(Effect.as(
        store.transact((txn) => txn.put(9999, enc.encode("{}"), post(9999), { namespace: "doc/posts", key: "late" })),
        base.scan(prefix, options),
      ));
    },
  };
  store = (yield* openShardOverKv("s0", engine)).partition("acme");
  for (let seq = 1; seq <= 300; seq++) {
    yield* store.transact((txn) => txn.put(seq, enc.encode("{}"), post(seq), { namespace: "doc/posts", key: `p${seq}` }));
  }
  interloper = true;
  const taken = yield* store.snapshot;
  assert.equal(interloper, false, "the write went in during the copy");
  assert.equal(taken.position, (yield* store.stats).head, "and the snapshot covers it");

  // Only the snapshot is left to rebuild from once the log is gone.
  const before = yield* answers(store);
  yield* store.compact({ keep: 0 });
  yield* store.rebuildLenses;
  assert.deepEqual(yield* answers(store), before);
  assert.equal(yield* store.lookup("doc/posts", "late"), 9999);
})));
