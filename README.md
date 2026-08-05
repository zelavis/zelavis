# Zelavis

Zelavis is an early-stage, self-hostable App Platform for building, hosting, and operating modern web applications from one composable TypeScript workspace.

It brings together backend primitives, runtime composition, an admin dashboard, database tooling, authentication, plugins, native website hosting, and server/project control surfaces without tying the core to one JavaScript runtime, framework, or hosting provider.

Zelavis is foundation-first today. The current repository already includes working packages for auth, database, server composition, runtime mounting, dashboard delivery, framework adapters, and optional domain plugins. The broader platform surface is still evolving.

## What Zelavis Is

Zelavis is designed to become the application control plane for teams that want to own their infrastructure and product surface.

The platform direction includes:

- Application runtime composition.
- Authentication and identity primitives.
- Tenant-aware database and data administration.
- Admin/dashboard UI.
- Native website hosting from the Zelavis runtime.
- Project management for Zelavis-native apps and managed apps such as WordPress, static sites, or generic hosted software.
- Server management surfaces for domains, backups, logs, and local app hosting.
- Plugin and package extensibility.
- Framework and host adapters.
- Operational tooling, including optional external deployment/provider plugins when the user chooses them.
- Optional domain packages for larger product systems.

The goal is not a loose collection of utilities. Zelavis is being shaped as a coherent App Platform: something you can embed inside an existing app, self-host as an admin surface, or extend into a larger product platform.

## Product Model

Zelavis starts at a Projects overview. A project is the operational unit the dashboard manages:

- A **Zelavis-native project** gets project-local backend surfaces such as Auth, Database, Content, Media, Settings, and a project Marketplace for plugins.
- A **managed app project** can represent software Zelavis hosts or manages, such as WordPress, a static site, or a generic app. These projects should show hosting-style controls instead of Zelavis-native backend menus.
- The **global Marketplace** is outside any project and is for apps, starters, templates, and server provider plugins. Project plugins belong inside a Zelavis-native project.
- The **Server** area is outside projects and owns machine-level concerns such as domains, backups, and logs.

Native website hosting is part of the core product story. External hosts, storage providers, DNS providers, CDNs, and deploy targets can be connected through plugins, but they are optional user choices rather than Zelavis runtime targets.

## Principles

- App Platform first.
- Self-hostable and embeddable.
- Runtime-neutral core.
- Standard Web APIs over provider lock-in.
- Strong service contracts over hidden magic.
- Endpoint-backed capabilities over dashboard-only behavior.
- Small, composable package surfaces.
- Clear provider, adapter, plugin, and service boundaries.
- Honest documentation about what exists today and what is still in progress.

Zelavis is intended for developers building custom software, internal platforms, SaaS backends, CMS systems, multi-tenant applications, admin panels, plugins, and reusable infrastructure components.

## Current Platform Layers

Zelavis currently focuses on these layers:

- **Runtime**: a high-level `Zelavis` runtime that composes services and exposes a Web-style request handler.
- **Server**: shared endpoint contracts and adapter utilities for mounting services across host frameworks.
- **Auth**: account, credential, session, and pluggable authentication method primitives.
- **Database**: tenant-aware document collections with development drivers and SQL-capable adapters.
- **Dashboard**: an admin UI package mounted by the runtime at the platform root path, opening to Projects and then into project-local control surfaces.
- **CLI**: workspace tooling for future platform and developer workflows.
- **Website hosting**: built-in public page delivery from the Zelavis runtime, with dashboard and API routes kept under a reserved platform namespace.
- **Server management**: dashboard surfaces for domains, backups, logs, and local hosting operations.
- **Plugins**: optional domain and provider packages that extend the core platform.

## Endpoint-Backed Capabilities

The dashboard is a client of Zelavis, not the authority layer. Everything Zelavis can do should be available through a stable server capability and a versioned endpoint, so the same operation can be used by the dashboard, CLI, AI agents, scripts, plugins, and external admin tools.

That means platform features start in the service/runtime layer and then become HTTP API surface. UI buttons, charts, forms, and setup flows should call those capabilities instead of owning privileged behavior themselves.

Examples:

- a Linux security checklist should have a server capability and endpoint, not only a dashboard button
- resource charts should read resource telemetry endpoints, not dashboard-local logic once collectors exist
- domain, backup, service-install, and project actions should be scriptable through the API

