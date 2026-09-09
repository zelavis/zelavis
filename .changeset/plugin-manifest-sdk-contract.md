---
"zelavis": major
"@zelavis/ecommerce": major
"@zelavis/ecommerce-paypal": major
"@zelavis/ecommerce-stripe": major
---

Replace `defineService` with a manifest-based plugin contract. Plugins and
services now declare themselves through a validated `package.json` manifest
(`"zelavis": { "kind": ... }`, ESM `type` and `exports`, no legacy `main`) and
author their behavior through the official `zelavis/sdk` surface —
`zelavis.menu`, `zelavis.routes`, `zelavis.commands`, `zelavis.events`, and
`zelavis.services` — bound to an explicit plugin execution context.

Route definitions carry typed operation specs and the runtime generates an
OpenAPI 3.1 document for every mounted service at
`/zelavis/api/v1/runtime/openapi.json`.

Plugin manifest resolution moved out of the runtime core: hosts install a
`ZelavisServiceManifestResolver` (the Node and Bun adapters install the local
filesystem one), keeping filesystem plugin scanning out of core. A runtime
service's `api` is now optional so `kind: "provider"` plugins can register
through a domain contract without mounting HTTP routes.

`defineService` and the `zelavisEcommerceService` alias are removed with no
compatibility shims. Import `ecommercePlugin` from `@zelavis/ecommerce` and move
plugin configuration into `package.json`. The unrelated marketplace helpers
`defineServiceCatalogEntry` and `defineServiceCatalog` are unchanged.
