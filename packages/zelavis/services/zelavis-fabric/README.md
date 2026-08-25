# @zelavis/fabric

`@zelavis/fabric` is the trusted `kind: "core"` System Service for distributed
placement, routing, health, balancing, migration, and recovery across the
Zelavis Platform OS.

Fabric is project-kind agnostic at the platform layer. It can inventory and
place Zelavis Apps, WordPress, Drupal, static websites, and generic managed
applications through capability-aware runtime drivers. Zelavis App projects
may later expose deeper tenant-aware database placement, replication, and
sharding capabilities through their isolated project runtime boundary.

## Current implementation

The first implementation is deliberately high level and honest:

- one statically mounted `@zelavis/fabric` runtime service
- a runtime-neutral Effect v4 capability boundary
- a single-node default inventory
- node, health, project-placement, migration, and snapshot endpoints
- optional inventory providers for Platform OS integration
- platform menu metadata for `/zelavis/server/fabric`

The initial Fabric submenu provides route-backed workspaces for overview,
nodes, placements, migrations, balancing, replication and failover, backups
and recovery, observability, Zelavis App data placement, infrastructure, and
Fabric settings. Planned pages are structured placeholders rather than dead
navigation entries.

Infrastructure includes connection surfaces for self-managed servers and
optional cloud/VPS providers. Provider credentials and vendor SDK calls belong
to provider plugins and the Platform System Store; Fabric consumes only the
provider-neutral provisioning capability.

Multi-node coordination, durable migration execution, automatic balancing,
replication, infrastructure autoscaling, and Zelavis App data placement remain
explicitly reported as planned capabilities.

## Service entrypoint

The real mounted definition lives in `src/fabric-service.ts`. `src/index.ts`
only re-exports that entrypoint.

```ts
import { createFabricService } from "@zelavis/fabric";

const fabric = createFabricService({
  localNode: {
    id: "node-a",
    status: "ready",
    roles: ["gateway", "control", "worker"],
    runtimeEngine: "node",
    runtimeDriver: "node-process",
  },
});
```

The Platform OS mounts Fabric automatically. Applications should not mount it
inside project runtimes, and runtime-installed extensions cannot replace it.

## Initial endpoints

Under the default Zelavis namespace:

```text
GET /zelavis/api/v1/fabric/snapshot
GET /zelavis/api/v1/fabric/health
GET /zelavis/api/v1/fabric/nodes
GET /zelavis/api/v1/fabric/nodes/:nodeId
GET /zelavis/api/v1/fabric/placements/projects
GET /zelavis/api/v1/fabric/placements/projects/:projectId
GET /zelavis/api/v1/fabric/migrations
```

The dashboard is a client of these endpoints. Fabric authority must remain in
the service and its runtime/agent contracts rather than in React routes.
