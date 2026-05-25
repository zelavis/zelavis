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
- Clear provider, adapter, and service boundaries.

This repository is intended for developers building custom software, internal tools, multi-tenant backends, CMS systems, platform services, plugins, and reusable infrastructure components.

## Community Files

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [SECURITY.md](SECURITY.md)
- [MAINTAINERS.md](MAINTAINERS.md)

## Current shape

Zelavis currently focuses on these platform layers:

- Auth primitives and pluggable authentication methods.
- A tenant-aware, document-first database core.
- Shared server contracts and HTTP adapters.
- A high-level runtime package that composes core services.
- An admin UI package that powers the runtime dashboard shell.

The repository also contains `@zelavis/ecommerce` as an optional domain package built with the same extensibility patterns.

## Workspace

Packages live in [packages/](packages).

Current packages:

- [packages/zelavis](packages/zelavis)
  The high-level runtime package. It composes core services such as auth, database, and dashboard delivery, and re-exports server adapters.
- [packages/db](packages/db)
  A document-first, tenant-aware database core with an in-memory driver, optional SQL capability, and a mountable server service.
- [packages/db/adapters/bun-sqlite](packages/db/adapters/bun-sqlite)
  A Bun SQLite adapter package for `@zelavis/db` using the built-in `bun:sqlite` module.
- [packages/db/adapters/node-sqlite](packages/db/adapters/node-sqlite)
  A Node.js SQLite adapter package for `@zelavis/db` using `better-sqlite3`.
- [packages/auth](packages/auth)
  A low-level authentication core for accounts, credentials, sessions, and opt-in auth method services.
- [packages/server](packages/server)
  Shared endpoint contracts and framework adapters that mount service APIs from Zelavis packages.
- [packages/ui](packages/ui)
  The admin/dashboard frontend used by the high-level runtime.
- [plugins/ecommerce](plugins/ecommerce)
  An optional low-level ecommerce core for building custom commerce platforms, CMS services, and embedded commerce workflows.
- []()
  An Express adapter package for exposing the ecommerce core over HTTP.
- []()
  A Hono adapter package for exposing the ecommerce core over HTTP.
- [plugins/ecommerce/plugins/stripe](plugins/ecommerce/plugins/stripe)
  A Stripe payment provider service for `@zelavis/ecommerce`.
- [plugins/ecommerce/plugins/paypal](plugins/ecommerce/plugins/paypal)
  A PayPal payment provider service for `@zelavis/ecommerce`.
- [packages/auth/plugins/email-password](packages/auth/plugins/email-password)
  An email/password auth provider service for `@zelavis/auth`.
- [packages/auth/plugins/username-password](packages/auth/plugins/username-password)
  A username/password auth provider service for `@zelavis/auth`.

## Runtime Defaults

Applications should usually import from `zelavis`, where core services are included by default:

```ts
import { zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";

const runtime = await zelavis();
const server = nodeAdapter(runtime);
```

Maintainers publishing packages should follow the [release workflow](CONTRIBUTING.md#release-workflow) in CONTRIBUTING.md.
If you use `NPM_TOKEN`, set it in your local shell or CI secret store. Do not
commit tokens to this repository.

Zelavis can also run directly as a Web-style handler when an adapter is unnecessary:

```ts
import { zelavis } from "zelavis";

const runtime = await zelavis({});

const response = await runtime.fetch(
  new Request("http://localhost/zelavis/api/v1/dashboard/config"),
);
```

When a host framework needs fallthrough-aware mounting, use its thin adapter instead. For example, h3 apps can use `app.use("/**", h3Adapter(runtime))` while still keeping Zelavis at `/zelavis`.

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
});
```

That moves the dashboard and APIs together:

```txt
/admin
/admin/api/v1/auth
/admin/api/v1/database
```

Use scoped packages such as `@zelavis/server`, `@zelavis/db`, and `@zelavis/auth` when building lower-level primitives, adapters, plugins, or tests that need direct package APIs.

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
});
```

Configure the built-in auth service through `coreServices.auth`, including auth provider services and repositories:

```ts
await zelavis({
  coreServices: {
    auth: {
      authOptions: {
        services: [emailPasswordService({ verifyPasswordHash })],
      },
    },
  },
});
```

Current architecture includes:

