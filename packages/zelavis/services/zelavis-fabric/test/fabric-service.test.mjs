import assert from "node:assert/strict";
import test from "node:test";

import { zelavisServer } from "@zelavis/server";
import { createFabricService } from "../dist/index.js";

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
          projectId: "wordpress-site",
          projectKind: "wordpress",
          nodeId: "node-a",
          generation: 1,
          state: "active",
          runtimeStatus: "running",
        },
        {
          projectId: "zelavis-app",
          projectKind: "zelavis",
          nodeId: "node-a",
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
        projectId: "wordpress-site",
        projectKind: "wordpress",
        nodeId: "node-a",
        generation: 1,
        state: "active",
        runtimeStatus: "running",
      },
      {
        projectId: "zelavis-app",
        projectKind: "zelavis",
        nodeId: "node-a",
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
  assert.equal(service.menu?.path, "/server/fabric");
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
