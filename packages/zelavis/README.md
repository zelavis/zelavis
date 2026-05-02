# zelavis

`zelavis` is the high-level runtime package for the Zelavis backend platform.

Use this package when building an application or service with Zelavis and you want the default platform building blocks wired together for you. Lower-level packages such as `@zelavis/server`, `@zelavis/database`, and `@zelavis/auth` remain available when you need direct access to the primitives.

Today, that mostly means auth, database, website delivery, server mounting, and dashboard delivery under one runtime entry point.

## Import split

Use `Zelavis` for application and runtime code:

```ts
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { nodePlatform } from "zelavis/platforms/node";

const zelavis = new Zelavis({
  adapter: nodeAdapter(),
  platform: nodePlatform(),
});
const server = await zelavis.adapter.nodeServer();
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
import { createDatabase } from "@zelavis/database";
import { defineServerService } from "@zelavis/server";
import { authService } from "@zelavis/auth";
```

## Usage

```ts
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { nodePlatform } from "zelavis/platforms/node";

const zelavis = new Zelavis({
  adapter: nodeAdapter(),
  platform: nodePlatform(),
});
const server = await zelavis.adapter.nodeServer();

server.listen(3000);
```

When you do not need a framework-specific adapter, use the Web-style runtime handlers directly:

```ts
const zelavis = new Zelavis({});

const response = await zelavis.fetch(
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
/admin/api/v1/website/pages
```

The dashboard UI is built from the `@zelavis/ui` workspace package and copied
into this package during `pnpm --filter zelavis build`. Application users should
serve it through `zelavis`; they do not need to import `@zelavis/ui`
directly.

The runtime now supports both styles:

- explicit framework adapters such as Node, Elysia, Express, Fastify, Hono, and h3
- host-level platform presets such as the Node platform
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
`createFileDashboardSettingsStore()` from `zelavis/adapters/node`.

For local dashboard work, point Zelavis at the mounted dashboard base URL of a running UI dev server:

```ts
new Zelavis({
  coreServices: {
    dashboard: {
      devServerUrl: "http://127.0.0.1:3001/zelavis",
    },
  },
});
```

When `devServerUrl` is set, dashboard route requests redirect to the live UI dev
server instead of serving the embedded built dashboard assets.

The dashboard, auth, database, and website core services are included by default. Disable any of them when you need a smaller server or want to supply replacements:

```ts
new Zelavis({
  coreServices: {
    auth: false,
    dashboard: false,
    database: false,
    website: false,
  },
});
```

Configure the built-in auth service when the defaults are not enough:

```ts
import { emailPasswordPlugin } from "@zelavis/auth-email-password";

new Zelavis({
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
new Zelavis({
  coreServices: {
    database: {
      defaultTenantId: "acme",
    },
  },
});
```
