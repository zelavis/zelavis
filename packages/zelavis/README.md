# zelavis

`zelavis` is the high-level runtime package for the Zelavis backend platform.

Use this package when building an application or service with Zelavis and you want the default platform building blocks wired together for you. Lower-level packages such as `@zelavis/server`, `@zelavis/database`, and `@zelavis/auth` remain available when you need direct access to the primitives.

Today, that mostly means auth, database, server integration, and dashboard delivery under one runtime entry point.

## Import split

Use `zelavis` for application and runtime code:

```ts
import { zelavisServer } from "zelavis";
import { nodeIntegration } from "zelavis/integrations/node";
```

Use scoped packages when building lower-level primitives, integrations, plugins, or tests that need direct package APIs:

```ts
import { createDatabase } from "@zelavis/database";
import { defineServerService } from "@zelavis/server";
import { authService } from "@zelavis/auth";
```

## Usage

```ts
import { zelavisServer } from "zelavis";
import { nodeIntegration } from "zelavis/integrations/node";

const runtime = await zelavisServer({
  integration: nodeIntegration(),
});

runtime.server.listen(3000);
```

By default, Zelavis owns one safe namespace:

```txt
/zelavis
/zelavis/settings
/zelavis/assets/*
/zelavis/api/v1/dashboard/config
/zelavis/api/v1/auth
/zelavis/api/v1/database
```

Customize that namespace with `rootPath`:

```ts
await zelavisServer({
  rootPath: "/admin",
  integration: nodeIntegration(),
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
serve it through `zelavisServer`; they do not need to import `@zelavis/ui`
directly.

Dashboard client routes are served as SPA shell routes by the dashboard core
service, so direct visits such as `/zelavis/settings` work in Node and Express.

The dashboard, auth, and database core services are included by default. Disable any of them when you need a smaller server or want to supply replacements:

```ts
await zelavisServer({
  coreServices: {
    auth: false,
    dashboard: false,
    database: false,
  },
  integration: nodeIntegration(),
});
```

Configure the built-in auth service when the defaults are not enough:

```ts
import { emailPasswordPlugin } from "@zelavis/auth-email-password";

await zelavisServer({
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
  integration: nodeIntegration(),
});
```

Configure the built-in database service when the defaults are not enough:

```ts
await zelavisServer({
  coreServices: {
    database: {
      defaultTenantId: "acme",
    },
  },
  integration: nodeIntegration(),
});
```
