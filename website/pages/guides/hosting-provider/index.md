---
layout: docs
title: "Hosting Provider"
description: "Sell hosting subscriptions and give customers self-service Zelavis Projects within their plan."
---

# Hosting Provider

Hosting Provider (`@zelavis/hosting`) is an optional service for hosting and
cloud companies using Zelavis as their panel. Use it to sell recurring plans
that give customers self-service Projects. Zelavis Cloud runs the same service code
as a self-hosted installation. Ecommerce and its payment providers handle billing.

## Install and configure

1. Open the Platform Marketplace and install **Ecommerce**, then a provider that
   supports hosted checkout, recurring payments, a customer portal, and signed
   callbacks. [Configure Stripe and its webhook](/guides/official-service-packages/#billing-through-ecommerce)
   if you use Stripe.
2. Install **Hosting Provider** on the Platform. Review and approve its requested
   permissions. Zelavis creates a dedicated service account that can create,
   view and stop billed Projects and manage their Auth role assignments. The
   requested Project permissions also bound what a plan can delegate.
3. Open **Extensions → Hosting Provider → Plans and settings**. Save the public
   HTTPS origin that customers should return to after checkout and portal visits,
   select the registered payment provider, and set the grace period. The default
   is seven days and the range is 1–30 days. HTTP is allowed on loopback for local
   testing.
4. Make customer accounts available through Platform registration or invitations.
   Customers use their Zelavis account and need a verified email to subscribe.

The package becomes available on released installations through the Marketplace
allow-list after its first publish. In a development checkout, the local service
catalogue offers the built package directly.

## Plans and billing

Set a plan's title, price in currency minor units, monthly or yearly billing,
Project limit, optional recipe allow-list, and Project permissions. An installation
can have up to 20 plans and each plan can allocate up to 20 Projects. A lower
limit takes effect if every subscription's existing Projects and pending
reservations fit within it. Turning off availability closes checkout for new
customers. Existing subscriptions keep their plan, and price changes apply to
new checkouts.

Every plan has a Platform Auth role named `hosting-plan-<id>`. Hosting assigns
it only for the customer's billed Project IDs. Keep the `hosting-plan-` roles
and `hosting-suspended` managed by Hosting. Customers create Projects through
the Hosting page, where the service enforces the plan's limit. Deleting a billed
Project frees its slot during reconciliation. An Auth access change can end the
customer's existing sessions, so customers may need to sign in again after
creating a Project or after their plan access changes.

Customers can subscribe and open the billing portal from **Extensions → Hosting
Provider**. The payment link opens from a dashboard confirmation in a separate
tab. The subscription activates after Ecommerce verifies the provider callback.
Use **Subscriptions** to see customer accounts, subscription states, and grace
deadlines. Operators need `hosting.manage` for settings and plans and
`hosting.view` for subscription inventory.

## Grace, suspension, and renewal

Customers who are past due retain their existing Project access through the
grace deadline. New Project provisioning requires an active subscription.
When grace ends, or a canceled or expired subscription reaches the end of its
paid period, Hosting switches its Project grants to view and logs and stops
the billed Projects. Project data is retained. Once the provider reports the
subscription active again, Hosting restores the plan role. Customers can then
start their Projects.

Disabling Hosting removes its pages and revokes its service account. Existing
Project state and role assignments remain in place, and the payment provider
continues billing subscriptions. Reinstalling Hosting resumes reconciliation
from its stored state. Disable Hosting before disabling Ecommerce.

Domain resale, refunds from Hosting, and tax calculation are outside the service.
Customers can bring their own domains using the [ownership verification flow](/architecture/edge/#connect-a-project-hostname)
or use a subdomain the operator provides.

## HTTP, SDK, and CLI

The default HTTP prefix is `/zelavis/api/v1/plugins/hosting/hosting`. The SDK
discovers operations under `client.plugins.hosting`. Mutations that accept data
can read JSON from standard input using `--data-stdin` in the CLI.

| HTTP | JavaScript SDK under `client.plugins.hosting` | CLI after `zelavis plugins hosting` |
| --- | --- | --- |
| `GET /settings` | `.settings.get()` | `settings get` |
| `PUT /settings` | `.settings.set(input)` | `settings set --data-stdin` |
| `GET /plans` | `.plans.list()` | `plans list` |
| `PUT /plans/:planId` | `.plans.save(input, { params: { planId } })` | `plans save --param planId=ID --data-stdin` |
| `GET /subscriptions` | `.subscriptions.list(undefined, { query })` | `subscriptions list --query limit=20` |
| `GET /subscription` | `.subscription.get()` | `subscription get` |
| `POST /checkout` | `.checkout.create({ planId })` | `checkout create --data-stdin` |
| `POST /portal` | `.portal.create()` | `portal create` |
| `GET /projects` | `.projects.list()` | `projects list` |
| `POST /projects` | `.projects.create({ name, recipeName })` | `projects create --data-stdin` |

Supply the last returned `updatedAt` when editing a plan. Follow `next` as
`after` when paging through subscriptions. Project creation returns 409
`plan_limit_reached` when all of the customer's slots are allocated.
