import assert from "node:assert/strict";
import test from "node:test";

import {
  createMemorySystemStore,
  createZelavisEdgeManager,
  ZelavisEdgeConflictError,
  ZelavisEdgeSwitchError,
  ZelavisEdgeValidationError,
} from "../dist/index.js";

const publication = {
  id: "platform-routes",
  revision: "routes-42",
  routeCount: 12,
  requiredCapabilities: ["http", "https", "websocket"],
  certificateRefs: ["certificate:platform.example.com"],
};

function adapter(id, events, overrides = {}) {
  return {
    id,
    title: id === "traefik" ? "Traefik" : "Caddy",
    capabilities: [
      "http",
      "https",
      "websocket",
      "sse",
      "connection-draining",
      "certificate-hot-reload",
    ],
    async detect() {
      events.push(`${id}:detect`);
      return {
        state: "available",
        installed: true,
        healthy: true,
        checkedAt: "2026-09-19T00:00:00.000Z",
        version: "test",
      };
    },
    async stage(context) {
      events.push(`${id}:stage:${context.switchId}`);
    },
    async verify(context) {
      events.push(`${id}:verify:${context.switchId}`);
      return { ready: true };
    },
    async activate(context) {
      events.push(`${id}:activate:${context.switchId}`);
    },
    async drain(context) {
      events.push(`${id}:drain:${context.switchId}`);
    },
    async rollback(context) {
      events.push(`${id}:rollback:${context.switchId}`);
    },
    ...overrides,
  };
}

function certificateDistributor(events) {
  return {
    async stage(context) {
      events.push(`certificates:stage:${context.switchId}`);
      assert.deepEqual(
        context.publication.certificateRefs,
        ["certificate:platform.example.com"],
      );
    },
    async activate(context) {
      events.push(`certificates:activate:${context.switchId}`);
    },
    async rollback(context) {
      events.push(`certificates:rollback:${context.switchId}`);
    },
  };
}

test("Edge stages and verifies before activating, then drains the old adapter", async () => {
  const events = [];
  let switchNumber = 0;
  const manager = createZelavisEdgeManager({
    store: createMemorySystemStore(),
    adapters: [adapter("traefik", events), adapter("caddy", events)],
    defaultAdapterId: "traefik",
    certificates: certificateDistributor(events),
    createSwitchId: () => `switch-${++switchNumber}`,
  });

  const first = await manager.switchAdapter("traefik", publication);
  assert.equal(first.phase, "complete");
  assert.equal((await manager.getPolicy()).activeAdapterId, "traefik");

  events.length = 0;
  const second = await manager.switchAdapter("caddy", {
    ...publication,
    revision: "routes-43",
  });

  assert.equal(second.phase, "complete");
  assert.deepEqual(events, [
    "caddy:detect",
    "certificates:stage:switch-2",
    "caddy:stage:switch-2",
    "caddy:verify:switch-2",
    "certificates:activate:switch-2",
    "caddy:activate:switch-2",
    "traefik:drain:switch-2",
  ]);
  const policy = await manager.getPolicy();
  assert.match(policy.updatedAt, /^2026-|^20\d\d-/);
  assert.deepEqual({ ...policy, updatedAt: "<timestamp>" }, {
    schemaVersion: 1,
    revision: 2,
    desiredAdapterId: "caddy",
    activeAdapterId: "caddy",
    activePublication: {
      id: "platform-routes",
      revision: "routes-43",
    },
    updatedAt: "<timestamp>",
  });
});

