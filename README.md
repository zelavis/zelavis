# zelavis

`zelavis` is an early-stage Firebase/Supabase-style backend platform built as a pnpm workspace of composable TypeScript packages.

The current goal is to provide self-hostable and embeddable building blocks for auth, database, API mounting, and admin tooling without forcing a single framework or hosted deployment model.

Today, Zelavis is still foundation-first. It already has working packages for auth, database, server composition, and a runtime package with a dashboard shell. It is not yet trying to claim full Firebase or Supabase feature parity.

## Philosophy

- Backend platform first.
- Self-hostable and embeddable.
- Low-level first.
- Framework-agnostic by default.
- Strong contracts over hidden magic.
- Small, composable package surfaces.
- Clear extension points for providers, adapters, and integrations.

This repository is intended for developers building custom software, internal tools, multi-tenant backends, CMS integrations, platform services, plugins, and reusable infrastructure components.

## Current shape

Zelavis currently focuses on these platform layers:

- Auth primitives and pluggable authentication methods.
- A tenant-aware, document-first database core.
- Shared server contracts and HTTP integrations.
- A high-level runtime package that composes core services.
- An admin UI package that powers the runtime dashboard shell.

The repository also contains `@zelavis/ecommerce` as an optional domain package built with the same extensibility patterns.

## Workspace

Packages live in [packages/](packages).

Current packages:

- [packages/zelavis](packages/zelavis)  
  The high-level runtime package. It composes core services such as auth, database, and dashboard delivery, and re-exports server integrations.
- [packages/database](packages/database)  
  A document-first, tenant-aware database core with an in-memory driver, optional SQL capability, and a mountable server service.
- [packages/auth](packages/auth)  
  A low-level authentication core for accounts, credentials, sessions, and opt-in auth method plugins.
- [packages/server](packages/server)  
  Shared endpoint contracts and framework adapters that mount service APIs from Zelavis packages.
- [packages/ui](packages/ui)  
  The admin/dashboard frontend used by the high-level runtime.
- [packages/ecommerce](packages/ecommerce)  
  An optional low-level ecommerce core for building custom commerce platforms, CMS plugins, and embedded commerce workflows.
- [packages/ecommerce/integrations/express](packages/ecommerce/integrations/express)  
  An Express integration package for exposing the ecommerce core over HTTP.
- [packages/ecommerce/integrations/hono](packages/ecommerce/integrations/hono)  
  A Hono integration package for exposing the ecommerce core over HTTP.
- [packages/ecommerce/plugins/stripe](packages/ecommerce/plugins/stripe)  
  A Stripe payment provider plugin for `@zelavis/ecommerce`.
- [packages/ecommerce/plugins/paypal](packages/ecommerce/plugins/paypal)  
  A PayPal payment provider plugin for `@zelavis/ecommerce`.
- [packages/auth/plugins/email-password](packages/auth/plugins/email-password)  
  An email/password auth plugin for `@zelavis/auth`.
- [packages/auth/plugins/username-password](packages/auth/plugins/username-password)  
  A username/password auth plugin for `@zelavis/auth`.

## Runtime Defaults

Applications should usually import from `zelavis`, where core services are included by default:

```ts
import { zelavis } from "zelavis";
import { nodeIntegration } from "zelavis/integrations/node";

await zelavis({
  integration: nodeIntegration(),
});
```

By default, Zelavis owns one safe namespace:

```txt
/zelavis
/zelavis/api/v1/auth
/zelavis/api/v1/database
```

Customize that namespace with `rootPath`:

```ts
await zelavis({
  rootPath: "/admin",
  integration: nodeIntegration(),
});
```

That moves the dashboard and APIs together:

```txt
/admin
/admin/api/v1/auth
/admin/api/v1/database
```

Use scoped packages such as `@zelavis/server`, `@zelavis/database`, and `@zelavis/auth` when building lower-level primitives, integrations, plugins, or tests that need direct package APIs.

## Core Services

Core services use the same service contract as extension services. The high-level `zelavis` runtime currently includes dashboard delivery, auth, and database by default.

The dashboard and admin experience are still evolving. The runtime already serves the current UI package, but the overall product surface should be treated as early and subject to change.

Disable built-in core services when you need a smaller server:

```ts
await zelavis({
  coreServices: {
    auth: false,
    dashboard: false,
    database: false,
  },
  integration: nodeIntegration(),
});
```

Configure the built-in database service when the defaults are not enough:

```ts
await zelavis({
  coreServices: {
    database: {
      defaultTenantId: "acme",
    },
  },
  integration: nodeIntegration(),
});
```

Configure the built-in auth service through `coreServices.auth`, including auth plugins and repositories:

```ts
await zelavis({
  coreServices: {
    auth: {
      authOptions: {
        plugins: [emailPasswordPlugin({ verifyPasswordHash })],
      },
    },
  },
  integration: nodeIntegration(),
});
```

Current architecture includes:

- Tenant-aware document collections.
- A document API for create, read, query, update, and delete operations.
- An in-memory driver for development and tests.
- An optional SQL capability contract for future SQLite-compatible integrations.
- `databaseService(database)` for mounting database routes through `@zelavis/server`, with documents exposed as a nested service.

The first implementation is intentionally portable and does not depend on `unstorage` or native SQLite bindings. Durable database drivers should be supplied by platform integrations such as future `@zelavis/integration-node`, `@zelavis/integration-cloudflare`, or `@zelavis/integration-turso` packages.

## Optional domain package: `@zelavis/ecommerce`

The ecommerce package focuses on the primitives required to build larger commerce systems without prescribing the final product.

Current architecture includes:

- Typed domain models for customers, products, coupons, orders, and payment attempts.
- Repository contracts that isolate persistence from business logic.
- In-memory repository implementations for development and tests.
- A plugin-oriented payment layer for providers such as Stripe, PayPal, and others.
- Optional framework adapters exposed as separate integration packages such as `@zelavis/ecommerce-express` and `@zelavis/ecommerce-hono`.

This package is meant to support use cases such as:

- Building a WooCommerce-like plugin on top of an existing app or CMS.
- Building a PrestaShop-like commerce system with your own admin and storefront layers.
- Embedding commerce operations directly inside a backend application.
- Creating provider adapters and storage integrations without rewriting the core domain.

## Getting Started

Install dependencies:

```bash
pnpm install
```

Run package scripts from the workspace root or target a specific package:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @zelavis/ecommerce typecheck
pnpm --filter @zelavis/ecommerce build
```

## Usage Example

For a unified recurring billing flow (Stripe + PayPal) through the ecommerce core, see:

- [examples/nodejs.ts](examples/nodejs.ts)
- [examples/express.ts](examples/express.ts)
- [examples/ecommerce-recurring-subscriptions.ts](examples/ecommerce-recurring-subscriptions.ts)

The recurring subscriptions example uses these environment variables:

- `STRIPE_SECRET_KEY`
- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`

## Roadmap Direction

The repo is intentionally early and focused on foundations.

Near-term areas:

- More core platform packages under `packages/*`.
- Better admin and developer experience around the runtime package.
- Persistence adapters for tools like Prisma and Drizzle.
- Durable database drivers for different runtimes.
- Payment provider plugins for Stripe, PayPal, and similar gateways.
- Auth method plugins and storage adapters for `@zelavis/auth`.
- Better tests, fixtures, and package-level examples.

## Contributing

Contributors and coding agents should follow the guidance in [AGENTS.md](AGENTS.md).
