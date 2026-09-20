# AGENTS.md

## Project Vision

Zelavis is a unified, self-hostable App Platform. It replaces — and combines — several categories of tools that teams currently stitch together separately:

| Inspiration | What Zelavis covers |
|---|---|
| Firebase / Supabase | Backend-as-a-service: auth, database, real-time, self-hostable |
| Vitess (for MySQL) | SQL-database-agnostic query routing, replication, and sharding — not tied to one engine |
| WordPress | Content management: content types, entries, schemas, media |
| cPanel / Plesk / Coolify / Dokploy / deploy providers | Server, app, local website hosting, and optional external deploy management |
| phpMyAdmin | Database administration UI (collections, tables, queries, events) |
| Workers / Functions platforms | Project-scoped workloads: functions, jobs, schedules, and webhooks hosted by the long-running Zelavis runtime |
| Claude / Codex chat | AI chat area built into the dashboard for interacting with Zelavis and building via AI |
| Linear / Jira *(roadmap)* | Project planning: issues, tickets, roadmaps, and cycles scoped to a Zelavis Project |
| Notion / Figma multiplayer *(roadmap)* | Real-time collaboration: presence, shared editing, and comments across dashboard and Project surfaces |

Rows marked *(roadmap)* are committed product direction, not shipped behavior. Planning and
real-time collaboration complete the lifecycle the product positioning claims — plan, build, and
manage in one self-hosted platform — and self-hosting a team's tickets, roadmap, and discussion is
a stronger ownership claim than self-hosting a database alone. No implementation exists yet. Do not
describe either as available in docs, README, dashboard, or marketing copy until it ships, and keep
them out of `pnotes/TODO.md`, which tracks core, App-versioning, and Fabric capabilities
rather than product scope.

The difference from Firebase/Supabase is depth and ownership: Zelavis is fully self-hostable, runtime-neutral, and built to scale beyond a single database engine. The database layer is the deepest differentiator — `zelavis/db` is a multi-model object store (event-sourced, tenant-aware, one payload projected through document, column, measure, and graph lenses) on a swappable storage engine. SQLite, libSQL, RocksDB and LMDB drivers ship today, all over the same store logic through an ordered key-value interface. Official Zelavis Apps are locally physically sharded from creation: one logical App database routes stable virtual shard ranges across several SQLite files even when every placement is on one Node. Tenant placement, replication, failover, shard movement, and exceptional Tenant subdivision build on that same topology instead of introducing a second distributed architecture later. The event log is the natural replication stream and `tenant_id` is the normal first partition key. That is the same role Vitess plays for MySQL, but Zelavis is not coupled to any single SQL engine. Replicas do not imply multiple writable owners; multi-writer consistency requires a separate explicit data specification.

Zelavis should be able to host websites itself on user-controlled infrastructure. Managed deployment providers may be optional targets through plugins, but they are not the default hosting model and must not replace native Zelavis website hosting.

## Product Positioning

The canonical public tagline is:

> **Zelavis — The App Platform.**
> Plan, build, and manage apps together, from first ticket to production.

The headline claims the whole application lifecycle, which is what earns the definite article;
the subline names the span of that lifecycle, which is the claim no single competing tool covers.
Keep these surfaces consistent with it and with each other when any one of them changes:

- `README.md` headline.
- `website/astro.config.mjs` Starlight `description`.
- `website/src/content/docs/index.mdx` frontmatter `description` and intro line.

The tagline stays deployment-neutral on purpose. Managed Zelavis on zelavis.com is a first-class
offering alongside self-hosting, so headline and tagline copy must not lead with self-hosting,
ownership, or "your own infrastructure": that framing reads as DIY-only and quietly excludes the
managed product. Self-hostability remains a core architectural constraint and a capability worth
stating plainly in body copy, feature sections, and installation docs. It is simply not the
headline claim, and it should not be reintroduced into one.

The tagline is deliberately ahead of shipped features, so body copy carries the accuracy load:
headlines may claim the direction, but feature lists, docs, and dashboard copy must still mark
planning and collaboration as roadmap.

Dashboard/product structure:

- `/zelavis` is the Projects overview, not a single project dashboard.
- Zelavis-native project pages live under `/zelavis/projects/:projectId/*`.
- Managed app projects such as WordPress/static/generic projects may use hosting-style controls instead of Zelavis-native Auth/Database/Content navigation.
- `/zelavis/marketplace` is global for Project recipes (presented as apps and
  starters), templates, and server provider plugins.
- `/zelavis/projects/:projectId/marketplace` is project-local for Zelavis plugins and services.
- `/zelavis/server/*` owns server-level concerns such as domains, backups, and logs.

Core platform work centers on the unified `zelavis` package and its public
subpaths: `zelavis/core`, `zelavis/runtime`, `zelavis/fabric`, `zelavis/app`,
`zelavis/db`, `zelavis/app/auth`, and `zelavis/app/workloads`. The dashboard
remains the focused `@zelavis/ui` package bundled by `zelavis`.

The repo still contains domain packages such as `@zelavis/ecommerce`, but they are optional layers on top of the platform primitives, not the main product definition.

## Agent Instruction Source Of Truth

`AGENTS.md` is the canonical instruction file for coding agents in this repo.
Do not add new project rules, architecture notes, or workflow instructions to
`CLAUDE.md`. If an agent finds something worth preserving from `CLAUDE.md`,
move or summarize it here instead.

It is technically acceptable for `CLAUDE.md` to become a short pointer to
`AGENTS.md`. Until that migration happens, treat `CLAUDE.md` as legacy context
only. If a requested change would add or update `CLAUDE.md`, stop and notify
the developer that the content belongs in `AGENTS.md`.

Keep the `.agents/` folder in sync with this file. When adding or changing
durable guidance that affects a specific agent workflow, update the relevant
`.agents/skills/*/SKILL.md` file or add a focused reference under
`.agents/references/` so skill-loaded agents receive the same current guidance.

`.claude/` is Claude-specific tool configuration, not a second instruction
system. It may contain Claude settings, local permissions, worktree state, or
symlinks that point Claude at `.agents/skills/*` and `.agents/references`.
Do not duplicate instructions or skill content into `.claude/`. If a Claude
integration needs access to repo-maintained guidance, point it at `AGENTS.md`
or symlink/read from `.agents/`; keep the maintained source in `AGENTS.md` and
`.agents/`. The tracked Claude session-start hook should keep those symlinks
current automatically.

## Platform And App Service Boundary

- **Zelavis Platform OS** is the `zelavis` package: the official framework and
  App Platform distribution, long-running control plane, dashboard, project
  registry, server management, System Store, service registry, and lifecycle
  orchestration.
- **Zelavis App** is the official Firebase/Supabase-style project stack made
  from app-facing database, auth, storage, and workload services. It is an
  official Project recipe implemented as a `kind: "app"` service in
  `packages/zelavis/services/zelavis-app` (`@zelavis/app`), bundled and shipped
  with the Platform OS release at the same version.
- **Project recipes** are the versioned create-project definitions and runtime
  entrypoints behind Marketplace apps and starters. They are services with
  `kind: "app"`; optional Project recipe metadata declares runtime
  compatibility.
  Every Project locks its exact recipe/runtime version (`{ name, version, specifier }`),
  so a newer parent Platform can keep running older Projects without silently
  rewriting them. Project recipes own setup/provisioning behavior, default
  files, menu metadata, and the runtime services mounted in the created
  Project.
- **Multi-Version Recipe Support**: The Platform must architecturally support
  multiple installed/available versions of any Project recipe (e.g. 50 distinct
  WordPress versions, multiple Laravel or Drupal versions, or historical and
  newer `@zelavis/app` versions). While the Platform distribution always ships
  with the current `@zelavis/app` version built-in under `packages/zelavis/services/zelavis-app`,
  operators and projects can install and lock alternative recipe versions via
  marketplaces. Runtime drivers execute the exact version locked in the
  Project's runtime database.
- **Frontends (The WordPress Theme Analogy)**: Services with `kind: "frontend"`
  are the visual "face" of an installation or a Project, functioning exactly
  like themes and templates do in WordPress, but for headless, modern web apps.
  - The Platform itself uses `@zelavis/ui` (`kind: "frontend"`) as its face (the dashboard).
  - A blog project uses the `zelavis/app` recipe for backend infrastructure + a Blog Frontend theme (`kind: "frontend"`).
  - An ecommerce project uses `zelavis/app` + `@zelavis/ecommerce` plugin + a Storefront theme (`kind: "frontend"`).
  - Swapping a frontend (e.g. from an Astro blog to a Next.js blog) leaves all project data, auth accounts, and schemas untouched.
