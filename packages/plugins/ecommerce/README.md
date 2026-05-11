# @zelavis/ecommerce

Official Zelavis ecommerce package.

This package is now the single home for Zelavis ecommerce:

- the official Zelavis runtime plugin `zelavisEcommercePlugin`
- the low-level commerce domain API via `createEcommerce(...)`
- child plugin extension points such as `payments`
- provider packages such as Stripe and PayPal

There is no separate old ecommerce base package anymore.

## Main entrypoints

- [packages/plugins/ecommerce/src/zelavis-ecommerce-plugin.ts](/Users/ivanjeremicx/Projects/zelavis/packages/plugins/ecommerce/src/zelavis-ecommerce-plugin.ts)
- [packages/plugins/ecommerce/src/core/create-ecommerce.ts](/Users/ivanjeremicx/Projects/zelavis/packages/plugins/ecommerce/src/core/create-ecommerce.ts)
- [packages/plugins/ecommerce/src/ecommerce-plugin.ts](/Users/ivanjeremicx/Projects/zelavis/packages/plugins/ecommerce/src/ecommerce-plugin.ts)
- [packages/plugins/ecommerce/src/repositories/database.ts](/Users/ivanjeremicx/Projects/zelavis/packages/plugins/ecommerce/src/repositories/database.ts)

## Usage

```ts
import {
  createEcommerce,
  zelavisEcommercePlugin,
} from "@zelavis/ecommerce";
import { definePlugin } from "zelavis/plugin";
```

## Included layers

- `zelavisEcommercePlugin`
  - the official top-level Zelavis marketplace/runtime plugin
  - mounts `/zelavis/api/v1/commerce/*` routes
  - appears in the dashboard/plugin system
- `createEcommerce(...)`
  - the low-level commerce API for direct programmatic use
  - defaults to in-memory repositories unless you provide your own repositories
- child payment provider plugins
  - use the normal Zelavis `definePlugin(...)` contract
  - declare `extends: { plugin: "zelavis-ecommerce", extensionPoint: "payments" }`
  - receive the ecommerce API in setup when the parent ecommerce plugin activates

## Layering

There is one plugin builder:

```ts
import { definePlugin } from "zelavis/plugin";
```

The top-level ecommerce plugin uses it:

```ts
export const zelavisEcommercePlugin = definePlugin({
  name: "zelavis-ecommerce",
  extensionPoints: [
    {
      name: "payments",
      policy: "reviewed",
      allowedPlugins: ["stripe", "paypal"],
    },
  ],
});
```

Payment providers use the same builder, but declare that they extend ecommerce:

```ts
export const stripePlugin = definePlugin({
  name: "stripe",
  extends: {
    plugin: "zelavis-ecommerce",
    extensionPoint: "payments",
  },
  setup(api) {
    api.payments.registerProvider("stripe", provider);
  },
});
```

That means `@zelavis/ecommerce` is both:

- the official Zelavis ecommerce plugin package
- the home for its child provider plugin system

The provider layer extends the ecommerce domain API. It is installed through the same plugin registry, but it activates through its parent plugin rather than as an independent top-level workspace plugin.

The `payments` extension point is currently `reviewed`. The official ecommerce package accepts Stripe and PayPal. Other payment providers should be added to that allowlist by the parent plugin package before they activate.

## Persistence

The official runtime plugin persists through Zelavis primitives when they are available:

- if Zelavis database core is enabled, `zelavisEcommercePlugin` stores commerce entities in Zelavis database collections
- if no database core is enabled, the low-level `createEcommerce(...)` API falls back to in-memory repositories

The current database-backed collections are:

- `commerce_products`
- `commerce_customers`
- `commerce_orders`
- `commerce_coupons`
- `commerce_payment_attempts`
- `commerce_subscriptions`

## Runtime routes

`zelavisEcommercePlugin` currently mounts:

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
