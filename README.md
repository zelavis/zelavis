# Zelavis

Build apps and websites. Manage data and content. Own your platform.

## What Zelavis Is

Zelavis is a platform for building and managing apps, websites, data, and content. Run it on your own infrastructure or use managed Zelavis on zelavis.com. Use Zelavis as your backend, host your projects, deploy existing applications, or install software like WordPress.

## Install

Production packages bundle a private pinned Node runtime, while developers who
already manage Node 24 can install from npm:

```bash
curl -fsSL https://zelavis.com/install.sh | sudo sh
# or
npm install --global zelavis
zelavis serve
```

APT, direct `.deb`, and manual `.tar.gz`/`.zip` releases use the same staged
Platform payload. See the [installation guide](website/src/content/docs/getting-started/installation.md)
and [distribution documentation](distribution/README.md).

## Product Model

Zelavis starts at a Projects overview. A project is the operational unit the dashboard manages:

- A **Zelavis-native project** gets project-local backend surfaces such as Auth, Database, Content, Media, Settings, and a project Marketplace for plugins.
- A **managed app project** can represent software Zelavis hosts or manages, such as WordPress, a static site, or a generic app. These projects should show hosting-style controls instead of Zelavis-native backend menus.
- The **global Marketplace** is outside any project and is for apps, starters, templates, and server provider plugins. Project plugins belong inside a Zelavis-native project.
- The **Server** area is outside projects and owns machine-level concerns such as domains, backups, and logs.

The current Node host can create multiple Zelavis App projects from the
shipped `@zelavis/app` service boilerplate. Each project locks its exact app
service version and runs with its own process and data directory. This default
is operational isolation for trusted code; stronger OCI and microVM drivers
remain future implementations of the same project-runtime contract.

Zelavis serves one dashboard application from the Platform OS. Project
runtimes do not contain hidden dashboard copies. When a user opens a project,
the Platform UI reads that runtime's service metadata and proxies its APIs, so
Database, Auth, Workloads, and installed plugin menus still come from the
project that owns them.

An app service is both the project recipe and the runtime service entrypoint.
It owns the app-facing modules, declares menu metadata, and gives project
creation a real boilerplate folder to copy or execute. WordPress-style app
services can follow the same shape later.

Native website hosting is part of the core product story. External hosts, storage providers, DNS providers, CDNs, and deploy targets can be connected through plugins, but they are optional user choices rather than Zelavis runtime targets.

Zelavis should still be easy to integrate with modern stateless protocols and AI
agent tooling. A Zelavis MCP server, deploy provider connector, or storage/email
connector can be stateless and can run on serverless or edge infrastructure if
that is the right plugin shape. That does not make serverless a core Zelavis
runtime target: the platform runtime, database, auth, dashboard, native website
hosting, server management, and future replication model stay self-hosted and
runtime-neutral.

## Principles

- App Platform first.
- Self-hostable and embeddable.
- Runtime-neutral core.
- Standard Web APIs over provider lock-in.
- Strong service contracts over hidden magic.
- Endpoint-backed capabilities over dashboard-only behavior.
- One core access-control model for owner, operator, reseller, customer,
  service-account, CLI, script, and AI-agent callers.
- Stateless connector-friendly endpoints without making serverless the core runtime.
- Mobile-slot-ready dashboard components over separate desktop/mobile implementations.
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
- **Workloads**: first-party project functions, jobs, schedules, and webhooks exposed through `@zelavis/app/workloads` and managed from the project dashboard.
- **Server management**: dashboard surfaces for domains, backups, logs, and local hosting operations.
- **Plugins**: optional domain and provider packages that extend the core platform.
- **Assistant**: System Store-backed project conversations exposed through the
  runtime API and rendered with assistant-ui in the desktop workspace and
  mobile slide slots. The current local responder routes supported requests;
  model providers, streaming, and tool execution are still in progress.

Dashboard feature work should be mobile-slot-ready by default. Desktop routes
compose reusable workspace and panel components into the main content area, and
future mobile browser or Capacitor shells can mount those same components into
slide-based navigation slots instead of rebuilding separate mobile screens.

## Endpoint-Backed Capabilities

The dashboard is a client of Zelavis, not the authority layer. Everything Zelavis can do should be available through a stable server capability and a versioned endpoint, so the same operation can be used by the dashboard, CLI, AI agents, scripts, plugins, and external admin tools.

That means platform features start in the service/runtime layer and then become HTTP API surface. UI buttons, charts, forms, and setup flows should call those capabilities instead of owning privileged behavior themselves.

Examples:

- a Linux security checklist should have a server capability and endpoint, not only a dashboard button
- resource charts should read resource telemetry endpoints, not dashboard-local logic once collectors exist
- domain, backup, service-install, and project actions should be scriptable through the API

## Access Control

Zelavis uses one core principal, permission, and scoped-grant model for the
control plane and project dashboards. The owner console, customer dashboard,
future reseller/operator dashboards, API keys, service accounts, scripts, CLI,
and AI agents should all pass through that same model.