- **Standardized Nested Child Marketplaces**: The marketplace architecture is
  strictly hierarchical and standardized across CLI, REST API, and UI for all
  three service kinds (`app`, `plugin`, `frontend`):
  - **Root Platform Marketplace** (`/zelavis/marketplace`): Platform-level Project recipes (`kind: "app"` starters/apps), server provider plugins, and control plane themes.
  - **Project Child Marketplace** (`/zelavis/projects/:projectId/marketplace`): Project-scoped plugins (`kind: "plugin"` e.g. ecommerce, payment gateways, custom auth) and themes/storefronts (`kind: "frontend"`).
  - A uniform command structure (`zelavis marketplace search|install|list`) and uniform REST API routes operate across both scopes.
- **Plugins** use `kind: "plugin"` and extend the Platform or a Project
  runtime. Auth, Database, Workloads, Fabric, UI, and Marketplace are plugins
  the operator composed rather than a separate kind: what makes them trusted is
  `scope: "system"`, not a label. A plugin is not a Project recipe and does not
  appear in the create-project selector merely because it is built in.
- There is no `core` kind, and no `web-app`, `website`, `dashboard-extension`,
  `provider`, or `template`. Each described who shipped a service or restated a
  capability, and nothing ever branched on them. A provider is discovered by
  its capability, and that capability names the service it extends
  (`zelavis/auth:credentials`, `@acme/shop:payments`) rather than a bare domain
  two plugins could both scan for.
- **System Services** are trusted Platform OS capabilities. Do not call every
  bundled project service a core service.
- **System Store** is Platform OS persistence. Local adapters default to
  `.zelavis/system/zelavis.sqlite`. It must stay separate from `zelavis/db`
  project databases and must never appear in a project's Database UI.
- Fresh installations have one bootstrap state and one first-owner authority.
  The interactive `zelavis setup` CLI and the `@zelavis/ui` `/setup` route are
  presentations over the existing `/auth/bootstrap` capability; do not add a
  second setup flag, owner-creation path, or frontend-only authority. While
  bootstrap is required, the dashboard redirects every first visit to the
  setup wizard. Once the durable owner claim succeeds, setup stays closed and
  the normal authenticated dashboard/login flow owns subsequent visits.
- The Platform process does not mount an app-facing `zelavis/db` service by
  default. Each Zelavis App project owns its logical database below
  `.zelavis/projects/<projectId>/.zelavis/data`; the official recipe maps its
  virtual shard ranges across several physical SQLite shard files even on one
  Node. Project-private topology and runtime metadata stays separate at
  `.zelavis/projects/<projectId>/.zelavis/runtime/zelavis.sqlite`.
- Project routes and grants always require a real project ID. Never introduce
  an implicit `default` project or fall back from a project API request to the
  Platform runtime.
- `zelavis/core`, `zelavis/runtime`, `zelavis/fabric`, `zelavis/workload`,
  `zelavis/artifact`, and `zelavis/provider` are public subpaths of the one
  package. Their implementation lives under `packages/zelavis/src/core` and is
  the reusable, product-neutral foundation for both the privileged Platform and
  scoped Zelavis Apps. Hosting business logic stays in the Platform layer; App
  business logic stays inside the Project.
- Trusted product-specific control-plane services live under
  `packages/zelavis/src/platform`. First-party product surfaces are their own
  packages under `packages/zelavis/services/*`: `@zelavis/ui` owns
  dashboard delivery, `@zelavis/marketplace` owns the marketplace, and
  `@zelavis/auth` owns the auth settings dashboard page and provider catalogue.
  These internal services assemble the public core primitives into the Zelavis
  product and are not separate public framework brands.
- **Core Subsystems vs. Services**: Foundational capabilities built into the
  Platform OS — Identity & Permissions, Database engine, Fabric scheduler,
  and Server Control Plane — are **Platform Subsystems**, not "services".
  They are core platform primitives providing native runtime APIs (`runtime.auth`,
  `runtime.database`, authenticators, and core routes), not pseudo-plugins
  disguised with `kind: "plugin"` in `runtime.services`. "Services" is a concept
  strictly reserved for loadable components: first-party services in
  `packages/zelavis/services/*`, domain plugins in `plugins/*`, Project recipes,
  and external extensions.
- **Service Dashboard Pages**: `pageAssets` is obsolete and removed. All service
  dashboard pages and static assets stream directly from disk via `packageDir`
  (resolved from `dashboard/` or package root) with classic 90s webspace
  semantics. Inlined asset string maps are not supported.

`zelavis/core` owns the generic service definition, loading, composition,
endpoint, and contribution transport contracts. Product services may define
namespaced extension points on top of that mechanism. Only statically trusted
product/core services may introduce a new extension-point schema or privileged
manifest capability; ordinary services and marketplace extensions may
contribute values to an allowed extension point after validation.

Do not reintroduce `childServices`, service `extends`, parent-maintained plugin
name allow-lists, or hidden child setup contexts. Auth methods, payment
providers, and similar integrations are ordinary installed plugins discovered
by a declared capability and validated against the owning domain's explicit
public registration contract. Plugins may also expose their own endpoint-backed
capabilities as normal services.

Bundled product packages, including `@zelavis/ui`, use the same manifest and
SDK registration path as installed packages. Static identity, capabilities,
Marketplace and Project recipe metadata belong only in `package.json`.
`loadPluginPackage` rejects exported metadata and raw `api` objects. Trust
(`scope`) and package location come from host loading options, never exports.
Use a package `register(configuration)` hook for per-load SDK declarations,
`zelavis.createAPI`/`zelavis.operations.create` for APIs, and `zelavis.setup`
for runtime-dependent setup. Static frontends attach runtime shell/dev behavior
through `zelavis.frontend.configure`; do not revive a parallel UI service factory.
The register hook runs for every load despite ESM caching, so do not cache a
first-party service globally to preserve module-evaluation side effects.

Dashboard menu semantics belong to `@zelavis/ui`: it defines what a menu
contribution means and renders it. `zelavis/core` may carry runtime-neutral
menu/contribution wire data so headless Project runtimes do not need to bundle
the dashboard. Services are configured through the `package.json` `zelavis`
namespace; the retired `zelavis.service.json` sidecar is no longer read. Do not
let services add arbitrary top-level keys to that namespace; use a stable
namespaced contribution map when the generic extension-point mechanism is
introduced.

The Platform OS can create multiple Zelavis App Projects from the official
`zelavis/app` Project recipe. The default Node adapter prepares each Project
under `.zelavis/projects/<id>`, locks the exact Zelavis App recipe/runtime
version, and runs it in a separate Node process. A parent Platform update must
never rewrite that lock. The current local Node driver still executes the
parent-installed code and therefore does not yet advertise independent-version
execution; artifact materialization must make the version lock operational.
This is operational isolation for trusted Project code, not a hostile-code
security sandbox. Project lifecycle code must stay behind the runtime-driver
contract so rootless OCI containers and stronger isolation can replace it later.
Do not run app project services directly inside the Platform process; the
Platform dashboard must communicate with project runtimes through the Project
Gateway boundary. The current proxy route is the first local implementation of
that boundary.

Project deletion is a durable Platform lifecycle operation, not a direct
filesystem shortcut. Persist a deletion tombstone before cleanup, stop the
runtime, run stable idempotent cleanup participants, remove runtime/project data
last, and delete the Project registry record only after every participant has
completed. Failed deletion remains visible and retryable, and reconciliation
must resume it after restart without rerunning durably completed participants.
Any new Platform resource keyed by Project identity must register a cleanup
participant; deleting a Project must not leave Assistant threads, domain
bindings, bundle assets, project-private databases, logs, locks, or runtime
metadata behind.

The canonical hierarchy is: Platform scales Projects, Projects scale Tenants,
and exceptional Tenants may eventually scale Shards. Project is the universal
first-level workload and hard isolation boundary for Zelavis Apps, WordPress,
static sites, generic applications, and future managed kinds. Tenant is an
App-owned logical data/workload boundary. Principal/User is an authenticated
identity and is not interchangeable with either Project or Tenant.

