---
title: Service Model
---
Zelavis currently benefits from separating two layers that both use the word
service in code:

- **runtime service** for the internal endpoint-mounting unit
- **service** for the public extension concept developers and operators interact with

## Current recommendation

Use this language split consistently:

- **Runtime services** are the internal transport/runtime primitive.
- **Services** are the external product concept.

That means the dashboard, docs, and developer-facing product language can talk about services without forcing the runtime internals to stop using the service contract that already exists.

## Are services services under the hood?

Sometimes yes, but not always in the same way.

- Auth provider services extend the auth API surface through service registration.
- Ecommerce provider services extend the ecommerce API surface through service registration.
- Installable dashboard/runtime features may expose one or more runtime-mounted
  services as part of activation.

That lower-level provider layer uses named capabilities and explicit public registration contracts.

Current example:

- `zelavis-ecommerce` is a top-level project Marketplace/runtime service
- payment providers such as Stripe or PayPal are ordinary plugins declaring
  `@zelavis/ecommerce:payments`, the capability that plugin owns

So the safe model is:

> A service may register or compose one or more internal services, but the service itself is the user-facing extension unit.

## Why this split is good

- The runtime already has a clear internal service contract.
- Service is the public unit for installable capabilities, web apps, providers, and dashboard extensions.
- Operators think in terms of installing, enabling, and using services, not mounting service graphs.
- This avoids leaking internal transport language into the UX.

## Dashboard rule

The dashboard should reflect that split:

- Dashboard pages are clients of service capabilities and endpoints; they must not be the only implementation of a platform action.
- The global `Marketplace` is a top-level discovery area for Project recipes
  presented as apps and starters, plus templates and server provider plugins.
- The project `Marketplace` under `/zelavis/projects/:projectId/marketplace` is where Zelavis-native project plugins are installed.
- Installed services do not get first-slide root items.
- Each installed service gets exactly one root entry under `Extensions`.
- Each service may own unlimited nested sidebar slides inside its own Extensions area.
- Service-owned dashboard navigation should be declared through a plain menu object such as `menu: { ... }`, not by reaching into sidebar internals directly.
- A service menu item may declare `page: { id, title, file }` when that menu
  item owns iframe-backed dashboard content.
- `menu.path` is the dashboard URL. `menu.page.file` is the
  browser-extension-style HTML entry file for service-owned dashboard documents.
  Use `menu.path` without `menu.page` for core service screens already provided
  by `@zelavis/ui`.
- If a service page is implemented as a SPA, that SPA owns its internal
  navigation inside the iframe. Zelavis service menu metadata selects HTML entry
  files; it does not model private routes inside plugin-owned SPAs.
- A service menu item may declare `search` metadata for route state such as
  `{ databaseTable: "products" }`. Dynamic menu endpoints should return the
  same menu item shape when runtime-owned lists need active search state.
- A service menu item may declare `fixed: true` to render as a pinned action at
  the top of its current sidebar slide. Use `fixedOrder` to sort multiple fixed
  actions in the same slide. A nested slide may set `fixedActionScope` to
  control how parent fixed actions flow into that slide:
  - `local` shows only fixed actions declared by the opened slide. This is the
    default.
  - `inherit` combines the parent slide's visible fixed actions with fixed
    actions declared by the opened slide.
  - `replace` uses only the opened slide's fixed actions as an explicit
    boundary.
  - `clear` hides inherited and local fixed actions for the opened slide. A
    deeper slide can reintroduce actions with its own local or replacement
    actions.
  This makes it possible for a service to keep one action visible across a few
  nested slides, clear it at a boundary, and then introduce another fixed action
  deeper in the workflow.
- Core services may declare a service-only menu `surface` such as `platform`, `root`, `core`, `extensions`, or `settings`.
- `platform` is the global `/zelavis` management shell for owner/operator areas such as Access.
- Service menus must not declare a `surface`; Zelavis always mounts them under `Extensions`.

This keeps the first slide stable and prevents dashboard sprawl.

The same rule applies to service-owned pages: a page can render UI, but the action should live behind a service capability and endpoint so non-dashboard clients can call it too.

## Shared Access Model

Services and official modules must use the core Zelavis access model instead
of inventing package-local dashboard permissions.

The server contract supports one request principal plus route and menu access
requirements. A principal can represent an owner, operator, support user,
reseller, customer, service account, or system actor. Permissions can be
system-wide or scoped to projects and services.

That is the intended foundation for a future official Hosting Provider module:

- owners and superadmins get system-level grants
- operators get delegated support or operations grants
- resellers get grants scoped to projects and customers they own
- customers get grants scoped only to their own projects

The same `/zelavis` dashboard shell can therefore render different menus and
project lists for each principal, while every privileged action still goes
through endpoint-level authorization. A customer dashboard is not a separate
product surface with a separate auth model; it is an authorized view of the
same Zelavis control plane.

