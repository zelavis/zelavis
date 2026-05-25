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
- packaged as a normal workspace package

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

## Child services

An official service package may expose child services.

`@zelavis/ecommerce` is the current example:

- top-level Zelavis service:
  - `zelavisEcommerceService`
- child payment provider services:
  - use the normal `defineService(...)` builder
  - declare `extends: "@zelavis/ecommerce"`

That child service metadata is for extending the ecommerce domain itself, such as payment providers. A child service can be installed through the same registry, but it activates through its parent service instead of appearing as an independent top-level workspace service.

Parent services declare accepted children with `childServices`. `zelavis-ecommerce` currently allows the official Stripe and PayPal child services. Child service `marketplace.categories` are interpreted inside the parent service's child marketplace.

## Rule of thumb

- use `defineService(...)` for top-level Zelavis services
- use `defineService(...)` with `extends` for child services
- let parent services own child-service allow-lists until the marketplace review model is mature
- keep official service source in this repo, and keep community service source in author-owned repositories
- describe community services through Marketplace catalog metadata instead of importing their source into the monorepo

See [Service Marketplace Catalog](../reference/service-marketplace-catalog.md) for the catalog metadata contract and hosting recommendation.
