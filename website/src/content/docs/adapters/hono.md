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
const zv = new Zelavis({ adapter: nodeAdapter() });

app.use(honoMiddleware(zv));

serve({ fetch: app.fetch, port: 3000 });
```

## Hono on Bun

```ts
import { Hono } from "hono";
import { Zelavis } from "zelavis";
import { bunAdapter } from "zelavis/adapters/bun";
import { honoMiddleware } from "zelavis/hono";

const app = new Hono();
const zv = new Zelavis({ adapter: bunAdapter() });

app.use(honoMiddleware(zv));

Bun.serve({
  port: 3000,
  fetch: app.fetch,
});
```

## API

```ts
honoMiddleware(zv: Zelavis): MiddlewareHandler
```

## Good fit

- Hono apps running on Node.js or Bun
- Apps that already use Hono middleware and route composition
- Cases where Zelavis should share an app with custom Hono endpoints

## Related docs

- [Adapter Entry Points](./entry-points.md)
- [First Runtime](../getting-started/first-runtime.md)
- [@zelavis/server](../packages/server.md)
