# Hosting billing, entitlements and self-service Projects

Job: Let a Platform operator sell hosting: define plans, take subscriptions through a payment provider plugin (Stripe first), turn an active subscription into ordinary scoped grants, let customers create Projects within their plan's quota, and suspend (never delete) on lapse.
Date: 2026-11-13
Status: planned
Verified-at: b04fa02d95
Part: 10 of 10. Read 00-overview.md first.

To start:    Execute part 10 in .agents/plans/2026-11-13-accounts-billing-domain-automation/10-hosting-billing-and-entitlements.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-13-accounts-billing-domain-automation/10-hosting-billing-and-entitlements.md. Start with its section 8.

## Progress

- [ ] 1. Confirm parts 2 and 6 and the baseline.
- [ ] 2. Define the payments capability contract and a test provider.
- [ ] 3. Add the Stripe billing plugin with a fake API.
- [ ] 4. Add plans and their managed roles.
- [ ] 5. Add subscriptions, checkout and the customer portal.
- [ ] 6. Add webhooks, the event ledger and lapse handling.
- [ ] 7. Add self-service Project provisioning and its cleanup.
- [ ] 8. Expose the operations over HTTP, SDK and CLI.
- [ ] 9. Add the operator and customer dashboard pages.
- [ ] 10. Document billing.
- [!] 11. Qualify against Stripe test mode. (blocked by: a Stripe test-mode secret key and the Stripe CLI logged in on the qualifying machine, from the user; check: `pnpm --filter @zelavis/billing-stripe run qualify:test-mode` prints `PASS checkout`, `PASS webhook`, `PASS provision`, `PASS lapse` and exits 0)
- [ ] 12. Self-audit.

## 0. Summary and finish line

Customers can sign up (earlier plan) and be granted access to existing Projects, but nothing lets an operator charge for hosting or lets a paying customer create a Project. This part adds a Platform billing subsystem: operator plans (price, interval, Project limit, allowed recipes, Project permissions), subscriptions created through a payment provider's hosted checkout, signed webhooks recorded idempotently, entitlements expressed as a managed custom role (part 6) assigned for each billed Project, self-service Project creation that reserves quota before creating, and lapse handling that stops billed Projects after a grace period and restores access on payment. No card data touches the Platform.

- **In scope**: capability `zelavis/billing:payments`, `@zelavis/billing-stripe` (Checkout, Customer Portal, Products/Prices, webhook signatures), plans, subscriptions, event ledger, entitlement roles, provisioning state machine, Project deletion participant, lapse and resume, notice emails through part 2, HTTP/SDK/CLI, operator and customer dashboard pages, docs, tests, Stripe test-mode qualification.
- **Out of scope**: taxes and invoices beyond the provider's own, refunds and coupons (provider dashboard), metered or per-resource billing, resellers, multiple subscriptions per account, App-level ecommerce (`@zelavis/ecommerce` already exists), domain purchase for customers.
- **Done means**: (a) an owner creates plan `starter` (5 USD/month, 2 Projects, recipe `@zelavis/app`); (b) customer C starts checkout and gets a provider URL; the provider's signed `checkout.session.completed`/`customer.subscription.*` webhooks make C's subscription `active`; replaying a webhook changes nothing; an unsigned one is 400; (c) C creates two Projects through `POST /runtime/billing/projects`; the third is 409 `plan_limit_reached`; C has the plan permissions on exactly those Projects; (d) concurrent creates never exceed the limit; a crash mid-provision is resumed without a second Project; (e) a `past_due` subscription keeps working for 7 days, then C's billed Projects stop and C keeps only view and logs; payment restores the plan role (Projects stay stopped until C starts them); nothing is deleted; (f) deleting a billed Project releases its slot; (g) the Stripe test-mode run passed (step 11); (h) parity, browser, `verify`, `ci:ui`, `docs:check` pass.
- **Supplement**: updated in this run (overview section 0).
- **Sources read**: `AGENTS.md § Core Access-Control Rule` ("Hosting Provider must not create a separate customer permission system"), `§ Platform And App Service Boundary` (Project deletion participants, bounded reconciliation), `§ TigerStyle Adaptation`; parts 2 and 6; files below.

## 1. Context packet

