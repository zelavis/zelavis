import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Deferred, Effect, Stream } from "effect";
import { claimGeneration, openShardOverKv, shardOverKv } from "../dist/db/kv-store.js";
import { partitionKeys, shardMetaKey } from "../dist/db/keys.js";
import { StoreError } from "../dist/db/errors.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { makeNodeSqliteEngine } from "../dist/db/engines/node-sqlite.js";
import { makeLmdbEngine } from "../dist/db/engines/lmdb.js";
import { engineAvailable } from "./_engine-available.mjs";
import { makeRocksdbJsEngine } from "../dist/db/engines/rocksdb-js.js";

const enc = new TextEncoder();
const manifest = { terms: [["title", "fenced"]], columns: [], measures: [], edges: [] };
const put = (store, seq = 1) => store.transact(txn => txn.put(seq, enc.encode("payload"), manifest));
const state = engine => Stream.runCollect(engine.scan(new Uint8Array()));
const error = effect => effect.pipe(Effect.match({ onSuccess: () => undefined, onFailure: e => e }));
const run = effect => Effect.runPromise(Effect.scoped(effect));
/** The one partition these tests write, on a shard opened over `engine`. */
const openPartitionOver = (partition, engine) =>
  Effect.map(openShardOverKv(partition, engine), (shard) => shard.partition(partition));
