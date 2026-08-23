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
- child payment provider services
  - use the normal Zelavis `defineService(...)` contract
  - declare `extends: "@zelavis/ecommerce"`
  - receive the ecommerce API in setup when the parent ecommerce service activates

## Layering

There is one service builder:

```ts
import { defineService } from "zelavis/service";
```

The top-level ecommerce service uses it:

```ts
export const zelavisEcommerceService = defineService({
  name: "@zelavis/ecommerce",
  childServices: ["@zelavis/ecommerce-stripe", "@zelavis/ecommerce-paypal"],
});
```

Payment providers use the same builder, but declare that they extend ecommerce:

```ts
export const stripeService = defineService({
  name: "@zelavis/ecommerce-stripe",
  extends: "@zelavis/ecommerce",
  marketplace: {
    title: "Stripe",
    categories: ["payments"],
  },
  setup(api) {
    api.payments.registerProvider("@zelavis/ecommerce-stripe", provider);
  },
});
```

That means `@zelavis/ecommerce` is both:

- the official Zelavis ecommerce service package
- the home for its child provider service system

The provider layer extends the ecommerce domain API. It is installed through the same service registry, but it activates through its parent service rather than as an independent top-level Extensions service.

The official ecommerce package accepts Stripe and PayPal through `childServices`. Other payment providers should be added to that allow-list by the parent service package before they activate.

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