**Glossary.**
- **Plan**: an operator-defined offer with a price and limits.
- **Subscription**: one account's subscription to one plan, mirrored from the provider.
- **Entitlement role**: the managed role `plan-<planId>` in the role catalogue (part 6), whose `projectPermissions` are the plan's; and `billing-suspended` (`projectPermissions: ["project.view", "project.logs.read"]`).
- **Billed Project**: a Project created through billing; listed on the subscription.
- **Provision**: the durable record of one self-service Project creation.

**Governing rules.**
> "Future official modules such as Hosting Provider must not create a separate customer permission system. … The same `/zelavis` shell should render different menus, project lists, and actions from those grants, while endpoints remain the authority layer." `AGENTS.md § Core Access-Control Rule`
>
> "Any new Platform resource keyed by Project identity must register a cleanup participant" `AGENTS.md § Platform And App Service Boundary`
>
> "Never restore all desired-running projects with an unbounded `Promise.all` … Reconciliation must be bounded, asynchronous, idempotent, and safe to retry." `AGENTS.md § Platform And App Service Boundary`

**System today.**
- Project creation route `packages/zelavis/src/index.ts:6201-6260` (`POST /runtime/projects`, `projects.create`, calls `projects!.create({ name, id?, recipeName?, start? })`).
- Project permissions in use: `project.view`, `project.runtime.manage`, `project.settings.manage`, `project.logs.read`, `project.delete`, `project.setup.reveal` (`index.ts` route access), `project.users.manage` (`identity-service.ts:329-331`), `project.domains.view|manage` (`packages/zelavis/src/edge/project-domains.ts:18-19`).
- Deletion participants: list in `packages/zelavis/src/index.ts:7480-7520` (for example `id: "edge-routes"` with `cleanup(project)`).
- Raw request bodies: `packages/zelavis/src/platform/storage.ts:75` reads `request.arrayBuffer()` in a route; read that route's definition to see how it avoids JSON parsing, and mirror it for webhooks.
- Part 6 handover: role catalogue repository and `RoleDefinition` (`packages/zelavis/src/app/identity/domain/roles.ts`), `roleAssignments` on accounts, role service with delegation checks. Billing writes managed roles and assignments as a trusted system writer (section 2).
- Part 2 handover: `EmailOutbox` (kind `"billing"` exists in `EmailKind`).
- Plugin pattern: parts 7 and 9 (`defineDnsProviders`, `defineRegistrars`, encrypted connection stores, `collect…` discovery).

**Pattern to mirror.** Part 9's durable order state machine for provisions; part 7's encrypted connection store; the earlier enrollment slot reservation (`packages/zelavis/src/app/identity/services/registration-service.ts:268-330`) for quota reservation by CAS.

**Traps.**
- Trusting the checkout redirect: activation comes only from a signed webhook (or a server-side fetch of the session), never from the browser landing on `success_url`.
- Parsing the webhook body as JSON before verifying: the signature covers the exact bytes.
- Processing webhooks in arrival order: providers retry and reorder; keep `providerUpdatedAt` and ignore older state.
- Counting a customer's Projects by listing all Projects: the subscription record holds its billed Project ids.
- Deleting customer data on non-payment: suspension only stops and narrows access.
- Letting the operator's own `projects.create` path bypass limits for customers: customers never get `projects.create`; they use the billing route.

## 2. Design

**Authority and scope.** Platform-only subsystem. Operator: NEW `system.billing.manage` (plans, connection, subscription overrides) and `system.billing.view` (list subscriptions), system scope. Customer: any authenticated human principal may read plans and its own subscription, start checkout, open the portal, and (with an active subscription) create billed Projects; the subscription record is the authority for quota. Billing writes entitlement roles and assignments through the identity services as a system actor (a NEW internal `IdentityApi.system` writer that skips delegation checks; not reachable from HTTP), recorded as security events `billing.entitlement.changed`.

**Capability contract** (NEW `packages/zelavis/src/platform/billing/payments-provider.ts`, exported as `zelavis/billing/payments-provider`):

