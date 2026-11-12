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
import { createAuth, authService } from "zelavis/app/identity";
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

The recipe includes Project-owned Auth with password sign-in, optional public
registration, session lifecycle, OAuth/OpenID Connect configuration, and durable
accounts and credentials in the Project database. These identities are the
App's users; Platform owners and service accounts remain a separate authority
boundary. Registration starts closed and the Project's saved setting applies
immediately. Closing it preserves existing sign-in. The Platform can manage
the setting on a running Project with `zelavis projects registration-settings PROJECT`
and `zelavis projects set-registration-settings PROJECT --data JSON`.
Visitors sign in at `/zelavis/login` on the App's verified site hostname or
Edge preview. When the App owner enables password registration, the login
page links to `/zelavis/sign-up`. Both forms return to the site's root on
success and work alongside the Project's selected frontend. Use HTTPS for
public password traffic. Connect the hostname through **Project → Domains** and
wait for it to become active. For an App at `https://app.example.com`, the
public signup URL is `https://app.example.com/zelavis/sign-up`.
See [Project hostname setup](../architecture/edge.md#connect-a-project-hostname)
and [Auth](./auth.md).
