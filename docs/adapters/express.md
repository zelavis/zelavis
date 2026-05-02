# Express Adapter

Use the Express adapter when Zelavis should live inside an existing Express application.

## Basic usage

```ts
import express from "express";
import { Zelavis } from "zelavis";
import { expressAdapter } from "zelavis/adapters/express";
import { nodePlatform } from "zelavis/platforms/node";

const app = express();
const zelavis = new Zelavis({
  adapter: expressAdapter(),
  platform: nodePlatform(),
});

app.use(express.json());
app.use(zelavis.adapter.expressMiddleware());

app.listen(3000);
```

## Good fit

- existing Express apps
- apps that already own middleware ordering
- cases where Zelavis should share one process with custom routes

## Notes

- Register any app-specific Express middleware before `zelavis.adapter.expressMiddleware()` when those routes should see parsed request bodies or custom headers first.
- Zelavis still serves the dashboard under its configured `rootPath`, for example `/zelavis`.
- The Express app can keep its own routes outside the Zelavis namespace.

## Related docs

- [Adapter Entry Points](./entry-points.md)
- [First Runtime](../getting-started/first-runtime.md)
- [@zelavis/server](../packages/server.md)
