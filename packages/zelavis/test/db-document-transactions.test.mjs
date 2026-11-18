/**
 * `documents.transaction`: serializable read-decide-write over one Tenant's documents, on every engine.
 *
 * The body runs outside the writer; the commit re-reads everything the body read inside the writer's transaction
 * and refuses on any difference. The cases prove the lost update, the phantom, atomic failure, exhaustion, bounds,
 * the overlay, the outbox, the read-only path and the Promise form.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { makeDatabase, partitionMapFor } from "../dist/db/index.js";
import { makeMemoryStore } from "../dist/db/engines/memory-kv.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";
import { makeLmdbStore } from "../dist/db/engines/lmdb.js";
import { makeRocksdbJsStore } from "../dist/db/engines/rocksdb-js.js";
import { engineAvailable } from "./_engine-available.mjs";
import { openTemporaryDatabase } from "./_database.mjs";

const engines = [
  { name: "memory", open: () => (shard) => makeMemoryStore(shard) },
  { name: "node:sqlite", open: (dir) => (shard) => makeNodeSqliteStore(shard, dir) },
  ...(engineAvailable("lmdb") ? [{ name: "lmdb", open: (dir) => (shard) => makeLmdbStore(shard, dir) }] : []),
  ...(engineAvailable("@harperfast/rocksdb-js") ? [{ name: "rocksdb", open: (dir) => (shard) => makeRocksdbJsStore(shard, dir) }] : []),
];

const eventCount = (tenant) => Effect.gen(function* () {
  let count = 0;
  let after;
  for (;;) {
    const page = yield* tenant.events.read({ ...(after === undefined ? {} : { after }), limit: 1000 });
    count += page.events.length;
    if (!page.more) return count;
    after = page.cursor;
  }
});

const failureOf = (effect) => Effect.map(Effect.exit(effect), (exit) => {
  assert.ok(Exit.isFailure(exit), "expected a failure");
  return Cause.squash(exit.cause);
});

const cases = (name, withTenant) => {
  test(`${name}: 32 concurrent increments of one counter end at 32, one event each, with the default attempts`, () => withTenant((tenant) => Effect.gen(function* () {
    const documents = tenant.documents;
    yield* documents.createCollection({ name: "counters" });
    yield* documents.insert({ collection: "counters", id: "c", data: { n: 0 } });
    const before = yield* eventCount(tenant);
    yield* Effect.all(Array.from({ length: 32 }, () => documents.transaction((tx) => Effect.gen(function* () {
      const current = yield* tx.get({ collection: "counters", id: "c" });
      yield* tx.update({ collection: "counters", id: "c", data: { n: current.data.n + 1 } });
    }))), { concurrency: 32 });
    assert.equal((yield* documents.findById({ collection: "counters", id: "c" })).data.n, 32);
    assert.equal((yield* eventCount(tenant)) - before, 32);
  })));

  test(`${name}: two concurrent insert-unless-exists transactions insert exactly one`, () => withTenant((tenant) => Effect.gen(function* () {
    const documents = tenant.documents;
    yield* documents.createCollection({ name: "people", columns: ["email"] });
    yield* Effect.all(Array.from({ length: 2 }, () => documents.transaction((tx) => Effect.gen(function* () {
      const found = yield* tx.find({ collection: "people", where: [{ path: "email", value: "a@x" }], limit: 1 });
      if (found.length === 0) yield* tx.insert({ collection: "people", data: { email: "a@x" } });
    }))), { concurrency: 2 });
    assert.equal((yield* documents.findMany({ collection: "people", where: [{ path: "email", value: "a@x" }] })).length, 1);
  })));

  for (const readBy of ["id", "query"]) {
    test(`${name}: reading by ${readBy} retries after deletion and recreation at the same version`, () => withTenant((tenant) => Effect.gen(function* () {
      const documents = tenant.documents;
      yield* documents.createCollection({ name: "counters" });
      yield* documents.insert({ collection: "counters", id: "c", data: { n: 1 } });
      const read = yield* Deferred.make();
      const resume = yield* Deferred.make();
      const transaction = yield* Effect.forkChild(documents.transaction((tx) => Effect.gen(function* () {
        const before = readBy === "id"
          ? yield* tx.get({ collection: "counters", id: "c" })
          : (yield* tx.find({ collection: "counters", limit: 1 }))[0];
        yield* Deferred.succeed(read, undefined);
        yield* Deferred.await(resume);
        yield* tx.insert({ collection: "counters", id: "result", data: { n: before.data.n + 1 } });
      })));
      yield* Deferred.await(read);
      yield* documents.delete({ collection: "counters", id: "c" });
      const replacement = yield* documents.insert({ collection: "counters", id: "c", data: { n: 100 } });
      assert.equal(replacement.version, 1);
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(transaction);
      assert.equal((yield* documents.findById({ collection: "counters", id: "result" })).data.n, 101);
    })));
  }

  test(`${name}: reads inside a body see its own staged writes, ordered as findMany orders them`, () => withTenant((tenant) => Effect.gen(function* () {
    const documents = tenant.documents;
    yield* documents.createCollection({ name: "items", columns: ["kind", "rank"] });
    for (const [id, kind, rank] of [["a", "x", 3], ["b", "x", 1], ["c", "y", 2]]) {
      yield* documents.insert({ collection: "items", id, data: { kind, rank } });
    }
    const seen = yield* documents.transaction((tx) => Effect.gen(function* () {
      yield* tx.insert({ collection: "items", id: "d", data: { kind: "x", rank: 2 } });
      yield* tx.update({ collection: "items", id: "a", data: { kind: "y" } });
      yield* tx.delete({ collection: "items", id: "b" });
      const inserted = yield* tx.get({ collection: "items", id: "d" });
      const deleted = yield* tx.get({ collection: "items", id: "b" });
      const xs = yield* tx.find({ collection: "items", where: [{ path: "kind", value: "x" }], orderBy: [{ path: "rank" }], limit: 10 });
      const ys = yield* tx.find({ collection: "items", where: [{ path: "kind", value: "y" }], orderBy: [{ path: "rank" }], limit: 10 });
      return { inserted: inserted?.id, deleted, xs: xs.map((d) => d.id), ys: ys.map((d) => d.id) };
    }));
    assert.deepEqual(seen, { inserted: "d", deleted: undefined, xs: ["d"], ys: ["c", "a"] });
    const after = (kind) => documents.findMany({ collection: "items", where: [{ path: "kind", value: kind }], orderBy: [{ path: "rank" }] });
    assert.deepEqual((yield* after("x")).map((d) => d.id), ["d"]);
    assert.deepEqual((yield* after("y")).map((d) => d.id), ["c", "a"]);
  })));

  test(`${name}: a failing body commits nothing and appends no event; its error reaches the caller as itself`, () => withTenant((tenant) => Effect.gen(function* () {
    const documents = tenant.documents;
    yield* documents.createCollection({ name: "things" });
    const before = yield* eventCount(tenant);
    const boom = { _tag: "Boom", reason: "no" };
    const failure = yield* failureOf(documents.transaction((tx) => Effect.gen(function* () {
      yield* tx.insert({ collection: "things", id: "t", data: {} });
      return yield* Effect.fail(boom);
    })));
    assert.equal(failure, boom);
    assert.equal(yield* documents.findById({ collection: "things", id: "t" }), undefined);
    assert.equal(yield* eventCount(tenant), before);
  })));

  const conflicting = (documents) => (tx) => Effect.gen(function* () {
    const current = yield* tx.get({ collection: "counters", id: "c" });
    // Outside the transaction, so what the body read is stale by the time it commits.
    yield* documents.update({ collection: "counters", id: "c", data: { n: current.data.n + 1 } });
    yield* tx.update({ collection: "counters", id: "c", data: { n: -1 } });
  });

  test(`${name}: a body that always conflicts fails TransactionConflict after its attempts, or at its deadline`, () => withTenant((tenant) => Effect.gen(function* () {
    const documents = tenant.documents;
    yield* documents.createCollection({ name: "counters" });
    yield* documents.insert({ collection: "counters", id: "c", data: { n: 0 } });
    const exhausted = yield* failureOf(documents.transaction(conflicting(documents)));
    assert.equal(exhausted._tag, "TransactionConflict");
    assert.equal(exhausted.attempts, 8);
    assert.equal(exhausted.reason, "read-set");
    const started = Date.now();
    const late = yield* failureOf(documents.transaction(conflicting(documents), { deadlineMs: 100 }));
    assert.equal(late._tag, "TransactionConflict");
    assert.equal(late.reason, "deadline");
    assert.ok(Date.now() - started < 1000, "the deadline ends it within a second");
    assert.ok((yield* documents.findById({ collection: "counters", id: "c" })).data.n >= 8, "only the outside writes landed");
  })));

  test(`${name}: bounds refuse with TransactionTooLarge`, () => withTenant((tenant) => Effect.gen(function* () {
    const documents = tenant.documents;
    yield* documents.createCollection({ name: "things" });
    const refused = (body) => Effect.map(failureOf(documents.transaction(body)), (failure) => {
      assert.equal(failure._tag, "TransactionTooLarge");
      return failure.what;
    });
    assert.equal(yield* refused((tx) => Effect.forEach(Array.from({ length: 257 }, (_, n) => n), (n) =>
      tx.get({ collection: "things", id: `g${n}` }))), "point-reads");
    assert.equal(yield* refused((tx) => tx.find({ collection: "things", limit: 1001 })), "query-limit");
    assert.equal(yield* refused((tx) => Effect.forEach(Array.from({ length: 1001 }, (_, n) => n), (n) =>
      tx.insert({ collection: "things", id: `i${n}`, data: {} }))), "writes");
    assert.equal(yield* refused((tx) => tx.find({ collection: "things", search: "x", limit: 1 })), "query");
    assert.equal(yield* refused((tx) => Effect.forEach(Array.from({ length: 257 }, (_, n) => n), () =>
      tx.find({ collection: "things", limit: 1 }))), "query-reads");
  })));

  test(`${name}: a unique violation at commit is not retried`, () => withTenant((tenant) => Effect.gen(function* () {
    const documents = tenant.documents;
    yield* documents.createCollection({ name: "users", indexes: [{ name: "by_email", fields: [{ path: "email" }], unique: true }] });
    yield* documents.insert({ collection: "users", data: { email: "a@x" } });
    let runs = 0;
    const failure = yield* failureOf(documents.transaction((tx) => Effect.gen(function* () {
      runs += 1;
      yield* tx.insert({ collection: "users", data: { email: "a@x" } });
    })));
    assert.equal(failure._tag, "UniqueViolation");
    assert.equal(runs, 1);
  })));

  test(`${name}: emitted messages commit with the writes, and a failed transaction emits none`, () => withTenant((tenant) => Effect.gen(function* () {
    const documents = tenant.documents;
    yield* documents.createCollection({ name: "things" });
    yield* documents.transaction((tx) => Effect.gen(function* () {
      yield* tx.insert({ collection: "things", id: "t", data: {} });
      yield* tx.emit({ topic: "made", payload: { id: "t" } });
    }));
    yield* failureOf(documents.transaction((tx) => Effect.gen(function* () {
      yield* tx.emit({ topic: "lost", payload: {} });
      return yield* Effect.fail({ _tag: "Nope" });
    })));
    const page = yield* tenant.outbox.read({});
    assert.deepEqual(page.messages.map((message) => message.topic), ["made"]);
  })));

  test(`${name}: a body that only reads appends no event and never waits for the writer`, () => withTenant((tenant) => Effect.gen(function* () {
    const documents = tenant.documents;
    yield* documents.createCollection({ name: "things" });
    yield* documents.insert({ collection: "things", id: "t", data: { n: 1 } });
    const before = yield* eventCount(tenant);
    const gate = yield* Deferred.make();
    // A body in flight holds nothing of the writer: only its commit does.
    const slow = yield* Effect.forkChild(documents.transaction((tx) => Effect.gen(function* () {
      yield* tx.insert({ collection: "things", id: "slow", data: {} });
      yield* Deferred.await(gate);
    })));
    const read = yield* documents.transaction((tx) => tx.get({ collection: "things", id: "t" }));
    assert.equal(read.data.n, 1);
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(slow);
    assert.equal((yield* eventCount(tenant)) - before, 1, "only the slow writer appended an event");
  })));
};

for (const engine of engines) {
  cases(`transactions on ${engine.name}`, (use) => {
    const dir = mkdtempSync(join(tmpdir(), "zv-transactions-"));
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const db = yield* makeDatabase({
        partitionMap: partitionMapFor(["s0"]),
        openShard: engine.open(dir),
      });
      yield* use(db.forTenant("acme"));
    }))).finally(() => rmSync(dir, { recursive: true, force: true }));
  });
}

test("the Promise form: 32 concurrent increments through TenantRuntimeApi.documents.transaction", async (t) => {
  const db = await openTemporaryDatabase(t);
  const tenant = db.api.forTenant("t1");
  await tenant.documents.createCollection({ name: "counters" });
  await tenant.documents.insert({ collection: "counters", id: "c", data: { n: 0 } });
  await Promise.all(Array.from({ length: 32 }, () => tenant.documents.transaction(async (tx) => {
    const current = await tx.get({ collection: "counters", id: "c" });
    await tx.update({ collection: "counters", id: "c", data: { n: current.data.n + 1 } });
  })));
  assert.equal((await tenant.documents.findById({ collection: "counters", id: "c" })).data.n, 32);
  const boom = new Error("rejected");
  await assert.rejects(tenant.documents.transaction(async () => { throw boom; }), (error) => error === boom);
});
