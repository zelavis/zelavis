---
title: Plugin API
---

This guide describes the Zelavis package and plugin API as the repository
implements it. It is written for someone authoring a package, and for a coding
agent that would otherwise invent private integration paths or reach for a
retired service kind.

## The architectural model

A Zelavis extension is a normal npm package:

1. `package.json` declares the package identity and its Zelavis classification
   under the `zelavis` namespace.
2. Packages containing executable service code use modern ESM (`"type":
   "module"` plus `"exports"`).
3. Plugin code imports the public SDK from `zelavis/sdk`.
4. During package loading, Zelavis establishes an execution context and
   evaluates the package entry module.
5. Calls such as `zelavis.menu.create(...)` and
   `zelavis.routes.create(...)` contribute behavior to that active package.
6. Zelavis turns the manifest, exported values, and SDK contributions into one
   runtime service.

There is no required `definePlugin()` wrapper, base class, sidecar manifest, or
private dashboard registration API. The canonical metadata lives in
`package.json`; the canonical authoring API is `zelavis/sdk`.

> Naming note: the public import is currently `zelavis/sdk`. There is no
> `zelavis/plugin` package export. “Plugin API” refers to the plugin-facing API
> exposed by the `zelavis` SDK object.

## Complete `zelavis.kind` reference

Exactly three values are valid:

```ts
type ZelavisServiceKind = "app" | "frontend" | "plugin";
```

Unknown values are rejected during manifest validation. In particular, do not
use retired or unsupported kinds such as `core`, `provider`, `template`,
`website`, `web-app`, or `dashboard-extension`.

### `kind: "plugin"`

Use `plugin` for code that extends the Platform or a Project runtime. Examples
include dashboard extensions, authentication methods, payment providers,
database-related services, routes, commands, and other optional capabilities.

“Provider” is not a kind. A provider is an ordinary plugin discovered by a
capability such as `zelavis/auth:oauth` or
`@zelavis/ecommerce:payments`.

Minimal manifest:

```json
{
  "name": "@acme/example-plugin",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "zelavis": {
    "kind": "plugin",
    "capabilities": ["dashboard:menu", "api:routes"]
  },
  "peerDependencies": {
    "zelavis": ">=1.0.1-alpha.2"
  }
}
```

### `kind: "app"`

Use `app` for a **Project recipe**: a versioned create-project definition and
runtime entrypoint. It is something from which Zelavis can create a Project.
It does not mean “a package that happens to serve a web application.”

An app recipe can declare compatible runtime-driver families through its
exported service definition:

```ts
export default {
  name: "@acme/my-project-recipe",
  kind: "app",
  capabilities: ["app:project"],
  project: {
    runtimeKinds: ["native"],
  },
  service: {},
  api: {},
};
```

Its package manifest still uses modern ESM:

```json
{
  "name": "@acme/my-project-recipe",
  "version": "1.0.0",
  "type": "module",
  "exports": "./dist/index.js",
  "zelavis": {
    "kind": "app",
    "capabilities": ["app:project"]
  }
}
```

Every created Project locks the exact recipe/runtime version. A parent
Platform update must not silently rewrite that lock.

### `kind: "frontend"`

Use `frontend` for the public-facing frontend of an installation or Project.
A frontend is described in `package.json` and is loaded from its manifest
without executing JavaScript. It has two explicit runtime modes.

#### Static frontend

```json
{
  "name": "@acme/storefront",
  "version": "1.0.0",
  "zelavis": {
    "kind": "frontend",
    "frontend": {
      "runtime": "static",
      "bundle": "dist",
      "mode": "spa",
      "indexHtml": "index.html",
      "assetBase": "/assets/",
      "basePathGlobal": "__ZELAVIS_BASE_PATH__"
    }
  }
}
```

Static frontend fields:

- `runtime`: required and must be `"static"`.
- `bundle`: required package-relative directory containing the built files.
- `mode`: optional `"spa"` or `"mpa"`; defaults to SPA behavior.
- `indexHtml`: optional entry file; defaults to `index.html`.
- `assetBase`: optional absolute directory prefix such as `/assets/` that
  Zelavis can rewrite when mounting the bundle elsewhere. It must start and end
  with `/` and must be more specific than `/`.
- `basePathGlobal`: optional valid JavaScript identifier. Zelavis defines this
  global in the page with the actual mount path for a client-side router.

