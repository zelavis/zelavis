---
"zelavis": minor
"@zelavis/app-auth-oidc": minor
---

Credential providers reach Platform auth by being installed, and nothing else.

The `authMethods` constructor option and the `coreServices.auth.methods` path
are gone. They were a second way to provide a service, and the two disagreed: a
provider handed to composition never entered the registry, so it could not be
listed, disabled, or updated the way the same provider installed normally
could. A provider now arrives through one path — installation — whether from the
product-services folder, the registry endpoints, or the marketplace.

Auth providers declare `@zelavis/auth:credentials` instead of `provider:auth`,
naming the plugin they extend rather than a bare domain.

The distribution seeds its bundled services into
`<dataDirectory>/product-services` on first boot, the way a CMS lays down its
bundled plugins. From then on the operator owns them: a deleted service stays
deleted rather than reappearing on the next restart.

Fixes three defects found while proving this end to end:

- The product-services folder could only host self-contained packages. Anything
  importing `zelavis/app/auth` — nearly every real plugin — failed to load,
  because a package outside `node_modules` cannot resolve its peer dependency.
  The running Platform is now linked into the folder where Node's resolution
  walk looks for it.
- Manifest-declared capabilities never reached the loaded service, so an
  installed provider registered and was then never discovered by the plugin it
  named.
- `@zelavis/app-auth-email-password` default-exported its factory function
  rather than a service, so the loader produced no service object at all.
