// Writer leases and follower failover. The protocol is held to an exact model under seeded random sequences with
// the clock under control; the gate is held to refuse a paused writer before anyone else may write; and a follower
// on a second database is promoted when the writer's lease lapses, keeping what the writer had replicated and the
// log positions a cursor taken on the writer continues on.
import assert from "node:assert/strict";
import test from "node:test";
import { Clock, Effect, Exit, Fiber, Scope } from "effect";
import { TestClock } from "effect/testing";
import {
  acquireWriter, memoryLeaseStore, promoteFollower, releaseWriter, renewWriter,
} from "../dist/db/writer-lease.js";
import { openTemporaryDatabase } from "./_database.mjs";

const wait = (millis) => new Promise((resolve) => setTimeout(resolve, millis));
const until = async (condition, what, millis = 15_000) => {
  for (const started = Date.now(); !(await condition()); await wait(25)) assert.ok(Date.now() - started < millis, what);
};
const fail = (exit) => (Exit.isFailure(exit) ? exit.cause.reasons.map((reason) => reason.error).find((error) => error !== undefined) : undefined);

test("a lease changes hands only by expiry or release, only to a follower that holds what was acknowledged, and only once", () =>
  Effect.runPromise(Effect.gen(function* () {
    const leases = memoryLeaseStore();
    const none = yield* Effect.exit(promoteFollower(leases, { partition: "p", owner: "B", ttlMillis: 1000, followerHead: 0 }));
    assert.equal(fail(none)._tag, "NoWriterLease");

    const first = yield* acquireWriter(leases, { partition: "p", owner: "A", ttlMillis: 1000 });
    assert.equal(first.epoch, 1);
    assert.equal(fail(yield* Effect.exit(acquireWriter(leases, { partition: "p", owner: "B", ttlMillis: 1000 })))._tag, "LeaseOwnedByAnother",
      "another owner does not simply acquire");
    assert.equal(fail(yield* Effect.exit(promoteFollower(leases, { partition: "p", owner: "B", ttlMillis: 1000, followerHead: 9 })))._tag, "LeaseStillHeld",
      "an unexpired lease is not taken");

    const renewed = yield* renewWriter(leases, first, { ttlMillis: 1000, acknowledgedHead: 40 });
    assert.equal(renewed.acknowledgedHead, 40);
    assert.equal((yield* renewWriter(leases, renewed, { ttlMillis: 1000, acknowledgedHead: 10 })).acknowledgedHead, 40, "acknowledgments only rise");

    yield* TestClock.adjust("1 second");
    const behind = fail(yield* Effect.exit(promoteFollower(leases, { partition: "p", owner: "B", ttlMillis: 1000, followerHead: 35 })));
    assert.deepEqual([behind._tag, behind.head, behind.required], ["FollowerBehind", 35, 40], "a follower missing acknowledged writes is not promoted");

    // Two followers race from the same observation: one wins.
    const results = yield* Effect.all([
      Effect.exit(promoteFollower(leases, { partition: "p", owner: "B", ttlMillis: 1000, followerHead: 40 })),
      Effect.exit(promoteFollower(leases, { partition: "p", owner: "C", ttlMillis: 1000, followerHead: 41 })),
    ], { concurrency: "unbounded" });
    assert.equal(results.filter(Exit.isSuccess).length, 1, "exactly one promotion lands");
    const winner = results.find(Exit.isSuccess).value;
    assert.equal(winner.lease.epoch, 2);
    assert.equal(winner.lostPositions, 0);

    // The old writer, returning, is fenced by the epoch; it cannot renew or release the lease it no longer has.
    const fenced = fail(yield* Effect.exit(renewWriter(leases, renewed, { ttlMillis: 1000 })));
    assert.deepEqual([fenced._tag, fenced.claimed, fenced.current, fenced.reason], ["WriterFenced", 1, 2, "superseded"]);
    assert.equal(yield* releaseWriter(leases, renewed), false);

    // A release hands over at once; accepting loss says how much.
    assert.equal(yield* releaseWriter(leases, winner.lease), true);
    const lossy = yield* promoteFollower(leases, { partition: "p", owner: "D", ttlMillis: 1000, followerHead: 30, allowDataLoss: true });
    assert.equal(lossy.lease.epoch, 3);
    assert.equal(lossy.lostPositions, 10);
    const restarted = yield* acquireWriter(leases, { partition: "p", owner: "D", ttlMillis: 1000 });
    assert.equal(restarted.epoch, 4, "an owner starting again takes a new epoch, fencing its former self");
  }).pipe(Effect.provide(TestClock.layer()))));