The bundle and entry paths must remain inside the package.

#### Server frontend

```json
{
  "name": "@acme/server-storefront",
  "version": "1.0.0",
  "zelavis": {
    "kind": "frontend",
    "frontend": {
      "runtime": "server",
      "start": ["node", "server.js"],
      "portEnv": "PORT"
    }
  }
}
```

Server frontend fields:

- `runtime`: required and must be `"server"`.
- `start`: required non-empty argv array. It is deliberately not a shell
  string.
- `portEnv`: optional environment-variable name through which Zelavis supplies
  the listening port; defaults to `PORT`.

A frontend may contain only files, so `frontend` is the one kind exempt from
the general requirement for `"type": "module"` and `"exports"`. A frontend
listed in the Marketplace has additional integration requirements, including
the `frontends` category and a dependency or peer dependency on `zelavis`.

## Manifest rules

For `plugin` and `app`, Zelavis currently validates these rules:

- `name` must be a non-empty string.
- `zelavis.kind` is required and must be `plugin`, `app`, or `frontend`.
- `type` must be `module` for executable `plugin` and `app` packages.
- `exports` is required for executable `plugin` and `app` packages.
- Legacy `main` is rejected; use `exports`.
- `zelavis.capabilities`, when present, must be an array of valid capability
  strings.
- A capability uses a namespace/name shape. Prefer ownership-qualified names
  such as `@acme/example-plugin:reports` for plugin-defined extension points.

Common built-in capability names include:

- `api:routes`
- `dashboard:menu`
- `dashboard:settings`
- `web:app`
- `web:site`
- `zelavis/auth:credentials`
- `zelavis/auth:oauth`

The capability type is extensible, so a plugin may define a namespaced
capability. Capabilities express what a service supplies or which owning
service it extends; they do not create new service kinds.

The manifest also accepts Marketplace metadata beneath `zelavis.marketplace`.
Typical descriptive fields include `title`, `summary`, `description`,
`categories`, and `tags`.

## Loading and execution semantics

Zelavis validates `package.json`, resolves the primary `exports` entry, creates
a plugin execution context, and imports the ESM entry inside that context. SDK
registration calls are therefore normally made at module scope:

```ts
import { zelavis } from "zelavis/sdk";

zelavis.menu.create({
  title: "Example",
  path: "/example",
});
```

Wrapping registration in a function is valid only if the function runs while
the package entry is being evaluated:

```ts
import { zelavis } from "zelavis/sdk";

function registerPlugin() {
  zelavis.menu.create({ title: "Example", path: "/example" });
}

registerPlugin();
```

Calling a registration API outside an active plugin execution context throws.
Exporting an uncalled registration function contributes nothing.

The package can also export ordinary domain values or a service definition.
The loader merges exported service fields with SDK contributions. SDK menus,
routes, commands, events, and nested services are attributed to the package
whose module is currently loading.

## SDK overview

```ts
import { zelavis } from "zelavis/sdk";
```

The current `zelavis` SDK object exposes:

```ts
interface ZelavisSdk {
  menu: {
    create(menu): MenuDefinition;
  };
  routes: {
    create(routeOrRoutes): readonly Route[];
  };
  commands: {
    register(command): CommandDefinition;
  };
  events: {
    on(event, handler): () => void;
  };
  services: {
    add(service): void;
  };
  context(): PluginExecutionContext | undefined;
  createClient(options): ZelavisClient;
}
```

The default export is also the same SDK object, but the named import is clearer:

```ts
import { zelavis } from "zelavis/sdk";
```

## Menus with `zelavis.menu.create()`

The smallest menu contribution is:

```ts
zelavis.menu.create({
  title: "Example",
  path: "/example",
});
```

A plugin-owned settings page can be shipped as an HTML entry document:

```ts
zelavis.menu.create({
  title: "Example Plugin",
  path: "/example",
  pageLabel: "Example",
  page: {
    id: "dashboard",
    title: "Example Plugin",
    file: "dashboard.html",
  },
  items: [
    {
      title: "Settings",
      path: "/example/settings",
      page: {
        id: "settings",
        title: "Example Plugin Settings",
        file: "settings.html",
      },
    },
  ],
});
```

Menu fields currently include:

- `title`: required visible title.
- `path`: dashboard-owned URL. It changes router, sidebar, active-menu, reload,
  and share state.