Treat the Platform OS as the control plane and project runtimes as the data
plane. A unified product does not require both planes to share one failure
domain. The Platform Fabric is the one privileged hosting authority: it owns
physical nodes, Project allocation, placement, routing, generation/fencing,
and fleet policy. A Zelavis App may reuse workload primitives only within its
Project authority and granted resource envelope. A child knows its parent but
never becomes its parent.

A future Project may be promoted into a **delegated Project Platform**, also
called a Project Cell. It may use the same Zelavis engine to manage multiple
nested Apps or Projects within its allocation, but it remains scoped by the
parent. The parent Fabric places and moves the whole cell, including its nested
workloads, as one isolation and placement group. Promotion must not implicitly
grant root provider credentials, physical Node authority, or an unconstrained
resource envelope. This is a prepared architecture direction, not current
operational nested scheduling.

Fabric decides globally and authenticated Zelavis Agents execute locally.
Runtime drivers such as Node process, Bun, OCI, VM, or dedicated host are Agent
execution implementations, not competing schedulers. The built-in Node process
driver is the development and small single-host mode: the Platform process owns
its children, reconciles desired state with bounded concurrency, and stops them
when `Zelavis.close()` runs. Production worker Agents must be supervised
separately so customer runtimes survive control-plane restarts while remaining
subject to the one logical Platform authority.

Never restore all desired-running projects with an unbounded `Promise.all` or
make control-plane readiness wait for an entire fleet to start. Reconciliation
must be bounded, asynchronous, idempotent, and safe to retry. Distributed
drivers will also need leases or fencing, durable work queues, health-based
placement, and paginated project discovery; do not stretch the in-process Node
child map into the Zelavis Cloud scheduler.

Deployment backend adapters are centralized under
`packages/zelavis/src/backends/<backend-id>`. The shared registry/policy
contract lives alongside them; built-in native, Docker, and future Podman,
Incus, nspawn, or microVM implementations must not be scattered through the
Platform service or hidden as special cases inside the Node adapter. Backend
adapters declare capability and backend-specific operations. Signed authority,
durable leases, audit state, reconciliation, and privileged execution belong to
the shared Zelavis Agent subsystem, not to separate ad-hoc queues or general
command runners in each backend.

Keep concrete host filesystem, process, socket, native-library, command and
virtualization implementations behind runtime/Agent bindings in
`packages/zelavis/src/adapters`. Share implementations across Node, Bun and other
runtimes only where APIs are supported, or inject explicit host operations.
`_shared.ts` currently imports Node APIs and is not universally portable.
Runtime-neutral policy and domain logic remain in backends/core/App/Platform;
browser SDK imports must never reach host implementations.

Firecracker is a conditional Linux/KVM execution dependency, not a universal
Zelavis development dependency. Windows/macOS trusted native development and
Linux Firecracker execution can be supported by the same runtime adapter through
distinct backend implementations; each path needs platform qualification. If
Firecracker is adopted, the intended flow is automatic, idempotent dependency
provisioning through the authorized Agent/runtime adapter and profile-aware
selection on qualified Linux hosts. Verify usable KVM, permissions, compatible
verified artifacts/guest images and confinement rather than checking OS alone.
Do not override explicit isolation/backend intent or silently downgrade required
microVM execution. This provisioning flow remains planned until implemented.

Recipe isolation intent (`zelavis.project.isolation`) is locked with the recipe
version and compared with the assigned backend's advertised capabilities. A
`required` shortfall selects another enabled, healthy backend at creation or
refuses; it refuses start and restart; `advisory` is only
reported. Unknown intent keys are refused, never ignored. Advertised capability
is a claim to be proven by conformance, not enforcement evidence.
`zelavis/backends` must not import `node:` modules; host probes are injected.

Keep traffic balancing, placement, replication, and infrastructure
provisioning as separate capabilities. A placement is authoritative; a runtime
URL is only an Agent-reported route target. Replicas do not imply multiple
writable owners. Provider adapters supply capacity but never define Zelavis.

**Zelavis Edge** is the proxy-neutral Platform ingress control plane, not a
serverless runtime and not another scheduler. Domains, canonical HTTP/TCP/UDP
route intent, endpoint generations, certificate identity/material, rollout
state, and audit history are Platform authority persisted through the System
Store; they never belong to a Project database or to a reverse proxy's private
configuration. Traefik, Caddy, Nginx and external/cloud load balancers are
replaceable execution adapters. Their configuration is compiled output, never
the source of truth, and they must not independently reinterpret Fabric
placement.

Switching an Edge adapter is a durable, reversible migration. Preflight every
active route against the destination's declared capabilities, refuse required
semantic loss, render and validate shadow configuration, stage certificates and
targets, health-check the candidate, shift traffic, drain the former adapter,
and retain rollback state until the cutover is committed. Apps, domains, route
identity, and certificates survive the switch. Proxy-specific extensions must
be explicitly namespaced and marked non-portable; an incompatible extension
blocks automatic migration rather than being ignored. Certificate private keys
are protected Platform secrets, never proxy-owned authority or audit/log data.
Do not describe safe Edge switching or distributed certificate automation as
operational until those reconciliation and failure-path tests pass.

First-run onboarding includes an optional **Platform hostname** step for the
dashboard/API address. Use hostname terminology: `s1.host.com`,
`panel.example.com`, and the apex `example.com` are all valid fully qualified
hostnames; “full domain” is not a separate mode. Hosting/provider automation may
preseed a per-instance hostname, while independent operators may enter either
an apex or subdomain. Never infer authority from reverse DNS. Offer
Zelavis-managed HTTPS (recommended), externally terminated TLS, or configure
later. The managed action is “Verify DNS & enable HTTPS,” not “secure the
server”: it verifies routing/reachability before ACME and secures the public
Platform ingress, not the whole host.

Hostname/TLS setup is a resumable authenticated Edge operation after the
durable first-owner claim, not extra authority hidden in `/auth/bootstrap` and
not one transaction with account creation. A DNS/ACME failure leaves the owner
claim complete and the installation reachable through its local recovery path;
the dashboard shows the incomplete production-readiness action until retry.
CLI, HTTP/SDK and dashboard onboarding use the same Edge operations. Do not add
a hostname form to either wizard until that authority exists. Child-app domains
remain separate Edge resources, and provider fleets should prefer distinct
per-instance certificates rather than distributing one wildcard private key to
every server.

An object store that carries a lease, a fence, or an authoritative publication
must pass `probeFileStorageGuarantees` first, and every such write must be
conditional (`ifAbsent` or `ifMatch`). An "S3-compatible" label proves nothing:
some stores accept the conditional headers and ignore them. A backend that
cannot enforce a condition refuses the write; it never performs it
unconditionally.

Authoritative file-backed registry access must pass the scope-aware storage
guarantee gate. Local file replacement is process-local; a sequential probe
does not qualify it for shared-process or distributed authority. Registry
mutations carry the observed revision (including absence), re-read and reapply
intent on bounded conflicts, and never retry a stale whole snapshot. System
Store adapters must atomically enforce `expectedValue` when supplied to CAS.

Every official `zelavis/app` Project uses the App Data Fabric topology from
creation. A single-node App still routes Tenant data through a versioned
partition map containing many virtual shard ranges and several physical SQLite
shards; the placements merely happen to share one Node. `zelavis/db` may
support a one-shard topology as an embeddable low-level instance, but the
official App recipe must not bypass the topology router or expose a physical
driver as its application API. Scaling out changes shard placement, replicas,
or range grouping rather than introducing sharding for the first time.

The App Data Fabric owns Tenant partitioning and logical data semantics inside
the Project envelope. The root Platform Fabric remains the only physical Node
and placement authority. Ordinary Tenant operations are shard-local and may be
atomic there; cross-shard operations require an explicit distributed workflow,
projection, scatter/gather contract, or compensation. Event cursors and
projection checkpoints must be shard-aware and must not treat one physical
SQLite autoincrement sequence as a logical global order. Only the current
writer generation may accept a write, including when stale and current
placements are colocated on one Node.

Breaking pre-release API changes do not require compatibility aliases, but
persisted Project data must remain recoverable. The local App adapter performs
a one-time, durably marked migration from the retired single-file App database
into the shard topology, leaves the source file untouched as a recovery
artifact, and refuses ambiguous merges when both layouts contain unrelated
data. Retired official package locks may be canonicalized as a data migration;
do not reintroduce the retired package or public import alias.

