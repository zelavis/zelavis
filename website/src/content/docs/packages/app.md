---
title: "@zelavis/app"
---

`@zelavis/app` is the official Zelavis-native project stack. It owns the app
database, auth, and workloads modules that used to live as separate workspace
packages.

The package is an independently published `kind: "app"` Project recipe and
runtime stack used directly by the Platform project creator.

## App-Owned Modules

Use subpath imports when lower-level code needs direct access:

```ts
import { createDatabase, defineDatabaseService } from "@zelavis/app/db";
import { createAuth, authService } from "@zelavis/app/auth";
import { workloadsService } from "@zelavis/app/workloads";
import { zelavisServer } from "@zelavis/server";
```

Runtime service IDs remain stable:

- `@zelavis/db`
- `@zelavis/auth`
- `@zelavis/workloads`

Those names identify mounted runtime capabilities and dashboard menus. They are
not standalone package names anymore.

## Project Recipe

The source lives at `packages/app`. The `zelavis` package declares it as a
workspace/package dependency and registers it directly as the official native
Project recipe. No copied package under `packages/zelavis/product-services` is needed.

App modules consume the product-neutral `@zelavis/server` package. Reusing the
engine does not reuse Platform authority: the Platform still starts App
Projects in isolated runtimes and proxies requests through the Project
Gateway. Sharing the Platform process would collapse the isolation boundary.
