---
"zelavis": major
"@zelavis/app-auth-oidc": major
---

Name core auth as core, and remove the last way to switch a feature off in code.

Accounts, sessions, credentials, and roles/permissions are part of Zelavis
itself, so the service is now `zelavis/auth`, alongside `zelavis/platform`,
`zelavis/fabric`, and `zelavis/app`. Scoped `@zelavis/*` names belong to
installable packages, which frees `@zelavis/auth` for the plugin layer that
brings OAuth and the providers extending it.

Providers declare `zelavis/auth:credentials`. Capability owners may now be core
service names as well as package names, since both own capabilities.

`frontend: false` is gone. Having no frontend is expressed by installing none,
and the root path says so — a second code-level switch meant the same thing
twice and let the two contradict each other. Two tests were passing a frontend
factory *and* `frontend: false` as duplicate keys, silently supplying a
frontend that was then discarded.

What that flag really encoded was the kind of runtime, so `role` now says it:
a Platform leads `/` to its root path, and a Project serves its own "no
frontend yet" placeholder rather than bouncing to a Platform page.

The no-frontend page is now served only at the root path. It previously claimed
every path beneath it, the way an installed frontend does — but an installed
frontend routes those paths client-side and this page routes nothing, so a
mistyped path was answered with 200 HTML instead of a 404.
