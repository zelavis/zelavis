import assert from "node:assert/strict";
import test from "node:test";

import { createProjectManager } from "../dist/project.js";
import { createMemorySystemStore } from "../dist/system-store.js";
import { createProjectPlacementAuthority } from "../dist/platform/project-placement-authority.js";
import {
  createAgentNonceTracker, signProjectDispatchAuthority,
  verifyProjectDispatchAuthority,
} from "../dist/index.js";

const recipes = [{
  service: { name: "@zelavis/app", kind: "app", version: "1.0.0-test", api: {}, service: {} },
  specifier: "@zelavis/app", status: "available", source: "official", order: 0,
}];

function driver() {
  const starts = [];
  const stops = [];
  return {
    starts, stops,
    runtime: {
      name: "test-runtime",
      capabilities: () => ({
        independentRuntimeVersion: false, movable: false, liveMigration: false,
        secureIsolation: false, resourceLimits: false, persistentFilesystem: true,
        statelessRuntimeReplicas: false, managedStorage: false, managedDatabase: false,
        databaseReplication: false, tenantPlacement: false, databaseSharding: false,
        runtimeOwnership: "platform-process", survivesControlPlaneRestart: false,
        description: "test",
      }),
      async prepare() {},
      async start(project, placement) {
        starts.push({ id: project.id, placement });
        return { status: "running", url: "http://127.0.0.1:1" };
      },
      async stop(id) { stops.push(id); return { status: "stopped" }; },
      async status() { return { status: "stopped" }; },
      async logs() { return []; },
      async destroy() {},
      async close() {},
    },
  };
}

async function seed(store) {
  const setup = await createProjectManager({
    store, projectRecipes: recipes, runtime: driver().runtime, autoReconcile: false,
  });
  await setup.create({ id: "shop", name: "shop", start: false });
  await setup.close();
}

function planner(nodeId, fail = false) {
  return {
    async planProjectPlacements(requests) {
      if (fail) throw new Error("planner unavailable");
      return { replicas: requests.map((request) => ({
        identity: request.identity, projectKind: request.projectKind,
        replicaId: "shop:runtime:1", replicaIndex: 0, runtimeNodeId: nodeId,
      })), unplaced: [] };
    },
  };
}

test("local start requires a committed placement and passes its token to the driver", async () => {
  const store = createMemorySystemStore();
  await seed(store);
  const authority = createProjectPlacementAuthority({ store, mayPlace: () => true });
  const running = driver();
  const manager = await createProjectManager({
    store, projectRecipes: recipes, runtime: running.runtime, autoReconcile: false,
    placement: () => planner("node-a"), authoritativePlacement: authority,
    dispatch: () => ({ localNodeId: "node-a" }),
  });
  try {
    await manager.start("shop");
    assert.equal(running.starts.length, 1);
    const token = running.starts[0].placement;
    assert.equal(token.nodeId, "node-a");
    assert.equal(token.epoch, 1);
    assert.equal(await authority.validate(token), true);
    await manager.stop("shop");
    assert.equal((await authority.current("shop")).state, "released");
    assert.deepEqual(running.stops, ["shop"]);
  } finally {
    await manager.close();
  }
});

test("reconciliation and a start reaching for the same placements at once share one claim", async () => {
  // Startup reconciliation plans every Project that should be running, and a
  // person's click plans the fleet plus the one they chose. Both read the same
  // epochs and both tried to take them; the loser was told the Project had no
  // placement, though the winner was this same session, and nothing started.
  const memory = createMemorySystemStore();
  // A real store yields between calls, which is what lets two callers interleave.
  const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));
  const store = new Proxy(memory, {
    get(target, name) {
      const member = target[name];
      return typeof member === "function"
        ? async (...args) => { await yieldTurn(); return member.apply(target, args); }
        : member;
    },
  });
  const setup = await createProjectManager({
    store, projectRecipes: recipes, runtime: driver().runtime, autoReconcile: false,
  });
  await setup.create({ id: "shop", name: "shop", start: false });
  await setup.create({ id: "blog", name: "blog", start: false });
  await setup.close();
  const blog = await store.get("projects", "blog");
  await store.set("projects", "blog", { ...blog.value, desiredState: "running" });

  const authority = createProjectPlacementAuthority({ store, mayPlace: () => true });
  const running = driver();
  const manager = await createProjectManager({
    store, projectRecipes: recipes, runtime: running.runtime, autoReconcile: false,
    placement: () => ({
      async planProjectPlacements(requests) {
        return { replicas: requests.map((request) => ({
          identity: request.identity, projectKind: request.projectKind,
          replicaId: `${request.identity.workloadId}:runtime:1`, replicaIndex: 0, runtimeNodeId: "node-a",
        })), unplaced: [] };
      },
    }),
    authoritativePlacement: authority,
    dispatch: () => ({ localNodeId: "node-a" }),
  });
  try {
    const results = await Promise.allSettled([manager.reconcile(), manager.start("shop"), manager.start("blog")]);
    for (const result of results) assert.equal(result.status, "fulfilled", result.reason?.message);
    assert.equal((await authority.current("blog")).epoch, 1, "one claim, not one per caller");
    assert.equal((await authority.current("shop")).epoch, 1);
  } finally {
    await manager.close();
  }
});