- `pageLabel`: optional label for the content page.
- `panelLabel`: optional nested sidebar-panel label.
- `search`: optional query-state map associated with the item.
- `order`: optional non-negative integer; lower sibling values sort first.
- `fixed`: optional boolean placing the item in the fixed-action area.
- `fixedOrder`: optional non-negative integer controlling fixed-action order.
- `fixedActionScope`: optional `local`, `inherit`, `replace`, or `clear`.
- `sectionLabel`: optional section heading.
- `disabled`: optional boolean.
- `access`: optional access requirement or array of requirements.
- `surface`: optional dashboard surface: `platform`, `root`, `core`,
  `extensions`, or `settings`.
- `dynamicItems`: optional endpoint-backed dynamic child section.
- `items`: optional nested menu items using the same menu shape.
- `page`: optional plugin-owned page entry.

### Menu page fields

```ts
page: {
  id: "settings",          // required stable page ID
  title: "Settings",      // optional title
  file: "settings.html",  // required package/bundle-relative HTML entry
  bundle: "dist",         // optional bundle name/path; defaults to "dist"
}
```

`menu.path` and `menu.page.file` are deliberately different:

- `menu.path` is a URL owned by the Zelavis dashboard router.
- `menu.page.file` is an HTML entry inside the service bundle.

Zelavis serves the HTML through its generated service-page asset endpoint and
renders it through the service-frame iframe boundary. It never exposes a raw
filesystem path. Relative page assets such as `./settings.js` and
`./settings.css` can sit beside the HTML file.

If the page boots a SPA, the plugin owns that SPA's internal routing. Zelavis
menu metadata selects the HTML entry; it does not deep-link into the private
routes of the embedded SPA.

### Dashboard surfaces and trust

The surface names are:

- `platform`: global owner/operator `/zelavis` shell.
- `root`: first slide of a project dashboard.
- `core`: project Backend slide.
- `extensions`: project Extensions slide.
- `settings`: project Settings slide.

These names do not grant authority. Runtime-installed services are forced to
extension scope, and an installed extension cannot promote itself by declaring
`scope: "system"` or a privileged menu surface. Privileged surfaces are for
bundled or statically trusted system services. A normal plugin should expose
its settings as a page within its own Extensions menu.

### Dynamic menu items

Use dynamic items for service-owned runtime lists rather than hardcoding them
in dashboard code:

```ts
zelavis.menu.create({
  title: "Reports",
  path: "/reports",
  dynamicItems: {
    path: "/reports/menu",
    emptyTitle: "No reports yet",
    emptyPath: "/reports",
    emptySearch: { view: "empty" },
  },
});
```

The service-owned endpoint returns the same menu-item schema:

```json
{
  "items": [
    {
      "title": "Monthly report",
      "path": "/reports/monthly",
      "search": { "report": "monthly" }
    }
  ]
}
```

Dynamic sections should remain route-backed when empty. Use `emptyPath` and
`emptySearch` to choose the empty-state destination.

## Routes with `zelavis.routes.create()`

Register one route or an array of routes:

```ts
zelavis.routes.create({
  id: "example.settings.read",
  method: "GET",
  path: "/settings",
  access: {
    authenticated: true,
    permissions: ["example.settings.read"],
    scope: { type: "project", projectIdParam: "projectId" },
  },
  spec: {
    operationId: "getExampleSettings",
    summary: "Read example-plugin settings",
    tags: ["example"],
    responses: {
      200: {
        description: "Current settings",
        schema: {
          type: "object",
          additionalProperties: true
        }
      }
    }
  },
  handler: async ({ principal, query }) => ({
    status: 200,
    body: {
      principalId: principal?.id,
      tab: query.get("tab")
    }
  }),
});
```

Route fields:

- `id`: required stable route ID.
- `method`: `GET`, `POST`, `PUT`, `PATCH`, or `DELETE`.
- `path`: service-relative route path.
- `host`: optional exact hostname, array of hostnames, or `"*"`.
- `access`: optional access requirement or array of requirements.
- `meta`: optional runtime metadata.
- `spec`: optional OpenAPI/SDK-generation metadata. Routes without `spec` are
  omitted from generated OpenAPI output.
- `handler`: sync or async handler returning `{ status?, body?, headers? }`.

The handler context currently includes:

