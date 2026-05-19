# zelavis

`zelavis` is the high-level runtime package for the Zelavis backend platform.

Use this package when building an application or service with Zelavis and you want the default platform building blocks wired together for you. Lower-level packages such as `@zelavis/server`, `@zelavis/db`, and `@zelavis/auth` remain available when you need direct access to the primitives.

Today, that mostly means auth, database, website delivery, server mounting, and dashboard delivery under one runtime entry point.

## Entry point preference

Use the package in this order:

1. `new Zelavis(...)` for application/runtime code
2. `await zelavis(...)` only when you intentionally need low-level runtime composition
3. scoped packages like `@zelavis/server` when you are building primitives, tests, or custom infrastructure

The class is the safe batteries-included API. The function is the advanced escape hatch.

## Import split

Use `Zelavis` for application and runtime code:

```ts
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { createNodeServer } from "zelavis/node";

const zelavis = new Zelavis({ adapter: nodeAdapter() });
const server = await createNodeServer(zelavis);
```

Or embed the runtime directly in a Web/fetch environment:

```ts
import { Zelavis } from "zelavis";

const zelavis = new Zelavis({});

export function GET(request: Request) {
  return zelavis.fetch(request);
}
```

Use scoped packages when building lower-level primitives, adapters, plugins, or tests that need direct package APIs:

```ts
import { createDatabase } from "@zelavis/db";
import { createPlugin } from "zelavis";
import { defineService } from "@zelavis/server";
import { authService } from "@zelavis/auth";
```

For installable product capabilities, prefer plugin language in developer-facing APIs. Zelavis now also exports a small `createPlugin(...)` helper for declarative plugin metadata such as dashboard menu ownership.

Plugin loading should stay pure ESM. Zelavis also exposes helpers such as `loadPlugin(...)`, `loadPluginRegistry(...)`, `resolvePluginModule(...)`, and `removePluginFromRegistry(...)` so plugin install/load/remove flows can stay inside standard JavaScript module semantics instead of Node-specific loaders.

For runtime composition, Zelavis also supports a plugin registry option with real install state and activation order:

```ts
import { createPlugin, createPluginRegistry, Zelavis } from "zelavis";

const ecommerce = createPlugin({
  name: "zelavis-ecommerce",
  menu: {
    title: "Ecommerce",
    path: "/commerce",
  },
});

const zelavis = new Zelavis({
  plugins: {
    entries: createPluginRegistry([
      {
        plugin: ecommerce,
        status: "installed",
        source: "official",
        order: 0,
      },
    ]),
  },
});
```

Plugin setup receives standard JavaScript data only:

- mounted `rootPath`
- API path information
- platform summary (`presets`, resource availability, metadata)
- already collected services plus `addService(...)`

That keeps plugin setup runtime-neutral while still giving plugins enough context to register extra services.

Use the lower-level `zelavis(...)` function only when you need internal runtime controls such as `coreServices`, direct `services`, or path/mount overrides. See [Advanced Runtime Composition](../../website/src/content/docs/guides/advanced-runtime-composition.md) for the focused version of that story.

## Usage

```ts
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { createNodeServer } from "zelavis/node";

const zelavis = new Zelavis({ adapter: nodeAdapter() });
const server = await createNodeServer(zelavis);

server.listen(3000);
```

When you do not need a framework-specific adapter, use the Web-style runtime handlers directly:

```ts
const zelavis = new Zelavis({});

const response = await zelavis.fetch(
  new Request("http://localhost/zelavis/api/v1/dashboard/config"),
);
```

`new Zelavis(...)` is the guarded high-level entrypoint. It accepts app-facing options such as adapters, platforms, root path, plugin registry state, and error handling. Internal runtime knobs like `services`, `coreServices`, and path overrides stay on the lower-level `zelavis(...)` function.

That split is intentional:

- the class is for real application code
- the function is for advanced composition and internal/runtime-facing work

By default, Zelavis owns one safe namespace:

```txt
/zelavis
/zelavis/settings
/zelavis/assets/*
/zelavis/api/v1/dashboard/config
/zelavis/api/v1/dashboard/settings
/zelavis/api/v1/auth
/zelavis/api/v1/database
/zelavis/api/v1/storage/files/*
/zelavis/api/v1/website/pages
```

Customize that namespace with `rootPath`:

```ts
new Zelavis({
  rootPath: "/admin",
});
```

That moves the dashboard and APIs together:

```txt
/admin
/admin/settings
/admin/assets/*
/admin/api/v1/dashboard/config
/admin/api/v1/dashboard/settings
/admin/api/v1/auth
/admin/api/v1/database
/admin/api/v1/storage/files/*
/admin/api/v1/website/pages
```

The dashboard UI is built from the `@zelavis/ui` workspace package and copied
into this package during `pnpm --filter zelavis build`. Application users should
serve it through `zelavis`; they do not need to import `@zelavis/ui`
directly.

The runtime supports two complementary integration patterns:

- **environment adapters** (`zelavis/adapters/*`) — describe the environment Zelavis runs on, supply database/KV/file storage defaults
- **framework utilities** (`zelavis/<framework>`) — small helper functions that wrap `zelavis.fetch` for a specific framework signature

