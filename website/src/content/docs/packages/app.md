---
title: "@zelavis/app"
---

`@zelavis/app` is the official Zelavis-native project stack. It owns the app
database, auth, and workloads modules that used to live as separate workspace
packages.

The package is both:

- an installable `kind: "app"` service used by the Platform project creator
- the source for the bundled `packages/zelavis/services/zelavis-app`
  production boilerplate

## App-Owned Modules

Use subpath imports when lower-level code needs direct access:

```ts
import { createDatabase, defineDatabaseService } from "@zelavis/app/db";
import { createAuth, authService } from "@zelavis/app/auth";
import { workloadsService } from "@zelavis/app/workloads";
import { zelavisServer } from "@zelavis/app/server";
```

Runtime service IDs remain stable:

- `@zelavis/db`
- `@zelavis/auth`
- `@zelavis/workloads`

Those names identify mounted runtime capabilities and dashboard menus. They are
not standalone package names anymore.

## Bundled Boilerplate

The published `zelavis` package ships the official app service under
`packages/zelavis/services/zelavis-app`. The sync script stages the built
runtime entry, package metadata, source, adapters, and plugins so project
creation can use it as a real project boilerplate rather than a dist-only
service bundle.

The app package also owns `@zelavis/app/server`. App modules use that server
contract instead of importing the Platform's `@zelavis/server` package. The
Platform still starts app projects in isolated runtimes and proxies requests to
them; sharing the Platform process would collapse the isolation boundary.
