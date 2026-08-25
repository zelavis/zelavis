# zelavis

`zelavis` is the Platform OS package for the Zelavis App Platform.

It owns the long-running control plane, dashboard composition, System Store,
service lifecycle, official service directory, and server/project orchestration.
Lower-level packages such as `@zelavis/server`, `@zelavis/app/db`, and
`@zelavis/app/auth` remain independently useful primitives.

The Platform mounts `@zelavis/fabric` as a trusted core service. Fabric begins
as an honest single-node inventory and project-placement capability, then grows
into the node, routing, balancing, migration, recovery, and replication control
plane for multi-machine installations. It places every managed project kind;
only Zelavis App projects receive the deeper tenant-aware database placement,
sharding, replica, and schema-rollout capabilities.

The Platform OS creates projects from services with `kind: "app"`. With the
Node adapter, every project receives its own data directory and long-running
Node process. The driver provides operational isolation for trusted projects
and can later be replaced by an OCI or stronger isolation driver without
changing the project API.

Platform records use a separate System Store. Node and Bun local adapters
default to `.zelavis/system/zelavis.sqlite`; project data remains in the project
database and is never exposed through that store.

The Platform does not mount `@zelavis/app/db` as a global application database by
default. Node process projects live under `.zelavis/projects/<projectId>`; each
has an app database at `.zelavis/zelavis.sqlite` and private runtime metadata at
`.zelavis/runtime/zelavis.sqlite` relative to its project directory. There is
no implicit `default` project.

Project lifecycle endpoints are available under
`/zelavis/api/v1/runtime/projects`. The dashboard uses these same endpoints to
create, list, start, and stop projects, and project dashboard API traffic is
proxied to the selected project's runtime.

The Platform OS also owns Assistant threads. `createAssistantManager(...)`
stores project-scoped conversations in the System Store and delegates replies
to a `ZelavisAssistantResponder`. The default `zelavis-local-router` provides a
small deterministic development responder. It is not an LLM and does not run
tools. Applications can replace it through
`new Zelavis({ assistant: responder })`, while clients use stable endpoints under
`/zelavis/api/v1/runtime/assistant`.

Only the Platform OS mounts `@zelavis/ui`. A Zelavis App project process is headless:
it serves its application APIs plus `@zelavis/server` runtime metadata, but no
dashboard shell or dashboard assets. The Platform dashboard uses the project
proxy to read that metadata and render the Zelavis App services' own menu declarations.

Project boilerplates are app services. The selected app service is locked into
the project record and owns its setup behavior, menu metadata, and app-facing
runtime services through the shared service contract.

The dashboard opens to Projects. Project-local Zelavis surfaces live under
`/zelavis/projects/:projectId/*`, global app/server discovery lives under
`/zelavis/marketplace`, global management routes live outside projects, and
server-owned operation routes live under `/zelavis/server/*`.
Fabric operations and settings live under `/zelavis/server/fabric/*`, backed by
versioned endpoints under `/zelavis/api/v1/fabric/*`.

The dashboard is a client of the runtime, not the source of truth. Any operation
available in the dashboard should also be exposed through a stable runtime
capability and versioned endpoint so CLI tools, AI agents, scripts, plugins, and
external admin clients can perform the same work.

## Install and run

Developers who already manage Node 24 can install the public package directly:

```bash
npm install --global zelavis
zelavis serve
```

Production archives and operating-system packages carry a private pinned Node
runtime, so they do not require or modify the server's global Node installation.
The public command is the same in every delivery format. By default it listens
on `127.0.0.1:3000`, stores Platform state in `.zelavis`, and serves the
dashboard at `/zelavis`.

```bash
zelavis serve --host 0.0.0.0 --port 3000 --data-dir /var/lib/zelavis
zelavis services list
```

See the public installation guide for APT, direct `.deb`, archive, and quick
installer workflows.

## Entry point preference

Use the package in this order:

1. `new Zelavis(...)` for application/runtime code
2. scoped packages like `@zelavis/server` when you are building primitives, tests, or custom infrastructure

The class is the safe batteries-included API. The lower-level `zelavis(...)` function exists for internal runtime composition and is not the public application convention.

## Import split

Use `Zelavis` for application and runtime code:

