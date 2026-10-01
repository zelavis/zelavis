---
name: zelavis-core-platform
description: Use when changing the unified Zelavis package, its core runtime/Fabric, built-in App stack, or trusted product services, especially for authority boundaries, public API shape, and runtime-neutral architecture decisions.
---

# Zelavis Core Platform

Use this skill for changes in:

- `packages/zelavis/src/core`
- `packages/zelavis/src/app`
- `packages/zelavis/src/platform`
- `packages/zelavis/services/*`
- `packages/zelavis/src/adapters`
- `zelavis-services/*` when an officially maintained optional service (plugin,
  provider or Project recipe) consumes the unified package's public contracts

Start by reading `AGENTS.md` and the relevant `packages/zelavis` documentation
before editing.

## Working rules

- All bundled packages, including UI, load through `loadPluginPackage` using
  their `package.json` identity and static metadata. Exported metadata and raw
  `api` objects are rejected. Host options supply scope and package location.
- Use `register(configuration)` for per-load SDK declarations, `createAPI` or
  `operations.create` for APIs, `zelavis.setup` for runtime-dependent work, and
  `zelavis.frontend.configure` for static-frontend runtime shell/dev behavior.
  Do not restore a dashboard service factory or cache loaded product services
  globally to compensate for ESM module caching.

- Treat `new Zelavis(...)` as the public Platform entrypoint and the `zelavis`
  package as the one official framework/App Platform distribution.
- Do not recreate separate `@zelavis/server` or `@zelavis/core` packages, or a
  second copy of the built-in App stack. Their responsibilities are public
  subpaths of `zelavis`. (`@zelavis/app` is the official Project recipe package
  under `services/`, not a framework package.)
- Ship first-party product surfaces as their own packages under
  `packages/zelavis/services/*` — `@zelavis/ui`, `@zelavis/marketplace`,
  `@zelavis/auth` and the `@zelavis/app` Project recipe today. A product service owns a face, never an authority:
  `@zelavis/auth` is the settings page for core auth, and removing it costs the
  page rather than the ability to sign in. A product service is built the way a
  third-party one is: a `package.json` manifest declaring `zelavis.kind`, and a
  module that calls the official SDK. It is loaded through `loadPluginPackage`,
  the same loader an installed plugin goes through, so it exercises the public
  extension points rather than a private path into the Platform. If a
  first-party service needs a private path, the extension point is incomplete —
  extend the public contract instead of special-casing the service.
- Keep `packages/zelavis/src/core` product-neutral and runtime-neutral. It owns
  the contracts and implementations exported through `zelavis/core`,
  `zelavis/runtime`, `zelavis/fabric`, `zelavis/workload`,
  `zelavis/artifact`, and `zelavis/provider`.
- Do not create parent/child service graphs. Provider plugins are ordinary
  installed services discovered by capability and validated against an explicit
  public registration contract; never use `childServices` or service `extends`.
- A capability names the service that owns it — `zelavis/identity:credentials`,
  `zelavis/identity:oauth`, `@acme/shop:payments` — not a bare domain. A domain
  such as `provider:payments` says what a plugin implements and never whose
  contract it satisfies, so two plugins scanning for it collect each other's
  providers. An owner is recognised by containing a `/`; a bare word stays a
  Platform domain namespace. Naming an owner asks to be considered by it and
  grants nothing: discovery stays a flat scan and the owner still validates.
- Core names no capability owned by a product it does not ship. Core once
  listed `@zelavis/ecommerce:payments` in its capability hints and imported the
  plugin in its own tests, so the Platform could not test itself without
  building a shopping cart. Test core against a fixture, not a product.
- Do not switch features off in code. There is no `frontend: false`: an
  installation with no frontend is one with none installed, and the root path
  says so. A flag that expresses what a runtime *is* rather than a preference
  is named for that instead — `role: "platform" | "project"`.
