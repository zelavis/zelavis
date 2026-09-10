# Zelavis

**The App Platform.** Plan, build, and manage apps together, on infrastructure you own.

## What Zelavis Is

Zelavis is a platform for building and managing apps, websites, data, and content. Run it on your own infrastructure or use managed Zelavis on zelavis.com. Use Zelavis as your backend, host your projects, deploy existing applications, or install software like WordPress.

Project planning and real-time collaboration are committed roadmap direction, not shipped behavior. See the Project Vision section of `AGENTS.md`.

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
- The **global Marketplace** is outside any project and is for Project recipes presented as apps and starters, plus templates and server provider plugins. Project plugins belong inside a Zelavis-native project.
- The **Server** area is outside projects and owns machine-level concerns such as domains, backups, and logs.

The current Node host can create multiple Zelavis App projects from the
shipped `zelavis/app` Project recipe. Each project locks its exact recipe
version and runs with its own process and data directory. This default
is operational isolation for trusted code; stronger OCI and microVM drivers
remain future implementations of the same project-runtime contract.

Zelavis serves one dashboard application from the Platform OS. Project
runtimes do not contain hidden dashboard copies. When a user opens a project,
the Platform UI reads that runtime's service metadata and proxies its APIs, so
Database, Auth, Workloads, and installed plugin menus still come from the
project that owns them.

A Project recipe is a versioned create-project definition and runtime
entrypoint implemented as a service with `kind: "app"`. Its optional Project
metadata declares runtime compatibility. It owns provisioning, default files, menu metadata, and the
app-facing runtime services mounted in the created Project. Zelavis App and
WordPress are official Project recipes. Services with `kind: "plugin"` extend
the Platform or a Project runtime but are not create-project options, and
services with `kind: "frontend"` are the face of an installation or a Project.

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
- **Workloads**: first-party project functions, jobs, schedules, and webhooks exposed through `zelavis/app/workloads` and managed from the project dashboard.
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

The base authorization contract lives in `zelavis/core`, because route
access requirements must be enforceable for every service no matter which auth
method produced the principal. `zelavis/app/auth` owns accounts, credentials,
sessions, and pluggable authentication methods.

That split is important for the future official Hosting Provider module:
customers and resellers should not get a separate permission system. They
should be regular Zelavis principals with project-scoped grants. The same
`/zelavis` shell can then render an owner view, operator view, reseller view,
or customer view based on the current principal.

## Workspace

Packages live in [packages/](packages) and official plugins live in [plugins/](plugins).

Core package and public surfaces:

- [packages/zelavis](packages/zelavis)
  The unified framework and App Platform. Reusable runtime and Fabric code is
  under `src/core`; the official versioned App recipe, Auth, Database, and
  Workloads stack is under `src/app`; trusted product services are under
  `src/platform`.
- [packages/zelavis/src/core](packages/zelavis/src/core)
  Public `zelavis/core`, `zelavis/runtime`, `zelavis/fabric`,
  `zelavis/workload`, `zelavis/artifact`, and `zelavis/provider` surfaces.
- [packages/zelavis/src/app](packages/zelavis/src/app)
  Public `zelavis/app`, `zelavis/app/auth`, and `zelavis/app/workloads`
  surfaces.
- [packages/zelavis/src/dbnew](packages/zelavis/src/dbnew)
  Public `zelavis/dbnew` multi-model object store and its Node opener.
- [packages/zelavis/src/platform](packages/zelavis/src/platform)
  Trusted Platform control-plane and Marketplace product services.
- [packages/zelavis/product-services/zelavis-ui](packages/zelavis/product-services/zelavis-ui)
  The admin/dashboard frontend used by the high-level runtime.
- [packages/cli](packages/cli)
  Command-line tooling for Zelavis workflows.

Database adapters:

- `zelavis/dbnew/node`
  Opens a sharded database for a Node host and closes it on shutdown.
- `zelavis/dbnew/node-sqlite`
  The `node:sqlite` object store one shard is built on.

Auth plugins:

- [plugins/auth-oidc](plugins/auth-oidc)
  Accepts JWT bearer tokens issued by an external OpenID Connect provider.

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

Use scoped packages such as `zelavis/core`, `zelavis/dbnew`, and `zelavis/app/auth` when building lower-level primitives, adapters, plugins, or tests that need direct package APIs.

## Core Services

Core services use the same service contract as extension services. The high-level `Zelavis` runtime currently includes dashboard delivery, auth, database, website, and workloads by default.

The dashboard and admin experience are still evolving. The runtime already serves the current UI package, but the overall product surface should be treated as early and subject to change.

Platform subsystems are composed through `zelavis(...)`, not the public
constructor, which refuses them: what an installation runs is decided by what
is installed, not by switches in code.

```ts
import { zelavis } from "zelavis";

const runtime = await zelavis({
  subsystems: { database: false, workloads: false },
});
```

Configure the built-in database service when the defaults are not enough:

Password sign-in is part of Zelavis, so an installation can be adopted with
nothing installed first. One provider covers both identifier kinds: an
identifier containing `@` is treated as an email address, anything else as a
username.

```ts
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";

const zv = new Zelavis({
  bootstrap: { token: process.env.ZELAVIS_BOOTSTRAP_TOKEN! },
  adapter: nodeAdapter(),
});
```

The bootstrap token must contain at least 32 characters. It is needed only to
claim the first owner and is not a login credential. The dashboard performs
bootstrap, login, rotation, and logout through the same versioned Auth
endpoints available to SDKs and scripts.

Current database architecture includes:

- Tenant-aware document collections.
- A document API for create, read, query, update, and delete operations.
- An in-memory driver for development and tests.
- Optional SQL capability contracts.
- SQLite and libSQL adapter packages.
- `defineDatabaseService(database)` for mounting database routes through `zelavis/core`, with documents exposed as a nested service.

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

## Security

If you discover a security vulnerability in Zelavis, please report it responsibly rather than opening a public issue.

Email **security@zelavis.com** with details, and we'll acknowledge your report, investigate promptly, and keep you posted as we work toward a fix. Once resolved, we're happy to credit you in the release notes with your permission.
