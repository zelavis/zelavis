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
- [x] Provider-neutral deterministic runtime build profiles select Node, Bun,
  or future Deno without embedding deployment-provider assumptions.
- [x] Runtime artifacts carry validated SHA-256 object/file digests and optional
  signature metadata, with a Web-standard digest helper.
- [x] `ArtifactStore` is the first concrete provider capability, with immutable
  content-addressed retrieval semantics and an in-memory embeddable adapter.
- [x] Portable Ed25519 `signRuntimeArtifact`/`verifyRuntimeArtifactSignature`
  cover artifact signing over a canonical unsigned manifest, and the staged
  distribution tree emits a digest-complete `runtime-artifact.json` for every
  release target.
- [x] The Node adapter provides a persistent local `ArtifactStore` with
  content-derived paths, immutable first-write behavior, restart-safe metadata,
  read-time corruption detection, and no Project placement authority.
- [x] Provider-neutral capacity contracts provision and release Nodes through
  idempotent requests while keeping Project allocation and placement in Fabric.
- [x] Versioned provider definition and narrow capability negotiation contract.
- [x] Runtime-neutral workload identity, authority, resource, capability, and
  placement contracts.
- [x] Fabric snapshot and read-only inventory endpoints for the current
  single-node implementation.
- [x] The Gateway routes a Project's public paths to its running server
  frontend and keeps `/zelavis/*` with the Zelavis runtime. A frontend never
  receives a Platform authority envelope: it is third-party application code,
  and the envelope exists so a Zelavis runtime can enforce the caller's
  permissions. A frontend that is not yet running, or an ownership lookup that
  fails, falls back to the Project's own runtime rather than taking the site
  down.
- [x] A `server` frontend runs as a Project-owned runtime. The driver spawns
  the manifest's declared argv with a Platform-allocated port, treats the port
  accepting connections as readiness — an arbitrary frontend knows nothing
  about Zelavis, so no protocol handshake is available — reports a routable
  loopback URL, and surfaces the frontend's own stderr when it exits before
  binding. It reuses the Project environment allow-list and log bounds rather
  than a second copy.
- [x] A `frontend` marketplace category exists, and a listed frontend must
  carry it and depend on the Zelavis SDK — listing is a promise that the
  frontend integrates rather than only renders. A frontend that does neither is
  still installable; it simply cannot be listed.
- [x] Projects can own Projects. An owned Project is excluded from the
  Platform's project list, deleted with its owner through a durable cleanup
  participant, and its ownership survives a restart. Ownership, not a display
  rule, is the boundary: reconciliation still sees owned Projects, and nested
  ownership is refused until placement grouping exists.
- [x] Every installation answers at its root, and what it serves depends on
  which installation it is. An installation running the dashboard uses it as
  its default frontend, so `/` leads there; a Project runtime, which does not
  run the dashboard, serves the frontend placeholder until one is chosen.
  Neither shadows control-plane paths.
- [x] The Frontend contract exists: `kind: "frontend"` in the `package.json`
  `zelavis` namespace declares `static` or `server`. The runtime is declared,
  never inferred from a `start` script, because a `server` frontend spawns a
  process and a `static` one does not. Static frontends reuse the existing
  service `app` definition with its SPA/MPA modes and load without a JavaScript
  entry; bundle paths cannot escape the package; a `server` start command is
  argv rather than a shell string. Malformed frontends are refused at manifest
  validation rather than surfacing as a broken site.
- [x] The retired website content model is gone. A Project that has not chosen
  a frontend serves an explicit placeholder at its public paths instead of a
  404, while control-plane paths keep their own 404s. The placeholder is not a
  content model: a Frontend is a static site or an application with its own
  server, chosen from the marketplace.
- [x] Fabric inventory and placement-planning endpoints enforce distinct
  `fabric.view` and `fabric.manage` permissions by default; intentionally
  public embedded Fabric services require an explicit access opt-out.
- [x] The current privileged project/control route audit covers service-page
  assets, Website mutation, Storage list/mutation, Workloads management/logs,
  Project Gateway, Fabric, Auth administration, Assistant, services, and
  settings. Public website delivery, direct file delivery, health, Auth entry,
  and workload HTTP invocation remain explicit public data-plane routes.
- [x] Deterministic Project replica planning across one or many Nodes with
  capability gates, fixed/pressure-driven replica policy, driver and label
  constraints, topology spreading, and explicit resource-budget enforcement.
- [x] Project-scoped functions, jobs, schedules, and webhooks exist through
  `zelavis/app/workloads` on top of server contracts.
- [x] App Projects persist an exact `zelavis/app` recipe/runtime version and
  preserve it when the parent Platform registry or package version changes.
- [x] Every Project and exact App recipe lock persists an explicit
  `runtimeKind`/supported-runtime assignment. Historical records are repaired
  to their known `native` semantics, the configured driver publishes its
  available/default kinds, and creation rejects incompatible or unavailable
  kinds before claiming the Project ID. Docker is not advertised by this
  contract alone.
