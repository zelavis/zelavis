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

A good long-term TypeScript direction is:

- keep `defineServerService(...)` for the internal runtime contract
- keep package-specific plugin helpers where needed today
- introduce a unified higher-level `createPlugin(...)` or `definePlugin(...)` only when Zelavis has one shared cross-package plugin contract to normalize against
- let that higher-level helper accept declarative dashboard metadata such as `menu: { ... }` so plugins are not locked to one dashboard implementation detail

That future helper should be about developer ergonomics and metadata, not about replacing the internal service contract.

## Suggested plugin shape

The current DX direction should lean declarative:

```ts
createPlugin({
  name: "zelavis-ecommerce",
  menu: {
    title: "Ecommerce",
    url: "/commerce",
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