```ts
export const PAYMENTS_CAPABILITY = "zelavis/billing:payments";
export interface BillingPlanPrice { readonly amount: number /* minor units */; readonly currency: string /* ISO 4217 lowercase */; readonly interval: "month" | "year" }
export type BillingProviderEvent =
  | { readonly id: string; readonly type: "checkout.completed"; readonly accountId: string; readonly customerRef: string; readonly subscriptionRef: string; readonly occurredAt: string }
  | { readonly id: string; readonly type: "subscription.updated"; readonly subscriptionRef: string; readonly customerRef: string; readonly status: "active" | "trialing" | "past_due" | "unpaid" | "canceled" | "incomplete"; readonly priceRef: string; readonly currentPeriodEnd: string; readonly cancelAtPeriodEnd: boolean; readonly occurredAt: string }
  | { readonly id: string; readonly type: "ignored"; readonly occurredAt: string };
export interface BillingProviderClient {
  ensurePrice(input: { planId: string; title: string; price: BillingPlanPrice; existingRef?: string }): Promise<{ priceRef: string }>;
  createCheckout(input: { priceRef: string; accountId: string; email?: string; customerRef?: string; successUrl: string; cancelUrl: string; idempotencyKey: string }): Promise<{ url: string; sessionRef: string }>;
  createPortal(input: { customerRef: string; returnUrl: string }): Promise<{ url: string }>;
  subscription(subscriptionRef: string): Promise<Extract<BillingProviderEvent, { type: "subscription.updated" }>>;
  /** Verifies the signature over the exact bytes; returns undefined when invalid. */
  verifyWebhook(body: Uint8Array, headers: Headers, nowMs: number): Promise<BillingProviderEvent | undefined>;
}
export interface BillingProviderDefinition {
  readonly name: string; readonly title: string;
  readonly credentials: readonly { name: string; label: string; secret: boolean }[];
  readonly tokenGuidance: string;
  createClient(credentials: Readonly<Record<string, string>>, context: { readonly fetch: typeof fetch; readonly signal?: AbortSignal }): BillingProviderClient;
}
export function defineBillingProviders(name: string, providers: readonly BillingProviderDefinition[]): { name: string; kind: "plugin"; capabilities: readonly string[]; service: { billingProviders: readonly BillingProviderDefinition[] } };
```

**Persistence** (System Store, Platform):
- `billing.connection` / `current`: provider name, encrypted credentials, revision.
- `billing.plans` / `catalogue`: `{ schemaVersion: 1, revision, plans: BillingPlan[] /* ≤ 20 */ }`.
- `billing.subscriptions` / `<accountId>`: `BillingSubscription` (one per account), CAS on `updatedAt`.
- `billing.subscription-refs` / `<subscriptionRef>` → accountId (`setIfAbsent` at checkout completion).
- `billing.provisions` / `<accountId>:<provisionId>`: `{ state: "reserved" | "created" | "granted" | "released", projectId, name, recipeName, createdAt, updatedAt }`.
- `billing.events` / `<provider>:<eventId>`: `{ receivedAt }` with `setIfAbsent`; swept after 30 days, ≤ 500 per sweep.

**Subscription state.** `pending` (checkout started) → `active` (provider `active`/`trialing`) ⇄ `past_due` (provider `past_due`/`unpaid`, `graceEndsAt = first past_due time + 7 days`) → `suspended` (grace passed, or `canceled` after `currentPeriodEnd`) → `active` (payment). Fields `providerUpdatedAt` (ignore older events), `billedProjects: string[]` (≤ plan limit, ≤ 1000), `reserved: number`.

**Entitlements.** On `active`: role catalogue holds `plan-<planId>` (written when the plan is saved) and the account's assignment `{ roleId: "plan-<planId>", projectIds: billedProjects }`. On `suspended`: assignment becomes `{ roleId: "billing-suspended", projectIds }` and each billed Project is stopped (through the Project manager's stop, bounded concurrency 4). On resume: back to the plan role; no automatic start. Plan change (portal upgrade): new `priceRef` maps to another plan; assignment role switches; if over the new limit, creation is refused but nothing is removed.

**Provisioning.** `POST /runtime/billing/projects { name, recipeName? }`: (1) CAS on the subscription: require `active`, `billedProjects.length + reserved < limit`, recipe allowed; `reserved += 1`; write provision `reserved` with a generated `projectId`; (2) `projects.create({ id: projectId, name, recipeName, start: true })`; (3) provision `created`; (4) subscription CAS: `reserved -= 1`, append `projectId`, then update the assignment; provision `granted`. Reconciliation (every 60 s, ≤ 20 provisions per pass): `reserved` with no Project after 10 minutes → create (idempotent by id) or release; `created` → finish step 4. Deletion participant `billing-provisions`: remove the Project id from the owning subscription and its assignment, mark the provision `released`.

