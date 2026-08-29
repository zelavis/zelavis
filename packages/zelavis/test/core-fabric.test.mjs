import assert from "node:assert/strict";
import test from "node:test";

import {
  createFabricService,
  planFabricProjectPlacements,
  createServiceRuntime,
} from "../dist/core/index.js";

test("workload and Fabric contracts have narrow package subpaths", async () => {
  const [workload, fabric] = await Promise.all([
    import("zelavis/workload"),
    import("zelavis/fabric"),
  ]);

  assert.equal(typeof workload, "object");
  assert.equal(typeof fabric.createFabricService, "function");
});

test("Fabric mounts a single-node core service with project placement inventory", async () => {
  const service = createFabricService({
    localNode: {
      id: "node-a",
      status: "ready",
      roles: ["gateway", "control", "worker"],
      runtimeEngine: "node",
      runtimeDriver: "node-process",
    },
    inventory: {
      projectPlacements: () => [
        {
          identity: {
            scopeId: "local-platform",
            workloadId: "wordpress-site",
            type: "project",
          },
          projectKind: "wordpress",
          runtimeNodeId: "node-a",
          generation: 1,
          state: "active",
          runtimeStatus: "running",
        },
        {
          identity: {
            scopeId: "local-platform",
            workloadId: "zelavis-app",
            type: "project",
          },
          projectKind: "zelavis",
          runtimeNodeId: "node-a",
          databaseNodeId: "node-a",
          generation: 1,
          state: "active",
          runtimeStatus: "running",
        },
      ],
    },
  });
  const runtime = await createServiceRuntime({
    prefix: "/zelavis/api/v1",
    version: "v1",
    services: [service],
  });

  const response = await runtime.plain({
    url: "/zelavis/api/v1/fabric/snapshot",
    principal: { id: "operator", type: "system", permissions: ["fabric.view"] },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    authority: {
      scope: "platform",
      scopeId: "local-platform",
      capabilities: ["hosting:projects", "hosting:fabric"],
    },
    mode: "single-node",
    status: "ready",
    localNodeId: "node-a",
    nodes: [
      {
        id: "node-a",
        status: "ready",
        roles: ["gateway", "control", "worker"],
        runtimeEngine: "node",
        runtimeDriver: "node-process",
      },
    ],
    projectPlacements: [
      {
        identity: {
          scopeId: "local-platform",
          workloadId: "wordpress-site",
          type: "project",
        },
        projectKind: "wordpress",
        runtimeNodeId: "node-a",
        generation: 1,
        state: "active",
        runtimeStatus: "running",
      },
      {
        identity: {
          scopeId: "local-platform",
          workloadId: "zelavis-app",
          type: "project",
        },
        projectKind: "zelavis",
        runtimeNodeId: "node-a",
        databaseNodeId: "node-a",
        generation: 1,
        state: "active",
        runtimeStatus: "running",
      },
    ],
    migrations: [],
    features: {
      projectPlacement: "available",
      multiNode: "planned",
      automaticBalancing: "planned",
      projectMigration: "planned",
      zelavisAppDataPlacement: "planned",
      replication: "planned",
      infrastructureAutoscaling: "planned",
    },
  });
  assert.equal(service.kind, "core");
  assert.equal(service.menu, undefined);
});

test("Fabric returns 404 for unknown nodes and placements", async () => {
  const runtime = await createServiceRuntime({
    prefix: "/zelavis/api/v1",
    version: "v1",
    services: [createFabricService()],
  });

  const principal = { id: "operator", type: "system", permissions: ["fabric.view"] };
  const [node, placement] = await Promise.all([
    runtime.plain({ url: "/zelavis/api/v1/fabric/nodes/missing", principal }),
    runtime.plain({
      url: "/zelavis/api/v1/fabric/placements/projects/missing",
      principal,
    }),
  ]);

  assert.equal(node.status, 404);
  assert.equal(placement.status, 404);
});

test("Fabric inventory and planning enforce distinct permissions", async () => {
  const runtime = await createServiceRuntime({
    prefix: "/zelavis/api/v1",
    version: "v1",
    services: [createFabricService()],
  });
  const anonymous = await runtime.plain({
    url: "/zelavis/api/v1/fabric/snapshot",
  });
  const viewerPlan = await runtime.plain({
    url: "/zelavis/api/v1/fabric/placements/projects/plan",
    method: "POST",
    principal: { id: "viewer", type: "system", permissions: ["fabric.view"] },
    body: { requests: [] },
  });
  const managerPlan = await runtime.plain({
    url: "/zelavis/api/v1/fabric/placements/projects/plan",
    method: "POST",
    principal: { id: "manager", type: "system", permissions: ["fabric.manage"] },
    body: { requests: [] },
  });

  assert.equal(anonymous.status, 401);
  assert.equal(viewerPlan.status, 403);
  assert.equal(managerPlan.status, 200);
});

test("Fabric resolves a Project placement through the point inventory", async () => {
  let listCalls = 0;
  const service = createFabricService({
    inventory: {
      projectPlacements() {
        listCalls += 1;
        return [];
      },
      projectPlacement(projectId) {
        return projectId === "project-a"
          ? {
              identity: {
                scopeId: "platform-a",
                workloadId: projectId,
                type: "project",
              },
              projectKind: "zelavis",
              runtimeNodeId: "node-a",
              databaseNodeId: "node-a",
              generation: 7,
              state: "active",
              runtimeStatus: "running",
            }
          : undefined;
      },
    },
  });

  assert.deepEqual(await service.service.getProjectPlacement("project-a"), {
    identity: {
      scopeId: "platform-a",
      workloadId: "project-a",
      type: "project",
    },
    projectKind: "zelavis",
    runtimeNodeId: "node-a",
    databaseNodeId: "node-a",
    generation: 7,
    state: "active",
    runtimeStatus: "running",
  });
  assert.equal(listCalls, 0);
});