- `coreServices` is gone. Platform subsystems are `subsystems` on
  `zelavis(...)` (auth, database, fabric, storage, workloads, site), frontend
  options are the public `frontend` option, and the settings store is
  `runtimeSettingsStore`. Passing `coreServices` is refused rather than
  ignored, because silently dropping it would leave a caller believing they
  had turned a subsystem off.
- The official service kinds are `app`, `frontend`, and `plugin`, enforced at
  manifest validation. Do not add a kind nothing branches on — that is how the
  union previously drifted to list five dead kinds while omitting `frontend`.
  Trust comes from `scope` (`system` for what the operator composed,
  `extension` for what was installed at runtime), never from the kind.
- Plugins and services are configured via `package.json` manifests (`"zelavis": { "kind": "plugin", "capabilities": [...] }`, `"type": "module"`, `"exports"`, no legacy `main` outside `frontend`). Plugin code uses the official Zelavis SDK (`zelavis.plugins.ui.menus.create`, `zelavis.routes.create`); `defineService` is completely removed. See `website/src/content/docs/guides/plugin-api.md`.
- The SDK contributes during package registration, inside the loader's
  execution context. A service that needs the registry, a database, or
  platform resources mounts an endpoint group from a `zelavis.setup` callback
  with `context.addEndpointGroup` instead. A package never creates other
  services: one package, one identity.
- Native Platform subsystems (Server Control Plane, Identity, Database, Fabric)
  mount as endpoint groups and are advertised as runtime `capabilities`; the
  service inventory lists loadable packages only. Bundled packages come from the
  distribution `services/*` folder through the same loader as installed ones.
- Package menus are registered only with `zelavis.plugins.ui.menus.create`; the loader
  rejects exported `menu`/`menus` fields. Runtime `menus` is the full SDK list;
  `menu` is its primary catalogue entry, not another registration.
- The loader must carry everything a plugin declares. It once built its service
  object field by field and omitted `setup`, so a plugin registering its API
  there installed as a package with a menu and no endpoints while the same
  object composed in code worked — the supported path was the broken one.
- Keep the built-in Zelavis App stack in `packages/zelavis/src/app`, exported
  through `zelavis/app`, `zelavis/app/identity`, and `zelavis/app/workloads`
  (the database is `zelavis/db`). It reuses the core implementation; never create an
  App-private dispatcher or server contracts.
- Use **Project recipe** as the canonical name for a versioned create-project
  definition. A service with `kind: "app"` is a Project recipe; its optional
  Project metadata declares runtime compatibility. The official kinds are
  `app`, `frontend`, and `plugin`, and the union is enforced at manifest
  validation — do not add a kind that nothing branches on. Trust comes from
  `scope` (`system` for what the operator composed, `extension` for what was
  installed at runtime), never from the kind.
- Keep trusted Platform product behavior in `packages/zelavis/src/platform`
  and dashboard rendering in `@zelavis/ui`. Core must not own Zelavis product
  menus or root Platform policy.
- Put framework or host behavior in `adapters/*`; put optional provider or
  domain capabilities in `zelavis-services/*`.
- Treat complete native installation removal as a host-local lifecycle
  capability: the runtime-neutral contract belongs in core, concrete removal
  belongs in the host adapter/distribution, and the packaged CLI is the
  operator surface. It intentionally has no HTTP/dashboard equivalent because
  it deletes the Platform, Agent, authority material, and all Project data.
  Require a dry run and exact acknowledgement; remove only provably
  installer-owned resources and retain shared host/operator state. When an
  installer starts owning a new resource, update the uninstall inventory,
  staged script, destructive-path tests, and docs together.