**Webhooks.** `POST /runtime/billing/webhooks/:provider` public, raw body ≤ 64 KiB; `verifyWebhook`; invalid → 400 `invalid_webhook`; ledger `setIfAbsent` → duplicate → 200 `{ duplicate: true }`; apply; 200. Apply failures after the ledger write mark the ledger entry `failed` and answer 500 so the provider retries; a retry re-applies (application is idempotent by `providerUpdatedAt`).

**Invariants.**
1. `billedProjects.length + reserved ≤ plan.limits.projects` at every committed subscription state.
2. A customer's authority on a billed Project comes only from the entitlement role assignment.
3. Each provider event is applied at most once per ledger entry and never moves state backwards in provider time.
4. No billing transition deletes a Project or its data.
5. Provider credentials are encrypted, never returned or logged.

**Failure model.** NEW `BillingError` codes: 400 `invalid_billing_request`, 400 `invalid_webhook`, 402 `subscription_inactive`, 404 `plan_not_found`, 409 `plan_limit_reached`, 409 `recipe_not_in_plan`, 409 `billing_revision_conflict`, 429 `billing_busy`, 502 `billing_provider_failed`, 503 `billing_unavailable` (no connection or plugin).

**Concurrency, bounds, interruption.** All subscription changes are CAS with retry (≤ 5); provider calls 15 s timeout, ≤ 4 in flight; reconciliation bounded per pass; Project stops bounded to 4 in flight. Crash points are covered by provisions, the ledger and reconciliation.

**Decisions and rejected alternatives.** Hosted checkout and portal over custom card forms (no card data, no PCI scope). Entitlements as managed roles over new grant types (one permission system). Suspension over deletion. One subscription per account (simplest correct model).

**Decisions taken for the user.** 7-day grace; plan permissions default `["project.view", "project.runtime.manage", "project.settings.manage", "project.users.manage", "project.domains.manage", "project.logs.read", "project.delete"]`; customers' billed Projects start on creation; notice emails on activation, past-due and suspension when email is configured.

**Needs from the user.** Stripe test-mode secret key and Stripe CLI login (blocks step 11 only).

## 3. Contracts

```ts
export interface BillingPlan {
  readonly id: string;                       // ^[a-z][a-z0-9-]{1,31}$
  readonly title: string; readonly description?: string;
  readonly price: BillingPlanPrice;
  readonly limits: { readonly projects: number /* 1-1000 */; readonly recipes?: readonly string[] /* ≤ 20 recipe names; absent = any */ };
  readonly projectPermissions: readonly string[]; // ≤ 30
  readonly active: boolean;                  // inactive plans accept no new checkouts
  readonly providerPriceRef?: string;
}
export interface BillingSubscription {
  readonly accountId: string; readonly planId: string;
  readonly state: "pending" | "active" | "past_due" | "suspended";
  readonly customerRef?: string; readonly subscriptionRef?: string;
  readonly currentPeriodEnd?: string; readonly graceEndsAt?: string; readonly cancelAtPeriodEnd?: boolean;
  readonly billedProjects: readonly string[]; readonly reserved: number;
  readonly providerUpdatedAt?: string; readonly updatedAt: string;
}
```

| HTTP (relative to the API base) | Access | SDK | CLI (`--json`) |
| --- | --- | --- | --- |
| `GET /runtime/billing/providers` | `system.billing.view` | `client.billing.providers()` | `zelavis billing providers` |
| `GET\|PUT\|DELETE /runtime/billing/connection` | `system.billing.manage` | `client.billing.connection()`, `.connect(input)`, `.disconnect()` | `zelavis billing connection`, `connect --data JSON`, `disconnect` |
| `GET /runtime/billing/plans` | authenticated | `client.billing.plans()` | `zelavis billing plans` |
| `PUT /runtime/billing/plans/:planId` `{ ...BillingPlan without providerPriceRef, expectedRevision }` | `system.billing.manage` | `client.billing.savePlan(id, input)` | `zelavis billing save-plan PLAN --data JSON` |
| `GET /runtime/billing/subscription` (own) | authenticated | `client.billing.subscription()` | `zelavis billing subscription` |
| `GET /runtime/billing/subscriptions?limit&after` | `system.billing.view` | `client.billing.subscriptions(page?)` | `zelavis billing subscriptions` |
| `POST /runtime/billing/checkout` `{ planId, idempotencyKey }` → `{ url }` | authenticated human | `client.billing.checkout(planId, key)` | `zelavis billing checkout PLAN` |
| `POST /runtime/billing/portal` → `{ url }` | authenticated, own subscription | `client.billing.portal()` | `zelavis billing portal` |
| `POST /runtime/billing/projects` `{ name, recipeName? }` → 201 `{ project }` | authenticated, active subscription | `client.billing.createProject(input)` | `zelavis billing create-project --data JSON` |
| `POST /runtime/billing/webhooks/:provider` | public (signature) | not in SDK or CLI (parity exemption with reason: provider-only callback) | — |

