---
title: Advanced Runtime Access
---
Use `new Zelavis(...)` for public application code. The lower-level `zelavis(...)` function is reserved for internal runtime composition.

## When to use it

Reach for the runtime instance when you need things like:

- direct `fetch(...)` handling
- access to the initialized runtime through `zv.runtime()`
- core service APIs such as `zv.db` and `zv.auth`

For normal application code, prefer:

```ts
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";

const zv = new Zelavis({
  adapter: nodeAdapter(),
});
```

## Core idea

`new Zelavis(...)` is the product-facing entrypoint. It exposes core APIs such as `zv.db` and `zv.auth`, lazily initializes the server runtime, and provides `fetch`, `dispatch`, and `runtime` methods.

## Example

```ts
import { Zelavis } from "zelavis";

const zv = new Zelavis({
  rootPath: "/admin",
});

const runtime = await zv.runtime();
```

That returns the mounted runtime object with `fetch`, `dispatch`, `plain`, resolved routes, and the service map.

## Transitional in-process Zelavis App composition

There is no separate `defineCoreService(...)` helper. The current in-process
composition is transitional while Zelavis App moves behind its Blueprint and
project runtime boundary.

The pattern is:

1. A package exposes a normal server-service factory.
2. That factory returns a plain `ZelavisRuntimeService` object literal.
3. The current high-level development runtime decides when to call that factory
   and include the result for the default Zelavis App project.

For example:

- database package factory:
  [packages/db/src/database-service.ts](/Users/ivanjeremicx/Projects/zelavis/packages/db/src/database-service.ts)
- high-level runtime assembly:
  [packages/zelavis/src/index.ts](/Users/ivanjeremicx/Projects/zelavis/packages/zelavis/src/index.ts)

Concretely:

- `@zelavis/db` exports `defineDatabaseService(database)`
- that function returns a plain `{ name, basePath, service, api }` object
- then the transitional runtime calls `resolveDatabaseCoreService(...)`, wraps
  the returned database API with `defineDatabaseService(...)`, and mounts it
  for the default Zelavis App project

The same low-level runtime service shape is used for System Services and project
services, but their ownership and persistence are different.

Do not build new architecture around the `coreServices` option name. It is
transitional composition internals, not the product boundary. Platform state
belongs in the System Store; Zelavis App capabilities belong to Blueprint projects.

## Why this split exists

This gives Zelavis two useful properties:

- packages like `@zelavis/db` stay independently usable
- the high-level runtime can still reserve extra privileges for built-in core services

That means the service factory itself can stay ordinary, while the runtime decides which services are privileged built-ins.

## Related docs

- [First Runtime](../getting-started/first-runtime.md)
- [zelavis package](../packages/zelavis.md)
- [Adapter Entry Points](../adapters/entry-points.md)
