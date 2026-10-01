# @zelavis/ecommerce-stripe

## 1.0.0-alpha.3

### Patch Changes

- Services are self-contained: the Stripe and PayPal plugins bundle their SDKs, `effect` and `zelavis` come from the Platform, and unused dependencies are gone, so the Platform accepts them.
- Updated dependencies
  - @zelavis/ecommerce@2.0.0-alpha.4

## 1.0.0-alpha.2

### Major Changes

- 12e430f: Payment gateways declare `@zelavis/ecommerce:payments`.
  
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
- d6a33d1: Replace `defineService` with a manifest-based plugin contract. Plugins and
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
- 2272870: Consolidate the reusable server/Fabric engine, built-in App recipe, App Auth,
  App Database, Workloads, and trusted Platform services into the unified
  `zelavis` package with focused public subpaths. Add typed runtime lifecycle,
  artifact/provider contracts, deterministic Fabric replica planning, and exact
  per-Project App version locks that parent Platform upgrades preserve. Project
  deletion now persists resumable cleanup progress and removes Project-owned
  Assistant threads, domain bindings, bundle assets, and runtime data before the
  registry record disappears.
  
  This intentionally removes the previous standalone package entry points and is
  a breaking release with no compatibility aliases.

### Minor Changes

- d64fec1: Add native-Web request authentication, opaque persisted sessions, Web Crypto
  password hashing, Basic/JWT/JWKS verifiers, and the OIDC bearer plugin. Move
  Auth plugins out of the unified package and replace the retired child-service
  graph with capability-discovered provider registration contracts. Add
  provider-owned credential enrollment, token-gated first-owner bootstrap, real
  Platform dashboard login/logout, session cookies and rotation, same-origin
  cookie issuance and mutation enforcement, and permission gates for critical
  control-plane endpoints.

### Patch Changes

- 51386bd: The ecommerce plugin declares its menu through the SDK, and the plugin loader
  stops dropping what a plugin declares.
  
  The authoring guide's Rule 4 tells plugin authors to use `zelavis/sdk` for
  menus, routes, commands and events. The flagship example plugin used a `menu`
  field on its exported object instead — which works, because the loader merges
  both, but a first-party plugin contradicting a documented rule is how the rule
  stops sticking. It now calls `zelavis.plugins.ui.menus.create`.
  
  That only works inside a plugin execution context, so the plugin has to be
  loaded rather than imported and passed around as a live object. Which turned up
  the real problem: `loadPluginPackage` built its service object field by field
  and omitted `setup`, `runtimeServices`, `app`, `project`, `scope` and
  `authenticators`. The ecommerce plugin registers its whole `commerce` API
  during setup, so installing it as a package produced a service with a menu and
  no endpoints, while composing the same object in code worked — the supported
  path was the broken one.
  
  Breaking: `ecommercePlugin` can no longer be imported and used directly. Load
  it through `loadPluginPackage` with the exported `ECOMMERCE_MANIFEST`, which is
  what an installation does.
  
  Also clears what an audit of the first-party plugins turned up:
  
  - Both payment gateways still carried a legacy `main` field, which the manifest
    contract refuses — so even with the `zelavis` block added they could not have
    been installed.
  - `@zelavis/ecommerce` declared its capabilities only on the service object,
    not in its manifest, unlike every other plugin.
  - `@zelavis/app-auth-oidc` exported an `oidcService` alias nothing imported.
  - The ecommerce README documented `kind: "provider"`, removed with the taxonomy.
  
  A test now validates every first-party manifest against the real contract, so
  they cannot drift back.