Add the webhook route to the parity test's exemptions with its reason (`packages/zelavis/test/capability-parity.test.mjs`). Success and cancel URLs are built from the Platform's configured public base (part 2 `linkBaseUrl`, or the Edge Platform hostname), never from the request. Dashboard routes NEW `/server/billing` (operator) and `/billing` (customer).

**Plugin package** `zelavis-services/billing-stripe` (NEW): `"name": "@zelavis/billing-stripe"`, `"zelavis": { "kind": "plugin", "capabilities": ["zelavis/billing:payments"], "namespace": "stripeBilling" }`. Not `stripe`: `@zelavis/ecommerce-stripe` already owns that namespace (`zelavis-services/ecommerce/plugins/stripe/package.json:14`), and namespaces are unique per runtime. Credentials `secretKey` (`sk_test_`/`sk_live_` prefix shown as mode), `webhookSecret` (`whsec_`). API `https://api.stripe.com/v1`, form-encoded, `Authorization: Bearer`, `Idempotency-Key` on creates: `POST /products`, `POST /prices` (`unit_amount`, `currency`, `recurring[interval]`, `product`), `POST /checkout/sessions` (`mode=subscription`, `line_items[0][price]`, `line_items[0][quantity]=1`, `client_reference_id`, `customer` or `customer_email`, `success_url`, `cancel_url`, `subscription_data[metadata][zelavis_account]`), `POST /billing_portal/sessions` (`customer`, `return_url`), `GET /subscriptions/:id`. Webhook header `Stripe-Signature: t=<ts>,v1=<hex>`; HMAC-SHA256 over `<ts>.<raw body>` with the webhook secret; tolerance 300 s; constant-time compare. Events: `checkout.session.completed`, `customer.subscription.created|updated|deleted`; others → `ignored`. Verify field names against Stripe's API reference during step 3 and record differences.

## 4. Execution steps

### 1. Confirm parts 2 and 6 and the baseline

- **Files**: none.
- **Change**: `rg -n "interface RoleDefinition" packages/zelavis/src/app/identity` and `rg -n "\"billing\"" packages/zelavis/src/app/email/contracts.ts` find the handover.
- **Depends on**: parts 2, 6 (and 7-9 landed).
- **Check**: build; `pnpm --filter zelavis exec node --test --test-reporter=dot test/identity-roles.test.mjs test/email-service.test.mjs test/capability-parity.test.mjs; echo "exit $?"` prints `exit 0`.

### 2. Define the payments capability contract and a test provider

- **Files**: NEW `packages/zelavis/src/platform/billing/payments-provider.ts`; `packages/zelavis/package.json` exports (`"./billing/payments-provider"`); `packages/zelavis/src/core/service/definition.ts:75-77`; `packages/zelavis/src/index.ts` (`collectBillingProviders`); NEW `packages/zelavis/test/_billing-provider.mjs` (a test plugin whose client records calls, signs webhooks with HMAC and lets tests emit events).
- **Depends on**: 1.
- **Check**: build; `pnpm run typecheck; echo "exit $?"` prints `exit 0`.

### 3. Add the Stripe billing plugin with a fake API

- **Files**: NEW `zelavis-services/billing-stripe/{package.json,tsconfig.json,README.md,src/index.ts,src/stripe-billing.ts,test/stripe-billing.test.mjs,scripts/qualify-test-mode.mjs}`.
- **Change**: section 3; refuse `sk_live_` keys unless the connection sets `live: true` explicitly (field in credentials); tests with an injected `fetch` and known-answer signatures (compute the expected HMAC in the test with `node:crypto`).
- **Depends on**: 2.
- **Check**: `pnpm install; pnpm --filter @zelavis/billing-stripe run build; pnpm --filter @zelavis/billing-stripe test; echo "exit $?"` prints `exit 0`.

### 4. Add plans and their managed roles

