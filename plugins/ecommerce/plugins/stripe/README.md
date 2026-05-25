# @zelavis/ecommerce-stripe

Stripe payment provider service for `@zelavis/ecommerce`.

This package registers a Stripe-backed payment provider using Stripe's official Node SDK and the Payment Intents API.

It uses the Stripe SDK in the service-friendly form recommended by Stripe, including `appInfo`, and creates PaymentIntents for ecommerce orders.

Recurring billing is also supported through Stripe's official Subscriptions API.

## Runtime model

This package is intended to stay provider-centric rather than platform-centric.

Use one Stripe service package across:

- Node.js servers
- serverless environments
- fetch-based runtimes
- worker-style runtimes that can provide compatible HTTP support

The service supports this by allowing either:

- a preconfigured Stripe client via `client`
- a `secretKey` plus `runtime` config

For fetch-based runtimes, use `createFetchStripeRuntime()` to build Stripe config with `Stripe.createFetchHttpClient(...)`.

Webhook verification concerns should stay outside the payment provider service. For runtimes using Web Crypto, this package also exports `createStripeWebhookCryptoProvider()` as a helper around Stripe's SubtleCrypto provider.

## Examples

### Node-style runtime

```ts
import { createEcommerce } from "@zelavis/ecommerce";
import { stripeService } from "@zelavis/ecommerce-stripe";

const commerce = await createEcommerce({
  services: [
    stripeService({
      secretKey: process.env.STRIPE_SECRET_KEY,
    }),
  ],
});
```

### Fetch-based runtime

```ts
import { createEcommerce } from "@zelavis/ecommerce";
import { createFetchStripeRuntime, stripeService } from "@zelavis/ecommerce-stripe";

const commerce = await createEcommerce({
  services: [
    stripeService({
      secretKey: process.env.STRIPE_SECRET_KEY,
      runtime: createFetchStripeRuntime({
        fetchFn: fetch,
      }),
    }),
  ],
});
```
