# Adapters

Every Zelavis setup uses exactly one adapter. The adapter tells Zelavis two things:

- How to mount into the host environment (framework middleware, HTTP server, or nothing for fetch-native hosts)
- What host infrastructure to use (database, KV, file storage)

Both concerns live in one object and come from one import path.

```ts
import { zelavisExpress, zelavisNode } from "zelavis/adapters";
```

## The short rule

Pick the adapter that matches your host:

| Host | Adapter |
|---|---|
| Standalone Node HTTP server | `zelavisNodeServer({ platform: zelavisNode() })` |
| Express | `zelavisExpress({ platform: zelavisNode() })` |
| Fastify | `zelavisFastify({ platform: zelavisNode() })` |
| Hono on Node | `zelavisHono({ platform: zelavisNode() })` |
| Hono on Cloudflare Workers | `zelavisHono({ platform: zelavisCloudflare({ env }) })` |
| Next.js App Router | `zelavisVercel()` |
| Cloudflare Workers | `zelavisCloudflare({ env })` |
| Vercel | `zelavisVercel()` |
| Netlify | `zelavisNetlify({ kv, files })` |
| Bun fetch handler | `zelavisBun()` |
| Any fetch-native host | `zelavisFetch()` |

## Framework adapters

Framework adapters answer: *how does Zelavis mount into this host?*

They accept an optional `platform` option that contributes host infrastructure. Without a `platform`, Zelavis has no infrastructure opinions — useful when you supply your own database and storage configuration directly.

```ts
import { Zelavis } from "zelavis";
import { zelavisExpress, zelavisNode } from "zelavis/adapters";

const zelavis = new Zelavis({
  adapter: zelavisExpress({ platform: zelavisNode() }),
});

const app = express();
app.use(zelavis.adapter.expressMiddleware());
app.listen(3000);
```

Available framework adapters: `zelavisExpress`, `zelavisHono`, `zelavisFastify`, `zelavisH3`, `zelavisElysia`, `zelavisNodeServer`, `zelavisNextjsPagesRouter`.

## Fetch-native hosts

Some hosts already speak the Web-standard `Request` → `Response` model directly: Cloudflare Workers, Bun, Next.js App Router route handlers, and similar runtimes. These hosts do not need a framework adapter for mounting — you call `zelavis.fetch(request)` directly.

The platform adapter still applies for infrastructure:

```ts
import { Zelavis } from "zelavis";
import { zelavisCloudflare } from "zelavis/adapters";

const zelavis = new Zelavis({
  adapter: zelavisCloudflare({ env }),
});

export default {
  async fetch(request, env, ctx) {
    return zelavis.fetch(request, ctx);
  },
};
```

## The fetch adapter

`zelavisFetch()` is the explicit form for a fetch-native host with no platform opinions. Use it when the host is already fetch-native and you are wiring up Zelavis infrastructure manually through the `Zelavis` constructor options.

```ts
import { Zelavis } from "zelavis";
import { zelavisFetch } from "zelavis/adapters";

const zelavis = new Zelavis({
  adapter: zelavisFetch(),
  coreServices: { database: myCustomDriver },
});

export default {
  fetch(request) {
    return zelavis.fetch(request);
  },
};
```

## Platform-only adapters

Some adapters only contribute infrastructure and have no framework mounting logic. Cloudflare, Vercel, Netlify, Node, and Bun platform adapters work this way — they provide storage defaults and you call `zelavis.fetch(request)` yourself.

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

## Composing framework and platform

Framework adapters accept a `platform` option so you can pair any supported framework with any supported platform:

```ts
import { zelavisHono, zelavisCloudflare } from "zelavis/adapters";

// Hono running on Cloudflare Workers
new Zelavis({
  adapter: zelavisHono({ platform: zelavisCloudflare({ env }) }),
});
```

```ts
import { zelavisExpress, zelavisNode } from "zelavis/adapters";

// Express running on a Node VPS
new Zelavis({
  adapter: zelavisExpress({ platform: zelavisNode() }),
});
```

## Defining custom adapters

Use `defineAdapter` to build your own adapter. The `mount` option handles framework mounting and the `platform` option contributes infrastructure resolution. Both are optional.

```ts
import { defineAdapter } from "zelavis";

const myAdapter = defineAdapter({
  name: "my-host",
  platform: (options) => ({
    resources: {
      kv: myKvStore,
      files: myFileStorage,
    },
  }),
  mount: ({ getRuntime }) => ({
    async myHandler(request) {
      const runtime = await getRuntime();
      return runtime.fetch(request);
    },
  }),
});
```

The `platform` option can be a function or an object with a `resolve` method. The `mount` option can be a function or an object with a `bind` method. Both forms are equivalent.

## Related docs

- [Adapter Entry Points](../adapters/entry-points.md)
- [First Runtime](../getting-started/first-runtime.md)