- **Files**: NEW `packages/zelavis/src/platform/billing/plans.ts`; the identity system writer (NEW `IdentityApi.system.putManagedRole(def)` / `.setManagedAssignment(accountId, assignment)` in `packages/zelavis/src/app/identity/services/role-service.ts` and `account-service.ts`, with security events); NEW `packages/zelavis/test/billing.test.mjs`.
- **Change**: saving a plan calls `ensurePrice` (when connected) and writes `plan-<id>`; `billing-suspended` is written at subsystem start if absent. Managed roles carry `managed: "billing"` (NEW optional field on `RoleDefinition`) and the role routes refuse to edit or delete them (409 `role_managed`).
- **Depends on**: 3.
- **Check**: rebuild; `pnpm --filter zelavis exec node --test test/billing.test.mjs; echo "exit $?"` prints `exit 0`.

### 5. Add subscriptions, checkout and the customer portal

- **Files**: NEW `packages/zelavis/src/platform/billing/subscriptions.ts`; `test/billing.test.mjs`.
- **Change**: checkout creates or reuses a `pending` subscription, calls `createCheckout` with the idempotency key; portal requires `customerRef`.
- **Depends on**: 4.
- **Check**: rebuild; checkout cases pass.

### 6. Add webhooks, the event ledger and lapse handling

- **Files**: NEW `packages/zelavis/src/platform/billing/webhooks.ts`, `packages/zelavis/src/platform/billing/reconcile.ts`; `packages/zelavis/src/index.ts` (fork reconciliation in the runtime scope, Platform role); `test/billing.test.mjs`.
- **Depends on**: 5.
- **Check**: rebuild; webhook and lapse cases pass.

### 7. Add self-service Project provisioning and its cleanup

- **Files**: NEW `packages/zelavis/src/platform/billing/provisioning.ts`; `packages/zelavis/src/index.ts` (deletion participant `billing-provisions` beside `edge-routes` at `:7512`); `test/billing.test.mjs`.
- **Depends on**: 6.
- **Check**: rebuild; provisioning cases pass.

### 8. Expose the operations over HTTP, SDK and CLI

- **Files**: NEW `packages/zelavis/src/platform/billing/routes.ts` (mounted where Platform runtime routes are assembled; find where `createProjectDomainRoutes` from `platform/project-domain-routes.ts` is mounted and mount beside it); `packages/zelavis/src/sdk/fetch.ts` (NEW `billing` client); NEW `packages/zelavis/src/cli/billing-operations.ts`; `packages/zelavis/src/cli/commands.ts`; `packages/zelavis/test/capability-parity.test.mjs` (webhook exemption).
- **Depends on**: 7.
- **Check**: rebuild; `pnpm --filter zelavis exec node --test test/capability-parity.test.mjs test/billing.test.mjs; echo "exit $?"` prints `exit 0`.

### 9. Add the operator and customer dashboard pages

- **Files**: NEW `packages/zelavis/services/zelavis-ui/app/billing-pages.ts`; `app/screens.ts` (routes), `app/dashboard-routes.ts` (`/server/billing`, `/billing`), `app/navigation-menu.ts` (Server → Billing for `system.billing.view`; a Billing entry for signed-in humans), `app/projects-pages.ts` (customers with an active subscription see "New Project" posting to the billing route, with remaining quota); `scripts/test-route-parity.mjs`.
- **Change**: operator: connect provider (test/live badge), plans editor with revision CAS, subscriptions table. Customer: plans with prices, Subscribe (redirect to provider URL), status, Manage billing (portal), quota. Checkout return page `/billing?checkout=success` shows "Waiting for payment confirmation" and polls `GET /runtime/billing/subscription` every 2 s up to 60 s.
- **Depends on**: 8.
- **Check**: `pnpm --filter @zelavis/ui typecheck; echo "exit $?"`, `pnpm --filter @zelavis/ui test; echo "exit $?"`, `pnpm run ci:ui; echo "exit $?"`; all `exit 0` (browser run uses the test provider plugin; the test emits the signed webhook).

### 10. Document billing

- **Files**: NEW `website/src/content/docs/guides/hosting-billing.md`; `website/src/content/docs/architecture/access-control.md` (entitlement roles); `website/src/content/docs/api/platform-operations.md`; plugin README.
- **Change**: plans, checkout flow, webhook setup (endpoint URL, signing secret), entitlements, quota, grace and suspension, nothing deleted, test vs live keys, what is not supported.
- **Depends on**: 9.
- **Check**: `pnpm run docs:check; echo "exit $?"` prints `exit 0`.

### 11. Qualify against Stripe test mode

