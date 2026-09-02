---
title: zelavis
---
`zelavis` is the framework and App Platform: the one official package for the
reusable backend engine, built-in App stack, and self-hosted Platform OS.

Use it when you want the default platform building blocks wired together through one runtime entry point.

## Current role

Today, that mostly means:

- dashboard delivery
- auth service
- database service
- storage service when an adapter file store exists
- website service
- service activation
- project and server dashboard surfaces
- runtime composition

## Main entry point

```ts
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";

const zv = new Zelavis({
  adapter: nodeAdapter(),
});
```

Treat this as the normal public API.

## High-level vs low-level

Prefer these layers in order:

1. `new Zelavis(...)` for application/runtime work
2. focused subpaths like `zelavis/core` for primitive-level infrastructure

The lower-level `zelavis()` function still exists, but it now intentionally owns the internal runtime controls such as:

- direct `services`
- path and mount overrides

The `Zelavis` class is the product-facing Platform OS entrypoint. With the Node
adapter it discovers shipped Project recipes (`kind: "app"` services),
persists Project records in the System Store, and
runs created Projects through the default process runtime driver. Lower-level
route mounting knobs stay on `zelavis()`.

Examples use `zv` as the short local name for a `Zelavis` runtime instance.

## Default behavior

By default, Zelavis owns one safe namespace under `/zelavis`. The Projects view
creates recipe-backed runtimes under `.zelavis/projects/<id>` and the Project
dashboard proxies API operations to the selected runtime.

The Platform process is the only process that mounts `@zelavis/ui`. Zelavis App
project processes remain headless and expose service metadata through
`zelavis/core`. The selected Project recipe composes Database, Auth, Workloads,
and plugins, and each service contributes menu metadata through the shared
service API.

The dashboard stays mounted under the configured root path, while API services stay grouped under `/api/<version>/...`.

The dashboard root opens Projects. Global surfaces such as Marketplace and Server live outside project URLs, while Zelavis-native project pages live under `/zelavis/projects/:projectId/*`.

The dashboard is a client of the runtime. Operations shown in the dashboard should also be available through stable runtime capabilities and versioned endpoints so CLI tools, AI agents, scripts, plugins, and external admin clients can perform the same work.

Default dashboard paths include:

```txt
/zelavis
/zelavis/marketplace
/zelavis/projects/:projectId
/zelavis/projects/:projectId/marketplace
/zelavis/projects/:projectId/settings
/zelavis/server
/zelavis/server/domains
/zelavis/server/backups
/zelavis/server/logs
/zelavis/projects/:projectId/workloads
```

The Node process driver is the simplest default isolation boundary. It provides
separate processes, databases, files, logs, and failure domains for trusted
projects. It does not claim secure multi-tenant sandboxing. Future OCI and
microVM drivers implement the same project-runtime contract.

Each Project locks its exact Zelavis App recipe/runtime version. Parent
Platform upgrades preserve that lock; immutable artifact execution will make
side-by-side old and new versions operational. A future Project Cell may also
manage nested Apps within a delegated allocation while the root Platform moves
the cell as one placement group.

Development application code can access the mounted Zelavis App service APIs through the runtime instance:

```ts
const tenantDb = zv.db.forTenant("tenant_acme");

await tenantDb.documents.createCollection({ name: "posts" });

const doc = await tenantDb.documents.insert({
  collection: "posts",
  data: { title: "Hello" },
});

const account = await zv.auth.accounts.create({
  id: "owner",
  email: "owner@example.com",
});
```

## When to use lower-level packages instead

Use scoped packages directly when you need lower-level control over primitives, adapters, or tests:

- `zelavis/core`
- `zelavis/app/db`
- `zelavis/app/auth`

The lower-level `zelavis()` function still exists for internal runtime composition, but the main public application-facing entry point is the `Zelavis` class plus a runtime adapter.

Available runtime adapters:

- `zelavis/adapters/node`
- `zelavis/adapters/bun`

Deno is a planned runtime target.

Serverless function platforms are not Zelavis runtime targets. Managed providers
may appear through optional plugins for user websites, storage, DNS, CDN, email,
or other provider adapters.

The main package also ships `zelavis/runtimes/node` for the standalone
long-running Node HTTP server. `zelavis/runtimes/bun` and
`zelavis/runtimes/deno` are separate runtime marker subpaths for bundle-aware
host selection. Fetch-native hosts can call `zv.fetch(request)` directly.

## SDK bundle surfaces

The official SDK is a bundle surface of `zelavis` itself. SDK entry points reuse
the portable app contracts and database core, but exclude the dashboard UI,
host runtime utilities, Node/Bun/Deno adapters, and project process
orchestration.

Available SDK entry points:

```txt
zelavis/sdk
zelavis/sdk/browser
zelavis/sdk/node
```

Use the browser SDK to talk to a running Zelavis Platform OS from browser code:

```ts
import { createBrowserZelavisClient } from "zelavis/sdk/browser";

const client = createBrowserZelavisClient({
  baseUrl: "https://example.com",
});

const settings = await client.runtime.settings();
```

The SDK surface also exposes runtime-neutral `zelavis/app/db` and
`zelavis/app/auth` APIs. Browser database adapters such as IndexedDB or SQLite
WASM should plug into the same database driver boundary later, so local-first
browser apps and server runtimes share the same document/event model.

Build only the SDK surfaces with:

```sh
pnpm build:sdk
pnpm build:sdk:browser
pnpm build:sdk:node
```

## Related docs

- [First Runtime](../getting-started/first-runtime.md)
- [zelavis/core](./server.md)
- [Endpoint-Backed Capabilities](../architecture/endpoint-backed-capabilities.md)
- [@zelavis/db](./database.md)
- [@zelavis/auth](./auth.md)
- [@zelavis/ui](./ui.md)
- [@zelavis/workloads](./workloads.md)