- [x] Deployment backends have host-supplied, backend-neutral capability and
  read-only detection definitions; the Platform persists native-default
  administrator policy, exposes permission-gated endpoints and a Server UI,
  blocks request-level backend selection, and never changes existing Project
  assignments when policy changes. Docker may be detected but cannot be
  enabled without a registered Project driver.
- [x] Host operations have a runtime-neutral manifest/request/executor contract
  and a Node executor foundation that requires an authority verifier, exact
  version and SHA-256 artifact match, declared bounded arguments, contained
  non-writable executable files, deadline/output limits, shell-free spawning,
  and idempotent operation IDs.
- [x] The official `zelavis/wordpress` App recipe creates native Dockerless
  WordPress Projects with a locked WordPress release, isolated files, generated
  credentials, and dedicated project-owned Nginx, PHP-FPM, and MariaDB
  instances, configuration, sockets, logs, and data. Debian packaging and
  authorized APT/Homebrew first-use provisioning install the host stack.
  Hosting-style dashboard navigation and local recipe routing leave room for a
  later OCI driver without changing the Project kind.
- [x] App Data Fabric topology contracts separate desired partitioning from
  observed placement, cover the complete deterministic hash space with stable
  virtual ranges, and enforce one active writer per physical shard.
- [x] The official Node and Bun App adapters persist one logical topology and
  route Tenant operations across four local physical SQLite shards by default.
- [x] The composite sharded database driver routes tenant-scoped documents,
  events, projections, and time series while applying logical schema changes
  across the bounded physical shard set.
- [x] Multi-shard regression coverage proves collection materialization,
  shard-bound opaque events, replicated logical schemas, built-in projections,
  and Tenant-routed time-series state across every default physical shard.
- [x] Logical database system views expose collections, events, schemas,
  projections, and time-series definitions without exposing physical shard
  drivers or `zv_*` tables. The dashboard renders those views read-only, and
  permission-gated Tenant backup/restore preserves exact schemas, event
  identity, revisions, and timestamps idempotently across shard routing.
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
- [x] Writer generations are durably fenced inside physical SQLite writes. A
  writer claims a generation before it may mutate a shard, every write
  transaction re-reads the fence, and a superseded writer is rejected by the
  shard itself rather than trusted to stand down. Fencing is an advertised
  driver capability, so the embedded single-process default stays unfenced.
- [x] Local SQLite App writes serialize competing top-level transactions and
  enforce unique collection/document stream revisions; raw SQL collection
  protection handles comments and CTEs and rejects statement batches.
- [x] Shared bundle storage validates every Project, service, bundle, prefix,
  and asset-path component, while local file storage separately enforces root
  containment.
- [x] Project Auth administration is permission-gated and the local Project
  Gateway supplies scoped Platform principal context to isolated runtimes.
- [x] Native-Web request authenticators compose with core principal resolution;
  opaque hashed sessions support Bearer and HttpOnly-cookie transport, Platform
  Auth persists through the System Store, App Auth persists through its Tenant
  database boundary, password hashing uses Web Crypto PBKDF2, and optional
  Basic, JWT, and remote-JWKS verifiers are available.
- [x] Session/device administration is endpoint-backed: accounts can list and
  revoke their own sessions, administrators can revoke one or all account
  sessions, and token hashes are never returned.
- [x] Authentication attempts have bounded window/block policies, durable
  Platform/App repository state, atomic cross-process/database mutation,
  privacy-safe security events, `429` retry guidance, and a permission-gated
  audit endpoint.
- [x] The System Store exposes atomic create-if-absent, compare-and-set, and
  compare-and-delete operations with strictly advancing CAS timestamps;
  first-owner bootstrap uses them for a durable leased claim that prevents
  competing Platform writers from creating multiple owners.
- [x] Credential recovery is provider-owned and endpoint-backed with generic
  start responses, explicit completion, and account-session revocation. The
  built-in email/username password plugins support expiring hashed one-time
  tokens through an operator-supplied delivery callback.
- [x] Provider-neutral Authorization Code login and explicit account linking
  are App Auth workflows with persisted one-time state, S256 PKCE, state/nonce
  binding, session issuance, and no implicit email linking. The OIDC plugin
  builds the standards-based authorization/token requests and verifies ID
  tokens through issuer, audience, algorithm, signature, JWKS, and nonce.
- [x] Platform first-owner bootstrap is guarded by an operator-supplied
  high-entropy one-time token and provider-owned credential enrollment. The
  dashboard performs real login/logout, `/runtime/access` returns the session
  principal instead of a demo identity, session rotation is endpoint-backed,
  only matching-origin browser requests receive session cookies, cookie
  mutations require a same-origin `Origin`, and critical Project, Assistant,
  service-mutation, and settings-mutation endpoints declare core permissions.
- [x] Retired the package-local auth plugin folder and the generic
  `childServices`/`extends` graph. Auth and payment providers are ordinary
  workspace plugins discovered by capability and registered through explicit
  domain contracts.
- [x] Plugins and services declare themselves through a validated `package.json`
  manifest (`"zelavis": { "kind": ... }`, ESM `type`/`exports`, no legacy
  `main`). `defineService` is removed; only the unrelated marketplace helpers
  `defineServiceCatalogEntry`/`defineServiceCatalog` remain.