- `service`
- `params`
- `query` as `URLSearchParams`
- parsed `body`
- normalized `headers`
- native `requestHeaders`
- native `request`
- resolved `principal`, when present
- `platform`, when supplied by the host

An access requirement can declare:

- `authenticated`
- `roles`
- `permissions`
- `scope`, using a `system`, `project`, or `service` scope

Define privileged behavior as a domain capability and an endpoint. A dashboard
page should call that endpoint; React state or an iframe callback must not
become the authority layer.

`spec` can describe:

- `operationId`
- `summary`
- `description`
- `tags`
- `pathParams`
- `queryParams`
- `requestBody`
- `responses` keyed by HTTP status code

Parameter types are `string`, `number`, `integer`, or `boolean`, with optional
`required`, `description`, and string `enum` fields. Request and response bodies
use JSON Schema-compatible records.

## Commands with `zelavis.commands.register()`

```ts
zelavis.commands.register({
  name: "example.rebuild-index",
  description: "Rebuild the example search index",
  async handler(projectId) {
    return { rebuilt: true, projectId };
  },
});
```

A command has:

- `name`: required stable name.
- `description`: optional description.
- `handler`: sync or async function receiving arbitrary arguments.

The registration call returns the command definition.

## Events with `zelavis.events.on()`

```ts
const unsubscribe = zelavis.events.on(
  "example.updated",
  async (...args) => {
    // React to the event.
  },
);
```

`events.on()` records an event name and sync/async handler and returns an
unsubscribe function. The exact meaningful event names are defined by the
owning subsystem or plugin contract; do not invent a global event vocabulary.

## Nested services with `zelavis.services.add()`

```ts
zelavis.services.add({
  name: "@acme/example-worker",
  kind: "plugin",
  capabilities: ["@acme/example-plugin:worker"],
  service: {},
  api: {},
});
```

This contributes an ordinary runtime service. Do not model integrations using
parent-maintained child-name allow-lists, `childServices`, or service
inheritance. A provider is discovered through a declared capability and the
owning plugin's public registration contract.

`zelavis.services.add()` runs during module evaluation, so it can only declare
a service that needs nothing from the runtime. A service built from the
registry, a database, or platform resources is added from `setup(context)`
instead:

```ts
export default {
  name: "@acme/example-plugin",
  setup(context) {
    context.addService({
      name: "example-api",
      basePath: "/example",
      service: buildService(context.core.database),
      api: { v1: routes },
    });
  },
};
```

Both are official. Which one applies is decided by whether the service can be
described before the runtime exists, not by preference.

## Reading the active context

```ts
const context = zelavis.context();

if (context) {
  console.log(context.name, context.version, context.kind);
}
```

`context()` returns the active `PluginExecutionContext` or `undefined`. The
context contains package identity and the contributions being collected. It is
primarily useful during registration; code should not treat the temporary
loader context as durable runtime state.

## Calling Zelavis with `zelavis.createClient()`

The same SDK can create a fetch-based client:

```ts
const client = zelavis.createClient({
  baseUrl: "http://127.0.0.1:3000",
  rootPath: "/zelavis",
  headers: async () => ({
    authorization: `Bearer ${await getToken()}`,
  }),
});

const config = await client.runtime.config();
const settings = await client.runtime.settings();

const response = await client.request("/example/settings", {
  method: "PATCH",
  body: { enabled: true },
});

const json = await client.json("/example/settings");
```

Client options:

- `baseUrl`: required string or `URL`.
- `rootPath`: optional Zelavis root path; defaults to `/zelavis`.
- `fetch`: optional fetch implementation.
- `headers`: optional static headers or async header-producing function.

The generic `request()` and `json()` methods resolve paths beneath the
versioned API namespace. Their options are based on `RequestInit`, with `body`
also accepting a plain object that the client JSON-encodes.

The current typed runtime client helpers are:

- `client.runtime.config()`
- `client.runtime.settings()`
- `client.runtime.updateSettings(update)`

## Complete small plugin example

Suggested package layout:

```text
example-plugin/
├── package.json
├── tsconfig.json
└── dist/
    ├── index.js
    ├── index.d.ts
    ├── dashboard.html
    ├── settings.html
    └── settings.js
```

`package.json`:

