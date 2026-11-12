// The SQLite engine commits batches that are ready together in one transaction, so they share one
// flush of the log. Each batch must still be exactly what it was alone: its own conditions, its own
// failure, and no answer before the commit that makes it durable.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Effect, Fiber } from "effect";
import { sqliteKvEngineOver } from "../dist/db/engines/sqlite-kv.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const bytes = (text) => new TextEncoder().encode(text);
const text = (value) => value === undefined ? undefined : new TextDecoder().decode(value);

/** A real SQLite file behind a handle that counts commits and can be told to fail the next one. */
const engineIn = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-group-commit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "kv.sqlite");
  const db = new DatabaseSync(file);
  const counts = { commits: 0, failNextCommit: false };
  /** A statement whose writes to the key `broken` fail, as a full disk would. */
  const failingOn = (statement) => ({
    get: (...params) => statement.get(...params),
    iterate: (...params) => statement.iterate(...params),
    run: (...params) => {
      if (params[0] instanceof Uint8Array && new TextDecoder().decode(params[0]) === "broken") throw new Error("injected write failure");
      return statement.run(...params);
    },
  });
  const handle = {
    prepare: (sql) => failingOn(db.prepare(sql)),
    exec: (sql) => {
      if (sql === "COMMIT") {
        if (counts.failNextCommit) {
          counts.failNextCommit = false;
          throw new Error("injected commit failure");
        }
        counts.commits += 1;
      }
      return db.exec(sql);
    },
    close: () => db.close(),
  };
  const engine = sqliteKvEngineOver(handle, { openReader: () => new DatabaseSync(file, { readOnly: true }) });
  t.after(() => Effect.runPromise(engine.close));
  return { engine, counts };
};

const put = (key, value) => ({ op: "put", key: bytes(key), value: bytes(value) });

test("batches ready together share one commit, and every one of them lands", async (t) => {
  const { engine, counts } = engineIn(t);
  const outcomes = await Effect.runPromise(Effect.all(
    Array.from({ length: 16 }, (_, index) => engine.conditionalWrite([put(`k${index}`, `v${index}`)], [])),
    { concurrency: "unbounded" },
  ));
  assert.deepEqual(outcomes, Array(16).fill(true));
  assert.equal(counts.commits, 1, "sixteen concurrent batches, one commit");
  for (let index = 0; index < 16; index++) {
    assert.equal(text(await Effect.runPromise(engine.get(bytes(`k${index}`)))), `v${index}`);
  }
});

test("a group is the batches one after another: each checks its conditions against those ahead of it", async (t) => {
  const { engine, counts } = engineIn(t);
  await Effect.runPromise(engine.write([put("held", "0")]));
  const before = counts.commits;
  const [first, stale, follows] = await Effect.runPromise(Effect.all([
    // Holds, and moves `held` to 1.
    engine.conditionalWrite([put("held", "1"), put("a", "first")], [{ key: bytes("held"), value: bytes("0") }]),
    // Built on the value the first batch replaced: refused, and writes nothing of its own.
    engine.conditionalWrite([put("held", "stale"), put("b", "stale")], [{ key: bytes("held"), value: bytes("0") }]),
    // Built on the first batch's value: holds, because the first is ahead of it in the group.
    engine.conditionalWrite([put("c", "follows")], [{ key: bytes("held"), value: bytes("1") }]),
  ], { concurrency: "unbounded" }));
  assert.deepEqual([first, stale, follows], [true, false, true]);
  assert.equal(counts.commits - before, 1, "one group");
  assert.equal(text(await Effect.runPromise(engine.get(bytes("held")))), "1");
  assert.equal(await Effect.runPromise(engine.get(bytes("b"))), undefined, "a refused batch writes nothing");
  assert.equal(text(await Effect.runPromise(engine.get(bytes("c")))), "follows");
});

test("a batch whose writes fail fails alone; the rest of its group still commits", async (t) => {
  const { engine } = engineIn(t);
  const results = await Effect.runPromise(Effect.all([
    engine.conditionalWrite([put("x", "1")], []),
    // Its second write fails, after its first has landed inside the shared transaction.
    engine.conditionalWrite([put("broken-first", "written then undone"), put("broken", "never")], []),
    engine.conditionalWrite([put("y", "2")], []),
  ].map((effect) => Effect.result(effect)), { concurrency: "unbounded" }));
  assert.deepEqual(results.map((result) => result._tag), ["Success", "Failure", "Success"]);
  assert.equal(results[1].failure._tag, "StoreError");
  assert.equal(text(await Effect.runPromise(engine.get(bytes("x")))), "1");
  assert.equal(text(await Effect.runPromise(engine.get(bytes("y")))), "2");
  assert.equal(await Effect.runPromise(engine.get(bytes("broken-first"))), undefined, "nothing of the failed batch survives");
});

test("a malformed batch is refused without leaving any batch of its group waiting", async (t) => {
  const { engine } = engineIn(t);
  const results = await Effect.runPromise(Effect.all([
    engine.conditionalWrite([put("before", "1")], []),
    engine.conditionalWrite([{ op: "put", key: bytes("malformed"), value: undefined }], []),
    engine.conditionalWrite([put("after", "2")], []),
  ].map((effect) => Effect.result(effect)), { concurrency: "unbounded" }));
  assert.equal(results[1]._tag, "Failure");
  assert.equal(results[1].failure._tag, "StoreError");
  // The engine is usable afterwards, and nothing is left half written.
  assert.equal(await Effect.runPromise(engine.conditionalWrite([put("later", "ok")], [])), true);
  assert.equal(await Effect.runPromise(engine.get(bytes("malformed"))), undefined);
});

test("a failed commit fails every batch in the group and leaves none of them written", async (t) => {
  const { engine, counts } = engineIn(t);
  counts.failNextCommit = true;
  const results = await Effect.runPromise(Effect.all(
    ["p", "q", "r"].map((key) => Effect.result(engine.conditionalWrite([put(key, key)], []))),
    { concurrency: "unbounded" },
  ));
  assert.deepEqual(results.map((result) => result._tag), ["Failure", "Failure", "Failure"]);
  for (const key of ["p", "q", "r"]) assert.equal(await Effect.runPromise(engine.get(bytes(key))), undefined);
  // The engine is usable afterwards.
  assert.equal(await Effect.runPromise(engine.conditionalWrite([put("after", "ok")], [])), true);
  assert.equal(text(await Effect.runPromise(engine.get(bytes("after")))), "ok");
});

test("an interrupted caller never leaves its batch undecided: a batch once queued is committed", async (t) => {
  const { engine } = engineIn(t);
  await Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(engine.conditionalWrite([put("queued", "yes")], []));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(fiber);
  }));
  assert.equal(text(await Effect.runPromise(engine.get(bytes("queued")))), "yes");
});

test("partitions of one shard commit together through the store, each keeping its own revision", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-group-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifest = { terms: [["title", "note"]], columns: [], measures: [], edges: [] };
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const shard = yield* makeNodeSqliteStore("s0", dir, { durability: "power" });
    const partitions = Array.from({ length: 8 }, (_, index) => shard.partition(`t${index}`));
    yield* Effect.forEach(partitions, (store) => Effect.forEach([1, 2, 3, 4, 5], (seq) =>
      store.transact((txn) => txn.put(seq, bytes(`n${seq}`), manifest, { namespace: "notes", key: String(seq) })),
    { discard: true }), { concurrency: "unbounded", discard: true });
    for (const store of partitions) assert.equal((yield* store.stats).records, 5);
  })));
});
