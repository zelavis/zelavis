---
title: First Runtime
---
This page shows the simplest current way to start Zelavis.

## Quick start

```ts
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { createNodeServer } from "zelavis/node";

const zelavis = new Zelavis({
  adapter: nodeAdapter(),
});
const server = await createNodeServer(zelavis);

server.listen(3000);
```

This is the preferred application-facing shape. Reach for `await zelavis(...)` only when you deliberately want lower-level runtime composition.

When you do want that lower-level path, jump to [Advanced Runtime Composition](../guides/advanced-runtime-composition.md).

## What you get by default

Today, a default `new Zelavis(...)` runtime includes these core services by default:

- dashboard
- auth
- database
- website

When the selected adapter provides file storage, Zelavis can also expose:

- storage

Default root namespace:

```txt
/zelavis
/zelavis/settings
/zelavis/assets/*
/zelavis/api/v1/runtime/config
/zelavis/api/v1/runtime/settings
/zelavis/api/v1/auth
/zelavis/api/v1/database
/zelavis/api/v1/storage/files/*
/zelavis/api/v1/storage/files/*?format=metadata
/zelavis/api/v1/website/pages
```

The website core service also mounts public website pages at `/`, while still reserving the dashboard namespace under `/zelavis`.

## Disable built-in services when needed

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

When the host already speaks the Web `Request` → `Response` model (Cloudflare Workers, Bun, Next.js App Router, etc.), no framework helper is needed — call `zelavis.fetch(request)` directly:

```ts
import { Zelavis } from "zelavis";

const zelavis = new Zelavis();
const response = await zelavis.fetch(
  new Request("http://localhost/zelavis/api/v1/runtime/config"),
);
```

## Next

- [Node adapter](../adapters/node.md)
- [zelavis package](../packages/zelavis.md)
- [@zelavis/server](../packages/server.md)
