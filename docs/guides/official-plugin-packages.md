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

## Child plugin extension points

An official plugin package may expose child plugin extension points.

`@zelavis/ecommerce` is the current example:

- top-level Zelavis plugin:
  - `zelavisEcommercePlugin`
- child payment provider plugins:
  - use the normal `definePlugin(...)` builder
  - declare `extends: { plugin: "zelavis-ecommerce", extensionPoint: "payments" }`

That child plugin metadata is for extending the ecommerce domain itself, such as payment providers. A child plugin can be installed through the same registry, but it activates through its parent plugin instead of appearing as an independent top-level workspace plugin.

Parent plugins declare the policy for each extension point:

- `open`
  - any installed child plugin can target the extension point
- `reviewed`
  - only child plugins listed by the parent are accepted
- `private`
  - default policy; also requires the parent to list accepted child plugins

`zelavis-ecommerce` currently marks `payments` as `reviewed` and allows the official Stripe and PayPal child plugins. That keeps the marketplace safe while we are still learning what third-party review should look like.

## Rule of thumb

- use `definePlugin(...)` for top-level Zelavis plugins
- use `definePlugin(...)` with `extends` for child plugins
- keep parent plugin extension points named clearly so contributors can tell where a child plugin belongs
- let parent plugins own child-plugin policy until the marketplace review model is mature
- keep official plugin source in this repo, and keep community plugin source in author-owned repositories
- describe community plugins through Marketplace catalog metadata instead of importing their source into the monorepo

See [Plugin Marketplace Catalog](../reference/plugin-marketplace-catalog.md) for the catalog metadata contract and hosting recommendation.
