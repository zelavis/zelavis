# AGENTS.md

## Project Overview

`zelavis` is a pnpm workspace for low-level utilities and libraries.

This repository is not an app product. Packages in this repo should provide reusable primitives, composable services, adapters, and infrastructure that other systems can build on top of.

Current direction:

- `@zelavis/ecommerce` is the first package.
- The ecommerce package is a low-level commerce core for custom backends, CMS integrations, plugins, and larger commerce platforms.
- Prefer extensible architecture over framework-specific shortcuts.

## Repo Structure

- `packages/*` contains workspace packages.
- `packages/*/integrations/*` contains nested framework or external-system integration packages.
- `packages/*/plugins/*` contains nested optional capability/provider/plugin packages.
- Each package should be independently useful and have a focused responsibility.
- Shared patterns may be repeated across packages until a real common abstraction is justified.

## Engineering Rules

- Keep libraries framework-agnostic unless a package is explicitly an adapter for a framework or provider.
- Prefer TypeScript for package code.
- Design around small public APIs, explicit contracts, and clear extension points.
- Separate domain logic from persistence and transport concerns.
- Avoid app-specific assumptions, UI logic, or deployment-specific coupling in core packages.
- Do not introduce heavy dependencies without a clear need.
- Favor composition and adapters over inheritance.

## Package Design Guidance

When creating or extending packages:

- Start with the domain model and public API.
- Define interfaces for infrastructure concerns such as storage, payments, queues, or external providers.
- Ship an in-memory or local development implementation when it improves testability or package adoption.
- Keep provider integrations behind plugin or adapter boundaries.
- Make defaults simple, but keep escape hatches available for advanced users.
- Use `integrations` for framework bindings and external-system adapters such as Express, Hono, or other transport/runtime integrations.
- Use `plugins` for optional domain capabilities such as auth methods, payment providers, or similar extension points registered into the core package.

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
- Document extension points and integration boundaries.
- Avoid marketing copy. Be concrete about what the package does and does not do.

## Preferred Output

When acting as an agent in this repo:

- Be concise.
- Explain architectural tradeoffs when they matter.
- Prefer implementing changes over only suggesting them.
- If introducing a new pattern, keep it simple and reusable across future packages.
