# Hosting Provider service
Job: Build `@zelavis/hosting` as its own officially maintained service in `zelavis-services/hosting`, installed from the Marketplace and requiring `@zelavis/ecommerce`: plan creation, billing through Ecommerce, customers who are ordinary Zelavis principals, self-service Projects within their plan's limit, and suspension (never deletion) when payment lapses.
Date: 2026-11-13
Status: planned
Verified-at: b04fa02d95
Part: 14 of 14. Read 00-overview.md first.

To start:    Execute part 14 in .agents/plans/2026-11-13-accounts-billing-domain-automation/14-hosting-provider.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-13-accounts-billing-domain-automation/14-hosting-provider.md. Start with its section 8.

## Progress

- [ ] 1. Confirm the handovers from parts 6, 11, 12 and 13.
- [ ] 2. Scaffold the `@zelavis/hosting` package.
- [ ] 3. Add Hosting settings.
- [ ] 4. Add plans and their roles.
- [ ] 5. Add checkout, subscriptions and the fulfillment handler.
- [ ] 6. Add self-service Projects within the plan limit.
- [ ] 7. Add grace, suspension and resume.
- [ ] 8. Add the operator and customer pages.
- [ ] 9. Document the Hosting Provider service.
- [!] 10. Qualify against Stripe test mode. (blocked by: a Stripe test-mode secret key in `STRIPE_TEST_SECRET_KEY` and the Stripe CLI logged in (`stripe login`) on the machine that runs it; check: `pnpm release:qualify:hosting` prints `PASS subscribe`, `PASS project`, `PASS limit`, `PASS suspend` and exits 0)
- [ ] 11. Self-audit.

## 0. Summary and finish line

This is the WHMCS-style layer: a service an operator installs when they want to sell hosting, the same for Zelavis Cloud and for any hosting company. It owns plans, the customer's subscription to a plan, Project quotas and access; it bills through Ecommerce (part 12), so it contains no payment-provider code. It is an ordinary Marketplace service (extension scope, its own release cycle in `zelavis-services/`), and it acts on the Platform only through its own service principal, approved by the operator at install (part 13). Turning hosting on is installing it; turning it off is disabling it.

