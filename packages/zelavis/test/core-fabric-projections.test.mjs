import assert from "node:assert/strict";
import test from "node:test";

import { createServiceRuntime } from "../dist/core/index.js";
import {
  createFabricService,
  planFabricProjectPlacements,
} from "../dist/core/fabric/index.js";

const node = (id, status) => ({ id, status, roles: ["worker"] });

const statelessRequest = (replicaPolicy) => ({
  identity: { scopeId: "platform-a", workloadId: "alpha", type: "project" },
  projectKind: "zelavis",
  capabilities: { statelessRuntimeReplicas: true },
  ...(replicaPolicy ? { replicaPolicy } : {}),
});

test("fixed replica policy honours replicas without an explicit maximum", () => {
  const nodes = [node("node-a", "ready"), node("node-b", "ready"), node("node-c", "ready")];

  const plan = planFabricProjectPlacements(nodes, [
    statelessRequest({ mode: "fixed", replicas: 3 }),
  ]);
  const requested = plan.replicas.length + plan.unplaced.length;
  assert.equal(
    requested,
    3,
    `fixed replicas: 3 must ask for 3, saw ${plan.replicas.length} placed and ${plan.unplaced.length} unplaced`,
  );

  // An explicit maximum still constrains the fixed count.
  const capped = planFabricProjectPlacements(nodes, [
    statelessRequest({ mode: "fixed", replicas: 3, maxReplicas: 2 }),
  ]);
  assert.equal(capped.replicas.length + capped.unplaced.length, 2);

  // Single mode is unaffected.
  const single = planFabricProjectPlacements(nodes, [
    statelessRequest({ mode: "single" }),
  ]);
  assert.equal(single.replicas.length + single.unplaced.length, 1);
});

test("a draining node degrades the Fabric summary", async () => {
  const principal = { id: "ops", type: "system", permissions: ["fabric.view"] };

  const draining = await createServiceRuntime({
    prefix: "/zelavis/api/v1",
    version: "v1",
    services: [createFabricService({ localNode: node("node-a", "draining") })],
  });
  const drainingSnapshot = await draining.plain({
    url: "/zelavis/api/v1/fabric/snapshot",
    method: "GET",
    principal,
  });
  assert.equal(drainingSnapshot.status, 200, JSON.stringify(drainingSnapshot.body));
  assert.equal(
    drainingSnapshot.body.status,
    "degraded",
    "a draining node must not report the fleet as ready",
  );

  const ready = await createServiceRuntime({
    prefix: "/zelavis/api/v1",
    version: "v1",
    services: [createFabricService({ localNode: node("node-a", "ready") })],
  });
  const readySnapshot = await ready.plain({
    url: "/zelavis/api/v1/fabric/snapshot",
    method: "GET",
    principal,
  });
  assert.equal(readySnapshot.body.status, "ready");
});
