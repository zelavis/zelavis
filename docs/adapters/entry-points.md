# Adapter Entry Points

Zelavis currently exposes adapter entry points from both the high-level `zelavis` package and the lower-level `@zelavis/server` package.

## High-level runtime adapters

Use these when you want the default Zelavis runtime plus a framework-specific mount helper:

```txt
zelavis/adapters/node
zelavis/adapters/express
zelavis/adapters/fastify
zelavis/adapters/hono
zelavis/adapters/h3
zelavis/adapters/elysia
zelavis/adapters/nextjs-pages-router
```

Typical usage:

```ts
import { zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";

const runtime = await zelavis();
const server = nodeAdapter(runtime);
```

## Lower-level server adapters

Use these when you are working directly with `zelavisServer(...)` or custom server services:

```txt
@zelavis/server/adapters/node
@zelavis/server/adapters/express
@zelavis/server/adapters/fastify
@zelavis/server/adapters/hono
@zelavis/server/adapters/h3
@zelavis/server/adapters/elysia
@zelavis/server/adapters/nextjs-pages-router
```

Typical usage:

```ts
import { defineServerService, zelavisServer } from "@zelavis/server";
import { nodeAdapter } from "@zelavis/server/adapters/node";

const runtime = await zelavisServer({
  services: [
    defineServerService({
      name: "health",
      api: {
        v1: [
          {
            id: "health.read",
            method: "GET",
            path: "/health",
            handler: () => ({ status: 200, body: { ok: true } }),
          },
        ],
      },
    }),
  ],
});

const server = nodeAdapter(runtime);
```

## When not to use an adapter

If the host already speaks the standard Web `Request`/`Response` model, use `runtime.fetch(request)` directly instead of wrapping it in a framework adapter.

That is the preferred shape for fetch-native environments such as:

- Cloudflare Workers
- Next.js App Router route handlers
- other Web-standard server runtimes

## Related docs

- [Node Adapter](./node.md)
- [First Runtime](../getting-started/first-runtime.md)
- [@zelavis/server](../packages/server.md)