test("only the designated standby is promoted without accepting loss, and the new writer names its own", () =>
  Effect.runPromise(Effect.gen(function* () {
    const leases = memoryLeaseStore();
    const first = yield* acquireWriter(leases, { partition: "p", owner: "A", ttlMillis: 1000, standby: "B" });
    assert.equal(first.standby, "B");
    yield* renewWriter(leases, first, { ttlMillis: 1000, acknowledgedHead: 5 });
    yield* TestClock.adjust("2 seconds");
    const refused = fail(yield* Effect.exit(promoteFollower(leases, { partition: "p", owner: "C", ttlMillis: 1000, followerHead: 9 })));
    assert.deepEqual([refused._tag, refused.standby, refused.owner], ["NotDesignatedStandby", "B", "C"], "another follower, even one that is level, is not known to hold what was acknowledged");
    const promoted = yield* promoteFollower(leases, { partition: "p", owner: "B", ttlMillis: 1000, followerHead: 5, successor: "A" });
    assert.deepEqual([promoted.lease.epoch, promoted.lease.standby], [2, "A"]);
    yield* TestClock.adjust("2 seconds");
    const override = yield* promoteFollower(leases, { partition: "p", owner: "C", ttlMillis: 1000, followerHead: 5, allowDataLoss: true });
    assert.equal(override.lease.epoch, 3, "an operator may override, accepting that acknowledged writes may be missing");
    assert.equal(override.lease.standby, undefined);
  }).pipe(Effect.provide(TestClock.layer()))));

const random = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const model = (seed) => Effect.runPromise(Effect.gen(function* () {
  const next = random(seed);
  const pick = (list) => list[Math.floor(next() * list.length)];
  const leases = memoryLeaseStore();
  const owners = ["A", "B", "C"];
  const TTL = 1000;
  // The reference: the lease, and the lease each owner believes it holds.
  let truth; // { owner, epoch, expiresAt, ack }
  const believed = new Map();
  let now = 0;
  let epochs = 0;
  const here = (step, what) => `seed ${seed} step ${step}: ${what}`;

  for (let step = 0; step < 300; step++) {
    const owner = pick(owners);
    const roll = next();
    if (roll < 0.25) {
      yield* TestClock.adjust(`${Math.floor(next() * 700)} millis`);
      now = yield* Clock.currentTimeMillis;
    } else if (roll < 0.45) {
      const exit = yield* Effect.exit(acquireWriter(leases, { partition: "p", owner, ttlMillis: TTL }));
      const allowed = truth === undefined || truth.owner === owner;
      assert.equal(Exit.isSuccess(exit), allowed, here(step, `acquire by ${owner} ${allowed ? "lands" : "is refused"}`));
      if (allowed) {
        assert.equal(exit.value.epoch, (truth?.epoch ?? 0) + 1, here(step, "an acquire raises the epoch by one"));
        truth = { owner, epoch: exit.value.epoch, expiresAt: now + TTL, ack: truth?.ack ?? 0 };
        believed.set(owner, exit.value);
        epochs++;
      }
    } else if (roll < 0.7) {
      const held = believed.get(owner);
      if (held === undefined) continue;
      const ack = Math.floor(next() * 60);
      const exit = yield* Effect.exit(renewWriter(leases, held, { ttlMillis: TTL, acknowledgedHead: ack }));
      const current = truth !== undefined && truth.owner === owner && truth.epoch === held.epoch;
      assert.equal(Exit.isSuccess(exit), current, here(step, `renew by ${owner} at epoch ${held.epoch} ${current ? "lands" : "is fenced"}`));
      if (current) {
        truth = { ...truth, expiresAt: now + TTL, ack: Math.max(truth.ack, ack) };
        believed.set(owner, exit.value);
      }
    } else if (roll < 0.9) {
      const head = Math.floor(next() * 60);
      const loss = next() < 0.2;
      const exit = yield* Effect.exit(promoteFollower(leases, { partition: "p", owner, ttlMillis: TTL, followerHead: head, allowDataLoss: loss }));
      const expected = truth === undefined ? "NoWriterLease" : truth.expiresAt > now ? "LeaseStillHeld" : head < truth.ack && !loss ? "FollowerBehind" : undefined;
      if (expected === undefined) {
        assert.ok(Exit.isSuccess(exit), here(step, `promotion of ${owner} (head ${head}, ack ${truth.ack}) lands`));
        assert.equal(exit.value.lease.epoch, truth.epoch + 1, here(step, "a promotion raises the epoch by one"));
        assert.equal(exit.value.lostPositions, Math.max(0, truth.ack - head), here(step, "and reports what it may have lost"));
        truth = { owner, epoch: exit.value.lease.epoch, expiresAt: now + TTL, ack: head };
        believed.set(owner, exit.value.lease);
        epochs++;
      } else {
        assert.equal(fail(exit)?._tag, expected, here(step, `promotion of ${owner} is refused as ${expected}`));
      }
    } else {
      const held = believed.get(owner);
      if (held === undefined) continue;
      const released = yield* releaseWriter(leases, held);
      const current = truth !== undefined && truth.owner === owner && truth.epoch === held.epoch;
      assert.equal(released, current, here(step, "only the lease actually held is released"));
      if (current) truth = { ...truth, expiresAt: 0 };
    }
    // The invariant that matters: at most one owner holds an unexpired lease of the current epoch.
    const read = yield* leases.read("p");
    if (truth !== undefined) {
      assert.deepEqual([read.lease.owner, read.lease.epoch], [truth.owner, truth.epoch], here(step, "the store holds the reference's lease"));
      const live = [...believed].filter(([name, lease]) => truth.owner === name && truth.epoch === lease.epoch && truth.expiresAt > now);
      assert.ok(live.length <= 1, here(step, "at most one live holder"));
    }
  }
  assert.ok(epochs > 3, `seed ${seed} exercised the protocol`);
}).pipe(Effect.provide(TestClock.layer())));

