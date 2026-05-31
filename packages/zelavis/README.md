# zelavis

`zelavis` is the high-level runtime package for the Zelavis backend platform.

Use this package when building an application or service with Zelavis and you want the default platform building blocks wired together for you. Lower-level packages such as `@zelavis/server`, `@zelavis/db`, and `@zelavis/auth` remain available when you need direct access to the primitives.

Today, that mostly means auth, database, website delivery, server mounting, and dashboard delivery under one runtime entry point.

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
import { createNodeServer } from "zelavis/node";

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
import { authService } from "@zelavis/auth";
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
import { createNodeServer } from "zelavis/node";

const zv = new Zelavis({ adapter: nodeAdapter() });
const server = await createNodeServer(zv);

server.listen(3000);
```

When you do not need a framework-specific adapter, use the Web-style runtime handlers directly:

```ts
const zv = new Zelavis({});

const response = await zv.fetch(
  new Request("http://localhost/zelavis/api/v1/runtime/config"),
);
```

`new Zelavis(...)` is the guarded high-level entrypoint. It accepts app-facing options such as adapters, platforms, root path, service registry state, and error handling. Internal runtime knobs like direct `runtimeServices` and path overrides stay on the lower-level `zelavis(...)` function.

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
/zelavis/settings
/zelavis/api/v1/runtime/config
/zelavis/api/v1/runtime/settings
/zelavis/api/v1/auth
/zelavis/api/v1/database
/zelavis/api/v1/storage/files/*
/zelavis/api/v1/website/pages
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
/admin/settings
/admin/api/v1/runtime/config
/admin/api/v1/runtime/settings
/admin/api/v1/auth
/admin/api/v1/database
/admin/api/v1/storage/files/*
/admin/api/v1/website/pages
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

The runtime supports two complementary integration patterns:

- **environment adapters** (`zelavis/adapters/*`) — describe the environment Zelavis runs on, supply database/KV/file storage defaults
- **framework utilities** (`zelavis/<framework>`) — small helper functions that wrap `zv.fetch` for a specific framework signature

For fetch-native hosts (Cloudflare Workers, Bun, Next.js App Router), no framework utility is needed — call `zv.fetch(request)` directly.

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
zelavis/express       expressMiddleware(zv)
zelavis/hono          honoMiddleware(zv)
zelavis/fastify       fastifyPlugin(zv)
zelavis/h3            h3Handler(zv)
zelavis/elysia        elysiaPlugin(zv)
zelavis/nextjs/pages  nextjsPagesRouterHandler(zv, options?)
zelavis/node          createNodeServer(zv)
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
    const zv = new Zelavis({
      adapter: cloudflareAdapter({ env }),
    });

    return zv.fetch(request, {
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
GET /zelavis/api/v1/runtime/service-pages/:service/:page
```

When a service registry store is configured, these endpoints read and update
real install state instead of a hardcoded list. Dashboard metadata updates
immediately, while service activation is adapter-controlled: a long-running
server can recompose its runtime graph, while serverless hosts can map the same
activation request to a worker/function boundary or another live host
capability. Runtime config exposes the current adapter's service activation
capabilities so the dashboard can show whether uploaded specifiers, runtime
installs, and isolated execution are actually supported by the active host.

`POST /runtime/services` registers a non-marketplace ESM source with
`{ name, specifier }`. The best portable input is a module specifier or hosted
ESM entry point that the active host knows how to resolve.

Installed services can also attach iframe-backed dashboard documents to their
menu items with `menu.page`. The dashboard receives a safe `src` URL from
runtime config and mounts it through the `zelavis-service-frame` web component,
so service UI can be a full HTML document instead of a React component tied to
Zelavis dashboard internals.

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
Platform resources such as KV or file storage are used as settings defaults when
they are available.

For local dashboard work, use the `pnpm run ui:dev` workflow. It starts the
runtime and UI dev server together and wires dashboard requests to the live UI
build.

The dashboard, auth, database, and website core services are included by
default. The storage core service is enabled when Zelavis has a file storage
resource to expose.
