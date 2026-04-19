# zelavis

`zelavis` is the high-level runtime package that composes core services and server integrations.

Use this package when building an application or service with Zelavis. Lower-level packages such as `@zelavis/server`, `@zelavis/database`, and `@zelavis/auth` remain available when you need direct access to the primitives.

## Import split

Use `zelavis` for application and runtime code:

```ts
import { authService, zelavisServer } from "zelavis";
import { nodeIntegration } from "zelavis/integrations/node";
```

Use scoped packages when building lower-level primitives, integrations, plugins, or tests that need direct package APIs:

```ts
import { createDatabase } from "@zelavis/database";
import { defineServerService } from "@zelavis/server";
```

## Usage

```ts
import { authService, zelavisServer } from "zelavis";
import { nodeIntegration } from "zelavis/integrations/node";

const runtime = await zelavisServer({
  services: [authService()],
  integration: nodeIntegration(),
});

runtime.server.listen(3000);
```

The database core service is included by default. Disable it when you need a server without database routes:

```ts
await zelavisServer({
  coreServices: {
    database: false,
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
