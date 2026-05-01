# First Runtime

This page shows the simplest current way to start Zelavis.

## Quick start

```ts
import { zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";

const runtime = await zelavis();
const server = nodeAdapter(runtime);

server.listen(3000);
```

## What you get by default

Today, `zelavis()` includes these core services by default:

- dashboard
- auth
- database

Default root namespace:

```txt
/zelavis
/zelavis/assets/*
/zelavis/api/v1/dashboard/config
/zelavis/api/v1/dashboard/settings
/zelavis/api/v1/auth
/zelavis/api/v1/database
```

## Disable built-in services when needed

```ts
await zelavis({
  coreServices: {
    auth: false,
    dashboard: false,
    database: false,
  },
});
```

## Use the fetch-style runtime directly

When you do not need a framework-specific mount helper:

```ts
import { zelavis } from "zelavis";

const runtime = await zelavis();
const response = await runtime.fetch(
  new Request("http://localhost/zelavis/api/v1/dashboard/config"),
);
```

## Next

- [Node adapter](../adapters/node.md)
- [zelavis package](../packages/zelavis.md)
- [@zelavis/server](../packages/server.md)
