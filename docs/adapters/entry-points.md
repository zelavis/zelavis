# Adapter Entry Points

All Zelavis adapters — framework adapters, platform adapters, and the fetch-native adapter — come from a single entry point:

```ts
import { ... } from "zelavis/adapters";
```

## Available adapters

### Framework adapters

Framework adapters mount Zelavis into an existing host framework. Each accepts an optional `platform` option for pairing with a platform adapter.

```txt
zelavisExpress       — Express middleware
zelavisHono          — Hono middleware
zelavisFastify       — Fastify plugin
zelavisH3            — h3 handler
zelavisElysia        — Elysia plugin
zelavisNodeServer    — standalone Node HTTP server
zelavisNextjsPagesRouter — Next.js Pages Router API handler
```

Typical usage:

```ts
import { Zelavis } from "zelavis";
import { zelavisNodeServer, zelavisNode } from "zelavis/adapters";

const zelavis = new Zelavis({
  adapter: zelavisNodeServer({ platform: zelavisNode() }),
});

const server = await zelavis.adapter.nodeServer();
```

### Platform adapters

Platform adapters contribute host-level infrastructure: database, KV, file storage. They work standalone (for fetch-native hosts) or as the `platform` option inside a framework adapter.

```txt
zelavisNode          — Node.js defaults (SQLite, local file storage)
zelavisBun           — Bun defaults (Bun SQLite, local file storage)
zelavisCloudflare    — Cloudflare Workers (D1, KV, R2)
zelavisVercel        — Vercel (injected resources)
zelavisNetlify       — Netlify (Netlify Blobs)
```

Typical usage for a fetch-native host:

```ts
import { Zelavis } from "zelavis";
import { zelavisVercel } from "zelavis/adapters";

const zelavis = new Zelavis({
  adapter: zelavisVercel(),
});

export async function GET(request: Request) {
  return zelavis.fetch(request);
}
```

### Fetch adapter

`zelavisFetch()` is the explicit fetch-native adapter with no platform opinions. Use it when the host is fetch-native and you supply all infrastructure directly through `Zelavis` constructor options.

```ts
import { Zelavis } from "zelavis";
import { zelavisFetch } from "zelavis/adapters";

const zelavis = new Zelavis({
  adapter: zelavisFetch(),
  coreServices: { database: myDriver },
});
```

## Individual deep imports

The individual adapter paths remain available for cases where you want a single adapter without the full barrel:

```txt
zelavis/adapters/express
zelavis/adapters/hono
zelavis/adapters/fastify
zelavis/adapters/h3
zelavis/adapters/elysia
zelavis/adapters/node
zelavis/adapters/nextjs-pages-router
zelavis/platforms/node
zelavis/platforms/bun
zelavis/platforms/cloudflare
zelavis/platforms/netlify
zelavis/platforms/vercel
```

## Lower-level server adapters

The `@zelavis/server` package exposes lower-level adapters for custom runtime assembly:

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
import { defineService, zelavisServer } from "@zelavis/server";
import { nodeAdapter } from "@zelavis/server/adapters/node";

const runtime = await zelavisServer({ services: [...] });
const server = nodeAdapter(runtime);
```

Treat this layer as infrastructure-facing. It is the right tool for custom runtime assembly, not the default recommendation for application code.

## defineAdapter

To build a custom adapter, use `defineAdapter` from the main `zelavis` package:

```ts
import { defineAdapter } from "zelavis";

const myAdapter = defineAdapter({
  name: "my-host",
  platform: (options) => ({
    resources: { kv: myStore },
  }),
  mount: ({ getRuntime }) => ({
    async myHandler(request) {
      const runtime = await getRuntime();
      return runtime.fetch(request);
    },
  }),
});
```

## Related docs

- [Adapters Guide](../guides/adapters-and-fetch-native.md)
- [Platform Adapters](../reference/platform-presets.md)
- [First Runtime](../getting-started/first-runtime.md)
- [@zelavis/server](../packages/server.md)
