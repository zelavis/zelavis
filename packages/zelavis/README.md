# zelavis

`zelavis` is the high-level runtime package that composes core services and server integrations.

Use this package when building an application or service with Zelavis. Lower-level packages such as `@zelavis/server`, `@zelavis/database`, and `@zelavis/auth` remain available when you need direct access to the primitives.

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