test("the lease protocol matches an exact model under seeded random sequences", async () => {
  for (const seed of [1, 2, 3, 7, 42, 99, 1234, 20261031]) await model(seed);
});

/** A lease store whose reach can be cut: while cut, every call hangs, as a partitioned writer's would. */
const partitionable = (inner) => {
  const state = { cut: false };
  const guarded = (call) => (...args) => (state.cut ? Effect.never : call(...args));
  return { state, store: { read: guarded(inner.read), create: guarded(inner.create), replace: guarded(inner.replace) } };
};

const inScope = (scope, effect) => Effect.runPromise(effect.pipe(Effect.provideService(Scope.Scope, scope)));
const newScope = () => Effect.runSync(Scope.make());
const closeScope = (scope) => Effect.runPromise(Scope.close(scope, Exit.void));

const docs = (database, id) => database.api.forTenant("acme").documents.findById({ collection: "posts", id: typeof id === "number" ? `p${id}` : id });
const insert = (database, n) => database.api.forTenant("acme").documents.insert({ collection: "posts", id: `p${n}`, data: { n } });
const headOf = async (database) => (await Effect.runPromise(database.database.followers.source("acme").pipe(Effect.flatMap((source) => source.stats)))).head;

test("a paused writer is refused before a follower may write, the follower takes over with what it replicated, and the old writer stays fenced", { timeout: 60_000 }, async (t) => {
  const A = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  const B = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  const shared = memoryLeaseStore();
  const reachA = partitionable(shared);
  const TTL = 1500;
  const scopeA = newScope(), scopeB = newScope();
  t.after(async () => { await closeScope(scopeA); await closeScope(scopeB); });

  await A.api.forTenant("acme").documents.createCollection({ name: "posts" });
  await insert(A, 0);
  const handleA = await inScope(scopeA, A.database.writerLeases.hold({ partition: "acme", leases: reachA.store, owner: "A", ttlMillis: TTL, endpoint: "A" }));
  assert.equal((await Effect.runPromise(handleA.lease)).epoch, 1);

  const sourceA = await Effect.runPromise(A.database.followers.source("acme"));
  let promoted;
  const standing = inScope(scopeB, B.database.writerLeases.standby({
    partition: "acme", leases: shared, owner: "B", ttlMillis: TTL, leaderFor: () => ({ source: sourceA }), interval: "30 millis", pollMillis: 100,
  })).then((handle) => { promoted = handle; return handle; });

  for (let n = 1; n <= 20; n++) await insert(A, n);
  await until(async () => (await docs(B, 20)) !== undefined, "B holds what A wrote");
  assert.equal(promoted, undefined, "B waits while A's lease is live");
  const headBefore = await headOf(A);

  // A is cut off from the lease store: it can neither renew nor learn that it was superseded.
  reachA.state.cut = true;
  let refusedAt, refusedId, attempt = 0;
  await until(async () => {
    refusedId = `z${attempt++}`;
    const exit = await Effect.runPromiseExit(A.database.forTenant("acme").documents.insert({ collection: "posts", id: refusedId, data: {} }));
    if (Exit.isSuccess(exit)) return false;
    refusedAt = Date.now();
    return true;
  }, "A's writes are refused once its lease cannot be proved");
  assert.equal(promoted, undefined, "A was refused before B was promoted: there was no moment with two writers");
  assert.equal(await docs(A, refusedId), undefined, "nothing of the refused write landed");

  const handleB = await standing;
  assert.equal(handleB.promotion.lease.epoch, 2);
  assert.equal(handleB.promotion.lostPositions, 0);
  assert.ok(Date.now() >= refusedAt);

  // B writes on, continuing the positions A had.
  await insert(B, 21);
  assert.equal(await headOf(B) > headBefore, true, "positions carry on from A's");
  for (let n = 0; n <= 21; n++) assert.ok(await docs(B, n), `B holds p${n}`);

  // A returns. It learns it was superseded and stays refused.
  reachA.state.cut = false;
  await until(async () => !(await Effect.runPromise(handleA.writable)), "A is fenced");
  await until(async () => (await Effect.runPromise(handleA.lease)).epoch === 1, "its view is its old epoch");
  const again = await Effect.runPromiseExit(A.database.forTenant("acme").documents.insert({ collection: "posts", id: "late", data: {} }));
  assert.ok(Exit.isFailure(again), "a returning old writer is refused at its first write");
  assert.equal(await docs(B, "late"), undefined);

  // The old writer can be given back as a follower of the new one, and then holds all of it.
  await closeScope(scopeA);
  const sourceB = await Effect.runPromise(B.database.followers.source("acme"));
  const following = Effect.runFork(A.database.followers.follow(sourceB, { partition: "acme", interval: "30 millis" }));
  t.after(() => Effect.runPromise(following.interruptAsPromise?.() ?? Promise.resolve()).catch(() => {}));
  await until(async () => (await docs(A, 21)) !== undefined, "A, now a follower, holds what B wrote");
});

