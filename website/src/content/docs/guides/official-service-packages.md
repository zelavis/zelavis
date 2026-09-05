---
title: Official Service Packages
---
Official Zelavis service packages live under `plugins/*`.

These packages are first-party marketplace/runtime services written by the Zelavis team. They are configured via modern `package.json` manifests (`"type": "module"`, `"exports"`, and `"zelavis": { "kind": "plugin" }`) and use the official Zelavis SDK or export `ZelavisRuntimeService` instances.

## What makes them different

An official service package is a top-level Zelavis plugin:

- installable through the Zelavis service system
- visible in the dashboard/service registry
- able to mount runtime services and API routes
- packaged as a normal modern ESM package

Example:

- [plugins/ecommerce](/Users/ivanjeremicx/Projects/zelavis/plugins/ecommerce)

## Recommended structure

Use standard `package.json` manifests and put definitions in named files under `src/`:

```text
plugins/example/
  package.json
  src/
    index.ts
    zelavis-example-service.ts
```

- `package.json`
  - contains `"type": "module"`, `"exports"`, and `"zelavis": { "kind": "plugin" }`
- `zelavis-example-service.ts`
  - contains the runtime service definition or uses `import { zelavis } from "zelavis/sdk"`
- `index.ts`
  - re-exports the package surface

## Provider plugins

An official service package may define a public provider registration contract.

`@zelavis/ecommerce` is the current example:

- top-level Zelavis plugin:
  - `ecommercePlugin`
- payment provider plugins:
  - declared as provider plugins (`"zelavis": { "kind": "plugin" }`)
  - declare the `@zelavis/ecommerce:payments` capability

The Ecommerce service discovers installed providers by capability and invokes their explicit registration object. It does not receive hidden children or maintain a package-name allow-list.

## Rule of thumb

- configure plugins in `package.json` (`"zelavis": { "kind": "plugin" }`)
- use the official SDK (`import { zelavis } from "zelavis/sdk"`) for plugin code
- use provider capabilities plus explicit public registration contracts
- let Marketplace trust and permissions decide which plugins may install
- keep official service source in this repo, and keep community service source in author-owned repositories
- describe community services through Marketplace catalog metadata instead of importing their source into the monorepo

See [Service Marketplace Catalog](../reference/service-marketplace-catalog.md) for the catalog metadata contract and hosting recommendation.
