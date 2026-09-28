---
"@zelavis/ecommerce": major
"@zelavis/ecommerce-stripe": major
"@zelavis/ecommerce-paypal": major
"zelavis": patch
---

Payment gateways declare `@zelavis/ecommerce:payments`.

They declared `provider:payments`, a bare domain namespace that says what a
gateway implements and never whose contract it satisfies — so a second commerce
plugin scanning for it would collect these gateways too, and neither plugin
could tell. Naming the owner also places them: a gateway now appears under
`@zelavis/ecommerce` in `GET /runtime/extensions` and on that plugin's own
settings page, rather than in a general catalogue where a payment gateway sits
beside a dashboard theme.

Both gateways also declared `kind: "provider"`, a kind removed when the
taxonomy collapsed to `app | frontend | plugin`, and neither package.json
carried a `zelavis` block at all — so installing either would have been refused
at manifest validation. They only ever worked composed in code.

Installing a gateway without `@zelavis/ecommerce` is now refused rather than
appearing to work: the commerce plugin is what discovers it, so on its own it
would look enabled and process nothing.

Also corrects the capability hints in `zelavis/core`, which still listed
`@zelavis/auth:credentials` after core auth was renamed to `zelavis/auth`.
