---
"@zelavis/ecommerce": minor
"@zelavis/ecommerce-stripe": patch
"@zelavis/ecommerce-paypal": patch
"zelavis": patch
---

Give the ecommerce plugin a working dashboard, with a payments settings page.

Its menu never reached the dashboard. The plugin adds its routes during setup,
so it carries no `basePath`, service, or routes of its own — and the mount
check looked for exactly those, dropping a menu with five pages while the
plugin looked installed. A service contributing only a menu or page assets is
mounted now, because a menu is a contribution too.

The pages would not have rendered anyway. They pointed at `bundle: "dashboard"`,
which resolves through the bundle store, and nothing ever uploaded them into
one — every page answered "Service asset not found". They ship as page assets
now, generated from the same editable HTML on disk, which needs no upload step.

A new Payments page lists the gateways this installation can take payments
through and the plugins that extend `@zelavis/ecommerce`, so a payment gateway
is chosen where it means something rather than in a general catalogue. Stripe
and PayPal carry marketplace titles for it, since a list of package names says
less than the gateway an operator is choosing between.
