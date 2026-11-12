// The mailbox against an exact model, under seeded random sequences of sends (with and without a primary key),
// processing that succeeds, fails or is cancelled from under it, cancels, and time passing. Each seed prints itself
// on failure so the run can be repeated. What the model holds the store to: every message's status and attempts, each
// entity's counts and state, processing strictly in arrival order per entity, and a failed message's place taken by
// the next only once it is finished.
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { makeDatabase, partitionMapFor } from "../dist/db/index.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { openShardOverKv } from "../dist/db/kv-store.js";

/** mulberry32: small, seeded, the same sequence on every host. */
const random = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const MAX_ATTEMPTS = 3;
const RETRY = [1000, 2000, 4000];

const run = (seed) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const next = random(seed);
  const pick = (list) => list[Math.floor(next() * list.length)];
  const db = yield* makeDatabase({ partitionMap: partitionMapFor(["s0"]), crossTenantRefresh: false, openShard: (shard) => openShardOverKv(shard, memoryKvEngine()) });
  const entities = db.forTenant("acme").entities;
  const ids = ["a", "b", "c"];
  // The model: per entity, its queue of owed keys (arrival order); per message, what it must be.
  const queue = new Map(ids.map((id) => [id, []]));
  const messages = new Map();
  const counts = new Map(ids.map((id) => [id, { processed: 0, failed: 0, seen: [] }]));
  const notBefore = new Map(); // key -> time its head may run
  let now = 0;
  let serial = 0;

  for (let step = 0; step < 300; step++) {
    const roll = next();
    const id = pick(ids);
    if (roll < 0.4) {
      const keyed = next() < 0.3 && messages.size > 0;
      const primaryKey = keyed ? pick([...messages.keys()].filter((key) => key.startsWith(`${id}:`)).concat([`${id}:k${serial}`])) : undefined;
      const n = serial++;
      const sent = yield* entities.send({ type: "t", id, tag: "m", payload: { n }, ...(primaryKey === undefined ? {} : { primaryKey }) });
      const key = `${id}:${sent.message.messageKey}`;
      if (messages.has(key)) {
        assert.equal(sent.duplicate, true, `seed ${seed} step ${step}: a known key is a duplicate`);
        assert.equal(sent.message.status, messages.get(key).status, `seed ${seed} step ${step}`);
      } else {
        assert.equal(sent.duplicate, false, `seed ${seed} step ${step}`);
        messages.set(key, { status: "pending", attempts: 0, n });
        queue.get(id).push(key);
        notBefore.set(key, 0);
      }
    } else if (roll < 0.8) {
      const succeed = next() < 0.6;
      const outcome = yield* entities.process("t", id, (message) => succeed
        ? Effect.succeed({ state: { last: message.payload.n }, reply: message.payload.n })
        : Effect.fail(new Error("no")), { maxAttempts: MAX_ATTEMPTS });
      const head = queue.get(id)[0];
      if (head === undefined) { assert.equal(outcome._tag, "Idle", `seed ${seed} step ${step}`); continue; }
      if (notBefore.get(head) > now) { assert.equal(outcome._tag, "Waiting", `seed ${seed} step ${step}`); continue; }
      const model = messages.get(head);
      assert.equal(outcome.messageKey, head.slice(id.length + 1), `seed ${seed} step ${step}: the head, in arrival order`);
      model.attempts += 1;
      if (succeed) {
        assert.equal(outcome._tag, "Processed", `seed ${seed} step ${step}`);
        model.status = "processed";
        queue.get(id).shift();
        counts.get(id).processed += 1;
        counts.get(id).seen.push(model.n);
      } else if (model.attempts >= MAX_ATTEMPTS) {
        assert.equal(outcome._tag, "Failed", `seed ${seed} step ${step}`);
        model.status = "failed";
        queue.get(id).shift();
        counts.get(id).failed += 1;
      } else {
        assert.equal(outcome._tag, "Retrying", `seed ${seed} step ${step}`);
        notBefore.set(head, now + RETRY[model.attempts - 1]);
      }
    } else if (roll < 0.9) {
      const owed = queue.get(id);
      if (owed.length === 0) continue;
      const key = pick(owed);
      const answer = yield* entities.cancel({ type: "t", id, messageKey: key.slice(id.length + 1) });
      assert.equal(answer.cancelled, true, `seed ${seed} step ${step}`);
      messages.get(key).status = "cancelled";
      owed.splice(owed.indexOf(key), 1);
    } else {
      const by = pick([500, 1000, 3000]);
      now += by;
      yield* TestClock.adjust(`${by} millis`);
    }
  }

  for (const [key, model] of messages) {
    const [id, ...rest] = key.split(":");
    const stored = yield* entities.message({ type: "t", id, messageKey: rest.join(":") });
    assert.equal(stored.status, model.status, `seed ${seed}: ${key}`);
    assert.equal(stored.attempts, model.attempts, `seed ${seed}: ${key} attempts`);
  }
  for (const id of ids) {
    const state = yield* entities.state({ type: "t", id });
    if (state === undefined) { assert.equal(queue.get(id).length + counts.get(id).processed, 0); continue; }
    assert.equal(state.pending, queue.get(id).length, `seed ${seed}: ${id} pending`);
    assert.equal(state.processed, counts.get(id).processed, `seed ${seed}: ${id} processed`);
    assert.equal(state.failed, counts.get(id).failed, `seed ${seed}: ${id} failed`);
    const seen = counts.get(id).seen;
    assert.deepEqual(state.state, seen.length === 0 ? null : { last: seen.at(-1) }, `seed ${seed}: ${id} state`);
    const owed = (yield* entities.mailbox({ type: "t", id })).messages.map((message) => `${id}:${message.messageKey}`);
    assert.deepEqual(owed, queue.get(id), `seed ${seed}: ${id} mailbox in arrival order`);
  }
}).pipe(Effect.provide(TestClock.layer()))));

test("the mailbox matches an exact model across seeded random histories", async () => {
  for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]) await run(seed);
});
