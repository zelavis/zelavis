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
- website

Default root namespace:

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

The website core service also mounts public website pages at `/`, while still reserving the dashboard namespace under `/zelavis`.

## Disable built-in services when needed

```ts
await zelavis({
  coreServices: {
    auth: false,
    dashboard: false,
    database: false,
    website: false,
  },
});
```

## Dashboard settings

The built-in dashboard settings endpoint currently exposes:

- `rootPath`
- `pendingRootPath`
- `apiBasePath`
- `theme`
- `pageBuilderEnabled`
- `persistence`
- `editable`
- `restartRequired`

Root path changes are stored as pending runtime settings and require a restart before the dashboard actually moves.

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
