---
"zelavis": minor
---

Discover services from a `product-services` folder on the server, and let a
plugin declare whose contract it satisfies.

The folder was only ever a convention — the shipped placeholder told operators
to drop a frontend package into `product-services`, and nothing scanned it. The
Node adapter now reads `<dataDirectory>/product-services/*/package.json` at
boot, validates each manifest, and registers what it finds through the same
importer and validation as any installed service. Scoped packages nest one
level deeper, as in `node_modules`. Pass `productServices: false` to scan
nothing.

Discovery refuses rather than trusts: an `exports` entry resolving outside its
own package directory, a missing entry file, an invalid manifest, and any
package claiming a reserved core service name are all skipped with a reason.
A package that fails to load is skipped too, so one broken download cannot stop
a Platform from booting.

Capabilities may now be owned by the package that defines them —
`@zelavis/auth:credentials` alongside the existing `provider:auth` — and are
validated at manifest time. Domain-namespaced capabilities say what interface a
plugin implements but never whose contract it satisfies, so two commerce
plugins both scanning `provider:payments` pick up each other's providers.
Discovery stays a flat scan with no parent/child graph: naming an owner asks to
be considered by it and grants nothing, and the owning plugin still validates
every provider against its own registration contract.

Also fixes runtime option merging silently dropping `manifestResolver`, which
discarded the adapter-supplied resolver whenever adapter and host options were
combined.
