---
"zelavis": minor
"@zelavis/auth": minor
"@zelavis/auth-providers": minor
"@zelavis/app-auth-oidc": major
---

Add `@zelavis/auth`, the OAuth layer above core auth, and the provider
definitions that extend it.

Core auth owns accounts, sessions, credentials, permissions, and the
Authorization Code flow. `@zelavis/auth` sits above it: it discovers identity
provider definitions from plugins declaring `@zelavis/auth:oauth`, pairs each
with the credentials an operator configured, and registers the result with core
auth. `@zelavis/auth-providers` ships Google, GitHub, and a builder for any
OpenID Connect issuer.

The split follows who has what. A provider plugin knows a provider's endpoints
and claim shapes and can ship them; only the operator has the client id and
secret their installation was issued. A package needing the second could never
be installed, only composed in code — and services are not composed any more.

This needed two things core did not have:

- **Installed services could not persist anything.** The setup context reported
  whether the host had a key-value store but never handed one over, and there
  is no constructor left to pass one through. Services now receive a store
  whose namespace is fixed to the service that asked, so a plugin cannot reach
  another's records.
- **A credential provider registered before services were set up**, so a plugin
  hosting other plugins' providers could not see them or read what an operator
  had saved. `AuthMethodPlugin.register` now receives the installed services
  and its own store.

`@zelavis/app-auth-oidc` is now only a JWT bearer authenticator for callers
already holding a token. Its Authorization Code half is superseded by
`@zelavis/auth`; two implementations of one exchange drift, and only one can be
the one an operator configured.