The public logical database boundary is `db.forTenant(tenantId)`. Documents,
events, and time-series reads live on that Tenant handle; schema, projection,
and time-series definitions remain logical database concerns. Do not restore
implicit Tenant fields, `DatabaseApi.driver`, or logical `db.sql` aliases.
Event continuation uses opaque `DatabaseEvent.cursor` values and
`events.read({ after })`; physical positions stay inside drivers and topology
routing.

Fabric replica policy must remain topology-independent. Plan the same Project
replicas whether one or many worker Nodes are available: colocate eligible
replicas on one Node when necessary and spread them when capacity appears,
without switching runtime-driver modes. Spare Node capacity does not create
demand by itself. Scale only from explicit fixed intent or Project-level load,
within declared capability and resource limits. Projects whose runtime driver
does not advertise stateless runtime replicas remain single-replica.

There is exactly one Zelavis dashboard application: `@zelavis/ui`, mounted by
the Platform OS. Isolated Zelavis App project runtimes must not mount or serve
another dashboard bundle. They expose capabilities, runtime metadata, and service menus
through `zelavis/core`; the Platform dashboard proxies those endpoints and
renders the selected project's navigation under `/zelavis/projects/:projectId`.

## Effect Version & Vendored Source (@repos/effect)

- Use **Effect v4** instead of Effect v3.
- The authoritative Effect v4 codebase is vendored locally under `repos/effect/`.
- When writing or refactoring Effect code (Schema, Services, Layer, HttpApi, Stream, Context):
  - Check `repos/effect/LLMS.md` first for official Effect v4 rules and patterns.
  - Review `repos/effect/packages/effect/SCHEMA.md` and `repos/effect/packages/effect/HTTPAPI.md` for dedicated sub-module guidance.
  - Inspect `repos/effect/packages/effect/src/` and `repos/effect/packages/effect/test/` for real implementations, types, and test patterns instead of guessing or using v3 habits.
- **Vendored repo usage rules**:
  - Treat `repos/effect/` strictly as **read-only reference material**.
  - **Never import from `repos/effect/`** in application code; always import from official package dependencies (e.g. `import { Schema } from "effect"`).
  - Do not edit files under `repos/effect/` unless explicitly asked.

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

## High-Level Principles

- Prefer extensible architecture, service contracts, and provider boundaries over framework-specific shortcuts.
- Keep the core self-hostable and replaceable.
- Favor explicit contracts over hidden magic.
- Keep core platform concerns split cleanly across auth, data, transport, and UI.
- Avoid app-specific assumptions in shared packages.
- Favor composition and adapters over inheritance.
- Do not introduce heavy dependencies without a clear reason.
- Keep future replication and explicit consistency models possible: prefer deterministic event application, explicit idempotency, stable node identity, tenant-aware boundaries, ownership generations, and adapter-neutral replication contracts over hidden single-node assumptions. Do not imply multi-writer behavior merely because replicas exist.

## Database Architecture Rules

`zelavis/db` is the database. A payload is written once and projected through
document, column, measure, and graph lenses that hold only pointers back to a
shared, partition-local identifier space, so a predicate spanning several data
models is one set intersection rather than an exchange between engines. Its
event log is the source of truth for writes and the replication stream.

Key rules:

- Writes go through the documents API. There is no raw SQL surface and one must
  not be reintroduced: it was the last way to reach storage without the
  guarantees the documents API exists to provide. Being the only door is also
  where the at-most-once guard lives: a write may carry an `idempotencyKey`, and
  its receipt is written in the same transaction as the change, so there is no
  moment where the write has happened and the key has not been noted.
- Storage is an ordered key-value engine. Lenses are key ranges, a posting is a
  key with no value, and a transaction is one atomic batch with reads overlaying
  it. An engine implements `get`, `scan`, `write` and `close`; nothing above it
  knows which engine it is. SQLite (default), libSQL, RocksDB and LMDB ship today; all but SQLite are optional peer dependencies, selected with `engine` when a database is opened. SQLite is the default because it is the only one needing no native build; LMDB is fastest while the working set fits in memory, and RocksDB stores roughly six times more per byte and barely slows when it does not.
- Append to the log before projecting into the lenses. A crash must leave an
  event whose projection can be replayed, never a lens row with no event behind
  it. `rebuildLenses` re-derives every lens from the log alone and is the check
  that this holds.
- Ordered KV store commits must atomically check writer generation, session,
  and the revision observed before dependent reads. Advance the revision with
  every protected batch, including replication, allocation, maintenance and
  format upgrades. Generation acquisition is conditional and never wraps.
  Reject unsupported coordination; do not emulate shared-writer fencing with
  a read followed by an unconditional write. RocksDB's exclusive-file mode
  is local single-process ownership, not concurrent takeover. LMDB batches use
  abortable child transactions: queued transaction callbacks alone can commit
  earlier mutations when the callback throws. Keep current ownership metadata
  through recovery; restoring an old authority snapshot requires a separate
  disaster-recovery protocol.
- A store admits one writer at a time. Every store write reads state and
  writes it back changed, so two in flight on an asynchronous engine read the
  same value and one is lost. Reads take no permit. Nothing holding the permit
  may call another store write, or it waits on itself.
- Document values, and anything a query compares or orders, use one order: the
  ordered lens's (`compareOrderedValues` in `db/keys.ts`) — booleans, then
  numbers, then strings by code point, then null. Never `localeCompare` or any
  other host order for them, including when sorting in memory: a result sorted
  in memory must match the same result read from an index, on every host.
- A posting is a key in the live tier or a bit in a sealed blob, and a read is
  the union of both minus the tombstones. Blobs are immutable: `db.maintenance`
  seals the live postings into segments of 65536 identifiers, and anything
  removed afterwards leaves a tombstone rather than editing one. So a removal
  path must go through the store's own helpers — deleting a posting key
  directly leaves whatever a blob still claims. Sealing merges rather than
  rebuilds, touching only the segments a live posting or tombstone falls in, so
  the blobs accumulate across seals; `reindexLenses` is what re-derives them
  from the manifests when that accumulation needs checking. After its first
  full sweep a seal reads only the groups marked dirty since, and the same
  helpers write those marks — a posting written around them is never sealed
  until the next reindex.
- A composite index is a column of the ordered lens whose value is the
  document's tuple, encoded by `orderedTuple` so that string order is tuple
  order; the store knows nothing of it. A document write reads its collection's
  indexes inside its transaction, and a backfill reads each document inside the
  transaction that rewrites it. Both then run under the store's one writer,
  which is the only thing keeping a write from missing an index created
  alongside it and a backfill from overwriting a newer write: never move either
  read out of the transaction.
- A document write checks what it depends on — the id, the version, a
  precondition, a unique value, a check, a reference — inside the transaction
  that writes it (`transactChecked` in `documents.ts`), never before it: only
  there does the store's one writer keep the answer true until the write
  lands, and a failure there discards the whole batch. Reads inside a
  transaction see committed state, not the transaction's own writes, so a
  change that writes one record twice builds the second write from the first
  (as `releaseReferences` and `linkTargets` do), never from a second read.
- A read that joins two collections answers the named collection's query first
  and turns the ids it returns into an equality union over the referencing
  field's own postings (`relatedFilters` in `documents.ts`), so a join stays a
  set operation over the one dense identifier space. Never read the
  referencing collection and filter it in memory, and never let a reference
  the collection does not declare pass as a clause matching everything or
  nothing: that is `UnknownReference`.
- A change that writes more than once in one transaction — a batch, a delete
  cascading or clearing what names it — threads one `Pending` overlay and
  reads every document, id and unique value through it. A transaction sees
  committed state, so a second write built on a fresh read undoes the first,
  and two writes each pass a check the other already answered. Atomicity stops
  at one tenant, which is one shard: there is no cross-shard write, and a
  scatter reads.
- A scan that stops early passes `limit` to `engine.scan` rather than cutting
  the stream with `Stream.take`. A stream pulls an iterable thousands of
  entries at a time, so a take of a few rows still reads thousands; the limit
  is what lets an engine stop at the source. Every engine honours it, and
  `test/db-kv-engines.test.mjs` holds each to the same answers.