test("Edge refuses a target missing a required capability before staging", async () => {
  const events = [];
  const limited = adapter("traefik", events, {
    capabilities: ["http", "https"],
  });
  const manager = createZelavisEdgeManager({
    store: createMemorySystemStore(),
    adapters: [limited],
    defaultAdapterId: "traefik",
    certificates: certificateDistributor(events),
    createSwitchId: () => "switch-missing-capability",
  });

  const plan = await manager.planSwitch("traefik", publication);
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.missingCapabilities, ["websocket"]);
  await assert.rejects(
    manager.switchAdapter("traefik", publication),
    (error) => {
      assert.ok(error instanceof ZelavisEdgeSwitchError);
      assert.ok(error.cause instanceof ZelavisEdgeValidationError);
      assert.equal(error.record.phase, "failed");
      return true;
    },
  );
  assert.deepEqual(events, [
    "traefik:detect",
    "traefik:detect",
    "traefik:rollback:switch-missing-capability",
    "certificates:rollback:switch-missing-capability",
  ]);
  assert.equal((await manager.getPolicy()).activeAdapterId, undefined);
});

test("Edge rolls back staged certificates and routing when verification fails", async () => {
  const events = [];
  const broken = adapter("traefik", events, {
    async verify(context) {
      events.push(`traefik:verify:${context.switchId}`);
      return { ready: false, detail: "synthetic probe failed" };
    },
  });
  const manager = createZelavisEdgeManager({
    store: createMemorySystemStore(),
    adapters: [broken],
    defaultAdapterId: "traefik",
    certificates: certificateDistributor(events),
    createSwitchId: () => "switch-rollback",
  });

  await assert.rejects(
    manager.switchAdapter("traefik", publication),
    ZelavisEdgeSwitchError,
  );
  assert.deepEqual(events, [
    "traefik:detect",
    "certificates:stage:switch-rollback",
    "traefik:stage:switch-rollback",
    "traefik:verify:switch-rollback",
    "traefik:rollback:switch-rollback",
    "certificates:rollback:switch-rollback",
  ]);
  assert.equal((await manager.getPolicy()).activeAdapterId, undefined);
  assert.equal((await manager.getActiveSwitch()).phase, "failed");
});

test("Startup reconciliation: interrupted switch pre-activation cleanly rolls back and marks failed", async () => {
  const events = [];
  const store = createMemorySystemStore();
  const initialSwitch = {
    schemaVersion: 1,
    id: "switch-pre-crash",
    targetAdapterId: "traefik",
    publication,
    phase: "stage-routing",
    startedAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-20T10:00:01.000Z",
    leaseOwner: "crashed-controller",
    leaseExpiresAt: "2026-09-20T10:00:10.000Z",
    fenceToken: 2,
  };
  await store.set("edge", "active-switch", initialSwitch);

  const currentTime = new Date("2026-09-20T10:01:00.000Z"); // Lease expired
  const manager = createZelavisEdgeManager({
    store,
    adapters: [adapter("traefik", events)],
    defaultAdapterId: "traefik",
    certificates: certificateDistributor(events),
    now: () => currentTime,
    controllerId: "recovering-controller",
  });

  const result = await manager.reconcile();
  assert.equal(result.status, "rolled-back");
  assert.equal(result.phase, "failed");
  assert.equal(result.switchId, "switch-pre-crash");

  // Verify rollback was invoked on target adapter and certs
  assert.deepEqual(events, [
    "traefik:rollback:switch-pre-crash",
    "certificates:rollback:switch-pre-crash",
  ]);

  const activeSwitch = await manager.getActiveSwitch();
  assert.equal(activeSwitch.phase, "failed");
  assert.match(activeSwitch.error, /Interrupted by controller restart/);
  assert.equal(activeSwitch.leaseOwner, "recovering-controller");
  assert.equal(activeSwitch.fenceToken, 4);

  // Policy should be unchanged (no active adapter)
  const policy = await manager.getPolicy();
  assert.equal(policy.activeAdapterId, undefined);
});