- [x] Plugin code uses the official `zelavis/sdk` surface — `zelavis.menu`,
  `zelavis.routes`, `zelavis.commands`, `zelavis.events`, and
  `zelavis.services` — bound to an explicit plugin execution context that
  throws a descriptive error when called outside `loadPluginPackage`.
- [x] Route definitions carry typed operation specs and the runtime generates a
  valid OpenAPI 3.1 document for every mounted service, served from
  `/zelavis/api/v1/runtime/openapi.json`.
- [x] The runtime core stays filesystem-free: plugin manifest resolution is an
  injected `ZelavisServiceManifestResolver` that the local Node/Bun adapters
  install, and `api` is optional so `kind: "provider"` plugins can register
  through a domain contract without mounting routes.

## Prepared, Not Operational Yet

- [ ] Compatibility dates are carried by runtimes, artifacts, and providers,
  but no behavior gates have been introduced yet. Add gates only when behavior
  must change incompatibly.
- [ ] Artifact manifests, digests, and signing primitives exist and the staged
  release tree is digested, but no release is signed with a real key yet, there
  is no remote store, and immutable Project runtimes are not installed from
  artifacts.
- [ ] Provider definitions advertise capability APIs, but capability-specific
  contracts other than artifacts and capacity—DNS, networking, secrets, backups,
  and telemetry—still need to be specified independently.
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
- [ ] Official App local routing, topology persistence, and writer-generation
  fencing are operational, but local move/split/merge operations are not yet
  durable state machines.
- [ ] Docker has a centralized read-only backend adapter and detector but no
  installer, Project driver, secret provider, backup/restore contract, or
  durable migration state machine. Enabling Docker must remain separate from
  migrating Projects.
- [ ] The Agent now has stable identity, operation-bound signed authority,
  durable queued state, atomic leases, bounded concurrency, redacted audit
  events, replay-safe IDs, restart recovery, and read-only management
  endpoints. A separately supervised IPC service, release-signed manifests,
  process-group cancellation/reconciliation, and registered installation
  operations remain required.
- [ ] Native reports its current `process` isolation boundary honestly. Stable
  per-Project Unix identities, filesystem/PID/network namespace policy, cgroup
  v2 limits, systemd supervision, capability/seccomp/MAC confinement, quotas,
  and adversarial cross-Project tests are not operational.

## Next

- [ ] Execute `server` frontends. The contract accepts them and refuses to
  install them, because they need a supervised process and a routed target
  through the Project runtime and Gateway. Reuse the Agent/backend path rather
  than adding a second process supervisor.
- [ ] Forward a verified public domain to the Project that owns it. Routes
  already match on host inside a runtime, and the Gateway resolves a Project's
  target, but nothing yet accepts public traffic on a bound domain and forwards
  it. Until then a frontend is reachable through the authenticated Gateway
  rather than at its own domain.
- [ ] Acquire frontend packages. The runtime executes what is already on disk;
  npm, `npx create`, an uploaded archive, and Git sources each need an explicit
  trust policy through the existing service source settings.
- [ ] Place an owned Project with its owner. Fabric currently plans each Project
  independently, so an owned runtime could be placed away from the Project it
  serves. This is the Project Cell placement-group rule applied one level down.


- [ ] Prove local shard movement, split/merge, generation fencing, crash-safe
  cutover, and resumable durable operation state before remote data placement.
- [ ] Wire a release signing key into the staged distribution build so
  published runtime artifacts carry a verified signature, not only complete
  file digests.
- [ ] Materialize each Project's exact Zelavis App version as an immutable
  runtime artifact and have capable drivers execute that artifact independently
  of the parent Platform installation.
- [ ] Add remote `ArtifactStore` adapters for Agent retrieval and immutable
  Project runtime installation.
- [ ] Replace the current narrow native recipe router with the public
  capability-aware Project-driver registry described in `ARCHITECTURE.md`.
  Runtime assignment and recipe compatibility are now explicit, but leaf
  driver registration and resolution still need to be generalized.
- [ ] Implement the phased Docker/WordPress plan in
  `pnotes/ZELAVIS_DOCKER_IMPLEMENTATION_PLAN.md`: capability detection and the
  authenticated privileged executor first, then isolated Docker WordPress
  creation, then durable backup/cutover/rollback migration.
- [ ] Continue the reconciled native/backend plan in
  `pnotes/ZELAVIS_NATIVE_ISOLATION_AND_DEPLOYMENT_BACKENDS_PLAN.md`: build the
  separately supervised Agent transport and process supervisor, then harden
  the native backend before adding Docker Project execution and migration.
- [ ] Persist Platform identity, allocations, placements, and generations in
  the System Store.
- [ ] Put local Node child-process execution behind the Zelavis Agent command
  contract before adding remote Agents or other isolation drivers.
- [ ] Make the Gateway resolve authoritative placement plus Agent-reported
  healthy targets.
- [ ] Require real principal permissions on every Agent and provider control
  endpoint when those endpoints are introduced, and extend the route-audit
  tests with them.
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
