# @zelavis/ecommerce

Official Zelavis ecommerce plugin.

This package provides an end-to-end commerce capability for Zelavis applications and runtimes:

- the official Zelavis plugin `ecommercePlugin`
- low-level commerce domain APIs via `createEcommerce(...)`
- payment provider integrations (e.g. Stripe and PayPal) discovered through the `provider:payments` capability
- recurring billing and subscription lifecycle management

## Main entrypoints

- [`src/ecommerce-plugin.ts`](src/ecommerce-plugin.ts): canonical plugin definition (`kind: "plugin"`)
- [`src/core/create-ecommerce.ts`](src/core/create-ecommerce.ts): low-level commerce engine factory
- [`src/ecommerce-service.ts`](src/ecommerce-service.ts): domain service composition
- [`src/repositories/database.ts`](src/repositories/database.ts): Zelavis Document DB persistence layer

## Usage

```ts
import { createEcommerce, ecommercePlugin } from "@zelavis/ecommerce";
```

## Architecture & Layering

Plugins are configured in `package.json` manifests (`"zelavis": { "kind": "plugin" }`) and export frozen `ZelavisRuntimeService` instances or use the official Zelavis SDK:

```ts
import type { ZelavisRuntimeService } from "zelavis";

export const ecommercePlugin: ZelavisRuntimeService = Object.freeze({
  name: "@zelavis/ecommerce",
  kind: "plugin",
  capabilities: ["api:routes", "dashboard:menu"],
  // ...
});
```

### Payment Provider Discovery

Payment providers (such as `@zelavis/ecommerce-stripe` or `@zelavis/ecommerce-paypal`) are standalone provider plugins. They register with Zelavis by declaring the `provider:payments` capability:

```ts
export const stripeService: ZelavisRuntimeService = Object.freeze({
  name: "@zelavis/ecommerce-stripe",
  kind: "provider",
  capabilities: ["provider:payments"],
  service: {
    name: "stripe",
    register(api) {
      api.payments.registerProvider("stripe", provider);
    },
  },
});
```

Installed providers are discovered dynamically from `context.registry` by capability, without hardcoding provider allow-lists into the ecommerce core.

## Persistence

The runtime plugin persists through native Zelavis Document DB primitives when available:

- When database services are configured, entities are persisted to dedicated tenant collections with `surface: "database"`.
- Without a database, `createEcommerce(...)` falls back to in-memory repositories.

Current collections:

- `commerce_products`
- `commerce_customers`
- `commerce_orders`
- `commerce_coupons`
- `commerce_payment_attempts`
- `commerce_subscriptions`

## Runtime Routes

`ecommercePlugin` registers OpenAPI-documented routes under `/commerce` (accessed via `/zelavis/api/v1/commerce/*`):

### Products
- `GET /health` — Service health & platform presets
- `GET /products` — List all products
- `POST /products` — Create product
- `GET /products/:id` — Get product by ID

### Customers
- `GET /customers` — List customers
- `POST /customers` — Create customer
- `GET /customers/:id` — Get customer by ID

### Coupons
- `GET /coupons` — List coupons
- `POST /coupons` — Create coupon
- `GET /coupons/:code` — Get coupon by code

### Orders
- `GET /orders` — List orders
- `POST /orders` — Create order
- `GET /orders/:id` — Get order by ID

### Payments
- `GET /payments/providers` — List registered payment providers
- `GET /payments/attempts` — List payment attempts
- `POST /orders/:id/payments` — Initiate payment for an order

### Subscriptions & Recurring Billing
- `GET /subscriptions` — List active and historical subscriptions
- `POST /subscriptions` — Create a recurring subscription (supports Stripe, PayPal, etc.)
- `GET /subscriptions/:id` — Get subscription details
- `POST /subscriptions/:id/cancel` — Cancel an active subscription
