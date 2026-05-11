# @zelavis/ecommerce

Official Zelavis ecommerce package.

This package is now the single home for Zelavis ecommerce:

- the official Zelavis runtime plugin `zelavisEcommercePlugin`
- the low-level commerce domain API via `createEcommerce(...)`
- provider extension points such as `defineEcommercePlugin(...)`
- provider packages such as Stripe and PayPal

There is no separate old ecommerce base package anymore.

## Main entrypoints

- [packages/plugins/ecommerce/src/zelavis-ecommerce-plugin.ts](/Users/ivanjeremicx/Projects/zelavis/packages/plugins/ecommerce/src/zelavis-ecommerce-plugin.ts)
- [packages/plugins/ecommerce/src/core/create-ecommerce.ts](/Users/ivanjeremicx/Projects/zelavis/packages/plugins/ecommerce/src/core/create-ecommerce.ts)
- [packages/plugins/ecommerce/src/ecommerce-plugin.ts](/Users/ivanjeremicx/Projects/zelavis/packages/plugins/ecommerce/src/ecommerce-plugin.ts)

## Usage

```ts
import {
  createEcommerce,
  defineEcommercePlugin,
  zelavisEcommercePlugin,
} from "@zelavis/ecommerce";
```

## Included layers

- `zelavisEcommercePlugin`
  - the official top-level Zelavis marketplace/runtime plugin
  - mounts `/zelavis/api/v1/commerce/*` routes
  - appears in the dashboard/plugin system
- `createEcommerce(...)`
  - the low-level commerce API for direct programmatic use
- `defineEcommercePlugin(...)`
  - lower-level child/provider plugin contract for extending the commerce API
  - used by payment providers such as Stripe and PayPal

## Layering

There are two plugin layers here on purpose:

1. `definePlugin(...)` from `zelavis/plugin`
   - top-level Zelavis runtime and marketplace plugins
   - example: `zelavisEcommercePlugin`
2. `defineEcommercePlugin(...)` from `@zelavis/ecommerce`
   - lower-level commerce provider plugins
   - examples: Stripe and PayPal payment providers

That means `@zelavis/ecommerce` is both:

- the official Zelavis ecommerce plugin package
- the home for its child provider plugin system

The provider layer extends the ecommerce domain API. It is not the same thing as a top-level Zelavis marketplace plugin.

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
