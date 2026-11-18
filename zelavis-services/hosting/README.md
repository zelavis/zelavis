# Zelavis Hosting Provider

`@zelavis/hosting` adds paid Project plans to a Zelavis Platform. It is for
hosting and cloud companies that want customers to subscribe and provision their
own Projects within a quota. The service definition lives in
[src/hosting-plugin.ts](src/hosting-plugin.ts).

Install Ecommerce and configure a payment provider with recurring hosted
checkout, portal, and signed callbacks. Then install **Hosting Provider** through
the Platform Marketplace and approve its service principal permissions. The
published package reaches installations through the Marketplace allow-list.

Open **Extensions → Hosting Provider → Plans and settings** to configure the
return origin, payment provider and grace period and to create a plan. The plan
defines a price, billing interval, allowed Project recipes and at most 20
Projects per subscription. Its Auth role grants access only to billed Projects.
Customers use their Zelavis accounts with a verified email to subscribe, manage
billing and create Projects.

Past-due subscriptions keep access through grace. Suspension stops billed
Projects and keeps view and logs. Renewal restores plan permissions and leaves
stopped Projects ready for the customer to start. Disabling Hosting revokes its
service principal. Existing Projects, role assignments and provider billing
remain in place. Domain resale, refunds and tax calculation are outside Hosting.

See the [Hosting Provider guide](../../website/src/content/docs/guides/hosting-provider.md)
for setup and the HTTP, SDK and CLI operations.
