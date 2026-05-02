# Hono Adapter

Use the Hono adapter when Zelavis should be mounted into an existing Hono application.

## Basic usage

```ts
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { zelavis } from "zelavis";
import { honoAdapter } from "zelavis/adapters/hono";

const app = new Hono();
const runtime = await zelavis();

app.use(honoAdapter(runtime));

serve({
  fetch: app.fetch,
  port: 3000,
});
```

## Good fit

- Hono apps running on Node.js
- apps that already use Hono middleware and route composition
- cases where Zelavis should share an app with custom Hono endpoints

## Notes

- Hono remains the outer app boundary.
- Zelavis routes stay Web-standard internally and are adapted into Hono’s middleware shape.
- For fetch-native environments, `runtime.fetch(request)` can still be simpler than mounting an adapter.

## Related docs

- [Adapter Entry Points](./entry-points.md)
- [First Runtime](../getting-started/first-runtime.md)
- [@zelavis/server](../packages/server.md)
