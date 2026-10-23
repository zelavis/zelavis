// The transactional outbox: a message emitted with a write exists exactly when
// the write does, and is read back in commit order from a cursor that moves
// past everything a read looks at.
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { makeDatabase, partitionMapFor } from "../dist/db/index.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { openShardOverKv } from "../dist/db/kv-store.js";

const withDatabase = (body, shards = ["s0"]) => {
  const stores = new Map();
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const db = yield* makeDatabase({
      partitionMap: partitionMapFor(shards),
      openShard: (shard) => Effect.tap(openShardOverKv(shard, memoryKvEngine()), (store) => Effect.sync(() => stores.set(shard, store))),
    });
    return yield* body({ db, tenant: db.forTenant("acme"), stores });
  })));
};

const ids = (page) => page.messages.map((message) => message.id);

test("a message emitted with a write commits with it, and a batch that fails emits nothing", () =>
  withDatabase(({ tenant }) => Effect.gen(function* () {
    yield* tenant.documents.createCollection({ name: "orders" });
    yield* tenant.documents.write({
      operations: [{ _tag: "Insert", collection: "orders", id: "o1", data: { total: 10 } }],
      emit: [{ topic: "order.placed", payload: { order: "o1" }, id: "m1" }],
    });
    const refused = yield* Effect.flip(tenant.documents.write({
      operations: [{ _tag: "Insert", collection: "orders", id: "o1", data: { total: 99 } }],
      emit: [{ topic: "order.placed", payload: { order: "o1 again" }, id: "m2" }],
    }));
    assert.equal(refused._tag, "DocumentConflict");

    const page = yield* tenant.outbox.read();
    assert.deepEqual(ids(page), ["m1"], "the refused batch's message is not there");
    assert.deepEqual(page.messages[0].payload, { order: "o1" });
    assert.equal(page.messages[0].topic, "order.placed");
    assert.ok(!Number.isNaN(Date.parse(page.messages[0].emittedAt)));
    assert.equal(page.more, false);
  })));

test("messages read back in commit order, a page at a time, past everything else in the log", () =>
  withDatabase(({ tenant }) => Effect.gen(function* () {
    yield* tenant.documents.createCollection({ name: "notes" });
    for (let i = 0; i < 5; i++) {
      yield* tenant.documents.insert({ collection: "notes", data: { i } });
      yield* tenant.outbox.emit({ topic: i % 2 === 0 ? "even" : "odd", payload: { i }, id: `m${i}` });
      yield* tenant.documents.insert({ collection: "notes", data: { i, after: true } });
    }

    const first = yield* tenant.outbox.read({ limit: 2 });
    assert.deepEqual(ids(first), ["m0", "m1"]);
    assert.equal(first.more, true);
    assert.equal(first.cursor, first.messages[1].cursor, "a full page stops on the message that filled it");
    const rest = yield* tenant.outbox.read({ after: first.cursor });
    assert.deepEqual(ids(rest), ["m2", "m3", "m4"]);
    assert.equal(rest.more, false);
    const caughtUp = yield* tenant.outbox.read({ after: rest.cursor });
    assert.deepEqual(caughtUp.messages, []);
    assert.equal(caughtUp.cursor, rest.cursor, "nothing new, so the cursor stays");

    assert.deepEqual(ids(yield* tenant.outbox.read({ topic: "even" })), ["m0", "m2", "m4"]);
    // The last message is followed by a note: the cursor goes past it too.
    const tail = yield* tenant.outbox.read({ after: (yield* tenant.outbox.read()).messages[4].cursor });
    assert.deepEqual(tail.messages, []);
    assert.notEqual(tail.cursor, (yield* tenant.outbox.read()).messages[4].cursor);
  })));

test("an id the outbox holds, or one twice in a batch, refuses the batch whole", () =>
  withDatabase(({ tenant }) => Effect.gen(function* () {
    yield* tenant.documents.createCollection({ name: "orders" });
    yield* tenant.outbox.emit({ topic: "t", payload: {}, id: "m1" });
    const held = yield* Effect.flip(tenant.documents.write({
      operations: [{ _tag: "Insert", collection: "orders", id: "o1", data: {} }],
      emit: [{ topic: "t", payload: {}, id: "m1" }],
    }));
    assert.deepEqual([held._tag, held.id], ["MessageExists", "m1"]);
    assert.equal(yield* tenant.documents.findById({ collection: "orders", id: "o1" }), undefined, "and the insert did not happen");

    const twice = yield* Effect.flip(tenant.documents.write({
      operations: [],
      emit: [{ topic: "t", payload: {}, id: "m2" }, { topic: "t", payload: {}, id: "m2" }],
    }));
    assert.equal(twice._tag, "MessageExists");
    assert.deepEqual(ids(yield* tenant.outbox.read()), ["m1"]);
  })));

