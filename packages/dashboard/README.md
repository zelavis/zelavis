# @zelavis/dashboard

`@zelavis/dashboard` is the server-rendered admin surface used by the high-level `zelavis` runtime.

It does not own auth, commerce, or database logic. Instead, it provides a small HTML dashboard service that can be mounted through `@zelavis/server` and replaced entirely by consumers that want a custom control panel.

The high-level `zelavis` package includes this dashboard as a core service by default at `/zelavis`. Use `@zelavis/dashboard` directly when you need the lower-level dashboard service primitive.

## Purpose

- Ship a default dashboard route for common `zelavis` stacks.
- Keep the UI transport simple enough to work across server integrations.
- Stay replaceable so advanced users can mount their own dashboard.

## Initial surface

- `createDashboardService(options)`
- `dashboardService(options)`
- `createDefaultDashboardDefinition()`
- `defaultDashboardStyles`

## Example

```ts
import express from "express";
import { dashboardService } from "@zelavis/dashboard";
import { zelavisServer } from "@zelavis/server";
import { expressIntegration } from "@zelavis/server/integrations/express";

async function main(): Promise<void> {
  const app = express();
  const router = express.Router();

  await zelavisServer({
    services: [
      dashboardService({
        title: "zelavis control",
      }),
    ],
    integration: expressIntegration(router),
  });

  app.use(router);
  app.listen(3000);
}

void main();
```

The default service exposes:

- `/dashboard`
- `/dashboard/customers`
- `/dashboard/orders`
- `/dashboard/system`
- `/dashboard/assets/dashboard.css`