test("an unavailable planner cannot authorize a local start", async () => {
  const store = createMemorySystemStore();
  await seed(store);
  const authority = createProjectPlacementAuthority({ store, mayPlace: () => true });
  const running = driver();
  const manager = await createProjectManager({
    store, projectRecipes: recipes, runtime: running.runtime, autoReconcile: false,
    placement: () => planner("node-a", true), authoritativePlacement: authority,
    dispatch: () => ({ localNodeId: "node-a" }),
  });
  try {
    await assert.rejects(manager.start("shop"), /no committed Fabric placement/);
    assert.deepEqual(running.starts, []);
    assert.equal(await authority.current("shop"), undefined);
  } finally {
    await manager.close();
  }
});

test("remote dispatch receives committed token and requires a fenced stop path", async () => {
  const store = createMemorySystemStore();
  await seed(store);
  const authority = createProjectPlacementAuthority({ store, mayPlace: (_, node) => node === "node-b" });
  const running = driver();
  const starts = [];
  const stops = [];
  const leases = [];
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"],
  );
  const trust = { keys: [{
    keyId: "platform-a",
    publicKey: Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64"),
    notBefore: new Date(Date.now() - 60_000).toISOString(),
    notAfter: new Date(Date.now() + 60_000).toISOString(),
  }] };
  const consumeNonce = createAgentNonceTracker();
  const receive = async (input, action) => {
    const placement = await authority.current(input.projectId);
    const verified = await verifyProjectDispatchAuthority(trust, input.authority, {
      agentId: "agent-b", action, placement, consumeNonce,
    });
    assert.ok(verified);
    assert.equal(verified.nodeId, input.nodeId);
  };
  const manager = await createProjectManager({
    store, projectRecipes: recipes, runtime: running.runtime, autoReconcile: false,
    placement: () => planner("node-b"), authoritativePlacement: authority,
    dispatch: () => ({
      localNodeId: "node-a",
      async dispatchLeaseFenced(placement) { leases.push(placement); },
      async authorizeDispatch({ action, placement }) {
        const now = Date.now();
        return signProjectDispatchAuthority(privateKey, {
          keyId: "platform-a", agentId: "agent-b", action,
          ...placement, issuedAt: now, expiresAt: now + 30_000,
          nonce: crypto.randomUUID(),
        });
      },
      async dispatchStartFenced(input) { await receive(input, "start"); starts.push(input); },
      async dispatchStopFenced(input) { await receive(input, "stop"); stops.push(input); },
    }),
  });
  try {
    const started = await manager.start("shop");
    assert.deepEqual(running.starts, []);
    assert.equal(started.desiredState, "running");
    assert.equal(starts.length, 1);
    assert.equal(leases.length, 1);
    assert.equal(starts[0].placement.epoch, 1);
    assert.equal(await authority.validate(starts[0].placement), true);
    await manager.stop("shop");
    assert.equal(stops.length, 1);
    assert.equal((await authority.current("shop")).state, "released");
  } finally {
    await manager.close();
  }
});

test("a replacement Platform waits for the old lease and advances the epoch", async () => {
  const store = createMemorySystemStore();
  await seed(store);
  const authority = createProjectPlacementAuthority({ store, mayPlace: () => true,
    fencePrevious: () => true });
  const old = await authority.acquire({
    projectId: "shop", nodeId: "node-a", ownerSession: "old-session",
    expectedEpoch: 0, leaseMs: 200,
  });
  assert.equal(old.granted, true);
  const running = driver();
  const manager = await createProjectManager({
    store, projectRecipes: recipes, runtime: running.runtime, autoReconcile: false,
    placement: () => planner("node-a"), authoritativePlacement: authority,
    dispatch: () => ({ localNodeId: "node-a" }),
  });
  try {
    await assert.rejects(manager.start("shop"), /no committed Fabric placement/);
    assert.deepEqual(running.starts, []);
    await new Promise((resolve) => setTimeout(resolve, 240));
    await manager.start("shop");
    assert.equal(running.starts[0].placement.epoch, 2);
  } finally {
    await manager.close();
  }
});
