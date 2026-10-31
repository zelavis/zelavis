// Durable entities: a mailbox and state in the Tenant's own partition, messages processed one at a time per entity in
// the order they arrived, and a handler's writes committed with the message's processed mark, so its database effects
// land once however often it runs. These tests hold the mailbox to that: sends, duplicates by primary key, order,
// the step committed whole or not at all, retries and failure, cancelling, delayed delivery, a full mailbox, a moved
// Tenant, retention, and the runner that serves them.
import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { makeDatabase, partitionMapFor } from "../dist/db/index.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { openShardOverKv } from "../dist/db/kv-store.js";

const map = partitionMapFor(["s0", "s1"]);
const allOn = (shard, version) => ({ version, virtualRanges: 256, placements: [{ from: 0, to: 256, shard }] });

const withDatabase = (body) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const db = yield* makeDatabase({
      partitionMap: map,
      crossTenantRefresh: false,
      openShard: (shard) => openShardOverKv(shard, memoryKvEngine()),
    });
    return yield* body(db);
  })));

/** A counter document per entity, raised by every message: what "exactly once" is measured by. */
const counting = (documents) => (message, context) =>
  Effect.gen(function* () {
    const current = yield* Effect.orDie(documents.findById({ collection: "counters", id: message.id }));
    const count = (current?.data.count ?? 0) + 1;
    return {
      writes: [current === undefined
        ? { _tag: "Insert", collection: "counters", id: message.id, data: { count } }
        : { _tag: "Update", collection: "counters", id: message.id, data: { count }, expectedVersion: current.version }],
      state: { seen: [...(context.state?.seen ?? []), message.payload.n] },
      reply: { count },
    };
  });

const drainAll = (entities, type, id, handler) =>
  Effect.gen(function* () {
    const outcomes = [];
    for (;;) {
      const outcome = yield* entities.process(type, id, handler);
      outcomes.push(outcome._tag);
      if (outcome._tag !== "Processed" && outcome._tag !== "Failed") return outcomes;
    }
  });

test("a message is kept until processed, in order, and its writes, state and reply commit with it", () =>
  withDatabase((db) => Effect.gen(function* () {
    const tenant = db.forTenant("acme");
    yield* tenant.documents.createCollection({ name: "counters" });
    for (let n = 1; n <= 5; n++) {
      const sent = yield* tenant.entities.send({ type: "chat", id: "general", tag: "said", payload: { n } });
      assert.equal(sent.duplicate, false);
      assert.equal(sent.message.status, "pending");
    }
    assert.equal((yield* tenant.entities.mailbox({ type: "chat", id: "general" })).messages.length, 5);
    assert.equal((yield* tenant.entities.state({ type: "chat", id: "general" })).pending, 5);

    assert.deepEqual(yield* drainAll(tenant.entities, "chat", "general", counting(tenant.documents)),
      ["Processed", "Processed", "Processed", "Processed", "Processed", "Idle"]);
    const state = yield* tenant.entities.state({ type: "chat", id: "general" });
    assert.deepEqual(state.state, { seen: [1, 2, 3, 4, 5] }, "one at a time, in the order they arrived");
    assert.deepEqual([state.pending, state.processed, state.failed], [0, 5, 0]);
    assert.equal((yield* tenant.documents.findById({ collection: "counters", id: "general" })).data.count, 5);
    assert.deepEqual((yield* tenant.entities.mailbox({ type: "chat", id: "general" })).messages, []);
  })));

test("a primary key names one message: sending it again answers the message already there", () =>
  withDatabase((db) => Effect.gen(function* () {
    const tenant = db.forTenant("acme");
    yield* tenant.documents.createCollection({ name: "counters" });
    const first = yield* tenant.entities.send({ type: "chat", id: "general", tag: "said", payload: { n: 1 }, primaryKey: "slack-1700000000.0001" });
    const again = yield* tenant.entities.send({ type: "chat", id: "general", tag: "said", payload: { n: 1 }, primaryKey: "slack-1700000000.0001" });
    assert.equal(again.duplicate, true);
    assert.equal(again.message.messageKey, first.message.messageKey);
    assert.equal((yield* tenant.entities.state({ type: "chat", id: "general" })).pending, 1, "kept once");
    yield* drainAll(tenant.entities, "chat", "general", counting(tenant.documents));
    const after = yield* tenant.entities.send({ type: "chat", id: "general", tag: "said", payload: { n: 1 }, primaryKey: "slack-1700000000.0001" });
    assert.equal(after.duplicate, true);
    assert.equal(after.message.status, "processed");
    assert.deepEqual(after.message.reply, { count: 1 });
    assert.equal((yield* tenant.documents.findById({ collection: "counters", id: "general" })).data.count, 1, "and processed once");
  })));

