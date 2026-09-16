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
5. Calls such as `zelavis.plugins.ui.menus.create(...)` and
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
    "capabilities": [
      "dashboard:menu",
      "api:routes"
    ],
    "namespace": "examplePlugin"
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

An app recipe declares compatible runtime-driver families in its
`package.json` under `zelavis.project.runtimeKinds`. Static metadata is never
exported from its JavaScript module.

Its package manifest still uses modern ESM:

```json
{
  "name": "@acme/my-project-recipe",
  "version": "1.0.0",
  "type": "module",
  "exports": "./dist/index.js",
  "zelavis": {
    "kind": "app",
    "project": { "runtimeKinds": ["native"] },
    "capabilities": [
      "app:project"
    ],
    "namespace": "myProjectRecipe"
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

Executable packages must declare a stable `zelavis.namespace`, such as
`"namespace": "seotool"`. It is a JavaScript identifier beginning with a lowercase
letter, containing letters/digits, and excluding reserved protocol names such
as `then` and `constructor`. The loader validates it before evaluating the
module. Namespaces must be unique in each installation or Project runtime.
An exported service cannot override the manifest namespace.

Plugin HTTP endpoints mount at `/zelavis/api/v1/plugins/<namespace>`; an
exported `basePath` does not select a second public API location. The configured
runtime root, API prefix and version replace those defaults. Frontend page
routes keep their own paths.

### One operation across HTTP, JavaScript and CLI

Use the SDK's operation declaration for new plugin endpoints:

```ts
import { zelavis } from "zelavis/sdk";

zelavis.operations.create({
  id: "seotool.audits.create",
  resource: "audits",
  action: "create",
  method: "POST",
  path: "/audits",
  access: { permissions: ["seotool.audits.create"], scope: { type: "system" } },
  spec: {
    operationId: "createSeoAudit",
    summary: "Create an SEO audit",
    requestBody: {
      required: true,
      schema: {
        type: "object",
        required: ["url"],
        properties: { url: { type: "string" } },
      },
    },
  },
  handler: async ({ body }) => auditService.create(body),
});
```

Here `auditService` is the plugin's implementation; it owns input validation,
business behavior and the HTTP response. The operation spec documents the
contract; it does not replace validation in that implementation. Every adapter
invokes the same handler through HTTP, including its access checks.

With manifest namespace `seotool`, the operation is available as:

- HTTP: `POST /zelavis/api/v1/plugins/seotool/audits` with a JSON body.
- JS: `client.plugins.seotool.audits.create({ url: "https://example.com" })`.
- CLI: `zelavis plugins seotool audits create --file audit.json --json`.

Create a connected JS client with
`zelavis.createClient({ baseUrl: "http://localhost:3000", headers: ... })`.
Its `plugins` tree discovers mounted operations from runtime configuration.
`client.pluginOperations()` lists their resource/action identities, methods,
paths and specs. Plugin packages can publish typed client declarations through
the exported `PluginApiRegistry` interface; otherwise discovered operations
accept unknown inputs and return unknown results.

`zelavis plugins seotool --help --url http://localhost:3000/zelavis` discovers
the same operations and their specs. Commands accept `--param name=value` for
path parameters, `--query name=value` for query parameters, `--file` for a JSON
body, and `--token` for bearer authentication. Output is JSON; the CLI entrypoint
reports HTTP failures with a status and domain error body and exits nonzero.
Use `--api-prefix` and `--api-version` for non-default API configurations.

For JS operations with path or query parameters, pass
`{ params: { id: "..." }, query: { limit: "10" } }` as the second argument.
GET and DELETE operations take no body; pass `undefined` as the first argument
when supplying these options.

This is the namespace and operation-dispatch foundation. Existing endpoints
declared only through `routes.create` still need operation metadata to appear
in JS/CLI discovery. `zelavis.plugins.ui.menus.create` currently registers
package-owned menus during loading; HTTP/CLI runtime menu mutation is not yet
implemented. It must preserve the same ownership, persistence and cleanup
contract before it ships.

Zelavis validates `package.json`, resolves the primary `exports` entry, creates
a plugin execution context, and imports the ESM entry inside that context. SDK
registration calls are therefore normally made at module scope:

```ts
import { zelavis } from "zelavis/sdk";

zelavis.plugins.ui.menus.create({
  title: "Example",
  path: "/example",
});
```

Export `register(configuration)` to run declarations for every package load,
including when its ESM module is cached:

```ts
import { zelavis } from "zelavis/sdk";

export function register() {
  zelavis.plugins.ui.menus.create({ title: "Example", path: "/example" });
}
```

Calling registration APIs outside an active plugin execution context throws.
Other exported helper functions run only when explicitly called. Ordinary
exported domain values may still be consumed by a plugin's public contract;
package identity and API declarations come from the manifest and SDK.

File-only frontends load directly from their manifest. A static frontend with an ESM
`exports` entry also declares its namespace and runs through the SDK loader.
Server frontend code runs in its Project process; its npm exports are never
evaluated as control-plane plugin code.
Package evaluation is serialized so concurrently requested loads cannot mix
registrations. Registration hooks declare their own package; compose other
packages at the host rather than recursively loading them inside `register`.

## SDK overview

```ts
import { zelavis } from "zelavis/sdk";
```

### Package registration and frontend behavior

Export a `register(configuration)` function for declarations that must run on
every load. `loadPluginPackage` invokes it inside a fresh SDK context even when
ESM has already cached the module. Host configuration is passed explicitly;
`register` should register behavior, while `zelavis.setup` handles work that
requires the running runtime.

```ts
import { zelavis } from "zelavis/sdk";

export function register() {
  zelavis.createAPI({ health: { list() { return { ready: true }; } } });
}
```

The manifest owns name, version, kind, namespace, capabilities, Project recipe
metadata and Marketplace metadata. Exported package metadata and raw `api`
objects are rejected. The host supplies `packageDir` and trusted `scope` through
loading options; a package cannot grant itself system authority.

A static frontend declares its bundle, mode and base-path convention in
`zelavis.frontend` in `package.json`. It attaches runtime behavior through
`zelavis.frontend.configure({ shell: { render }, devUrl, devUrlExcludePaths })`.
That helper only accepts runtime behavior, rejects metadata overrides, and
requires a static frontend manifest. `@zelavis/ui` follows this same path: it
uses `createAPI(..., { routes: false })` for its in-process shell API and the
frontend SDK to attach it. The host mounts the resulting HTML surface;
HTTP plugin operations still live under `/api/v1/plugins/ui/...`.

These are package-authoring declarations, supplied remotely through a package
artifact rather than serialized executable closures. Runtime calls still use
the discovered SDK, HTTP and CLI operations described below.

### Declare an API with `createAPI`

During package evaluation, `createAPI` uses the manifest's `zelavis.namespace`
and registers resource methods as discoverable HTTP operations:

```ts
import { zelavis } from "zelavis/sdk";

export const inventory = zelavis.createAPI({
  items: {
    async list(input: { category?: string }) {
      return [{ id: "book", category: input.category }];
    },
    async get(input: { id: string }) {
      return { id: input.id, status: "available" };
    },
  },
}, {
  access: { permissions: ["inventory.read"], scope: { type: "system" } },
});
```

With `"namespace": "inventory"`, these methods are available through all three
client surfaces. Configure credentials with the required permission:

```ts
const client = zelavis.createClient({ baseUrl: "http://localhost:3000" });
await client.plugins.inventory.items.list(undefined, { query: { category: "books" } });
await client.plugins.inventory.items.get(undefined, { params: { id: "book" } });
```

```http
GET /zelavis/api/v1/plugins/inventory/items?category=books
GET /zelavis/api/v1/plugins/inventory/items/book
```

```sh
zelavis plugins inventory items list --query category=books --json
zelavis plugins inventory items get --param id=book --json
zelavis plugins inventory --help
```

The configured runtime root, API prefix/version, and Project Gateway apply in
exactly the same way as explicit `operations.create` declarations.

| Method name | HTTP method | Resource path |
| --- | --- | --- |
| `list`, `find` | GET | `/items` |
| `get`, `read` | GET | `/items/:id` |
| `create`, `add` | POST | `/items` |
| `update`, `put` | PUT | `/items/:id` |
| `delete`, `remove` | DELETE | `/items/:id` |
| Other resource actions | POST | `/items/<action>` |