test("a graceful stop hands the partition over at once, not after the time to live", { timeout: 60_000 }, async (t) => {
  const A = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  const B = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  const leases = memoryLeaseStore();
  const TTL = 3000;
  const scopeA = newScope(), scopeB = newScope();
  t.after(async () => { await closeScope(scopeA); await closeScope(scopeB); });
  await A.api.forTenant("acme").documents.createCollection({ name: "posts" });
  await insert(A, 1);
  await inScope(scopeA, A.database.writerLeases.hold({ partition: "acme", leases, owner: "A", ttlMillis: TTL, endpoint: "A" }));
  const sourceA = await Effect.runPromise(A.database.followers.source("acme"));
  const standing = inScope(scopeB, B.database.writerLeases.standby({
    partition: "acme", leases, owner: "B", ttlMillis: TTL, leaderFor: () => ({ source: sourceA }), interval: "30 millis", pollMillis: 100,
  }));
  await until(async () => (await docs(B, 1)) !== undefined, "B holds p1");
  const closed = Date.now();
  await closeScope(scopeA);
  const handle = await standing;
  assert.ok(Date.now() - closed < TTL, `handed over in ${Date.now() - closed} ms, well inside the ${TTL} ms lease`);
  assert.equal(handle.promotion.lease.epoch, 2);
  await insert(B, 2);
  assert.ok(await docs(B, 2));
});

test("a leased partition cannot be moved or removed until the lease is released", { timeout: 30_000 }, async (t) => {
  const A = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  const scope = newScope();
  t.after(() => closeScope(scope));
  await A.api.forTenant("acme").documents.createCollection({ name: "posts" });
  await insert(A, 1);
  await inScope(scope, A.database.writerLeases.hold({ partition: "acme", leases: memoryLeaseStore(), owner: "A", ttlMillis: 2000 }));
  const removed = await Effect.runPromiseExit(A.database.dropTenant("acme"));
  assert.ok(Exit.isFailure(removed), "a leased Tenant is not removed");
  assert.ok(await docs(A, 1), "and nothing of it was");
  await closeScope(scope);
  await Effect.runPromise(A.database.dropTenant("acme"));
});

