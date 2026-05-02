# zelavis

`zelavis` is the high-level runtime package for the Zelavis backend platform.

Use it when you want the default platform building blocks wired together through one runtime entry point.

## Current role

Today, that mostly means:

- dashboard delivery
- auth service
- database service
- website service
- runtime composition

## Main entry point

```ts
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { nodePlatform } from "zelavis/platforms/node";

const zelavis = new Zelavis({
  adapter: nodeAdapter(),
  platform: nodePlatform(),
});
```

## Default behavior

By default, Zelavis owns one safe namespace under `/zelavis` and includes dashboard, auth, database, and website core services.

The dashboard stays mounted under the configured root path, while API services stay grouped under `/api/<version>/...`.

## When to use lower-level packages instead

Use scoped packages directly when you need lower-level control over primitives, adapters, or tests:

- `@zelavis/server`
- `@zelavis/database`
- `@zelavis/auth`

The lower-level `zelavis()` function still exists for direct runtime composition, but the main public application-facing entry point is the `Zelavis` class with framework adapters plus platform presets.

Current platform presets are:

- `zelavis/platforms/node`
- `zelavis/platforms/bun`
- `zelavis/platforms/cloudflare`
- `zelavis/platforms/vercel`

## Related docs

- [First Runtime](../getting-started/first-runtime.md)
- [@zelavis/server](./server.md)
- [@zelavis/database](./database.md)
- [@zelavis/auth](./auth.md)