test("a step that cannot commit commits nothing, and the message is retried after a pause, then failed", () =>
  withDatabase((db) => Effect.gen(function* () {
    const tenant = db.forTenant("acme");
    yield* tenant.documents.createCollection({ name: "counters" });
    yield* tenant.entities.send({ type: "job", id: "j1", tag: "run", payload: {} });
    yield* tenant.entities.send({ type: "job", id: "j1", tag: "run", payload: {} });
    // Writes a counter and then a document into a collection that does not exist: the whole step is refused.
    const broken = () => Effect.succeed({
      writes: [
        { _tag: "Insert", collection: "counters", id: "x", data: { count: 1 } },
        { _tag: "Insert", collection: "missing", id: "y", data: {} },
      ],
      state: { touched: true },
    });
    const first = yield* tenant.entities.process("job", "j1", broken, { maxAttempts: 2 });
    assert.equal(first._tag, "Retrying");
    assert.equal(first.attempts, 1);
    assert.equal(yield* tenant.documents.findById({ collection: "counters", id: "x" }), undefined, "nothing of the step landed");
    assert.equal((yield* tenant.entities.state({ type: "job", id: "j1" })).state, null);
    assert.equal((yield* tenant.entities.process("job", "j1", broken, { maxAttempts: 2 }))._tag, "Waiting", "the pause holds the entity, in order");
    yield* TestClock.adjust("2 seconds");
    const second = yield* tenant.entities.process("job", "j1", broken, { maxAttempts: 2 });
    assert.equal(second._tag, "Failed");
    assert.match(second.error, /CollectionNotFound/);
    const failed = yield* tenant.entities.message({ type: "job", id: "j1", messageKey: second.messageKey });
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempts, 2);
    // The next message goes on.
    assert.equal((yield* tenant.entities.process("job", "j1", () => Effect.succeed({ reply: "ok" })))._tag, "Processed");
    assert.deepEqual(
      ((s) => [s.pending, s.processed, s.failed])(yield* tenant.entities.state({ type: "job", id: "j1" })), [0, 1, 1]);
    // A handler that throws or answers nonsense is a failed attempt too, never a commit.
    yield* tenant.entities.send({ type: "job", id: "j2", tag: "run", payload: {} });
    assert.equal((yield* tenant.entities.process("job", "j2", () => Effect.fail(new Error("boom"))))._tag, "Retrying");
    yield* TestClock.adjust("10 minutes");
    const nonsense = yield* tenant.entities.process("job", "j2", () => Effect.succeed({ write: [] }));
    assert.equal(nonsense._tag, "Retrying");
    assert.match((yield* tenant.entities.message({ type: "job", id: "j2", messageKey: nonsense.messageKey })).lastError, /no "write"/);
  }).pipe(Effect.provide(TestClock.layer()))));

test("a message cancelled while its handler runs is not finished by it", () =>
  withDatabase((db) => Effect.gen(function* () {
    const tenant = db.forTenant("acme");
    yield* tenant.documents.createCollection({ name: "counters" });
    const sent = yield* tenant.entities.send({ type: "job", id: "j1", tag: "run", payload: {} });
    const handler = () => Effect.gen(function* () {
      // Someone cancels it while the handler is still deciding.
      const cancelled = yield* tenant.entities.cancel({ type: "job", id: "j1", messageKey: sent.message.messageKey });
      assert.equal(cancelled.cancelled, true);
      return { writes: [{ _tag: "Insert", collection: "counters", id: "x", data: { count: 1 } }] };
    });
    assert.equal((yield* tenant.entities.process("job", "j1", handler))._tag, "Superseded");
    assert.equal(yield* tenant.documents.findById({ collection: "counters", id: "x" }), undefined, "the superseded step wrote nothing");
    assert.equal((yield* tenant.entities.message({ type: "job", id: "j1", messageKey: sent.message.messageKey })).status, "cancelled");
    assert.equal((yield* tenant.entities.cancel({ type: "job", id: "j1", messageKey: sent.message.messageKey })).cancelled, false, "once");
  })));

