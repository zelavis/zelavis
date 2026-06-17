# CLAUDE.md

Coding-agent context for the Zelavis monorepo. Read `AGENTS.md` first for the product vision and repo structure. This file covers architectural decisions and current implementation state that affect day-to-day code changes.

## What Zelavis Is Building

A unified, self-hostable App Platform that replaces and combines:

- **Firebase / Supabase** — backend-as-a-service: auth, database, self-hostable, runtime-neutral
- **Database layer** — SQL-database-agnostic Document DB with event sourcing, tenant routing, and a roadmap for replication and sharding (think Vitess but not MySQL-only, and doing much more)
- **Content management** — content types, entries, schemas, media (think WordPress)
- **Server / app / hosting / deploy management** — runtime management, environment config, service lifecycle (think cPanel, Plesk, Vercel, Netlify, Coolify, Dokploy)
- **Database administration** — collections, tables, query browser, event log (think phpMyAdmin)
- **AI chat** — a built-in chat area inside the dashboard for interacting with Zelavis and building via AI (think Claude / Codex)

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
`sql.execute()` on the driver checks the target table against the `collections` registry before running any DML/DDL. Direct SQL writes to registered collection tables throw `DatabaseDomainError` pointing to the documents API. `sql.query()` (reads) is unrestricted. All four adapters (better-sqlite3, Bun SQLite, libSQL, D1) inherit this via the shared `createSqliteCompatibleDriver`.

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

The sidebar structure is built in `packages/ui/app/lib/dashboard-data.ts` → `buildPlatformNavItems`. Any change to nav items requires rebuilding `packages/ui/src/generated/dashboard-assets.ts` via `pnpm --filter @zelavis/ui build`.

## Collection Name Rules

- Pattern: `/^[A-Za-z_][A-Za-z0-9_-]*$/`
- Reserved names: `zv_collections`, `zv_events`, `zv_schemas`, `zv_time_series_checkpoints`, `zv_time_series_points`
- Any name starting with `zv_` is blanket-reserved for future Zelavis internals
- Validated in `validateDatabaseCollectionName` in `packages/db/src/contracts/documents.ts`

## Content Studio Routes (UI)

All Content Studio routes live under `packages/ui/app/routes/content*.tsx`. When creating a collection from any of these routes, always pass `surface: "content-studio"` as a top-level field to `createDatabaseCollection` — not inside `metadata`.

```ts
await createDatabaseCollection(runtime, {
  name: "fruits",
  surface: "content-studio",
  metadata: { kind: "content-type" },
});
```

## Package Boundaries to Respect

- `@zelavis/db` — core DB contracts, driver, event sourcing, SQL protection. No Node/Bun/CF specifics.
- `@zelavis/db/adapters/*` — runtime-specific storage adapters. Each wraps `createSqliteCompatibleDriver`.
- `@zelavis/server` — shared service/endpoint contracts. No storage or auth specifics.
- `@zelavis/auth` — auth core and method plugins only.
- `@zelavis/ui` — dashboard SPA (React Router v7, SPA mode). See `AGENTS.md` UI section.
- `zelavis` — high-level runtime that composes the above. Public API entry point.

## Testing

- `@zelavis/db`: Node test runner, `.mjs` files in `test/` and `adapters/*/test/`. Run with `pnpm --filter @zelavis/db test`.
- `@zelavis/ui`: Vitest for unit tests, Playwright for e2e. Run with `pnpm --filter @zelavis/ui test`.
- After any `@zelavis/db` contract change, rebuild with `pnpm --filter @zelavis/db build` before running adapter tests.
- After any `@zelavis/ui` source change that affects the compiled dashboard, rebuild with `pnpm --filter @zelavis/ui build` to regenerate `packages/ui/src/generated/dashboard-assets.ts`.

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