The base authorization contract lives in `@zelavis/server`, because route
access requirements must be enforceable for every service no matter which auth
method produced the principal. `@zelavis/app/auth` owns accounts, credentials,
sessions, and pluggable authentication methods.

That split is important for the future official Hosting Provider module:
customers and resellers should not get a separate permission system. They
should be regular Zelavis principals with project-scoped grants. The same
`/zelavis` shell can then render an owner view, operator view, reseller view,
or customer view based on the current principal.

## Workspace

Packages live in [packages/](packages) and official plugins live in [plugins/](plugins).

Core packages:

- [packages/zelavis](packages/zelavis)
  The high-level runtime package. It composes core services such as auth, database, website, workloads, and dashboard delivery, and re-exports server adapters.
- [packages/zelavis/services/server](packages/zelavis/services/server)
  Shared service, endpoint, and framework adapter contracts for mounting Zelavis packages.
- [packages/zelavis/services/zelavis-app/src/auth](packages/zelavis/services/zelavis-app/src/auth)
  A low-level authentication core for accounts, credentials, sessions, and opt-in auth method services.
- [packages/zelavis/services/zelavis-app/src/db](packages/zelavis/services/zelavis-app/src/db)
  A document-first, tenant-aware database core with an in-memory driver, optional SQL capability, and a mountable server service.
- [packages/zelavis/services/ui](packages/zelavis/services/ui)
  The admin/dashboard frontend used by the high-level runtime.
- [packages/zelavis/services/zelavis-app/src/workloads](packages/zelavis/services/zelavis-app/src/workloads)
  A first-party core plugin for project-scoped functions, jobs, schedules, and webhooks.
- [packages/cli](packages/cli)
  Command-line tooling for Zelavis workflows.

Database adapters:

- [packages/zelavis/services/zelavis-app/adapters/bun-sqlite](packages/zelavis/services/zelavis-app/adapters/bun-sqlite)
  A Bun SQLite adapter package for `@zelavis/app/db`.
- [packages/zelavis/services/zelavis-app/adapters/node-sqlite](packages/zelavis/services/zelavis-app/adapters/node-sqlite)
  A Node.js SQLite adapter package for `@zelavis/app/db`.
- [packages/zelavis/services/zelavis-app/adapters/libsql](packages/zelavis/services/zelavis-app/adapters/libsql)
  A libSQL adapter package for `@zelavis/app/db`.

Auth plugins:

- [packages/zelavis/services/zelavis-app/plugins/email-password](packages/zelavis/services/zelavis-app/plugins/email-password)
  An email/password auth provider service for `@zelavis/app/auth`.
- [packages/zelavis/services/zelavis-app/plugins/username-password](packages/zelavis/services/zelavis-app/plugins/username-password)
  A username/password auth provider service for `@zelavis/app/auth`.

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
import { createNodeServer } from "zelavis/runtimes/node";

const zv = new Zelavis({ adapter: nodeAdapter() });
const server = await createNodeServer(zv);
```

Examples use `zv` as the short local name for a `Zelavis` runtime instance.

Zelavis can also run directly as a Web-style handler when an adapter is unnecessary:

```ts
import { Zelavis } from "zelavis";

const zv = new Zelavis({});

const response = await zv.fetch(
  new Request("http://localhost/zelavis/api/v1/runtime/config"),
);
```

SDK bundles are separate import surfaces of the same package. They talk to a
running Zelavis runtime through fetch-native endpoints and do not import the
dashboard, host runtimes, or local server adapters:

```ts
import { createBrowserZelavisClient } from "zelavis/sdk/browser";

const client = createBrowserZelavisClient({
  baseUrl: "https://example.com",
});

const config = await client.runtime.config();
```

Use `pnpm build:sdk:browser` or `pnpm build:sdk:node` to check those surfaces
without building runtime host utilities.

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
/zelavis/projects/default/workloads
/zelavis/api/v1/auth
/zelavis/api/v1/database
/zelavis/api/v1/workloads
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
/admin/projects/default/workloads
/admin/api/v1/auth
/admin/api/v1/database
/admin/api/v1/workloads
```

Use scoped packages such as `@zelavis/server`, `@zelavis/app/db`, and `@zelavis/app/auth` when building lower-level primitives, adapters, plugins, or tests that need direct package APIs.

## Core Services

Core services use the same service contract as extension services. The high-level `Zelavis` runtime currently includes dashboard delivery, auth, database, website, and workloads by default.

The dashboard and admin experience are still evolving. The runtime already serves the current UI package, but the overall product surface should be treated as early and subject to change.

Disable built-in core services when you need a smaller server:

```ts
const zv = new Zelavis({
  coreServices: {
    auth: false,
    dashboard: false,
    database: false,
    website: false,
    workloads: false,
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

Node.js is the current supported production host. Zelavis core packages remain
designed around JavaScript, TypeScript, and standard Web platform primitives
such as `Request`, `Response`, `Headers`, `URL`, streams, and standard `crypto`.

Runtime-specific behavior belongs in adapters. Provider-specific behavior belongs in plugins. The core platform should remain portable across Node, Bun, and future Deno without treating external deployment providers or framework mounts as runtime targets.

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
pnpm dev
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