const statelessCapabilities = { statelessRuntimeReplicas: true };
const statefulCapabilities = { statelessRuntimeReplicas: false };

function placementRequest(projectId, overrides = {}) {
  return {
    identity: {
      scopeId: "platform-a",
      workloadId: projectId,
      type: "project",
    },
    projectKind: "zelavis",
    capabilities: statefulCapabilities,
    ...overrides,
  };
}

test("Fabric packs many single-replica Projects onto one eligible worker", () => {
  const plan = planFabricProjectPlacements(
    [{ id: "node-a", status: "ready", roles: ["worker"] }],
    [
      placementRequest("project-c"),
      placementRequest("project-a"),
      placementRequest("project-b"),
    ],
  );

  assert.deepEqual(
    plan.replicas.map((replica) => [
      replica.identity.workloadId,
      replica.runtimeNodeId,
    ]),
    [
      ["project-a", "node-a"],
      ["project-b", "node-a"],
      ["project-c", "node-a"],
    ],
  );
  assert.deepEqual(plan.unplaced, []);
});

test("Fabric scales a hot stateless Project locally and spreads it when workers exist", () => {
  const request = placementRequest("hot-project", {
    capabilities: statelessCapabilities,
    replicaPolicy: {
      mode: "automatic",
      minReplicas: 1,
      maxReplicas: 4,
    },
    scaleSignal: { currentReplicas: 2, cpu: 0.9 },
  });

  const local = planFabricProjectPlacements(
    [{ id: "node-a", status: "ready", roles: ["worker"] }],
    [request],
  );
  assert.deepEqual(
    local.replicas.map((replica) => replica.runtimeNodeId),
    ["node-a", "node-a", "node-a"],
  );

  const distributed = planFabricProjectPlacements(
    [
      { id: "node-a", status: "ready", roles: ["worker"] },
      { id: "node-b", status: "ready", roles: ["worker"] },
    ],
    [request],
  );
  assert.deepEqual(
    distributed.replicas.map((replica) => replica.runtimeNodeId),
    ["node-a", "node-b", "node-a"],
  );
});

test("Fabric never multiplies a Project whose driver cannot run stateless replicas", () => {
  const plan = planFabricProjectPlacements(
    [
      { id: "node-a", status: "ready", roles: ["worker"] },
      { id: "node-b", status: "ready", roles: ["worker"] },
    ],
    [
      placementRequest("sqlite-project", {
        replicaPolicy: { mode: "fixed", replicas: 8, maxReplicas: 8 },
      }),
    ],
  );

  assert.equal(plan.replicas.length, 1);
  assert.equal(plan.replicas[0].runtimeNodeId, "node-a");
});

test("Fabric enforces runtime compatibility, labels, and explicit capacity", () => {
  const plan = planFabricProjectPlacements(
    [
      {
        id: "node-a",
        status: "ready",
        roles: ["worker"],
        runtimeDriver: "node-process",
        capacity: { cpuCores: 1, memoryBytes: 1_000 },
        labels: { region: "eu" },
      },
      {
        id: "node-b",
        status: "draining",
        roles: ["worker"],
        runtimeDriver: "node-process",
        capacity: { cpuCores: 8, memoryBytes: 8_000 },
        labels: { region: "eu" },
      },
    ],
    [
      placementRequest("project-a", {
        runtimeDriver: "node-process",
        requiredLabels: { region: "eu" },
        resources: { cpuCores: 1, memoryBytes: 750 },
      }),
      placementRequest("project-b", {
        runtimeDriver: "node-process",
        requiredLabels: { region: "eu" },
        resources: { cpuCores: 1, memoryBytes: 750 },
      }),
      placementRequest("project-c", {
        runtimeDriver: "bun-process",
      }),
    ],
  );

  assert.deepEqual(
    plan.replicas.map((replica) => replica.identity.workloadId),
    ["project-a"],
  );
  assert.deepEqual(
    plan.unplaced.map((replica) => [
      replica.identity.workloadId,
      replica.reason,
    ]),
    [
      ["project-b", "insufficient-capacity"],
      ["project-c", "no-eligible-node"],
    ],
  );
});

test("Fabric exposes deterministic placement planning through its managed endpoint", async () => {
  const runtime = await createServiceRuntime({
    prefix: "/zelavis/api/v1",
    version: "v1",
    services: [
      createFabricService({
        localNode: {
          id: "node-a",
          status: "ready",
          roles: ["worker"],
          runtimeDriver: "node-process",
        },
      }),
    ],
  });

  const principal = {
    id: "manager",
    type: "system",
    permissions: ["fabric.manage"],
  };
  const response = await runtime.plain({
    url: "/zelavis/api/v1/fabric/placements/projects/plan",
    method: "POST",
    principal,
    body: {
      requests: [
        placementRequest("project-a", {
          runtimeDriver: "node-process",
        }),
      ],
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.plan.replicas[0].runtimeNodeId, "node-a");

  const invalid = await runtime.plain({
    url: "/zelavis/api/v1/fabric/placements/projects/plan",
    method: "POST",
    principal,
    body: { requests: [{ projectKind: "zelavis" }] },
  });
  assert.equal(invalid.status, 400);
});
