---
"@zelavis/ecommerce": major
"@zelavis/ecommerce-stripe": patch
"@zelavis/ecommerce-paypal": patch
"@zelavis/app-auth-oidc": patch
"zelavis": patch
---

The ecommerce plugin declares its menu through the SDK, and the plugin loader
stops dropping what a plugin declares.

The authoring guide's Rule 4 tells plugin authors to use `zelavis/sdk` for
menus, routes, commands and events. The flagship example plugin used a `menu`
field on its exported object instead — which works, because the loader merges
both, but a first-party plugin contradicting a documented rule is how the rule
stops sticking. It now calls `zelavis.menu.create`.

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