```ts
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { createNodeServer } from "zelavis/runtimes/node";

const zv = new Zelavis({ adapter: nodeAdapter() });
const server = await createNodeServer(zv);
```

Examples use `zv` as the short local name for a `Zelavis` runtime instance.

Or embed the runtime directly in a Web/fetch environment:

```ts
import { Zelavis } from "zelavis";

const zv = new Zelavis({});

export function GET(request: Request) {
  return zv.fetch(request);
}
```

Use scoped packages when building lower-level primitives, adapters, services, or tests that need direct package APIs:

```ts
import { defineService } from "zelavis";
import { authService } from "@zelavis/app/auth";
```

Services are the public extension unit. A service can be a dashboard extension,
provider, hosted website/webapp, or a combination of those capabilities.

Service loading stays pure ESM. Zelavis exposes helpers such as
`loadService(...)`, `loadServiceRegistry(...)`, `resolveServiceModule(...)`,
and `removeServiceFromRegistry(...)` so install/load/remove flows stay inside
standard JavaScript module semantics instead of Node-specific loaders.

For runtime composition, Zelavis supports a service registry option with real
install state and activation order:

```ts
import { createServiceRegistry, defineService, Zelavis } from "zelavis";

const ecommerce = defineService({
  name: "@zelavis/ecommerce",
  kind: "plugin",
  capabilities: ["api:routes", "dashboard:menu"],
  childServices: ["@zelavis/ecommerce-stripe", "@zelavis/ecommerce-paypal"],
  menu: {
    title: "Ecommerce",
    path: "/commerce",
  },
});

const zv = new Zelavis({
  services: {
    entries: createServiceRegistry([
      {
        service: ecommerce,
        status: "installed",
        source: "official",
        order: 0,
      },
    ]),
  },
});
```

Service setup receives standard JavaScript data only:

- mounted `rootPath`
- API path information
- platform summary (`presets`, resource availability, metadata)
- already collected runtime services plus `addService(...)`

That keeps service setup runtime-neutral while still giving services enough
context to register extra runtime routes.

The lower-level `zelavis(...)` function owns internal runtime controls such as
direct `runtimeServices` or path/mount overrides. Public application examples
should use `new Zelavis(...)`.

## Usage

```ts
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { createNodeServer } from "zelavis/runtimes/node";

const zv = new Zelavis({ adapter: nodeAdapter() });
const server = await createNodeServer(zv);

server.listen(3000);
```

When you do not need the standalone Node HTTP server, use the Web-style runtime
handler directly:

```ts
const zv = new Zelavis({});

const response = await zv.fetch(
  new Request("http://localhost/zelavis/api/v1/runtime/config"),
);
```

`new Zelavis(...)` is the guarded high-level entrypoint. It accepts app-facing options such as adapters, root path, service registry state, and error handling. Internal runtime knobs like direct `runtimeServices` and path overrides stay on the lower-level `zelavis(...)` function.

That split is intentional:

- the class is for real application code
- the function is for internal/runtime-facing work

Application code can use the core services through the runtime instance:

```ts
await zv.db.documents.createCollection({ name: "posts" });

const doc = await zv.db.documents.insert({
  collection: "posts",
  data: { title: "Hello", published: false },
});

await zv.db.documents.update({
  collection: "posts",
  id: doc.id,
  data: { published: true },
  mode: "merge",
});
```

