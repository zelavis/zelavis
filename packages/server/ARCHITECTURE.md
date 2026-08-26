# @zelavis/server Architecture

This package is the reusable server and workload-runtime foundation used by
both the Zelavis Platform and Zelavis Apps. The Platform is a privileged
Zelavis application: it reuses the same primitives but receives explicit
hosting authority.

The canonical scaling rule is:

```text
Platform scales Projects.
Projects scale Tenants.
Exceptional Tenants may eventually scale Shards.
```

The engine may repeat at each level. Authority, scope, isolation, and resource
ownership never do.

## Canonical terminology

| Term | Meaning |
|---|---|
| Platform | The one logical hosting authority for a Zelavis installation. |
| Project | The universal first-level hosted workload and hard isolation boundary. |
| Zelavis App | A Project kind with native Zelavis auth, data, storage, jobs, realtime, and future Tenant placement. |
| Tenant | An application-owned logical data and workload boundary inside a Zelavis App. It is not a Project or a User. |
| Principal / User | An authenticated identity with roles, permissions, and scoped grants. |
| Node | Capacity registered with the Platform Fabric. |
| Allocation | Capacity granted by the Platform to a Project. |
| Placement | The authoritative mapping from scoped workload identity to runtime/database ownership and generation. |
| Agent | The authenticated local executor on a Node. Fabric decides; the Agent prepares, starts, stops, reports, migrates, and cleans workloads. |
| Runtime Driver | The host-specific execution implementation used by an Agent, such as Node process, Bun, OCI, VM, or dedicated host. |
| Platform Fabric | The privileged Platform capability that owns nodes, Project placement, routing, health, migration, and fleet policy. |
| App Fabric | Scoped reuse of workload primitives for a Zelavis App's own Tenants and data inside its granted envelope. It is not another root fleet controller. |

## Current implementation map

| Concern | Current owner | Current behavior |
|---|---|---|
| HTTP services and routing | `@zelavis/server` | Web-first service, route, dispatch, fetch, and Node adapter contracts are reusable. |
| Principals and permissions | `@zelavis/server` contracts/dispatcher | Low-level principals, scoped grants, route requirements, and authorization hooks exist. |
| Project registry/provisioning | `zelavis/src/project.ts` | Platform System Store records plus direct prepare/start/stop calls. Creation currently selects an installed `kind: "app"` service. |
| Runtime execution | `zelavis` Node adapter | A direct child-process driver owns trusted Project processes and per-Project directories. |
| Project storage | `zelavis` Node adapter | Project data is isolated below `.zelavis/projects/<id>/.zelavis`; Platform state stays in the System Store. |
| Fabric | `@zelavis/server/fabric.ts` | Read-only single-node inventory and endpoints for nodes, placements, and migrations. |
| Fabric integration | `zelavis/src/index.ts` | Fabric placements are derived from Project runtime status and currently use generation `1`. |
| Project proxy | `zelavis/src/index.ts` | Project API traffic requires an active scoped Fabric placement and eligible node, then forwards to `project.runtime.url`. |
| Dashboard access payload | `zelavis/src/index.ts` | Demo owner/customer presentation data. It is not an authentication source. |

## Gap analysis

### Authority and identity

Runtime-neutral contracts now define scoped workload identity, explicit
Platform/Project authority, resource envelopes, Project capabilities, and
runtime/database placement. The local Platform still uses the temporary scope
ID `local-platform`; it needs a stable installation identity persisted in the
System Store before multi-node enrollment exists.

### Project model

Project is named correctly but creation is still coupled to installed App
services and a single runtime driver. The next Project model must separate:

- universal Project identity, kind, desired state, authority, and resource envelope
- a Project kind/recipe such as Zelavis App, WordPress, static, or generic
- a capability-aware runtime driver selected for that Project
- allocation and placement state owned by Fabric

Capabilities are now declared per Project and can differ even when Projects use
the same runtime driver. The current Node driver honestly reports that movement,
replicas, resource limits, replication, Tenant placement, and sharding are not
implemented.

### Provisioning and Agent execution

Creation still performs `prepare -> start` directly. There is no scheduler,
allocation record, local Agent contract implementation, health gate, or
placement activation transaction. The first replacement should be a local
Agent using the same command contract future remote Agents use. Docker and
remote execution must wait until that boundary is proven.

### Placement authority

Fabric placements are projections of process state rather than authoritative
control-plane records. Their fixed generation cannot fence stale owners.
Placement, generation, migration, draining, and allocation state must move to
dedicated System Store contracts before remote movement or writable failover.
Customer Project databases must never store this state.

### Gateway routing

The current proxy now resolves scoped Project placement before routing, but its
final target still comes from a URL stored in Project runtime state. The
Gateway must ultimately resolve:

```text
request/domain -> scoped Project identity -> authoritative placement
               -> healthy eligible runtime target
```

Runtime URLs must become Agent-reported healthy targets, not placement
authority.

### Access control

The reusable authorization machinery is promising, but Project lifecycle,
proxy, and Fabric endpoints are not yet consistently decorated and mounted with
a real principal resolver. The query-selectable dashboard access payload is
demo UI data only. Before these become remotely exposed control APIs, every
operation needs explicit system/project permissions and endpoint enforcement.

### Scale and lifecycle

The local child-process driver is appropriate for development and small
single-host installations. Startup reconciliation is bounded and asynchronous,
and `Zelavis.close()` drains Platform-owned children. A production control-plane
outage must not terminate customer Apps: worker Nodes need separately supervised
Zelavis Agents that own runtimes while the one logical Platform authority owns
desired state and placement decisions.

The current System Store `list(namespace)` API is not fleet-scale pagination.
Cloud-scale discovery and reconciliation will require paginated authoritative
stores, durable queues, leases/fencing, rate limits, and idempotent Agent
commands. The in-process child map must not become the cloud scheduler.

## Migration order

1. Keep the canonical workload, authority, capability, resource, and placement contracts in `@zelavis/server`.
2. Split universal Project descriptors from Project recipes and introduce a Project-driver registry.
3. Persist a stable Platform scope identity and authoritative local allocations/placements in the System Store.
4. Put the current Node child-process execution behind a local Zelavis Agent capability.
5. Change Project provisioning to `Project -> allocation -> placement -> Agent prepare/start -> health -> activation`.
6. Change the proxy into a Gateway resolver backed by placement plus Agent-reported healthy runtime targets.
7. Enforce system/project permissions on Project, Gateway, Agent, and Fabric endpoints with real principals.
8. Prove generation changes, fencing, durable migration state, rollback, and node draining on local/manual movement.
9. Add remote Agents and only then automatic placement, stronger isolation drivers, provider capacity adapters, replication, and failover.
10. Add Tenant placement and much later exceptional intra-Tenant SQL sharding without conflating either with Project placement.

At every stage, keep traffic balancing, placement, replication, and
infrastructure provisioning as separate capabilities.
