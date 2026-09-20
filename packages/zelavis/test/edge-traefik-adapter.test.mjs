import assert from "node:assert/strict";
import test from "node:test";

import {
  createMemorySystemStore,
  createZelavisEdgeManager,
  createTraefikEdgeAdapter,
  createTraefikCertificateDistributor,
  ZelavisEdgeSwitchError,
} from "../dist/index.js";

function makeInvoker(events, options = {}) {
  return {
    async execute(opId, args) {
      events.push({ opId, args });
      if (options.failOnValidate && opId === "zelavis.edge-validate") {
        return { valid: false, error: "Validation intentionally failed in test" };
      }
      if (opId === "zelavis.edge-unit-control") {
        return { unit: args.unit, action: args.action, active: true, status: "success" };
      }
      if (opId === "zelavis.edge-stage") {
        return { status: "staged", generation: args.generation };
      }
      if (opId === "zelavis.edge-validate") {
        return { valid: true, generation: args.generation, dynamicConfigBytes: 1234 };
      }
      if (opId === "zelavis.edge-activate") {
        return { status: "activated", generation: args.generation, previousGeneration: null };
      }
      if (opId === "zelavis.edge-drain") {
        return { status: "drained", durationMs: Number(args["duration-ms"]) };
      }
      if (opId === "zelavis.edge-rollback") {
        return { status: "rolled_back", restoredGeneration: null };
      }
      return { status: "ok" };
    },
  };
}

test("Traefik Edge Adapter: detect returns available and version", async () => {
  const events = [];
  const invoker = makeInvoker(events);
  const adapter = createTraefikEdgeAdapter({ invoker });

  const detection = await adapter.detect();
  assert.equal(detection.state, "available");
  assert.equal(detection.installed, true);
  assert.equal(detection.version, "3.7.13");
  assert.equal(events.length, 1);
  assert.equal(events[0].opId, "zelavis.edge-unit-control");
  assert.equal(events[0].args.action, "status");
});

test("Traefik Edge Adapter: executes full switch lifecycle through signed operations", async () => {
  const events = [];
  const invoker = makeInvoker(events);
  const adapter = createTraefikEdgeAdapter({
    invoker,
    baseDir: "/var/lib/zelavis/edge/traefik",
  });

  const certificates = createTraefikCertificateDistributor({
    invoker,
    baseDir: "/var/lib/zelavis/edge/traefik",
    certificateResolver: async (ref) => ({
      certPem: `CERT_PEM_FOR_${ref}`,
      keyPem: `KEY_PEM_FOR_${ref}`,
    }),
  });

  const store = createMemorySystemStore();
  const manager = createZelavisEdgeManager({
    store,
    adapters: [adapter],
    certificates,
    defaultAdapterId: "traefik",
    createSwitchId: () => "switch-test-01",
  });

  const publication = {
    id: "platform-routes",
    revision: "rev-1",
    routeCount: 2,
    requiredCapabilities: ["http", "https"],
    certificateRefs: ["cert.example.com"],
  };

  const switchRecord = await manager.switchAdapter("traefik", publication);
  assert.equal(switchRecord.phase, "complete");
  assert.equal(switchRecord.targetAdapterId, "traefik");

  // Verify operation sequence
  const opNames = events.map((e) => e.opId);
  // 1. detect (during plan/switch)
  assert.ok(opNames.includes("zelavis.edge-unit-control"));
  // 2. certificate stage
  assert.ok(opNames.includes("zelavis.edge-stage"));
  // 3. route stage
  assert.ok(opNames.includes("zelavis.edge-stage"));
  // 4. route validate
  assert.ok(opNames.includes("zelavis.edge-validate"));
  // 5. route activate
  assert.ok(opNames.includes("zelavis.edge-activate"));
  // 6. unit reload
  assert.ok(opNames.includes("zelavis.edge-unit-control"));

  // Check policy is now committed
  const policy = await manager.getPolicy();
  assert.equal(policy.activeAdapterId, "traefik");
  assert.equal(policy.desiredAdapterId, "traefik");
});

test("Traefik Edge Adapter: rolls back when validation fails", async () => {
  const events = [];
  const invoker = makeInvoker(events, { failOnValidate: true });
  const adapter = createTraefikEdgeAdapter({ invoker });

  const store = createMemorySystemStore();
  const manager = createZelavisEdgeManager({
    store,
    adapters: [adapter],
    defaultAdapterId: "traefik",
    createSwitchId: () => "switch-fail-01",
  });

  const publication = {
    id: "platform-routes",
    revision: "rev-1",
    routeCount: 1,
    requiredCapabilities: ["http"],
    certificateRefs: [],
  };

  await assert.rejects(
    manager.switchAdapter("traefik", publication),
    ZelavisEdgeSwitchError,
  );

  // Verify rollback was invoked
  const rollbackEvent = events.find((e) => e.opId === "zelavis.edge-rollback");
  assert.ok(rollbackEvent, "zelavis.edge-rollback must have been called");
});
