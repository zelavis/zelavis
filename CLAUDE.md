# CLAUDE.md

Coding-agent context for the Zelavis monorepo. Read `AGENTS.md` first for the product vision and repo structure. This file covers architectural decisions and current implementation state that affect day-to-day code changes.

## What Zelavis Is Building

A unified, self-hostable App Platform that replaces and combines:

- **Firebase / Supabase** — backend-as-a-service: auth, database, self-hostable, runtime-neutral
- **Database layer** — SQL-database-agnostic Document DB with event sourcing, tenant routing, and a roadmap for replication and sharding (think Vitess but not MySQL-only, and doing much more)
- **Content management** — content types, entries, schemas, media (think WordPress)
- **Server / app / hosting / deploy management** — native website hosting, runtime management, environment config, service lifecycle, and optional external deployment targets (think cPanel, Plesk, Coolify, Dokploy, plus user-selected deploy providers)
- **Database administration** — collections, tables, query browser, event log (think phpMyAdmin)
- **Project workloads** — first-party functions, jobs, schedules, and webhooks served by the long-running Zelavis runtime
- **AI chat** — a built-in chat area inside the dashboard for interacting with Zelavis and building via AI (think Claude / Codex)

## Effect v4 & Vendored Library Source (@repos/effect)

- Zelavis uses **Effect v4**.
- The full Effect v4 source is vendored locally under `repos/effect/`.
- When writing Effect code, always refer to `repos/effect/LLMS.md`, `repos/effect/packages/effect/SCHEMA.md`, and the real source files in `repos/effect/packages/effect/src/` for idiomatic v4 patterns.
- `repos/effect/` is read-only reference material. Never import from `repos/effect/` in project code (import from `effect` or submodules).

## Database Architecture — Key Facts

### Per-collection tables
Every Content Studio collection gets its own SQLite table (e.g. a `Fruits` content type → a `"Fruits"` table). The old shared `documents` table no longer exists. Collection tables are created inside the `collection.created` event transaction.

### Event sourcing
All document writes go through `events` first, then project into the per-collection table. The event log is the authoritative record and the future replication stream. Never write to a collection table directly — use the documents API.

### Collection identity — `surface`
Collections are tagged with a first-class `surface` field on `DatabaseCollection` (not buried in freeform metadata):

- `surface: "content-studio"` — Content Studio content types. Set at creation time by Content Studio routes. `isContentTypeDatabaseCollection(collection)` checks `collection.surface === "content-studio"`.
- `surface: "database"` — raw database tables created from Core > Database (e.g. `database.new.tsx`). These appear in the Database sidebar under **Tables**, not in Content Studio.

### Write protection
`sql.execute()` on the driver checks the target table against the `collections` registry before running any DML/DDL. Direct SQL writes to registered collection tables throw `DatabaseDomainError` pointing to the documents API. `sql.query()` (reads) is unrestricted. SQLite-compatible adapters such as better-sqlite3, Bun SQLite, and libSQL inherit this via the shared `createSqliteCompatibleDriver`.

### Tenant routing
Every collection table row has `tenant_id`. The driver already declares `tenantRouting: true` capability. `tenant_id` is the intended shard key when sharding is implemented.

### System tables — NOT collections
`zv_collections`, `zv_events`, `zv_schemas`, `zv_time_series_checkpoints`, and `zv_time_series_points` are raw SQLite tables created via DDL. They are completely separate from the document collection system:

- They are NOT created via `createCollection` and are NOT in the event sourcing pipeline
- They cannot be accessed via `documents.insert`, `documents.findMany`, etc.
- The `zv_collections` table IS the registry that write protection reads — it is not itself a collection entry
- Any name starting with `zv_` is reserved for Zelavis internals; `validateDatabaseCollectionName` rejects it

The `_` prefix convention visible in the dashboard UI (e.g. the `systemTable` URL param) is a UI artifact and does not reflect physical table names. Physical names are `zv_*`.

### Sharding / replication (roadmap)
The event log is the replication stream. Replay events on replicas to rebuild collection tables. Tenant-level routing is the planned sharding boundary.

## Dashboard — Content vs Database

**Content sidebar section** — shows only collections with `surface === "content-studio"`. Section label: "Collections".

