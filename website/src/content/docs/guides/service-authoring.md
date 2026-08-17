---
title: Service Authoring
---
Use this guide when creating a new Zelavis core package, runtime-mounted service, or service package.

The goal is simple:

- one obvious file for the real definition
- one small `index.ts` that re-exports it
- no hunting through nested folders to find the important entrypoint

## Rule 1: Put the real definition in a named top-level file

For core packages, the service definition should live in a named file near the top of `src/`.

Examples:

- [packages/auth/src/auth-service.ts](/Users/ivanjeremicx/Projects/zelavis/packages/auth/src/auth-service.ts)
- [packages/db/src/database-service.ts](/Users/ivanjeremicx/Projects/zelavis/packages/db/src/database-service.ts)

For service packages, the service definition should also live in a named file near the top of the package source.

Examples:

- [plugins/ecommerce/src/ecommerce-service.ts](/Users/ivanjeremicx/Projects/zelavis/plugins/ecommerce/src/ecommerce-service.ts)
- [plugins/ecommerce/plugins/stripe/src/stripe-service.ts](/Users/ivanjeremicx/Projects/zelavis/plugins/ecommerce/plugins/stripe/src/stripe-service.ts)
- [packages/auth/services/email-password/src/email-password-service.ts](/Users/ivanjeremicx/Projects/zelavis/packages/auth/services/email-password/src/email-password-service.ts)

Avoid hiding the real definition under paths like:

- `src/server/service.ts`
- `src/core/define-service.ts`

Those files work mechanically, but they make the package harder to read.

## Rule 2: Keep `index.ts` small and boring

The package `index.ts` should re-export the named definition file instead of re-implementing anything.

Example service package index:

```ts
export * from "./auth-service.js";
export * from "./core/create-auth.js";
export * from "./core/define-auth-service.js";
export * from "./core/types.js";
```

Example service package index:

```ts
export * from "./stripe-service.js";
```

That gives package authors one obvious place to open first, while keeping imports ergonomic.

## Rule 3: Use `defineService(...)` for service definitions

Core services, runtime services, marketplace services, and child services use the same `defineService(...)` builder.

The package-level definition file should expose a factory that returns the service shape:

```ts
import { defineService } from "@zelavis/server";
import type { AuthApi } from "./core/types.js";

export function defineAuthService(auth: AuthApi): AuthServiceDefinition {
  return defineService({
    name: "@zelavis/auth",
    kind: "plugin",
    childServices: ["@zelavis/auth-email-password"],
    basePath: "/auth",
    api: {
      v1: [
        {
          id: "auth.accounts.list",
          method: "GET",
          path: "/accounts",
          handler: async () => ({
            status: 200,
            body: await auth.accounts.list(),
          }),
        },
      ],
    },
  });
}
```

That factory is not accidental extra abstraction.

It is the package's concrete service-definition entrypoint:

- binds the domain API object
- sets the service name
- sets base path and menu metadata
- defines routes
- composes nested services when needed

## Rule 4: Use `defineService(...)` for top-level and child services

For runtime, marketplace, and child services, use the high-level Zelavis `defineService(...)`.

A package-level service definition file should look like this:

```ts
import { defineService } from "zelavis/service";
import type { EcommerceApi } from "@zelavis/ecommerce";

export function stripeService() {
  return defineService<EcommerceApi>({
    name: "@zelavis/ecommerce-stripe",
    extends: "@zelavis/ecommerce",
    marketplace: {
      title: "Stripe",
      categories: ["payments"],
    },
    setup(api) {
      // register provider behavior
    },
  });
}
```

The named file should show the real service options and setup behavior immediately.

Official marketplace/runtime services use the same builder without `extends`:

```ts
import { defineService, ZELAVIS_SERVICE_V1 } from "zelavis";

export const zelavisEcommerceService = defineService({
  name: "@zelavis/ecommerce",
  contractVersion: ZELAVIS_SERVICE_V1,
  childServices: ["@zelavis/ecommerce-stripe", "@zelavis/ecommerce-paypal"],
  setup(context) {
    // register runtime-mounted services and service metadata
  },
});
```

Child services declare `extends` metadata. They are installed through the same registry, but the parent service decides how to consume them and must allow them through `childServices`. Zelavis does not run child services as independent top-level Extensions services.

## Rule 5: Make capabilities endpoint-backed

Anything a service lets users do from the dashboard should also be exposed as a service capability and API endpoint.

Service dashboard pages can present forms, charts, setup flows, and actions, but the authoritative behavior belongs in the service/runtime layer. This lets CLI commands, AI agents, scripts, plugins, and external admin clients use the same operation without depending on the dashboard.

Good shape:

- `setup(context)` registers the capability and endpoint
- `menu.page` renders UI that calls the endpoint
- the operation can be tested without rendering the dashboard