- One transaction is one batch, and that is the whole durability story: a
  killed process loses no commit that returned, a write-ahead log truncated by
  a power cut costs a suffix rather than leaving holes, and an interrupted
  maintenance pass is a state the reader already handles rather than damage to
  repair. `test/db-durability.test.mjs` holds the store to all three by killing
  real processes; anything that makes a write span two batches breaks it.
- The log is the source of truth up to the compaction point, not forever.
  Payloads, manifests and identities are the snapshot, so `db.maintenance`
  compacts by truncating the log — after which storage tracks live objects
  rather than every write ever taken. Anything reading history must therefore
  handle being cut off rather than assume it can reach the beginning: an old
  cursor fails with `CursorCompacted`, `rebuildLenses` refuses with
  `LogCompacted`, and the state-reading equivalents (`reindexLenses` for
  postings, a state-derived export for backups) are what still work.
- A partition map carries routing and no data, so changing where an occupied
  range points is a relocation, not a map edit. `db.movement` copies the records
  unfenced, catches the copy up from the source log, fences writes only for the
  last catch-up, and moves routing last; every step is recorded so an
  interrupted one resumes. Routing is one record for every tenant in a
  rebalance, so it moves once, after all of them are copied — applying it while
  one was still uncopied would route a tenant to a shard that does not hold it.
  `topology.update` still refuses an occupied range; `topology.update` still refuses an occupied range. Routing is read
  from the topology on every call — never cached from the map a handle opened
  with, which would go on reading the shard the records left.
- Crossing partitions is a separate API, never a fallback. `forTenant` is
  single-partition by construction; `db.scatter` is the only thing that fans
  out, and it reports what each leg cost. A `Seq` names an object only together
  with its partition, so anything crossing that boundary carries both — and a
  query naming a bare identifier, an edge above all, is refused rather than run
  somewhere it means something else.
- A restore says what to do about data already there — refuse, purge, or merge
  — and never guesses. Whatever the mode, the identities inside a backup must
  name the tenant being restored into: they are lens keys, and a merge looks
  them up, so a mislabelled backup would write over the tenant they really
  belong to on the same shard.
- A schema version governs what is accepted next, never what is already
  stored: activating one rewrites nothing. `tenant.migrations` is the separate,
  explicit operation that brings stored documents forward, and its instructions
  are data rather than functions — inspectable, and reviewable before they run.
- Locality is declared, not inferred. Everything sharing a `PartitionKey` lives
  on one node, which is what keeps the intersection cheap. Tenant scoping is
  structural — the tenant is part of every namespace and lens key — never a
  predicate a caller can omit.
- Identifiers are dense and partition-local. Global identity is
  `(PartitionKey, Seq)`; a globally unique id would make posting sets sparse and
  destroy scan locality.
- Queries are data, not closures. A closure cannot cross a node boundary, so a
  router that accepts one can only ever answer locally.
- `DatabaseCollection.surface` is a first-class field. Use
  `surface: "content-studio"` for Content Studio content types and
  `surface: "database"` for raw database tables. Do not bury `surface` inside
  `metadata`.
- Schemas, projections, time series, events, and system views are all
  Tenant-scoped. A surface reaching them without a Tenant would show one Tenant
  another's definitions.
- Dashboard system views are built from the Tenant APIs, never from storage, so
  a view cannot name a physical table or survive into another Tenant's data.
- Names beginning with `zv` are reserved for Zelavis internals and must be
  rejected as collection names.

Bundle storage keys are authority boundaries. Validate the Project/system
owner, service identity, bundle identifier, storage prefix, and relative asset
path independently before composing a key. Filesystem root containment alone
does not prevent one Project from traversing into another Project's namespace.

System tables are not document collections. Tables such as `zv_collections`,
`zv_events`, `zv_schemas`, `zv_time_series_checkpoints`, and
`zv_time_series_points` are raw internal SQL tables. They are not created
through `createCollection`, are not accessed through `documents.*`, and are not
part of the collection event pipeline. Names beginning with `zv_` are reserved
for Zelavis internals and must be rejected as collection names.

Dashboard system views must be logical, shard-aware capabilities exposed by
`zelavis/db`; they must never select a physical shard's internal table or
raw SQL endpoint. Until those logical views exist, keep physical `zv_*` tables
out of the dashboard entirely.

## Open Protocols And Embeddable Core

Zelavis should be useful as a full product, as an embeddable library, and as a
set of small composable tools. Prefer open protocols and narrow entry points
over closed product-only integration paths.

Design extension surfaces so they can be used by:

- the dashboard
- the CLI
- browser and native-fetch SDK bundles
- background agents
- MCP servers and clients
- local scripts and software-factory workflows
- cloud-hosted connectors and provider plugins

The package boundary should follow a Unix-like composition rule: small focused
programs and services do one thing well, expose stable contracts, and compose by
calling each other through explicit APIs. The full Platform OS can assemble
those pieces, but the pieces must remain useful without the full dashboard or
host runtime.

`zelavis` should therefore keep a clear embeddable core:

- core contracts, schemas, service definitions, and typed clients stay
  runtime-neutral
- `zelavis/sdk/*` surfaces are SDK/client bundles of Zelavis itself, excluding
  UI and host runtime code
- `zelavis/runtimes/*` surfaces are host utilities for long-running Platform OS
  processes
- adapters provide host, storage, or external-system bindings behind explicit
  subpaths
- plugins add optional capabilities without becoming the platform foundation

Do not make the product shell the only integration point. If a capability is
valuable, it should be reachable through a stable endpoint, embeddable API, or
protocol-facing surface so users can build their own CLI, local agent,
background worker, browser app, native-fetch client, or higher-level factory on
top of Zelavis.

## Endpoint-Backed Capability Rule

Everything Zelavis can do must be reachable through a stable server capability and an endpoint.

### JS, HTTP, and CLI parity

Every official public Zelavis capability must be available through the official
JavaScript SDK, versioned HTTP API, and CLI. No official capability is complete
when it is JS-only, HTTP-only, or CLI-only. When adding or changing a core API,
inspect and update all three surfaces in the same change; existing missing
surfaces are implementation gaps, not precedent for another exception.

- Define one domain operation and shared input/output/error schemas, then adapt
  it to JS, HTTP, and CLI. Keep authorization, validation, defaults, ownership,
  lifecycle, persistence, idempotency, and effects identical for equivalent
  requests. Do not duplicate business logic in transport handlers or commands.
- Service/plugin-owned APIs use the plural `plugins` namespace everywhere:
  `zelavis.plugins.<namespace>.<resource>.<action>(...)`, HTTP
  `/zelavis/api/v1/plugins/<namespace>/<resource>`, and CLI
  `zelavis plugins <namespace> <resource> <action>`. This includes official
  services: UI owns `plugins.ui`, and third-party SEO tools might own
  `plugins.seotool`. Do not use singular `plugin`, root aliases such as
  `zelavis.seotool`, or a parallel private API for first-party services.
- Every executable plugin/service package must explicitly declare
  `zelavis.namespace` in its manifest. Creation templates must include it;
  loaders validate it before evaluating code. Use a stable lower-camel-case
  identifier (letters/digits, starting lowercase); reserved JS protocol names
  are refused. Never infer it from an npm package name. File-only frontends
  need a namespace only if they own an API.
- Namespace ownership is unique within an installation or Project runtime;
  reject collisions explicitly, including collisions with official services.
  The manifest is authoritative: an exported object cannot claim a different
  namespace. Owning an API namespace grants no extra permission or ability to
  impersonate another service. Disabling/uninstalling removes its operations
  with the service lifecycle; independent runtimes have independent registries.
- Core Platform capabilities retain their domain namespaces. SDK authoring
  helpers that declare operations or executable handlers are distinct from
  installed plugin operations; plugins call the same public APIs as other
  clients. Define operations once with a resource/action, HTTP method/path,
  schemas, access requirements and handler so JS and CLI adapt the same HTTP
  contract. Keep frontend page routes separate from plugin API routes.
- HTTP uses resource paths and appropriate methods; JS uses typed methods; CLI
  uses domain/resource subcommands and action verbs, with flags for options.
  Equivalent behavior is required, not identical punctuation. Preserve explicit
  Project/Tenant/service identity and the configured API root in every adapter.
- The SDK and CLI must provide discoverable, typed/documented operations;
  a generic HTTP request escape hatch alone does not satisfy parity. CLI
  operations need a machine-readable output mode and equivalent domain errors.
