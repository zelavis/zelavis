---
title: Advanced Runtime Access
---
Use `new Zelavis(...)` for public application code. The lower-level `zelavis(...)` function is reserved for internal runtime composition.

## When to use it

Reach for the runtime instance when you need things like:

- direct `fetch(...)` handling
- access to the initialized runtime through `zv.runtime()`
- subsystem APIs such as `zv.db` and `zv.auth`

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

## Project recipe composition

The in-process
composition is internal runtime plumbing; create-project definitions are
Project recipes: services with `kind: "app"`.

The pattern is:

1. A package exposes a normal server-service factory.
2. That factory returns a plain `ZelavisRuntimeService` object literal.
3. A Project recipe decides when to call that factory and include the result in
   a created Project runtime.

For example:

- database package factory:
  `packages/zelavis/src/db/database-service.ts`
- high-level runtime assembly:
  `packages/zelavis/src/index.ts`

Concretely:

- `zelavis/app/db` exports `defineDatabaseService(database)`
- that function returns a plain `{ name, basePath, service, api }` object
- then `zelavis/app` receives the project database API, wraps it with
  `defineDatabaseService(...)`, and mounts it for that project runtime

The same low-level runtime service shape is used for System Services and project
services, but their ownership and persistence are different.

The Platform's own pieces are configured by what they are, never as
installable services:

- `subsystems` on `zelavis(...)` carries `auth`, `database`, `fabric`,
  `storage`, `workloads`, and `site` — infrastructure and policy switches, not
  installable services.
- `frontend` carries the frontend options: the factory, plus `title`,
  `subtitle`, `devServerUrl`, and a `clientRoutes` override (which falls back
  to the routes the frontend declares for itself).
- `runtimeSettingsStore` carries the settings store. It is a resource, so the
  Platform's own settings persist whether or not a frontend is installed.

`frontend` has no `false`. An installation with no frontend is one with none
installed, and its root path says so while the API is unchanged; a second
code-level switch expressed the same state and could contradict the first.
What that flag actually carried was the kind of runtime, which `role`
(`"platform"` or `"project"`) now states directly.

Services come from the services folder and the registry endpoints, and
only from there. Platform state belongs in the System Store; app-facing
capabilities belong to Project runtimes created from recipes.

## Why this split exists

This gives Zelavis two useful properties:

- packages like `zelavis/app/db` stay independently usable
- the high-level runtime can still reserve extra privileges for built-in system services

That means the service factory itself can stay ordinary, while the runtime decides which services are privileged built-ins.

## Related docs

- [First Runtime](../getting-started/first-runtime.md)
- [zelavis package](../packages/zelavis.md)
- [Adapter Entry Points](../adapters/entry-points.md)
