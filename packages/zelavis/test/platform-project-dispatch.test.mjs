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

function recordingDriver({ runningProjects = [] } = {}) {
  const started = [];
  const stopped = [];
  return {
    started,
    stopped,
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
      async stop(projectId) {
        stopped.push(projectId);
        return { status: "stopped" };
      },
      async status(projectId) {
        return {
          status: runningProjects.includes(projectId) ? "running" : "stopped",
        };
      },
      async logs() {
        return [];
      },
      async destroy() {},
      async close() {},
    },
  };
}

/** Places every Project on `nodeId`. */
function planner(nodeId) {
  return {
    async planProjectPlacements(requests) {
      return {
        replicas: requests.map((request) => ({
          identity: request.identity,
          projectKind: request.projectKind,
          replicaId: `${request.identity.workloadId}:runtime:1`,
          replicaIndex: 0,
          runtimeNodeId: nodeId,
        })),
        unplaced: [],
      };
    },
  };
}

async function seed(store, projects) {
  const { driver } = recordingDriver();
  const setup = await createProjectManager({
    projectRecipes: PROJECT_RECIPES,
    store,
    runtime: driver,
  });
  for (const project of projects) {
    await setup.create(project);
  }
  await setup.close();
}

async function managerWith(store, { authority, dispatch, runningProjects } = {}) {
  const { driver, started, stopped } = recordingDriver({ runningProjects });
  const manager = await createProjectManager({
    projectRecipes: PROJECT_RECIPES,
    store,
    runtime: driver,
    ...(authority ? { placement: () => authority } : {}),
    ...(dispatch ? { dispatch: () => dispatch } : {}),
  });
  return { manager, started, stopped };
}

test("a Project placed on this node still starts here", async () => {
  const store = createMemorySystemStore();
  await seed(store, [{ id: "shop", name: "shop", start: true }]);

  const { manager, started } = await managerWith(store, {
    authority: planner("node-a"),
    dispatch: { localNodeId: "node-a" },
  });
  await manager.reconcile();
  await manager.close();

  assert.deepEqual(started, ["shop"]);
});

test("a Project placed on another node is not started here", async () => {
  const store = createMemorySystemStore();
  await seed(store, [{ id: "shop", name: "shop", start: true }]);

  const { manager, started } = await managerWith(store, {
    authority: planner("node-b"),
    dispatch: { localNodeId: "node-a" },
  });
  await manager.reconcile();

  // Running it anyway would contradict the placement the Fabric decided, and
  // on a fleet where every host reconciles, every host would reach the same
  // conclusion and run its own copy.
  assert.deepEqual(started, []);

  const project = await manager.get("shop");
  // Not stopped by intent — unstarted by this host — so a later reconcile with
  // a dispatcher, or a placement naming this node, starts it.
  assert.equal(project.desiredState, "running");
  assert.equal(project.placement.nodeId, "node-b");
  assert.match(project.placement.error, /cannot start Projects on node "node-b"/);
  await manager.close();
});

test("a dispatcher runs the Project on the node it belongs to", async () => {
  const store = createMemorySystemStore();
  await seed(store, [{ id: "shop", name: "shop", start: true }]);

  const dispatched = [];
  const { manager, started } = await managerWith(store, {
    authority: planner("node-b"),
    dispatch: {
      localNodeId: "node-a",
      async dispatchStart(request) {
        dispatched.push(request);
      },
    },
  });
  await manager.reconcile();
  await manager.close();

  assert.deepEqual(started, []);
  assert.deepEqual(dispatched, [{ projectId: "shop", nodeId: "node-b" }]);
});

test("a dispatch that fails is recorded rather than silently retried here", async () => {
  const store = createMemorySystemStore();
  await seed(store, [{ id: "shop", name: "shop", start: true }]);

  const { manager, started } = await managerWith(store, {
    authority: planner("node-b"),
    dispatch: {
      localNodeId: "node-a",
      async dispatchStart() {
        throw new Error("node-b is unreachable");
      },
    },
  });
  await manager.reconcile();

  assert.deepEqual(started, []);
  const project = await manager.get("shop");
  assert.equal(project.placement.nodeId, "node-b");
  assert.match(project.placement.error, /node-b is unreachable/);
  assert.equal(project.placement.dispatchedAt, undefined);
  await manager.close();
});

test("a Project running here that moves away is stopped here", async () => {
  const store = createMemorySystemStore();
  await seed(store, [{ id: "shop", name: "shop", start: true }]);

  const { manager, started, stopped } = await managerWith(store, {
    authority: planner("node-b"),
    dispatch: { localNodeId: "node-a" },
    runningProjects: ["shop"],
  });
  await manager.reconcile();
  await manager.close();

  // Stopping it is this host's half of the move; the node that now owns it
  // starts it.
  assert.deepEqual(started, []);
  assert.deepEqual(stopped, ["shop"]);
});

test("starting a Project placed elsewhere is refused, with the node named", async () => {
  const store = createMemorySystemStore();
  await seed(store, [{ id: "shop", name: "shop", start: false }]);

  const { manager, started } = await managerWith(store, {
    authority: planner("node-b"),
    dispatch: { localNodeId: "node-a" },
  });

  await assert.rejects(
    manager.start("shop"),
    /placed on node "node-b"/,
  );
  assert.deepEqual(started, []);
  await manager.close();
});

test("a host that does not know which node it is starts everything locally", async () => {
  const store = createMemorySystemStore();
  await seed(store, [{ id: "shop", name: "shop", start: true }]);

  // No dispatcher means no local node id, so there is no assignment to compare
  // against and nothing changes for a single-node installation.
  const { manager, started } = await managerWith(store, {
    authority: planner("node-b"),
  });
  await manager.reconcile();
  await manager.close();

  assert.deepEqual(started, ["shop"]);
});

test("a planner that fails does not leave the installation stopped", async () => {
  const store = createMemorySystemStore();
  await seed(store, [{ id: "shop", name: "shop", start: true }]);

  const { manager, started } = await managerWith(store, {
    authority: {
      async planProjectPlacements() {
        throw new Error("fabric is down");
      },
    },
    dispatch: { localNodeId: "node-a" },
  });
  await manager.reconcile();
  await manager.close();

  assert.deepEqual(started, ["shop"]);
});