- Package-loading SDK declarations must map to an explicit capability contract
  with equivalent HTTP and CLI operations. Carry declarative data or artifact
  references, not executable JS closures, across transports. Preserve package
  ownership and cleanup semantics; a remote menu registration must not silently
  become an unrelated global menu or bypass the SDK registration contract.
- Verify equivalent successful results, validation failures, authorization,
  and lifecycle effects across adapters with focused contract tests. Document
  all three forms together, and identify unimplemented forms as gaps rather
  than describing them as shipped.

This is the required direction for public APIs, not a claim that the current
SDK, HTTP routes, and CLI already have full parity. Internal implementation
helpers are not separate public capabilities.

The dashboard is a client of Zelavis, not the source of truth for platform behavior. Any feature exposed in the dashboard must also be available to non-dashboard callers such as the CLI, AI agents, scripts, plugins, external admin tools, and future automation flows.

Endpoint-backed does not mean serverless-first. Zelavis should expose stateless,
HTTP-compatible capability endpoints wherever practical, because that makes the
platform scriptable, MCP-friendly, AI-agent-friendly, and easy to integrate.
Those endpoints are the access layer into Zelavis; they are not a reason to move
the core Zelavis runtime onto serverless function platforms.

Required shape for platform features:

- define the domain capability first, behind a service/runtime contract
- expose that capability through a versioned endpoint under the configured API namespace
- let the dashboard call the same endpoint or typed client surface that other tools can call
- keep dashboard routes, React state, and UI-only handlers out of the authority path
- never implement privileged behavior only as a React route action, component callback, or framework-specific server action

Examples:

- Security checklist: capability `security.runChecklist(...)`, endpoint `POST /zelavis/api/v1/security/checklists/:id/run`, dashboard button calls that endpoint.
- Resource telemetry: capability `resources.getHostMetrics(...)`, endpoint `GET /zelavis/api/v1/resources/host`, dashboard charts render that endpoint data.
- Domain management: capability `domains.addDomain(...)`, endpoint `POST /zelavis/api/v1/domains`, dashboard form calls that endpoint.

This rule keeps Zelavis automatable, scriptable, plugin-friendly, AI-agent-friendly, and independent from any single dashboard framework.

The Zelavis Assistant follows the same rule. Thread persistence and Assistant
operations belong to the Platform OS and System Store, with versioned endpoints
under `/zelavis/api/v1/runtime/assistant`. `@assistant-ui/react` is a dashboard
rendering/runtime library only; it must not own provider credentials, thread
authority, tools, approvals, or privileged actions. Model and agent providers
implement the `ZelavisAssistantResponder` boundary. The built-in
`zelavis-local-router` is an honest deterministic development responder, not an
LLM. Future streaming and rich tool state should extend the endpoint protocol
without moving authority into React or Assistant Cloud.

Dashboard menu metadata may include dynamic sections through `dynamicItems`.
Dynamic menu sections must point at service-owned endpoints and return
`{ "items": [...] }`, where each item uses the same shape as static service menu
items. Use this for runtime-owned lists such as
Database tables and Workloads functions, jobs, schedules, and webhooks; do not
hardcode those lists inside the dashboard. Menu items may include `search`
metadata for route state such as the selected database table; dynamic endpoints
should return that state as menu metadata instead of requiring dashboard-specific
sidebar code.
Dynamic sections must also stay route-backed when empty. Use
`dynamicItems.emptyPath` and `dynamicItems.emptySearch` when the empty state
should open a specific route or route state, such as `/workloads/jobs`.
Do not rely on disabled placeholder-only rows for dynamic sections that own a
content area.
Service menu content has two supported shapes: a dashboard-local `path` that
the `@zelavis/ui` router owns, or a `page.file` HTML entry document that the
dashboard renders inside the content area through the service-frame iframe
boundary. If a service or dynamic endpoint forgets to provide a path, the
dashboard derives a stable
dashboard path from the service name and menu trail and renders a structured
placeholder instead of a dead menu item.
`menu.path` is always the dashboard URL. It changes React Router state, sidebar
state, active menu state, and reload/share behavior. `menu.page.file` is the
browser-extension-style HTML entry file for iframe-backed service UI, such as
`dashboard.html`, `settings.html`, or `options.html`. Zelavis serves that file
from the service bundle through the generated service-page-asset endpoint; iframes
must never point at raw filesystem paths. Core services with content already
shipped in `@zelavis/ui` should use `menu.path` without `menu.page`, so the
local dashboard route renders directly and no iframe is mounted.
If a service page wants to be a SPA, the service author owns that SPA's internal
router, tabs, and menu inside the bundled HTML/JS. Zelavis menu metadata selects
the HTML entry file only; it must not deep-link into a plugin SPA's private
routes.

Dashboard menu metadata may declare a `surface`. `platform` is the global
`/zelavis` owner/operator shell, `root` is the first slide of a project
dashboard, `core` is the project Backend slide, `extensions` is the project
Extensions slide, and `settings` is the project Settings slide. Runtime-installed
marketplace services are still constrained to Extensions; privileged surfaces
are for bundled or statically trusted system services. The Access area is a core
`zelavis/core` menu contribution, not a hardcoded sidebar exception.

Dashboard menu items may include `fixed: true` and `fixedOrder` for pinned
actions such as "Add Function". A nested slide may control inherited fixed
actions with `fixedActionScope`: `local` shows only actions declared in the
opened slide, `inherit` combines parent fixed actions with local actions,
`replace` uses local actions as an explicit boundary, and `clear` hides fixed
actions until a deeper slide reintroduces them with its own local or replacement
actions.

## Core Access-Control Rule

Zelavis uses one core principal, permission, and scoped-grant model across the
owner console, project dashboards, future customer/reseller/operator views,
service accounts, CLI calls, scripts, plugins, and AI agents.

Unscoped and system grants authorize runtime-wide routes. Project and service
grants require the same explicit route identity and never satisfy an unscoped
requirement; top-level principal permissions express authority spanning scopes.
An isolated Project Gateway child translates signed audience-bound permissions
into local authority. Do not relax root scope matching for child administration,
or infer Platform host-code installation authority from a Project grant.

The base authorization contract belongs in `zelavis/core`, because every
runtime service route needs to declare and enforce access requirements
independently of the authentication method that produced the caller.

`zelavis/app/auth` owns authentication primitives: accounts, credentials,
sessions, roles and permissions. It ships the credential ceremonies whose
dangerous parts are generic and identical for every provider — password
verification and its timing, and the state, nonce and PKCE custody an OAuth
redirect flow depends on — so they are written and audited once. It resolves
identities into principals; the server contract enforces route access.

What is vendor-specific stays a plugin. A credential provider declares
`zelavis/auth:credentials` and owns its whole exchange; an OAuth provider
declares `zelavis/auth:oauth` and supplies only endpoints and claim mapping.
Any OpenID Connect issuer needs neither: pasting its issuer URL is enough,
because the issuer publishes its own endpoints.

Future official modules such as Hosting Provider must not create a separate
customer permission system. Customers, resellers, operators, and owners are
Zelavis principals with system, project, or service-scoped grants. The same
`/zelavis` shell should render different menus, project lists, and actions from
those grants, while endpoints remain the authority layer.

## Repo Structure

- `packages/*` contains core platform workspace packages.
- `plugins/*` contains official user-installable Zelavis plugins.
- `packages/zelavis` is the unified framework and Platform OS package. Do not
  recreate the retired pre-consolidation server, App, core-service, or
  Marketplace package boundaries.
- `packages/zelavis/src/core` owns reusable service and endpoint contracts, Web
  routing, access enforcement, runtime lifecycle, and generic
  Fabric/workload/Agent/runtime-driver machinery. It is exported through
  focused `zelavis/*` subpaths and does not own product menus or root authority.
- `pnotes/` is the ignored, separate private repository for confidential design
  notes, evaluations, security reviews, and the implementation roadmap. Never
  stage or publish its contents in the main repository, and never make public
  documentation checks or CI depend on those local files.
- When available, `pnotes/TODO.md` is the maintained private implementation roadmap. Update
  its Done, Prepared, Next, and Later sections when a core, App-versioning, or
  Fabric capability changes state; never mark an exported contract as
  operational behavior before its implementation exists.
