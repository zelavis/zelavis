// A Project's start is guarded by its whole-database writer lease: it is taken before the database is handed out, and a
// node that cannot take it opens nothing. The lease is the fence for any start, whoever decided it.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import { Effect } from "effect";
import { acquireWriter, memoryLeaseStore, startWriter, renewWriter } from "../dist/db/writer-lease.js";
import { openNodeDatabase } from "../dist/db/node-host.js";
import { localDatabaseLeader } from "../dist/db/leader.js";
import { leaseFromEnvironment } from "../dist/adapters/_node-project-engine.js";
import { temporaryDatabaseDirectory } from "./_database.mjs";

const wait = (millis) => new Promise((resolve) => setTimeout(resolve, millis));
const until = async (condition, what, millis = 10_000) => {
  for (const started = Date.now(); !(await condition()); await wait(20)) assert.ok(Date.now() - started < millis, what);
};
const failure = (exit) => (exit._tag === "Failure" ? exit.cause.reasons.map((reason) => reason.error).find((error) => error !== undefined) : undefined);
const run = (effect) => Effect.runPromiseExit(effect);

test("a start takes the lease when it is free or its own, takes over only as the named standby of a lapsed writer, and refuses otherwise", async () => {
  const leases = memoryLeaseStore();
  const start = (owner, standby = "B") => run(startWriter(leases, { scope: "project-1", owner, ttlMillis: 200, standby, endpoint: `http://${owner}` }));

  const first = await start("A");
  assert.equal(first._tag, "Success");
  assert.deepEqual([first.value.epoch, first.value.owner, first.value.standby, first.value.endpoint], [1, "A", "B", "http://A"], "the first start takes a free lease");
  assert.equal((await start("A")).value.epoch, 2, "a restart is its own next epoch, which fences its former self");

  assert.equal(failure(await start("B", "A"))._tag, "LeaseStillHeld", "told to start while the writer is live, it refuses");
  await wait(260);
  assert.equal(failure(await start("C", "A"))._tag, "NotDesignatedStandby", "a lapsed lease is not taken by a node the writer did not name");
  const promoted = await start("B", "A");
  assert.equal(promoted._tag, "Success");
  assert.deepEqual([promoted.value.epoch, promoted.value.owner, promoted.value.standby], [3, "B", "A"], "the named standby takes over and names its own");
});

test("the lease is configured from the environment, all or nothing", () => {
  assert.equal(leaseFromEnvironment("p1", {}), undefined, "no authority, no guard");
  assert.throws(() => leaseFromEnvironment("p1", { ZELAVIS_LEASE_AUTHORITY: "http://platform/api" }), /ZELAVIS_LEASE_TOKEN/);
  assert.throws(() => leaseFromEnvironment("p1", { ZELAVIS_LEASE_AUTHORITY: "http://platform/api", ZELAVIS_LEASE_TOKEN: "t", ZELAVIS_LEASE_NODE: "node-a", ZELAVIS_LEASE_STANDBY: "node-b", ZELAVIS_LEASE_ROLE: "writer" }), /ZELAVIS_LEASE_TTL_MILLIS/);
  assert.throws(() => leaseFromEnvironment("p1", { ZELAVIS_LEASE_AUTHORITY: "http://platform/api", ZELAVIS_LEASE_TOKEN: "t", ZELAVIS_LEASE_NODE: "node-a", ZELAVIS_LEASE_STANDBY: "node-b", ZELAVIS_LEASE_TTL_MILLIS: "9000" }), /ZELAVIS_LEASE_ROLE/);
  assert.throws(() => leaseFromEnvironment("p1", { ZELAVIS_LEASE_AUTHORITY: "http://platform/api", ZELAVIS_LEASE_TOKEN: "t", ZELAVIS_LEASE_NODE: "node-a", ZELAVIS_LEASE_STANDBY: "node-b", ZELAVIS_LEASE_ROLE: "both", ZELAVIS_LEASE_TTL_MILLIS: "9000" }), /ZELAVIS_LEASE_ROLE/);
  const lease = leaseFromEnvironment("p1", {
    ZELAVIS_LEASE_AUTHORITY: "http://platform/zelavis/api/v1", ZELAVIS_LEASE_TOKEN: "t", ZELAVIS_LEASE_NODE: "node-a", ZELAVIS_LEASE_STANDBY: "node-b", ZELAVIS_LEASE_ROLE: "writer", ZELAVIS_LEASE_TTL_MILLIS: "9000",
  });
  assert.deepEqual([lease.scope, lease.owner, lease.standby, lease.ttlMillis], ["p1", "node-a", "node-b", 9000]);
  assert.equal(typeof lease.onSuperseded, "function");
});

