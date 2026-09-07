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
| Project Recipe | A versioned create-project definition and runtime entrypoint represented by a service with `kind: "app"`, such as Zelavis App or WordPress. Marketplace apps and starters are user-facing recipe categories. |
| Plugin | A service with `kind: "plugin"` that extends the Platform or a Project runtime. It is not a create-project option. Trusted plugins are distinguished by `scope: "system"`, not by their kind. |
| Frontend | A service with `kind: "frontend"`: the face of an installation or a Project, declaring a `zelavis.frontend` block with a `static` or `server` runtime. |
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
| Project registry/provisioning | `src/project.ts` | Platform System Store records plus direct prepare/start/stop calls. Creation selects a registered `kind: "app"` recipe, locks its exact version and supported runtime kinds, and persists an explicit Project runtime assignment. Historical records repair to their known native semantics. Deletion persists resumable participant progress and removes the registry record only after all Project-owned resources are cleaned. |
| Runtime execution | `zelavis` Node adapter | The configured driver advertises only the runtime kinds it can execute. Current local recipe routing is explicitly native: Zelavis Apps run as Node child processes and WordPress through dedicated native Nginx, PHP-FPM, and MariaDB instances with per-Project configuration, sockets, ports, logs, files, and data. The Debian distribution installs the native stack; authorized local installs can provision it through APT or Homebrew. Docker is not currently available. |
| Deployment backend policy | `src/backends` | A central adapter registry owns the shared contract and the built-in `native/` and `docker/` implementations. The System Store persists administrator policy and read-only observations. A backend cannot be enabled/default unless it is healthy and has a registered Project driver. |
| Agent operations | `zelavis/agent` plus `zelavis/core` contracts | A stable Agent identity, operation-bound HMAC authority, durable journal, atomic leases, bounded execution, restart recovery, redacted audit summaries, and permission-gated read endpoints are implemented. The Node executor still runs in-process when explicitly assembled; separately supervised IPC, release-signed scripts, cancellation/process-group supervision, and registered installation operations remain. |
| Project storage | `zelavis` Node/Bun adapters | Project data is isolated below `.zelavis/projects/<id>/.zelavis`; official App data uses one persisted logical topology backed by four local physical SQLite shards by default. Platform state stays in the System Store. |
| App Data Fabric | `zelavis/app/db` | Versioned desired topology, observed placements, deterministic virtual ranges, single-writer route validation, and a composite tenant-routing driver are operational locally. Writer fence enforcement and durable topology operations remain future work. |
| Multi-model object store | `zelavis/dbnew` | A separate store from `zelavis/app/db`, not mounted by any Project recipe. One payload is projected through document, column, measure, and graph lenses over a shared partition-local identifier space, with its own event log, writer generations, and bitmap postings. Its relationship to the App Data Fabric is an open decision. |
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
services. Runtime assignment is now explicit and persisted separately from the
Project/App kind, and exact recipe locks declare compatible runtime kinds.
Creation validates the assignment against both the recipe and configured
driver before it claims an ID; there is no native/Docker fallback. The local
adapter still performs narrow recipe-to-driver routing for Zelavis App and
WordPress, so the next Project model must finish separating:

- universal Project identity, kind, desired state, authority, and resource envelope
- a Project kind/recipe such as Zelavis App, WordPress, static, or generic
- a capability-aware runtime driver registry resolving the explicit assignment
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

Backend selection is administrator policy for new Projects, not an ordinary
Project-creation choice. Each Project retains its explicit stored assignment,
so changing the default never migrates existing workloads. Runtime/backend IDs
are validated slugs rather than a Docker-shaped closed enum, leaving Podman,
system containers, and microVM implementations possible without pretending
they have identical capabilities.

The current native backend is still a trusted-code process boundary, not a
CloudLinux/CageFS-equivalent security boundary. Owner-only directories and
separate processes do not protect two compromised workloads sharing one Unix
identity. Production native isolation requires stable per-Project identities,
filesystem/PID views, cgroup v2 resource limits, capability removal, syscall/
MAC policy where supported, complete-cgroup lifecycle, and a separately
supervised Agent. Capability reporting keeps those features `planned` until
they are applied and tested.

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

Creation still performs `prepare -> start` directly. The durable Agent operation
contract now exists, but Project lifecycle is not routed through it and there
is no scheduler, allocation record, supervised IPC service, health gate, or
placement activation transaction. The next replacement should connect the
local Project drivers to a separately supervised Agent using this same journal
and authority contract. Docker and remote execution must wait until that
boundary is proven.

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

### Multi-model object store

`zelavis/dbnew` is a document, column, measure, and graph store in which a
payload is written once and projected through index lenses that hold only
pointers back to a shared, partition-local identifier space. Because every lens
addresses the same space, a predicate spanning several data models is one set
intersection rather than an exchange between separate engines. A design study
measured the alternative: three specialist stores must move roughly 1,363
identifiers between themselves for every row such a query returns, a ratio that
held across a fivefold change in scale. The lenses cost 1.79x the payload in
derived storage over the same range.

Several of its properties were chosen to match the canonical topology rather
than to be retrofitted into it later. Locality is declared, so everything
sharing a partition key is guaranteed to live together and Tenant is the natural
partition key. Identifiers are dense and partition-local, and global identity is
the pair, so a single-partition deployment is a placement fact rather than an
architectural commitment. The event log is the source of truth and the natural
replication stream, cursors are opaque and carry their partition so no physical
position can be mistaken for a logical global order, and opening a partition
claims a writer generation that fences the previous holder even when both sit on
one Node.

What this does not yet settle is how it relates to `zelavis/app/db`, and that
decision should be made before either grows a dependency on the other. Three
shapes are open: `dbnew` becomes a storage engine beneath the existing
document API while `app/db` keeps the topology router; it becomes a second
app-facing capability for the workloads a document model serves poorly, such as
search, traversal, and aggregation; or it eventually supersedes `app/db`. The
current implementation commits to none of them, and no migration step below
depends on it.

Before any official recipe could mount it, it must route through the topology
rather than expose a physical driver, and it needs a cross-partition
scatter/gather contract, snapshots — rebuilding currently replays all history
rather than live objects — and durability testing, since `synchronous=NORMAL`
is configured rather than proven. Postings are also still stored one row per
posting; holding them as bitmap blobs would remove the scan that now dominates
a wide query, but requires immutable segments and compaction.

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
