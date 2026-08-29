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

- [packages/zelavis/src/app/auth/auth-service.ts](/Users/ivanjeremicx/Projects/zelavis/packages/zelavis/src/app/auth/auth-service.ts)
- [packages/zelavis/src/app/db/database-service.ts](/Users/ivanjeremicx/Projects/zelavis/packages/zelavis/src/app/db/database-service.ts)

For service packages, the service definition should also live in a named file near the top of the package source.

Examples:

- [plugins/ecommerce/src/ecommerce-service.ts](/Users/ivanjeremicx/Projects/zelavis/plugins/ecommerce/src/ecommerce-service.ts)
- [plugins/ecommerce/plugins/stripe/src/stripe-service.ts](/Users/ivanjeremicx/Projects/zelavis/plugins/ecommerce/plugins/stripe/src/stripe-service.ts)
- `plugins/auth-email-password/src/email-password-service.ts`

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

## Rule 3: Use `package.json` manifests and `ZelavisRuntimeService`

Zelavis uses `package.json` as the manifest and configuration surface for plugins and services (`"zelavis": { "kind": "plugin" }`, `"type": "module"`, `"exports"`).

For internal or runtime-mounted services, definition files return frozen `ZelavisRuntimeService` objects:

```ts
import type { ZelavisRuntimeService } from "zelavis";
import type { AuthApi } from "./core/types.js";

export function defineAuthService(auth: AuthApi): ZelavisRuntimeService {
  return Object.freeze({
    name: "@zelavis/auth",
    kind: "plugin",
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

That factory is the package's concrete service-definition entrypoint:

- binds the domain API object
- sets the service name
- sets base path and menu metadata
- defines routes
- contributes explicit capabilities when needed

## Rule 4: Use the official Zelavis SDK (`zelavis/sdk`) for plugins

For plugins that register menus, API routes, commands, or event listeners, use the official Zelavis SDK (`import { zelavis } from "zelavis/sdk"`):

```ts
import { zelavis } from "zelavis/sdk";

zelavis.menu.create({
  title: "Reports",
  path: "/reports",
  page: {
    id: "dashboard",
    file: "dashboard.html",
  },
});

zelavis.routes.create({
  id: "reports.data",
  method: "GET",
  path: "/data",
  handler: async () => ({ status: 200, body: { generatedAt: Date.now() } }),
});
```

Provider plugins declare a capability in `package.json` (`"zelavis": { "kind": "plugin" }`) and export their runtime service:

```ts
import type { EcommerceApi } from "@zelavis/ecommerce";
import type { ZelavisRuntimeService } from "zelavis";

export function stripeService(): ZelavisRuntimeService {
  return Object.freeze({
    name: "@zelavis/ecommerce-stripe",
    kind: "provider",
    capabilities: ["provider:payments"],
    service: {
      name: "stripe",
      register(api: EcommerceApi) {
        // register provider behavior through the public Ecommerce API
      },
    },
  });
}
```

Provider plugins declare a capability such as `provider:auth` or `provider:payments` and expose the corresponding public registration contract as their service value. The owning domain discovers installed providers by capability. There is no hidden parent/child service graph or parent-maintained name allow-list.

## Rule 5: Make capabilities endpoint-backed

Anything a service lets users do from the dashboard should also be exposed as a service capability and API endpoint.

Service dashboard pages can present forms, charts, setup flows, and actions, but the authoritative behavior belongs in the service/runtime layer. This lets CLI commands, AI agents, scripts, plugins, and external admin clients use the same operation without depending on the dashboard.

Good shape:

- `setup(context)` registers the capability and endpoint
- `menu.page.file` selects a bundled HTML entry file that calls the endpoint
- the operation can be tested without rendering the dashboard

Avoid:

- dashboard-only mutations
- framework-specific server actions as the only execution path
- hiding service behavior inside page rendering code

## Runtime service shape

A top-level service is a normal ESM module. Export the service definition as `default`, `service`, or directly from the module so Zelavis can resolve it through dynamic `import()`.

```ts
import { zelavis } from "zelavis/sdk";

zelavis.menu.create({
  title: "Search",
  path: "/search",
  page: {
    id: "dashboard",
    title: "Search",
    file: "dashboard.html",
  },
});

