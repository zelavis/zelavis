# @zelavis/ecommerce

Low-level ecommerce building blocks for custom software, CMS systems, and application backends.

This package is intended to sit below a storefront, admin panel, CMS plugin, or SaaS product. It focuses on composable domain services and payment/provider plugins rather than prescribing a full application.

## Goals

- Manage customers and user-facing commerce entities.
- Support coupons, pricing rules, and order flows.
- Integrate payment providers through plugins.
- Stay low level enough to embed inside larger systems.

## Architecture

- Typed domain entities for customers, products, coupons, orders, and payment attempts.
- Repository contracts that isolate persistence from domain logic.
- In-memory repositories by default for local development and tests.
- Payment providers registered through plugins so Stripe, PayPal, and other gateways can be added without changing the core.
- Customers may optionally reference an auth account through `accountId`, which keeps `@zelavis/ecommerce` and `@zelavis/auth` linkable without coupling either package to a specific database model.

## Initial surface

- `createEcommerce(options)`
- `definePlugin(plugin)`
- `@zelavis/ecommerce-stripe`
- `CustomerService`
- `CouponService`
- `ProductService`
- `OrderService`
- `PaymentService`
- `createInMemoryRepositories()`

The main plugin-definition entrypoint lives in
[packages/ecommerce/src/ecommerce-plugin.ts](/Users/ivanjeremicx/Projects/zelavis/packages/ecommerce/src/ecommerce-plugin.ts),
so package authors can immediately see the `definePlugin({ ... })` shape in one place.

## Example

```ts
import { createEcommerce, definePlugin } from "@zelavis/ecommerce";

const stripePlugin = definePlugin({
  name: "stripe",
  setup(api) {
    api.payments.registerProvider("stripe", {
      async createPayment({ order, amount, currency }) {
        const now = new Date();

        return {
          id: `pay_${order.id}`,
          orderId: order.id,
          provider: "stripe",
          amount,
          currency,
          status: "requires_action",
          createdAt: now,
          updatedAt: now,
        };
      },
    });
  },
});

const commerce = await createEcommerce({
  plugins: [stripePlugin],
});

const customer = await commerce.customers.create({
  id: "cus_1",
  accountId: "acc_1",
  email: "ada@example.com",
});

const product = await commerce.products.create({
  id: "prod_1",
  slug: "starter-plan",
  title: "Starter plan",
  price: {
    amount: 1999,
    currency: "USD",
  },
});

const order = await commerce.orders.create({
  id: "ord_1",
  customerId: customer.id,
  items: [
    {
      productId: product.id,
      quantity: 1,
      unitPrice: product.price.amount,
    },
  ],
  totals: {
    subtotal: 1999,
    discountTotal: 0,
    taxTotal: 0,
    grandTotal: 1999,
    currency: "USD",
  },
});

await commerce.payments.createPayment(order, "stripe");
```

## HTTP Adapters

Framework helpers live in nested workspace packages:

- `@zelavis/ecommerce-express`
- `@zelavis/ecommerce-hono`

These adapters are thin transport adapters around the core services. They are optional and intended as convenience layers, not as the primary architecture of the package.

## Plugins

Optional domain capabilities live in nested workspace plugin packages:

- `@zelavis/ecommerce-stripe`
- `@zelavis/ecommerce-paypal`

Payment providers should be implemented as plugins, not transport adapters.

## Recurring Billing

`PaymentService` also provides a unified recurring billing surface:

- `createSubscription(input, providerName)`
- `cancelSubscription(subscriptionId, options?)`
- `getSubscriptionById(id)`
- `listSubscriptions()`

Providers can implement recurring flows through the same plugin boundary used for one-time payments.

## Adapter direction

The current package ships with in-memory repositories only. The intended next layer is separate adapter packages or app-level adapters for:

- Prisma or Drizzle-backed repositories.
- SQL document or key-value persistence.
- Provider plugins for Stripe, PayPal, and other gateways.
