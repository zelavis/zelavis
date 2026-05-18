---
title: Hono
---
Use the Hono utility when Zelavis should be mounted into an existing Hono application.

## Basic usage (Hono on Node)

```ts
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { honoMiddleware } from "zelavis/hono";

const app = new Hono();
const zelavis = new Zelavis({ adapter: nodeAdapter() });

app.use(honoMiddleware(zelavis));

serve({ fetch: app.fetch, port: 3000 });
```

## Hono on Cloudflare Workers

```ts
import { Hono } from "hono";
import { Zelavis } from "zelavis";
import { cloudflareAdapter } from "zelavis/adapters/cloudflare";
import { honoMiddleware } from "zelavis/hono";

export default {
  fetch(request: Request, env) {
    const zelavis = new Zelavis({ adapter: cloudflareAdapter({ env }) });
    const app = new Hono();
    app.use(honoMiddleware(zelavis));
    return app.fetch(request);
  },
};
```

## API

```ts
honoMiddleware(zelavis: Zelavis): MiddlewareHandler
```

## Good fit

- Hono apps running on Node.js or Cloudflare Workers
- Apps that already use Hono middleware and route composition
- Cases where Zelavis should share an app with custom Hono endpoints

## Related docs

- [Adapter Entry Points](./entry-points.md)
- [First Runtime](../getting-started/first-runtime.md)
- [@zelavis/server](../packages/server.md)