test("an emit with an idempotency key happens once, and its replays name the same message", () =>
  withDatabase(({ tenant }) => Effect.gen(function* () {
    const first = yield* tenant.outbox.emit({ topic: "t", payload: { n: 1 }, idempotencyKey: "k1" });
    const again = yield* tenant.outbox.emit({ topic: "t", payload: { n: 1 }, idempotencyKey: "k1" });
    assert.deepEqual(first, { id: "idempotent:k1" }, "an id taken from the key");
    assert.deepEqual(again, first);
    assert.deepEqual(ids(yield* tenant.outbox.read()), [first.id], "one message, not two");
    const own = yield* tenant.outbox.emit({ topic: "t", payload: {}, id: "mine", idempotencyKey: "k2" });
    assert.deepEqual(own, { id: "mine" });
    const reused = yield* Effect.flip(tenant.outbox.emit({ topic: "t", payload: { n: 2 }, idempotencyKey: "k1" }));
    assert.equal(reused._tag, "IdempotencyKeyReused");
  })));

test("handled messages are removed by id; ids not held are skipped", () =>
  withDatabase(({ tenant }) => Effect.gen(function* () {
    for (const id of ["m1", "m2", "m3"]) yield* tenant.outbox.emit({ topic: "t", payload: {}, id });
    assert.deepEqual(yield* tenant.outbox.remove({ ids: ["m1", "m3", "nope", "m1"] }), { removed: 2 });
    assert.deepEqual(ids(yield* tenant.outbox.read()), ["m2"]);
    // A removed id is free to be emitted again; consumers deduplicate by id.
    yield* tenant.outbox.emit({ topic: "t", payload: { again: true }, id: "m1" });
    assert.deepEqual(ids(yield* tenant.outbox.read()), ["m2", "m1"]);
    const tooMany = yield* Effect.flip(tenant.outbox.remove({ ids: Array.from({ length: 1001 }, (_, i) => `x${i}`) }));
    assert.equal(tooMany._tag, "InvalidMessage");
  })));

test("a message that cannot be one is refused before anything is written", () =>
  withDatabase(({ tenant }) => Effect.gen(function* () {
    for (const bad of [
      { topic: "", payload: {} },
      { topic: "x".repeat(257), payload: {} },
      { topic: "t", payload: {}, id: "" },
      { topic: "t", payload: [] },
      { topic: "t", payload: { n: Number.NaN } },
    ]) {
      assert.equal((yield* Effect.flip(tenant.outbox.emit(bad)))._tag, "InvalidMessage", JSON.stringify(bad));
    }
    assert.deepEqual((yield* tenant.outbox.read()).messages, []);
  })));

test("a tenant behind a move's fence refuses to emit", () =>
  withDatabase(({ db, tenant, stores }) => Effect.gen(function* () {
    yield* stores.get(db.shardOf("acme")).partition("acme").fence({ from: "s0", to: "s1" });
    assert.equal((yield* Effect.flip(tenant.outbox.emit({ topic: "t", payload: {} })))._tag, "TenantMoving");
  })));

test("a moved tenant's outbox cursor carries on on its new shard", () =>
  withDatabase(({ db, tenant }) => Effect.gen(function* () {
    yield* tenant.outbox.emit({ topic: "t", payload: {}, id: "before" });
    const cursor = (yield* tenant.outbox.read()).cursor;
    const target = db.shardOf("acme") === "s0" ? "s1" : "s0";
    yield* db.movement.rebalance({ version: 2, virtualRanges: 256, placements: [{ from: 0, to: 256, shard: target }] });
    assert.equal(db.shardOf("acme"), target);

    yield* tenant.outbox.emit({ topic: "t", payload: {}, id: "after" });
    assert.deepEqual(ids(yield* tenant.outbox.read({ after: cursor })), ["after"], "the cursor taken before the move continues after it");
    assert.deepEqual(ids(yield* tenant.outbox.read()), ["before", "after"]);
  }), ["s0", "s1"]));