const partitionOver = (partition, engine, claim) => shardOverKv(partition, engine, claim).partition(partition);
const directory = body => {
  const dir = mkdtempSync(join(tmpdir(), "zelavis-atomic-fence-"));
  return Promise.resolve().then(() => body(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
};
const makers = [
  ["memory", () => Effect.succeed(memoryKvEngine())],
  ["node-sqlite", dir => makeNodeSqliteEngine("acme", dir)],
  ["lmdb", dir => makeLmdbEngine("acme", dir)],
  ["rocksdb-js exclusive process", dir => makeRocksdbJsEngine("acme", dir)],
];

for (const [name, make] of makers) {
  test(`${name}: conditional rejection leaves every key untouched`, () => directory(dir => run(Effect.gen(function* () {
    const engine = yield* make(dir);
    const key = enc.encode("key"), value = enc.encode("old");
    assert.equal(yield* engine.conditionalWrite([{ op: "put", key, value }], [{ key, value: undefined }]), true);
    const before = yield* state(engine);
    assert.equal(yield* engine.conditionalWrite([{ op: "delete", key }], [{ key, value: enc.encode("wrong") }]), false);
    assert.deepEqual(yield* state(engine), before);
    for (const condition of [{ key, value: undefined }, { key: enc.encode("missing"), value }]) {
      assert.equal(yield* engine.conditionalWrite([{ op: "delete", key }], [condition]), false);
      assert.deepEqual(yield* state(engine), before);
    }
  }))));

  test(`${name}: takeover during a prepared transaction fences the batch and all maintenance`, () => directory(dir => run(Effect.gen(function* () {
    const engine = yield* make(dir);
    const stale = yield* openPartitionOver("acme", engine);
    yield* put(stale);
    const independent = name === "memory" || name.startsWith("rocksdb-js") ? engine : yield* make(dir);
    let before;
    const result = yield* error(stale.transact(txn => Effect.gen(function* () {
      yield* txn.put(2, enc.encode("late"), manifest);
      const current = yield* openPartitionOver("acme", independent);
      yield* put(current, 3);
      before = yield* state(independent);
    })));
    assert.equal(result?._tag, "WriterFenced");
    assert.deepEqual(yield* state(independent), before);
    for (const mutation of [stale.nextSeq, stale.reindexLenses, stale.rebuildLenses, stale.snapshot,
      stale.sealPostings, stale.compact(), stale.events.apply({ _tag: "ObjectPut", generation: 1,
        seq: 4, version: 1, at: 1, bytes: enc.encode("replica"), manifest })]) {
      assert.equal((yield* error(mutation))?._tag, "WriterFenced");
      assert.deepEqual(yield* state(independent), before);
    }
  }))));
}

test("SQLite: same-claim contention rejects dependent stale reads; foreign session cannot reuse a generation", () => directory(dir => run(Effect.gen(function* () {
  const engine = yield* makeNodeSqliteEngine("acme", dir);
  const claim = yield* claimGeneration(engine);
  const first = partitionOver("acme", engine, claim);
  const otherEngine = yield* makeNodeSqliteEngine("acme", dir);
  const second = partitionOver("acme", otherEngine, claim);
  let before;
  const conflict = yield* error(first.transact(txn => Effect.gen(function* () {
    yield* txn.put(1, enc.encode("late"), manifest);
    yield* put(second, 2);
    before = yield* state(otherEngine);
  })));
  assert.equal(conflict?.op, "store.conflict");
  assert.deepEqual(yield* state(otherEngine), before);
  const forged = partitionOver("acme", engine, { generation: claim.generation, session: enc.encode("foreign") });
  assert.equal((yield* error(forged.nextSeq))?._tag, "WriterFenced");
}))));

test("SQLite: concurrent independent claims advance generations without reuse", () => directory(dir => run(Effect.gen(function* () {
  const engines = yield* Effect.forEach(Array.from({ length: 16 }), () => makeNodeSqliteEngine("acme", dir));
  const claims = yield* Effect.all(engines.map(claimGeneration), { concurrency: "unbounded" });
  assert.deepEqual(claims.map(c => c.generation).sort((a,b) => a-b), Array.from({ length: 16 }, (_, i) => i+1));
  assert.equal(new Set(claims.map(c => new TextDecoder().decode(c.session))).size, 16);
}))));

test("SQLite: another process can supersede a paused writer; restart preserves the high-water mark", () => directory(dir => run(Effect.gen(function* () {
  const engine = yield* makeNodeSqliteEngine("acme", dir);
  const stale = yield* openPartitionOver("acme", engine);
  let before;
  const result = yield* error(stale.transact(txn => Effect.gen(function* () {
    yield* txn.put(1, enc.encode("late"), manifest);
    const code = `import { Effect } from 'effect';
      import { makeNodeSqliteStore } from './dist/db/engines/node-sqlite.js';
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const store = yield* makeNodeSqliteStore('acme', process.argv[1]);
        process.stdout.write(String(store.generation));
      })));`;
    const child = yield* Effect.promise(() => promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, dir], { cwd: new URL("..", import.meta.url) }));
    assert.equal(child.stdout.trim(), "2");
    before = yield* state(engine);
  })));
  assert.equal(result?._tag, "WriterFenced");
  assert.deepEqual(yield* state(engine), before);
  const reopened = yield* openPartitionOver("acme", engine);
  assert.equal(reopened.generation, 3);
}))));

test("an exhausted or malformed generation is refused, and the shard is left as it was", () => run(Effect.gen(function* () {
  const engine = memoryKvEngine();
  const original = yield* openPartitionOver("acme", engine);
  yield* put(original);
  assert.equal((yield* engine.get(shardMetaKey("generation"))).length, 8);
  const exhausted = new Uint8Array(8);
  new DataView(exhausted.buffer).setBigUint64(0, BigInt(Number.MAX_SAFE_INTEGER));
  for (const value of [exhausted, Uint8Array.of(1,2,3), Uint8Array.of(255,255,255,255)]) {
    yield* engine.write([{ op: "put", key: shardMetaKey("generation"), value }]);
    const before = yield* state(engine);
    assert.equal((yield* error(claimGeneration(engine)))?._tag, "StoreError");
    assert.deepEqual(yield* state(engine), before);
  }
})));

test("an engine without destination conditions refuses activation", () => run(Effect.gen(function* () {
  const engine = memoryKvEngine();
  const { conditionalWrite, ...unsupported } = engine;
  assert.equal((yield* error(openPartitionOver("acme", unsupported)))?.op, "generation.claim");
  assert.deepEqual(yield* state(engine), []);
})));

