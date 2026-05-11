# Service and Plugin Authoring

Use this guide when creating a new Zelavis core package, runtime-mounted service, or plugin package.

The goal is simple:

- one obvious file for the real definition
- one small `index.ts` that re-exports it
- no hunting through nested folders to find the important entrypoint

## Rule 1: Put the real definition in a named top-level file

For core packages, the service definition should live in a named file near the top of `src/`.

Examples:

- [packages/auth/src/auth-service.ts](/Users/ivanjeremicx/Projects/zelavis/packages/auth/src/auth-service.ts)
- [packages/database/src/database-service.ts](/Users/ivanjeremicx/Projects/zelavis/packages/database/src/database-service.ts)

For plugin packages, the plugin definition should also live in a named file near the top of the package source.

Examples:

- [packages/plugins/ecommerce/src/ecommerce-plugin.ts](/Users/ivanjeremicx/Projects/zelavis/packages/plugins/ecommerce/src/ecommerce-plugin.ts)
- [packages/plugins/ecommerce/plugins/stripe/src/stripe-plugin.ts](/Users/ivanjeremicx/Projects/zelavis/packages/plugins/ecommerce/plugins/stripe/src/stripe-plugin.ts)
- [packages/auth/plugins/email-password/src/email-password-plugin.ts](/Users/ivanjeremicx/Projects/zelavis/packages/auth/plugins/email-password/src/email-password-plugin.ts)

Avoid hiding the real definition under paths like:

- `src/server/service.ts`
- `src/core/define-plugin.ts`

Those files work mechanically, but they make the package harder to read.

## Rule 2: Keep `index.ts` small and boring

The package `index.ts` should re-export the named definition file instead of re-implementing anything.

Example service package index:

```ts
export * from "./auth-service.js";
export * from "./core/create-auth.js";
export * from "./core/define-auth-plugin.js";
export * from "./core/types.js";
```

Example plugin package index:

```ts
export * from "./stripe-plugin.js";
```

That gives package authors one obvious place to open first, while keeping imports ergonomic.

## Rule 3: Use `defineService(...)` for mounted runtime services

`defineService(...)` is the low-level builder for runtime-mounted services.

The package-level definition file should wrap that builder with the package's real semantics:

```ts
import { defineService, type ZelavisService } from "@zelavis/server";
import type { AuthApi } from "./core/types.js";

export type AuthServiceDefinition = ZelavisService<AuthApi>;

export function defineAuthService(auth: AuthApi): AuthServiceDefinition {
  return defineService({
    name: "auth",
    basePath: "/auth",
    service: auth,
    api: {
      v1: [
        // routes
      ],
    },
  });
}
```

That wrapper is not accidental extra abstraction.

It is the package's concrete service-definition entrypoint:

- binds the domain API object
- sets the service name
- sets base path and menu metadata
- defines routes
- composes nested services when needed

## Rule 4: Use the package-appropriate plugin builder

For runtime and marketplace plugins, use the high-level Zelavis `definePlugin(...)`.

For lower-level domain packages, use a package-local builder when the package needs to stay independently usable.

A package-level plugin definition file should look like this:

```ts
import { defineEcommercePlugin } from "@zelavis/ecommerce";

export function stripePlugin() {
  return defineEcommercePlugin({
    name: "stripe",
    setup(api) {
      // register provider behavior
    },
  });
}
```

The named file should show the real plugin options and setup behavior immediately.

Use the high-level Zelavis builder for official marketplace/runtime plugins:

```ts
import { definePlugin, ZELAVIS_PLUGIN_V1 } from "zelavis";

export const zelavisEcommercePlugin = definePlugin({
  name: "zelavis-ecommerce",
  contractVersion: ZELAVIS_PLUGIN_V1,
  setup(context) {
    // register runtime-mounted services and plugin metadata
  },
});
```

## Rule 5: Keep orchestration helpers only when they add real value

Some helpers are worth keeping.

Example:

- `authService(...)`

That helper still does real orchestration:

- creates auth if needed
- applies auth service plugins
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

### Core package with a plugin builder

```text
src/
  ecommerce-plugin.ts
  index.ts
  core/
  services/
  storage/
```

Use this when the package's main extension point is a plugin contract rather than a mounted runtime service.

### Nested plugin package

```text
src/
  stripe-plugin.ts
  index.ts
```

Use this for focused provider packages and optional extension packages.

## Naming guidance

Prefer these names:

- `defineService(...)`
- `defineAuthService(...)`
- `defineDatabaseService(...)`
- `definePlugin(...)`
- `defineEcommercePlugin(...)`
- `stripePlugin(...)`
- `paypalPlugin(...)`

Avoid names that make the entrypoint harder to spot:

- `createAuthServerService(...)`
- `createDatabaseServerService(...)`
- deeply nested `service.ts`
- deeply nested `define-plugin.ts`

## What this buys us

- package authors know where to start reading
- docs can point to one stable file
- package entrypoints stay ergonomic
- service and plugin authoring look like the same family of patterns
- the repo feels more intentional and less accidental

## Related docs

- [Plugin and Service Model](../architecture/plugin-service-model.md)
- [Advanced Runtime Composition](./advanced-runtime-composition.md)
- [@zelavis/server](../packages/server.md)