- **Files**: `zelavis-services/billing-stripe/scripts/qualify-test-mode.mjs` (from step 3).
- **Change**: start a local Platform, connect with `STRIPE_TEST_SECRET_KEY` from the environment, run `stripe listen --forward-to <local webhook URL> --print-secret` to obtain the webhook secret, create a plan, start checkout as a customer, and complete Stripe's hosted Checkout page in Playwright chromium with Stripe's published test card `4242 4242 4242 4242` (any future expiry, any CVC; test mode only), so the real `checkout.session.completed` and `customer.subscription.created` events carry this account's `client_reference_id`; wait for `active`, provision one Project, then `stripe subscriptions cancel` (test mode) and advance the injected clock past grace to see suspension.
- **Depends on**: 10 and the user's Stripe test key and CLI login.
- **Check**: `STRIPE_TEST_SECRET_KEY=… pnpm --filter @zelavis/billing-stripe run qualify:test-mode; echo "exit $?"` prints the four `PASS` lines and `exit 0`. Record the run (no keys) in the execution report.

### 12. Self-audit

- **Check**: `pnpm run verify; echo "exit $?"`, `pnpm run ci:ui; echo "exit $?"`, `git diff --check; echo "exit $?"`; all `exit 0`. With step 11 still `[!]`, set `Status: partly done`.

## 5. Tests

`zelavis-services/billing-stripe/test/stripe-billing.test.mjs`: form encoding of nested fields; `Idempotency-Key` sent on creates; valid signature accepted, tampered body or old timestamp refused; event mapping for the three event types; `sk_live_` refused without `live: true`.

`packages/zelavis/test/billing.test.mjs` (Platform via `./_runtime.mjs`, test provider from `_billing-provider.mjs`, injected clock):
- Plans: owner saves `starter`; customer 403 on save; revision conflict 409; `plan-starter` role exists and cannot be edited through role routes (409 `role_managed`).
- Checkout: customer gets a URL; same idempotency key → same URL; inactive plan → 404 `plan_not_found`.
- Webhook: signed `checkout.completed` then `subscription.updated active` → `active`; same event again → `duplicate: true`, state unchanged; unsigned → 400; an older `subscription.updated past_due` after a newer `active` → ignored.
- Provisioning: two creates succeed, third 409 `plan_limit_reached`; 8 concurrent creates with limit 2 → exactly 2 Projects; recipe outside plan → 409; customer has plan permissions on exactly the billed Projects; `projects.create` still 403 for the customer.
- Crash: stop the runtime after `projects.create` and before `granted` (inject a failing assignment write once); restart; reconciliation grants without creating a second Project.
- Lapse: `past_due` → still active access for 7 days; after `graceEndsAt` the Projects are stopped and the customer can view and read logs but not start (`project.runtime.manage` 403); `active` again → plan role restored, Projects stay stopped.
- Deletion: customer deletes a billed Project → slot freed; a new create succeeds.
- Credentials: stored encrypted; never in responses or logs.
- Parity: SDK and CLI match HTTP; the webhook exemption is recorded.

