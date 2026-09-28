---
"zelavis": minor
---

Make a fresh installation adoptable: ship a credential provider and add
`zelavis bootstrap`.

The Platform had a first-owner endpoint, password hashing, and a provider
registry, and `@zelavis/app-auth-email-password` had implemented the provider
itself — but nothing installed one. A shipped `zelavis serve` reported
`providers: []` and answered `POST /auth/bootstrap` with `Unknown
authentication provider`, so there was no supported way to create the first
account on a new box.

The binary now loads that provider the way it loads the dashboard: an optional
dependency, absent without breaking anything. Hosts embedding the Platform
offer providers through a new public `authMethods` option, because
`new Zelavis(...)` refuses `coreServices` and `serviceRegistry` and so
previously had no way to supply one. The library still names no provider of its
own.

`zelavis bootstrap` claims the first owner against a running Platform, and
`zelavis bootstrap status` reports whether an owner is still needed, whether the
bootstrap token is configured, and which providers are installed. The password
comes from an echo-suppressed prompt or `--password-stdin`; `--password` is
refused rather than accepted, because an argument is readable in shell history
and in the process list.
