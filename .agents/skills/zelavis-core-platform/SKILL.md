---
name: zelavis-core-platform
description: Use when changing the unified Zelavis package, its core runtime/Fabric, built-in App stack, or trusted product services, especially for authority boundaries, public API shape, and runtime-neutral architecture decisions.
---

# Zelavis Core Platform

Use this skill for changes in:

- `packages/zelavis/src/core`
- `packages/zelavis/src/app`
- `packages/zelavis/src/platform`
- `packages/zelavis/product-services/*`
- `packages/zelavis/adapters/*`
- `plugins/*` when an official optional provider or capability plugin consumes
  the unified package's public contracts

Start by reading `AGENTS.md` and the relevant `packages/zelavis` documentation
before editing.

## Working rules

- Treat `new Zelavis(...)` as the public Platform entrypoint and the `zelavis`
  package as the one official framework/App Platform distribution.
- Do not recreate separate `@zelavis/server`, `@zelavis/app`,
  `@zelavis/core`, or `@zelavis/marketplace` packages. Their responsibilities
  are now public subpaths or internal product services of `zelavis`.
- Keep `packages/zelavis/src/core` product-neutral and runtime-neutral. It owns
  the contracts and implementations exported through `zelavis/core`,
  `zelavis/runtime`, `zelavis/fabric`, `zelavis/workload`,
  `zelavis/artifact`, and `zelavis/provider`.
- Do not create parent/child service graphs. Provider plugins are ordinary
  installed services discovered by capability and validated against an explicit
  public registration contract; never use `childServices` or service `extends`.
- Keep the built-in Zelavis App stack in `packages/zelavis/src/app`, exported
  through `zelavis/app`, `zelavis/app/auth`, `zelavis/app/db`, and
  `zelavis/app/workloads`. It reuses the core implementation; never create an
  App-private dispatcher or server contracts.
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
- Do not implement Platform behavior only in UI routes, framework server
  actions, local component state, or dashboard-only helpers.
- Keep `packages/zelavis/TODO.md` current when core, runtime, App versioning, or
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

## Design checklist

1. Start from the public API and authority boundary.
2. Decide whether the change belongs in core, App, Platform product behavior,
   an adapter, or a plugin.
3. Define the domain capability before the transport or dashboard surface.
4. Expose dashboard operations through versioned service endpoints.
5. Keep defaults ergonomic and authority explicit.
6. Update the nearest README and `packages/zelavis/TODO.md` when behavior changes.
7. Add or update focused tests in `packages/zelavis/test`.

## Validation

Run the smallest useful checks first, then broaden as needed:

```bash
pnpm --filter zelavis test
pnpm --filter @zelavis/ui test
pnpm --filter @zelavis/ecommerce test
pnpm check
```