test("Startup reconciliation: interrupted switch post-activation with healthy target completes forward recovery", async () => {
  const events = [];
  const store = createMemorySystemStore();
  // Initial policy has traefik active
  await store.set("edge", "policy", {
    schemaVersion: 1,
    revision: 1,
    desiredAdapterId: "traefik",
    activeAdapterId: "traefik",
    updatedAt: "2026-09-20T10:00:00.000Z",
  });

  // Switch to caddy crashed after activate-routing (in drain phase)
  const crashedSwitch = {
    schemaVersion: 1,
    id: "switch-post-crash-healthy",
    targetAdapterId: "caddy",
    previousAdapterId: "traefik",
    publication: { ...publication, revision: "routes-43" },
    phase: "drain",
    startedAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-20T10:00:05.000Z",
    leaseOwner: "crashed-controller",
    leaseExpiresAt: "2026-09-20T10:00:15.000Z",
    fenceToken: 5,
  };
  await store.set("edge", "active-switch", crashedSwitch);

  const currentTime = new Date("2026-09-20T10:01:00.000Z");
  const manager = createZelavisEdgeManager({
    store,
    adapters: [adapter("traefik", events), adapter("caddy", events)],
    defaultAdapterId: "traefik",
    certificates: certificateDistributor(events),
    now: () => currentTime,
    controllerId: "recovering-controller",
  });

  const result = await manager.reconcile();
  assert.equal(result.status, "recovered-forward");
  assert.equal(result.phase, "complete");
  assert.equal(result.switchId, "switch-post-crash-healthy");

  // Verify verify, drain, and policy commit
  assert.deepEqual(events, [
    "caddy:verify:switch-post-crash-healthy",
    "traefik:drain:switch-post-crash-healthy",
  ]);

  const activeSwitch = await manager.getActiveSwitch();
  assert.equal(activeSwitch.phase, "complete");

  const policy = await manager.getPolicy();
  assert.equal(policy.activeAdapterId, "caddy");
  assert.equal(policy.activePublication.revision, "routes-43");
});

test("Startup reconciliation: interrupted switch post-activation with unhealthy target rolls back and reactivates previous", async () => {
  const events = [];
  const store = createMemorySystemStore();
  await store.set("edge", "policy", {
    schemaVersion: 1,
    revision: 1,
    desiredAdapterId: "traefik",
    activeAdapterId: "traefik",
    updatedAt: "2026-09-20T10:00:00.000Z",
  });

  const crashedSwitch = {
    schemaVersion: 1,
    id: "switch-post-crash-unhealthy",
    targetAdapterId: "caddy",
    previousAdapterId: "traefik",
    publication: { ...publication, revision: "routes-43" },
    phase: "drain",
    startedAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-20T10:00:05.000Z",
    leaseOwner: "crashed-controller",
    leaseExpiresAt: "2026-09-20T10:00:15.000Z",
    fenceToken: 5,
  };
  await store.set("edge", "active-switch", crashedSwitch);

  const currentTime = new Date("2026-09-20T10:01:00.000Z");
  const brokenCaddy = adapter("caddy", events, {
    async verify(context) {
      events.push(`caddy:verify:${context.switchId}`);
      return { ready: false, detail: "proxy crashed during restart" };
    },
  });

  const manager = createZelavisEdgeManager({
    store,
    adapters: [adapter("traefik", events), brokenCaddy],
    defaultAdapterId: "traefik",
    certificates: certificateDistributor(events),
    now: () => currentTime,
    controllerId: "recovering-controller",
  });

  const result = await manager.reconcile();
  assert.equal(result.status, "rolled-back");
  assert.equal(result.phase, "failed");

  assert.deepEqual(events, [
    "caddy:verify:switch-post-crash-unhealthy",
    "caddy:rollback:switch-post-crash-unhealthy",
    "certificates:rollback:switch-post-crash-unhealthy",
    "traefik:activate:switch-post-crash-unhealthy",
  ]);

  const activeSwitch = await manager.getActiveSwitch();
  assert.equal(activeSwitch.phase, "failed");

  // Policy should remain traefik
  const policy = await manager.getPolicy();
  assert.equal(policy.activeAdapterId, "traefik");
});

