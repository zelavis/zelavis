# Zelavis Core and Fabric Architecture

`zelavis` is the one official framework and App Platform package. Its reusable
server, runtime, Fabric, workload, artifact, and provider implementation lives
under `src/core` and is exposed through focused `zelavis/*` subpaths. The same
engine powers the privileged root Platform and isolated Zelavis App Projects;
scope and explicit authority make their roles different.

The canonical scaling rule is:

```text
Platform scales Projects.
Projects scale Tenants.
Exceptional Tenants may eventually scale Shards.
```

The engine may repeat at each level. Authority, scope, isolation, and resource
ownership never do.

The canonical App data topology rule is:

```text
Official Zelavis App
  -> one logical App database
    -> versioned virtual shard ranges
      -> several physical SQLite shards
        -> authoritative writer placements
          -> one or many Nodes
```

Local physical sharding is the official App default from creation. A
single-node installation executes the same topology and placement contracts as
a multi-node installation, with an in-process fast path and all placements
colocated. Scale-out moves, splits, merges, or replicates existing shard
placements; it does not introduce sharding for the first time.

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
| Project Cell | A future delegated Project Platform that may own nested Apps/Projects inside its allocation while the parent places and moves the whole cell. |

## Current implementation map

| Concern | Current owner | Current behavior |
|---|---|---|
| HTTP services and routing | `zelavis/core` | Web-first service, route, dispatch, fetch, and Node adapter contracts are reusable. |
| Runtime lifecycle | `zelavis/runtime` | Explicit plugins, typed lifecycle hooks, and idempotent cleanup are integrated into `createServiceRuntime()`. |
| Portable artifacts | `zelavis/artifact` | A validated versioned manifest exists; build, digest, signing, storage, and installation are not implemented. |
| Provider boundary | `zelavis/provider` | Versioned provider definitions advertise narrow capabilities; capability-specific APIs and concrete cloud plugins are future work. |
| Principals and permissions | `zelavis/core` contracts/dispatcher | Low-level principals, scoped grants, route requirements, and authorization hooks exist. |
| Project registry/provisioning | `src/project.ts` | Platform System Store records plus direct prepare/start/stop calls. Creation selects a registered `kind: "app"` recipe and locks its exact version. Deletion persists resumable participant progress and removes the registry record only after all Project-owned resources are cleaned. |
| Runtime execution | `zelavis` Node adapter | A direct child-process driver owns trusted Project processes and per-Project directories. |
| Project storage | `zelavis` Node/Bun adapters | Project data is isolated below `.zelavis/projects/<id>/.zelavis`; official App data uses one persisted logical topology backed by four local physical SQLite shards by default. Platform state stays in the System Store. |
| App Data Fabric | `zelavis/app/db` | Versioned desired topology, observed placements, deterministic virtual ranges, single-writer route validation, and a composite tenant-routing driver are operational locally. Writer fence enforcement and durable topology operations remain future work. |
| Fabric | `src/core/fabric/index.ts` | Read-only inventory/endpoints plus deterministic capability-, pressure-, topology-, and capacity-aware Project replica placement planning. |
| Fabric integration | `src/index.ts` | Fabric placements are derived from Project runtime status and currently use generation `1`. |
| Project proxy | `src/index.ts` | Project API traffic requires an active scoped Fabric placement and eligible node, then forwards to `project.runtime.url`. |
| Dashboard access payload | `src/index.ts` | Demo owner/customer presentation data. It is not an authentication source. |

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

Every Zelavis App Project stores the exact recipe/runtime version selected at
creation. Registry changes and parent Platform upgrades preserve that lock.
The current Node child driver still loads code from the parent installation, so
it correctly advertises `independentRuntimeVersion: false`; immutable artifact
materialization and execution must turn the stored lock into a real runtime
boundary before older and newer Zelavis versions can run side by side.

### Delegated Project Platforms

The authority model intentionally permits a future Project to run scoped
Platform capabilities and manage multiple nested Apps or Projects. This
**Project Cell** starts and replicates through the same outer Project lifecycle
as an ordinary runtime. To the parent Fabric it is one placement group whose
nested state and workloads move together.

Delegation is asymmetric. The cell may schedule only inside its granted
allocation and may receive narrow provider capabilities explicitly. The parent
retains physical Node enrollment, root provider credentials, global placement,
routing, generation/fencing, and the authority to move or stop the whole cell.
This preserves a recursive Zelavis experience without creating competing root
control planes. Nested registry, routing, resource accounting, and migration
are not implemented yet.

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

The pure placement planner now defines how desired Project replicas are packed
on one worker or spread across several workers without changing execution
models when the topology changes. It refuses to multiply Projects whose driver
does not advertise stateless runtime replicas and reports unmet capacity
instead of overcommitting explicit resource envelopes. The resulting plan is
not yet authoritative or executable: persistence, generations, fencing, Agent
commands, health activation, and Gateway target sets remain required.

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

Project deletion already uses the durable shape future Agents need: a persisted
tombstone records the stable cleanup plan and completed participants, failed
steps remain retryable, and startup reconciliation resumes incomplete deletion.
The local participants remove Assistant threads, domain bindings, shared bundle
assets, and finally driver-owned runtime/project data. New Project-keyed
Platform stores must join that participant plan rather than relying on a broad
directory delete or leaving orphaned control-plane records.

## Migration order

1. Keep the canonical workload, authority, capability, resource, and placement contracts in `src/core` and its public `zelavis/*` subpaths.
2. Split universal Project descriptors from Project recipes and introduce a Project-driver registry.
3. Persist a stable Platform scope identity and authoritative local allocations/placements in the System Store.
4. Put the current Node child-process execution behind a local Zelavis Agent capability.
5. Change Project provisioning to `Project -> allocation -> placement -> Agent prepare/start -> health -> activation`.
6. Change the proxy into a Gateway resolver backed by placement plus Agent-reported healthy runtime targets.
7. Enforce system/project permissions on Project, Gateway, Agent, and Fabric endpoints with real principals.
8. Prove generation changes, fencing, durable migration state, rollback, and node draining on local/manual movement.
9. Connect the deterministic placement planner to remote Agents and durable reconciliation, then add stronger isolation drivers, provider capacity adapters, replication, and failover.
10. Add delegated Project Cells with nested resource accounting and whole-cell movement, without granting root fleet authority.
11. Make the official App Data Fabric route stable virtual shard ranges across
    several local SQLite files, with Tenant as the normal partition key and no
    directly exposed physical driver.
12. Prove shard-aware event cursors, local movement, generations/fencing,
    durable cutover, split/merge, and restore before remote data placement.
13. Connect those existing data placements to remote Agents, replicas, and
    failover without conflating App partitioning with root Project placement.
14. Add exceptional intra-Tenant subdivision only after the normal Tenant
    topology and ownership boundaries are operational.

At every stage, keep traffic balancing, placement, replication, and
infrastructure provisioning as separate capabilities.

The maintained implementation checklist for these stages lives in
[TODO.md](./TODO.md).