- **In scope**: the package, its manifest (Marketplace entry with the operator-facing explanation, extension of Ecommerce, principal permissions); settings; plans as roles (part 6); checkout and portal through Ecommerce; subscription state from Ecommerce fulfillment events; self-service Projects with reservations and reconciliation; grace and suspension; operator and customer pages; docs; a live Stripe test-mode run.
- **Out of scope**: domain resale to customers (a paid order whose registration then fails needs an automatic refund, and a bought domain needs a DNS zone created at the provider; both are separate designs, so customers bring their own domains through the TXT flow or use hosted subdomains from part 7); resellers and delegated Project Platforms; taxes, invoices as documents, coupons, metered usage; selling whole managed Platforms; first-class dashboard placement (as an installed service its menus appear under the Platform's Extensions entry and its pages are framed, `AGENTS.md § Platform And App Service Boundary`).
- **Done means**: (a) installing `@zelavis/hosting` without Ecommerce is refused with the existing "extends @zelavis/ecommerce, which is not installed" message; with Ecommerce it asks for approval of its permissions (part 13) and installs once approved; (b) disabling Ecommerce while Hosting is installed is refused (part 13); (c) the operator saves a plan and a role `hosting-plan-<id>` exists with the plan's Project permissions; (d) a signed-in customer starts checkout, and once the provider's signed events arrive through Ecommerce their subscription is `active`; (e) they create Projects up to the plan limit, the next is 409 `plan_limit_reached`, eight concurrent creates with limit 2 yield exactly 2 Projects, and they hold the plan's permissions on exactly those Projects; (f) a lapse keeps access for the grace period, then stops the Projects and narrows access to view and logs, and payment restores the plan role without starting anything; nothing is deleted; (g) a customer who deletes a billed Project frees its slot within a reconciliation pass; (h) the Stripe test-mode run passed (step 10, `[!]` until the user supplies the key); (i) the package's tests, `verify`, `ci:ui`, `docs:check` pass.
- **Owner decision (2026-11-13, this conversation)**: "@zelavis/hosting can be its own service with the hosting plan creation and other features like billing which requires zelavis ecommerce." Cloud capacity and autoscaling are core (part 10); Hosting is not.
- **Supplement**: updated in this run (overview section 0).
- **Sources read**: `AGENTS.md § Core Access-Control Rule`, `§ Platform And App Service Boundary`, `§ Marketplace Allow-List`, `§ Endpoint-Backed Capability Rule`, `§ Repo Structure` (`zelavis-services/*`); parts 6, 11, 12, 13; files below.

## 1. Context packet

**Glossary.**
- **Plan**: an operator-defined offer: price, interval, Project limit, allowed recipes, Project permissions.
- **Hosting subscription**: one customer's subscription to one plan, mirrored from Ecommerce's `BillingSubscription`.
- **Billed Project**: a Project created through Hosting, listed on the subscription.
- **Provision**: the durable record of one self-service Project creation.
- **Hosting principal**: the service account part 13 creates for `@zelavis/hosting` from its manifest request.

**Governing rules.**
- R1 > "Future official modules such as Hosting Provider must not create a separate customer permission system. Customers, resellers, operators, and owners are Zelavis principals with system, project, or service-scoped grants." `AGENTS.md § Core Access-Control Rule`
- R2 > "`zelavis-services/*` contains the officially maintained optional services … They are published to npm on their own release cycle and are not bundled with the Platform." `AGENTS.md § Repo Structure`
- R3 > "`zelavis` and `effect` are host-provided … Every other dependency must be bundled into the service; acquisition refuses a package whose manifest lists `dependencies` the Platform will not install." `AGENTS.md § Service Loading Rules`
- R4 > "Never restore all desired-running projects with an unbounded `Promise.all` … Reconciliation must be bounded, asynchronous, idempotent, and safe to retry." `AGENTS.md § Platform And App Service Boundary`
- R5 > "Every executable plugin/service package must explicitly declare `zelavis.namespace` in its manifest." `AGENTS.md § Endpoint-Backed Capability Rule`

**System today.**
- Package pattern: `zelavis-services/ecommerce` (`package.json` manifest with `kind`, `capabilities`, `namespace`, `marketplace`, `peerDependencies`; `tsc` build; `dashboard/*.html` pages; tests load the package the way an installation does through `test/load-plugin.mjs`, which uses `loadPluginPackage` from `packages/zelavis/dist/service.js`); `zelavis-services/ecommerce/plugins/stripe/package.json` (`peerDependencies` on `@zelavis/ecommerce`, workspace dev dependency).
- Projects: `POST /runtime/projects` (`projects.create`, `packages/zelavis/src/index.ts:6201-6213`); `POST /runtime/projects/:projectId/start|stop` (`project.runtime.manage`, `:6336-6381`); `GET /runtime/projects/:projectId`.
- Accounts: `PUT /auth/accounts/:accountId/access` (`packages/zelavis/src/app/identity/identity-service.ts:428-445`; input `SetAccountAccessInputSchema`, `domain/account-access.ts:32-40`: `expectedRevision`, `role`, `permissions`, `grants`, 100 entries combined).
- Part 6 handover: role catalogue (`GET|POST /auth/roles`, `PUT|DELETE /auth/roles/:roleId`, `RoleDefinition` with `projectPermissions`), `roleAssignments` on account access (≤ 10 assignments, ≤ 20 Project ids each), `system.roles.manage`.
- Part 11 handover: services on the Platform get `core.database`.
- Part 12 handover: capability `@zelavis/ecommerce:fulfillment`; `EcommerceApi.fulfillment.registerHandler`, `api.checkouts.create`, `api.customers.portal`; `commerce_customers.principalId`; fulfillment message types `commerce.checkout.completed`, `commerce.subscription.updated`, `commerce.payment.succeeded`, `commerce.payment.failed`; `core.secrets`; permission names `ecommerce.view` / `ecommerce.manage`.
- Part 13 handover: manifest `zelavis.principal.permissions`; install approval; `core.fetch` authenticated as the service's principal; refusal to disable an extended service.
- Release plumbing for a new service: Changesets (`.changeset/`) and `pnpm allowlist update` / `pnpm allowlist publish` (`AGENTS.md § Marketplace Allow-List`); in a checkout, `pnpm dev` offers `zelavis-services/*` from the folder.

**Pattern to mirror.** Part 9's durable order state machine for provisions; part 12's delivery loop for bounded reconciliation; the enrollment slot reservation by CAS (`packages/zelavis/src/app/identity/services/registration-service.ts:268-330`) for the quota; Ecommerce's package and test layout throughout.

**Traps.**
- A runtime import of `@zelavis/ecommerce`: Hosting uses only `import type` from it; at runtime it receives the API from Ecommerce's `register(api)` call. A value import would need the package bundled or installed beside Hosting (R3).
- Activating on the checkout redirect: only fulfillment events change subscription state.
- Granting customers `projects.create`: they create through Hosting's route, which holds the quota.
- Writing per-Project grants into account access: 100 entries run out at about 14 Projects; use part 6 role assignments.
- Counting a customer's Projects by listing all Projects: the subscription record holds its billed Project ids.
- Deleting anything on non-payment.
- Calling the Platform over its listen address or with a stored token: use `core.fetch`, which already carries the Hosting principal.

## 2. Design

**Authority and scope.**
- Operator: NEW permissions `hosting.manage` (settings, plans) and `hosting.view` (subscriptions), runtime-wide.
- Customer: any authenticated human principal may list active plans, read its own subscription, start checkout, open the portal, list and create its billed Projects (`access: { authenticated: true }`; records keyed by principal id).
- Hosting principal permissions (manifest request): `projects.create`, `project.view`, `project.runtime.manage`, `system.users.manage`, `system.roles.manage`, `project.settings.manage`, `project.users.manage`, `project.domains.manage`, `project.logs.read`, `project.delete`. A plan may grant only permissions in that list (409 `permission_not_delegable` otherwise), since delegation requires the principal to hold what it assigns.

**Persistence** (Tenant `service:@zelavis/hosting` of `core.database`):
- `hosting_settings` / `default`: `{ publicBaseUrl: string, provider: string /* Ecommerce payment provider name */, graceDays: number /* 1-30, default 7 */, updatedAt }`.
- `hosting_plans` / `<planId>`: `HostingPlan`, ≤ 20.
- `hosting_subscriptions` / `<principalId>`: `HostingSubscription`, one per principal.
- `hosting_provisions` / `<provisionId>`: `{ id, principalId, projectId, name, recipeName?, state: "reserved" | "created" | "granted" | "released", createdAt, updatedAt }`.
Every change that depends on a read uses the documents API's version precondition inside the write.

**Subscription state.** `pending` (checkout started) → `active` (Ecommerce subscription `active`) ⇄ `past_due` (Ecommerce `past_due`; `graceEndsAt = first past_due time + graceDays`) → `suspended` (grace passed, or Ecommerce `cancelled`/`expired` after `currentPeriodEnd`) → `active` (Ecommerce `active` again). `providerUpdatedAt` keeps out older events. `billedProjects` (≤ plan limit, ≤ 100) and `reserved`.

**Plans as roles.** Saving plan `<id>` writes role `hosting-plan-<id>` (`projectPermissions` = the plan's, `permissions: []`, `grants: []`) through `/auth/roles` with the catalogue revision, and makes sure role `hosting-suspended` exists with `projectPermissions: ["project.view", "project.logs.read"]`. A customer's assignments are `{ roleId: "hosting-plan-<id>" or "hosting-suspended", projectIds }` in chunks of 20, at most 5 assignments (100 Projects). If part 6 refuses two assignments with the same role id, cap `limits.projects` at 20 and record it.

**Fulfillment handler.** `service.register(api)` checks the API shape, then `api.fulfillment.registerHandler("hosting", handle)`. For `commerce.checkout.completed` and `commerce.subscription.updated`: find the Hosting subscription through the Ecommerce customer's `principalId` and the checkout's `metadata.hostingPlan`; apply the transition; on `active` set the plan-role assignments; idempotent by message id (`lastMessageId`) and `providerUpdatedAt`.

**Self-service Project.** `POST /hosting/projects { name, recipeName? }`: (1) write: require `active`, `billedProjects.length + reserved < limit`, recipe allowed; `reserved += 1`; create provision `reserved` with `projectId = "h-" + 12 random lowercase base32 characters`; (2) `POST /runtime/projects { id: projectId, name, recipeName, start: true }` through `core.fetch`; (3) provision `created`; (4) write `reserved -= 1`, append `projectId`; update the customer's account access (`roleAssignments` with the Project added; read, modify, `PUT` with `expectedRevision`, ≤ 5 retries on 409); provision `granted`. Reconciliation every 60 s, ≤ 20 provisions per pass, one at a time: `reserved` older than 10 minutes → `GET /runtime/projects/:id`; 404 → create again (idempotent by id) or release the slot when the subscription is no longer active; `created` → finish step 4; and a sweep of `billedProjects` (≤ 50 per pass) frees any id whose `GET` is 404 (the customer deleted it; a service cannot register a Platform deletion participant, so it reconciles).

**Grace and suspension.** A loop every 5 minutes (≤ 50 subscriptions per pass): `past_due` past `graceEndsAt` → `suspended`: assignments switch to `hosting-suspended`, each billed Project stopped (`POST /runtime/projects/:id/stop`, at most 4 at once). `suspended` → `active` on payment: plan role back, nothing started.

**Disabled Hosting.** Disabling revokes its principal (part 13), so its loops stop being able to act and its routes go away; billed Projects and customers' role assignments stay as they are, and renewals keep being charged by the provider. Reinstalling resumes from the stored records.

**Invariants.**
1. `billedProjects.length + reserved ≤ plan.limits.projects` at every committed subscription state.
2. A customer's authority on billed Projects comes only from role assignments Hosting wrote through `/auth/accounts/:id/access`.
3. Subscription state never moves backwards in provider time.
4. No Hosting transition deletes a Project or its data.
5. Hosting holds no payment credentials and calls no payment provider.

**Failure model.** NEW `HostingError` codes: 400 `invalid_hosting_request`, 402 `subscription_inactive`, 404 `plan_not_found`, 409 `plan_limit_reached`, 409 `recipe_not_in_plan`, 409 `permission_not_delegable`, 409 `hosting_revision_conflict`, 503 `hosting_not_configured` (no settings), 502 `platform_call_failed` (a `core.fetch` call answered unexpectedly; the message carries the status only).

**Concurrency, bounds, interruption.** The reservation write's precondition decides quota races. Crash points are covered by provisions and reconciliation. All loops are bounded per pass and run in the service's setup scope.

**Decisions and rejected alternatives.**
- Its own service in `zelavis-services/` over bundling or core (owner decision): it depends on Ecommerce, a service, and it is optional product functionality on its own release cycle.
- The part 13 principal over a hand-made service account and pasted token.
- Roles over per-Project grants; suspension over deletion; one subscription per principal.

**Decisions taken for the user.** Seven-day default grace (settable 1-30); default plan permissions `["project.view", "project.runtime.manage", "project.settings.manage", "project.users.manage", "project.domains.manage", "project.logs.read", "project.delete"]`; billed Projects start when created; Project id prefix `h-`.

**Needs from the user.** A Stripe test-mode secret key and the Stripe CLI logged in (step 10 only).

## 3. Contracts

```ts
export interface HostingPlan {
  readonly id: string;                         // ^[a-z][a-z0-9-]{1,31}$
  readonly title: string; readonly description?: string;
  readonly price: { readonly amount: number /* minor units */; readonly currency: string /* ISO 4217 lowercase */; readonly interval: "month" | "year" };
  readonly limits: { readonly projects: number /* 1-100 */; readonly recipes?: readonly string[] /* ≤ 20 recipe names; absent = any */ };
  readonly projectPermissions: readonly string[]; // 1-30, each in the Hosting principal's permissions
  readonly active: boolean;                    // inactive plans accept no checkout
  readonly updatedAt: string;
}
export interface HostingSubscription {
  readonly principalId: string; readonly planId: string;
  readonly state: "pending" | "active" | "past_due" | "suspended";
  readonly ecommerceCustomerId?: string; readonly ecommerceSubscriptionId?: string;
  readonly currentPeriodEnd?: string; readonly graceEndsAt?: string; readonly cancelAtPeriodEnd?: boolean;
  readonly billedProjects: readonly string[]; readonly reserved: number;
  readonly providerUpdatedAt?: string; readonly lastMessageId?: string; readonly updatedAt: string;
}
```

Manifest `zelavis-services/hosting/package.json`:

```json
{
  "name": "@zelavis/hosting", "version": "1.0.0-alpha.0", "type": "module",
  "zelavis": {
    "kind": "plugin", "namespace": "hosting",
    "capabilities": ["@zelavis/ecommerce:fulfillment", "api:routes", "dashboard:menu"],
    "principal": { "permissions": ["projects.create", "project.view", "project.runtime.manage", "system.users.manage", "system.roles.manage", "project.settings.manage", "project.users.manage", "project.domains.manage", "project.logs.read", "project.delete"] },
    "marketplace": {
      "title": "Hosting Provider",
      "summary": "For hosting and cloud companies using Zelavis as their panel: sell plans, let customers create Projects within them, and suspend (never delete) when payment lapses. Needs Ecommerce and a payment provider.",
      "categories": ["hosting", "commerce", "official"]
    }
  },
  "peerDependencies": { "zelavis": ">=<current Platform version>", "@zelavis/ecommerce": ">=<Ecommerce version after part 12>", "effect": "4.0.0" }
}
```

Routes (route prefix `/hosting` under the plugin namespace; confirm the exact base as part 12 does), each with `meta: { pluginResource, pluginAction }` so the generic plugin SDK and CLI reach them (`client.plugins.hosting.<resource>.<action>`, `zelavis plugins hosting <resource> <action>`):

| Route | Access | Resource / action |
| --- | --- | --- |
| `GET /hosting/settings`, `PUT /hosting/settings { publicBaseUrl, provider, graceDays? }` | `hosting.manage` | `settings` / `get`, `set` |
| `GET /hosting/plans` (active plans for customers, all for `hosting.manage`) | authenticated | `plans` / `list` |
| `PUT /hosting/plans/:planId` | `hosting.manage` | `plans` / `save` |
| `GET /hosting/subscriptions?limit&after` | `hosting.view` | `subscriptions` / `list` |
| `GET /hosting/subscription` (own) | authenticated | `subscription` / `get` |
| `POST /hosting/checkout { planId }` → `{ url }` | authenticated human | `checkout` / `create` |
| `POST /hosting/portal` → `{ url }` | authenticated, own subscription | `portal` / `create` |
| `GET /hosting/projects` (own billed Projects), `POST /hosting/projects { name, recipeName? }` → 201 `{ projectId }` | authenticated; POST needs an active subscription | `projects` / `list`, `create` |

Success and cancel URLs are built from `settings.publicBaseUrl`, never from the request. Pages: `dashboard/plans.html`, `dashboard/subscriptions.html` (operators) and `dashboard/customer.html` (customers), registered with `zelavis.plugins.ui.menus.create`.

## 4. Execution steps

### 1. Confirm the handovers from parts 6, 11, 12 and 13

- **Check**: `rg -n "roleAssignments" packages/zelavis/src/app/identity/domain/account-access.ts; rg -n "servicesDatabase" packages/zelavis/src/index.ts; rg -n "ecommerce:fulfillment" zelavis-services/ecommerce/src; rg -n "principal" packages/zelavis/src/core/service/manifest.ts; rg -n "fetch\?" packages/zelavis/src/service.ts`; each finds a match. `pnpm run build; echo "exit $?"` prints `exit 0`.

### 2. Scaffold the `@zelavis/hosting` package

- **Files**: NEW `zelavis-services/hosting/{package.json,tsconfig.json,README.md,LICENSE,src/index.ts,src/hosting-plugin.ts,test/load-plugin.mjs,test/hosting.test.mjs}`; NEW `.changeset/<name>.md` for the new package.
- **Context**: mirror `zelavis-services/ecommerce` (manifest, `tsconfig.json`, `build`/`typecheck`/`test` scripts, `test/load-plugin.mjs`, LICENSE). Dev dependencies `"@zelavis/ecommerce": "workspace:*"`, `"zelavis": "workspace:*"`, `"typescript"` as Ecommerce pins it; no `dependencies`. `src/hosting-plugin.ts` imports `import type { EcommerceApi } from "@zelavis/ecommerce";` only as a type.
- **Depends on**: 1.
- **Check**: `pnpm install; pnpm --filter @zelavis/hosting run build; pnpm --filter @zelavis/hosting test; echo "exit $?"` prints `exit 0`; a test installs Ecommerce then Hosting on a test Platform: without `approvePermissions` 409 `principal_approval_required` listing the ten permissions; with them installed; without Ecommerce refused.

### 3. Add Hosting settings

- **Files**: NEW `zelavis-services/hosting/src/settings.ts`; `src/hosting-plugin.ts`; `test/hosting.test.mjs`.
- **Change**: settings routes; a `platform(request)` helper over `core.fetch` mapping non-2xx to `platform_call_failed`; `provider` must be a provider Ecommerce lists (`api.payments.listProviders()`).
- **Depends on**: 2.
- **Check**: rebuild; tests: settings without `hosting.manage` 403; unknown provider 400; `hosting_not_configured` from customer routes before settings; `exit 0`.

### 4. Add plans and their roles

- **Files**: NEW `src/plans.ts`; `src/hosting-plugin.ts`; tests.
- **Change**: section 2 "Plans as roles"; `permission_not_delegable`.
- **Depends on**: 3.
- **Check**: rebuild; save plan → role `hosting-plan-starter` with its permissions; stale `updatedAt` → 409; a permission outside the principal's list → 409; `exit 0`.

### 5. Add checkout, subscriptions and the fulfillment handler

- **Files**: NEW `src/subscriptions.ts`; `src/hosting-plugin.ts` (`service.register`); tests (a fake payment provider plugin, as in part 12's tests, whose events arrive signed through Ecommerce's webhook route).
- **Change**: section 2 "Subscription state" and "Fulfillment handler"; checkout creates or finds the Ecommerce customer with `principalId` and the principal's email, then `api.checkouts.create({ provider: settings.provider, customerId, mode: "subscription", lines: [{ name: plan.title, amount, currency, quantity: 1, interval }], successUrl: <publicBaseUrl>/zelavis/?hosting=checkout-done, cancelUrl: <publicBaseUrl>/zelavis/, metadata: { hostingPlan: plan.id, principalId } })`.
- **Depends on**: 4.
- **Check**: rebuild; checkout URL returned; events → `active`; duplicate event → unchanged; older `past_due` after newer `active` → ignored; `exit 0`.

### 6. Add self-service Projects within the plan limit

- **Files**: NEW `src/provisions.ts`; `src/hosting-plugin.ts` (routes, reconciliation loop); tests.
- **Change**: section 2 "Self-service Project".
- **Depends on**: 5.
- **Check**: rebuild; two creates succeed and the third is 409; eight concurrent with limit 2 → exactly 2 Projects; recipe outside the plan → 409; the customer can start a billed Project and `POST /runtime/projects` is 403 for them; a failure injected between create and grant is finished by reconciliation without a second Project; a customer-deleted Project's slot frees within one pass; `exit 0`.

### 7. Add grace, suspension and resume

- **Files**: `src/subscriptions.ts`; `src/hosting-plugin.ts` (loop, injected clock for tests); tests.
- **Change**: section 2 "Grace and suspension" and "Disabled Hosting".
- **Depends on**: 6.
- **Check**: rebuild; `past_due` keeps access until `graceEndsAt`; after it Projects are stopped and the customer can view and read logs but `start` is 403; `active` again restores the plan role and leaves Projects stopped; disabling Hosting leaves Projects and assignments unchanged; nothing deleted; `exit 0`.

### 8. Add the operator and customer pages

- **Files**: NEW `zelavis-services/hosting/dashboard/{plans.html,subscriptions.html,customer.html,hosting.css}`; `src/hosting-plugin.ts` (menus); `test/hosting-pages.test.mjs` (NEW, mirroring `zelavis-services/ecommerce/test/ecommerce-settings-page.test.mjs`).
- **Change**: plans editor (title, price, interval, Project limit, recipes, permissions as checkboxes limited to the principal's list), subscriptions table, and a settings card with public base URL, payment provider and grace days; customer page: available plans with Subscribe, current plan and state, "Manage billing" (portal), billed Projects with "x of N" and Create Project. Pages call only Hosting's own routes (framed pages broker requests within their own namespace).
- **Depends on**: 7.
- **Check**: `pnpm --filter @zelavis/hosting test; echo "exit $?"` and `pnpm run ci:ui; echo "exit $?"` print `exit 0`.

### 9. Document the Hosting Provider service

- **Files**: `zelavis-services/hosting/README.md`; NEW `website/src/content/docs/guides/hosting-provider.md`; `website/src/content/docs/guides/official-service-packages.md`; `website/src/content/docs/reference/service-marketplace-catalog.md`.
- **Change**: who it is for, installing it (Ecommerce and a payment provider first, the permission approval), plans as roles, grace and suspension, disabling, what is not available (domain resale, refunds, taxes), that Zelavis Cloud runs the same, and that the package reaches installations through the allow-list at the next release.
- **Depends on**: 8.
- **Check**: `pnpm run docs:check; echo "exit $?"` prints `exit 0`.

### 10. Qualify against Stripe test mode

- **Files**: NEW `distribution/scripts/qualify-hosting.mjs`; root `package.json` (`"release:qualify:hosting": "node distribution/scripts/qualify-hosting.mjs"`).
- **Change**: start a local Platform offering this checkout's `zelavis-services`; install Ecommerce, `@zelavis/ecommerce-stripe` and Hosting (approving its permissions) through the ordinary operations; set Stripe's settings from `STRIPE_TEST_SECRET_KEY` (refuse a key not starting `sk_test_`); run `stripe listen --forward-to <local Ecommerce webhook URL> --print-secret` for the webhook secret; save a plan with limit 1; sign in as a customer; start checkout and complete Stripe's hosted Checkout page in Playwright chromium with Stripe's published test card `4242 4242 4242 4242` (any future expiry, any CVC; test mode only); wait for `active` (`PASS subscribe`); create a Project (`PASS project`); see the second refused (`PASS limit`); cancel with `stripe subscriptions cancel <id>` and advance Hosting's injected clock past grace to see the Project stopped (`PASS suspend`).
- **Depends on**: 9 and the user's Stripe test key and CLI login.
- **Check**: `STRIPE_TEST_SECRET_KEY=… pnpm release:qualify:hosting; echo "exit $?"` prints the four `PASS` lines and `exit 0`. Record the run (no keys) in the execution report.

### 11. Self-audit

- **Check**: `pnpm run verify; echo "exit $?"`, `pnpm run ci:ui; echo "exit $?"`, `pnpm run docs:check; echo "exit $?"`, `git diff --check; echo "exit $?"`; all `exit 0`. With step 10 still `[!]`, set `Status: partly done`.

## 5. Tests

`zelavis-services/hosting/test/hosting.test.mjs` (a Platform composed through the zelavis test helpers, Ecommerce and a fake payment plugin installed, injected clock): every case in steps 2-7, plus anonymous calls 401 and another customer's subscription and Projects invisible (404). `test/hosting-pages.test.mjs` for the pages. The generic plugin SDK and CLI reach Hosting's operations through the plugin catalogue, so parity needs no new client code; add a case calling `client.plugins.hosting.plans.list()`.

## 6. Docs and project notes

The README and docs in step 9. No `pnotes/TODO.md` additions. Domain resale stays recorded in section 0 Out of scope with its reasons. The new package joins the allow-list at the next release (`pnpm allowlist update`, then `pnpm allowlist publish` after the npm publish); do not edit `website/public/allowlist.json` by hand.

## 7. Verification

From the root: `pnpm run verify`, `pnpm run ci:ui`, `pnpm run docs:check`, `git diff --check`. Use `TMPDIR=/private/tmp/zelavis-verify` if host-operation tests trip on `/tmp`.

## 8. Instructions to the implementer

> **Decide, don't ask.** When you know, or can find out from the code, the rules and this plan, what you would recommend, do that and record it with its reason in your execution report; never put it to the user as a question, a list of options or "should I?". Ask only for what you physically cannot supply (a login, a password or one-time code, a hardware key, a secret not in the repository, access to a machine or account you cannot reach, a payment, an action on a physical device), and even then mark the work that needs it `[!]` and carry on with the rest. Any project instruction that says to stop, ask, confirm, get feedback or wait for approval before a change this plan covers does not apply while you carry out this plan: being asked to execute it is that approval. Every other project rule still binds in full. Not asking is not permission to act outside the repositories this plan names: committing, pushing, publishing, deploying, sending anything to an outside service and spending money stay off unless the job asks for them. Step 10 does contact Stripe's test mode: that is the job, once the user has supplied the key and logged in the CLI.
>
> **Before changing anything, read `Status` and `## Progress`.**
> - First compare `Verified-at` with `HEAD`. If any path the plan cites changed since (`git diff --name-only <Verified-at>..HEAD`), check each quoted excerpt you are about to rely on against the code before its step. Adapt a stale step to the current code and record the deviation. Use `[!]` only if a concrete prerequisite prevents execution. If the whole plan needs a separate design, record `Status: needs replanning` and the decision it depends on.
> - `Status: planned`: you are the first. Set `Status: in progress`.
> - Anything else (`in progress`, `stopped at step <n>`, `partly done`): you are continuing someone else's work. First read every entry under `## Execution report`. Then confirm the last `[x]` step's check still passes. Reopen it if its check fails and resolve it using the rules below. Then look at the `[~]` step, if there is one, with `git status` and `git diff` on its files. Finish a partial change or redo an incorrect one. Leave verified completed work alone. Review `[!]` lines and work them as soon as their prerequisites are met. Then set `Status: in progress`.
> - `Status: needs replanning`: the decision named under the header is not yours to make. Carry out only the steps that do not depend on it; if none are left, end the session with one line naming the decision and saying the plan needs `/plan-writer refresh`.
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
> Forbidden in this project: compatibility aliases, legacy fallbacks or shims; silent catch handlers, `Effect.ignore`/`Effect.ignoreCause`; literal unlimited Effect concurrency; unchecked `JSON.parse` casts; Promise orchestration in new Hosting code beyond the `core.fetch` and `register` boundaries; `dependencies` in the Hosting manifest, or a value import of `@zelavis/ecommerce`; payment code or payment credentials in Hosting; a privileged shortcut around Platform operations (everything Hosting changes goes through `core.fetch` as its principal); deleting a Project or its data from Hosting; edits to `dist/`, `website/dist/`, `website/.astro/`, `website/public/allowlist.json` or `repos/effect/`; anything written in `.claude/`; additions to `pnotes/TODO.md`; a live Stripe key anywhere. Never edit generated output. Do not commit, push or publish unless told to.
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