test("Distributed fencing: lease expiration allows takeover and fences out stale controller", async () => {
  const events = [];
  const store = createMemorySystemStore();
  let currentTime = new Date("2026-09-20T10:00:00.000Z");

  const controllerB = createZelavisEdgeManager({
    store,
    adapters: [adapter("traefik", events)],
    defaultAdapterId: "traefik",
    certificates: certificateDistributor(events),
    now: () => currentTime,
    controllerId: "controller-b",
    leaseDurationMs: 5_000,
  });

  // Controller A creates an active switch and stalls in stage-routing
  const switchRecord = {
    schemaVersion: 1,
    id: "switch-fenced",
    targetAdapterId: "traefik",
    publication,
    phase: "stage-routing",
    startedAt: currentTime.toISOString(),
    updatedAt: currentTime.toISOString(),
    leaseOwner: "controller-a",
    leaseExpiresAt: new Date(currentTime.getTime() + 5_000).toISOString(),
    fenceToken: 1,
  };
  await store.set("edge", "active-switch", switchRecord);

  // Controller B tries to reconcile while Controller A's lease is still active: returns idle
  const earlyReconcile = await controllerB.reconcile();
  assert.equal(earlyReconcile.status, "idle");
  assert.match(earlyReconcile.detail, /leased to controller "controller-a"/);

  // Time advances past lease expiration (+10 seconds)
  currentTime = new Date(currentTime.getTime() + 10_000);

  // Controller B now reconciles and recovers the switch
  const recovered = await controllerB.reconcile();
  assert.equal(recovered.status, "rolled-back");
  assert.equal(recovered.phase, "failed");

  // Now controller A (stale) tries to advance the switch it thought it owned using its old updatedAt
  const staleRecord = {
    ...switchRecord,
    updatedAt: "2026-09-20T10:00:00.000Z", // stale timestamp
  };
  const written = await store.compareAndSet(
    "edge",
    "active-switch",
    staleRecord.updatedAt,
    { ...staleRecord, phase: "activate-routing" },
    staleRecord,
  );
  assert.equal(written, undefined); // CAS rejected stale write!
});

test("Stale-generation refusal: aborts cutover if publication is superseded before activation", async () => {
  const events = [];
  const store = createMemorySystemStore();
  let currentDesiredPublication = publication;

  const manager = createZelavisEdgeManager({
    store,
    adapters: [adapter("traefik", events, {
      async stage(context) {
        events.push(`traefik:stage:${context.switchId}`);
        // Simulate concurrent publication change during staging!
        currentDesiredPublication = {
          ...publication,
          revision: "routes-43",
        };
      },
    })],
    defaultAdapterId: "traefik",
    certificates: certificateDistributor(events),
    getPublication: async () => currentDesiredPublication,
    createSwitchId: () => "switch-stale-pub",
  });

  await assert.rejects(
    manager.switchAdapter("traefik", publication),
    (error) => {
      assert.ok(error instanceof ZelavisEdgeSwitchError);
      assert.ok(error.cause instanceof ZelavisEdgeValidationError);
      assert.match(error.cause.message, /superseded by "routes-43"/);
      return true;
    },
  );

  // Verification that target was never activated! It staged, verified, then rolled back.
  assert.deepEqual(events, [
    "traefik:detect",
    "certificates:stage:switch-stale-pub",
    "traefik:stage:switch-stale-pub",
    "traefik:verify:switch-stale-pub",
    "certificates:activate:switch-stale-pub",
    "traefik:rollback:switch-stale-pub",
    "certificates:rollback:switch-stale-pub",
  ]);

  const activeSwitch = await manager.getActiveSwitch();
  assert.equal(activeSwitch.phase, "failed");
  assert.match(activeSwitch.error, /superseded by "routes-43"/);
  assert.equal((await manager.getPolicy()).activeAdapterId, undefined);
});
