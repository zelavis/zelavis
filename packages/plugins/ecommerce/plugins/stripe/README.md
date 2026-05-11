# @zelavis/ecommerce-stripe

Stripe payment provider plugin for `@zelavis/ecommerce`.

This package registers a Stripe-backed payment provider using Stripe's official Node SDK and the Payment Intents API.

It uses the Stripe SDK in the plugin-friendly form recommended by Stripe, including `appInfo`, and creates PaymentIntents for ecommerce orders.

Recurring billing is also supported through Stripe's official Subscriptions API.

## Runtime model

This package is intended to stay provider-centric rather than platform-centric.

Use one Stripe plugin package across:

- Node.js servers
- serverless environments
- fetch-based runtimes
- worker-style runtimes that can provide compatible HTTP support

The plugin supports this by allowing either:

- a preconfigured Stripe client via `client`
- a `secretKey` plus `runtime` config

For fetch-based runtimes, use `createFetchStripeRuntime()` to build Stripe config with `Stripe.createFetchHttpClient(...)`.

Webhook verification concerns should stay outside the payment provider plugin. For runtimes using Web Crypto, this package also exports `createStripeWebhookCryptoProvider()` as a helper around Stripe's SubtleCrypto provider.

## Examples

### Node-style runtime

```ts
import { createEcommerce } from "@zelavis/ecommerce";
import { stripePlugin } from "@zelavis/ecommerce-stripe";

const commerce = await createEcommerce({
  plugins: [
    stripePlugin({
      secretKey: process.env.STRIPE_SECRET_KEY,
    }),
  ],
});
```

### Fetch-based runtime

```ts
import { createEcommerce } from "@zelavis/ecommerce";
import { createFetchStripeRuntime, stripePlugin } from "@zelavis/ecommerce-stripe";

const commerce = await createEcommerce({
  plugins: [
    stripePlugin({
      secretKey: process.env.STRIPE_SECRET_KEY,
      runtime: createFetchStripeRuntime({
        fetchFn: fetch,
      }),
    }),
  ],
});
```
