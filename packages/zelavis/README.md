# zelavis

`zelavis` is the high-level runtime package for the Zelavis backend platform.

Use this package when building an application or service with Zelavis and you want the default platform building blocks wired together for you. Lower-level packages such as `@zelavis/server`, `@zelavis/database`, and `@zelavis/auth` remain available when you need direct access to the primitives.

Today, that mostly means auth, database, server integration, and dashboard delivery under one runtime entry point.

## Import split

Use `zelavis` for application and runtime code:

```ts
import { zelavis } from "zelavis";
import { nodeIntegration } from "zelavis/integrations/node";

const runtime = await zelavis();
const server = nodeIntegration(runtime);
```

Or embed the runtime directly in a Web/fetch environment:

```ts
import { zelavis } from "zelavis";

const runtime = await zelavis({});

export function GET(request: Request) {
  return runtime.fetch(request);
}
```

Use scoped packages when building lower-level primitives, integrations, plugins, or tests that need direct package APIs:

```ts
import { createDatabase } from "@zelavis/database";
import { defineServerService } from "@zelavis/server";
import { authService } from "@zelavis/auth";
```

## Usage

```ts
import { zelavis } from "zelavis";
import { nodeIntegration } from "zelavis/integrations/node";

const runtime = await zelavis();
const server = nodeIntegration(runtime);

server.listen(3000);
```

When you do not need a framework-specific adapter, use the Web-style runtime handlers directly:

```ts
const runtime = await zelavis({});

const response = await runtime.fetch(
  new Request("http://localhost/zelavis/api/v1/dashboard/config"),
);
```

By default, Zelavis owns one safe namespace:

```txt
/zelavis
/zelavis/settings
/zelavis/assets/*
/zelavis/api/v1/dashboard/config
/zelavis/api/v1/dashboard/settings
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
/admin/settings
/admin/assets/*
/admin/api/v1/auth
/admin/api/v1/database
```

The dashboard UI is built from the `@zelavis/ui` workspace package and copied
into this package during `pnpm --filter zelavis build`. Application users should
serve it through `zelavis`; they do not need to import `@zelavis/ui`
directly.

The runtime now supports both styles:

- explicit adapter helpers such as Node, Elysia, Express, Fastify, Hono, and h3
- direct Web-handler embedding through `runtime.fetch(...)`

Dashboard client routes are served as SPA shell routes by the dashboard core
service, so direct visits such as `/zelavis/settings` work in Node and Express.

The dashboard settings endpoint exposes runtime-editable dashboard preferences:

```txt
GET /zelavis/api/v1/dashboard/settings
PATCH /zelavis/api/v1/dashboard/settings
```

Root path changes are saved as pending settings and report `restartRequired`
because mounted routes cannot move safely while the runtime is already running.
Pass `coreServices.dashboard.settingsStore` when you want to back these settings
with your own storage. For the built-in Node file-backed store, import
`createFileDashboardSettingsStore()` from `zelavis/integrations/node`.

For local dashboard work, point Zelavis at a running UI dev server:

```ts
await zelavis({
  coreServices: {
    dashboard: {
      devServerUrl: "http://127.0.0.1:3001",
    },
  },
});
```

When `devServerUrl` is set, dashboard route requests redirect to the live UI dev
server instead of serving the embedded built dashboard assets.

The dashboard, auth, and database core services are included by default. Disable any of them when you need a smaller server or want to supply replacements:

```ts
await zelavis({
  coreServices: {
    auth: false,
    dashboard: false,
    database: false,
  },
});
```

Configure the built-in auth service when the defaults are not enough:

```ts
import { emailPasswordPlugin } from "@zelavis/auth-email-password";

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
await zelavis({
  coreServices: {
    database: {
      defaultTenantId: "acme",
    },
  },
});
```
