# Official Plugin Packages

Official Zelavis plugin packages live under `packages/plugins/*`.

These packages are first-party marketplace/runtime plugins written by the Zelavis team. They use the top-level `definePlugin(...)` contract from `zelavis/plugin`.

## What makes them different

An official plugin package is a top-level Zelavis plugin:

- installable through the Zelavis plugin system
- visible in the dashboard/plugin registry
- able to mount runtime services and API routes
- packaged as a normal workspace package

Example:

- [packages/plugins/ecommerce](/Users/ivanjeremicx/Projects/zelavis/packages/plugins/ecommerce)

## Recommended structure

Use one obvious named file for the top-level plugin definition:

```text
packages/plugins/example/
  src/
    index.ts
    zelavis-example-plugin.ts
```

- `zelavis-example-plugin.ts`
  - contains the real `definePlugin(...)` call
- `index.ts`
  - re-exports the package surface

## Nested provider or child plugin systems

An official plugin package may still have its own lower-level extension system inside it.

`@zelavis/ecommerce` is the current example:

- top-level Zelavis plugin:
  - `zelavisEcommercePlugin`
- lower-level child/provider plugin contract:
  - `defineEcommercePlugin(...)`
  - child plugins explicitly target the `payments` extension point of `zelavis-ecommerce`

That lower-level contract is for extending the ecommerce domain itself, such as payment providers. It is not the same as a top-level marketplace plugin.

## Rule of thumb

- use `definePlugin(...)` for top-level Zelavis plugins
- use package-local plugin builders only when a domain package needs its own internal extension model
- keep the two layers named clearly so contributors can tell which plugin system they are looking at
