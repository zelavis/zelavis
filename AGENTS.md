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
| Claude / Codex chat | AI chat area built into the dashboard for interacting with Zelavis and building via AI |

The difference from Firebase/Supabase is depth and ownership: Zelavis is fully self-hostable, runtime-neutral, and built to scale beyond a single database engine. The database layer is the deepest differentiator — `@zelavis/db` extends SQL with a Document DB model (event-sourced, tenant-aware, per-collection tables) while keeping the storage engine swappable (SQLite, libSQL, and future engines). Replication, sharding, and eventually distributed multi-master operation are roadmap goals; the event log is the natural replication stream and `tenant_id` is the natural shard key. That is the same role Vitess plays for MySQL, but Zelavis is not coupled to any single SQL engine.

Zelavis should be able to host websites itself on user-controlled infrastructure. Managed deployment providers may be optional targets through plugins, but they are not the default hosting model and must not replace native Zelavis website hosting.

Core platform work currently centers on:

- `zelavis`
- `@zelavis/server`
- `@zelavis/db`
- `@zelavis/auth`
- `@zelavis/ui`

The repo still contains domain packages such as `@zelavis/ecommerce`, but they are optional layers on top of the platform primitives, not the main product definition.

## Effect Version

- Use [Effect v4](https://raw.githubusercontent.com/Effect-TS/effect-smol/refs/heads/main/LLMS.md) instead of Effect v3.
  - When using Schema, refer to the v4 documentation at [SCHEMA.md](https://raw.githubusercontent.com/Effect-TS/effect-smol/refs/heads/main/packages/effect/SCHEMA.md)
  - When using HttpApi, refer to the v4 documentation at [HTTPAPI.md](https://raw.githubusercontent.com/Effect-TS/effect-smol/refs/heads/main/packages/effect/HTTPAPI.md)
  - If the docs are insufficient, browse the source at https://github.com/Effect-TS/effect-smol/tree/main/packages/effect/src

## High-Level Principles

- Prefer extensible architecture, service contracts, and provider boundaries over framework-specific shortcuts.
- Keep the core self-hostable and replaceable.
- Favor explicit contracts over hidden magic.
- Keep core platform concerns split cleanly across auth, data, transport, and UI.
- Avoid app-specific assumptions in shared packages.
- Favor composition and adapters over inheritance.
- Do not introduce heavy dependencies without a clear reason.
- Keep future distributed multi-master operation possible: prefer deterministic event application, explicit idempotency, stable node identity, tenant-aware boundaries, and adapter-neutral replication contracts over hidden single-node assumptions.

## Repo Structure

- `packages/*` contains core platform workspace packages.
- `plugins/*` contains official user-installable Zelavis plugins.
- `packages/zelavis` is the high-level runtime package that composes core services.
- `packages/server` defines the shared service and route mounting model.
- `packages/db` contains the document-first database core and server-facing database service.
- `packages/auth` contains the low-level auth core and auth method plugins.
- `packages/ui` contains the admin/dashboard UI used by the runtime package.
- `packages/*/adapters/*` contains framework or external-system adapters.
- `packages/*/plugins/*` contains package-local capability/provider plugins for core services.
- `examples/*` contains runnable example workspace packages.
- `website/` contains the public Astro Starlight documentation site (`website/src/content/docs/`).

Each package should remain independently useful and focused.

## Current Important Runtime Facts

- The main public runtime entry point is `new Zelavis(...)`; `zelavis()` is an internal/low-level composition function.
- Public docs and examples should name the local `Zelavis` instance `zv`.
- The default dashboard root path is `/zelavis`.
- Opening `/zelavis` shows the Projects overview. Project-local dashboard pages live under `/zelavis/projects/:projectId/*`; the built-in starter project currently uses `/zelavis/projects/default`.
- Global dashboard areas such as `/zelavis/marketplace` and `/zelavis/server/*` sit outside any project. Project-local marketplace/plugins live under `/zelavis/projects/:projectId/marketplace`.
- Projects may represent Zelavis-native apps or managed apps such as WordPress/static/generic projects. Managed app projects should show hosting-style controls instead of Zelavis-native Auth/Database/Content plugin navigation.
- The runtime now supports a dashboard dev-server mode via `coreServices.dashboard.devServerUrl` or `ZELAVIS_UI_DEV_SERVER`.
- The main local dashboard workflow is `pnpm run ui:dev`.
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
- `plugins` for optional domain/provider capabilities such as auth methods or payment providers

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
3. Use plain `ZelavisService` object literals for mounted runtime services.
4. Use `defineService(...)` for user-facing services and package-local service contracts.
5. Keep orchestration helpers only when they add real behavior.
   - good: `authService(...)` because it creates auth and applies service plugins
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

`packages/ui` is a special package with extra constraints:

- It uses **React Router v7** (SPA mode, `ssr: false`) — not TanStack Router or TanStack Start.
- Styling is Tailwind CSS v4 + shadcn/ui (Base UI components).
- Generated route types live in `.react-router/types/`. Do not hand-edit them.
- Route source files are under `packages/ui/app/routes/`. Edit these; typegen runs automatically.
- The dashboard sidebar uses a slide-based navigation model. Treat each slide as a distinct sidebar panel.
- The "Community" section is intentionally rendered inside the first navigation slide.
- Dummy community entries may exist as markup-only placeholders and do not imply real routes.

**Data loading**: every route that fetches data uses a `clientLoader` + `useLoaderData`. Never fetch in `useEffect` for page-level data. After mutations, use `useRevalidator().revalidate()`. Root loader data (`runtime`, `settings`, `databaseCollections`, `schemaCollections`) is accessed in child routes via `useRouteLoaderData<typeof rootClientLoader>('root')`.

**URL state**: everything that can survive a reload must be in the URL. Use `useTypedSearchParams` / `useTypedSearchParam` from `app/lib/use-typed-search-params.ts`. `clientLoader` reads search params from `request.url` so data and URL are always in sync on reload.

When working on UI behavior:

- Prefer `pnpm run ui:dev` for end-to-end dashboard iteration.
- Use `pnpm --filter @zelavis/ui typecheck` and `pnpm --filter @zelavis/ui build` to validate UI-only changes.
- Preserve the existing design language unless the task explicitly asks for redesign.

## Generated and Sensitive Files

Treat these carefully:

- `packages/ui/.react-router/types/` is generated. Do not hand-edit it.
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
- Public docs in `website/src/content/docs/` should describe Zelavis as an in-progress backend platform, not as a generic utilities repo.
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

Supported Zelavis runtime targets are self-hosted Node.js, Bun, and future Deno.
Serverless function platforms are not Zelavis runtime targets. They may appear as
optional plugins for deploying user websites, storage, email, images, DNS, CDN,
or other provider integrations, but must not define the core runtime
architecture.

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