- Native release installation has the same host-local boundary. Archive
  installers and Debian `postinst` call `zelavis install --from-release` with
  the release's private Node. Keep planning in core runtime, host effects in
  adapters, unit/configuration templates in the release tree, and pins/checksums
  in distribution staging. Default native units to `127.0.0.1`; `--public` is
  the explicit all-interface opt-in. Package acquisition and create use the
  matching verified prebuilt release and the same plan. Create takes no folder
  argument. Its sudo bootstrap fetches and verifies a private root-owned release;
  never execute user package-cache files as root. User mode owns only its
  `~/.local/share/zelavis` prefix and command link. Runtime checksum helpers
  have one distribution source; shipped copies are generated at build time.
  Install/removal take an exclusive prefix lock and share the Node/Bun Platform
  data ownership guard; never bypass live data or port conflicts with `--force`.
  Current receipts carry source, entry, version, mode, selected instance, port
  and Edge ownership. Named system instances share immutable releases but own
  separate current/receipt/runtime descriptors, data/config/accounts/ports/units.
  Only default may own host Edge, enforced by a persistent record and kernel
  reservation; secondary instances run with Edge off. Removing an instance retains
  shared releases/commands/templates/package/APT state until the last receipt is
  removed. Doctor remains read-only and host-local.
- Keep first-run setup as a presentation over the one durable first-owner
  bootstrap capability. `zelavis setup`, scripted `zelavis bootstrap`, and the
  dashboard `/setup` route must call the same endpoint and must not introduce
  separate completion state or owner-creation authority.
- Keep Zelavis runtime targets to self-hosted Node.js, Bun, and future Deno; do
  not make serverless function platforms the core runtime model.
- Keep the canonical hierarchy explicit: the root Platform scales Projects,
  Projects scale Apps or Tenants, and exceptional Tenants may later scale
  Shards. Project, App, Tenant, and Principal/User are distinct boundaries.
- Every Zelavis App Project locks an exact Zelavis recipe/runtime version.
  Updating the parent Platform must not silently upgrade or rewrite child
  Project locks. A driver may claim independent-version execution only after
  it can materialize and run the locked artifact.
- Keep one root Platform Fabric. It owns physical Nodes, provider authority,
  Project allocation, placement, routing, generation/fencing, and fleet policy.
  Authenticated Zelavis Agents execute its decisions; runtime drivers are
  Agent execution implementations.
- Prepare for a future delegated Project Platform (Project Cell): a Project
  may run scoped Platform capabilities and manage nested Apps/Projects inside
  its allocation. The parent still places and moves the entire cell and its
  descendants as one isolation/placement group. Promotion never implicitly
  grants root provider credentials or unconstrained fleet authority.
- Keep Project lifecycle behind capability-aware runtime-driver and Agent
  contracts. The local Node process driver is Platform-owned and stops children
  during `Zelavis.close()`; production worker Agents should be separately
  supervised.
- Project/service grants require exact route scopes and cannot authorize
  unscoped routes. Unscoped/system grants match runtime-wide routes; top-level
  permissions span scopes. Signed Gateway audiences confine concrete local
  permissions to a child runtime; Project grants never imply Platform host-code
  installation authority. Preserve this boundary across JS, HTTP, and CLI.
- Keep deployment backend adapters centralized under `src/backends/<id>` with
  one shared registry/policy contract. Native, Docker, and future backend logic
  must not be scattered as Platform or Node-adapter special cases. Keep signed
  authority, durable leases, audit state, and privileged execution in the
  shared Agent subsystem rather than duplicating queues or command runners per
  backend.
- Centralized backend policy/capability/intent stays in `src/backends`, while
  concrete host filesystem/process/socket/native/command/virtualization work
  belongs behind runtime/Agent bindings in `src/adapters`. Share implementations
  only for supported APIs or use injected host interfaces; `_shared.ts` currently
  imports Node APIs. Runtime-neutral domain logic remains in core/App/Platform,
  and browser SDK imports cannot reach host implementations. Firecracker requires
  Linux/KVM and is a conditional host dependency; Windows/macOS native paths
  need separate qualification. The intended adapter flow automatically provisions
  pinned, verified dependencies through the authorized Agent and selects
  Firecracker when the adopted profile requires it on a qualified Linux host.
  Check usable KVM, permissions, compatible guest images and confinement, not OS
  alone. Provisioning/selection remain planned until implemented. Required microVM
  intent rejects unavailable hosts; VM/WSL labels alone do not establish usable
  KVM or authorize a downgrade. Preserve explicit intent and Project locks.
