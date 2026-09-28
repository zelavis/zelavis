---
"zelavis": major
"@zelavis/ui": minor
---

The Platform no longer depends on `@zelavis/ui`. It was a hard dependency
imported at module load, so removing the package stopped `zelavis` from loading
at all rather than leaving an installation with no frontend.

A frontend is now supplied through the new `frontend` option, and
`@zelavis/ui/frontend` exports the dashboard as one. An installation with no
frontend serves its complete API and explains itself at the root path instead
of returning a 404. `coreServices.dashboard: false` still serves nothing there,
which is Zelavis embedded as an API on purpose rather than a missing frontend.

Design tokens for service pages come from the installed frontend, falling back
to a neutral baseline in the browser's own colours so a service page renders
legibly with no frontend at all.

**Breaking:** an application composing `zelavis()` or `new Zelavis()` and
expecting a dashboard must now pass `frontend: zelavisUiFrontend` from
`@zelavis/ui/frontend`.
