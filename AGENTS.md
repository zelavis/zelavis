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

The difference from Firebase/Supabase is depth and ownership: Zelavis is fully self-hostable, runtime-neutral, and built to scale beyond a single database engine. The database layer is the deepest differentiator — `zelavis/app/db` extends SQL with a Document DB model (event-sourced, tenant-aware, per-collection tables) while keeping the storage engine swappable (SQLite, libSQL, and future engines). Official Zelavis Apps are locally physically sharded from creation: one logical App database routes stable virtual shard ranges across several SQLite files even when every placement is on one Node. Tenant placement, replication, failover, shard movement, and exceptional Tenant subdivision build on that same topology instead of introducing a second distributed architecture later. The event log is the natural replication stream and `tenant_id` is the normal first partition key. That is the same role Vitess plays for MySQL, but Zelavis is not coupled to any single SQL engine. Replicas do not imply multiple writable owners; multi-writer consistency requires a separate explicit data specification.

Zelavis should be able to host websites itself on user-controlled infrastructure. Managed deployment providers may be optional targets through plugins, but they are not the default hosting model and must not replace native Zelavis website hosting.

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
`zelavis/app/db`, `zelavis/app/auth`, and `zelavis/app/workloads`. The dashboard
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
  official Project recipe implemented as a `kind: "app"` service, not the
  Platform OS itself.
- **Project recipes** are the versioned create-project definitions and runtime
  entrypoints behind Marketplace apps and starters. They are services with
  `kind: "app"`; optional Project recipe metadata declares runtime
  compatibility.
  The official Zelavis App recipe lives inside the same package at
  `zelavis/app`. Every Project locks its exact recipe/runtime version, so a
  newer parent Platform can keep running older Projects without silently
  rewriting them. Project recipes own setup/provisioning behavior, default
  files, menu metadata, and the runtime services mounted in the created
  Project.
- **Plugins** use `kind: "plugin"` and extend the Platform or a Project
  runtime. Auth, Database, Workloads, Fabric, UI, and Marketplace are plugins
  the operator composed rather than a separate kind: what makes them trusted is
  `scope: "system"`, not a label. A plugin is not a Project recipe and does not
  appear in the create-project selector merely because it is built in.
- **Frontends** use `kind: "frontend"` and are the face of an installation or a
  Project. They declare a `zelavis.frontend` block choosing a `static` or
  `server` runtime, and are loaded from their manifest without executing
  JavaScript.
- There is no `core` kind, and no `web-app`, `website`, `dashboard-extension`,
  `provider`, or `template`. Each described who shipped a service or restated a
  capability, and nothing ever branched on them. A provider is discovered by
  its capability, and that capability names the service it extends
  (`zelavis/auth:credentials`, `@acme/shop:payments`) rather than a bare domain
  two plugins could both scan for.
- **System Services** are trusted Platform OS capabilities. Do not call every
  bundled project service a core service.
- **System Store** is Platform OS persistence. Local adapters default to
  `.zelavis/system/zelavis.sqlite`. It must stay separate from `zelavis/app/db`
  project databases and must never appear in a project's Database UI.
- The Platform process does not mount an app-facing `zelavis/app/db` service by
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
  packages under `packages/zelavis/product-services/*`: `@zelavis/ui` owns
  dashboard delivery, `@zelavis/marketplace` owns the marketplace. These
  internal services assemble the public core primitives into the Zelavis
  product and are not separate public framework brands.

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

Keep traffic balancing, placement, replication, and infrastructure
provisioning as separate capabilities. A placement is authoritative; a runtime
URL is only an Agent-reported route target. Replicas do not imply multiple
writable owners. Provider adapters supply capacity but never define Zelavis.

Every official `zelavis/app` Project uses the App Data Fabric topology from
creation. A single-node App still routes Tenant data through a versioned
partition map containing many virtual shard ranges and several physical SQLite
shards; the placements merely happen to share one Node. `zelavis/app/db` may
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

`zelavis/app/db` is a document-first database core backed by SQL-capable
drivers. Its event log is the source of truth for writes and the natural future
replication stream.

Key rules:

- Every registered collection has its own table. Do not reintroduce a shared
  `documents` table.
- All document writes go through the documents API and append events before
  projecting into the collection table. Do not write to registered collection
  tables directly with raw SQL.
- Collection tables are created inside the `collection.created` event
  transaction.
- `DatabaseCollection.surface` is a first-class field. Use
  `surface: "content-studio"` for Content Studio content types and
  `surface: "database"` for raw database tables. Do not bury `surface` inside
  `metadata`.
- Every collection table row has `tenant_id`. The database driver already
  declares `tenantRouting: true`; `tenant_id` is the intended shard key.
- SQLite-compatible adapters such as better-sqlite3, Bun SQLite, and libSQL
  should inherit shared behavior through `createSqliteCompatibleDriver`.
- Async SQLite gateway transactions must serialize unrelated top-level callers.
  Never treat a process-global `inTransaction` flag as proof that a concurrent
  caller is nested inside the current transaction. Event stream revisions must
  also have a physical uniqueness invariant as a final corruption barrier.
- `sql.execute()` must protect registered collection tables from direct DML/DDL
  writes and indirect trigger-based writes, and point callers to the documents
  API. `sql.query()` may read them.
- Do not expose `sql.execute()` through an endpoint unless collection-table
  write protection is preserved.

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
`zelavis/app/db`; they must never select a physical shard's internal table or
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
- `packages/zelavis/TODO.md` is the maintained implementation roadmap. Update
  its Done, Prepared, Next, and Later sections when a core, App-versioning, or
  Fabric capability changes state; never mark an exported contract as
  operational behavior before its implementation exists.
- `packages/zelavis/src/app` owns the official `zelavis/app` Project recipe,
  document-first database, auth primitives, and Project-scoped workloads. It
  consumes the same core implementation and must never grow private server
  contracts or a private dispatcher.
- `packages/zelavis/src/platform` owns trusted product-specific control-plane
  and Marketplace services.
- `packages/zelavis/product-services/zelavis-ui` contains the admin/dashboard UI used by the runtime package.
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
4. Use `package.json` manifest (`"zelavis": { "kind": "plugin" }`) and the official Zelavis SDK (`zelavis.menu.create`, `zelavis.routes.create`, etc.) for plugins. `defineService` is removed.
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

`packages/zelavis/product-services/zelavis-ui` is a special package with extra constraints:

- It uses **React Router v7** (SPA mode, `ssr: false`) — not TanStack Router or TanStack Start.
- Styling is Tailwind CSS v4 + shadcn/ui (Base UI components).
- Generated route types live in `.react-router/types/`. Do not hand-edit them.
- Route source files are under `packages/zelavis/product-services/zelavis-ui/app/routes/`. Edit these; typegen runs automatically.
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

- `packages/zelavis/product-services/zelavis-ui/.react-router/types/` is generated. Do not hand-edit it.
- `packages/*/dist/*` is build output.
- `website/.astro/*` and `website/dist/*` are generated site output.

Do not manually edit generated files unless the user explicitly asks for it and the generating source cannot reasonably be changed instead.

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
