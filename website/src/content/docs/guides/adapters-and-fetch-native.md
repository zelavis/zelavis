---
title: Adapters and Framework Utilities
---
Zelavis has a clean two-layer adapter model:

1. **Runtime adapters** describe the self-hosted JavaScript runtime Zelavis runs
   on. Today that means Node.js and Bun. Deno is planned.
2. **Framework utilities** are small helpers that wrap `zv.fetch(request)` for a
   specific host framework such as Express, Hono, Fastify, h3, or Elysia.

The core request handler remains Web-standard: `zv.fetch(request)` accepts a
standard `Request` and returns a standard `Response`. That keeps the core
portable without making serverless platforms runtime targets.

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

### Bun fetch handler

```ts
import { Zelavis } from "zelavis";
import { bunAdapter } from "zelavis/adapters/bun";

const zv = new Zelavis({ adapter: bunAdapter() });

Bun.serve({
  port: 3000,
  fetch(request) {
    return zv.fetch(request);
  },
});
```

## Runtime adapters

| Adapter | Import path | Provides |
|---|---|---|
| Node.js | `zelavis/adapters/node` | better-sqlite3, local files, local service packages |
| Bun | `zelavis/adapters/bun` | bun:sqlite, local files, local service packages |

All adapters are also re-exported from the barrel `zelavis/adapters` under both
their canonical names and `zelavisX` aliases:

```ts
import {
  zelavisNode,
  zelavisBun,
} from "zelavis/adapters";
```

## Framework utilities

Framework utilities take a `Zelavis` instance and return whatever shape the host
framework expects:

| Framework | Import | Returns |
|---|---|---|
| Express | `zelavis/express` -> `expressMiddleware(zv)` | `RequestHandler` |
| Hono | `zelavis/hono` -> `honoMiddleware(zv)` | `MiddlewareHandler` |
| Fastify | `zelavis/fastify` -> `fastifyPlugin(zv)` | `FastifyPluginAsync` |
| h3 | `zelavis/h3` -> `h3Handler(zv)` | h3 handler |
| Elysia | `zelavis/elysia` -> `elysiaPlugin(zv)` | Elysia service instance |
| Next.js Pages Router | `zelavis/nextjs/pages` -> `nextjsPagesRouterHandler(zv, options?)` | `NextApiHandler` |
| Node HTTP server | `zelavis/node` -> `createNodeServer(zv)` | `Promise<http.Server>` |

Each utility internally lazy-initializes the runtime on first request, so you can
construct your `Zelavis` instance at module top level.

## Why no serverless runtime targets

Zelavis is intended to be the platform the operator owns. It should run on a VPS,
dedicated server, container, local machine, or future Deno-compatible
self-hosted environment. Managed platforms can still be deployment providers for
user websites or optional provider adapters, but they are not places where
the Zelavis runtime itself is expected to live.

## Related docs

- [Adapter Entry Points](../adapters/entry-points.md)
- [Runtime Targets](../reference/runtime-targets.md)
- [First Runtime](../getting-started/first-runtime.md)