**Core > Database sidebar section** — shows **all** registered collections (both `surface: "content-studio"` and `surface: "database"`). Content types use their editor label when available; database tables use the collection name. Section label for table entries: "Tables". System tables (`events`, `schemas`, `collections`, etc.) are nested under "System Tables".

The sidebar structure is built in `packages/zelavis/services/ui/app/lib/dashboard-data.ts` → `buildPlatformNavItems`. Any change to nav items requires rebuilding `packages/zelavis/services/ui/src/generated/dashboard-assets.ts` via `pnpm --filter @zelavis/ui build`.

Nested sidebar slide headers use a larger standard gap before the next menu content. Sidebar panels with pinned/fixed action rows should use `SidebarFixedActionMenu`; when those actions sit directly below the centered slide back/title header, pass `afterHeader` so the spacing stays consistent across Content, Database, and future nested panels.

Shared UI primitives should stay aligned with the current shadcn CLI output unless there is a deliberate design-system decision. Use shadcn presets and CSS variables for theme changes; do not hand-edit generated primitives or route code for visual preferences that should come from `shadcn apply`.

Dashboard routes should use shared control defaults. Do not pass `size="sm"` / `size="lg"` or `buttonVariants({ size: ... })` for ordinary text buttons; reserve explicit size variants for icon-only controls or a clearly distinct component primitive.

Navigation is route-backed. Clicking any sidebar menu item or slide must update
the URL and change the content area to a dedicated page or panel. Parent items
with child slides need a canonical Overview route through `landingUrl`; planned
or unfinished areas still render a structured placeholder instead of becoming
dead clicks. Slide Back buttons must move both the sidebar and content area back
to the parent route. The full navigation state must be reconstructable from the
URL (`pathname` plus `?sidebar=...` and feature search params) after reload or
sharing.

## Collection Name Rules

- Pattern: `/^[A-Za-z_][A-Za-z0-9_-]*$/`
- Reserved names: `zv_collections`, `zv_events`, `zv_schemas`, `zv_time_series_checkpoints`, `zv_time_series_points`
- Any name starting with `zv_` is blanket-reserved for future Zelavis internals
- Validated in `validateDatabaseCollectionName` in `packages/zelavis/services/zelavis-app/src/db/contracts/documents.ts`

## Content Studio Routes (UI)

All Content Studio routes live under `packages/zelavis/services/ui/app/routes/content*.tsx`. When creating a collection from any of these routes, always pass `surface: "content-studio"` as a top-level field to `createDatabaseCollection` — not inside `metadata`.

```ts
await createDatabaseCollection(runtime, {
  name: "fruits",
  surface: "content-studio",
  metadata: { kind: "content-type" },
});
```

## Package Boundaries to Respect

- `zelavis` — Platform OS control plane, System Store, Blueprint registry,
  dashboard composition, and project lifecycle orchestration. Its local System
  Store defaults to `.zelavis/system/zelavis.sqlite`.
- The Node adapter's default `node-process` project runtime prepares Zelavis App
  projects under `.zelavis/projects/<id>` and runs each in a separate process.
  It isolates data, event loops, and crashes, but is not a security sandbox.
  Keep lifecycle code behind `ZelavisProjectRuntimeDriver`; OCI and microVM
  implementations must not require dashboard or project-model changes.
- `@zelavis/app/db` — application/project DB contracts, driver, event sourcing, and
  SQL protection. It must not own Platform OS settings, users, project registry,
  Blueprint cache state, or service installation state.
- `@zelavis/app/adapters/*` — runtime-specific storage adapters. Each wraps `createSqliteCompatibleDriver`.
- `@zelavis/server` — reusable service/endpoint and access contracts for both
  Platform and isolated project runtimes. It also owns runtime introspection,
  service-menu discovery, and service-registry endpoints. It is not the
  Platform OS product.
- `@zelavis/app/auth` — application auth and method plugins. Platform identities and
  Zelavis App project identities are separate realms unless explicitly bridged.
- `@zelavis/ui` — the single Platform dashboard SPA (React Router v7, SPA
  mode). Project runtimes never mount a second dashboard; the Platform UI reads
  their service menus and APIs through the project proxy. See `AGENTS.md` UI
  section.
- `@zelavis/app/workloads` — first-party Zelavis App project service for functions, jobs,
  schedules, and webhooks. It is not Platform OS persistence.