## Workspace

Packages live in [packages/](packages) and official plugins live in [plugins/](plugins).

Core packages:

- [packages/zelavis](packages/zelavis)
  The high-level runtime package. It composes core services such as auth, database, and dashboard delivery, and re-exports server adapters.
- [packages/server](packages/server)
  Shared service, endpoint, and framework adapter contracts for mounting Zelavis packages.
- [packages/auth](packages/auth)
  A low-level authentication core for accounts, credentials, sessions, and opt-in auth method services.
- [packages/db](packages/db)
  A document-first, tenant-aware database core with an in-memory driver, optional SQL capability, and a mountable server service.
- [packages/ui](packages/ui)
  The admin/dashboard frontend used by the high-level runtime.
- [packages/cli](packages/cli)
  Command-line tooling for Zelavis workflows.

Database adapters:

- [packages/db/adapters/bun-sqlite](packages/db/adapters/bun-sqlite)
  A Bun SQLite adapter package for `@zelavis/db`.
- [packages/db/adapters/node-sqlite](packages/db/adapters/node-sqlite)
  A Node.js SQLite adapter package for `@zelavis/db`.
- [packages/db/adapters/libsql](packages/db/adapters/libsql)
  A libSQL adapter package for `@zelavis/db`.

Auth plugins:

- [packages/auth/plugins/email-password](packages/auth/plugins/email-password)
  An email/password auth provider service for `@zelavis/auth`.
- [packages/auth/plugins/username-password](packages/auth/plugins/username-password)
  A username/password auth provider service for `@zelavis/auth`.

Official domain plugins:

- [plugins/ecommerce](plugins/ecommerce)
  An optional ecommerce core for customers, products, coupons, orders, and payment workflows.
- [plugins/ecommerce/plugins/stripe](plugins/ecommerce/plugins/stripe)
  A Stripe payment provider service for `@zelavis/ecommerce`.
- [plugins/ecommerce/plugins/paypal](plugins/ecommerce/plugins/paypal)
  A PayPal payment provider service for `@zelavis/ecommerce`.

## Runtime Defaults

Applications should usually import from `zelavis`, where core services are included by default:

```ts
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { createNodeServer } from "zelavis/node";

const zv = new Zelavis({ adapter: nodeAdapter() });
const server = await createNodeServer(zv);
```

Examples use `zv` as the short local name for a `Zelavis` runtime instance.

Zelavis can also run directly as a Web-style handler when an adapter is unnecessary:

```ts
import { Zelavis } from "zelavis";

const zv = new Zelavis({});

const response = await zv.fetch(
  new Request("http://localhost/zelavis/api/v1/dashboard/config"),
);
```

When a host framework needs fallthrough-aware mounting, use its thin utility instead. For example, h3 apps can use `app.use("/**", h3Handler(zv))` while still keeping Zelavis at `/zelavis`.

By default, Zelavis owns one safe namespace:

```txt
/zelavis
/zelavis/marketplace
/zelavis/projects/default
/zelavis/projects/default/marketplace
/zelavis/projects/default/settings
/zelavis/server
/zelavis/server/domains
/zelavis/server/backups
/zelavis/server/logs
/zelavis/api/v1/auth
/zelavis/api/v1/database
```

Customize that namespace with `rootPath`:

```ts
const zv = new Zelavis({
  rootPath: "/admin",
});
```

That moves the dashboard and APIs together:

```txt
/admin
/admin/marketplace
/admin/projects/default
/admin/projects/default/marketplace
/admin/projects/default/settings
/admin/server
/admin/server/domains
/admin/server/backups
/admin/server/logs
/admin/api/v1/auth
/admin/api/v1/database
```

Use scoped packages such as `@zelavis/server`, `@zelavis/db`, and `@zelavis/auth` when building lower-level primitives, adapters, plugins, or tests that need direct package APIs.

## Core Services

Core services use the same service contract as extension services. The high-level `Zelavis` runtime currently includes dashboard delivery, auth, and database by default.

The dashboard and admin experience are still evolving. The runtime already serves the current UI package, but the overall product surface should be treated as early and subject to change.

Disable built-in core services when you need a smaller server:

