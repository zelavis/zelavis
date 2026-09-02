---
"zelavis": minor
"@zelavis/ui": minor
"@zelavis/marketplace": minor
---

Collapse the service kind taxonomy to `app`, `frontend`, and `plugin`, and
enforce it at manifest validation.

`frontend` was missing from `ZelavisServiceKind` despite being the kind the
Platform branches on most — it has its own load path, a `zelavis.frontend`
manifest block, and Gateway routing. Meanwhile `core`, `web-app`, `website`,
`dashboard-extension`, `provider`, and `template` were declared, documented,
and never read by anything.

`core` is removed rather than kept: it described who shipped a service rather
than what it is, which `scope` (`system` versus `extension`) already carries
and which the dashboard now enforces. Every service the Platform composes is a
`plugin`. A provider is discovered by its capability (`provider:auth`), never
by a kind.

An unrecognised kind is now refused. It previously loaded fine and produced a
service that silently never participated in anything, which is also how the
union drifted out of date in the first place.