The published `zelavis` package ships official manifests from
`packages/zelavis/blueprints`; downloaded versions belong in
`.zelavis/blueprints`. `pnpm dev` loads the source catalog explicitly while
running the runtime and React Router UI together. Blueprints are provisioning
recipes, not services: they select versioned services, while each installed
service owns its menu metadata and menu endpoints.

## Endpoint-Backed Capability Rule

Everything Zelavis can do must be reachable through a stable server capability and an endpoint.

The dashboard is only one client. If a dashboard page can run a Linux security checklist, read host resource metrics, add a domain, create a backup, install a service, mutate database state, or change project settings, the same operation must be available through the server API so the CLI, AI agents, scripts, plugins, and external admin tools can do it too.

Do not implement authoritative platform behavior only in React route modules, component callbacks, local state, framework server actions, or dashboard-only helpers. Start from the domain capability, mount it through `@zelavis/server`, then let the dashboard consume that endpoint.

This rule is compatible with stateless connector protocols such as MCP. Zelavis
capabilities should be easy to call over HTTP and easy for AI agents to use, but
the core runtime is still a self-hosted platform runtime, not a serverless
function app.

Assistant conversations are a Platform OS capability. `zelavis` owns the
`ZelavisAssistantManager`, System Store records, responder contract, and
`/zelavis/api/v1/runtime/assistant/*` endpoints. `@zelavis/ui` uses
`@assistant-ui/react` only for composable chat state and primitives. Do not put
model calls, provider secrets, thread persistence, tool authorization, or
privileged actions in React Router actions or components. The current
`zelavis-local-router` is deterministic and intentionally limited; real model,
streaming, tool-call, approval, and agent-run adapters remain provider/runtime
work behind the same Zelavis capability boundary.

Service dashboard menus can declare dynamic sections with `dynamicItems`. Those
sections must be backed by service-owned endpoints that return
`{ "items": [...] }`, where each item uses the same metadata shape as static
service menu items. Database uses this for tables; Workloads uses it for project functions,
jobs, schedules, and webhooks. Menu items may include `search` metadata for
route state such as the selected table, so services do not need dashboard-only
sidebar exceptions.
Dynamic sections must remain route-backed even when empty. Use
`dynamicItems.emptyPath` and `dynamicItems.emptySearch` to point an empty
dynamic section at a real content route/search view instead of leaving a
placeholder-only slide.
Service menu content may be either a dashboard-local `path` handled by
`@zelavis/ui` or a `page.file` HTML entry rendered through the service-frame
iframe boundary.
The dashboard derives stable paths for pathless service menu items and dynamic
items, then renders a structured placeholder for generated paths without a
dedicated route or iframe page.
`menu.path` is always the dashboard URL and must update React Router, sidebar
state, active menu state, and reload/share behavior. `menu.page.file` is the
browser-extension-style HTML entry file for iframe-backed service UI, such as
`dashboard.html`, `settings.html`, or `options.html`. Zelavis serves that file
from the service bundle through the generated service-page-asset endpoint; iframes
must never point at raw filesystem paths. Core services whose content already
ships with `@zelavis/ui` should use `menu.path` without `menu.page` so the local
React Router route renders directly.
If a service page wants to be a SPA, the service author owns that SPA's internal
router, tabs, and menu inside the bundled HTML/JS. Zelavis menu metadata selects
the HTML entry file only; it must not deep-link into a plugin SPA's private
routes.

Service dashboard menus can declare a `surface`. `platform` is the global
`/zelavis` owner/operator shell, `root` is the first slide of a project
dashboard, `core` is the project Backend slide, `extensions` is the project
Extensions slide, and `settings` is the project Settings slide. Runtime-installed
marketplace services are still constrained to Extensions; privileged surfaces
are for bundled or statically trusted system services. The Access area is a core
`@zelavis/server` menu contribution, not a hardcoded sidebar exception.

Service dashboard menus can declare slide-local fixed actions with
`fixed: true` and optional `fixedOrder`. Fixed actions are official menu
metadata for pinned actions such as "Add Function". Nested slides can control
fixed-action inheritance with `fixedActionScope`: `local` shows only actions
declared in the opened slide, `inherit` combines parent fixed actions with
local actions, `replace` uses local actions as an explicit boundary, and `clear`
hides fixed actions until a deeper slide reintroduces them with its own local
or replacement actions.

## Core Access-Control Rule

