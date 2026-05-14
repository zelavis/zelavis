# zelavis

`zelavis` is the high-level runtime package for the Zelavis backend platform.

Use it when you want the default platform building blocks wired together through one runtime entry point.

## Current role

Today, that mostly means:

- dashboard delivery
- auth service
- database service
- storage service when an adapter file store exists
- website service
- runtime composition

## Main entry point

```ts
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";

const zelavis = new Zelavis({
  adapter: nodeAdapter(),
});
```

Treat this as the normal public API.

## High-level vs low-level

Prefer these layers in order:

1. `new Zelavis(...)` for application/runtime work
2. `await zelavis(...)` when you intentionally need advanced runtime composition
3. scoped packages like `@zelavis/server` for primitive-level infrastructure

The lower-level `zelavis()` function still exists, but it now intentionally owns the internal runtime controls such as:

- `coreServices`
- direct `services`
- path and mount overrides

The `Zelavis` class is the safer product-facing entrypoint and does not accept those internal knobs.

For the focused lower-level story, see [Advanced Runtime Composition](../guides/advanced-runtime-composition.md).

## Default behavior

By default, Zelavis owns one safe namespace under `/zelavis` and includes dashboard, auth, database, and website core services.

The dashboard stays mounted under the configured root path, while API services stay grouped under `/api/<version>/...`.

## When to use lower-level packages instead

Use scoped packages directly when you need lower-level control over primitives, adapters, or tests:

- `@zelavis/server`
- `@zelavis/database`
- `@zelavis/auth`

The lower-level `zelavis()` function still exists for direct runtime composition, but the main public application-facing entry point is the `Zelavis` class plus an environment adapter.

Available environment adapters:

- `zelavis/adapters/node`
- `zelavis/adapters/bun`
- `zelavis/adapters/cloudflare`
- `zelavis/adapters/netlify`
- `zelavis/adapters/vercel`

Framework utilities (small wrappers around `zelavis.fetch`) live at:

- `zelavis/express`, `zelavis/hono`, `zelavis/fastify`, `zelavis/h3`, `zelavis/elysia`
- `zelavis/nextjs/pages` (Next.js Pages Router)
- `zelavis/node` (standalone Node HTTP server)

## Related docs

- [First Runtime](../getting-started/first-runtime.md)
- [@zelavis/server](./server.md)
- [@zelavis/database](./database.md)
- [@zelavis/auth](./auth.md)
