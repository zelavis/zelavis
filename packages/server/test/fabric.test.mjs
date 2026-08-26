import assert from "node:assert/strict";
import test from "node:test";

import { createFabricService, zelavisServer } from "../dist/index.js";

test("workload and Fabric contracts have narrow package subpaths", async () => {
  const [workload, fabric] = await Promise.all([
    import("@zelavis/server/workload"),
    import("@zelavis/server/fabric"),
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
  const runtime = await zelavisServer({
    prefix: "/zelavis/api/v1",
    version: "v1",
    services: [service],
  });

  const response = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/fabric/snapshot"),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
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
  const runtime = await zelavisServer({
    prefix: "/zelavis/api/v1",
    version: "v1",
    services: [createFabricService()],
  });

  const [node, placement] = await Promise.all([
    runtime.fetch(
      new Request("http://localhost/zelavis/api/v1/fabric/nodes/missing"),
    ),
    runtime.fetch(
      new Request(
        "http://localhost/zelavis/api/v1/fabric/placements/projects/missing",
      ),
    ),
  ]);

  assert.equal(node.status, 404);
  assert.equal(placement.status, 404);
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