```ts
const zv = new Zelavis({
  coreServices: {
    auth: false,
    dashboard: false,
    database: false,
  },
});
```

Configure the built-in database service when the defaults are not enough:

```ts
const zv = new Zelavis({
  coreServices: {
    database: {
      defaultTenantId: "acme",
    },
  },
});
```

Configure the built-in auth service through `coreServices.auth`, including auth provider services and repositories:

```ts
const zv = new Zelavis({
  coreServices: {
    auth: {
      authOptions: {
        services: [emailPasswordService({ verifyPasswordHash })],
      },
    },
  },
});
```

Current database architecture includes:

- Tenant-aware document collections.
- A document API for create, read, query, update, and delete operations.
- An in-memory driver for development and tests.
- Optional SQL capability contracts.
- SQLite and libSQL adapter packages.
- `defineDatabaseService(database)` for mounting database routes through `@zelavis/server`, with documents exposed as a nested service.

The core implementation is intentionally portable and does not depend on native bindings or host-specific storage APIs. Durable database drivers live behind adapter packages.

## Runtime Independence

Zelavis core packages are designed around JavaScript, TypeScript, and standard Web platform primitives such as `Request`, `Response`, `Headers`, `URL`, streams, and standard `crypto`.

Runtime-specific behavior belongs in adapters. Provider-specific behavior belongs in plugins. The core platform should remain portable across Node, Bun, future Deno, and framework utilities without treating external deployment providers as runtime targets.

## Error Model

Zelavis packages follow a shared internal error rule:

- Expected domain failures use typed internal errors such as validation, conflict, and not-found errors.
- Transport layers such as HTTP services map those known domain errors centrally instead of hand-rolling status codes in each route.
- Unexpected runtime and infrastructure failures still throw normally and bubble as true server errors.

That keeps public APIs ergonomic while making core behavior explicit inside the platform packages.

## Optional Domain Plugin: `@zelavis/ecommerce`

The ecommerce plugin focuses on the primitives required to build larger commerce systems without prescribing the final product.

Current architecture includes:

- Typed domain models for customers, products, coupons, orders, and payment attempts.
- Repository contracts that isolate persistence from business logic.
- In-memory repository implementations for development and tests.
- A service-oriented payment layer for provider adapters.

This package is meant to support use cases such as:

- Building commerce workflows on top of an existing app or CMS.
- Building a custom commerce system with your own admin and storefront layers.
- Embedding commerce operations directly inside a backend application.
- Creating provider adapters and storage adapters without rewriting the core domain.

## Getting Started

Install dependencies:

```bash
pnpm install
```

Run package scripts from the workspace root or target a specific package:

```bash
pnpm check
pnpm test
pnpm audit:security
pnpm ci:runtime
pnpm ci:ui
pnpm build
pnpm --filter @zelavis/ecommerce typecheck
pnpm --filter @zelavis/ecommerce build
```

The main local dashboard workflow is:

```bash
pnpm run ui:dev
```

That starts the Zelavis runtime on `http://127.0.0.1:3000`, the UI dev server on `http://127.0.0.1:3001`, and redirects dashboard requests under `/zelavis` to the live UI dev server.

## CI Baseline

The repository keeps a focused baseline CI workflow:

- `pnpm check` for workspace typechecks.
- `pnpm --filter zelavis test` for the main runtime package.
- `pnpm ci:ui` for a mounted desktop dashboard Playwright pass.
- `pnpm audit:security` to fail when moderate-or-higher vulnerabilities re-enter the lockfile.

That keeps the default branch honest without forcing every package and example into one heavy pipeline.

Dependabot is configured for weekly npm and GitHub Actions update PRs, and a companion workflow enables squash auto-merge for safe patch and minor Dependabot updates after checks pass.

The repository currently uses protected `main`, repository-level auto-merge, private vulnerability reporting, issue forms, and GitHub Discussions to keep collaboration orderly as the project grows.

## Community

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [SECURITY.md](SECURITY.md)
- [MAINTAINERS.md](MAINTAINERS.md)

Maintainers publishing packages should follow the [release workflow](CONTRIBUTING.md#release-workflow) in CONTRIBUTING.md.
If you use `NPM_TOKEN`, set it in your local shell or CI secret store. Do not commit tokens to this repository.
