# Zelavis Core and Fabric Roadmap

This file tracks the product-neutral backend framework and Fabric foundation.
It distinguishes working contracts from prepared boundaries and future work so
an exported type is never mistaken for an operational distributed feature.

## Done

- [x] Web-standard `fetch(request)` runtime surface.
- [x] Adapter-neutral dispatch and plain object-in/object-out surfaces.
- [x] Node HTTP adapter; Bun and other fetch-native hosts can call `fetch`
  directly.
- [x] Service definitions, nested composition, endpoint resolution, and
  route-level access requirements.
- [x] Typed server lifecycle hooks for start, request, response, error, and
  close.
- [x] Explicit server plugins with ordered setup and reverse-order cleanup.
- [x] Idempotent `runtime.close()` for server-plugin shutdown.
- [x] Strict `YYYY-MM-DD` compatibility-date validation and runtime exposure.
- [x] Versioned, validated portable runtime artifact manifest contract.
- [x] Versioned provider definition and narrow capability negotiation contract.
- [x] Runtime-neutral workload identity, authority, resource, capability, and
  placement contracts.
- [x] Fabric snapshot and read-only inventory endpoints for the current
  single-node implementation.
- [x] Deterministic Project replica planning across one or many Nodes with
  capability gates, fixed/pressure-driven replica policy, driver and label
  constraints, topology spreading, and explicit resource-budget enforcement.
- [x] Project-scoped functions, jobs, schedules, and webhooks exist through
  `zelavis/app/workloads` on top of server contracts.
- [x] App Projects persist an exact `zelavis/app` recipe/runtime version and
  preserve it when the parent Platform registry or package version changes.
- [x] App Data Fabric topology contracts separate desired partitioning from
  observed placement, cover the complete deterministic hash space with stable
  virtual ranges, and enforce one active writer per physical shard.
- [x] The official Node and Bun App adapters persist one logical topology and
  route Tenant operations across four local physical SQLite shards by default.
- [x] The composite sharded database driver routes tenant-scoped documents,
  events, projections, and time series while applying logical schema changes
  across the bounded physical shard set.
- [x] The logical `DatabaseApi` binds ordinary access through
  `db.forTenant(tenantId)`, keeps physical drivers and raw SQL out of the App
  API, requires Tenant identity at HTTP boundaries, and exposes versioned
  opaque event cursors that the topology router binds to a virtual shard.
- [x] Local App startup repairs the retired official `@zelavis/app` lock,
  durably and idempotently replays a pre-topology single-file event log into
  Tenant shards, preserves the old file as a recovery artifact, and reports a
  useful stderr cause when a child process fails before readiness.
- [x] Project deletion is a persisted, resumable cleanup lifecycle. It stops
  the runtime, removes Assistant threads, domain bindings, bundle assets, and
  runtime/project data through idempotent participants, and deletes the Project
  record only after every participant succeeds.

## Prepared, Not Operational Yet

- [ ] Compatibility dates are carried by runtimes, artifacts, and providers,
  but no behavior gates have been introduced yet. Add gates only when behavior
  must change incompatibly.
- [ ] Artifact manifests describe deterministic bundle contents, but
  `zelavis/core` does not yet build, hash, sign, upload, or install them.
- [ ] Provider definitions advertise capability APIs, but capability-specific
  contracts such as capacity, DNS, networking, artifacts, secrets, backups,
  and telemetry still need to be specified independently.
- [ ] Lifecycle hooks are in-process framework hooks. Durable deployment and
  Agent events must come from persisted Fabric operations, not process hooks.
- [ ] Workloads are discoverable through service endpoints, but durable queues,
  distributed execution, retries, leases, and scheduler ownership remain open.
- [ ] Replica planning is operational as a pure Fabric decision, but plans are
  not yet persisted/fenced or executed by Agents and the Gateway does not yet
  balance across Agent-reported replica targets.
- [ ] Exact App version locks are persisted, but the local Node driver still
  executes the parent-installed Zelavis code and therefore advertises
  `independentRuntimeVersion: false`. Artifact installation must make the lock
  executable before side-by-side old and new App runtimes are operational.
- [ ] The authority and placement model can represent a future delegated
  Project Platform/Project Cell, but nested registries, resource accounting,
  routing, reconciliation, and whole-cell movement are not implemented.
- [ ] Official App local routing and topology persistence are operational, but
  writer generations are not yet enforced inside physical SQLite writes and
  local move/split/merge operations are not yet durable state machines.

## Next

- [ ] Make schemas, collection materialization, events, projections, time
  series, dashboard system views, backup, and restore operate correctly across
  the local physical shards.
- [ ] Prove local shard movement, split/merge, generation fencing, crash-safe
  cutover, and resumable durable operation state before remote data placement.
- [ ] Define a deterministic build-profile contract that selects the Node,
  Bun, or future Deno runtime without introducing provider assumptions.
- [ ] Add artifact digests and optional signature metadata, then connect the
  manifest to the common staged release/distribution tree.
- [ ] Materialize each Project's exact Zelavis App version as an immutable
  runtime artifact and have capable drivers execute that artifact independently
  of the parent Platform installation.
- [ ] Define `ArtifactStore` as the first concrete provider capability because
  both local and remote Agents need immutable artifact retrieval.
- [ ] Define capacity provisioning separately from placement. Providers create
  or release Nodes; Fabric alone decides Project placement.
- [ ] Split universal Project descriptors from Project recipes and add the
  Project-driver registry described in `ARCHITECTURE.md`.
- [ ] Persist Platform identity, allocations, placements, and generations in
  the System Store.
- [ ] Put local Node child-process execution behind the Zelavis Agent command
  contract before adding remote Agents or other isolation drivers.
- [ ] Make the Gateway resolve authoritative placement plus Agent-reported
  healthy targets.
- [ ] Enforce real principal permissions on every Project, Agent, Gateway, and
  Fabric control endpoint.
- [ ] Add provider implementations as optional adapters or plugins rather than
  dependencies of the core implementation.

## Later

- [ ] Remote, separately supervised Zelavis Agents.
- [ ] Bounded durable reconciliation, leases, fencing, retries, and node drain.
- [ ] OCI and stronger runtime-isolation drivers after the Agent boundary works.
- [ ] Connect automated replica placement to durable reconciliation, balancing,
  migration, recovery, and provider-backed capacity scaling.
- [ ] Replication and failover with explicit single-writer ownership semantics.
- [ ] Remote Tenant/shard placement and exceptional intra-Tenant subdivision
  after the local multi-shard topology, Project authority, and Agent boundary
  are operational.
- [ ] Delegated Project Platforms/Project Cells that can own nested Apps or
  Projects inside a granted envelope while the parent places and moves the
  complete cell as one group.

## Deliberate Non-Goals

- Provider-specific serverless presets as the core execution model.
- A single all-powerful `CloudProvider` interface.
- Provider-controlled placement or routing policy.
- Filesystem route or plugin scanning in the runtime core. Optional developer
  tooling may compile conventions into explicit service and plugin inputs.
- A second storage/database model that competes with the Platform System Store
  or `zelavis/app/db`.
