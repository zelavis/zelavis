---
title: Adapter Entry Points
---
Zelavis has two kinds of entry points:

1. **Adapters** (`zelavis/adapters/*` and the `zelavis/adapters` barrel) — describe the *environment* Zelavis runs on.
2. **Framework utilities** (`zelavis/<framework>`) — small helper functions for plugging Zelavis into a specific host framework.

## Adapters

Adapters are built with `defineAdapter` and contribute infrastructure: database driver, KV, file storage, dashboard settings.

### Available environment adapters

```txt
zelavis/adapters/node         — Node.js (better-sqlite3, local files, file dashboard settings)
zelavis/adapters/bun          — Bun (bun:sqlite, local files, file dashboard settings)
zelavis/adapters/cloudflare   — Cloudflare Workers (D1, KV, R2)
zelavis/adapters/vercel       — Vercel (injected Vercel Blob and KV resources)
zelavis/adapters/netlify      — Netlify (Netlify Blobs)
```

### Barrel

The `zelavis/adapters` barrel re-exports every adapter under its canonical name and a `zelavisX` alias:

```ts
import {
  nodeAdapter,
  bunAdapter,
  cloudflareAdapter,
  vercelAdapter,
  netlifyAdapter,
  // aliases
  zelavisNode,
  zelavisBun,
  zelavisCloudflare,
  zelavisVercel,
  zelavisNetlify,
} from "zelavis/adapters";
```

### Typical usage

```ts
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";

const zelavis = new Zelavis({ adapter: nodeAdapter() });
```

Fetch-native hosts use the adapter for infrastructure and call `zelavis.fetch(request)` directly — no framework utility needed.

## Framework utilities

Framework utilities take a `Zelavis` instance and return whatever shape the framework expects. They live at `zelavis/<framework>`:

```txt
zelavis/express       — expressMiddleware(zelavis)
zelavis/hono          — honoMiddleware(zelavis)
zelavis/fastify       — fastifyPlugin(zelavis)
zelavis/h3            — h3Handler(zelavis)
zelavis/elysia        — elysiaPlugin(zelavis)
zelavis/nextjs/pages  — nextjsPagesRouterHandler(zelavis, options?)
zelavis/node          — createNodeServer(zelavis)
```

Typical usage:

```ts
import express from "express";
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { expressMiddleware } from "zelavis/express";

const zelavis = new Zelavis({ adapter: nodeAdapter() });
const app = express();
app.use(expressMiddleware(zelavis));
```

These are *not* adapters — they are helper functions. The `Zelavis` instance is constructed once with its environment adapter, and the utility just wraps `zelavis.fetch` for a specific framework signature.

## Lower-level server adapters

The `@zelavis/server` package exposes runtime-level helpers for custom server composition:

```txt
@zelavis/server/adapters/node
@zelavis/server/adapters/express
@zelavis/server/adapters/fastify
@zelavis/server/adapters/hono
@zelavis/server/adapters/h3
@zelavis/server/adapters/elysia
@zelavis/server/adapters/nextjs-pages-router
```

These accept a raw runtime rather than a `Zelavis` instance. The framework utilities in `zelavis/<framework>` wrap these for the `Zelavis` lifecycle. Use the low-level helpers only when you are composing services by hand via `zelavisServer(...)`.

## defineAdapter

To build a custom environment adapter:

```ts
import { defineAdapter } from "zelavis";

const myAdapter = defineAdapter({
  name: "my-host",
  async resolve(_options) {
    return {
      coreServices: { /* ... */ },
      resources: { kv: myStore, files: myStorage },
      metadata: { runtime: "my-host" },
    };
  },
});
```

Adapters can also expose service activation through `resources.services`. That controller is the host boundary for runtime service installs: a local server might recompose the in-process runtime graph, while a serverless adapter might route installed service code through a worker or function boundary. Core only consumes the declared capability shape and stays filesystem/provider neutral.

The full shape:

```ts
interface ZelavisAdapter {
  name: string;
  resolve?(options: ZelavisOptions):
    | ZelavisResolvedPlatformOptions
    | Promise<ZelavisResolvedPlatformOptions>;
}
```

## Related docs

- [Adapters Guide](../guides/adapters-and-fetch-native.md)
- [Platform Adapters](../reference/platform-presets.md)
- [First Runtime](../getting-started/first-runtime.md)
- [@zelavis/server](../packages/server.md)