For fetch-native hosts (Cloudflare Workers, Bun, Next.js App Router), no framework utility is needed — call `zelavis.fetch(request)` directly.

Available environment adapters:

```txt
zelavis/adapters/node
zelavis/adapters/bun
zelavis/adapters/cloudflare
zelavis/adapters/netlify
zelavis/adapters/vercel
```

Available framework utilities:

```txt
zelavis/express       expressMiddleware(zelavis)
zelavis/hono          honoMiddleware(zelavis)
zelavis/fastify       fastifyPlugin(zelavis)
zelavis/h3            h3Handler(zelavis)
zelavis/elysia        elysiaPlugin(zelavis)
zelavis/nextjs/pages  nextjsPagesRouterHandler(zelavis, options?)
zelavis/node          createNodeServer(zelavis)
```

Platform resources now also feed real core-service persistence in the high-level `Zelavis` class:

- dashboard settings can persist through platform KV or platform files
- the storage core service can expose platform file storage through the Zelavis API
- website pages can persist through platform files when no database core service is configured

For Cloudflare Workers, pass the worker `env` object to the platform preset and let Zelavis pick up the standard bindings itself:

```ts
import { Zelavis } from "zelavis";
import { cloudflareAdapter } from "zelavis/adapters/cloudflare";

export default {
  fetch(request: Request, env: { ZELAVIS_DB: unknown }, ctx: ExecutionContext) {
    const zelavis = new Zelavis({
      adapter: cloudflareAdapter({ env }),
    });

    return zelavis.fetch(request, {
      platform: {
        cloudflare: {
          env,
          executionContext: ctx,
        },
      },
    });
  },
};
```

`cloudflareAdapter()` expects a D1 binding at `env.ZELAVIS_DB` and will also pick up `env.ZELAVIS_KV` and `env.ZELAVIS_FILES` automatically when they are present. Use `bindings` only when your Cloudflare binding names differ from the Zelavis defaults.

Dashboard client routes are served as SPA shell routes by the dashboard core
service, so direct visits such as `/zelavis/settings` work in Node and Express.

The dashboard settings endpoint exposes runtime-editable dashboard preferences:

```txt
GET /zelavis/api/v1/dashboard/settings
PATCH /zelavis/api/v1/dashboard/settings
```

The dashboard plugin registry also has runtime endpoints:

```txt
GET /zelavis/api/v1/dashboard/plugins
POST /zelavis/api/v1/dashboard/plugins
PATCH /zelavis/api/v1/dashboard/plugins/:name
GET /zelavis/api/v1/dashboard/plugin-pages/:plugin/:page
```

When a plugin registry store is configured, these endpoints read and update real install state instead of a hardcoded list. Dashboard metadata updates immediately, while plugin service activation is adapter-controlled: a long-running server can recompose its runtime graph, while serverless hosts can map the same activation request to a worker/function boundary or another live host capability. Runtime config exposes the current adapter's plugin activation capabilities so the dashboard can show whether uploaded specifiers, runtime installs, and isolated execution are actually supported by the active host.

`POST /dashboard/plugins` registers a non-marketplace ESM source with `{ name, specifier }`. The best portable input is a module specifier or hosted ESM entry point that the active host knows how to resolve. A raw folder or zip is intentionally not the runtime contract because serverless platforms cannot all import arbitrary uploaded files the same way.

Installed plugins can also attach iframe-backed dashboard documents to their menu items with `menu.page`. The dashboard receives a safe `src` URL from runtime config and mounts it through the `zelavis-plugin-frame` web component, so plugin UI can be a full HTML document instead of a React component tied to Zelavis dashboard internals.

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
Pass `coreServices.dashboard.settingsStore` when you want to back these settings
with your own storage. For the built-in Node file-backed store, import
`createFileDashboardSettingsStore()` from `zelavis/adapters/node`.

For local dashboard work, point Zelavis at the mounted dashboard base URL of a running UI dev server:

```ts
import { zelavis } from "zelavis";

await zelavis({
  coreServices: {
    dashboard: {
      devServerUrl: "http://127.0.0.1:3001/zelavis",
    },
  },
});
```

When `devServerUrl` is set, dashboard route requests redirect to the live UI dev
server instead of serving the embedded built dashboard assets.

The dashboard, auth, database, and website core services are included by default. The storage core service is enabled when Zelavis has a file storage resource to expose. Disable any of them when you need a smaller server or want to supply replacements:

```ts
import { zelavis } from "zelavis";

await zelavis({
  coreServices: {
    auth: false,
    dashboard: false,
    database: false,
    storage: false,
    website: false,
  },
});
```

Configure the built-in auth service when the defaults are not enough:

```ts
import { emailPasswordPlugin } from "@zelavis/auth-email-password";
import { zelavis } from "zelavis";

await zelavis({
  coreServices: {
    auth: {
      authOptions: {
        plugins: [
          emailPasswordPlugin({
            verifyPasswordHash: async ({ password, passwordHash }) =>
              password === passwordHash,
          }),
        ],
      },
    },
  },
});
```

Configure the built-in database service when the defaults are not enough:

```ts
import { zelavis } from "zelavis";

await zelavis({
  coreServices: {
    database: {
      defaultTenantId: "acme",
    },
  },
});
```