test("a database opens only once it holds the lease, refuses to open while another writer is live, and releases the lease when it closes", { timeout: 60_000 }, async (t) => {
  const leases = memoryLeaseStore();
  const directory = temporaryDatabaseDirectory();
  // SQLite startup can take over a second under the parallel suite. The test controls when ownership changes.
  const ttlMillis = 9_000;
  const lease = (owner, standby, extra = {}) => ({ role: "writer", leases, scope: "project-1", owner, standby, ttlMillis, endpoint: `http://${owner}`, ...extra });
  let opened;
  t.after(async () => {
    try {
      await opened?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // Another node is the live writer: this one opens nothing.
  await Effect.runPromise(acquireWriter(leases, { partition: "project-1", owner: "other", ttlMillis, standby: "A" }));
  await assert.rejects(async () => {
    opened = await openNodeDatabase({ directory, crossTenantRefresh: false, lease: lease("A", "B") });
  }, (error) => error?.cause?._tag === "LeaseStillHeld" || error?._tag === "LeaseStillHeld" || /LeaseStillHeld|still held|held/i.test(String(error?.message ?? error)));

  // The other writer is gone (released): A is its named standby, takes over, and the database is handed out.
  const other = (await Effect.runPromise(leases.read("project-1"))).lease;
  await Effect.runPromise(leases.replace(await Effect.runPromise(leases.read("project-1")), { ...other, expiresAt: 0 }));
  opened = await openNodeDatabase({ directory, crossTenantRefresh: false, lease: lease("A", "B") });
  const held = (await Effect.runPromise(leases.read("project-1"))).lease;
  assert.deepEqual([held.owner, held.epoch, held.standby], ["A", 2, "B"]);
  await opened.api.forTenant("acme").documents.createCollection({ name: "posts" });
  await opened.api.forTenant("acme").documents.insert({ collection: "posts", id: "p1", data: {} });

  // Closing releases the lease, so the standby can take over at once.
  await opened.close();
  opened = undefined;
  assert.equal((await Effect.runPromise(leases.read("project-1"))).lease.expiresAt, 0);
  opened = await openNodeDatabase({ directory, crossTenantRefresh: false, lease: lease("A", "B") });
  assert.equal((await Effect.runPromise(leases.read("project-1"))).lease.epoch, 3, "reopened as its own next epoch");
  assert.equal((await opened.api.forTenant("acme").documents.findById({ collection: "posts", id: "p1" })).id, "p1", "the data is there");

  // Superseded while serving: the writer is told, and its writes are refused.
  let lost = 0;
  await opened.close();
  opened = undefined;
  opened = await openNodeDatabase({ directory, crossTenantRefresh: false, lease: lease("A", "B", { onSuperseded: () => { lost += 1; } }) });
  const superseded = await Effect.runPromise(Effect.flatMap(leases.read("project-1"), (mine) =>
    leases.replace(mine, { ...mine.lease, owner: "B", epoch: mine.lease.epoch + 1 })));
  assert.equal(superseded, true);
  await until(() => lost === 1, "the writer finds out it was superseded");
  await assert.rejects(opened.api.forTenant("acme").documents.insert({ collection: "posts", id: "late", data: {} }), {
    _tag: "WriterFenced", reason: "superseded",
  });
});

test("a database opened as a standby follows its writer and is handed out only once it holds the lease", { timeout: 60_000 }, async () => {
  const leases = memoryLeaseStore();
  const writerDirectory = temporaryDatabaseDirectory();
  const standbyDirectory = temporaryDatabaseDirectory();
  const writer = await openNodeDatabase({ directory: writerDirectory, crossTenantRefresh: false, lease: { role: "writer", leases, scope: "project-1", owner: "a", standby: "b", ttlMillis: 1000, endpoint: "a" } });
  await writer.api.forTenant("acme").documents.createCollection({ name: "posts" });
  await writer.api.forTenant("acme").documents.insert({ collection: "posts", id: "p1", data: { id: "p1" } });

  let opened;
  const standing = openNodeDatabase({ directory: standbyDirectory, crossTenantRefresh: false, lease: {
    role: "standby", leases, scope: "project-1", owner: "b", successor: "a", ttlMillis: 1000, endpoint: "b",
    leaderFor: () => localDatabaseLeader(writer.database.followers), timeoutMillis: 100, pollMillis: 50,
  } }).then((database) => { opened = database; return database; });
  await wait(700);
  assert.equal(opened, undefined, "a standby is not handed out while its writer holds the lease");
  assert.equal((await Effect.runPromise(leases.read("project-1"))).lease.owner, "a");

  await writer.close();
  const promoted = await standing;
  const held = (await Effect.runPromise(leases.read("project-1"))).lease;
  assert.deepEqual([held.owner, held.epoch, held.standby], ["b", 2, "a"]);
  assert.equal((await promoted.api.forTenant("acme").documents.findById({ collection: "posts", id: "p1" })).id, "p1", "it holds what the writer wrote");
  await promoted.close();
});

test("a promoted standby that is superseded later is told, like any writer", { timeout: 60_000 }, async () => {
  const leases = memoryLeaseStore();
  const writer = await openNodeDatabase({ directory: temporaryDatabaseDirectory(), crossTenantRefresh: false, lease: { role: "writer", leases, scope: "project-1", owner: "a", standby: "b", ttlMillis: 600, endpoint: "a" } });
  let told = 0;
  const standing = openNodeDatabase({ directory: temporaryDatabaseDirectory(), crossTenantRefresh: false, lease: {
    role: "standby", leases, scope: "project-1", owner: "b", successor: "a", ttlMillis: 600, endpoint: "b",
    leaderFor: () => localDatabaseLeader(writer.database.followers), timeoutMillis: 100, pollMillis: 50, onSuperseded: () => { told += 1; },
  } });
  await writer.close();
  const promoted = await standing;
  assert.equal(told, 0, "not told while it holds the lease");
  const mine = await Effect.runPromise(leases.read("project-1"));
  await Effect.runPromise(leases.replace(mine, { ...mine.lease, owner: "c", epoch: mine.lease.epoch + 1, expiresAt: Date.now() + 60_000 }));
  await until(() => told === 1, "the promoted standby is told it was superseded");
  await promoted.close();
});

test("a standby told to stop waiting ends its open at once, handing nothing out and leaving the writer's lease alone", { timeout: 60_000 }, async () => {
  const leases = memoryLeaseStore();
  const writer = await openNodeDatabase({ directory: temporaryDatabaseDirectory(), crossTenantRefresh: false, lease: { role: "writer", leases, scope: "project-1", owner: "a", standby: "b", ttlMillis: 5000, endpoint: "a" } });
  const waiting = new AbortController();
  const standing = openNodeDatabase({ directory: temporaryDatabaseDirectory(), crossTenantRefresh: false, lease: {
    role: "standby", leases, scope: "project-1", owner: "b", successor: "a", ttlMillis: 5000, endpoint: "b", signal: waiting.signal,
    leaderFor: () => localDatabaseLeader(writer.database.followers), timeoutMillis: 100, pollMillis: 50,
  } });
  const outcome = standing.then(() => "handed out", () => "ended");
  await wait(400);
  const started = Date.now();
  waiting.abort();
  assert.equal(await outcome, "ended");
  assert.ok(Date.now() - started < 2000, "the wait ended at once");
  const held = (await Effect.runPromise(leases.read("project-1"))).lease;
  assert.deepEqual([held.owner, held.epoch], ["a", 1], "the writer's lease is untouched");
  await writer.close();
});
