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
- `packages/zelavis/adapters/*`
- `plugins/*` when an official optional provider or capability plugin consumes
  the unified package's public contracts

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
- Do not recreate separate `@zelavis/server`, `@zelavis/app`, or
  `@zelavis/core` packages. Their responsibilities are now public subpaths of
  `zelavis`.
- Ship first-party product surfaces as their own packages under
  `packages/zelavis/services/*` — `@zelavis/ui`, `@zelavis/marketplace`
  and `@zelavis/auth` today. A product service owns a face, never an authority:
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
- A capability names the service that owns it — `zelavis/auth:credentials`,
  `zelavis/auth:oauth`, `@acme/shop:payments` — not a bare domain. A domain
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
- Plugins and services are configured via `package.json` manifests (`"zelavis": { "kind": "plugin", "capabilities": [...] }`, `"type": "module"`, `"exports"`, no legacy `main` outside `frontend`). Plugin code uses the official Zelavis SDK (`zelavis.plugins.ui.menus.create`, `zelavis.routes.create`, `zelavis.services.add`); `defineService` is completely removed. See `website/src/content/docs/guides/plugin-api.md`.
- The SDK contributes during package registration, inside the loader's
  execution context. A service that needs the registry, a database, or
  platform resources is added from a `zelavis.setup` callback with `context.addService`
  instead. Both are official; which applies is decided by whether the service
  can be described before the runtime exists.
- Package menus are registered only with `zelavis.plugins.ui.menus.create`; the loader
  rejects exported `menu`/`menus` fields. Runtime `menus` is the full SDK list;
  `menu` is its primary catalogue entry, not another registration.
- The loader must carry everything a plugin declares. It once built its service
  object field by field and omitted `setup`, so a plugin registering its API
  there installed as a package with a menu and no endpoints while the same
  object composed in code worked — the supported path was the broken one.
- Keep the built-in Zelavis App stack in `packages/zelavis/src/app`, exported
  through `zelavis/app`, `zelavis/app/auth`, `zelavis/app/db`, and
  `zelavis/app/workloads`. It reuses the core implementation; never create an
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
  domain capabilities in `plugins/*`.
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
- Keep confidential architecture notes, evaluations, security reviews, and the
  implementation roadmap in the ignored `pnotes/` private repository. Never
  stage or publish them in the main repository; public checks must work without
  access to those notes.
- When available, keep `pnotes/TODO.md` current when core, runtime, App versioning, or
  Fabric work changes a capability from planned to prepared or operational.
- Keep `AGENTS.md` as the canonical durable instruction source; do not add
  project rules to `CLAUDE.md`.
- If durable Platform guidance changes, update this skill or a focused
  `.agents/references/*` resource so skill-loaded agents stay current.
- For `zelavis/app/db`, preserve the event-sourced per-collection-table model.
  Do not reintroduce a shared `documents` table, write directly to registered
  collection tables (including indirectly through raw SQL triggers), or bury
  `surface` in metadata.
- Serialize unrelated top-level transactions in synchronous SQLite adapters;
  a shared `inTransaction` boolean must never make concurrent callers join one
  transaction. Keep physical uniqueness constraints behind event revisions.
- Treat every component of a bundle storage key as an authority boundary.
  Validate Project/system ownership, service identity, bundle identity, prefix,
  and asset paths before composition; filesystem root containment is not enough.
- Treat local physical sharding as the official `zelavis/app` default, not a
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
- The public logical database boundary is `db.forTenant(tenantId)`. Documents,
  events, and time-series reads live on that Tenant handle; schema, projection,
  and time-series definitions remain logical database concerns. Do not restore
  implicit Tenant fields, `DatabaseApi.driver`, or logical `db.sql` aliases.
  Event continuation uses opaque `DatabaseEvent.cursor` values and `read({
  after })`; physical positions stay inside drivers and topology routing.
- Keep breaking public APIs clean, but treat persisted Project state as durable.
  Storage rewrites need explicit, idempotent, durably marked recovery that
  preserves the old source artifact and stops on ambiguous merges. Canonicalize
  retired official locks as stored-data migrations; never restore retired
  package aliases merely to make an old Project boot.

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
pnpm --filter zelavis test
pnpm --filter @zelavis/ui test
pnpm --filter @zelavis/ecommerce test
pnpm check
```
