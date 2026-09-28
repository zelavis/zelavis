---
"@zelavis/ui": minor
---

Declare `zelavis` as a peer dependency of the dashboard.

`@zelavis/ui`'s built output imports `zelavis/sdk` and `zelavis/service`, so it
cannot run without a Platform — but `zelavis` was only a devDependency, which
npm does not install for consumers. Anyone installing the dashboard from the
registry got a package whose code imports something nothing declared.

The range is the exact Platform version, matching `@zelavis/app`,
`@zelavis/auth` and `@zelavis/marketplace`. Zelavis is pre-release and makes
breaking changes freely, so a loose range on a package this tightly coupled
would be worse than none: it would let a dashboard resolve against a core it
was never built against.

This is what makes updating the dashboard on its own safe. An installed
`@zelavis/ui` already takes precedence over the copy bundled in the
distribution, because bundled-service resolution runs only after normal
resolution fails.