Zelavis uses one core principal, permission, and scoped-grant model across the
owner console, project dashboards, future customer/reseller/operator views,
service accounts, CLI calls, scripts, plugins, and AI agents.

The base authorization contract belongs in `@zelavis/server`, because every
runtime service route needs to declare and enforce access requirements
independently of the authentication method that produced the caller.

`@zelavis/app/auth` owns authentication primitives: accounts, credentials, sessions,
and pluggable auth methods such as email/password, passkeys, OAuth, SSO, API
keys, and service-token providers. It resolves identities into principals; the
server contract enforces route access.

Future official modules such as Hosting Provider must not create a separate
customer permission system. Customers, resellers, operators, and owners are
Zelavis principals with system, project, or service-scoped grants. The same
`/zelavis` shell should render different menus, project lists, and actions from
those grants, while endpoints remain the authority layer.

## Runtime and Connector Boundary

Node.js is the current production host runtime. Keep core packages based on
standard JavaScript and Web platform APIs, with runtime-specific behavior in
adapters and provider-specific behavior in plugins, so Bun and future Deno can
be added without a core rewrite.

Serverless and edge platforms may appear as optional plugin or connector targets
for user website deployment, DNS, CDN, storage, images, email, MCP servers, AI
integrations, or similar edge-facing work. They must not define the architecture
of the Zelavis runtime, database, auth, dashboard, native website hosting,
server management, or future replication/multi-master model.

## Distribution Boundary

`distribution/` owns release staging, self-contained archives, Debian packages,
signed APT repository metadata, installers, and operating-system service files.
Every format must wrap the same staged deployment produced from the public
`zelavis` package. Packages may carry a pinned private Node runtime, but must not
replace the host's global Node installation or create another Platform runtime
implementation.

## Testing

- `@zelavis/app/db`: Node test runner, `.mjs` files in `packages/zelavis/services/zelavis-app/test` and `packages/zelavis/services/zelavis-app/adapters/*/test`. Run with `pnpm --filter @zelavis/app test`.
- `@zelavis/ui`: Vitest for unit tests, Playwright for e2e. Run with `pnpm --filter @zelavis/ui test`.
- After any `@zelavis/app/db` contract change, rebuild with `pnpm --filter @zelavis/app build` before running adapter tests.
- After any `@zelavis/ui` source change that affects the compiled dashboard, rebuild with `pnpm --filter @zelavis/ui build` to regenerate `packages/zelavis/services/ui/src/generated/dashboard-assets.ts`.

## Effect Version

- Use [Effect v4](https://raw.githubusercontent.com/Effect-TS/effect-smol/refs/heads/main/LLMS.md) instead of Effect v3.
  - When using Schema, refer to the v4 documentation at [SCHEMA.md](https://raw.githubusercontent.com/Effect-TS/effect-smol/refs/heads/main/packages/effect/SCHEMA.md)
  - When using HttpApi, refer to the v4 documentation at [HTTPAPI.md](https://raw.githubusercontent.com/Effect-TS/effect-smol/refs/heads/main/packages/effect/HTTPAPI.md)
  - If the docs are insufficient, browse the source at https://github.com/Effect-TS/effect-smol/tree/main/packages/effect/src

## Things That Must Not Happen

- Do not write to a collection table via raw SQL — always use the documents API.
- Do not put `surface` inside `metadata` — it is a first-class field on `DatabaseCollection` and `CreateCollectionInput`.
- Do not expose `sql.execute()` via an HTTP endpoint without collection-table protection.
- Do not add a shared `documents` table — the per-collection-table design is intentional.
- Do not add backward-compat shims — this project is pre-release with no public users. Remove stale shapes cleanly.
- Do not ship a dashboard feature that cannot also be performed through a stable endpoint.
- Do not treat serverless deployability of connectors as permission to make serverless the Zelavis core runtime target.
- Do not create menu items or slides that do not change the content area — every menu item click must navigate to its own content/overview page and update the URL.
- Do not leave menu items without content — render a structured placeholder page/panel if domain content is not yet implemented.
- Do not allow slide back navigation to leave the main content area out of sync — clicking Back in a slide must navigate both the slide and content area back to the parent route.
- Do not allow UI state to be unshareable — every navigation step must be fully reconstructable from the URL (`pathname` + `?sidebar=...`).
