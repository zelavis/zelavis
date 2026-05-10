# Plugin and Service Model

Zelavis currently benefits from using two names for two different layers:

- `service` for the internal runtime-mounting unit
- `plugin` for the public extension concept developers and operators interact with

## Current recommendation

Use this language split consistently:

- **Services** are the internal transport/runtime primitive.
- **Plugins** are the external product concept.

That means the dashboard, docs, and developer-facing product language can talk about plugins without forcing the runtime internals to stop using the service contract that already exists.

## Are plugins services under the hood?

Sometimes yes, but not always in the same way.

- Auth provider plugins extend the auth API surface through plugin registration.
- Ecommerce provider plugins extend the ecommerce API surface through plugin registration.
- Installable dashboard/runtime features may eventually expose one runtime-mounted service as part of how the plugin is activated.

So the safe model is:

> A plugin may register or compose one or more internal services, but the plugin itself is the user-facing extension unit.

## Why this split is good

- The runtime already has a clear internal service contract.
- Plugin is the more intuitive outside-world term for installable capabilities.
- Operators think in terms of installing, enabling, and using plugins, not mounting service graphs.
- This avoids leaking internal transport language into the UX.

## Dashboard rule

The dashboard should reflect that split:

- `Marketplace` is a top-level discovery/install area.
- Installed plugins do not get first-slide root items.
- Each installed plugin gets exactly one root entry under `Workspace`.
- Each plugin may own unlimited nested sidebar slides inside its own workspace area.
- Plugin-owned dashboard navigation should be declared through a plain menu object such as `menu: { ... }`, not by reaching into sidebar internals directly.

This keeps the first slide stable and prevents dashboard sprawl.

## TypeScript direction

A good current TypeScript direction is:

- keep `defineServerService(...)` for the internal runtime contract
- expose one shared public plugin builder: `definePlugin(...)`
- version that contract explicitly with `ZELAVIS_PLUGIN_V1`
- let plugin definitions carry declarative dashboard metadata such as `menu: { ... }` so plugins are not locked to one dashboard implementation detail

That builder should be about developer ergonomics and metadata, not about replacing the internal service contract.

## Suggested plugin shape

The current DX direction should lean declarative:

```ts
import { definePlugin, ZELAVIS_PLUGIN_V1 } from "zelavis";

definePlugin({
  name: "zelavis-ecommerce",
  contractVersion: ZELAVIS_PLUGIN_V1,
  menu: {
    title: "Ecommerce",
    path: "/commerce",
    items: [
      {
        title: "Orders",
        path: "/commerce/orders",
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
  },
  setup(plugin) {
    // register services, routes, providers, and plugin capabilities
  },
});
```

Important point:

- the `menu` object is plugin-owned metadata
- Zelavis decides how to render that metadata in the current dashboard shell
- if the dashboard changes later, the plugin contract can stay stable while Zelavis adapts the rendering layer

## Registry direction

Plugins should also be representable through one neutral registry shape:

```ts
createPluginRegistry([
  {
    plugin: ecommercePlugin,
    status: "installed",
    source: "official",
  },
]);
```

That gives Marketplace, installed plugin navigation, and future runtime activation a shared model instead of separate ad hoc lists.

## ESM loading direction

Zelavis should keep plugin loading 100% inside standard JavaScript and ESM:

- plugin modules should be loaded through dynamic `import()`
- plugin modules may export a plugin definition directly, as `plugin`, or as `default`
- loading and registry updates should stay runtime-neutral and avoid Node-only APIs

That means a future runtime can do things like:

```ts
const plugin = await loadPlugin("zelavis-ecommerce");
const registry = await loadPluginRegistry([
  { specifier: "zelavis-ecommerce", status: "installed", source: "official" },
]);
```

Important boundary:

- **load/install** can be modeled with ESM imports and registry state
- **remove/uninstall** should mean removing the plugin from Zelavis registry/config state
- JavaScript does not offer a standard way to unload an already-imported ESM module from memory, so Zelavis should not pretend otherwise

## Install State And Activation

The runtime model should also stay explicit:

- plugin **catalog metadata** lives in plugin registry entries
- plugin **install state** lives in a registry store
- plugin **activation order** is an explicit `order` number
- plugin **setup** runs in registry order and can register additional services through the setup context

That means install state and activation are related, but not the same thing:

- a plugin can exist in the catalog as `available`
- a plugin becomes active only when its registry state is `installed`
- setup should run only for installed plugins

The current runtime direction now reflects that split with:

- `createPluginRegistry(...)`
- `applyPluginRegistryState(...)`
- `activatePluginRegistry(...)`
- runtime plugin registry stores for memory, database, key/value, and file storage
- plugin setup context carrying only standard data such as root path, API paths, platform summary, and collected services

That platform summary should stay intentionally small:

- `presets`: platform preset names such as `node` or `cloudflare`
- `resources`: booleans for resource availability such as key/value or file storage
- `metadata`: plain serializable platform hints

That gives plugins useful context without leaking host-specific APIs into the plugin contract.

## Current design preference

For product language:

- prefer **Plugin** over **Service**

For runtime internals:

- keep **Service**

For possible alternatives:

- **Apps** feels more end-user/productized, but less precise for provider-style extensions
- **Extensions** is good, but broader and slightly less concrete than Plugin
- **Plugins** is the clearest choice for the current Zelavis direction

## Related docs

- [Website Core Service](./website-core-service.md)
- [Adapter Entry Points](../adapters/entry-points.md)
- [Marketplace](../adapters/index.md)
