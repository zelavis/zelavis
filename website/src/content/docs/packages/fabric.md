---
title: "@zelavis/fabric"
---

`@zelavis/fabric` is the trusted `kind: "core"` service that grows the Zelavis
Platform OS from one machine into a distributed installation.

## Scope

Fabric owns platform-wide node inventory, project placement, internal routing,
balancing, migration, recovery, replication coordination, and optional
infrastructure autoscaling. The universal placement unit is a project, so the
same control plane can manage Zelavis Apps, WordPress, Drupal, static sites,
and generic hosted applications.

Zelavis App projects expose an additional data capability. Fabric can later
route tenants among a shared project database, shared shard databases,
dedicated tenant databases, replicas, and—only when needed—intra-tenant shards.
Fabric does not claim transparent database sharding for arbitrary third-party
applications.

## Current implementation

The initial implementation provides:

- a runtime-neutral Effect v4 capability boundary
- a single-node inventory connected to Platform project state
- snapshot, health, node, project-placement, and migration endpoints
- a route-backed dashboard workspace under `/zelavis/server/fabric`
- explicit feature status for work that remains planned

The dashboard includes structured areas for nodes, placements, migrations,
balancing, replication, recovery, observability, Zelavis App data placement,
infrastructure providers, autoscaling, and Fabric policy settings.

## Infrastructure providers

Existing self-managed machines remain first-class. Optional provider plugins
may connect Hetzner Cloud, DigitalOcean, AWS, Azure, Google Cloud, Vultr, a
private cloud, or another server provider through a provider-neutral node
provisioning contract. Provider secrets and SDK behavior do not belong in the
Fabric core service.

## Endpoints

Initial read capabilities live under `/zelavis/api/v1/fabric`:

```text
GET /snapshot
GET /health
GET /nodes
GET /nodes/:nodeId
GET /placements/projects
GET /placements/projects/:projectId
GET /migrations
```

The dashboard is one client of these endpoints. Placement authority and future
mutations remain inside Fabric capabilities rather than React routes.

## Related docs

- [zelavis](./zelavis.md)
- [@zelavis/server](./server.md)
- [Endpoint-Backed Capabilities](../architecture/endpoint-backed-capabilities.md)