Avoid:

- dashboard-only mutations
- framework-specific server actions as the only execution path
- hiding service behavior inside page rendering code

## Runtime service shape

A top-level service is a normal ESM module. Export the service definition as `default`, `service`, or directly from the module so Zelavis can resolve it through dynamic `import()`.

```ts
import { defineService, ZELAVIS_SERVICE_V1 } from "zelavis";

export default defineService({
  name: "@acme/search",
  contractVersion: ZELAVIS_SERVICE_V1,
  version: "0.1.0",
  menu: {
    title: "Search",
    path: "/search",
    page: {
      id: "dashboard",
      title: "Search",
      render({ service, api }) {
        return {
          html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${service}</title>
  </head>
  <body>
    <main data-api="${api.basePath}">Search service</main>
  </body>
</html>`,
        };
      },
    },
  },
  setup(context) {
    context.addService({
      name: "search",
      basePath: "/search",
      service: {},
      api: {
        v1: [
          {
            id: "search.health",
            method: "GET",
            path: "/health",
            handler: () => ({ status: 200, body: { ok: true } }),
          },
        ],
      },
    });
  },
});
```

Important details:

- `name` is the stable runtime service id and should match the registry/catalog name.
- `version` is service metadata; package publishing still follows the package registry.
- `menu` is plain metadata. Services never reach into dashboard sidebar internals.
- `menu.page.render(...)` returns a full HTML document string or `{ html, status, headers, contentType }`.
- Service pages are mounted in the dashboard through the `zelavis-service-frame` iframe web component.
- `setup(context)` may register runtime services through `context.addService(...)`, `context.addServices(...)`, or by returning `{ runtimeServices }`.
- Child services use `extends` and are passed to their parent service; they do not get their own Extensions menu area.

The repo includes `examples/plugin-basic` as a minimal uploadable service. Build its upload package with `pnpm --filter @zelavis/example-plugin-basic package`, then select `examples/plugin-basic/dist/example-basic.zip` in the Node example project Marketplace flow at `/zelavis/projects/default/marketplace`. The service module defines its own `name`, `version`, menu, pages, and services, so the dashboard does not ask for a separate service name. The ZIP includes `zelavis.service.json`, whose `entry` field points at the ESM module the host adapter should import.

## Registry and activation

The runtime registry stores service entries separately from Marketplace catalog metadata:

```ts
{
  name: "@acme/search",
  specifier: "https://cdn.example.com/acme-search.mjs",
  status: "installed",
  source: "community",
  order: 10,
}
```

`specifier` is an ESM module entry point. On Node, the adapter can resolve package names, local files, `data:` URLs, and remote ESM cached under `.zelavis/services`. Bun follows the same local-runtime shape.

Installing a service updates registry state. Activation is adapter-owned:

- Local runtime adapters can recompose the in-process runtime graph when supported.
- Hosts without activation support can still store registry metadata, but installs may remain pending.

## Rule 5: Keep orchestration helpers only when they add real value

Some helpers are worth keeping.

Example:

- `authService(...)`

That helper still does real orchestration:

- creates auth if needed
- applies auth service services
- returns the final mounted service definition

Some helpers are not worth keeping.

Example:

- old `databaseService(...)`

That function only forwarded to `defineDatabaseService(...)`, so it added noise without adding behavior.

The rule:

- keep orchestration helpers when they actually orchestrate
- remove them when they only rename another function

## Preferred package shapes

### Core package with a mounted service

```text
src/
  auth-service.ts
  index.ts
  core/
  services/
  storage/
```

Use this when the package exposes a runtime-mounted Zelavis service.

### Core package with a service builder

```text
src/
  ecommerce-service.ts
  index.ts
  core/
  services/
  storage/
```

Use this when the package's main adapter surface is a service contract rather than a mounted runtime service.

### Nested service package

```text
src/
  stripe-service.ts
  index.ts
```

Use this for focused provider packages and optional extension packages.

## Naming guidance

Prefer these names:

- `defineAuthService(...)`
- `defineDatabaseService(...)`
- `defineService(...)`
- `stripeService(...)`
- `paypalService(...)`

Avoid names that make the entrypoint harder to spot:

- `createAuthServerService(...)`
- database server service aliases that only rename the real entrypoint
- deeply nested `service.ts`
- deeply nested `define-service.ts`

## What this buys us

- package authors know where to start reading
- docs can point to one stable file
- package entrypoints stay ergonomic
- service and service authoring look like the same family of patterns
- the repo feels more intentional and less accidental

## Related docs

- [Service Model](../architecture/service-model.md)
- [Advanced Runtime Composition](./advanced-runtime-composition.md)
- [@zelavis/server](../packages/server.md)
