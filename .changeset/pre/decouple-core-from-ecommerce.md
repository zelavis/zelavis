---
"zelavis": patch
"@zelavis/ecommerce": patch
---

Take ecommerce out of the Platform.

Core knew about a product it does not ship. Its capability union listed
`@zelavis/ecommerce:payments`, its doc comments used the plugin as an example,
its test suite carried three ecommerce test files plus a 250-line block
creating customers, products and orders, and its `test` script built three
ecommerce packages before it could run — so the Platform could not test itself
without building a shopping cart, and a change to a cart could fail the
Platform's suite.

Core's capability hints now list only the Platform's own services; a capability
owned by a plugin is that plugin's to name. Examples in doc comments use a
neutral `@acme/shop`.

The ecommerce tests moved to the plugin, which gained a test runner, and the
persistence coverage moved with them rather than being dropped. What core
needs from a plugin — that it mounts, receives its setup context, and is handed
platform resources — is covered against a fixture that belongs to nobody.

The manifest consistency check now discovers workspace services instead of
listing them. A hand-maintained list is what let two payment gateways ship with
no `zelavis` block and a removed `kind`; discovery immediately found that a
`frontend` is exempt from the `main` rule, which a list would have missed.

Verified by deleting every ecommerce `dist` and running the Platform's suite.
