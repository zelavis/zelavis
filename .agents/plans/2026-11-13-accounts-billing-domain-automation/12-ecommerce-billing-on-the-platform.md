# Ecommerce billing on the Platform
Job: Make `@zelavis/ecommerce` safe and complete enough to bill hosting customers from the Platform: every route authorized, provider credentials stored sealed, hosted checkout and customer portal, verified provider webhooks applied exactly once, and a fulfillment extension point that tells other services (Hosting) what was paid, at least once.
Date: 2026-11-13
Status: done
Verified-at: b04fa02d95
Part: 12 of 14. Read 00-overview.md first.

To start:    Execute part 12 in .agents/plans/2026-11-13-accounts-billing-domain-automation/12-ecommerce-billing-on-the-platform.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-13-accounts-billing-domain-automation/12-ecommerce-billing-on-the-platform.md. Start with its section 8.

## Progress

- [x] 1. (2026-11-17) Baseline Platform build, 22 Ecommerce tests and Stripe typecheck passed.
- [x] 2. (2026-11-17) Sealed service secrets, namespace binding, concurrent limits and Effect gate pass.
- [x] 3. (2026-11-17) All routes authorized; anonymous/forbidden/view/manage cases and all 23 tests pass.
- [x] 4. (2026-11-17) Checkout/portal persistence, validation and HTTP/SDK/CLI tests pass; 25 tests green.
- [x] 5. (2026-11-17) Signed events, concurrent duplicates, ordering, unknown references and body/event bounds pass; 27 tests green.
- [x] 6. (2026-11-17) Retry/backoff, per-handler acknowledgements, restart recovery and lifecycle cleanup pass; 29 Ecommerce and 3 core tests green.
- [x] 7. (2026-11-17) Stripe build/typecheck and all 32 Ecommerce tests pass with fake checkout/portal clients and real test signatures.
- [x] 8. (2026-11-17) All 33 Ecommerce tests and ci:ui pass; opaque-frame desktop/mobile credential saves, reload, gateway paths and failures proved.
- [x] 9. (2026-11-17) Ecommerce/Stripe READMEs, service/extension guides, durable guidance and changeset added; docs:check passed.
- [x] 10. (2026-11-17) Session diff/new files reviewed; 45 Ecommerce tests, full verify, ci:ui, docs and whitespace checks pass; no blocker remains.

## 0. Summary and finish line

Ecommerce already has customers, products, orders, payment attempts, subscriptions and provider plugins discovered through `@zelavis/ecommerce:payments` (`zelavis-services/ecommerce/src/ecommerce-plugin.ts:182`, `:523-549`; Stripe and PayPal in `zelavis-services/ecommerce/plugins/`). It cannot yet bill anyone from the Platform: its routes declare no access at all (anyone could call them on a Platform), provider keys come only from code (`stripeService({ secretKey })`, `plugins/stripe/src/stripe-service.ts:31-46`), there is no hosted checkout, no webhook intake (the contract comment says renewals "arriv[e] as webhooks", `src/services/payments.ts:1-12`, but nothing receives them), and nothing tells another service a subscription changed. This part closes those gaps once, for Ecommerce in a Project and on the Platform alike, so Hosting (part 14) contains no payment code.

- **In scope**: `core.secrets` in the Zelavis service setup context; access requirements on every Ecommerce route; provider contract additions (checkout, portal, webhook parsing); checkout and provider-event records; the webhook route; the fulfillment extension point with at-least-once delivery from the Tenant outbox; the Stripe implementation; dashboard pages; docs.
- **Out of scope**: PayPal checkout/webhooks (the contract members are optional; PayPal keeps what it has and is listed as not supporting checkout); taxes, invoices as documents, refunds through Zelavis, coupons on checkout, metered billing; live Stripe qualification (part 14 runs it end to end).
- **Done means**: (a) on a Platform, every Ecommerce route except the webhook route refuses anonymous callers (401) and callers without `ecommerce.view` (reads) or `ecommerce.manage` (writes) (403); (b) `PUT /plugins/stripe/settings` stores the secret key and webhook secret sealed and never returns them; (c) `POST /plugins/ecommerce/checkouts` returns a provider-hosted checkout URL and stores a checkout record; (d) a signed webhook for a completed checkout or a subscription change updates the stored subscription exactly once, even when the provider sends it twice or two copies arrive at once, and an unsigned or wrongly signed one is 400 with nothing written; (e) a service declaring `@zelavis/ecommerce:fulfillment` receives every paid/changed event at least once, across a restart, and a failing handler is retried with backoff and listed for the operator; (f) Ecommerce's own tests, the Stripe tests (against a fake Stripe client), `verify`, `ci:ui` and `docs:check` pass.
- **Owner decision (2026-11-13, this conversation)**: "Billing/Ecommerce stuff is solved once in Zelavis Ecommerce"; Ecommerce stays a service; payment providers (Stripe, PayPal, Braintree, Klarna, …) stay Ecommerce plugins.
- **Supplement**: updated in this run (overview section 0).
- **Sources read**: `AGENTS.md § Core Access-Control Rule`, `§ Endpoint-Backed Capability Rule` (plugin namespaces), `§ Database Architecture Rules` (outbox, idempotency keys), `§ Service Loading Rules`, `§ Effect Version`; `zelavis-services/ecommerce/README.md`; files below.

## 1. Context packet

**Glossary.**
- **Provider event**: one verified notification from a payment provider (`checkout.completed`, `subscription.updated`, `payment.succeeded`, `payment.failed`), with the provider's own event id.
- **Fulfillment handler**: code another service registers with Ecommerce to act on provider events (Hosting creates entitlements). Declared by the capability `@zelavis/ecommerce:fulfillment`.
- **Ecommerce Tenant**: `service:@zelavis/ecommerce`, the Tenant Ecommerce writes (`ecommerce-plugin.ts:545-547`).