Choose one name per HTTP route: declaring both `list` and `find` is rejected.
Names use the same validated identifier rules as plugin namespaces. Registration
is atomic: invalid names, duplicate methods, or route collisions publish nothing
from that call. Further calls may add new resources or methods, but cannot replace
an existing method.

Handlers receive `(input, routeContext)`. GET and DELETE input contains query
values and path parameters; other methods receive the parsed request body, with
any path `id` applied last. The path ID takes precedence over query/body IDs.
Return values are JSON data with status 200, including objects containing fields
named `status`, `body`, or `headers`. Use `zelavis.operations.create` for custom
status codes, schemas, paths, or per-operation access rules. `createAPI` applies
its `access` option to every generated route and otherwise uses normal runtime
access defaults. It does not infer validation schemas from TypeScript.

Both synchronous and asynchronous resource methods generate routes; this also
supports ordinary functions that return promises. Pass `{ routes: false }` for
in-process authoring helpers. `plugins.ui.menus.create` uses the shared registry
mechanism to collect menu wire data and never creates an HTTP route. Headless
Project runtimes need no dashboard import for this declaration.

`createAPI("tools", { hello() { return "world"; } })` outside package evaluation
creates a local in-process API only. Top-level functions are local helpers;
HTTP operations use the two-level resource/action shape above. Inside package
evaluation, an explicit namespace must match the manifest. Authoring registries
are isolated per loading context and are not a global directory of installed
runtime handlers. Keep the returned typed API for local calls; use
`createClient().plugins` for installed operations, including cross-plugin calls.
Unavailable or uninstalled services expose no discoverable operations.

The return value preserves the definition's TypeScript type. To type dynamic
lookups, augment `PluginAuthoringApiRegistry` for authoring and
`PluginApiRegistry` for remote clients in `declare module "zelavis/sdk"`:

```ts
declare module "zelavis/sdk" {
  interface PluginAuthoringApiRegistry {
    inventory: typeof inventory;
  }
}
```

The current `zelavis` SDK object exposes:

```ts
interface ZelavisSdk {
  createAPI(api, options?): Record<string, any>;
  createAPI(namespace, api, options?): Record<string, any>;
  plugins: { ui: { menus: {
    create(menu): MenuDefinition;
  } } } & Record<string, any>;
  operations: {
    create(operation): void;
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

## Menus with `zelavis.plugins.ui.menus.create()`

Register plugin and service package menus only through `zelavis.plugins.ui.menus.create()`
from `zelavis/sdk`. Exported `menu` or `menus` fields are rejected by the package
loader. The runtime's `menus` field contains the complete list of SDK
registrations; its singular `menu` field is the first entry for catalogue
display, not an additional registration.

The smallest menu contribution is:

```ts
zelavis.plugins.ui.menus.create({
  title: "Example",
  path: "/example",
});
```

A plugin-owned settings page can be shipped as an HTML entry document:

```ts
zelavis.plugins.ui.menus.create({
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
zelavis.plugins.ui.menus.create({
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

This contributes an ordinary runtime service. Do not model adapters using
parent-maintained child-name allow-lists, `childServices`, or service
inheritance. A provider is discovered through a declared capability and the
owning plugin's public registration contract.

`zelavis.services.add()` runs during package registration. Runtime-dependent
work is registered with `zelavis.setup` instead:

```ts
export function register() {
  zelavis.setup(context => {
    context.addService(buildService(context.core.database));
  });
}
```

The callback receives the runtime's scoped setup context once that runtime is
available. Register it once per package load. Service objects created inside
runtime setup are runtime components; they do not replace the owning package's
manifest or its SDK API declarations.

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
  "files": [
    "dist"
  ],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "zelavis": {
    "kind": "plugin",
    "capabilities": [
      "dashboard:menu",
      "api:routes"
    ],
    "namespace": "examplePlugin"
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

zelavis.plugins.ui.menus.create({
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
- `packages/zelavis/services/zelavis-auth/src/index.ts` — a smaller
  first-party plugin: one menu, one page, no routes of its own.

When this guide and the repository disagree, the repository wins.
