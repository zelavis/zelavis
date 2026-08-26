---
name: zelavis-core-platform
description: Use when changing Zelavis core packages such as zelavis, @zelavis/server, @zelavis/app, or trusted product services, especially for service boundaries, adapters vs plugins, public API shape, and runtime-neutral architecture decisions.
---

# Zelavis Core Platform

Use this skill for changes in:

- `packages/zelavis`
- `packages/server`
- `packages/app`
- `packages/zelavis/product-services/*`

Start by reading `AGENTS.md` and the relevant package README before editing.

## Working rules

- Treat `new Zelavis(...)` as the public application/runtime entrypoint.
- Treat `zelavis()` as a lower-level internal composition helper.
- Keep core packages runtime-neutral and based on standard Web APIs.
- Put framework or host behavior only in `adapters/*`.
- Put optional provider or domain capabilities only in `plugins/*`.
- Keep Zelavis runtime targets to self-hosted Node.js, Bun, and future Deno; do not add serverless function platforms as runtime targets.
- Keep the canonical hierarchy explicit: Platform scales Projects, Projects scale Tenants, and exceptional Tenants may later scale Shards. Project, Tenant, and Principal/User are different boundaries.
- Keep `@zelavis/server` product-neutral. It owns service, endpoint, access, Fabric, workload, Agent, and runtime-driver primitives; `@zelavis/core`, `@zelavis/marketplace`, and `@zelavis/ui` assemble those primitives into the Zelavis Platform product.
- Treat `@zelavis/app` as an independently published Project recipe/runtime stack that consumes `@zelavis/server`. Do not copy it into `packages/zelavis/product-services` or recreate App-private server contracts.
- Let `@zelavis/server` own the generic service and contribution mechanism. Only statically trusted product/core services may define new extension-point schemas or privileged manifest capabilities. Ordinary services may contribute to allowed extension points after validation.
- Treat dashboard menu semantics and rendering as `@zelavis/ui` concerns while keeping the contribution wire format runtime-neutral so headless Project runtimes do not bundle the dashboard.
- Keep one privileged Platform Fabric. Fabric decides Project placement globally; authenticated Zelavis Agents execute locally; runtime drivers are Agent execution implementations. A scoped App Fabric never receives physical fleet authority.
- Keep project lifecycle behind capability-aware runtime-driver and Agent contracts. The local Node process driver is Platform-owned and stops children during `Zelavis.close()`; production worker Agents should be separately supervised so runtimes survive control-plane outages without becoming independent authorities.
- Reconcile desired-running projects asynchronously with bounded concurrency. Never fan out an entire persisted fleet through an unbounded `Promise.all`, and do not make control-plane readiness wait for every project runtime.
- Keep traffic balancing, authoritative placement, replication, and infrastructure provisioning separate. Route through scoped identity and placement; never treat an incidental runtime URL as placement authority.
- Let optional provider plugins connect external deployment, storage, DNS, CDN, email, images, or hosting services without making those providers the core architecture.
- Prefer tightening exports over broad `export *` surfaces.
- Preserve the service model; do not invent a parallel composition pattern.
- Everything Zelavis can do must be reachable through a stable server capability and endpoint. The dashboard is a client, not the authority layer.
- Do not implement platform behavior only in UI routes, framework server actions, local component state, or dashboard-only helpers.
- Keep `AGENTS.md` as the canonical durable instruction source; do not add project rules to `CLAUDE.md`.
- If durable platform guidance changes, update the relevant `.agents/skills/*/SKILL.md` or `.agents/references/*` material so skill-loaded agents stay current.
- For `@zelavis/app/db`, preserve the event-sourced per-collection-table model. Do not reintroduce a shared `documents` table, do not write directly to registered collection tables, and keep `surface` as a first-class collection field.

## Design checklist

1. Start from the public API and package boundary.
2. Decide whether the change belongs in core, an adapter, or a plugin.
3. Define the domain capability before the transport or dashboard surface.
4. Expose dashboard-available operations through versioned service endpoints so CLI, AI agents, scripts, plugins, and external admin tools can call them too.
5. Keep defaults ergonomic, but leave escape hatches.
6. Update the nearest README when public behavior changes.
7. Add or update focused tests in the affected package.

## Validation

Run the smallest useful checks first, then broaden as needed:

```bash
pnpm --filter zelavis test
pnpm --filter @zelavis/server test
pnpm --filter @zelavis/app test
pnpm --filter @zelavis/ui test
pnpm check
```