**Governing rules.**
- R1 > "A write may carry an `idempotencyKey`, and its receipt is written in the same transaction as the change" `AGENTS.md § Database Architecture Rules`
- R2 > "App code that must emit a message with a write does it through the same batch: `documents.write({ emit })` … delivery is at least once, so consumers deduplicate by message id and `outbox.remove` what they have handled." `AGENTS.md § Database Architecture Rules`
- R3 > "Auth methods, payment providers, and similar integrations are ordinary installed plugins discovered by a declared capability and validated against the owning domain's explicit public registration contract." `AGENTS.md § Platform And App Service Boundary`
- R4 > "Effect v4 is mandatory for asynchronous orchestration in the unified `zelavis` package and trusted product/recipe runtimes." `AGENTS.md § Effect Version` (Ecommerce's services are Effect already, `src/services/payments.ts:13-60`; keep new orchestration in Effect and cross to Promises only at `runPromise`).
- R5 > "Provider tokens are stored encrypted, never returned or logged, and every use is audited." `AGENTS.md § Cloud Capacity And Alchemy` (the same standard for payment keys).

**System today.**
- Ecommerce plugin `zelavis-services/ecommerce/src/ecommerce-plugin.ts`: menus `:452-515`; setup `:523-549` (payment provider discovery, database check, `createEcommerce`); routes from `:550` with `meta: { pluginResource, pluginAction }` and no `access`; subscription routes `:1038-1135`.
- Payment contract `zelavis-services/ecommerce/src/contracts/payment-provider.ts:1-51` (`PaymentProvider` with optional `capturePayment`, `refundPayment`, `createSubscription`, `cancelSubscription`).
- Entities `zelavis-services/ecommerce/src/domain/entities.ts` (`PaymentAttempt` `:~95-110`, `SubscriptionStatus` `:116-123`, `BillingSubscription` `:127-145`).
- `EcommerceApi` `zelavis-services/ecommerce/src/core/types.ts:22-32` (services plus `runPromise`); provider extensions receive it in `register(api)` (`plugins/stripe/src/stripe-service.ts:439-464`).
- Database repositories `zelavis-services/ecommerce/src/repositories/database.ts` (641 lines; collections `commerce_*`, `surface: "database"`).
- Tests `zelavis-services/ecommerce/test/` (`ecommerce-payment-extensions.test.mjs`, `ecommerce-plugin.test.mjs`, `persistence.test.mjs`, `stripe-payment-provider.test.mjs`, helper `load-plugin.mjs`).
- Access enforcement: a route with no `access` has no requirements (`packages/zelavis/src/core/runtime/request-dispatcher.ts:768-772`), so nothing stops an anonymous caller. In a Project, calls arrive through the Gateway proxy (`project.view` for GET, `project.runtime.manage` otherwise, `packages/zelavis/src/platform/project-gateway.ts:815-824`) with the caller's own Project permissions forwarded (`:557-575`).
- Raw body: handlers receive the original `request` (`request-dispatcher.ts:885-895`; the parser reads a clone, `:448`), so `request.text()` gives the exact bytes a signature covers.
- Service setup core context `packages/zelavis/src/service.ts:217-235` (`database`, `auth`, `storage`, `workloads`, `store`, host operations); service store `packages/zelavis/src/platform/service-store.ts:21-46`.
- Master secret and sealing: `loadPlatformMasterSecret(store)` `packages/zelavis/src/platform/master-secret.ts:19`; `encryptSecret`/`decryptSecret` `packages/zelavis/src/edge/acme-crypto.ts:79`, `:104`.
- Part 11 handover: services on the Platform get `core.database` (`subsystems.servicesDatabase`).

**Pattern to mirror.** Payment provider discovery and `register(api)` for the new fulfillment capability (`ecommerce-plugin.ts:184-191`, `:525-528`); the extension tests in `test/ecommerce-payment-extensions.test.mjs` for composing a runtime with Ecommerce and a gateway; Assistant provider keys for sealed credentials (`packages/zelavis/src/assistant-provider.ts:120-250`).

**Traps.**
- Verifying a webhook against `JSON.stringify(body)`: signatures cover the exact bytes; read `request.text()` once, with a 256 KiB cap.
- Treating "webhook received" as "applied": the ledger entry and the state change are one `documents.write` with `idempotencyKey: "<provider>:<eventId>"` (R1), so a duplicate is answered 200 without a second change.
- Applying provider events in arrival order: providers do not guarantee order. Each subscription update carries the provider's `occurredAt`; apply only when it is newer than the stored `providerUpdatedAt`.
- Calling fulfillment handlers inside the webhook request: the request answers once the write commits; delivery runs from the outbox (R2).
- Letting a handler throw stop delivery for everyone: each handler's failure is recorded and retried for that handler only.
- Keys in plugin options in production code: credentials come from `core.secrets`; code options stay for tests and operator-composed setups.

## 2. Design

**Authority and scope.** Two permissions, no scope (runtime-wide): `ecommerce.view` for every `GET` and `ecommerce.manage` for every write. On the Platform they are Platform grants; in a Project they are checked against the permissions the Gateway forwards (Project owners hold `*`). The webhook route is anonymous and authorized only by the provider's signature. Stripe's settings route needs `ecommerce.manage`. If account access refuses permission names it does not know, add these two (and `ecommerce.view`/`manage` labels) wherever the Platform's permission vocabulary is validated: find it with `rg -n "\"server.cloud.view\"" packages/zelavis/src --glob '!**/cloud-*'`.

**Sealed service secrets** (NEW `packages/zelavis/src/platform/service-secrets.ts`, core, runtime-neutral):

```ts
export interface ZelavisServiceSecrets {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
  /** Names only, never values. */
  list(): Promise<readonly string[]>;
}
export function createServiceSecrets(store: ZelavisSystemStore, serviceName: string, masterSecret: string): ZelavisServiceSecrets;
```

Namespace `zelavis.service-secrets:<service name>`; value `{ schemaVersion: 1, sealed: EncryptedSecret, updatedAt }`; key `${masterSecret}\u0000service-secret:<service name>:<name>`; names `^[a-z][a-z0-9._-]{0,63}$`, values ≤ 4096 bytes, at most 32 per service. `ZelavisServiceSetupCoreContext` gains `secrets?: ZelavisServiceSecrets`, present wherever `store` is. Platform and Project runtimes each use their own master secret.

**Contract additions** (`src/contracts/payment-provider.ts`):

```ts
export interface CheckoutLine { readonly name: string; readonly amount: number /* minor units */; readonly currency: string; readonly quantity: number; readonly interval?: SubscriptionInterval; readonly intervalCount?: number }
export interface CreateCheckoutInput {
  readonly checkoutId: string; readonly mode: "payment" | "subscription"; readonly customer: Customer;
  readonly lines: readonly CheckoutLine[]; readonly successUrl: string; readonly cancelUrl: string;
  readonly metadata: Readonly<Record<string, string>>;
}
export interface CheckoutSession { readonly reference: string; readonly url: string; readonly expiresAt?: Date; readonly customerReference?: string }
export interface CreatePortalInput { readonly customer: Customer; readonly customerReference: string; readonly returnUrl: string }
export type ProviderEvent =
  | { readonly type: "checkout.completed"; readonly eventId: string; readonly occurredAt: Date; readonly checkoutReference: string; readonly customerReference?: string; readonly subscriptionReference?: string; readonly paymentReference?: string }
  | { readonly type: "subscription.updated"; readonly eventId: string; readonly occurredAt: Date; readonly subscriptionReference: string; readonly status: SubscriptionStatus; readonly currentPeriodStart?: Date; readonly currentPeriodEnd?: Date; readonly cancelAtPeriodEnd: boolean }
  | { readonly type: "payment.succeeded" | "payment.failed"; readonly eventId: string; readonly occurredAt: Date; readonly paymentReference: string; readonly amount: number; readonly currency: string; readonly subscriptionReference?: string };
export interface PaymentProvider {
  // existing members unchanged
  createCheckout?(input: CreateCheckoutInput): Promise<CheckoutSession>;
  createPortal?(input: CreatePortalInput): Promise<{ readonly url: string }>;
  /** Verifies the signature over `rawBody` and returns the events it carries; rejects with `InvalidWebhook` when it does not verify. Unknown event types are returned as an empty list. */
  parseWebhook?(input: { readonly headers: Headers; readonly rawBody: string }): Promise<readonly ProviderEvent[]>;
}
```

**Persistence** (Ecommerce Tenant, documents API):
- `commerce_checkouts`: `{ id, provider, mode, customerId, lines, reference, url, status: "open" | "completed" | "expired", subscriptionId?, metadata, createdAt, updatedAt }`.
- `commerce_subscriptions` (existing) gains `providerCustomerReference?`, `providerUpdatedAt?: Date`, `checkoutId?`.
- `commerce_customers` (existing) gains `providerReferences?: Record<string, string>` (provider → customer id at the provider) and `principalId?: string` (the Zelavis principal a customer is, set by whoever creates it; Hosting sets it).
- Ledger: every applied provider event is one `documents.write` with `idempotencyKey: "<provider>:<eventId>"` and `emit: [{ id: "<provider>:<eventId>", type: "commerce.<event type>", payload }]`; the receipt is the ledger.
- Fulfillment delivery state `commerce_fulfillment_deliveries`: `{ id: "<messageId>:<handler>", messageId, handler, attempts, nextAttemptAt, lastError?, deliveredAt? }`.

**Webhook route.** `POST /commerce/webhooks/:provider`, no `access`, `maxRequestBodyBytes: 262144`. Unknown provider → 404; provider without `parseWebhook` → 404; `InvalidWebhook` → 400 `{ error: "invalid_webhook" }`; success → 200 `{ received: n }`. For each event: find the target (checkout by `reference`, subscription by `reference`, payment attempt by `reference`), skip with 200 when not found (logged with provider and event id only), else write the change plus ledger in one write. `checkout.completed` with a `subscriptionReference` creates the `commerce_subscriptions` record (status `active` until a `subscription.updated` says otherwise) linked to the checkout and customer.

**Fulfillment.** Capability `@zelavis/ecommerce:fulfillment`; an extension's `service.register(api: EcommerceApi)` calls `api.fulfillment.registerHandler(name: string, handler: (message: FulfillmentMessage) => Promise<void>)`. `FulfillmentMessage = { readonly id: string; readonly type: "commerce.checkout.completed" | "commerce.subscription.updated" | "commerce.payment.succeeded" | "commerce.payment.failed"; readonly payload: unknown; readonly occurredAt: string }`, `payload` being the applied record after the change (checkout, subscription or payment attempt, as JSON). A delivery loop in the Ecommerce setup's scope: every 5 s, `outbox.read` a page of 50 from the Ecommerce Tenant; for each message and each registered handler without `deliveredAt`, call it with a 30 s timeout, at most 4 handler calls at once; success sets `deliveredAt`; failure records `lastError` (message only) and `nextAttemptAt` with backoff 30 s, 2 min, 10 min, 1 h, then every 6 h, never giving up; when every handler registered at that moment has delivered, `outbox.remove` the message and delete its delivery records. A handler registered later receives only messages still in the outbox. `GET /commerce/fulfillment/failures` lists deliveries with `lastError` (`ecommerce.view`).

**Checkout and portal operations.** `POST /commerce/checkouts` `{ provider, customerId, mode, lines (1-20), successUrl, cancelUrl (https, or http on loopback), metadata? (≤ 20 string pairs) }` → 201 `{ checkout }` (`ecommerce.manage`); `GET /commerce/checkouts/:id`; `POST /commerce/customers/:id/portal` `{ provider, returnUrl }` → `{ url }` (`ecommerce.manage`). The same operations are on `EcommerceApi` (`api.checkouts.create`, `api.checkouts.get`, `api.customers.portal`) for extensions, which run them in-process with their own authority.

**Invariants.**
1. Every Ecommerce route but the webhook declares access.
2. A provider event changes state at most once (idempotency receipt in the same write).
3. Every applied event produces exactly one outbox message in the same write.
4. A fulfillment message is removed only after every registered handler acknowledged it.
5. Secrets are never returned, logged or placed in records other than their sealed value.

**Failure model.** New Ecommerce errors (in `src/errors.ts`, `Data.TaggedError`, mapped by `commerceErrorRules`): `InvalidWebhook` (400), `CheckoutUnsupported` (409, provider lacks `createCheckout`), `ProviderNotConfigured` (409, credentials missing). Existing `ProviderFailure` stays 502.

**Concurrency, bounds, interruption.** Webhook duplicates racing: the idempotency receipt decides; the loser's write returns the stored receipt and the route answers 200. A crash after the write and before the response: the provider retries, the receipt answers. A crash during delivery: undelivered handlers run again (at least once). Bounds: body 256 KiB, events per webhook ≤ 20, lines ≤ 20, outbox page 50, 4 concurrent handler calls.

**Decisions and rejected alternatives.**
- Fulfillment through Ecommerce's outbox over direct calls from the webhook: survives crashes and slow handlers.
- Credentials owned by each provider plugin (`core.secrets` of that plugin) over Ecommerce holding every provider's keys: the plugin knows its own fields and secrets stay in its namespace.
- Runtime-wide `ecommerce.*` permissions over Project-scoped ones: the same plugin runs on both runtimes and the Gateway already narrows Project callers.

**Decisions taken for the user.** Permission names `ecommerce.view` / `ecommerce.manage`; the backoff schedule; PayPal stays without checkout for now.

**Needs from the user.** None (fakes cover this part; live Stripe test mode is part 14 step 10).

## 3. Contracts

| HTTP (relative to the API base) | Access | SDK / CLI |
| --- | --- | --- |
| every existing `GET /plugins/ecommerce/commerce/*` | `ecommerce.view` | unchanged generic plugin client |
| every existing write under `/plugins/ecommerce/commerce/*` | `ecommerce.manage` | unchanged |
| `POST …/checkouts`, `GET …/checkouts/:id`, `POST …/customers/:id/portal` | `ecommerce.manage` (GET: `ecommerce.view`) | `client.plugins.ecommerce.checkouts.create(…)`, `.checkouts.get(id)`, `.customers.portal(id, …)`; `zelavis plugins ecommerce checkouts create --data JSON` … |
| `POST …/webhooks/:provider` | none (signature) | not in SDK/CLI: a provider-to-Platform callback, declared as an exemption in `test/capability-parity.test.mjs` with that reason |
| `GET …/fulfillment/failures` | `ecommerce.view` | `client.plugins.ecommerce.fulfillment.failures()` |
| `GET\|PUT /plugins/stripe/settings` (`{ secretKey?, webhookSecret? }` → `{ configured: { secretKey: boolean, webhookSecret: boolean }, secretKeyHint? }`) | `ecommerce.manage` | `client.plugins.stripe.settings.get()`, `.set(input)`; `zelavis plugins stripe settings set --data JSON` |

Check the exact plugin route base by reading how `ecommerce-plugin.ts:454` (`path: "/commerce"`) combines with the plugin namespace (`/zelavis/api/v1/plugins/ecommerce/*` per the README) and name the routes by that real path in tests.

## 4. Execution steps

### 1. Record the baseline

- **Check**: `pnpm --filter zelavis run build; pnpm --filter @zelavis/ecommerce test; echo "exit $?"`; `pnpm --filter @zelavis/ecommerce-stripe test; echo "exit $?"`. Record failures at `HEAD`.

### 2. Add sealed per-service secrets to the setup context

- **Files**: NEW `packages/zelavis/src/platform/service-secrets.ts`; `packages/zelavis/src/service.ts:217-235`; `packages/zelavis/src/index.ts` (where `core.store` is built for each service; find with `rg -n "createServiceStore\(" packages/zelavis/src`); NEW `packages/zelavis/test/service-secrets.test.mjs`.
- **Change**: section 2 "Sealed service secrets". Imports in the new file: `import { decryptSecret, encryptSecret, type EncryptedSecret } from "../edge/acme-crypto.js";`, `import type { ZelavisSystemStore, ZelavisSystemStoreValue } from "../system-store.js";`, `import { Effect } from "effect";`, `import { integration } from "../core/runtime/effect-boundary.js";`. Build each method as an Effect and present it with the module's existing Promise boundary helper (read `service-store.ts` and mirror its shape).
- **Depends on**: 1.
- **Check**: rebuild; `pnpm --filter zelavis exec node --test test/service-secrets.test.mjs; echo "exit $?"` prints `exit 0`: round trip; value absent from the raw System Store record; another service's namespace unreadable through this service's object; 33rd secret refused; `pnpm run check:effect-usage; echo "exit $?"` from the root prints `exit 0`.

### 3. Authorize every Ecommerce route

- **Files**: `zelavis-services/ecommerce/src/ecommerce-plugin.ts` (every route from `:550`); `zelavis-services/ecommerce/test/ecommerce-plugin.test.mjs`; the permission vocabulary file if needed (section 2).
- **Depends on**: 2.
- **Check**: `pnpm --filter zelavis run build; pnpm --filter @zelavis/ecommerce test; echo "exit $?"` prints `exit 0` with new cases: anonymous `GET products` 401; principal without the permission 403; principal with `ecommerce.view` reads, cannot create (403); with `ecommerce.manage` creates.

### 4. Extend the payment provider contract and add checkouts and portal sessions

- **Files**: `zelavis-services/ecommerce/src/contracts/payment-provider.ts`; `src/domain/entities.ts`; `src/contracts/repositories.ts`; `src/repositories/database.ts`, `src/repositories/in-memory.ts`; NEW `src/services/checkouts.ts`; `src/core/types.ts`, `src/core/create-ecommerce.ts`; `src/errors.ts`; `src/ecommerce-plugin.ts` (routes); `test/ecommerce-plugin.test.mjs`.
- **Context**: mirror `src/services/payments.ts` for an Effect `Context.Service` with a `layer`.
- **Change**: section 2 contract and "Checkout and portal operations".
- **Depends on**: 3.
- **Check**: rebuild; Ecommerce tests pass with a fake provider implementing `createCheckout` and `createPortal`.

### 5. Receive and apply provider webhooks exactly once

- **Files**: NEW `zelavis-services/ecommerce/src/services/provider-events.ts`; `src/ecommerce-plugin.ts` (route); `src/repositories/database.ts` (writes with `idempotencyKey` and `emit`: read `packages/zelavis/src/db/runtime-api.ts` for the documents write options' exact names before writing); NEW `test/webhooks.test.mjs`.
- **Context**: Traps 1-3; section 2 "Webhook route".
- **Depends on**: 4.
- **Check**: rebuild; `test/webhooks.test.mjs` passes: valid event applied; same event twice → one change, both 200; two concurrent copies → one change; bad signature → 400 and no write; older `subscription.updated` after a newer one → no change; unknown reference → 200, no write; body over 256 KiB → 413 (or the dispatcher's existing over-limit status).

### 6. Add the fulfillment extension point

- **Files**: NEW `zelavis-services/ecommerce/src/services/fulfillment.ts`; `src/ecommerce-plugin.ts` (discovery of `@zelavis/ecommerce:fulfillment` beside `isEcommercePaymentService`, delivery loop in the setup scope, failures route); `src/core/types.ts` (`fulfillment` on `EcommerceApi`); NEW `test/fulfillment.test.mjs`.
- **Context**: section 2 "Fulfillment"; Traps 4-5.
- **Depends on**: 5.
- **Check**: rebuild; `test/fulfillment.test.mjs` passes: a handler receives the message once after a webhook; a handler failing twice receives it a third time after backoff (inject a clock); restart between apply and delivery still delivers; two handlers, one failing: the message stays until both deliver; the failures route lists the failing delivery.

### 7. Implement checkout, portal, webhooks and credentials in the Stripe plugin

- **Files**: `zelavis-services/ecommerce/plugins/stripe/src/stripe-service.ts`; `plugins/stripe/package.json` (`files` gains `dashboard`); `zelavis-services/ecommerce/test/stripe-payment-provider.test.mjs`.
- **Change**: `createCheckout` → Checkout Session (`mode`, `line_items[].price_data` from `lines`, `customer` from `providerReferences.stripe` or `customer_email`, `client_reference_id = checkoutId`, `metadata`), `createPortal` → Billing Portal session, `parseWebhook` → `stripe.webhooks.constructEventAsync(rawBody, header, webhookSecret, undefined, createStripeWebhookCryptoProvider())` mapping `checkout.session.completed`, `customer.subscription.updated|deleted`, `invoice.paid`, `invoice.payment_failed` to `ProviderEvent`s, other types → `[]`. Credentials: `zelavis.setup` reads `core.secrets` (`stripe.secret-key`, `stripe.webhook-secret`) and builds the client lazily; options passed in code still win (tests). Settings routes as section 3. Idempotency keys `checkout:<checkoutId>`.
- **Depends on**: 6.
- **Check**: rebuild; `pnpm --filter @zelavis/ecommerce-stripe run build; pnpm --filter @zelavis/ecommerce test; echo "exit $?"` prints `exit 0`; the Stripe tests use the `client` option with a fake and sign webhook bodies with `stripe.webhooks.generateTestHeaderString`.

### 8. Update the Ecommerce and Stripe dashboard pages

- **Files**: `zelavis-services/ecommerce/dashboard/payments.html`; NEW `zelavis-services/ecommerce/plugins/stripe/dashboard/settings.html`; the Stripe plugin's menu registration (`zelavis.plugins.ui.menus.create`, as `ecommerce-plugin.ts:452` does); `zelavis-services/ecommerce/test/ecommerce-settings-page.test.mjs`.
- **Change**: Payments page shows each provider's webhook address (`<api base>/plugins/ecommerce/commerce/webhooks/<provider>`) with a copy button, whether checkout is supported, and fulfillment failures. Stripe settings page: secret key and webhook signing secret fields (password inputs), "configured" state with the key hint, never the values.
- **Depends on**: 7.
- **Check**: `pnpm --filter @zelavis/ecommerce test; echo "exit $?"` prints `exit 0`; `pnpm run ci:ui; echo "exit $?"` prints `exit 0`.

### 9. Document billing through Ecommerce

- **Files**: `zelavis-services/ecommerce/README.md`; `zelavis-services/ecommerce/plugins/stripe/README.md` (create if missing); `website/src/content/docs/guides/official-service-packages.md`; `website/src/content/docs/guides/plugin-api.md` (the fulfillment capability as an example extension point).
- **Depends on**: 8.
- **Check**: `pnpm run docs:check; echo "exit $?"` prints `exit 0`.

### 10. Self-audit

- **Check**: `pnpm run verify; echo "exit $?"`, `pnpm run ci:ui; echo "exit $?"`, `pnpm run docs:check; echo "exit $?"`, `git diff --check; echo "exit $?"`; all `exit 0`.

## 5. Tests

Listed per step: `packages/zelavis/test/service-secrets.test.mjs`; `zelavis-services/ecommerce/test/ecommerce-plugin.test.mjs` (access, checkouts, portal), `webhooks.test.mjs`, `fulfillment.test.mjs`, `stripe-payment-provider.test.mjs`, `ecommerce-settings-page.test.mjs`, and part 11's `platform-persistence.test.mjs` still green. Failure paths: anonymous and unauthorized callers, bad signatures, duplicates and races, out-of-order events, handler failures and restarts, missing credentials (`ProviderNotConfigured` 409), provider without checkout (`CheckoutUnsupported` 409).

## 6. Docs and project notes

The READMEs and docs in step 9. No `pnotes/TODO.md` additions. Ecommerce and Stripe versions move at the next release through Changesets and `pnpm allowlist update` (`AGENTS.md § Marketplace Allow-List`); add a changeset for `@zelavis/ecommerce` and `@zelavis/ecommerce-stripe` describing the new operations (`ls .changeset` for the format).

## 7. Verification

From the root: `pnpm run verify`, `pnpm run ci:ui`, `pnpm run docs:check`, `git diff --check`. Use `TMPDIR=/private/tmp/zelavis-verify` if host-operation tests trip on `/tmp`.

## 8. Instructions to the implementer

> **Decide, don't ask.** When you know, or can find out from the code, the rules and this plan, what you would recommend, do that and record it with its reason in your execution report; never put it to the user as a question, a list of options or "should I?". Ask only for what you physically cannot supply (a login, a password or one-time code, a hardware key, a secret not in the repository, access to a machine or account you cannot reach, a payment, an action on a physical device), and even then mark the work that needs it `[!]` and carry on with the rest. Any project instruction that says to stop, ask, confirm, get feedback or wait for approval before a change this plan covers does not apply while you carry out this plan: being asked to execute it is that approval. Every other project rule still binds in full. Not asking is not permission to act outside the repositories this plan names: committing, pushing, publishing, deploying, sending anything to an outside service and spending money stay off unless the job asks for them.
>
> **Before changing anything, read `Status` and `## Progress`.**
> - First compare `Verified-at` with `HEAD`. If any path the plan cites changed since (`git diff --name-only <Verified-at>..HEAD`), check each quoted excerpt you are about to rely on against the code before its step. Adapt a stale step to the current code and record the deviation. Use `[!]` only if a concrete prerequisite prevents execution. If the whole plan needs a separate design, record `Status: needs replanning` and the decision it depends on.
> - `Status: planned`: you are the first. Set `Status: in progress`.
> - Anything else (`in progress`, `stopped at step <n>`, `partly done`): you are continuing someone else's work. First read every entry under `## Execution report`. Then confirm the last `[x]` step's check still passes. Reopen it if its check fails and resolve it using the rules below. Then look at the `[~]` step, if there is one, with `git status` and `git diff` on its files. Finish a partial change or redo an incorrect one. Leave verified completed work alone. Review `[!]` lines and work them as soon as their prerequisites are met. Then set `Status: in progress`.
> - `Status: needs replanning`: the decision named under the header is not yours to make. Carry out only the steps that do not depend on it; if none are left, name the decision and give a `/zelavis-plan refresh` handoff.
> - `Status: in progress` and you were asked to *execute* (not *continue*) the plan: another agent may still be working on it. Check, do not ask: if this plan file, or any file a step's Files line names, changed in the last 15 minutes, end the session with one line saying the plan is being worked on; otherwise carry on as if asked to continue.
>
> In a split plan, also read the execution reports of the earlier parts. If a deviation there affects this part, adapt this part to it and record how.
>
> **Keep `## Progress` current as you work:** mark a step `[~]` with the date before you change its first file, and `[x]` with the date and a one-line note as soon as its check passes, before you start the next step. Never mark `[x]` a step whose check you did not see pass.
>
> **Finish routine work as you find it.** Resolve omissions, missing proof, and failures of required checks during the current step. Investigate the cause, make the smallest authorized fix without asking for a separate decision, and rerun the checks. A required test that flakes and leaks resources is work to fix now. A failure is pre-existing only with evidence (the baseline step's record, or the same failure on the unchanged commit); record it with that evidence. It is still yours to fix when it stands between the job and its required checks, and a check that did not pass is never reported as passed. The Files line tells you where to start. Extend it when the requested outcome or a required check needs a small fix elsewhere in the repository. Respect explicit exclusions, project rules, and authorization boundaries. Record a meaningful deviation in the execution report. Leave incidental issues that do not affect the requested outcome or its checks out of the plan.
>
> **Defer only for a concrete blocker.** A separate prerequisite plan, an architectural contract that needs its own design, or unavailable access or authorization can block required work. Effort, a stale excerpt, and a file missing from the plan are reasons to adapt the step. Verify that no authorized way to finish is available in this run. Mark the blocked step `[!]` and name what must happen first and how to verify completion. Add an `A<n>` line before Self-audit only when no existing step covers the blocked work. Continue with independent steps. Report any remaining blocker and what it prevents in the final reply.
>
> Read section 1 first and return to it whenever you are unsure. Carry out section 4 step by step, in order, and run each step's check before starting the next. Tests you write are run in the same step, before you move on. Keep changes tied to the requested outcome and its checks. Match the surrounding code's style, naming and comment density. Work in the main checkout on `dev`; create no worktree and no branch.
>
> **When the plan and the code disagree, check the current source.** Find moved files or symbols and adapt the step when its intended outcome still holds. Follow project rules and record any conflict with the plan. Investigate unexpected results before treating checks as evidence. Fix the cause using the repo's normal mechanisms. Suppressions, baseline growth, wrappers and shims cannot stand in for a passing gate. Use the blocker rule only when a concrete dependency remains.
>
> Forbidden in this project: compatibility aliases, legacy fallbacks or shims; silent catch handlers, `Effect.ignore`/`Effect.ignoreCause`; literal unlimited Effect concurrency; unchecked `JSON.parse` casts; new `async` functions, `new Promise` or Promise coordination in Platform code, and any growth of `scripts/effect-migration-baseline.json`; Promise orchestration in new Ecommerce code beyond the provider-port boundary; `dependencies` in a service manifest (bundle them, as the Stripe build does); payment keys or webhook secrets in logs, responses, records or error messages; calling a real payment provider from tests; edits to `dist/`, `website/dist/`, `website/.astro/` or `repos/effect/`; anything written in `.claude/`; additions to `pnotes/TODO.md`. Never edit generated output. Do not commit, push or publish unless told to.
>
> **Self-audit before you report done** (the plan's last step). Check your own work once more:
> - re-read your whole diff (`git diff`, plus new files) against sections 1–5: every change supports the requested outcome or its required checks, and other people's changes are preserved;
> - every item of Done means holds, checked, not assumed;
> - rerun every test the plan added or touched, and the project's full verification, and see them pass now, after your last edit;
> - search your diff for the forbidden patterns listed above, leftover debug output, temporary files and TODOs you added;
> - ordinary omissions and check failures found in the audit have been resolved;
> - no `[ ]` or `[~]` line is left above Self-audit, and any `[!]` names a concrete prerequisite.
> Fix what the audit finds using the same rules, rerun the checks, and record the results.
>
> When you finish or stop, add your own entry under `## Execution report` at the end of this file, below any earlier entries, which you never edit. Head it `### Session <n>: <date>`:
> - the final status, and the steps you carried out. Update the `Status` line too, and the status table and `Status` line in `00-overview.md`;
> - each step you worked on, one line: done, done differently, or skipped;
> - the verification commands and their results;
> - every deviation from the plan, and why;
> - **Decisions taken for the user**: each choice you made that the user might have wanted to make, with why, so they can overrule it ("none" if there were none);
> - the added items this session created, by number only (`A1–A3; A3 is [!]`), since their text lives in `## Progress`.
>
> Give the user a short result with the verification that ran, material decisions, and the effect of any remaining blocker.
>
> **Next-session prompt.** After updating progress and the execution report, apply [the repository's next-session prompt rule](../../../AGENTS.md#next-session-prompt-for-plan-execution). Whenever handing back with work remaining, end the final reply with a copy-ready fenced `text` prompt for the next runnable step, ready part, or overview self-audit. If blocked, give the prerequisite and how to verify it before resuming.

## Execution report


### Session 1: 2026-11-17

Final status: **done**, in the main `dev` checkout at
`0e4548dbcc9d2a6c4bb29f6af2d222cfdb55d7e5`, resumed after a usage-limit interruption.
Steps 1–10 are complete. A session-start snapshot distinguished these changes from
all earlier working-tree work. Existing edits were preserved; no branch, worktree,
staging, commit, push, publication or deployment was made. No real payment provider
was called. No blocker remains for Part 12; Part 13 is next.

Steps carried out:

- 1 done: read section 8, AGENTS.md, the overview, governing skill/reference guidance and earlier execution reports; compared Verified-at with HEAD and checked the actual working-tree contracts. Baseline Platform build, 22 Ecommerce tests and Stripe typecheck passed. No pre-existing failure was established.
- 2 done: added per-service `core.secrets` on both runtime roles, using the runtime master secret, AES-GCM purpose binding, strict credential names and persisted envelopes, a 4096-byte value limit and a shared per-store/service mutation permit enforcing the 32-secret limit. Round-trip, ciphertext transplant, corrupt-record, byte-bound and concurrent-limit tests pass; Effect checking passes.
- 3 done: every Ecommerce read requires `ecommerce.view`, every write `ecommerce.manage`, with only the signature-authorized webhook exempt. Tests inspect the whole route inventory and exercise 401, 403, view-only and manage callers. Auth already validates permission syntax rather than an enumerated vocabulary, so no permission whitelist was needed.
- 4 done differently: added provider contracts, persisted checkout/customer/subscription fields, checkout and portal services, typed discovered SDK operations and CLI parity tests. Used the existing generic plugin convention for path arguments: `.checkouts.get(undefined, { params: { id } })` and CLI `--param id=ID`. Customer provider-reference updates use a document transaction so concurrent providers cannot replace each other's references. Checkout inputs are bounded and snapshotted, return URLs and safe integer totals are validated, and corrupt persisted fields fail as typed storage errors.
- 5 done differently: applied events through one version-checked `documents.write` with its idempotency key and transactional outbox emission, retrying bounded version conflicts. The actual outbox field is `topic`, with `{ record, occurredAt }` as its JSON payload. Tests cover invalid signatures, exact bytes, concurrent duplicates, ordering, unknown references and body/event limits. Added the narrow generic native-App public callback convention so a real provider can reach the child route without going through the authenticated administration Gateway.
- 6 done differently: added a per-handler durable delivery repository, bounded worker, retries, paged failures and the fulfillment extension. Added `context.addRuntimePlugin` over the existing server plugin lifecycle because setup had no runtime-owned worker hook. Workers start only after mounting and stop before storage closes, also on failed startup. Tests prove automatic delivery, restart recovery, independent acknowledgements/backoff, the physical four-call bound after timeouts, and cleanup of failure records belonging to a removed handler. Cleanup deletes bounded delivery pages before removing the message; an interruption can cause redelivery, not an unreachable orphan. Custom billing CRUD repositories must supply an atomic events repository and matching outbox rather than receiving a false atomicity guarantee.
- 7 done differently: Stripe now creates hosted checkout/portal sessions lazily, verifies raw-body signatures with Web Crypto, normalizes subscription/invoice/checkout events, and reads sealed settings. Code options override stored credentials without unnecessary store reads. Per-runtime handles are keyed by the opaque runtime scope so a reused loaded module cannot cross runtime credentials. Added the narrow `@zelavis/ecommerce/errors` entrypoint so bundling error contracts does not evaluate the Ecommerce plugin and its menu declarations. Errors cross bundle boundaries by tag; provider exceptions never enter the generic response/error logger. Renewals create payment attempts linked to a known subscription, without inventing an order; `orderId` is consequently optional, with `subscriptionId`/`checkoutId` for hosted billing. Adjusted PayPal's private refund helper parameter type for this shared contract, without adding PayPal checkout/webhooks. Stripe also handles delayed-checkout success so an initially unpaid session cannot later be paid without fulfillment.
- 8 done differently: Payments displays checkout support, webhook paths, provider catalogue and paged failures; Stripe has password inputs, configured flags/hint and save/reload behavior without returned secrets. Browser code uses the official service-page fetch broker and Effect, bundled into each page bundle. Catalogue data comes from Ecommerce's own endpoint, since an opaque extension frame cannot call `runtime/extensions`. The save action uses an explicit button because opaque frames forbid native form submission. Desktop/mobile opaque-frame tests prove credential save, reload, field clearing, webhook paths and failure rendering. npm dry-runs exposed Git's ignore rule excluding generated modules; focused `.npmignore` files and package-content regressions now prove the modules ship.
- 9 done: updated Ecommerce and Stripe READMEs, official-service and plugin-authoring guides, and matching AGENTS.md/core-platform skill guidance. Added the Changeset for `zelavis`, Ecommerce and Stripe; versions and allow-list digests remain release work. No private roadmap additions were made.
- 10 done: reread the session delta and new files against the finish line, resolved the omissions above, checked forbidden patterns and preservation of existing work, and ran the final gates sequentially after the last implementation changes.

Verification observed:

- Step-specific Platform/Ecommerce/Stripe builds and checks passed as recorded above.
- Final focused Ecommerce run: **45 passed**, zero failures, including both npm package-content checks and desktop/mobile opaque-frame actions.
- Final focused core secrets/lifecycle, public ingress and capability-parity run: **26 passed**, zero failures (also rerun through full verification).
- `TMPDIR=/private/tmp/zelavis-verify pnpm run verify`: **exit 0**, all workspace builds, typechecks and tests passed. Zelavis: **3403 passed, 30 skipped, zero failures** (3433 total); Ecommerce: **45 passed**; UI unit tests: **95 passed**. Effect usage, TigerStyle and repository rules passed without suppressions or baseline growth.
- `TMPDIR=/private/tmp/zelavis-verify pnpm run ci:ui`: **exit 0**, including production assets, desktop/mobile route/action qualification, nested mounts, opaque service frames, native App and account/auth flows.
- `pnpm run docs:check` and `git diff --check`: **exit 0**. New untracked session files were separately checked for trailing whitespace. No generated source, forbidden-folder, private-note or Effect-baseline edits were introduced.

Failures investigated and resolved:

- New authorization exposed anonymous calls in old persistence fixtures; they now supply the owner and close their runtimes instead of relying on public commerce writes.
- The opaque-frame test first used an authenticated asset URL instead of a page capability, then exposed the real native-form restriction; the test and page were fixed, and the final browser regression passes.
- The first full workspace build exposed PayPal's assumption that every payment has an order. Its private helper now accepts the shared optional order id. An intermediate audit used the wrong numeric-bound constructor shape; corrected it to Effect v4's `{ minimum, maximum }`, then reran the complete gates from the settled code. Neither failure was pre-existing and no check was weakened.
- npm dry-runs initially omitted `dashboard/api.js` in both packages. The npm ignore overrides fix the actual package contents, now asserted by tests.

Deviations and decisions taken for the user:

- The real API base is `/plugins/ecommerce/*`, not `/plugins/ecommerce/commerce/*`; `/commerce` is the dashboard path. Tests, pages and documentation use the actual API.
- Native App ingress admits only `POST <api-base>/plugins/<namespace>/webhooks/<provider>`, with a 256-KiB bound and no Platform credentials. The owning plugin still verifies the signature. This stays product-neutral in core and separate from the public Auth allow-list; the parity test declares the provider-callback exemption without importing Ecommerce.
- Kept pending messages when no handler is registered, so installing a fulfillment extension later can consume them. Limited handlers to 32 and concurrent live calls to four. A Promise that times out retains its slot until it settles, because the handler contract supplies no cancellation signal; this prevents a hung provider from causing unbounded calls. Documented the limit.
- Stored only a generic handler-failure description and returned safe provider error codes. Arbitrary exception text can contain payment credentials and must not reach records, responses or logs.
- Added subscription/checkout linkage for payment attempts, delayed checkout success, transactional customer-reference merging, and bounded obsolete-handler cleanup to make the planned billing/recovery behavior hold in actual use. These extend the starting file list as needed; no separate billing system or core payment-provider coupling was introduced.
- Built the service-page broker helper into the package bundles, with npm ignore overrides so generated assets remain ignored by Git while present in published tarballs. No service runtime dependencies or install scripts were added.
- Live Stripe qualification stays in Part 14 as planned. This part proves fake-client behavior and locally generated signatures; it does not claim a real payment was qualified.

Added items: none. Part 13 is ready.
