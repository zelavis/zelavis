---
title: Express
---
Use the Express utility when Zelavis should live inside an existing Express application.

## Basic usage

```ts
import express from "express";
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { expressMiddleware } from "zelavis/express";

const app = express();
const zelavis = new Zelavis({
  adapter: nodeAdapter(),
});

app.use(express.json());
app.use(expressMiddleware(zelavis));

app.listen(3000);
```

## API

```ts
expressMiddleware(zelavis: Zelavis): RequestHandler
```

Takes a `Zelavis` instance, returns an Express middleware that lazy-initializes the runtime on first request.

## Good fit

- Existing Express apps
- Apps that already own middleware ordering
- Cases where Zelavis should share one process with custom routes

## Notes

- Register any app-specific Express middleware before `expressMiddleware(zelavis)` when those routes should see parsed request bodies or custom headers first.
- Zelavis still serves the dashboard under its configured `rootPath`, for example `/zelavis`.
- The Express app can keep its own routes outside the Zelavis namespace.

## Related docs

- [Adapter Entry Points](./entry-points.md)
- [First Runtime](../getting-started/first-runtime.md)
- [@zelavis/server](../packages/server.md)
