// A standby is a copy of the whole database: Tenants, plugins' service: partitions, the App-scoped collections, the
// placement classes and the divisions, and (rebuilt, not followed) the replicated copies. Held to that through the leader
// in the same process and through the leader transport, up to and including a promotion.
import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Exit, Fiber, Scope } from "effect";
import { localDatabaseLeader, memoryLeaseStore, remoteDatabaseLeader } from "../dist/db/index.js";
import { StoreError } from "../dist/db/errors.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { openTemporaryDatabase } from "./_database.mjs";
import { leaderFetch } from "./fixtures/leader-routes.mjs";

const wait = (millis) => new Promise((resolve) => setTimeout(resolve, millis));
const until = async (condition, what, millis = 30_000) => {
  for (const started = Date.now(); !(await condition()); await wait(25)) assert.ok(Date.now() - started < millis, what);
};
const run = (effect) => Effect.runPromise(effect);
const insertInto = (documents, collection, id, data = { id }) => run(Effect.gen(function* () {
  if (!(yield* documents.collectionExists(collection))) yield* documents.createCollection({ name: collection });
  yield* documents.insert({ collection, id, data });
}));
const found = (documents, collection, id) => run(Effect.exit(documents.findById({ collection, id }))).then((exit) => Exit.isSuccess(exit) && exit.value !== undefined && exit.value !== null);

/** Everything the leader holds that a promoted standby must hold too. */
const populate = async (leader) => {
  const database = leader.database;
  await insertInto(database.forTenant("acme").documents, "posts", "a");
  await insertInto(database.global.documents, "settings", "site");
  await run(database.topology.placement.declare("plans", "replicated"));
  await run(database.global.documents.createCollection({ name: "plans" }));
  await run(database.global.documents.insert({ collection: "plans", id: "pro", data: { seats: 25 } }));
  await insertInto(database.forTenant("service:seo").documents, "pages", "home");
  await run(database.topology.subdivision.subdivide("whale", ["a", "b"]));
  await insertInto(database.forPart("whale", "a").documents, "posts", "w");
};

/** What a standby holds, read the way an App would after the promotion. */
const held = async (follower) => {
  const database = follower.database;
  return {
    tenant: await found(database.forTenant("acme").documents, "posts", "a"),
    appScoped: await found(database.global.documents, "settings", "site"),
    plugin: await found(database.forTenant("service:seo").documents, "pages", "home"),
    replicated: await found(database.forTenant("acme").shared, "plans", "pro"),
    parts: JSON.stringify(database.topology.subdivision.partsOf("whale") ?? null),
    part: await (async () => found(database.forPart("whale", "a").documents, "posts", "w"))().catch(() => false),
  };
};
const WHOLE = { tenant: true, appScoped: true, plugin: true, replicated: true, parts: JSON.stringify(["a", "b"]), part: true };

