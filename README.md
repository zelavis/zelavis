# zelavis

`zelavis` is a pnpm workspace for low-level Node.js and TypeScript libraries.

The goal is to build a collection of composable packages that solve real backend and infrastructure problems without forcing a framework, app structure, or product opinion on the user. Think reusable primitives, adapters, contracts, and service layers that can power larger systems.

## Philosophy

- Low-level first.
- Framework-agnostic by default.
- Strong contracts over hidden magic.
- Small, composable package surfaces.
- Clear extension points for providers, adapters, and integrations.

This repository is intended for developers building custom software, internal platforms, CMS integrations, backend services, plugins, and reusable infrastructure components.

## Workspace

Packages live in [`packages/`](/Users/ivanjeremicx/Projects/zelavis/packages).

Current packages:

- [`@zelavis/database`](/Users/ivanjeremicx/Projects/zelavis/packages/database)  
  A document-first, multi-model-ready database core with tenant-aware contracts, an in-memory adapter, optional SQL capability, and a mountable server service.
- [`@zelavis/ecommerce`](/Users/ivanjeremicx/Projects/zelavis/packages/ecommerce)  
  A low-level ecommerce core for building custom commerce platforms, CMS plugins, backend services, and embedded commerce workflows.
- [`@zelavis/ecommerce-express`](/Users/ivanjeremicx/Projects/zelavis/packages/ecommerce/integrations/express)  
  An Express integration package for exposing the ecommerce core over HTTP.
- [`@zelavis/ecommerce-hono`](/Users/ivanjeremicx/Projects/zelavis/packages/ecommerce/integrations/hono)  
  A Hono integration package for exposing the ecommerce core over HTTP.
- [`@zelavis/ecommerce-stripe`](/Users/ivanjeremicx/Projects/zelavis/packages/ecommerce/plugins/stripe)  
  A Stripe payment provider plugin for `@zelavis/ecommerce`.
- [`@zelavis/ecommerce-paypal`](/Users/ivanjeremicx/Projects/zelavis/packages/ecommerce/plugins/paypal)  
  A PayPal payment provider plugin for `@zelavis/ecommerce`.
- [`@zelavis/auth`](/Users/ivanjeremicx/Projects/zelavis/packages/auth)  
  A low-level authentication core for accounts, credentials, sessions, and opt-in auth method plugins.
- [`@zelavis/auth-email-password`](/Users/ivanjeremicx/Projects/zelavis/packages/auth/plugins/email-password)  
  An email/password auth plugin for `@zelavis/auth`.
- [`@zelavis/auth-username-password`](/Users/ivanjeremicx/Projects/zelavis/packages/auth/plugins/username-password)  
  A username/password auth plugin for `@zelavis/auth`.
- [`@zelavis/server`](/Users/ivanjeremicx/Projects/zelavis/packages/server)  
  Shared endpoint contract and framework adapters that mount endpoint manifests from zelavis packages.

## `@zelavis/database`

The database package is a core Zelavis service, but it uses the same service contract as extension services.

Current architecture includes:

- Tenant-aware document collections.
- A document API for create, read, query, update, and delete operations.
- An in-memory adapter for development and tests.
- An optional SQL capability contract for future SQLite-compatible adapters.
- `databaseService(database)` for mounting database routes through `@zelavis/server`, with documents exposed as a nested service.

The first implementation is intentionally portable and does not depend on `unstorage` or native SQLite bindings. Durable adapters should live in focused packages such as a future `@zelavis/database-node`, `@zelavis/database-d1`, or `@zelavis/database-libsql`.

## `@zelavis/ecommerce`

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

- [`examples/ecommerce-recurring-subscriptions.ts`](/Users/ivanjeremicx/Projects/zelavis/examples/ecommerce-recurring-subscriptions.ts)

The example uses these environment variables:

- `STRIPE_SECRET_KEY`
- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`

## Roadmap Direction

The repo is intentionally early and focused on foundations.

Near-term areas:

- More core packages under `packages/*`.
- Persistence adapters for tools like Prisma and Drizzle.
- Payment provider plugins for Stripe, PayPal, and similar gateways.
- Auth method plugins and storage adapters for `@zelavis/auth`.
- Better tests, fixtures, and package-level examples.

## Contributing

Contributors and coding agents should follow the guidance in [`AGENTS.md`](/Users/ivanjeremicx/Projects/zelavis/AGENTS.md).