```json
{
  "name": "@acme/example-plugin",
  "version": "1.0.0",
  "type": "module",
  "files": ["dist"],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "zelavis": {
    "kind": "plugin",
    "capabilities": ["dashboard:menu", "api:routes"]
  },
  "peerDependencies": {
    "zelavis": ">=1.0.1-alpha.2"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "zelavis": "workspace:*"
  }
}
```

`src/index.ts` before compilation:

```ts
import { zelavis } from "zelavis/sdk";

zelavis.menu.create({
  title: "Example Plugin",
  path: "/example",
  page: {
    id: "dashboard",
    file: "dashboard.html",
  },
  items: [
    {
      title: "Settings",
      path: "/example/settings",
      page: {
        id: "settings",
        file: "settings.html",
      },
    },
  ],
});

zelavis.routes.create([
  {
    id: "example.settings.read",
    method: "GET",
    path: "/settings",
    access: {
      authenticated: true,
      permissions: ["example.settings.read"],
    },
    spec: {
      operationId: "getExampleSettings",
      summary: "Get settings",
      tags: ["example"],
      responses: {
        200: {
          description: "Current settings",
          schema: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
            },
            required: ["enabled"],
          },
        },
      },
    },
    handler: async () => ({
      status: 200,
      body: { enabled: true },
    }),
  },
  {
    id: "example.settings.update",
    method: "PATCH",
    path: "/settings",
    access: {
      authenticated: true,
      permissions: ["example.settings.manage"],
    },
    handler: async ({ body }) => ({
      status: 200,
      body,
    }),
  },
]);

export const examplePluginVersion = "1.0.0";
```

`dist/settings.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width" />
    <title>Example Plugin Settings</title>
  </head>
  <body>
    <main>
      <h1>Settings</h1>
      <label>
        <input id="enabled" type="checkbox" />
        Enable the plugin
      </label>
      <button id="save" type="button">Save</button>
    </main>
    <script type="module" src="./settings.js"></script>
  </body>
</html>
```

The HTML page is only the rendering surface. `settings.js` should call the
versioned plugin endpoints. The server route remains the authority for reading,
validating, authorizing, and saving settings.

## Rules an implementation agent should preserve

- Import the authoring SDK from `zelavis/sdk`.
- Keep the package a standard ESM npm package.
- Put service classification and capabilities in the `package.json` `zelavis`
  namespace.
- Use only `plugin`, `app`, or `frontend` as `kind`.
- Treat `app` as a Project recipe, not a generic web UI.
- Treat providers as capability-discovered plugins, not a separate kind.
- Do not add arbitrary top-level keys to the `zelavis` namespace as an
  extension mechanism.
- Register SDK contributions during module evaluation inside the loader
  context.
- Put privileged behavior behind a stable domain capability and versioned
  endpoint.
- Treat the dashboard and service pages as clients of those endpoints.
- Keep installed plugins on the Extensions surface; manifest metadata cannot
  self-grant system trust.
- Use `menu.path` for dashboard routing and `menu.page.file` for an HTML entry
  inside the service bundle.
- Keep bundle-relative page paths contained; never point a menu directly at a
  filesystem path.
- Define plugin-to-plugin integration with owned, namespaced capabilities and
  explicit public registration contracts.
- Do not reintroduce sidecar manifests, `defineService`, `childServices`,
  inheritance, or parent-maintained plugin name allow-lists.

## Current source-of-truth locations

When this document and the repository disagree, follow the repository:

- `packages/zelavis/src/sdk/fetch.ts` — public SDK object and fetch client.
- `packages/zelavis/src/core/service/manifest.ts` — npm manifest validation.
- `packages/zelavis/src/core/service/definition.ts` — kinds, capabilities,
  menu page types, and service contracts.
- `packages/zelavis/src/core/runtime/contracts.ts` — routes, access, menus, and
  handler types.
- `packages/zelavis/src/core/service/context.ts` — plugin execution context.
- `packages/zelavis/src/core/service/frontend.ts` — static/server frontend
  manifest rules.
- `packages/zelavis/src/service.ts` — package loading and contribution merge.
- `packages/zelavis/README.md` — public package authoring documentation.
- `plugins/ecommerce/src/ecommerce-plugin.ts` — first-party SDK usage,
  including a service added from `setup` rather than at module scope.
- `packages/zelavis/product-services/zelavis-auth/src/index.ts` — a smaller
  first-party plugin: one menu, one page, no routes of its own.

When this guide and the repository disagree, the repository wins.