for (const [name, make] of makers) {
  test(`${name}: maintenance paused at commit cannot write after an independent takeover`, () => directory(dir => run(Effect.gen(function* () {
    const base = yield* make(dir);
    const independent = name === "memory" ? base : yield* make(dir);
    for (const operation of [s => s.reindexLenses, s => s.rebuildLenses, s => s.snapshot,
      s => s.sealPostings, s => s.compact(), s => s.nextSeq]) {
      let armed = false, before;
      const engine = { ...base, conditionalWrite: (writes, conditions) => Effect.gen(function* () {
        if (armed) {
          armed = false;
          yield* claimGeneration(independent);
          before = yield* state(independent);
        }
        return yield* base.conditionalWrite(writes, conditions);
      }) };
      const stale = yield* openPartitionOver("acme", engine);
      yield* put(stale);
      armed = true;
      assert.equal((yield* error(operation(stale)))?._tag, "WriterFenced");
      assert.deepEqual(yield* state(independent), before);
    }
  }))));
}

test("SQLite: competing real processes never claim the same generation", () => directory(dir => run(Effect.gen(function* () {
  yield* makeNodeSqliteEngine("acme", dir);
  const code = `import { Effect } from 'effect';
    import { makeNodeSqliteEngine } from './dist/db/engines/node-sqlite.js';
    import { claimGeneration } from './dist/db/kv-store.js';
    const generations = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const engine = yield* makeNodeSqliteEngine('acme', process.argv[1]);
      const result = [];
      for (let i = 0; i < 8; i++) result.push((yield* claimGeneration(engine)).generation);
      return result;
    })));
    console.log(JSON.stringify(generations));`;
  const children = yield* Effect.promise(() => Promise.all(Array.from({ length: 4 }, () =>
    promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, dir], { cwd: new URL("..", import.meta.url) }))));
  const generations = children.flatMap(child => JSON.parse(child.stdout));
  assert.deepEqual(generations.sort((a,b) => a-b), Array.from({ length: 32 }, (_,i) => i+1));
}))));


test("LMDB: another process fences a transaction prepared by the previous session", () => directory(dir => run(Effect.gen(function* () {
  const engine = yield* makeLmdbEngine("acme", dir);
  const stale = yield* openPartitionOver("acme", engine);
  let before;
  const outcome = yield* error(stale.transact(txn => Effect.gen(function* () {
    yield* txn.put(1, enc.encode("late"), manifest);
    const code = `import { Effect } from 'effect';
      import { makeLmdbStore } from './dist/db/engines/lmdb.js';
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const store = yield* makeLmdbStore('acme', process.argv[1]);
        process.stdout.write(String(store.generation));
      })));`;
    const child = yield* Effect.promise(() => promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, dir], { cwd: new URL("..", import.meta.url) }));
    assert.equal(child.stdout.trim(), "2");
    before = yield* state(engine);
  })));
  assert.equal(outcome?._tag, "WriterFenced");
  assert.deepEqual(yield* state(engine), before);
}))));

for (const [name, make] of makers) {
  test(`${name}: a failure partway through a conditional batch rolls it all back`, () => directory(dir => run(Effect.gen(function* () {
    const engine = yield* make(dir);
    const before = yield* state(engine);
    const broken = { get op() { throw new Error("injected batch failure"); } };
    const writes = [
      { op: "put", key: enc.encode("first"), value: enc.encode("discarded") }, broken,
    ];
    for (const batch of [engine.write(writes), engine.conditionalWrite(writes, [])]) {
      const exit = yield* Effect.exit(batch);
      assert.equal(exit._tag, "Failure");
      assert.deepEqual(yield* state(engine), before);
    }
  }))));
}

const hex = (bytes) => Buffer.from(bytes).toString("hex");