for (const [how, adapt] of [
  ["in the same process", (api) => localDatabaseLeader(api.database.followers)],
  ["through the leader transport", (api) => remoteDatabaseLeader(createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch: leaderFetch(api.api) }).followers("p1"))],
]) {
  test(`a follower of a whole database holds the App-scoped, plugin, replicated and divided data too (${how})`, { timeout: 120_000 }, async (t) => {
    const leader = await openTemporaryDatabase(t, { crossTenantRefresh: false });
    const follower = await openTemporaryDatabase(t, { crossTenantRefresh: false });
    await populate(leader);
    const fiber = Effect.runFork(follower.database.followers.followAll(adapt(leader), { name: "east", timeoutMillis: 200 }));
    t.after(() => Effect.runPromise(Fiber.interrupt(fiber)));
    await until(async () => (await held(follower)).tenant, "the follower holds the Tenant");
    await wait(1000);
    await run(follower.database.replication.refresh);
    assert.deepEqual(await held(follower), WHOLE);
  });

  test(`a division or a placement declared after the follower's resync reaches it at once, though its feed waits for a write (${how})`, { timeout: 60_000 }, async (t) => {
    const leader = await openTemporaryDatabase(t, { crossTenantRefresh: false });
    const follower = await openTemporaryDatabase(t, { crossTenantRefresh: false });
    await insertInto(leader.database.forTenant("acme").documents, "posts", "a");
    // A feed that waits 20 s for a write: only the declaration can wake it sooner.
    const fiber = Effect.runFork(follower.database.followers.followAll(adapt(leader), { name: "east", timeoutMillis: 20_000 }));
    t.after(() => Effect.runPromise(Fiber.interrupt(fiber)));
    await until(async () => (await held(follower)).tenant, "the follower holds the Tenant");
    await wait(300);

    await run(leader.database.topology.subdivision.subdivide("late-whale", ["x", "y"]));
    await run(leader.database.topology.placement.declare("late-plans", "replicated"));
    const started = Date.now();
    await until(async () => JSON.stringify(follower.database.topology.subdivision.partsOf("late-whale") ?? null) === JSON.stringify(["x", "y"]) &&
      follower.database.topology.placement.classOf("late-plans") === "replicated", "the follower declares what the leader declared after its resync", 10_000);
    assert.ok(Date.now() - started < 10_000);
  });

  test(`a promoted standby holds all of it and has rebuilt its replicated copies before it writes (${how})`, { timeout: 120_000 }, async (t) => {
    const leader = await openTemporaryDatabase(t, { crossTenantRefresh: false });
    const follower = await openTemporaryDatabase(t, { crossTenantRefresh: false });
    await populate(leader);
    const leases = memoryLeaseStore();
    const scopes = { leader: Effect.runSync(Scope.make()), standby: Effect.runSync(Scope.make()) };
    t.after(async () => { for (const scope of Object.values(scopes)) await run(Scope.close(scope, Exit.void)); });
    await run(leader.database.writerLeases.holdDatabase({ scope: "p1", leases, owner: "west", ttlMillis: 1000, endpoint: "west", standby: "east" }).pipe(Effect.provideService(Scope.Scope, scopes.leader)));
    const standing = run(follower.database.writerLeases.standbyDatabase({ scope: "p1", leases, owner: "east", ttlMillis: 1000, endpoint: "east", successor: "west", leaderFor: () => adapt(leader), timeoutMillis: 200, pollMillis: 100 }).pipe(Effect.provideService(Scope.Scope, scopes.standby)));
    await wait(1000);
    // The writer is lost: its lease is released and the standby takes over.
    await run(Scope.close(scopes.leader, Exit.void));
    const promoted = await standing;
    assert.equal(promoted.promotion.lease.owner, "east");
    // No refresh of the test's own: the promotion rebuilt the copies the replicated read uses.
    assert.deepEqual(await held(follower), WHOLE);
  });
}

test("a follower holding a division its leader lacks is not a copy: following stops and names the Tenant", { timeout: 60_000 }, async (t) => {
  const leader = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  const follower = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  await run(follower.database.topology.subdivision.subdivide("orca", ["a", "b"]));
  const exit = await Effect.runPromiseExit(follower.database.followers.followAll(localDatabaseLeader(leader.database.followers), { name: "east", timeoutMillis: 200 }));
  assert.ok(Exit.isFailure(exit));
  assert.match(String(exit.cause.reasons.map((reason) => reason.defect?.message ?? reason.error?.message ?? "").join(" ")), /orca/);
});

test("a leader whose declarations cannot be read once is asked again, and the follower still converges", { timeout: 60_000 }, async (t) => {
  const leader = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  const follower = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  await populate(leader);
  const real = localDatabaseLeader(leader.database.followers);
  let asked = 0;
  const flaky = { ...real, declarations: Effect.suspend(() => ++asked === 1 ? Effect.fail(new StoreError({ op: "leader.declarations", cause: "unreachable once" })) : real.declarations) };
  const fiber = Effect.runFork(follower.database.followers.followAll(flaky, { name: "east", timeoutMillis: 200 }));
  t.after(() => Effect.runPromise(Fiber.interrupt(fiber)));
  await until(async () => (await held(follower)).part, "the follower converges after the failed read");
  assert.ok(asked >= 2);
});