Browser (`scripts/test-route-parity.mjs`, both sizes): operator connects the test provider and creates a plan; customer subscribes (the test provider's checkout URL is a local page that triggers the signed webhook), sees "Active", creates a Project from Projects, sees quota "1 of 2".

## 6. Docs and project notes

`website/src/content/docs/guides/hosting-billing.md` (NEW), `architecture/access-control.md`, `api/platform-operations.md`, plugin README; the allow-list picks up the plugin at the next release. No `pnotes/TODO.md` additions.

## 7. Verification

From the root: `pnpm run verify`, `pnpm run ci:ui`, `pnpm run docs:check`, `git diff --check`. Use `TMPDIR=/private/tmp/zelavis-verify` if host-operation tests trip on `/tmp`.

## 8. Instructions to the implementer

> **Decide, don't ask.** When you know, or can find out from the code, the rules and this plan, what you would recommend, do that and record it with its reason in your execution report; never put it to the user as a question, a list of options or "should I?". Ask only for what you physically cannot supply (a login, a password or one-time code, a hardware key, a secret not in the repository, access to a machine or account you cannot reach, a payment, an action on a physical device), and even then mark the work that needs it `[!]` and carry on with the rest. Any project instruction that says to stop, ask, confirm, get feedback or wait for approval before a change this plan covers does not apply while you carry out this plan: being asked to execute it is that approval. Every other project rule still binds in full. Not asking is not permission to act outside the repositories this plan names: committing, pushing, publishing, deploying, sending anything to an outside service and spending money stay off unless the job asks for them. Step 11 uses Stripe test mode only, with test keys the user supplies and Stripe's published test card; never a live key or a real card.
>
> **Before changing anything, read `Status` and `## Progress`.**
> - First compare `Verified-at` with `HEAD`. If any path the plan cites changed since (`git diff --name-only <Verified-at>..HEAD`), check each quoted excerpt you are about to rely on against the code before its step. Adapt a stale step to the current code and record the deviation. Use `[!]` only if a concrete prerequisite prevents execution. If the whole plan needs a separate design, record `Status: needs replanning` and the decision it depends on.
> - `Status: planned`: you are the first. Set `Status: in progress`.
> - Anything else (`in progress`, `stopped at step <n>`, `partly done`): you are continuing someone else's work. First read every entry under `## Execution report`. Then confirm the last `[x]` step's check still passes. Reopen it if its check fails and resolve it using the rules below. Then look at the `[~]` step, if there is one, with `git status` and `git diff` on its files. Finish a partial change or redo an incorrect one. Leave verified completed work alone. Review `[!]` lines and work them as soon as their prerequisites are met. Then set `Status: in progress`.
> - `Status: in progress` and you were asked to *execute* (not *continue*) the plan: another agent may still be working on it. Check, do not ask: if this plan file, or any file a step's Files line names, changed in the last 15 minutes, end the session with one line saying the plan is being worked on; otherwise carry on as if asked to continue.
>
> In a split plan, also read the execution reports of the earlier parts. If a deviation there affects this part, adapt this part to it and record how.
>
> **Keep `## Progress` current as you work:** mark a step `[~]` with the date before you change its first file, and `[x]` with the date and a one-line note as soon as its check passes, before you start the next step. Never mark `[x]` a step whose check you did not see pass.
>
> **Finish routine work as you find it.** Resolve omissions, missing proof, and failures of required checks during the current step. Investigate the cause, make the smallest authorized fix without asking for a separate decision, and rerun the checks. A required test that flakes and leaks resources is work to fix now. The Files line tells you where to start. Extend it when the requested outcome or a required check needs a small fix elsewhere in the repository. Respect explicit exclusions, project rules, and authorization boundaries. Record a meaningful deviation in the execution report. Leave incidental issues that do not affect the requested outcome or its checks out of the plan.
>
> **Defer only for a concrete blocker.** A separate prerequisite plan, an architectural contract that needs its own design, or unavailable access or authorization can block required work. Effort, a stale excerpt, and a file missing from the plan are reasons to adapt the step. Verify that no authorized way to finish is available in this run. Mark the blocked step `[!]` and name what must happen first and how to verify completion. Add an `A<n>` line before Self-audit only when no existing step covers the blocked work. Continue with independent steps. Report any remaining blocker and what it prevents in the final reply.
>
> Read section 1 first and return to it whenever you are unsure. Carry out section 4 step by step, in order, and run each step's check before starting the next. Tests you write are run in the same step, before you move on. Keep changes tied to the requested outcome and its checks. Match the surrounding code's style, naming and comment density. Work in the main checkout on `dev`; create no worktree and no branch.
>
> **When the plan and the code disagree, check the current source.** Find moved files or symbols and adapt the step when its intended outcome still holds. Follow project rules and record any conflict with the plan. Investigate unexpected results before treating checks as evidence. Fix the cause using the repo's normal mechanisms. Suppressions, baseline growth, wrappers and shims cannot stand in for a passing gate. Use the blocker rule only when a concrete dependency remains.
>
> Forbidden in this project: compatibility aliases, legacy fallbacks or shims; silent catch handlers, `Effect.ignore`/`Effect.ignoreCause`; literal unlimited Effect concurrency; unchecked `JSON.parse` casts; new `async` functions, `new Promise` or Promise coordination in Platform code, and any growth of `scripts/effect-migration-baseline.json`; `node:` imports outside `src/adapters` (and the CLI); React for a dashboard page; edits to `dist/`, `website/dist/`, `website/.astro/` or `repos/effect/`; anything written in `.claude/`; additions to `pnotes/TODO.md`; provider keys or webhook secrets in logs, responses or files; card data anywhere in Zelavis; deleting a Project or its data from billing code; giving customers `projects.create`. Never edit generated output. Do not commit, push or publish unless told to.
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

## Execution report
