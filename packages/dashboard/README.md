# @zelavis/dashboard

`@zelavis/dashboard` is an optional server-rendered admin surface for `zelavis` stacks.

It does not own auth, commerce, or database logic. Instead, it provides a small HTML dashboard service that can be mounted through `@zelavis/server` and replaced entirely by consumers that want a custom control panel.

## Purpose

- Ship a default dashboard route for common `zelavis` stacks.
- Keep the UI transport simple enough to work across server integrations.
- Stay optional so advanced users can mount their own dashboard.

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