- Keep that roadmap current in the same change, never afterwards. A change
  that finishes an item marks it done in its own commit and says what it now
  does and what it cost — the numbers, where they were measured. Anything the
  work turned up goes in as a new open item then, while it is still known: a
  follow-up, a limit hit, a cost worth paying down later. And check what you
  touched on the way past: an item left open because nobody revisited it reads
  as work outstanding, which is the same defect as a stale comment, and the
  next reader plans around it.
- `packages/zelavis/src/app` owns the official `zelavis/app` Project recipe,
  document-first database, auth primitives, and Project-scoped workloads. It
  consumes the same core implementation and must never grow private server
  contracts or a private dispatcher.
- `packages/zelavis/src/platform` owns trusted product-specific control-plane
  and Marketplace services.
- `packages/zelavis/services/zelavis-ui` contains the admin/dashboard UI used by the runtime package.
- `packages/zelavis/adapters/*` contains optional framework, runtime, database,
  or external-system adapters distributed with the package workspace.
- `plugins/*` contains official optional capability and provider plugins,
  including Auth methods. Do not place plugin packages inside
  `packages/zelavis`; the unified package exports contracts and built-in App
  services, not installable plugin package source.
- `examples/*` contains runnable example workspace packages.
- `website/` contains the public Astro Starlight documentation site (`website/src/content/docs/`).
- `distribution/` owns release staging, archives, Debian packages, signed APT
  repository metadata, installers, and operating-system service files.

All production delivery formats must be assembled from the published `zelavis`
package and one common staged release tree. OS packages may bundle a pinned,
private Node runtime, but must not introduce a second Platform implementation or
install over the host's global Node runtime. Keep generated release trees,
download caches, and artifacts out of Git.

Complete native installation removal is a host-local lifecycle capability, not
a Platform HTTP/dashboard operation. Its runtime-neutral contract belongs in
core runtime, concrete filesystem/process/package behavior belongs in the host
adapter and distribution, and the packaged CLI is the operator surface. Require
an inspectable dry run plus the exact destructive acknowledgement before
removing anything. Remove only state whose installer ownership can be proved:
Platform/Agent units, package records, command links, release trees, Zelavis
data/config/trust, repository configuration, and a safely identified dedicated
account. Retain shared host packages, journal history, external archives and
backups, and operator-managed proxy/firewall/DNS/TLS state. Never add a remote
complete-wipe route: the operation destroys the authority and server that would
authorize it. npm/source copies must use their originating lifecycle. Whenever
an installer starts owning another resource, update the complete-uninstall
inventory, staged program, isolated destructive-path tests, and public docs in
the same change.

Each package should remain independently useful and focused.

## Current Important Runtime Facts

- The main public runtime entry point is `new Zelavis(...)`; `zelavis()` is an internal/low-level composition function.
- Public docs and examples should name the local `Zelavis` instance `zv`.
- The default dashboard root path is `/zelavis`.
- Opening `/zelavis` shows the endpoint-backed Projects overview. Project-local dashboard pages live under `/zelavis/projects/:projectId/*` and proxy project API calls to that project's isolated runtime.
- Project runtimes do not host private or secondary dashboards. The one Platform `@zelavis/ui` shell renders project menus fetched from project services through the project proxy.
- Global dashboard areas such as `/zelavis/marketplace` and `/zelavis/server/*` sit outside any project. Project-local marketplace/plugins live under `/zelavis/projects/:projectId/marketplace`.
- Server-level dashboard routes include `/zelavis/server/domains`, `/zelavis/server/backups`, and `/zelavis/server/logs`.
- Projects may represent Zelavis-native apps or managed apps such as WordPress/static/generic projects. Managed app projects should show hosting-style controls instead of Zelavis-native Auth/Database/Content plugin navigation.
- The runtime supports dashboard dev-server mode through `ZELAVIS_UI_DEV_SERVER` or `frontend.devServerUrl`. The `coreServices` option it used to live under is gone: Platform subsystems are `subsystems` on `zelavis(...)`, the frontend options are the public `frontend` option, and the settings store is `runtimeSettingsStore`.
- The main local platform workflow is `pnpm dev`.
- In repository development through `pnpm dev`, runtime state lives below
  `packages/zelavis/.zelavis`: the Platform System Store is under `system/` and
  isolated project directories are under `projects/<projectId>/`.
- `pnpm dev` builds the unified `zelavis` runtime and bundled Platform services,
  then starts both the long-running runtime and React Router dashboard dev
  server.
- That dev flow starts:
  - the Zelavis runtime on `http://127.0.0.1:3000`
  - the UI dev server on `http://127.0.0.1:3001`
  - dashboard requests to `/zelavis` are redirected to the live UI dev server

## Package Design Guidance

When creating or extending packages:

- Start from the domain model and the public API.
- Define interfaces for infrastructure concerns such as storage, payments, queues, or external providers.
- Ship an in-memory or local-development implementation when it improves usability or testability.
- Keep provider adapters behind plugin or adapter boundaries.
- Make defaults simple, but keep escape hatches available.
- Preserve a clear distinction between what exists today and what is only planned.

Use these boundaries consistently:

- `adapters` for framework bindings and external runtime adapters such as Express, Hono, or Node-specific mounting
- `plugins` for optional domain/provider capabilities such as OAuth providers or payment gateways, each declaring the capability of the service it extends

First-party core plugins such as `zelavis/app/workloads` may be enabled by default
by the high-level runtime while staying package-separated. Workloads are
project-scoped capabilities owned by the long-running Zelavis server. Provider
plugins may later sync or deploy workloads to Cloudflare, Vercel, Netlify, or
other external platforms when users choose that, but those providers must not
become the core workload execution architecture.

### New package checklist

When creating a new core package, service package, or plugin package:

1. Put the real definition in one obvious named top-level file under `src/`.
   - service package examples:
     - `src/auth-service.ts`
     - `src/database-service.ts`
   - plugin package examples:
     - `src/ecommerce-plugin.ts`
     - `src/stripe-plugin.ts`
2. Keep `src/index.ts` small and make it re-export the named definition file.
3. Use plain `ZelavisRuntimeService` object literals for mounted runtime services.
4. Use `package.json` manifest (`"zelavis": { "kind": "plugin" }`) and the official Zelavis SDK (`zelavis.plugins.ui.menus.create`, `zelavis.routes.create`, etc.) for plugins. `defineService` is removed. Plugin and service packages must register menus through `zelavis.plugins.ui.menus.create`; exported `menu`/`menus` fields are rejected. Runtime `menus` is the complete SDK registration list, and `menu` is its primary catalogue entry, so consumers must not concatenate them.
5. Keep orchestration helpers only when they add real behavior.
   - good: `authService(...)` because it creates Auth and registers explicit auth-method plugins
   - bad: pass-through aliases that only rename another function
6. Update the package README so it points directly to the named definition file.
7. Add or update tests around the real definition entrypoint, not only convenience wrappers.
8. Do not hide the main definition in nested files like `src/server/service.ts` or `src/core/define-plugin.ts` unless there is a strong reason and the user explicitly wants that shape.

### For core platform work

- Treat auth, database, server/runtime composition, and admin UX as the primary building blocks.
- Keep service APIs mountable through shared server contracts so packages compose cleanly.
- Keep storage, auth methods, and future provider adapters replaceable.
- Document current limitations clearly when functionality is placeholder or in progress.

### For ecommerce-specific work

- Treat customers, products, orders, coupons, payments, and plugins as core building blocks.
- Keep payment providers such as Stripe or PayPal behind provider contracts.
- Keep storage behind repository-style contracts so Prisma, Drizzle, SQL, or custom adapters can be added without rewriting the core.
- Optimize for embeddability inside apps, CMS systems, and larger commerce platforms.

## UI Package Rules

`packages/zelavis/services/zelavis-ui` is a special package with extra constraints:

