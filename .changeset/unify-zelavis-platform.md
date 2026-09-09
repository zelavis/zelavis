---
"zelavis": major
"@zelavis/ecommerce": major
"@zelavis/ecommerce-paypal": major
"@zelavis/ecommerce-stripe": major
---

Consolidate the reusable server/Fabric engine, built-in App recipe, App Auth,
App Database, Workloads, and trusted Platform services into the unified
`zelavis` package with focused public subpaths. Add typed runtime lifecycle,
artifact/provider contracts, deterministic Fabric replica planning, and exact
per-Project App version locks that parent Platform upgrades preserve. Project
deletion now persists resumable cleanup progress and removes Project-owned
Assistant threads, domain bindings, bundle assets, and runtime data before the
registry record disappears.

This intentionally removes the previous standalone package entry points and is
a breaking release with no compatibility aliases.