- `zelavis/backends` stays free of `node:` imports (enforced by
  `test/backends-host-boundary.test.mjs`); detection uses injected
  `ZelavisBackendHostProbes` from `src/adapters/_node-backend-host.ts`.
  ID-only lifecycle dispatch refuses a missing/malformed stored assignment;
  only the Project manager's explicit stored-record repair may fill one in.
- Recipe isolation intent (`zelavis.project.isolation`, `src/project-isolation.ts`)
  is validated at package load, locked with the recipe version, and assessed
  against advertised backend capability. `required` shortfalls refuse create,
  start and restart (409); never downgrade. Only creation may select another
  enabled, healthy, executable backend that satisfies it; never move existing Projects.
  Only `available` satisfies; advertised capability is not enforcement proof.
- Gate authoritative file-storage access by declared coordination scope and a
  successful session probe. Local replacement remains process-local. Registry
  mutations use observed revisions, bounded fresh-read retries of intent, and
  no unconditional fallback. System Store CAS must atomically compare the
  optional observed value as well as its timestamp when supplied.
- Treat Project deletion as a durable lifecycle operation. Persist its
  tombstone, stop execution, run stable idempotent cleanup participants, remove
  runtime data last, and delete the registry record only after all participants
  succeed. Failed deletion must remain retryable and resume during
  reconciliation. Every new Project-keyed Platform resource must register a
  cleanup participant.
- Reconcile desired-running Projects asynchronously with bounded concurrency.
  Never use an unbounded fleet-wide `Promise.all`, and do not make Platform
  readiness wait for every Project runtime.
- Keep traffic balancing, authoritative placement, replication, and
  infrastructure provisioning separate. A runtime URL is an Agent-reported
  target, not placement authority.
- Keep Zelavis Edge proxy-neutral. Domains, canonical routes, endpoint
  generations, certificates and cutover state are Platform authority in the
  System Store; Traefik, Caddy, Nginx and external load balancers are execution
  adapters whose configuration is generated output. A proxy switch must be a
  durable preflight/stage/verify/shift/drain/commit workflow with rollback, and
  apps plus certificates must survive it. Refuse required capability loss;
  mark proxy-specific extensions non-portable and let them block an automatic
  switch rather than silently dropping behavior. Keep certificate private keys
  out of logs and audit records, and do not claim safe switching before its
  reconciliation and failure tests pass.
- Treat the first-run Platform hostname as authenticated Edge onboarding after
  the one-time owner claim. Accept apex or subdomain hostnames, allow provider
  automation to preseed one, and offer managed HTTPS, external TLS, or defer.
  “Verify DNS & enable HTTPS” must verify routing before ACME and remain
  retryable without reopening/rolling back owner bootstrap. Keep child-app
  domains separate and prefer per-instance certificates over sharing one
  wildcard key across a provider fleet. Do not add wizard-only hostname/TLS
  authority; JS, HTTP, CLI and UI must consume the same Edge operations.
- Keep Fabric replica policy independent of Node count and runtime-driver mode.
  Spare capacity alone must not create replicas, and drivers without stateless
  replica capability remain single-replica.
- Let optional provider plugins connect external deployment, storage, DNS,
  CDN, email, images, or hosting services without defining Zelavis itself.
- Prefer tightening exports over broad `export *` surfaces.
- Preserve the service model; do not invent a parallel composition pattern.
- Everything Zelavis can do must be reachable through a stable capability and
  versioned endpoint. The dashboard is a client, not the authority layer.