Managed app projects such as WordPress, static sites, or generic hosted apps do
not automatically expose Zelavis-native service navigation. Their dashboard
surface should look like hosting/project management unless the managed app is
explicitly backed by Zelavis services.

Service pages are served as full HTML documents and mounted by the dashboard inside the `zelavis-service-frame` iframe web component. That lets service authors use plain HTML, React, Vue, web components, or any other browser-side approach without coupling service settings or workspaces to the internal dashboard React tree. A service page declares `page.file`, and Zelavis serializes it to a dashboard-safe asset URL under `/zelavis/api/v1/runtime/service-page-assets/:service/:bundle/*`. Relative bundled assets such as scripts and stylesheets resolve beside the HTML file. Service-owned dashboard pages are browser-extension-style HTML entry files.

## TypeScript direction

A good current TypeScript direction is:

- use `package.json` as the service manifest and configuration surface (`"zelavis": { "kind": "plugin" }`, `"type": "module"`, `"exports"`)
- use the official Zelavis SDK (`import { zelavis } from "zelavis/sdk"`) for plugin code: `zelavis.menu.create(...)`, `zelavis.routes.create(...)`, `zelavis.commands.register(...)`, `zelavis.events.on(...)`
- use plain `ZelavisRuntimeService` object literals for the internal runtime contract
- let plugins carry declarative dashboard metadata through `zelavis.menu.create({ ... })` so plugins are not locked to one dashboard implementation detail
- let provider plugins expose the public contract associated with a declared capability

## Suggested plugin shape

Plugins are standard npm packages configured via `package.json`:

```json
{
  "name": "@zelavis/ecommerce",
  "version": "1.0.0",
  "type": "module",
  "exports": "./dist/index.js",
  "zelavis": {
    "kind": "plugin"
  }
}
```

Plugin code uses the official Zelavis SDK:

```ts
import { zelavis } from "zelavis/sdk";

zelavis.menu.create({
  title: "Ecommerce",
  path: "/commerce",
  page: {
    id: "dashboard",
    title: "Commerce",
    file: "dashboard.html",
  },
  items: [
    {
      title: "Orders",
      path: "/commerce/orders",
      page: {
        id: "orders",
        title: "Orders",
        file: "orders.html",
      },
    },
    {
      title: "More",
      items: [
        {
          title: "Customers",
          path: "/commerce/customers",
        },
      ],
    },
  ],
});

zelavis.routes.create({
  id: "commerce.products.list",
  method: "GET",
  path: "/products",
  handler: async () => ({ status: 200, body: [] }),
});
```

Provider plugins declare provider capabilities in their manifest and expose an explicit registration object:

```ts
import type { EcommerceApi } from "@zelavis/ecommerce";
import type { ZelavisRuntimeService } from "zelavis";

export const stripePlugin: ZelavisRuntimeService = {
  name: "@zelavis/ecommerce-stripe",
  kind: "plugin",
  capabilities: ["@zelavis/ecommerce:payments"],
  service: {
    name: "stripe",
    register(api: EcommerceApi) {
      api.payments.registerProvider("stripe", provider);
    },
  },
};
```

Installed provider plugins are discovered by capability. The domain validates the plugin's public registration contract; it does not receive hidden children or require a package-name allow-list change for each compatible provider.

Important point:

- the `menu` object is service-owned metadata registered via `zelavis.menu.create(...)`
- `menu.page` is the content contract for service-owned dashboard pages
- Zelavis decides how to render that metadata in the current dashboard shell
- if the dashboard changes later, the service contract can stay stable while Zelavis adapts the rendering layer

## App services and domains

Services can also ship full web apps. The app contract should stay small:

```ts
export default {
  name: "@acme/storefront",
  kind: "web-app",
  capabilities: ["web:app", "api:routes"],
  app: {
    mount: "/",
    mode: "spa",
    bundle: "dist",
    domainPolicy: "optional",
  },
};
```

The important design rule is that services do **not** declare concrete hostnames.
Concrete domains are runtime activation state:

- the operator or project adds a domain binding such as `shop.acme.com`
- Zelavis verifies ownership through manual, DNS-TXT, or HTTP-01 verification
- activation exposes the app on verified bindings owned by that project or service

`app.domainPolicy` controls what happens when no verified domain exists:

- `optional` is the default. Extension apps can be served on verified domains, but also fall back to `/apps/<service-name>` on the shared Zelavis host.
- `required` means the extension app is not synthesized until it has a verified domain binding. Use this for website/webapp services that should not appear on the shared host.

This keeps service packages portable. A marketplace app can say "I am an SPA that wants root when hosted" without baking in `acme.com`, `localhost`, staging hostnames, certificate choices, or future deployment-provider details.

System services may still mount at privileged paths because the operator shipped them with the runtime. The built-in `@zelavis/ui` dashboard is one of these: it is an app service mounted under the configured dashboard root, but it is not a general deployment system itself.

## Registry direction

Services should also be representable through one neutral registry shape:

