# AGENTS.md

## Project Overview

`zelavis` is an early-stage backend platform and pnpm workspace for composable TypeScript packages.

The current direction is a self-hostable and embeddable Firebase/Supabase-style foundation: auth, database, server/runtime composition, admin UI, and optional higher-level domain packages.

Current direction:

- Core platform work currently centers on `zelavis`, `@zelavis/server`, `@zelavis/database`, `@zelavis/auth`, and `@zelavis/ui`.
- The repo still ships domain packages such as `@zelavis/ecommerce`, but they are optional layers on top of the platform primitives, not the primary product definition.
- Prefer extensible architecture, service contracts, and provider boundaries over framework-specific shortcuts or hosted-product assumptions.

## Repo Structure

- `packages/*` contains workspace packages.
- `packages/zelavis` is the high-level runtime package that composes core services.
- `packages/*/integrations/*` contains nested framework or external-system integration packages.
- `packages/*/plugins/*` contains nested optional capability/provider/plugin packages.
- `packages/ui` contains the admin/dashboard UI used by the runtime package.
- Each package should be independently useful and have a focused responsibility.
- Shared patterns may be repeated across packages until a real common abstraction is justified.

## Engineering Rules

- Keep libraries framework-agnostic unless a package is explicitly an adapter for a framework or provider.
- Prefer TypeScript for package code.
- Design around small public APIs, explicit contracts, and clear extension points.
- Keep core platform concerns split cleanly across auth, data, transport, and UI boundaries.
- Separate domain logic from persistence and transport concerns.
- Prefer self-hostable defaults and replaceable infrastructure over vendor lock-in.
- Avoid app-specific assumptions, UI logic, or deployment-specific coupling in core packages.
- Do not introduce heavy dependencies without a clear need.
- Favor composition and adapters over inheritance.

## Package Design Guidance

When creating or extending packages:

- Start with the domain model and public API.
- Define interfaces for infrastructure concerns such as storage, payments, queues, or external providers.
- Ship an in-memory or local development implementation when it improves testability or package adoption.
- Preserve a clear distinction between what already exists and what is only planned.
- Keep provider integrations behind plugin or adapter boundaries.
- Make defaults simple, but keep escape hatches available for advanced users.
- Use `integrations` for framework bindings and external-system adapters such as Express, Hono, or other transport/runtime integrations.
- Use `plugins` for optional domain capabilities such as auth methods, payment providers, or similar extension points registered into the core package.

For core platform work:

- Treat auth, database, server/runtime composition, and admin UX as the primary building blocks.
- Keep service APIs mountable through shared server contracts so packages compose cleanly.
- Keep storage, auth methods, and future provider integrations replaceable.
- Document current limitations clearly when functionality is still a placeholder or in progress.

For ecommerce-specific work:

- Treat customers, products, orders, coupons, payments, and plugins as core building blocks.
- Keep payment providers like Stripe or PayPal behind provider contracts.
- Keep storage behind repository-style contracts so Prisma, Drizzle, SQL, or custom adapters can be added without rewriting the core.
- Optimize for embeddability inside apps, CMS systems, and larger commerce platforms.

## Code Changes

- Make the smallest coherent change that moves the package forward.
- Preserve backward compatibility when reasonable. If a breaking change is necessary, call it out clearly.
- Update package docs when the public API or architecture changes.
- Add or update tests when a test setup exists. If there is no test setup yet, keep code easy to validate and note the gap.

## Documentation

- Each package should have a short README that explains purpose, scope, and basic usage.
- Top-level docs should describe Zelavis as an in-progress backend platform, not just a generic library collection.
- Document extension points and integration boundaries.
- Be explicit about what is implemented today versus roadmap direction.
- Avoid marketing copy. Be concrete about what the package does and does not do.

## Preferred Output

When acting as an agent in this repo:

- Be concise.
- Explain architectural tradeoffs when they matter.
- Prefer implementing changes over only suggesting them.
- If introducing a new pattern, keep it simple and reusable across future packages.