test("delayed delivery waits for its time, and a full mailbox refuses more", () =>
  withDatabase((db) => Effect.gen(function* () {
    const tenant = db.forTenant("acme");
    const later = new Date(Date.now() + 60_000).toISOString();
    yield* tenant.entities.send({ type: "reminder", id: "r1", tag: "ping", payload: {}, deliverAt: later });
    const waiting = yield* tenant.entities.process("reminder", "r1", () => Effect.succeed({}));
    assert.equal(waiting._tag, "Waiting");
    assert.equal(waiting.until, Date.parse(later));
    const due = yield* tenant.entities.due();
    assert.deepEqual(due, [{ type: "reminder", id: "r1", notBefore: Date.parse(later) }]);

    const refused = yield* Effect.flip(tenant.entities.send({ type: "Bad type", id: "x", tag: "t", payload: {} }));
    assert.equal(refused._tag, "InvalidEntityMessage");
    assert.equal((yield* Effect.flip(tenant.entities.send({ type: "t", id: "x", tag: "t", payload: { n: Number.NaN } })))._tag, "InvalidEntityMessage");
  })));

test("a mailbox holds at most 4096 unfinished messages", { timeout: 120_000 }, () =>
  withDatabase((db) => Effect.gen(function* () {
    const tenant = db.forTenant("acme");
    for (let n = 0; n < 4096; n++) yield* tenant.entities.send({ type: "flood", id: "f", tag: "m", payload: {} });
    const full = yield* Effect.flip(tenant.entities.send({ type: "flood", id: "f", tag: "m", payload: {} }));
    assert.equal(full._tag, "MailboxFull");
    assert.equal(full.capacity, 4096);
    yield* tenant.entities.send({ type: "flood", id: "other", tag: "m", payload: {} });
  })));

test("a moved Tenant keeps its mailboxes, and finished messages are removed after retention", () =>
  withDatabase((db) => Effect.gen(function* () {
    const tenant = db.forTenant("acme");
    yield* tenant.documents.createCollection({ name: "counters" });
    yield* tenant.entities.send({ type: "chat", id: "c", tag: "said", payload: { n: 1 }, primaryKey: "k1" });
    yield* tenant.entities.send({ type: "chat", id: "c", tag: "said", payload: { n: 2 } });
    const from = db.shardOf("acme");
    yield* db.movement.rebalance(allOn(from === "s0" ? "s1" : "s0", 2));
    assert.notEqual(db.shardOf("acme"), from);
    assert.equal((yield* tenant.entities.mailbox({ type: "chat", id: "c" })).messages.length, 2, "the mailbox moved with its Tenant");
    yield* drainAll(tenant.entities, "chat", "c", counting(tenant.documents));
    assert.equal((yield* tenant.documents.findById({ collection: "counters", id: "c" })).data.count, 2);

    assert.deepEqual(yield* tenant.entities.prune({ before: Date.now() - 60_000 }), { removed: 0 }, "nothing is old enough yet");
    assert.deepEqual(yield* tenant.entities.prune({ before: Date.now() + 60_000 }), { removed: 2 });
    assert.equal(yield* tenant.entities.message({ type: "chat", id: "c", messageKey: "k1" }), undefined);
    assert.equal((yield* tenant.entities.send({ type: "chat", id: "c", tag: "said", payload: { n: 1 }, primaryKey: "k1" })).duplicate, false,
      "past retention a key is forgotten");
  })));

test("the runner serves every Tenant's entities with the handlers it is given, at once on a send", () =>
  withDatabase((db) => Effect.gen(function* () {
    for (const name of ["acme", "globex"]) yield* db.forTenant(name).documents.createCollection({ name: "counters" });
    const handlers = (type) => type === "chat"
      ? (message, context) => counting(db.forTenant(context.tenant).documents)(message, context)
      : undefined;
    const runner = yield* Effect.forkScoped(db.entities.serve({ handlers, sweepInterval: "1 hour" }));
    for (let n = 1; n <= 10; n++) {
      yield* db.forTenant(n % 2 === 0 ? "acme" : "globex").entities.send({ type: "chat", id: `room-${n % 3}`, tag: "said", payload: { n } });
    }
    yield* db.forTenant("acme").entities.send({ type: "unhandled", id: "u", tag: "said", payload: {} });
    const total = Effect.gen(function* () {
      let sum = 0;
      for (const name of ["acme", "globex"]) {
        for (const id of ["room-0", "room-1", "room-2"]) sum += (yield* db.forTenant(name).documents.findById({ collection: "counters", id }))?.data.count ?? 0;
      }
      return sum;
    });
    for (let tries = 0; (yield* total) < 10; tries++) {
      assert.ok(tries < 200, "every message processed without waiting for a sweep");
      yield* Effect.sleep("10 millis");
    }
    assert.equal(yield* total, 10);
    assert.equal((yield* db.forTenant("acme").entities.state({ type: "unhandled", id: "u" })).pending, 1, "a type with no handler keeps its messages");
    yield* Fiber.interrupt(runner);
  })));
