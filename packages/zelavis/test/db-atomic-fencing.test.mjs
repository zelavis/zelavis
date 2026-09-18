import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Effect, Stream } from "effect";
import { claimGeneration, openStoreOverKv, storeOverKv } from "../dist/db/kv-store.js";
import { metaKey } from "../dist/db/keys.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { makeNodeSqliteEngine } from "../dist/db/engines/node-sqlite.js";
import { makeLibsqlEngine } from "../dist/db/engines/libsql.js";
import { makeLmdbEngine } from "../dist/db/engines/lmdb.js";
import { makeLibsqlRemoteEngine } from "../dist/db/engines/libsql-remote.js";
import { engineAvailable } from "./_engine-available.mjs";
import { makeRocksdbJsEngine } from "../dist/db/engines/rocksdb-js.js";

const enc = new TextEncoder();
const manifest = { terms: [["title", "fenced"]], columns: [], measures: [], edges: [] };
const put = (store, seq = 1) => store.transact(txn => txn.put(seq, enc.encode("payload"), manifest));
const state = engine => Stream.runCollect(engine.scan(new Uint8Array()));
const error = effect => effect.pipe(Effect.match({ onSuccess: () => undefined, onFailure: e => e }));
const run = effect => Effect.runPromise(Effect.scoped(effect));
const directory = body => {
  const dir = mkdtempSync(join(tmpdir(), "zelavis-atomic-fence-"));
  return Promise.resolve().then(() => body(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
};
const makers = [
  ["memory", () => Effect.succeed(memoryKvEngine())],
  ["node-sqlite", dir => makeNodeSqliteEngine("acme", dir)],
  ["libsql", dir => makeLibsqlEngine("acme", { directory: dir })],
  ["lmdb", dir => makeLmdbEngine("acme", dir)],
  ["libsql-client local transport", dir => makeLibsqlRemoteEngine("acme", { url: `file:${join(dir, "remote.sqlite")}` })],
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
    const stale = yield* openStoreOverKv("acme", engine);
    yield* put(stale);
    const independent = name === "memory" || name.startsWith("rocksdb-js") ? engine : yield* make(dir);
    let before;
    const result = yield* error(stale.transact(txn => Effect.gen(function* () {
      yield* txn.put(2, enc.encode("late"), manifest);
      const current = yield* openStoreOverKv("acme", independent);
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
  const first = storeOverKv("acme", engine, claim);
  const otherEngine = yield* makeNodeSqliteEngine("acme", dir);
  const second = storeOverKv("acme", otherEngine, claim);
  let before;
  const conflict = yield* error(first.transact(txn => Effect.gen(function* () {
    yield* txn.put(1, enc.encode("late"), manifest);
    yield* put(second, 2);
    before = yield* state(otherEngine);
  })));
  assert.equal(conflict?.op, "store.conflict");
  assert.deepEqual(yield* state(otherEngine), before);
  const forged = storeOverKv("acme", engine, { generation: claim.generation, session: enc.encode("foreign") });
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
  const stale = yield* openStoreOverKv("acme", engine);
  let before;
  const result = yield* error(stale.transact(txn => Effect.gen(function* () {
    yield* txn.put(1, enc.encode("late"), manifest);
    const code = `import { Effect } from 'effect';
      import { makeNodeSqliteStore } from './dist/db/engines/node-sqlite.js';
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const store = yield* makeNodeSqliteStore('acme', process.argv[1]);
        console.log(store.generation);
      })));`;
    const child = yield* Effect.promise(() => promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, dir], { cwd: new URL("..", import.meta.url) }));
    assert.equal(child.stdout.trim(), "2");
    before = yield* state(engine);
  })));
  assert.equal(result?._tag, "WriterFenced");
  assert.deepEqual(yield* state(engine), before);
  const reopened = yield* openStoreOverKv("acme", engine);
  assert.equal(reopened.generation, 3);
}))));

test("generation widening preserves existing events and refuses exhaustion or malformed state", () => run(Effect.gen(function* () {
  const engine = memoryKvEngine();
  const original = yield* openStoreOverKv("acme", engine);
  yield* put(original);
  const events = yield* Stream.runCollect(original.events.read());
  yield* engine.write([{ op: "put", key: metaKey("generation"), value: Uint8Array.of(255,255,255,255) }]);
  const widened = yield* openStoreOverKv("acme", engine);
  assert.equal(widened.generation, 2 ** 32);
  assert.deepEqual(yield* Stream.runCollect(widened.events.read()), events);
  assert.equal((yield* engine.get(metaKey("generation"))).length, 8);
  const exhausted = new Uint8Array(8);
  new DataView(exhausted.buffer).setBigUint64(0, BigInt(Number.MAX_SAFE_INTEGER));
  for (const value of [exhausted, Uint8Array.of(1,2,3)]) {
    yield* engine.write([{ op: "put", key: metaKey("generation"), value }]);
    const before = yield* state(engine);
    assert.equal((yield* error(claimGeneration(engine)))?._tag, "StoreError");
    assert.deepEqual(yield* state(engine), before);
  }
})));

test("an engine without destination conditions refuses activation", () => run(Effect.gen(function* () {
  const engine = memoryKvEngine();
  const { conditionalWrite, ...unsupported } = engine;
  assert.equal((yield* error(openStoreOverKv("acme", unsupported)))?.op, "generation.claim");
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
      const stale = yield* openStoreOverKv("acme", engine);
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
  const stale = yield* openStoreOverKv("acme", engine);
  let before;
  const outcome = yield* error(stale.transact(txn => Effect.gen(function* () {
    yield* txn.put(1, enc.encode("late"), manifest);
    const code = `import { Effect } from 'effect';
      import { makeLmdbStore } from './dist/db/engines/lmdb.js';
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const store = yield* makeLmdbStore('acme', process.argv[1]);
        console.log(store.generation);
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

test("discontinued RocksDB binding: single-owner conditional commits and stale maintenance", {
  skip: !engineAvailable("rocksdb") && "optional discontinued binding is unavailable",
}, () => directory(async dir => {
  const code = `import assert from 'node:assert/strict';
    import { Effect, Stream } from 'effect';
    import { makeRocksdbEngine } from './dist/db/engines/rocksdb.js';
    import { openStoreOverKv } from './dist/db/kv-store.js';
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const engine = yield* makeRocksdbEngine('acme', process.argv[1]);
      const old = yield* openStoreOverKv('acme', engine);
      const current = yield* openStoreOverKv('acme', engine);
      assert.equal(current.generation, 2);
      const before = yield* Stream.runCollect(engine.scan(new Uint8Array()));
      const failure = yield* old.nextSeq.pipe(Effect.match({ onSuccess: () => undefined, onFailure: e => e }));
      assert.equal(failure._tag, 'WriterFenced');
      assert.deepEqual(yield* Stream.runCollect(engine.scan(new Uint8Array())), before);
    })));
    console.log('passed');`;
  const child = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, dir], { cwd: new URL("..", import.meta.url) });
  assert.equal(child.stdout.trim(), "passed");
}));
