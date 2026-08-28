---
title: "zelavis/app"
---

`zelavis/app` is the official Zelavis-native project stack. It owns the app
database, auth, and workloads modules that used to live as separate workspace
packages.

It is a `kind: "app"` Project recipe and runtime stack exported as a subpath of
the unified `zelavis` package and used directly by the Platform project creator.

## App-Owned Modules

Use subpath imports when lower-level code needs direct access:

```ts
import { createDatabase, defineDatabaseService } from "zelavis/app/db";
import { createAuth, authService } from "zelavis/app/auth";
import { workloadsService } from "zelavis/app/workloads";
import { createServiceRuntime } from "zelavis/core";
```

Runtime service IDs remain stable:

- `@zelavis/db`
- `@zelavis/auth`
- `@zelavis/workloads`

Those names identify mounted runtime capabilities and dashboard menus. They are
not standalone package names anymore.

## Project Recipe

The source lives at `packages/zelavis/src/app`. The root package registers it
directly as the official native Project recipe. No copied service package or
second App distribution is needed.

App modules consume the product-neutral `zelavis/core` subpath. Reusing the
engine does not reuse Platform authority: the Platform still starts App
Projects in isolated runtimes and proxies requests through the Project
Gateway. Sharing the Platform process would collapse the isolation boundary.

Every Project stores the exact recipe/runtime version chosen at creation. A
parent Platform upgrade preserves that lock. The current Node driver does not
yet materialize older versions independently; immutable Project artifacts are
the next step for true side-by-side version execution.
