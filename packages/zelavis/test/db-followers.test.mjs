// A follower partition kept level with its leader: copied by `seed`, carried on
// by `followAll` from its own head, and copied again from the start only where
// carrying on could not be exact — and then it says why.
import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Fiber, Stream } from "effect";
import { followLeader, levelFollower } from "../dist/db/index.js";
import { makeMemoryStore } from "../dist/db/engines/memory-kv.js";
import { StoreError } from "../dist/db/errors.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const run = (body) => Effect.runPromise(Effect.scoped(body));
const manifest = (words) => ({ terms: words.map((w) => ["title", w]), columns: [], measures: [], edges: [] });
const put = (store, seq, body, words = ["w"]) =>
  store.transact((txn) => txn.put(seq, enc.encode(body), manifest(words), { namespace: "doc/x", key: `k${seq}` }));

/** A leader on one shard and an empty follower shard. */
const pair = Effect.gen(function* () {
  const leader = (yield* makeMemoryStore("one")).partition("acme");
  const shard = yield* makeMemoryStore("two");
  return { leader, shard, follower: { shard, partition: "acme" }, copy: () => shard.partition("acme") };
});

/** Every record as stored, and the log's head: equal for a level follower. */
const state = (store) => Effect.gen(function* () {
  const records = [...(yield* Stream.runCollect(store.records))].map(({ seq, record }) =>
    [Number(seq), record.live, record.version, record.live ? dec.decode(record.body) : null]);
  return { records, head: (yield* store.stats).head };
});

test("an empty follower is copied, then carried on from its head", () => run(Effect.gen(function* () {
  const { leader, follower, copy } = yield* pair;
  for (let seq = 1; seq <= 10; seq++) yield* put(leader, seq, `v1-${seq}`);
  yield* leader.transact((txn) => txn.retract(4));

  const first = yield* levelFollower(leader, follower);
  assert.equal(first.seed, "empty");
  assert.ok(first.seeded > 0);
  assert.deepEqual(yield* state(copy()), yield* state(leader));

  yield* put(leader, 2, "v2-2");
  yield* put(leader, 11, "v1-11");
  const second = yield* levelFollower(leader, follower);
  assert.deepEqual(second, { seeded: 0, applied: 2, more: false }, "carried on, not copied again");
  assert.deepEqual(yield* state(copy()), yield* state(leader));
})));

test("a follower whose head the leader has compacted past is copied again", () => run(Effect.gen(function* () {
  const { leader, follower, copy } = yield* pair;
  for (let seq = 1; seq <= 5; seq++) yield* put(leader, seq, `v1-${seq}`);
  yield* levelFollower(leader, follower);
  for (let seq = 1; seq <= 5; seq++) yield* put(leader, seq, `v2-${seq}`);
  yield* leader.compact({ keep: 1 });

  const pass = yield* levelFollower(leader, follower);
  assert.equal(pass.seed, "compacted");
  assert.deepEqual((yield* state(copy())).records, (yield* state(leader)).records);
  assert.equal((yield* copy().stats).head, (yield* leader.stats).head);
})));

test("a follower whose seed was cut off is copied again rather than carried on", () => run(Effect.gen(function* () {
  const { leader, follower, copy } = yield* pair;
  // Enough that the seed has written a batch, and marked itself unfinished,
  // before the cut.
  for (let seq = 1; seq <= 3000; seq++) yield* put(leader, seq, `v1-${seq}`, [`w${seq % 7}`, `u${seq}`]);
  // The records are copied a page per call; the read of the leader after them is cut off, so every
  // batch of records is written and the last, which clears the mark, never is.
  let scanned = false;
  const cut = {
    ...leader,
    scanRecords: (input) => Effect.tap(leader.scanRecords(input), () => Effect.sync(() => { scanned = true; })),
    stats: Effect.suspend(() => (scanned ? Effect.fail(new StoreError({ op: "test.read", cause: "cut off" })) : leader.stats)),
  };
  assert.equal((yield* Effect.flip(levelFollower(cut, follower)))._tag, "StoreError");
  assert.equal((yield* copy().stats).seeding, true, "the seed marked itself unfinished");

  const pass = yield* levelFollower(leader, follower);
  assert.equal(pass.seed, "unfinished");
  assert.deepEqual(yield* state(copy()), yield* state(leader));
})));

test("a follower holding another event at a position it shares with its leader is copied again", () => run(Effect.gen(function* () {
  const { leader, follower, copy } = yield* pair;
  for (let seq = 1; seq <= 3; seq++) yield* put(leader, seq, `v1-${seq}`);
  yield* levelFollower(leader, follower);
  // Written behind the follower's back, then the leader logs its own next event.
  yield* put(copy(), 9, "not the leader's");
  yield* put(leader, 4, "v1-4");

  const pass = yield* levelFollower(leader, follower);
  assert.equal(pass.seed, "diverged");
  assert.deepEqual(yield* state(copy()), yield* state(leader));
})));

test("a pass stops at its batch limit and says so, and the next carries on", () => run(Effect.gen(function* () {
  const { leader, follower, copy } = yield* pair;
  yield* put(leader, 1, "v1-1");
  yield* levelFollower(leader, follower);
  for (let version = 2; version <= 1301; version++) yield* put(leader, 1, `v${version}-1`);

  const passes = [];
  for (let tries = 0; tries < 10; tries++) {
    const pass = yield* levelFollower(leader, follower, { maxBatches: 1 });
    passes.push(pass);
    if (!pass.more) break;
  }
  // Each pass first re-reads the follower's last event to compare it, so a
  // pass of one 512-event batch applies 511 new ones; 1300 in all.
  assert.deepEqual(passes.map((pass) => [pass.applied, pass.more]), [[511, true], [511, true], [278, false]]);
  assert.deepEqual(yield* state(copy()), yield* state(leader));
})));

test("following keeps a follower level as the leader is written, until interrupted", () => run(Effect.gen(function* () {
  const { leader, follower, copy } = yield* pair;
  const following = yield* Effect.forkChild(followLeader(leader, follower, { interval: "2 millis" }));
  for (let seq = 1; seq <= 20; seq++) yield* put(leader, seq, `v1-${seq}`);
  const target = (yield* leader.stats).head;
  for (let tries = 0; tries < 500 && (yield* copy().stats).head < target; tries++) yield* Effect.sleep("2 millis");
  assert.deepEqual(yield* state(copy()), yield* state(leader));
  yield* Fiber.interrupt(following);
})));

test("a follower ahead of its leader is copied again", () => run(Effect.gen(function* () {
  const { leader, follower, copy } = yield* pair;
  for (let seq = 1; seq <= 3; seq++) yield* put(leader, seq, `v1-${seq}`);
  yield* levelFollower(leader, follower);
  yield* put(copy(), 9, "never the leader's");

  const pass = yield* levelFollower(leader, follower);
  assert.equal(pass.seed, "diverged");
  assert.deepEqual(yield* state(copy()), yield* state(leader));
})));

test("a read from a cursor includes the event it names; a read after it does not", () => run(Effect.gen(function* () {
  const { leader } = yield* pair;
  for (let seq = 1; seq <= 3; seq++) yield* put(leader, seq, `v1-${seq}`);
  const head = yield* leader.events.head;
  const from = [...(yield* Stream.runCollect(leader.events.read({ from: head })))];
  assert.deepEqual(from.map((event) => event.cursor), [head]);
  assert.deepEqual([...(yield* Stream.runCollect(leader.events.read({ after: head })))], []);
})));
