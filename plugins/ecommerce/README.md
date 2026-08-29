# @zelavis/ecommerce

Official Zelavis ecommerce package.

This package is now the single home for Zelavis ecommerce:

- the official Zelavis runtime service `zelavisEcommerceService`
- the low-level commerce domain API via `createEcommerce(...)`
- child payment provider services
- provider packages such as Stripe and PayPal

There is no separate old ecommerce base package anymore.

## Main entrypoints

- [services/ecommerce/src/zelavis-ecommerce-service.ts](/Users/ivanjeremicx/Projects/zelavis/services/ecommerce/src/zelavis-ecommerce-service.ts)
- [services/ecommerce/src/core/create-ecommerce.ts](/Users/ivanjeremicx/Projects/zelavis/services/ecommerce/src/core/create-ecommerce.ts)
- [services/ecommerce/src/ecommerce-service.ts](/Users/ivanjeremicx/Projects/zelavis/services/ecommerce/src/ecommerce-service.ts)
- [services/ecommerce/src/repositories/database.ts](/Users/ivanjeremicx/Projects/zelavis/services/ecommerce/src/repositories/database.ts)

## Usage

```ts
import {
  createEcommerce,
  zelavisEcommerceService,
} from "@zelavis/ecommerce";
import { defineService } from "zelavis/service";
```

## Included layers

- `zelavisEcommerceService`
  - the official Zelavis project Marketplace/runtime service
  - mounts `/zelavis/api/v1/commerce/*` routes
  - appears in the dashboard/service system
- `createEcommerce(...)`
  - the low-level commerce API for direct programmatic use
  - defaults to in-memory repositories unless you provide your own repositories
- payment provider plugins
  - use the normal Zelavis `defineService(...)` contract
  - declare `provider:payments`
  - expose an explicit registration object consumed through the Ecommerce API

## Layering

There is one service builder:

```ts
import { defineService } from "zelavis/service";
```

The top-level ecommerce service uses it:

```ts
export const zelavisEcommerceService = defineService({
  name: "@zelavis/ecommerce",
});
```

Payment providers use the same builder and declare their capability:

```ts
export const stripeService = defineService({
  name: "@zelavis/ecommerce-stripe",
  kind: "provider",
  capabilities: ["provider:payments"],
  marketplace: {
    title: "Stripe",
    categories: ["payments"],
  },
  service: {
    name: "stripe",
    register(api) {
      api.payments.registerProvider("stripe", provider);
    },
  },
});
```

That means `@zelavis/ecommerce` remains:

- the official Zelavis ecommerce service package
- the owner of the public payment-provider registration contract

The provider layer integrates through the Ecommerce API. Installed providers are discovered by `provider:payments`; adding a compatible provider does not require editing an allow-list in Ecommerce.

## Persistence

The official runtime service persists through Zelavis primitives when they are available:

- if Zelavis database core is enabled, `zelavisEcommerceService` stores commerce entities in Zelavis database collections
- if no database core is enabled, the low-level `createEcommerce(...)` API falls back to in-memory repositories

The current database-backed collections are:

- `commerce_products`
- `commerce_customers`
- `commerce_orders`
- `commerce_coupons`
- `commerce_payment_attempts`
- `commerce_subscriptions`

## Runtime routes

`zelavisEcommerceService` currently mounts:

- `GET /zelavis/api/v1/commerce/health`
- `GET /zelavis/api/v1/commerce/products`
- `POST /zelavis/api/v1/commerce/products`
- `GET /zelavis/api/v1/commerce/products/:id`
- `GET /zelavis/api/v1/commerce/customers`
- `POST /zelavis/api/v1/commerce/customers`
- `GET /zelavis/api/v1/commerce/customers/:id`
- `GET /zelavis/api/v1/commerce/coupons`
- `POST /zelavis/api/v1/commerce/coupons`
- `GET /zelavis/api/v1/commerce/coupons/:code`
- `GET /zelavis/api/v1/commerce/orders`
- `POST /zelavis/api/v1/commerce/orders`
- `GET /zelavis/api/v1/commerce/orders/:id`
- `GET /zelavis/api/v1/commerce/payments/providers`
- `GET /zelavis/api/v1/commerce/payments/attempts`
- `POST /zelavis/api/v1/commerce/orders/:id/payments`
- `GET /zelavis/api/v1/commerce/subscriptions`
