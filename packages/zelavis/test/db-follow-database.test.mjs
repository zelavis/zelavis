// Following a whole database costs the changes, not the Tenants: one listing at the start, then only the partitions the
// leader's feed names. Held to that by counting what the follower asks the leader for, over many Tenants, through the
// leader in the same process and through the transport, and across a resync, a failed partition and a lost cursor.
import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Fiber } from "effect";
import { localDatabaseLeader, remoteDatabaseLeader } from "../dist/db/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { openTemporaryDatabase } from "./_database.mjs";
import { leaderFetch } from "./fixtures/leader-routes.mjs";

const wait = (millis) => new Promise((resolve) => setTimeout(resolve, millis));
const until = async (condition, what, millis = 30_000) => {
  for (const started = Date.now(); !(await condition()); await wait(25)) assert.ok(Date.now() - started < millis, what);
};
const TENANTS = 300;
const name = (at) => `tenant-${String(at).padStart(4, "0")}`;
const put = async (api, tenant, id) => {
  const documents = api.forTenant(tenant).documents;
  if (!(await documents.collectionExists("posts"))) await documents.createCollection({ name: "posts" });
  await documents.insert({ collection: "posts", id, data: { id } });
};
const ids = async (api, tenant) => (await api.forTenant(tenant).documents.findMany({ collection: "posts" }).catch(() => [])).map((doc) => doc.id).sort();

/** A leader that counts what a follower asks of it, per partition, and can be told to misbehave once. */
const counting = (leader) => {
  const calls = { sources: new Map(), feeds: 0, pages: 0 };
  const flaky = new Set();
  let forceResync = false;
  return {
    calls,
    fail: (partition) => flaky.add(partition),
    resync: () => { forceResync = true; },
    leader: {
      ...leader,
      feed: (input) => { calls.feeds++; return Effect.map(leader.feed(input), (answer) => { if (forceResync && input.cursor !== undefined) { forceResync = false; return { ...answer, resync: true, partitions: [] }; } return answer; }); },
      partitions: (input) => { calls.pages++; return leader.partitions(input); },
      source: (partition) => {
        calls.sources.set(partition, (calls.sources.get(partition) ?? 0) + 1);
        if (flaky.delete(partition)) return Effect.die(new Error(`${partition} is not available`));
        return leader.source(partition);
      },
    },
  };
};
const sourcesTotal = (counter) => [...counter.calls.sources.values()].reduce((sum, count) => sum + count, 0);

for (const [how, adapt] of [
  ["in the same process", (api) => localDatabaseLeader(api.database.followers)],
  ["through the leader transport", (api) => remoteDatabaseLeader(createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch: leaderFetch(api.api) }).followers("p1"))],
]) {
  test(`a follower of a whole database lists once, then asks only about what changed (${how})`, { timeout: 120_000 }, async (t) => {
    const leader = await openTemporaryDatabase(t, { crossTenantRefresh: false });
    const follower = await openTemporaryDatabase(t, { crossTenantRefresh: false });
    for (let at = 0; at < TENANTS; at++) { await put(leader.api, name(at), "a"); await put(leader.api, name(at), "b"); }
    const counter = counting(adapt(leader));
    const fiber = Effect.runFork(follower.database.followers.followAll(counter.leader, { name: "east", timeoutMillis: 200 }));
    t.after(() => Effect.runPromise(Fiber.interrupt(fiber)));

    await until(async () => (await ids(follower.api, name(TENANTS - 1))).length === 2, "the follower holds every Tenant");
    for (const at of [0, 77, 150, 299]) assert.deepEqual(await ids(follower.api, name(at)), ["a", "b"]);
    assert.equal(counter.calls.pages, Math.ceil(TENANTS / 1000) + 0 || 1, "one listing, a page for these Tenants");

    // Steady state: three Tenants written. The follower asks the leader about those three, and about no others.
    await wait(300);
    const before = sourcesTotal(counter);
    for (const at of [5, 120, 280]) await put(leader.api, name(at), "c");
    await until(async () => (await ids(follower.api, name(280))).includes("c") && (await ids(follower.api, name(5))).includes("c") && (await ids(follower.api, name(120))).includes("c"), "the three writes reach the follower");
    await wait(300);
    const touched = sourcesTotal(counter) - before;
    assert.ok(touched >= 3 && touched <= 6, `${touched} partitions asked about for 3 written, among ${TENANTS}`);
    for (const at of [0, 77, 299]) assert.equal(counter.calls.sources.get(name(at)), 1, `${name(at)} was never asked about again after the listing`);

    // Acknowledgments are filed per partition, with the leader.
    const positions = await Effect.runPromise(Effect.flatMap(leader.database.followers.acknowledgments(name(5)), (record) => record.positions));
    assert.ok((positions.get("east") ?? 0) > 0, "the follower acknowledged what it holds");
  });
}

