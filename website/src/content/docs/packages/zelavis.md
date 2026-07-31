---
title: zelavis
---
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

const zv = new Zelavis({
  adapter: nodeAdapter(),
});
```

Treat this as the normal public API.

## High-level vs low-level

Prefer these layers in order:

1. `new Zelavis(...)` for application/runtime work
2. scoped packages like `@zelavis/server` for primitive-level infrastructure

The lower-level `zelavis()` function still exists, but it now intentionally owns the internal runtime controls such as:

- direct `services`
- path and mount overrides

The `Zelavis` class is the product-facing entrypoint. Built-in services are part of the runtime by default; lower-level route mounting knobs stay on `zelavis()`.

Examples use `zv` as the short local name for a `Zelavis` runtime instance.

## Default behavior

By default, Zelavis owns one safe namespace under `/zelavis` and includes dashboard, auth, database, and website core services.

The dashboard stays mounted under the configured root path, while API services stay grouped under `/api/<version>/...`.

Application code can access core service APIs through the runtime instance:

```ts
await zv.db.documents.createCollection({ name: "posts" });

const doc = await zv.db.documents.insert({
  collection: "posts",
  data: { title: "Hello" },
});

const account = await zv.auth.accounts.create({
  id: "owner",
  email: "owner@example.com",
});
```

## When to use lower-level packages instead

Use scoped packages directly when you need lower-level control over primitives, adapters, or tests:

- `@zelavis/server`
- `@zelavis/db`
- `@zelavis/auth`

The lower-level `zelavis()` function still exists for internal runtime composition, but the main public application-facing entry point is the `Zelavis` class plus a runtime adapter.

Available runtime adapters:

- `zelavis/adapters/node`
- `zelavis/adapters/bun`

Deno is a planned runtime target.

Framework utilities (small wrappers around `zv.fetch`) live at:

- `zelavis/express`, `zelavis/hono`, `zelavis/fastify`, `zelavis/h3`, `zelavis/elysia`
- `zelavis/nextjs/pages` (Next.js Pages Router)
- `zelavis/node` (standalone Node HTTP server)

## Related docs

- [First Runtime](../getting-started/first-runtime.md)
- [@zelavis/server](./server.md)
- [@zelavis/db](./database.md)
- [@zelavis/auth](./auth.md)