test("a follower that was not promoted finds the new writer from the lease alone, and so does the returning old writer", { timeout: 60_000 }, async (t) => {
  const A = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  const B = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  const C = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  const leases = memoryLeaseStore();
  const TTL = 1500;
  const scopeA = newScope(), scopeB = newScope(), scopeC = newScope();
  t.after(async () => { await closeScope(scopeA); await closeScope(scopeB); await closeScope(scopeC); });
  await A.api.forTenant("acme").documents.createCollection({ name: "posts" });
  await insert(A, 1);
  const sources = {};
  for (const [name, database] of [["A", A], ["B", B]]) sources[name] = await Effect.runPromise(database.database.followers.source("acme"));
  const leaderFor = (endpoint) => ({ source: sources[endpoint] });

  await inScope(scopeA, A.database.writerLeases.hold({ partition: "acme", leases, owner: "A", ttlMillis: TTL, endpoint: "A" }));
  const standing = inScope(scopeB, B.database.writerLeases.standby({ partition: "acme", leases, owner: "B", ttlMillis: TTL, endpoint: "B", leaderFor, interval: "30 millis", pollMillis: 100 }));
  // C is never promoted: it only follows whoever the lease names.
  const fibers = [];
  t.after(() => Promise.all(fibers.map((fiber) => Effect.runPromise(Fiber.interrupt(fiber)))));
  fibers.push(Effect.runFork(C.database.writerLeases.follow({ partition: "acme", leases, owner: "C", leaderFor, interval: "30 millis", pollMillis: 100 })));
  for (let n = 2; n <= 6; n++) await insert(A, n);
  await until(async () => (await docs(C, 6)) !== undefined, "C follows A");

  await closeScope(scopeA); // a graceful stop: the lease is released
  const handle = await standing;
  assert.equal(handle.promotion.lease.epoch, 2);
  await insert(B, 7);
  await until(async () => (await docs(C, 7)) !== undefined, "C found the new writer from the lease and holds what it wrote");

  // The old writer comes back as a follower of whoever holds the lease now.
  fibers.push(Effect.runFork(A.database.writerLeases.follow({ partition: "acme", leases, owner: "A", leaderFor, interval: "30 millis", pollMillis: 100 })));
  await insert(B, 8);
  await until(async () => (await docs(A, 8)) !== undefined, "the old writer follows the new one");
  await until(async () => (await docs(C, 8)) !== undefined, "and so does C");
});

test("a lease over the whole database gates every Tenant on every shard at once, and costs the same however many there are", { timeout: 60_000 }, async (t) => {
  const A = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  const leases = memoryLeaseStore();
  const scope = newScope();
  t.after(() => closeScope(scope));
  const tenants = Array.from({ length: 40 }, (_, at) => `tenant-${at}`);
  for (const tenant of tenants) {
    await A.api.forTenant(tenant).documents.createCollection({ name: "posts" });
    await A.api.forTenant(tenant).documents.insert({ collection: "posts", id: "p1", data: {} });
  }
  const write = (tenant, id) => Effect.runPromiseExit(A.database.forTenant(tenant).documents.insert({ collection: "posts", id, data: {} }));
  assert.ok(Exit.isSuccess(await write("tenant-0", "before")), "writable before the lease");

  const reachable = partitionable(leases);
  const handle = await inScope(scope, A.database.writerLeases.holdDatabase({ scope: "project-1", leases: reachable.store, owner: "A", ttlMillis: 1500, endpoint: "A", standby: "B" }));
  assert.deepEqual([(await Effect.runPromise(handle.lease)).partition, (await Effect.runPromise(handle.lease)).standby], ["project-1", "B"]);
  for (const tenant of tenants) assert.ok(Exit.isSuccess(await write(tenant, "held")), `${tenant} writable while the lease is live`);
  // A leased database is not moved or removed from under its lease, whichever Tenant is asked.
  assert.ok(Exit.isFailure(await Effect.runPromiseExit(A.database.dropTenant("tenant-3"))));

  // Cut off from the authority, the whole database stops: every Tenant, not one, and nothing lands.
  reachable.state.cut = true;
  let attempt = 0;
  await until(async () => Exit.isFailure(await write("tenant-0", `late-${attempt++}`)), "the gate closes when the lease cannot be proved");
  for (const tenant of tenants) assert.ok(Exit.isFailure(await write(tenant, "after")), `${tenant} refused`);
  assert.equal(await A.api.forTenant("tenant-7").documents.findById({ collection: "posts", id: "after" }), undefined, "nothing of a refused write landed");
  assert.equal((await A.api.forTenant("tenant-7").documents.findById({ collection: "posts", id: "p1" }))?.id, "p1", "reads go on");
});
