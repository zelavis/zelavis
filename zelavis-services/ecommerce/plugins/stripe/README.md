# @zelavis/ecommerce-stripe

Stripe payments, hosted Checkout, recurring subscriptions, Billing Portal and
signed webhooks for `@zelavis/ecommerce`. Install Ecommerce first, then this plugin.
It runs on the Platform or in a native App. Stripe's library ships bundled; the
Platform installs no dependencies for the service.

The canonical implementation is [`src/stripe-service.ts`](src/stripe-service.ts).
The package registers its settings menu through the official SDK on every load.

## Credentials

Open Stripe settings and save a Stripe secret key (`sk_test_…` or `sk_live_…`) and
webhook signing secret (`whsec_…`). Fields are password inputs, never prefilled,
and cleared after a successful save. A blank form field keeps its stored value.
Only configuration flags and the last four characters of the key are returned.
Credentials are sealed through this plugin's `core.secrets`, separately per runtime.
Code options on `stripeService` / `createStripePaymentProvider` override stored
credentials for explicitly composed runtimes and tests. Client creation is lazy;
an unconfigured provider composes and answers payment requests with 409.

| Surface | Read | Write |
| --- | --- | --- |
| HTTP, default API mount | `GET /zelavis/api/v1/plugins/stripe/settings` | `PUT /zelavis/api/v1/plugins/stripe/settings` |
| SDK | `client.plugins.stripe.settings.get()` | `client.plugins.stripe.settings.set({ secretKey?, webhookSecret? })` |
| CLI | `zelavis plugins stripe settings get` | `zelavis plugins stripe settings set --data-stdin` |

Both operations require `ecommerce.manage`. The API accepts an empty string to
remove a stored credential and omission to keep it. Never put a real credential
in shell history, a URL, a log or a committed file. Supply credential JSON through
standard input when using the CLI.

## Checkout and callbacks

Create checkout and portal sessions through Ecommerce's APIs. Checkout uses
`checkout:<checkoutId>` as its Stripe idempotency key and carries customer,
checkout and caller metadata into the session and subscription/payment intent.
Existing Stripe customer references are reused; otherwise Checkout collects the
customer using their email. Portals require a stored Stripe customer reference.

Copy the webhook path from Ecommerce → Payments into the Stripe endpoint setup,
using the runtime's public origin. The default path is
`/zelavis/api/v1/plugins/ecommerce/webhooks/stripe`. Select these events:

- `checkout.session.completed` and `checkout.session.async_payment_succeeded` (fulfillment waits for paid or no-payment-required)
- `customer.subscription.updated` and `customer.subscription.deleted`
- `invoice.paid` and `invoice.payment_failed`

Signatures are verified over the exact request bytes with Stripe's Web Crypto
provider. Unrecognized event types return an empty event list. Ecommerce owns
atomic application, duplicate protection, ordering and fulfillment retries. Renewal
invoices create payment attempts linked to their known subscription, with no
invented order; unknown subscription references are ignored. The
checkout success redirect never activates anything itself.

Taxes, invoices as documents, coupons on hosted checkout, refunds through the
Zelavis API and metered billing are outside this feature. Manage refunds in
Stripe's dashboard. Automated tests use fake Stripe clients and locally signed
fixtures, never a live payment endpoint. Live test-mode qualification remains
part of the Hosting end-to-end qualification.