- Tenant-aware document collections.
- A document API for create, read, query, update, and delete operations.
- An in-memory driver for development and tests.
- An optional SQL capability contract plus a Bun SQLite adapter via `@zelavis/db-bun-sqlite`.
- An optional SQL capability contract plus a Node SQLite adapter via `@zelavis/db-node-sqlite`.
- `defineDatabaseService(database)` for mounting database routes through `@zelavis/server`, with documents exposed as a nested service.

The core implementation is intentionally portable and does not depend on `unstorage` or native SQLite bindings. Durable database drivers should be supplied by platform adapters such as `@zelavis/db-bun-sqlite`, `@zelavis/db-node-sqlite`, or future `@zelavis/adapter-cloudflare` and `@zelavis/adapter-turso` packages.

## Error Model

Zelavis packages now follow a shared internal error rule:

- Expected domain failures use typed internal errors such as validation, conflict, and not-found errors.
- Transport layers such as HTTP services map those known domain errors centrally instead of hand-rolling status codes in each route.
- Unexpected runtime and infrastructure failures still throw normally and bubble as true server errors.

That keeps the public APIs ergonomic while making core behavior more explicit inside the platform packages.

## Optional domain package: `@zelavis/ecommerce`

The ecommerce package focuses on the primitives required to build larger commerce systems without prescribing the final product.

Current architecture includes:

- Typed domain models for customers, products, coupons, orders, and payment attempts.
- Repository contracts that isolate persistence from business logic.
- In-memory repository implementations for development and tests.
- A service-oriented payment layer for providers such as Stripe, PayPal, and others.


This package is meant to support use cases such as:

- Building a WooCommerce-like plugin on top of an existing app or CMS.
- Building a PrestaShop-like commerce system with your own admin and storefront layers.
- Embedding commerce operations directly inside a backend application.
- Creating provider adapters and storage adapters without rewriting the core domain.

## Getting Started

Install dependencies:

```bash
pnpm install
```

Run package scripts from the workspace root or target a specific package:

```bash
pnpm typecheck
pnpm test
pnpm audit:security
pnpm ci:runtime
pnpm ci:ui
pnpm build
pnpm --filter @zelavis/ecommerce typecheck
pnpm --filter @zelavis/ecommerce build
```

## CI Baseline

The repository keeps a small baseline CI workflow:

- `pnpm check` for workspace typechecks
- `pnpm --filter zelavis test` for the main runtime package
- `pnpm ci:ui` for a mounted desktop dashboard Playwright pass
- `pnpm audit:security` to fail when moderate-or-higher vulnerabilities re-enter the lockfile

That keeps the default branch honest without forcing every package and example into one heavy pipeline.

Dependabot is also configured for weekly npm and GitHub Actions update PRs, and a companion workflow enables squash auto-merge for safe patch and minor Dependabot updates after checks pass.

The repository currently uses protected `main`, repository-level auto-merge,
private vulnerability reporting, issue forms, and GitHub Discussions to keep
collaboration orderly as the project grows.

## Usage Example

For a unified recurring billing flow (Stripe + PayPal) through the ecommerce core, see:

- [examples/bun](examples/bun)
- [examples/nodejs/index.ts](examples/nodejs/index.ts)
- [examples/cloudflare](examples/cloudflare)
- [examples/elysia](examples/elysia)
- [examples/express/index.ts](examples/express/index.ts)
- [examples/fastify](examples/fastify)
- [examples/h3](examples/h3)
- [examples/hono/index.ts](examples/hono/index.ts)
- [examples/nextjs](examples/nextjs)
- [examples/nextjs-pages-router](examples/nextjs-pages-router)
- [examples/web-fetch](examples/web-fetch)
- [plugins/ecommerce/ecommerce-recurring-subscriptions.ts](plugins/ecommerce/ecommerce-recurring-subscriptions.ts)

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
- Payment provider services for Stripe, PayPal, and similar gateways.
- Auth method services and storage adapters for `@zelavis/auth`.
- Better tests, fixtures, and package-level examples.

## Contributing

Contributors and coding agents should follow the guidance in [AGENTS.md](AGENTS.md).

Maintainers publishing packages should follow the [release workflow](CONTRIBUTING.md#release-workflow) in CONTRIBUTING.md.
If you use `NPM_TOKEN`, set it in your local shell or CI secret store. Do not
commit tokens to this repository.