- It uses **React Router v7** (SPA mode, `ssr: false`) — not TanStack Router or TanStack Start.
- Styling is Tailwind CSS v4 + shadcn/ui (Base UI components).
- Generated route types live in `.react-router/types/`. Do not hand-edit them.
- Route source files are under `packages/zelavis/services/zelavis-ui/app/routes/`. Edit these; typegen runs automatically.
- The dashboard sidebar uses a slide-based navigation model. Treat each slide as a distinct sidebar panel.
- Nested sidebar slide headers use a larger standard gap before the next menu content. Sidebar panels with pinned/fixed action rows use `SidebarFixedActionMenu`; pass `afterHeader` when fixed actions sit directly under the slide back/title header.
- Build dashboard features as mobile-slot-ready modules. Route files may compose those modules into a wide desktop page, while mobile sidebar slides can later mount the same modules into named slots such as `overview`, `main`, `create`, `edit`, `inspect`, and `settings`.
- Below the dashboard desktop breakpoint (`lg`), the sidebar is the whole app shell. Keep the desktop content inset hidden there; mobile and smaller tablet views should be composed from slide navigation and route slots.
- Do not build separate desktop-only and mobile-only versions of feature behavior. Extract reusable workspace/panel components first, keep page-level data loading in routes/resource routes, and let desktop pages and future mobile slots share those components.
- Shared UI primitives must stay aligned with the current shadcn CLI output unless there is a deliberate design-system decision. Use shadcn presets and CSS variables for theme changes; do not hand-edit generated primitives or route code for visual preferences that should come from `shadcn apply`.
- Dashboard routes should use shared control defaults. Do not pass `size="sm"`/`size="lg"` or `buttonVariants({ size: ... })` for ordinary text buttons; reserve explicit size variants for icon-only controls or a clearly distinct component primitive.
- Do not add blog-style route title blocks that repeat the breadcrumb, sidebar slide title, or active navigation item. Dashboard content should start with the actual workspace, table, form, chart, or contextual controls unless the page needs a title for a genuinely distinct object or focused editor.
- The "Community" section is intentionally rendered inside the first navigation slide.
- Dummy community entries may exist as markup-only placeholders and do not imply real routes.
- Content Studio routes must create collections with
  `surface: "content-studio"` as a top-level field.
- Database routes that create raw tables must use `surface: "database"`.
- Content Studio sidebar sections show only `surface: "content-studio"`
  collections and label them as Collections.
- Core Database sidebar sections show all registered collections, label raw
  collection entries as Tables, and keep system tables in a distinct System
  Tables area.

**Data loading**: every route that fetches data uses a `clientLoader` + `useLoaderData`. Never fetch in `useEffect` for page-level data. After mutations, use `useRevalidator().revalidate()`. Root loader data (`runtime`, `settings`, `databaseCollections`, `schemaCollections`) is accessed in child routes via `useRouteLoaderData<typeof rootClientLoader>('root')`.

**URL state & reconstructability**:
- Everything that can survive a reload must be in the URL. Use `useTypedSearchParams` / `useTypedSearchParam` from `app/lib/use-typed-search-params.ts`. `clientLoader` reads search params from `request.url` so data and URL are always in sync on reload.
- Every navigation step and sidebar slide depth must be reflected in the URL (`pathname` + `?sidebar=...`). Sharing or reloading a URL must reconstruct the exact same sidebar slide depth and active content area.

**Menu items and content area rules**:
- **Rule 1 (Always Change Content)**: Clicking any menu item or slide **MUST** update the URL and change the content area to its own dedicated page or panel. Even parent items with nested child items must land on an Overview page/route of that section when opened.
- **Rule 2 (No Empty/Missing Content)**: If a specific domain feature is not yet built or is planned, a structured placeholder page/panel **MUST** still be rendered. A menu item must never be without content or act as a dead click.
- **Rule 3 (Back Button Synchronization)**: Clicking the Back button on any sidebar slide must navigate both the sidebar slide and the content area back to the corresponding parent route and update the URL.
- **Rule 4 (URL State Reconstructability)**: Every navigation step and sidebar slide depth must be reflected in the URL (`pathname` + `?sidebar=...`). Sharing or reloading a URL must reconstruct the exact same sidebar slide depth and active content area.

When working on UI behavior:

- Treat the dashboard as one client of Zelavis endpoints. Do not put platform-only behavior in route components, local React state, or dashboard-only actions.
- Prefer `pnpm dev` for end-to-end runtime and dashboard iteration.
- Use `pnpm --filter @zelavis/ui typecheck` and `pnpm --filter @zelavis/ui build` to validate UI-only changes.
- Preserve the existing design language unless the task explicitly asks for redesign.

## Generated and Sensitive Files

Treat these carefully:

- `packages/zelavis/services/zelavis-ui/.react-router/types/` is generated. Do not hand-edit it.
- `packages/*/dist/*` is build output.
- `website/.astro/*` and `website/dist/*` are generated site output.

Do not manually edit generated files unless the user explicitly asks for it and the generating source cannot reasonably be changed instead.

## Verification

- **Verify from the repository root, never from a package.** `pnpm run verify`
  is the command: it builds every shippable workspace project, typechecks all of
  them, and runs the tests. A package-scoped `pnpm run build` proves only that
  the package still compiles against itself — it says nothing about the plugins,
  services, and examples that consume it, which is exactly where a change to a
  shared API breaks something. Root verification takes seconds; there is no
  version of "too slow to bother" that justifies skipping it.
- **Build and typecheck are not the same check.** Some packages build through a
  bundler that never runs `tsc`, so a type error can survive a green build and
  be caught only by `pnpm run typecheck`. Run both, which is what `verify` does.
- **Select workspace projects by exclusion, not inclusion.** Scripts that name
  the projects they cover go stale the moment someone adds one, and the gap is
  invisible — the command still succeeds, having quietly checked less. Prefer
  `pnpm -r --if-present <script>` with `--filter '!<name>'` for the few
  deliberate exceptions, so a new package is covered by default.
- Check `pnpm-workspace.yaml` when adding a project. A directory that is not a
  workspace package is invisible to every root command, whatever its scripts say.

## Code Change Expectations

- Make the smallest coherent change that moves the repo forward.
- **No backward compatibility.** This project is pre-release with no public users. Remove stale shapes and legacy paths outright — do not add shims, fallbacks, or "legacy support" branches. If something needs to change, change it cleanly.
- Update docs when public API or architecture changes.
- Add or update tests when a test setup exists.
- If there is no test coverage yet, keep code easy to validate and call out the gap.

## Git and PR Workflow

- The `main` branch is protected and does not allow direct pushes.
- Changes must be pushed to a branch and merged through a pull request.
- Do not assume GitHub app or automation credentials can open PRs automatically; if that fails, leave the branch pushed and provide the PR URL to the user.

## Documentation Expectations

- Each package should have a focused README with purpose, scope, and basic usage.
- Public docs in `website/src/content/docs/` should describe Zelavis as an in-progress self-hostable App Platform, not as a generic utilities repo.
- Document extension points and adapter boundaries.
- Be explicit about what is implemented today versus roadmap direction.
- Avoid vague marketing language.

## Guidance for Coding Agents

When acting as an agent in this repo:

- Be concise.
- Prefer implementing changes over only suggesting them.
- Explain tradeoffs when they materially affect architecture or maintenance.
- Prefer repo-consistent patterns over inventing new abstractions.
- Do not add compatibility aliases, legacy shims, or stale fallback behavior unless the user explicitly wants them.
- For UI tasks, remember that the runtime and UI may run separately in dev and together in production.
- If something looks generated, verify before editing.

## Runtime Independence Rule

Zelavis core must only depend on the JavaScript language and standard platform APIs.

Node.js is the current supported production host runtime. Core contracts stay
runtime-neutral so Bun, future Deno, OCI, and stronger project-runtime drivers
can be added without changing the project lifecycle model.
Serverless function platforms are not Zelavis runtime targets. They may appear as
optional plugins for deploying user websites, storage, email, images, DNS, CDN,
or other provider adapters, but must not define the core runtime
architecture.

Stateless protocols and connector standards such as MCP are welcome at the
edges of the platform. A Zelavis MCP server, deploy-provider connector, storage
connector, or AI integration may be stateless and may run on serverless or edge
infrastructure when that makes sense. The distinction is strict: connectors and
plugins may be serverless; the Zelavis platform runtime, database, auth,
dashboard, local website hosting, server management, and future replication
model must not be architected around serverless hosting constraints.

This repo must not be architected around:

- Node.js APIs
- Bun APIs
- Deno APIs
- provider-specific APIs
- framework-specific request/response models
- hosting provider SDKs or platform lock-in

Allowed foundation:

- ECMAScript / TypeScript
- standard Web platform primitives such as `Request`, `Response`, `Headers`, `URL`, streams, and `crypto` where standard

Required architecture rule:

- host/framework/provider-specific behavior must live only in `adapters/*` or equivalent adapter boundaries
- core packages must remain portable and runtime-neutral
- Zelavis must never require a specific JS runtime, hosting provider, or framework as its architectural base