test("a write reads nothing before its work: the commit itself checks the writer, the revision and the fence", () => run(Effect.gen(function* () {
  const base = memoryKvEngine();
  const watched = new Set([
    shardMetaKey("generation"), shardMetaKey("writer_session"),
    partitionKeys("acme").meta("revision"), partitionKeys("acme").meta("fence"),
  ].map(hex));
  let reads = 0;
  const engine = { ...base, get: (key) => { if (watched.has(hex(key))) reads++; return base.get(key); } };
  const store = yield* openPartitionOver("acme", engine);
  reads = 0;
  yield* put(store, 1);
  assert.ok(reads > 0, "the first write reads what the handle then keeps, so the counter does see these keys");
  reads = 0;
  for (let seq = 2; seq <= 20; seq++) yield* put(store, seq);
  yield* store.nextSeq;
  yield* store.writable;
  assert.equal(reads, 0, "and no write after it reads any of them");
})));

test("something writing around a handle costs it one refused commit, after which it reads the partition afresh", () => run(Effect.gen(function* () {
  const engine = memoryKvEngine();
  const claim = yield* claimGeneration(engine);
  const first = partitionOver("acme", engine, claim);
  const second = partitionOver("acme", engine, claim);
  yield* put(first, 1);
  yield* put(second, 2);
  const refused = yield* error(put(first, 3));
  assert.equal(refused?.op, "store.conflict", "the stale revision is caught by the commit, not trusted");
  yield* put(first, 3);
  assert.equal((yield* first.stats).records, 3, "nothing either handle committed was lost");
})));

test("a commit the engine reports as failed may still have landed, so the handle forgets what it kept", () => run(Effect.gen(function* () {
  const base = memoryKvEngine();
  let failNext = false;
  const engine = {
    ...base,
    conditionalWrite: (writes, conditions) => {
      if (!failNext) return base.conditionalWrite(writes, conditions);
      failNext = false;
      // Applied, then lost on the way back: the failure a remote engine can give.
      return Effect.flatMap(base.conditionalWrite(writes, conditions),
        () => Effect.fail(new StoreError({ op: "test.commit", cause: "connection reset" })));
    },
  };
  const store = yield* openPartitionOver("acme", engine);
  yield* put(store, 1);
  failNext = true;
  assert.equal((yield* error(put(store, 2)))?._tag, "StoreError");
  // Kept, the revision from before that commit would refuse this one.
  yield* put(store, 3);
  assert.equal((yield* store.stats).records, 3);
})));

test("a fence is checked under the writer: every write either committed before it or is refused", () => run(Effect.gen(function* () {
  const base = memoryKvEngine();
  const tenth = yield* Deferred.make();
  let commits = 0;
  // Each commit yields, so the fence can arrive while a write holds the writer.
  const engine = {
    ...base,
    conditionalWrite: (writes, conditions) => Effect.gen(function* () {
      yield* Effect.sleep(1);
      const accepted = yield* base.conditionalWrite(writes, conditions);
      if (++commits === 10) yield* Deferred.succeed(tenth, undefined);
      return accepted;
    }),
  };
  const store = yield* openPartitionOver("acme", engine);
  // Spaced like separate requests, so the fence, waiting on the writer, gets
  // its turn between two of them.
  const writes = Effect.forEach(Array.from({ length: 40 }, (_, i) => i + 1),
    (seq) => Effect.andThen(Effect.sleep(1), error(put(store, seq))));
  const fence = Effect.gen(function* () {
    yield* Deferred.await(tenth);
    yield* store.fence({ from: "s0", to: "s1" });
    return (yield* store.stats).head;
  });
  const [results, headAtFence] = yield* Effect.all([writes, fence], { concurrency: 2 });
  const after = yield* store.stats;
  assert.equal(after.head, headAtFence, "nothing landed after the fence");
  assert.equal(results.filter((result) => result === undefined).length, after.records);
  assert.ok(results.every((result) => result === undefined || result._tag === "TenantMoving"));
  assert.ok(after.records > 0 && after.records < 40, "the fence went on part way through");
})));