By default, Zelavis owns one safe namespace:

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
/zelavis/api/v1/runtime/config
/zelavis/api/v1/runtime/settings
/zelavis/api/v1/runtime/assistant/threads
/zelavis/api/v1/runtime/assistant/threads/:threadId/messages
/zelavis/api/v1/auth
/zelavis/api/v1/database
/zelavis/api/v1/storage/files/*
/zelavis/api/v1/website/pages
/zelavis/api/v1/workloads/*
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
/admin/projects/:projectId
/admin/projects/:projectId/marketplace
/admin/projects/:projectId/settings
/admin/server
/admin/server/domains
/admin/server/backups
/admin/server/logs
/admin/projects/:projectId/workloads
/admin/api/v1/runtime/config
/admin/api/v1/runtime/settings
/admin/api/v1/auth
/admin/api/v1/database
/admin/api/v1/storage/files/*
/admin/api/v1/website/pages
/admin/api/v1/workloads/*
```

The dashboard itself is supplied by the `@zelavis/ui` service. The `zelavis`
runtime only wires the service into the service graph and exposes the runtime API
state it needs.

Services can also ship full web apps through the `app` field:

```ts
import { defineService } from "zelavis";

export default defineService({
  name: "@acme/storefront",
  kind: "web-app",
  capabilities: ["web:app", "api:routes"],
  app: {
    mount: "/",
    mode: "spa",
    bundle: "dist",
    domainPolicy: "optional",
  },
});
```

Apps declare their serving shape and domain policy, not concrete hostnames.
Verified domain bindings live in runtime state. Workspace apps with
`domainPolicy: "optional"` fall back to `/apps/<service-name>` when no verified
domain exists; apps with `domainPolicy: "required"` are not served until a
verified binding exists.

This is also the boundary for optional external deployment providers. Zelavis
can host websites itself from the local runtime; provider adapters such as
external static hosts, DNS, CDN, object storage, image storage, or email belong
in plugins and should not redefine where the Zelavis runtime itself lives.

The main package keeps one adapter layer: **runtime adapters**
(`zelavis/adapters/*`). These describe the self-hosted JavaScript runtime
Zelavis runs on and supply System Store, database, file storage, service package,
and project-runtime defaults.

Framework-specific mounting helpers are not part of the main Platform OS
surface. Long-running hosts should use `zelavis/runtimes/node` for the bundled
Node HTTP server or call `zv.fetch(request)` from fetch-native code.

Available runtime adapters:

```txt
zelavis/adapters/node
zelavis/adapters/bun
```

Node.js is the current supported production host. Bun remains an adapter target
while its full platform and project-runtime suite is completed; Deno is a
planned adapter target.

Available host utilities:

```txt
zelavis/runtimes/node          createNodeServer(zv)
zelavis/runtimes/bun           bun marker
zelavis/runtimes/deno          deno marker
```

Runtime host utilities are separate subpath exports. Import only the runtime
subpath you need so bundlers can drop code for the other host runtimes.

## SDK bundle surfaces

The official SDK is a bundle surface of Zelavis itself, not a separate client
architecture. SDK entry points reuse the portable app contracts and database
core, but intentionally exclude:

- the dashboard UI service
- long-running host runtime utilities
- Node, Bun, and future Deno adapters
- server/project process orchestration

Available SDK entry points:

```txt
zelavis/sdk                  fetch-native SDK core
zelavis/sdk/browser          browser SDK surface
zelavis/sdk/node             Node SDK surface using native fetch
```

Use the browser SDK when code should talk to a running Zelavis Platform OS
without importing host runtime code:

```ts
import {
  createBrowserZelavisClient,
  createDatabase,
} from "zelavis/sdk/browser";

const client = createBrowserZelavisClient({
  baseUrl: "https://example.com",
});

const config = await client.runtime.config();
```

The SDK also re-exports the runtime-neutral `@zelavis/app/db` and
`@zelavis/app/auth` core APIs. Today that enables in-memory local development.
Future browser storage adapters such as IndexedDB and SQLite WASM should attach
to the same database driver boundary instead of creating a separate browser DB
model.

SDK builds can be checked without building the dashboard or host runtimes:

```sh
pnpm --filter zelavis build:sdk
pnpm --filter zelavis build:sdk:browser
pnpm --filter zelavis build:sdk:node
```

At the workspace root, the same commands are available as:

```sh
pnpm build:sdk
pnpm build:sdk:browser
pnpm build:sdk:node
```

These scripts compile only the selected SDK source entry and its imports. They
are the current enforcement point for keeping browser and native-fetch SDK
surfaces separate from UI, host runtimes, and local server adapters.

Runtime resources now also feed real core-service persistence in the high-level `Zelavis` class:

- dashboard settings can persist through local KV or local files
- the storage core service can expose local file storage through the Zelavis API
- website pages can persist through local files when no database core service is configured

The dashboard settings endpoint exposes runtime-editable dashboard preferences:

```txt
GET /zelavis/api/v1/runtime/settings
PATCH /zelavis/api/v1/runtime/settings
```

The dashboard service registry also has runtime endpoints:

```txt
GET /zelavis/api/v1/runtime/services
POST /zelavis/api/v1/runtime/services
PATCH /zelavis/api/v1/runtime/services/:name
GET /zelavis/api/v1/runtime/service-page-assets/:service/:bundle/*
```

When a service registry store is configured, these endpoints read and update
real install state instead of a hardcoded list. Dashboard metadata updates
immediately, while service activation is runtime-controlled: a local runtime can
recompose its service graph when supported, or require a process restart when
live activation is unavailable. Runtime config exposes the current adapter's
service activation capabilities so the dashboard can show whether uploaded
specifiers, runtime installs, and isolated execution are actually supported.

`POST /runtime/services` registers a non-marketplace ESM source with
`{ name, specifier }`. The best portable input is a module specifier or hosted
ESM entry point that the active host knows how to resolve.

Installed services can also attach iframe-backed dashboard documents to their
menu items with `menu.page`. The dashboard receives a safe `src` URL from
runtime config and mounts it through the `zelavis-service-frame` web component,
so service UI can be a full HTML document instead of a React component tied to
Zelavis dashboard internals.

`menu.path` and `menu.page.file` intentionally mean different things:

- `menu.path` is the dashboard URL. Core services whose screens already ship
  with `@zelavis/ui` should use this without `menu.page`; the dashboard renders
  the local React Router route directly and no iframe is mounted.
- `menu.page.file` is a browser-extension-style HTML entry file inside the
  service bundle. Zelavis serves it through the generated service-page asset URL
  and the dashboard iframe loads that URL. The iframe never points at a raw
  filesystem path. Relative assets such as `<script src="./settings.js">` work
  when they are shipped beside the HTML file in the same bundle.
- If the HTML file boots a SPA, that SPA owns its internal router, tabs, and
  menu. Zelavis sidebar items select concrete HTML entry files; they do not
  deep-link into plugin-private SPA routes.

That lets a custom service ship simple static dashboard pages:

```ts
defineService({
  name: "@acme/reports",
  menu: {
    title: "Reports",
    path: "/reports",
    page: {
      id: "dashboard",
      file: "dashboard.html",
    },
    items: [
      {
        title: "Settings",
        path: "/reports/settings",
        page: {
          id: "settings",
          file: "settings.html",
        },
      },
    ],
  },
});
```

`dashboard.html` can be plain HTML or boot a client app with normal relative
assets from the same bundle:

```html
<main id="app"></main>
<script type="module" src="./dashboard.js"></script>
```

Dynamic menu sections use the same item schema as static service menus. A
service-owned endpoint returns a JSON menu fragment:

```json
{
  "items": [
    {
      "title": "Reports",
      "path": "/reports/monthly",
      "page": {
        "id": "monthly",
        "file": "monthly.html"
      }
    }
  ]
}
```

When a file storage resource exists, Zelavis can also expose a built-in storage core service:

```txt
GET /zelavis/api/v1/storage/files
GET /zelavis/api/v1/storage/files/*
GET /zelavis/api/v1/storage/files/*?format=metadata
PUT /zelavis/api/v1/storage/files/*
DELETE /zelavis/api/v1/storage/files/*
```

Writes return file metadata plus a first-class Zelavis file reference, and reads expose the SHA-256 checksum through metadata responses and the `x-zelavis-checksum-sha256` response header when available.

For generic object storage that is not really a hosting platform decision, Zelavis also exposes a first-party S3-compatible helper:

```ts
import { createS3CompatibleFileStorage } from "zelavis/storage/s3";
```

Use it when you want the normal Zelavis storage contract, metadata, and file-reference flow on top of an S3-compatible bucket.

Root path changes are saved as pending settings and report `restartRequired`
because mounted routes cannot move safely while the runtime is already running.
Runtime resources such as KV or file storage are used as settings defaults when
they are available.

For local Zelavis development, use the `pnpm dev` workflow. It starts the
runtime and UI dev server together and wires dashboard requests to the live UI
build.

`pnpm dev` uses the official service directory at `packages/zelavis/services`.
`@zelavis/app` lives directly at `packages/zelavis/services/zelavis-app` as a
nested workspace package and bundled app-service boilerplate.

The dashboard, project registry, Platform settings, and service registry state
persist through the separate System Store. Zelavis App capabilities run inside
created app-service project runtimes.
