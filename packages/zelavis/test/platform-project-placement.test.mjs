import assert from "node:assert/strict";
import test from "node:test";

import { createProjectManager } from "../dist/project.js";
import { createMemorySystemStore } from "../dist/system-store.js";

const PROJECT_RECIPES = [
  {
    service: {
      name: "zelavis/app",
      kind: "app",
      version: "1.0.0-test",
      api: {},
      service: {},
    },
    specifier: "zelavis/app",
    status: "available",
    source: "official",
    order: 0,
  },
];

function recordingDriver() {
  const started = [];
  return {
    started,
    driver: {
      name: "test-driver",
      capabilities: () => ({
        independentRuntimeVersion: false,
        movable: false,
        liveMigration: false,
        secureIsolation: false,
        resourceLimits: false,
        persistentFilesystem: true,
        statelessRuntimeReplicas: false,
        managedStorage: false,
        managedDatabase: false,
        databaseReplication: false,
        tenantPlacement: false,
        databaseSharding: false,
        runtimeOwnership: "platform-process",
        survivesControlPlaneRestart: false,
        description: "test",
      }),
      async prepare() {},
      async start(project) {
        started.push(project.id);
        return { status: "running", url: "http://127.0.0.1:1" };
      },
      async stop() {
        return { status: "stopped" };
      },
      async status() {
        return { status: "stopped" };
      },
      async logs() {
        return [];
      },
      async destroy() {},
      async close() {},
    },
  };
}

/** Records what it was asked to plan, and answers with a fixed verdict. */
function planner(unplaced = []) {
  const seen = [];
  return {
    seen,
    authority: {
      async planProjectPlacements(requests) {
        seen.push(requests);
        return {
          replicas: requests
            .filter((request) =>
              !unplaced.some((entry) => entry.id === request.identity.workloadId),
            )
            .map((request) => ({
              identity: request.identity,
              projectKind: request.projectKind,
              replicaId: `${request.identity.workloadId}:runtime:1`,
              replicaIndex: 0,
              runtimeNodeId: "node-a",
            })),
          unplaced: unplaced.map((entry) => ({
            identity: { scopeId: "platform", workloadId: entry.id, type: "project" },
            projectKind: "zelavis",
            replicaId: `${entry.id}:runtime:1`,
            replicaIndex: 0,
            reason: entry.reason,
          })),
        };
      },
    },
  };
}

async function seed(store, projects) {
  const { driver, started } = recordingDriver();
  const setup = await createProjectManager({
    projectRecipes: PROJECT_RECIPES,
    store,
    runtime: driver,
  });
  for (const project of projects) {
    await setup.create(project);
  }
  await setup.close();
  started.length = 0;
  return started;
}

async function reconcileWith(store, authority) {
  const { driver, started } = recordingDriver();
  const manager = await createProjectManager({
    projectRecipes: PROJECT_RECIPES,
    store,
    runtime: driver,
    placement: () => authority,
  });
  await manager.reconcile();
  await manager.close();
  return started;
}

test("a Project whose owner cannot be placed is not started", async () => {
  const store = createMemorySystemStore();
  await seed(store, [
    { id: "shop", name: "shop", start: true },
    { id: "shop-frontend", name: "shop-frontend", start: true, ownerProjectId: "shop" },
  ]);

  const { authority } = planner([{ id: "shop-frontend", reason: "owner-unplaced" }]);
  const started = await reconcileWith(store, authority);

  // Its owner has nowhere to run, so starting it would put a Project's
  // frontend somewhere its owner is not.
  assert.ok(!started.includes("shop-frontend"));
  assert.ok(started.includes("shop"));
});

test("an ownership cycle blocks every Project in it", async () => {
  const store = createMemorySystemStore();
  await seed(store, [
    { id: "a", name: "a", start: true },
    { id: "b", name: "b", start: true, ownerProjectId: "a" },
  ]);

  const { authority } = planner([
    { id: "a", reason: "owner-cycle" },
    { id: "b", reason: "owner-cycle" },
  ]);

  assert.deepEqual(await reconcileWith(store, authority), []);
});

test("a scheduling answer does not stop a Project from starting", async () => {
  const store = createMemorySystemStore();
  await seed(store, [
    { id: "shop", name: "shop", start: true },
    { id: "shop-frontend", name: "shop-frontend", start: true, ownerProjectId: "shop" },
  ]);

  // This host does not schedule — the driver runs everything locally — so
  // "no capacity" is not an answer reconciliation can act on. Treating it as a
  // refusal would stop Projects on an installation that models no capacity.
  const { authority } = planner([
    { id: "shop-frontend", reason: "insufficient-capacity" },
    { id: "shop", reason: "no-eligible-node" },
  ]);

  const started = await reconcileWith(store, authority);
  assert.deepEqual(started.sort(), ["shop", "shop-frontend"]);
});

test("nothing is planned when no Project is owned", async () => {
  const store = createMemorySystemStore();
  await seed(store, [
    { id: "alpha", name: "alpha", start: true },
    { id: "beta", name: "beta", start: true },
  ]);

  const { authority, seen } = planner();
  const started = await reconcileWith(store, authority);

  // No group exists to violate, so Fabric is not consulted at all — which also
  // keeps a Fabric failure from interfering with ordinary startup.
  assert.deepEqual(seen, []);
  assert.deepEqual(started.sort(), ["alpha", "beta"]);
});

test("a host with no placement authority reconciles as before", async () => {
  const store = createMemorySystemStore();
  await seed(store, [
    { id: "shop", name: "shop", start: true },
    { id: "shop-frontend", name: "shop-frontend", start: true, ownerProjectId: "shop" },
  ]);

  const started = await reconcileWith(store, undefined);
  assert.deepEqual(started.sort(), ["shop", "shop-frontend"]);
});

test("a failing planner does not stop Projects from starting", async () => {
  const store = createMemorySystemStore();
  await seed(store, [
    { id: "shop", name: "shop", start: true },
    { id: "shop-frontend", name: "shop-frontend", start: true, ownerProjectId: "shop" },
  ]);

  const started = await reconcileWith(store, {
    async planProjectPlacements() {
      throw new Error("fabric is unavailable");
    },
  });

  // Fabric being down is not a reason to leave an installation stopped.
  assert.deepEqual(started.sort(), ["shop", "shop-frontend"]);
});
