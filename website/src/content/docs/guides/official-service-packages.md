---
title: Official Service Packages
---
Official Zelavis service packages live under `services/*`.

These packages are first-party marketplace/runtime services written by the Zelavis team. They use the top-level `defineService(...)` contract from `zelavis/service`.

## What makes them different

An official service package is a top-level Zelavis service:

- installable through the Zelavis service system
- visible in the dashboard/service registry
- able to mount runtime services and API routes
- packaged as a normal monorepo package

Example:

- [plugins/ecommerce](/Users/ivanjeremicx/Projects/zelavis/plugins/ecommerce)

## Recommended structure

Use one obvious named file for the top-level service definition:

```text
services/example/
  src/
    index.ts
    zelavis-example-service.ts
```

- `zelavis-example-service.ts`
  - contains the real `defineService(...)` call
- `index.ts`
  - re-exports the package surface

## Provider plugins

An official service package may define a public provider registration contract.

`@zelavis/ecommerce` is the current example:

- top-level Zelavis service:
  - `zelavisEcommerceService`
- payment provider plugins:
  - use the normal `defineService(...)` builder
  - declare `provider:payments`

The Ecommerce service discovers installed providers by capability and invokes their explicit registration object. It does not receive hidden children or maintain a package-name allow-list.

## Rule of thumb

- use `defineService(...)` for top-level Zelavis services
- use provider capabilities plus explicit public registration contracts
- let Marketplace trust and permissions decide which plugins may install
- keep official service source in this repo, and keep community service source in author-owned repositories
- describe community services through Marketplace catalog metadata instead of importing their source into the monorepo

See [Service Marketplace Catalog](../reference/service-marketplace-catalog.md) for the catalog metadata contract and hosting recommendation.