- 78b5839: Give the ecommerce plugin a working dashboard, with a payments settings page.
  
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
- Updated dependencies [df8fcf2]
- Updated dependencies [d2b22c4]
- Updated dependencies [49177f0]
- Updated dependencies [71c1c4f]
- Updated dependencies [a59cfad]
- Updated dependencies [cd26722]
- Updated dependencies [61cde5e]
- Updated dependencies [3bf1481]
- Updated dependencies [313b7a2]
- Updated dependencies [48dbb58]
- Updated dependencies [448e097]
- Updated dependencies [c56a596]
- Updated dependencies [344368e]
- Updated dependencies [ac8daa0]
- Updated dependencies [493e2b5]
- Updated dependencies [874e983]
- Updated dependencies [7a32736]
- Updated dependencies [7bf02e0]
- Updated dependencies [3663b43]
- Updated dependencies [9957059]
- Updated dependencies [de5f3fe]
- Updated dependencies [f68f2da]
- Updated dependencies [3dbc353]
- Updated dependencies [48dbb58]
- Updated dependencies [2ffffbb]
- Updated dependencies [88c4f0e]
- Updated dependencies [48dbb58]
- Updated dependencies [694ae12]
- Updated dependencies [48dbb58]
- Updated dependencies [7e5cc15]
- Updated dependencies [62b2e91]
- Updated dependencies [ffb15fc]
- Updated dependencies [2833e08]
- Updated dependencies [503b6c0]
- Updated dependencies [48dbb58]
- Updated dependencies [349549b]
- Updated dependencies [0e6fdc5]
- Updated dependencies [0e6fdc5]
- Updated dependencies [ebab0bb]
- Updated dependencies [6aac906]
- Updated dependencies [c5147b4]
- Updated dependencies [89cf8f8]
- Updated dependencies [54c5aec]
- Updated dependencies [8801b18]
- Updated dependencies [1b40406]
- Updated dependencies [b1c76c5]
- Updated dependencies [ca8af30]
- Updated dependencies [79ebf23]
- Updated dependencies [0dd7c6d]
- Updated dependencies [907894c]
- Updated dependencies [0a2c8c7]
- Updated dependencies [48dbb58]
- Updated dependencies [48dbb58]
- Updated dependencies [48dbb58]
- Updated dependencies [14f77fd]
- Updated dependencies [3db7ee9]
- Updated dependencies [81c8c07]
- Updated dependencies [727a371]
- Updated dependencies [3808410]
- Updated dependencies [7d8b5e6]
- Updated dependencies [12e430f]
- Updated dependencies [8ac68d4]
- Updated dependencies [51386bd]
- Updated dependencies [78b5839]
- Updated dependencies [48dbb58]
- Updated dependencies [6a8c8c2]
- Updated dependencies [4d3ba56]
- Updated dependencies [6f057e5]
- Updated dependencies [493e2b5]
- Updated dependencies [36f7a76]
- Updated dependencies [d6be1ca]
- Updated dependencies [09ca0f1]
- Updated dependencies [ddc8b7a]
- Updated dependencies [ae6614c]
- Updated dependencies [8f57dc5]
- Updated dependencies [8f99bdf]
- Updated dependencies [d64fec1]
- Updated dependencies [727d95d]
- Updated dependencies [36b8646]
- Updated dependencies [48dbb58]
- Updated dependencies [3bf1481]
- Updated dependencies [48dbb58]
- Updated dependencies [48dbb58]
- Updated dependencies [61a9b45]
- Updated dependencies [d64fec1]
- Updated dependencies [60afafa]
- Updated dependencies [60afafa]
- Updated dependencies [d7bd476]
- Updated dependencies [48dbb58]
- Updated dependencies [48dbb58]
- Updated dependencies [48dbb58]
- Updated dependencies [d8d6880]
- Updated dependencies [8443cb8]
- Updated dependencies [81554ed]
- Updated dependencies [d6a33d1]
- Updated dependencies [8887ddb]
- Updated dependencies [d8d6880]
- Updated dependencies [820e6fd]
- Updated dependencies [d3c94f4]
- Updated dependencies [493e2b5]
- Updated dependencies [d54621c]
- Updated dependencies [e03f7ce]
- Updated dependencies [48dbb58]
- Updated dependencies [0bf279e]
- Updated dependencies [d1ce99d]
- Updated dependencies [d8d6880]
- Updated dependencies [3bf1481]
- Updated dependencies [aa3d4e2]
- Updated dependencies [d83f942]
- Updated dependencies [48dbb58]
- Updated dependencies [e4eb275]
- Updated dependencies [6b293f4]
- Updated dependencies [4f8f3ef]
- Updated dependencies [8e31941]
- Updated dependencies [a770ab4]
- Updated dependencies [6bf7f95]
- Updated dependencies [abcce55]
- Updated dependencies [509067a]
- Updated dependencies [55ee49f]
- Updated dependencies [28bde9d]
- Updated dependencies [36a7877]
- Updated dependencies [43540af]
- Updated dependencies [48dbb58]
- Updated dependencies [d03bd81]
- Updated dependencies [565846d]
- Updated dependencies [48dbb58]
- Updated dependencies [2272870]
- Updated dependencies [8a8156c]
- Updated dependencies [344ace8]
- Updated dependencies [40314af]
- Updated dependencies [1b8c0b7]
- Updated dependencies [5359178]
  - zelavis@2.0.0-alpha.3
  - @zelavis/ecommerce@2.0.0-alpha.3
