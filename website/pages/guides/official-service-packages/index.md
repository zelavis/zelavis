---
layout: docs
title: "Official Service Packages"
---

# Official Service Packages

Official Zelavis service packages live under `zelavis-services/*` in the repository. They are published to npm on their own release cycle and are not shipped with the Platform.

These packages are first-party marketplace/runtime services written by the Zelavis team. They declare their static identity in modern `package.json` manifests (`"type": "module"`, `"exports"`, and `"zelavis"`) and register APIs, routes and menus through the official SDK. Module exports may supply setup or a public service registration contract; they must not repeat manifest identity or export raw API objects.

## What makes them different

An official service package is a loadable Zelavis service:

- installable through the Zelavis service system
- visible in the dashboard/service registry
- able to mount runtime services and API routes
- packaged as a normal modern ESM package

Example:

- `zelavis-services/ecommerce`

## Recommended structure

Use standard `package.json` manifests and put definitions in named files under `src/`:

```text
zelavis-services/example/
  package.json
  src/
    index.ts
    zelavis-example-service.ts
```

- `package.json`
  - contains `"type": "module"`, `"exports"`, and `"zelavis": { "kind": "plugin" }`
- `zelavis-example-service.ts`
  - contains the named definition and uses `import { zelavis } from "zelavis/sdk"` for declarations
- `index.ts`
  - re-exports the package surface

## Provider plugins

An official service package may define a public provider registration contract.

`@zelavis/ecommerce` is the current example:

- top-level Zelavis plugin:
  - `ecommercePlugin`
- payment provider plugins:
  - declared as provider plugins (`"zelavis": { "kind": "plugin" }`)
  - declare the `@zelavis/ecommerce:payments` capability

The Ecommerce service discovers installed providers by capability and invokes their explicit registration object. It does not receive hidden children or maintain a package-name allow-list.

## Rule of thumb

- configure plugins in `package.json` (`"zelavis": { "kind": "plugin" }`)
- use the official SDK (`import { zelavis } from "zelavis/sdk"`) for plugin code
- use provider capabilities plus explicit public registration contracts
- let Marketplace trust and permissions decide which plugins may install
- keep official service source in this repo, and keep community service source in author-owned repositories
- describe community services through Marketplace catalog metadata instead of importing their source into the monorepo

See [Service Marketplace Catalog](/reference/service-marketplace-catalog/) for the catalog metadata contract and hosting recommendation.

## Billing through Ecommerce

`@zelavis/ecommerce` runs on the Platform using its private services database, or
inside a native App using that App's database. Its routes require `ecommerce.view`
for reads and `ecommerce.manage` for writes. Install `@zelavis/ecommerce-stripe` to
add hosted Checkout, Billing Portal and signature-verified callbacks. PayPal keeps
its existing payment/subscription operations; hosted checkout is unsupported.

Configure Stripe through its service settings page, or the equivalent
`GET|PUT /zelavis/api/v1/plugins/stripe/settings`,
`client.plugins.stripe.settings.get|set` and
`zelavis plugins stripe settings get|set --data-stdin`. Settings require
`ecommerce.manage` and return only configured flags and a key hint. Credentials
are sealed per service and runtime, and are never returned.

Ecommerce operations are relative to `/zelavis/api/v1/plugins/ecommerce`:

| HTTP | JavaScript SDK | CLI |
| --- | --- | --- |
| `POST /checkouts` | `client.plugins.ecommerce.checkouts.create(input)` | `zelavis plugins ecommerce checkouts create --data-stdin` |
| `GET /checkouts/:id` | `.checkouts.get(undefined, { params: { id } })` | `zelavis plugins ecommerce checkouts get --param id=ID` |
| `POST /customers/:id/portal` | `.customers.portal(input, { params: { id } })` | `zelavis plugins ecommerce customers portal --param id=ID --data-stdin` |
| `GET /fulfillment/failures` | `.fulfillment.failures()` | `zelavis plugins ecommerce fulfillment failures` |

A checkout contains a provider, customer id, `payment` or `subscription` mode,
1–20 lines (minor-unit amount, currency, quantity and optional recurring interval),
HTTPS success/cancel URLs (HTTP on loopback is allowed) and up to 20 metadata pairs.
It returns `{ checkout }` with a provider-hosted URL. Missing credentials and
unsupported checkout return 409. A redirect is not proof of payment.

The provider sends signed callbacks to `POST /plugins/ecommerce/webhooks/:provider`
under the API base; it is a provider callback with no SDK or CLI equivalent.
Ecommerce verifies the raw body, commits each applied event and its outbox message
atomically and ignores duplicate or older subscription changes. Other services
consume the [`@zelavis/ecommerce:fulfillment` extension point](/guides/plugin-api/#ecommerce-fulfillment).
Handlers deduplicate message ids; delivery retries across restarts. Payments shows
webhook paths, checkout support and paged fulfillment failures. Live Stripe
test-mode qualification remains a later end-to-end check.

## Hosting Provider

`@zelavis/hosting` adds recurring Project plans, quotas, and billing-driven
suspension on the Platform. Install Ecommerce and a compatible payment provider
first, then approve Hosting's service permissions in the Marketplace. Customers
use their existing Zelavis accounts. Hosting maps their subscriptions to
Project-scoped roles. See the [Hosting Provider guide](/guides/hosting-provider/).