zelavis.routes.create({
  id: "search.health",
  method: "GET",
  path: "/health",
  handler: () => ({ status: 200, body: { ok: true } }),
});
```

The installed service bundle should include `dashboard.html`. That file can be
plain HTML or boot a client app:

```html
<main id="app"></main>
<script type="module" src="./dashboard.js"></script>
```

`dashboard.js` is served from the same service bundle as the HTML file. If it
contains a client router, tabs, or a local menu, that navigation belongs to the
embedded page itself.

Important details:

- `name` is the stable runtime service id and should match the registry/catalog name.
- `version` is service metadata; package publishing still follows the package registry.
- `menu` is plain metadata. Services never reach into dashboard sidebar internals.
- Service pages are mounted in the dashboard through the `zelavis-service-frame` iframe web component.
- `menu.path` is the dashboard URL owned by React Router. `menu.page.file` is
  the browser-extension-style HTML entry file for iframe-backed service UI,
  such as `dashboard.html`, `settings.html`, or `options.html`.
- Zelavis serves `page.file` and sibling assets from the service bundle. A page
  can reference bundled files with normal relative URLs such as
  `<script type="module" src="./settings.js"></script>`.
- If the HTML file boots a SPA, that SPA owns its internal router, tabs, and
  menu. Zelavis sidebar items select concrete HTML entry files; they do not
  deep-link into plugin-private SPA routes.
- Core services whose content already ships with `@zelavis/ui` should use
  `menu.path` without `menu.page`, so the local route renders directly instead
  of mounting an iframe.
- Menu items can use `fixed: true` for slide-local pinned actions such as
  "Add Function". Use `fixedOrder` when a slide has multiple fixed actions.
- Nested slides can set `fixedActionScope` to control whether parent fixed
  actions carry forward: `local` uses only the opened slide's fixed actions,
  `inherit` combines parent and local actions, `replace` uses local actions as
  an explicit boundary, and `clear` hides fixed actions until a deeper slide
  reintroduces them.
- Menu items can use `dynamicItems` when a slide section is backed by runtime
  state. The dynamic endpoint returns `{ "items": [...] }`, and each item uses
  the same metadata shape as static service menu items.
- Menu items can include `search` when navigation depends on URL state, for
  example `{ databaseTable: "products" }`. Prefer returning that from the
  service-owned menu endpoint over hardcoding service-specific lists in the
  dashboard.
- Statically trusted system services can declare a dashboard `surface`.
  `platform` renders in the global `/zelavis` management shell; `root`, `core`,
  `extensions`, and `settings` render in project dashboards. Runtime-installed
  services are forced under Extensions.
- `setup(context)` may register runtime services through `context.addService(...)`, `context.addServices(...)`, or by returning `{ runtimeServices }`.
- Provider plugins are ordinary installed services. They declare a namespaced
  provider capability and expose that domain's explicit registration contract;
  the owning auth, payments, or future domain discovers and registers them.

Example fixed action plus dynamic section:

```ts
menu: {
  title: "Workloads",
  items: [
    {
      title: "Functions",
      fixedActionScope: "inherit",
      items: [
        {
          title: "Add Function",
          path: "/workloads/new",
          fixed: true,
          fixedOrder: 1,
        },
      ],
      dynamicItems: {
        path: "/workloads/menu/functions",
        emptyTitle: "No functions yet",
      },
    },
  ],
}
```

Example clearing a parent action and reintroducing a different action deeper
down:

```ts
menu: {
  title: "Tools",
  items: [
    {
      title: "Create Tool",
      path: "/tools/new",
      fixed: true,
      fixedOrder: 1,
    },
    {
      title: "Advanced",
      fixedActionScope: "inherit",
      items: [
        {
          title: "Danger Zone",
          fixedActionScope: "clear",
          items: [
            {
              title: "Recovery",
              fixedActionScope: "replace",
              items: [
                {
                  title: "Create Recovery Point",
                  path: "/tools/recovery/new",
                  fixed: true,
                  fixedOrder: 1,
                },
              ],
            },
          ],
        },
      ],
    },
  ],
}
```

In that example, `Advanced` keeps `Create Tool`, `Danger Zone` shows no fixed
actions, and `Recovery` reintroduces `Create Recovery Point`.

The repo includes `examples/plugin-basic` as a minimal uploadable service. Build its upload package with `pnpm --filter @zelavis/example-plugin-basic package`, then select `examples/plugin-basic/dist/example-basic.zip` in a project Marketplace flow at `/zelavis/projects/:projectId/marketplace`. The service module defines its own `name`, `version`, menu, pages, and services, so the dashboard does not ask for a separate service name. The ZIP includes `zelavis.service.json`, whose `entry` field points at the ESM module the host adapter should import.

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
- [zelavis/core](../packages/zelavis/src/core.md)
