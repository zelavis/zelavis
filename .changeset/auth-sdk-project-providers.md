---
"zelavis": minor
"@zelavis/ui": minor
---

Complete the first official Auth client surface and separate software,
Platform, and Project identities.

The typed SDK now covers password registration and sign-in, OAuth redirects,
identity linking, session inspection/rotation/logout, Project provider
settings, and Platform service-account creation, token rotation, and
revocation. The CLI exposes the same service-account lifecycle.

Zelavis App Projects ship password registration and persist their own OAuth or
OpenID Connect configuration in the Project database. The Project Auth page
can configure GitHub, Google, and issuer-discovered OIDC providers without
sharing secrets with the Platform or another Project.

Platform Access can create scoped service identities for Fluxgent, CI, agents,
and other software. Their one-time tokens authenticate as `service`
principals, can be rotated or revoked, and no longer require copying an owner's
browser session into an application.
