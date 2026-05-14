# Hono Adapter

Use the Hono adapter when Zelavis should be mounted into an existing Hono application.

## Basic usage

```ts
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { Zelavis } from "zelavis";
import { zelavisHono, zelavisNode } from "zelavis/adapters";

const app = new Hono();
const zelavis = new Zelavis({
  adapter: zelavisHono({ platform: zelavisNode() }),
});

app.use(zelavis.adapter.honoMiddleware());

serve({ fetch: app.fetch, port: 3000 });
```

## Hono on Cloudflare Workers

Hono is fetch-native on Cloudflare Workers. Swap the platform adapter and the rest stays the same:

```ts
import { zelavisHono, zelavisCloudflare } from "zelavis/adapters";

const zelavis = new Zelavis({
  adapter: zelavisHono({ platform: zelavisCloudflare({ env }) }),
});
```

## Options

```ts
zelavisHono({
  platform?: ZelavisAdapterPlatform;
})
```

## Good fit

- Hono apps running on Node.js or Cloudflare Workers
- Apps that already use Hono middleware and route composition
- Cases where Zelavis should share an app with custom Hono endpoints

## Notes

- Hono remains the outer app boundary.
- Zelavis routes stay Web-standard internally and are adapted into Hono's middleware shape.

## Related docs

- [Adapter Entry Points](./entry-points.md)
- [First Runtime](../getting-started/first-runtime.md)
- [@zelavis/server](../packages/server.md)