- Every official public capability must have matching JS SDK, HTTP, and CLI
  operations. Inspect and update all three when changing a core API; a missing
  surface is a gap, not a completed feature. Share operation schemas and domain
  logic, including permissions, errors, defaults, ownership, and lifecycle.
  Service-owned APIs use `zelavis.plugins.<namespace>.<resource>.<action>`,
  `/api/v1/plugins/<namespace>/<resource>`, and
  `zelavis plugins <namespace> <resource> <action>`, including official UI and
  third-party services. Require an explicit validated `zelavis.namespace` in
  executable package manifests and templates; reject runtime collisions and
  exported namespace overrides. No singular `plugin` or root aliases. Core
  Platform capabilities retain their domain namespaces. Provide
  discoverable SDK/CLI operations and machine-readable CLI output, not just a
  generic request escape hatch. Package-loading declarations also need parity
  through declarative data or artifact references with equivalent ownership
  and cleanup. Test adapter equivalence and document all three forms together.
  See AGENTS.md's "JS, HTTP, and CLI parity" rule for the full contract.
- Do not implement Platform behavior only in UI routes, framework server
  actions, local component state, or dashboard-only helpers.
- Keep confidential notes, decisions and the implementation roadmap in the single
  file `pnotes/TODO.md` of the ignored `pnotes/` private repository. Never stage
  or publish it in the main repository; public checks must work without access
  to it.
- When available, keep `pnotes/TODO.md` current when core, runtime, App versioning, or
  Fabric work changes a capability from planned to prepared or operational.
- Keep `AGENTS.md` as the canonical durable instruction source; there is no
  `CLAUDE.md`, so do not add one.
- If durable Platform guidance changes, update this skill or a focused
  `.agents/references/*` resource so skill-loaded agents stay current.
- For `zelavis/db`, preserve the event-sourced per-collection-table model.
  Do not reintroduce a shared `documents` table, write directly to registered
  collection tables (including indirectly through raw SQL triggers), or bury
  `surface` in metadata.
- Serialize unrelated top-level transactions in synchronous SQLite adapters;
  a shared `inTransaction` boolean must never make concurrent callers join one
  transaction. Keep physical uniqueness constraints behind event revisions.
- Treat every component of a bundle storage key as an authority boundary.
  Validate Project/system ownership, service identity, bundle identity, prefix,
  and asset paths before composition; filesystem root containment is not enough.
- Treat local physical sharding as the official `@zelavis/app` default, not a
  future multi-node migration. A new official App routes stable virtual shard
  ranges across several SQLite files even when all placements share one Node.
  Keep the low-level one-shard topology available only as the collapsed form of
  the same router-backed architecture for embedding and focused tests.
- Every ordered-KV store batch atomically checks generation, fresh writer
  session and the revision observed before dependent reads, then advances the
  revision. Include replication, allocator, maintenance and format writes;
  acquire generations conditionally and refuse exhaustion. Reject unsupported
  coordination rather than using read-then-write fencing. RocksDB exclusive-file
  mode does not support concurrent process takeover. Use LMDB's abortable child
  transactions for batches; queued transaction callbacks can retain partial
  writes on failure. Widen existing generation metadata without rewriting events
  or cursors, and retain current ownership metadata during recovery.
- Never expose a physical database driver, filename, or one-file global event
  sequence as the normal App data API. Bind ordinary data access to an explicit
  logical Tenant, keep cross-shard semantics explicit, and require current
  writer generations even for colocated local placements.
- For remote App shard placement, follow the request/grant authority contract
  in `../../references/two-fabrics-placement-contract.md`. Internal admission
  persists a conditional reservation only. A future committed grant and Agent
  validation are required for activation and writes. Do not extend the
  Project-local `PartitionMap` into physical Node authority.
- Project runtime ownership uses the Platform System Store CAS record in
  `src/platform/project-placement-authority.ts`. The Project manager must
  acquire it before start; the Agent process lease supervisor fences local
  workloads on a foreign/missing/expired record. Remote Project start is
  implemented: signed destination-bound single-use dispatch and a signed lease
  feed (`src/core/agent/project-dispatch.ts`, `remote-placement.ts`), a
  pinned-CA HTTPS worker (`src/adapters/_project-dispatch-https.ts`,
  `_remote-project-agent.ts`) with durable replay protection and
  fence-before-takeover, and digest-verified install-once artifact preparation
  (`_remote-project-snapshot.ts`). Read a request body only after its authority
  verifies, and never snapshot a Project that already has local runtime data.
  Still unproven: multi-host partition drills and Bun as the Agent runtime;
  remote App shard movement is not operational.