test("a feed the leader cannot answer is a resync that compares heads and levels only what is behind; a partition that failed is tried again", { timeout: 120_000 }, async (t) => {
  const leader = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  const follower = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  for (let at = 0; at < 60; at++) await put(leader.api, name(at), "a");
  const counter = counting(localDatabaseLeader(leader.database.followers));
  counter.fail(name(7));
  const fiber = Effect.runFork(follower.database.followers.followAll(counter.leader, { timeoutMillis: 100 }));
  t.after(() => Effect.runPromise(Fiber.interrupt(fiber)));
  await until(async () => (await ids(follower.api, name(59))).length === 1, "everything but the failed one is leveled");
  await until(async () => (await ids(follower.api, name(7))).length === 1, "the failed partition is tried again on the next turn");

  // The leader loses the follower's place: it lists again, and asks about the one partition that is behind.
  await wait(300);
  counter.calls.sources.clear();
  counter.resync();
  await put(leader.api, name(33), "b");
  await until(async () => (await ids(follower.api, name(33))).includes("b"), "the write made across the resync reaches the follower");
  await wait(300);
  assert.ok(counter.calls.pages >= 2, "it listed again");
  assert.ok(sourcesTotal(counter) <= 3, `${sourcesTotal(counter)} partitions asked about after the resync: only the one that was behind`);
});

// ---- the whole database as the failover unit ----
import { Exit, Scope } from "effect";
import { memoryLeaseStore } from "../dist/db/index.js";

const partitionable = (inner) => {
  const state = { cut: false };
  const guarded = (call) => (...args) => (state.cut ? Effect.never : call(...args));
  return { state, store: { read: guarded(inner.read), create: guarded(inner.create), replace: guarded(inner.replace) } };
};
const inScope = (scope, effect) => Effect.runPromise(effect.pipe(Effect.provideService(Scope.Scope, scope)));

test("a Project fails over as one: every Tenant is fenced on the old writer, the standby holds them all, and the returned writer and a third node follow the new one", { timeout: 120_000 }, async (t) => {
  const A = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  const B = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  const C = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  const shared = memoryLeaseStore();
  const reachA = partitionable(shared);
  const TTL = 1500;
  const nodes = { A, B, C };
  const leaderFor = (endpoint) => localDatabaseLeader(nodes[endpoint].database.followers);
  const scopes = { A: Effect.runSync(Scope.make()), B: Effect.runSync(Scope.make()), C: Effect.runSync(Scope.make()) };
  const fibers = [];
  t.after(async () => {
    await Promise.all(fibers.map((fiber) => Effect.runPromise(Fiber.interrupt(fiber))));
    reachA.state.cut = false;
    for (const scope of Object.values(scopes)) await Effect.runPromise(Scope.close(scope, Exit.void));
  });
  const tenants = Array.from({ length: 30 }, (_, at) => name(at));
  for (const tenant of tenants) await put(A.api, tenant, "p0");

  await inScope(scopes.A, A.database.writerLeases.holdDatabase({ scope: "project-1", leases: reachA.store, owner: "A", ttlMillis: TTL, endpoint: "A", standby: "B" }));
  const standing = inScope(scopes.B, B.database.writerLeases.standbyDatabase({ scope: "project-1", leases: shared, owner: "B", ttlMillis: TTL, endpoint: "B", successor: "A", leaderFor, timeoutMillis: 200, pollMillis: 100 }));
  // C also tries to stand by, but is not the designated standby.
  let cPromoted = false;
  fibers.push(Effect.runFork(C.database.writerLeases.standbyDatabase({ scope: "project-1", leases: shared, owner: "C", ttlMillis: TTL, endpoint: "C", leaderFor, timeoutMillis: 200, pollMillis: 100 }).pipe(
    Effect.provideService(Scope.Scope, scopes.C), Effect.tap(() => Effect.sync(() => { cPromoted = true; })))));
  for (const tenant of tenants) await put(A.api, tenant, "p1");
  await until(async () => (await ids(B.api, tenants[29])).length === 2 && (await ids(C.api, tenants[29])).length === 2, "B and C hold what A wrote, in every Tenant");

  reachA.state.cut = true;
  let attempt = 0;
  await until(async () => Exit.isFailure(await Effect.runPromiseExit(A.database.forTenant(tenants[0]).documents.insert({ collection: "posts", id: `z-${attempt++}`, data: {} }))), "the old writer is refused once its lease cannot be proved");
  for (const tenant of tenants) assert.ok(Exit.isFailure(await Effect.runPromiseExit(A.database.forTenant(tenant).documents.insert({ collection: "posts", id: "zombie", data: {} }))), `${tenant} is fenced too`);

  const promoted = await standing;
  assert.equal(promoted.promotion.lease.epoch, 2);
  assert.equal(promoted.promotion.lease.standby, "A");
  assert.equal(cPromoted, false, "the node that is not the designated standby was not promoted");
  // What A wrote while its lease was still valid (the probes above) reached B too; what it was refused did not.
  for (const tenant of tenants) {
    const held = await ids(B.api, tenant);
    assert.ok(held.includes("p0") && held.includes("p1"), `B holds ${tenant}`);
    assert.ok(!held.includes("zombie"), `a refused write to ${tenant} reached no one`);
  }
  await put(B.api, tenants[3], "p2");
  await put(B.api, "tenant-new", "p0"); // a Tenant that did not exist when the writer was lost

  // The old writer returns and follows the new one; so does C, which was never promoted.
  reachA.state.cut = false;
  await Effect.runPromise(Scope.close(scopes.A, Exit.void));
  fibers.push(Effect.runFork(A.database.writerLeases.followDatabase({ scope: "project-1", leases: shared, owner: "A", leaderFor, timeoutMillis: 200, pollMillis: 100 })));
  await until(async () => (await ids(A.api, tenants[3])).includes("p2") && (await ids(A.api, "tenant-new")).length === 1, "the old writer follows the new one, new Tenants included");
  await until(async () => (await ids(C.api, tenants[3])).includes("p2") && (await ids(C.api, "tenant-new")).length === 1, "so does C, from the lease alone");
});
