# @zelavis/ecommerce

Official Zelavis ecommerce plugin.

This package provides an end-to-end commerce capability for Zelavis applications and runtimes:

- the official Zelavis plugin `ecommercePlugin`
- low-level commerce domain APIs via `createEcommerce(...)`
- payment provider integrations (e.g. Stripe and PayPal) discovered through the `@zelavis/ecommerce:payments` capability
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

A package declares its identity, namespace and capabilities in `package.json`:

```json
{ "type": "module", "zelavis": { "kind": "plugin", "namespace": "payments", "capabilities": ["@zelavis/ecommerce:payments"] } }
```

A payment extension exports `service.register(api)` and returns the Effect's Promise
presentation. Runtime-dependent work belongs in `zelavis.setup`; menus use
`zelavis.plugins.ui.menus.create`. Package exports do not repeat manifest metadata.

```ts
export default {
  service: {
    name: "example",
    register(api) {
      return api.runPromise(api.payments.registerProvider("example", provider));
    },
  },
};
```

Installed providers are discovered dynamically from `context.registry` by capability, without hardcoding provider allow-lists into the ecommerce core.

## Persistence

The runtime plugin persists through native Zelavis Document DB primitives when available:

- When database services are configured, entities are persisted to dedicated tenant collections with `surface: "database"`.
- A deliberately database-free composition and `createEcommerce(...)` use in-memory repositories. They do not survive shutdown. An unrecognized database is refused.
- On the Node Platform, Ecommerce uses its private services database, Tenant `service:@zelavis/ecommerce`; native Apps use their own Project database. It never exposes the Platform services database as an App database.

Current collections:

- `commerce_products`
- `commerce_customers`
- `commerce_orders`
- `commerce_coupons`
- `commerce_payment_attempts`
- `commerce_subscriptions`
- `commerce_checkouts`
- `commerce_fulfillment_deliveries`

## Runtime Routes

`ecommercePlugin` mounts at `/zelavis/api/v1/plugins/ecommerce/*` with the default API mount. The dashboard pages use `/commerce`; that is not an API prefix. Every read requires `ecommerce.view`, and every write requires `ecommerce.manage`. The webhook callback instead verifies the provider signature over the original body.

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

## Hosted billing

Install Ecommerce and a payment provider through the Marketplace. Stripe supports
hosted Checkout, Billing Portal and verified webhooks. PayPal retains its existing
payment/subscription operations and does not support hosted checkout or webhooks here.
Configure Stripe from its settings page; credentials are sealed in that service's
`core.secrets`, with only configuration flags and a four-character hint returned.

Paths below are relative to `/zelavis/api/v1/plugins/ecommerce`:

| HTTP | SDK operation | CLI |
| --- | --- | --- |
| `POST /checkouts` | `client.plugins.ecommerce.checkouts.create(input)` | `zelavis plugins ecommerce checkouts create --data-stdin` |
| `GET /checkouts/:id` | `.checkouts.get(undefined, { params: { id } })` | `zelavis plugins ecommerce checkouts get --param id=ID` |
| `POST /customers/:id/portal` | `.customers.portal(input, { params: { id } })` | `zelavis plugins ecommerce customers portal --param id=ID --data-stdin` |
| `GET /fulfillment/failures` | `.fulfillment.failures()` | `zelavis plugins ecommerce fulfillment failures` |
| `POST /webhooks/:provider` | Provider callback, signature-authorized | Provider callback; no CLI operation |

Import `@zelavis/ecommerce` for the typed SDK augmentation. Plugin SDK and CLI calls
use the same discovered operations and authorization as HTTP. Use `--json` for
machine-readable CLI output (also the default). Failure pages return
`{ deliveries, next? }`; continue with SDK `{ query: { after: next } }` or CLI
`--query after=CURSOR`.

```ts
const { checkout } = await client.plugins.ecommerce.checkouts.create({
  provider: "stripe", customerId: "customer-id", mode: "subscription",
  lines: [{ name: "Hosting", amount: 1900, currency: "EUR", quantity: 1, interval: "month" }],
  successUrl: "https://shop.example/complete", cancelUrl: "https://shop.example/cancel",
  metadata: { plan: "standard" },
});
// Send the customer to checkout.url. A redirect is not proof of payment.
```

Amounts are integer minor units. A checkout accepts 1–20 lines with one currency,
positive integer quantities, and at most 20 string metadata pairs. Subscription
lines declare their recurring interval. Return URLs require HTTPS, with HTTP
allowed on loopback for development. Unsupported checkout is 409; missing provider
credentials are 409. A customer retains provider references after checkout completion
so the customer portal can use the same provider account. `principalId` can associate
a commerce customer with a Zelavis principal; it grants no permission.

Configure the provider with the webhook path displayed on Payments, using the
Platform's public origin (or a native App's own public hostname). Stripe's path at
the default mount is `/zelavis/api/v1/plugins/ecommerce/webhooks/stripe`.
Native App callbacks use the same exact service-webhook path on a verified App
hostname or preview; ordinary service administration stays private behind the
Project Gateway. Callbacks accept at most 256 KiB and 20 normalized events. Bad signatures return 400;
unknown references return 200 without changing data. Applied events commit their
state change, idempotency receipt and outbox message in one Tenant batch. Repeated
or concurrent deliveries do not repeat the change. Subscription changes apply only
when the provider's occurrence time is newer than the stored time. Recurring invoice
events create or update payment attempts linked by `subscriptionId`; hosted
one-time payments use `checkoutId`. Only order payments require an `orderId`.

## Fulfillment extensions

A service declares `@zelavis/ecommerce:fulfillment` and exports
`service.register(api)`. It registers through
`api.fulfillment.registerHandler(name, handler)`, returning
`api.runPromise(...)`. This works on the Platform and in a native App.

The handler receives `{ id, type, payload, occurredAt }`. Types are
`commerce.checkout.completed`, `commerce.subscription.updated`,
`commerce.payment.succeeded`, and `commerce.payment.failed`; the payload is the
applied record as JSON, with ISO date strings. Validate the payload before acting.
Persist deduplication by message id with your own business change: delivery is at
least once and a crash may repeat a handler call.

The runtime checks the Tenant outbox every five seconds, 50 messages per pass,
with at most four handler calls in flight and a 30-second deadline per attempt.
Failed handlers retry after 30 seconds, two minutes, ten minutes, one hour, then
six hours repeatedly. Successful handlers are not called again while another
handler retries. Messages remain until all registered handlers acknowledge them;
with no handlers they remain available for a later extension. Failures are paged
on the API and shown on Payments. Failure descriptions exclude arbitrary handler
exception text so credentials cannot leak into records or the dashboard.

Custom durable repositories must supply an atomic provider-event repository and
a matching fulfillment outbox. Ordinary CRUD writes cannot emulate that guarantee.
Live Stripe test-mode qualification is a later end-to-end check; these operations
are tested locally against fake clients and signed fixture events.

A timed-out Promise handler keeps its in-flight slot until its Promise settles;
the handler contract has no cancellation signal. This preserves the four-call
bound even when a handler ignores its deadline. Handlers should bound their own
external calls so an unresponsive dependency does not occupy every slot.