- The public logical database boundary is `db.forTenant(tenantId)`. Documents,
  events, and time-series reads live on that Tenant handle; schema, projection,
  and time-series definitions remain logical database concerns. Do not restore
  implicit Tenant fields, `DatabaseApi.driver`, or logical `db.sql` aliases.
  Event continuation uses opaque `DatabaseEvent.cursor` values and `read({
  after })`; physical positions stay inside drivers and topology routing.
- Pre-release means no compatibility: do not write migrations, aliases or
  fallbacks for data an earlier build wrote, and never restore a retired package
  or recipe name to make an old Project boot. Development Projects that predate
  a change are deleted and recreated. A Project that cannot be prepared must fail
  at prepare with its reason, never start and crash later.

Host-operation validation must retain an immutable snapshot of request fields
and arguments across asynchronous authorization/journal work, require own
manifest argument declarations, enforce protocol and manifest bounds, and
revalidate the deadline immediately before execution. The Node executor must
re-prove artifact/parent inode identity at execution, spawn a private copy of
the verified bytes rather than the registered path, and kill the operation's
process group at the deadline and when its leader exits. Host operations are
installed only with Ed25519 release-signed manifests verified against the
operator trust store; scripts name their interpreter inside the signature.
On Linux, use `cgroup-v2` supervision (a new session escapes a process group)
and never fall back from it silently. This does not substitute for pinned
shared libraries or destination fencing.

Agent authority is Ed25519: only the Platform holds the private key, Agents
trust its public file, and envelopes bind the exact arguments
(`argumentsDigest`). The Platform issues authority only through the host
operation broker, for installed operations whose release-signed manifest names
the permission and scope, after recording an audit entry; there is no general
command runner. Agents reach operations only over their local socket.
Operation output is journaled only when the signed manifest declares a bounded
JSON `result`; submissions are rate limited per actor, and audit reads never
return argument values.
Service setup hooks have a deadline; an abandoned setup cannot add services.

Plugin discovery is the ETag-revisioned `/runtime/plugin-operations`
catalogue: clients revalidate every call and never cache past revocation.
Package admission may only run concurrently or enforce a deadline when the
plugin context storage propagates async context; an abandoned package's
context is sealed. Recipe `isolation.resources` limits and required intent may
select another enabled, healthy, executable backend at creation only.

## Admin Agent

The Assistant's authority rules (caller's authority checked at execution,
audited, approvals as a second gate, untrusted model and data, per-scope
providers, Project chats confined to their Project) are in AGENTS.md's
Endpoint-Backed Capability section. Code lives in `src/assistant*.ts`; read them
before adding a tool, and give every tool an `access` requirement, an operator
`describe` label, and a test. A tool that changes anything must declare
`mutation` so it becomes an approval request.

## Design checklist

1. Start from the public API and authority boundary.
2. Decide whether the change belongs in core, App, Platform product behavior,
   an adapter, or a plugin.
3. Define the domain capability before the transport or dashboard surface.
4. Expose dashboard operations through versioned service endpoints.
5. Keep defaults ergonomic and authority explicit.
6. Update the nearest public README and, when available, private `pnotes/TODO.md` when behavior changes. Keep confidential design details out of the public README.
7. Add or update focused tests in `packages/zelavis/test`.

## Validation

Run the smallest useful checks first, then broaden as needed:

```bash
pnpm run verify              # from the repository root; the check that counts
pnpm --filter zelavis test
pnpm --filter @zelavis/ui test
pnpm --filter @zelavis/ecommerce test
pnpm run docs:check
```
