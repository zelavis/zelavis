// A Project's start is guarded by its whole-database writer lease: it is taken before the database is handed out, and a
// node that cannot take it opens nothing. The lease is the fence for any start, whoever decided it.
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { acquireWriter, memoryLeaseStore, startWriter, renewWriter } from "../dist/db/writer-lease.js";
import { openNodeDatabase } from "../dist/db/node-host.js";
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
  const lease = leaseFromEnvironment("p1", {
    ZELAVIS_LEASE_AUTHORITY: "http://platform/zelavis/api/v1", ZELAVIS_LEASE_TOKEN: "t", ZELAVIS_LEASE_NODE: "node-a", ZELAVIS_LEASE_STANDBY: "node-b", ZELAVIS_LEASE_TTL_MILLIS: "9000",
  });
  assert.deepEqual([lease.scope, lease.owner, lease.standby, lease.ttlMillis], ["p1", "node-a", "node-b", 9000]);
  assert.equal(typeof lease.onSuperseded, "function");
});

test("a database opens only once it holds the lease, refuses to open while another writer is live, and releases the lease when it closes", { timeout: 60_000 }, async (t) => {
  const leases = memoryLeaseStore();
  const directory = temporaryDatabaseDirectory(t);
  const lease = (owner, standby, extra = {}) => ({ leases, scope: "project-1", owner, standby, ttlMillis: 400, endpoint: `http://${owner}`, ...extra });

  // Another node is the live writer: this one opens nothing.
  await Effect.runPromise(acquireWriter(leases, { partition: "project-1", owner: "other", ttlMillis: 5000, standby: "A" }));
  await assert.rejects(openNodeDatabase({ directory, crossTenantRefresh: false, lease: lease("A", "B") }), (error) => error?.cause?._tag === "LeaseStillHeld" || error?._tag === "LeaseStillHeld" || /LeaseStillHeld|still held|held/i.test(String(error?.message ?? error)));

  // The other writer is gone (released): A is its named standby, takes over, and the database is handed out.
  const other = (await Effect.runPromise(leases.read("project-1"))).lease;
  await Effect.runPromise(leases.replace(await Effect.runPromise(leases.read("project-1")), { ...other, expiresAt: 0 }));
  const opened = await openNodeDatabase({ directory, crossTenantRefresh: false, lease: lease("A", "B") });
  const held = (await Effect.runPromise(leases.read("project-1"))).lease;
  assert.deepEqual([held.owner, held.epoch, held.standby], ["A", 2, "B"]);
  await opened.api.forTenant("acme").documents.createCollection({ name: "posts" });
  await opened.api.forTenant("acme").documents.insert({ collection: "posts", id: "p1", data: {} });

  // Closing releases the lease, so the standby can take over at once.
  await opened.close();
  assert.equal((await Effect.runPromise(leases.read("project-1"))).lease.expiresAt, 0);
  const again = await openNodeDatabase({ directory, crossTenantRefresh: false, lease: lease("A", "B") });
  assert.equal((await Effect.runPromise(leases.read("project-1"))).lease.epoch, 3, "reopened as its own next epoch");
  assert.equal((await again.api.forTenant("acme").documents.findById({ collection: "posts", id: "p1" })).id, "p1", "the data is there");

  // Superseded while serving: the writer is told, and its writes are refused.
  let lost = 0;
  await again.close();
  const guarded = await openNodeDatabase({ directory, crossTenantRefresh: false, lease: lease("A", "B", { onSuperseded: () => { lost += 1; } }) });
  const mine = await Effect.runPromise(leases.read("project-1"));
  await Effect.runPromise(leases.replace(mine, { ...mine.lease, owner: "B", epoch: mine.lease.epoch + 1 }));
  await until(() => lost === 1, "the writer finds out it was superseded");
  await until(async () => (await guarded.api.forTenant("acme").documents.insert({ collection: "posts", id: `late-${Math.random()}`, data: {} }).then(() => false, () => true)), "and its writes are refused");
  await guarded.close();
});
