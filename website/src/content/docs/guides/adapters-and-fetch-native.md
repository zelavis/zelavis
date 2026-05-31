---
title: Adapters and Framework Utilities
---
Zelavis has a clean two-layer integration model:

1. **Adapters** = the *environment* Zelavis runs on. Node, Bun, Cloudflare Workers, Vercel, Netlify. Adapters provide infrastructure: database driver, KV store, file storage.
2. **Framework utilities** = small helper functions that wrap `zv.fetch(request)` for a specific host framework (Express, Hono, Fastify, etc.). They are not adapters — they are convenience functions.

For fetch-native hosts (Cloudflare Workers, Bun, Next.js App Router, etc.) you do not need a framework utility at all — call `zv.fetch(request)` directly.

## Quick examples

### Node.js standalone HTTP server

```ts
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { createNodeServer } from "zelavis/node";

const zv = new Zelavis({ adapter: nodeAdapter() });
const server = await createNodeServer(zv);
server.listen(3000);
```

### Express middleware

```ts
import express from "express";
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { expressMiddleware } from "zelavis/express";

const zv = new Zelavis({ adapter: nodeAdapter() });
const app = express();
app.use(expressMiddleware(zv));
app.listen(3000);
```

### Hono on Cloudflare Workers

```ts
import { Hono } from "hono";
import { Zelavis } from "zelavis";
import { cloudflareAdapter } from "zelavis/adapters/cloudflare";
import { honoMiddleware } from "zelavis/hono";

export default {
  fetch(request: Request, env: CloudflareAdapterEnv) {
    const zv = new Zelavis({ adapter: cloudflareAdapter({ env }) });
    const app = new Hono();
    app.use(honoMiddleware(zv));
    return app.fetch(request);
  },
};
```

### Next.js App Router (fetch-native, no helper needed)

```ts
import { Zelavis } from "zelavis";
import { vercelAdapter } from "zelavis/adapters/vercel";

const zv = new Zelavis({ adapter: vercelAdapter() });

export async function GET(request: Request) {
  return zv.fetch(request);
}
```

### Cloudflare Workers (fetch-native)

```ts
import { Zelavis } from "zelavis";
import { cloudflareAdapter } from "zelavis/adapters/cloudflare";

export default {
  fetch(request: Request, env) {
    const zv = new Zelavis({ adapter: cloudflareAdapter({ env }) });
    return zv.fetch(request);
  },
};
```

## Adapters

The adapter is the environment Zelavis runs on. It provides:

- A database driver default
- KV / file storage defaults
- Dashboard settings persistence

Available adapters under `zelavis/adapters`:

| Adapter | Import path | Provides |
|---|---|---|
| Node.js | `zelavis/adapters/node` | better-sqlite3, file dashboard settings, local KV/files |
| Bun | `zelavis/adapters/bun` | bun:sqlite, file dashboard settings, local KV/files |
| Cloudflare Workers | `zelavis/adapters/cloudflare` | D1, KV, R2 from worker bindings |
| Vercel | `zelavis/adapters/vercel` | Injected Vercel Blob and KV resources |
| Netlify | `zelavis/adapters/netlify` | Netlify Blobs for KV and files |

All adapters are also re-exported from the barrel `zelavis/adapters` under both their canonical names and `zelavisX` aliases:

```ts
import {
  zelavisNode,
  zelavisBun,
  zelavisCloudflare,
  zelavisVercel,
  zelavisNetlify,
} from "zelavis/adapters";
```

## Framework utilities

Framework utilities are simple functions that take a `Zelavis` instance and return whatever shape the host framework expects:

| Framework | Import | Returns |
|---|---|---|
| Express | `zelavis/express` → `expressMiddleware(zv)` | `RequestHandler` |
| Hono | `zelavis/hono` → `honoMiddleware(zv)` | `MiddlewareHandler` |
| Fastify | `zelavis/fastify` → `fastifyPlugin(zv)` | `FastifyPluginAsync` |
| h3 | `zelavis/h3` → `h3Handler(zv)` | h3 handler |
| Elysia | `zelavis/elysia` → `elysiaPlugin(zv)` | Elysia service instance |
| Next.js Pages Router | `zelavis/nextjs/pages` → `nextjsPagesRouterHandler(zv, options?)` | `NextApiHandler` |
| Node HTTP server | `zelavis/node` → `createNodeServer(zv)` | `Promise<http.Server>` |

Each utility internally lazy-initializes the runtime on first request, so you can construct your `Zelavis` instance at module top level.

## Defining a custom adapter

For new environments, build an adapter with `defineAdapter`:

```ts
import { defineAdapter } from "zelavis";

export function herokuAdapter() {
  return defineAdapter({
    name: "heroku",
    async resolve(_options) {
      // Reuse nodeAdapter() resolve logic, then override Heroku specifics
      return {
        // resources, metadata
      };
    },
  });
}
```

The adapter shape is just:

```ts
interface ZelavisAdapter {
  name: string;
  resolve?(options: ZelavisOptions):
    | ZelavisResolvedPlatformOptions
    | Promise<ZelavisResolvedPlatformOptions>;
}
```

If a host supports runtime service installs, its adapter should expose that through `resources.services`. The service activation controller declares whether the host can apply runtime installs, resolve uploaded ESM specifiers, and isolate service execution. This keeps Node-style filesystem caches, Cloudflare-style worker dispatch, and other host mechanics outside portable core.

## Why no `zelavis.adapter.xxx` anymore

In earlier iterations the framework integration was modeled as an "adapter" object that the runtime mounted (`zelavis.adapter.expressMiddleware()`). We removed that because framework integration is not actually an adapter pattern — it's a small request/response converter. The new shape (`expressMiddleware(zv)`) is simpler, has no lifecycle coupling, and produces clean type inference.

The only real adapter pattern in Zelavis is the environment adapter, and that's what `defineAdapter` is for.

## Related docs

- [Adapter Entry Points](../adapters/entry-points.md)
- [Platform Adapters](../reference/platform-presets.md)
- [First Runtime](../getting-started/first-runtime.md)