```ts
createServiceRegistry([
  {
    service: ecommerceService,
    status: "installed",
    source: "official",
  },
]);
```

That gives Marketplace, installed service navigation, and future runtime activation a shared model instead of separate ad hoc lists.

## ESM loading direction

Zelavis should keep service loading 100% inside standard JavaScript and ESM:

- service modules should be loaded through dynamic `import()`
- service modules may export a service definition directly, as `service`, or as `default`
- loading and registry updates should stay runtime-neutral and avoid Node-only APIs

That means a future runtime can do things like:

```ts
const service = await loadService("@zelavis/ecommerce");
const registry = await loadServiceRegistry([
  { specifier: "@zelavis/ecommerce", status: "installed", source: "official" },
]);
```

Important boundary:

- **load/install** can be modeled with ESM imports and registry state
- **remove/uninstall** should mean removing the service from Zelavis registry/config state
- JavaScript does not offer a standard way to unload an already-imported ESM module from memory, so Zelavis should not pretend otherwise

## Install State And Activation

The runtime model should also stay explicit:

- service **catalog metadata** lives in Marketplace catalog entries
- service **runtime metadata** lives in service registry entries
- service **install state** lives in a registry store
- service **activation order** is an explicit `order` number
- service **setup** runs in registry order and can register additional services through the setup context
- service **activation** is adapter-owned: local runtime adapters can recompose the service graph when supported, or require a process restart when live activation is unavailable

That means install state and activation are related, but not the same thing:

- a service can exist in the catalog as `available`
- a service becomes active only when its registry state is `installed`
- setup should run only for installed services once the host has activated the service module

The current runtime direction now reflects that split with:

- `createServiceRegistry(...)`
- `defineServiceCatalogEntry(...)`
- `defineServiceCatalog(...)`
- `applyServiceRegistryState(...)`
- `activateServiceRegistry(...)`
- runtime service registry stores for memory, database, key/value, and file storage
- capability-discovered provider contracts for Auth, payments, and future extension points
- service setup context carrying only standard data such as root path, API paths, platform summary, and registry state
- a service activation controller with declared runtime capabilities:
  - `strategy`: `runtime-graph` or `external`
  - `supportsRuntimeInstall`
  - `supportsUploadedSpecifiers`
  - `supportsIsolatedExecution`

The dashboard exposes these capabilities so users can tell whether the active
runtime can truly apply uploaded or marketplace services at runtime. Core does
not assume a specific filesystem layout, process manager, or provider deploy
API.

For Node or Bun adapters, the likely production shape is a local service cache such as `.zelavis/services/<service>/<version>/index.js`, plus a registry entry that points to that ESM entry point. Zelavis can then dynamic-import the specifier and recompose the runtime graph without restarting the process.

Provider deployment is a separate concern. A future deployment plugin may publish
user websites or apps to an external provider, but that must not become a
Zelavis runtime activation path.

That platform summary should stay intentionally small:

- `presets`: runtime target names such as `node`, `bun`, or future `deno`
- `resources`: booleans for resource availability such as key/value or file storage
- `metadata`: plain serializable platform hints

That gives services useful context without leaking host-specific APIs into the service contract.

## Trust, capabilities, and stronger dashboard access

Some services need more power than normal Extensions services. The dashboard itself can render first-slide entries, settings surfaces, and core-owned pages. A random marketplace service should not be able to do that just by declaring a clever menu object.

The clean distinction is trust and capability, not "service vs. non-service":

- **system services** are bundled or statically registered by the operator. They may use privileged dashboard surfaces such as `platform`, `root`, `core`, or `settings`.
- **extension services** are uploaded, marketplace-installed, or tenant-managed. They are constrained to the Extensions surface and can own nested slides under their own entry.
- future hosts can make this more explicit with capability grants such as allowed menu surfaces, app hosting policy, isolated execution support, and runtime install strategy.

Bundling a service into `zelavis` is acceptable today as a trust signal for first-party/system code, but it should not become the only long-term authorization model. The issue to avoid is hidden privilege: if "more power" comes only from where the code was imported, the system grows special cases and users cannot reason about why one service can render into Settings while another cannot. The better future shape is that static registration sets or implies `scope: "system"` and, over time, explicit capability grants describe exactly what the service is allowed to do.

## Current design preference

For product language:

- prefer **Service** as the public extension unit

For runtime internals:

- use **runtime service** when explaining the lower-level endpoint contract

For possible alternatives:

- **Apps** feels more end-user/productized, but less precise for provider-style extensions
- **Extensions** is good, but broader and less precise than Service
- **Services** is the clearest choice for the current Zelavis direction

## Related docs

- [Official Service Packages](../guides/official-service-packages.md)
- [Service Authoring](../guides/service-authoring.md)
- [Website Core Service](./website-core-service.md)
- [Adapter Entry Points](../adapters/entry-points.md)
- [Marketplace](../adapters/index.md)
