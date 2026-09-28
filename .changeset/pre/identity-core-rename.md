---
"zelavis": major
"@zelavis/auth": minor
"@zelavis/app-auth-oidc": minor
---

Rename the auth core to identity, so it stops sharing a name with the package
that configures it.

Three names collided. `zelavis/app/auth` was the import subpath for the engine —
accounts, sessions, credentials, password verification, OAuth discovery and
flow. `"zelavis/auth"` was that engine's service name and capability owner, a
string that looked like an import path but resolved to nothing. `@zelavis/auth`
was, and still is, a separate removable package that only contributes the Auth
settings page and a catalogue of installable auth plugins. The engine's own
source warned that the two were "close enough to confuse, and getting it wrong
would produce a catalogue nothing ever appears in."

The engine is now identity:

- `zelavis/app/auth` → `zelavis/app/identity`, and the export subpath with it.
- Service name and capability owner `"zelavis/auth"` → `"zelavis/identity"`, so
  the string and the import path finally agree. Extensions declare
  `zelavis/identity:credentials` and `zelavis/identity:oauth`.
- `auth-service.ts` → `identity-service.ts`, `core/create-auth.ts` →
  `core/create-identity.ts`, `createAuth` → `createIdentity`, `authService` →
  `identityService`, `createAuthSubsystem` → `createIdentitySubsystem`.
- Subsystem-level types take the new prefix: `AuthApi` → `IdentityApi`, and the
  same for `AuthSubsystem`, `AuthContext`, `AuthRepositories`, `AuthEntity`,
  `AuthDocumentStore`, `AuthService*`, `AuthMethod*`, `AuthBootstrap*`,
  `AuthAuthorizationFlow*` and the domain errors.

Types whose subject is the act of signing in keep `Auth`, because they are about
authentication rather than identity: `AuthAttemptState`, `AuthRateLimitError`,
`AuthInvalidCredentialsError`, `AuthSecurityEvent` and their neighbours.
`IdentityRateLimitError` would have been less accurate than what it replaced.

`@zelavis/auth` keeps its name. It is what a person opens to configure sign-in,
and "Auth" is the word they look for; the subsystem gets the precise term and
the page keeps the familiar one. Its extension-owner constant is renamed to
`IDENTITY_EXTENSION_OWNER` and now points at `zelavis/identity`, and
`@zelavis/app-auth-oidc` declares against the new owner — without that change it
would have gone on declaring against a capability nothing owns and silently
vanished from the catalogue.

`.github/copilot-instructions.md` claimed "`@zelavis/auth` owns the auth core,"
which was the inversion this rename exists to prevent. It now says which package
owns what.

Pending changesets from earlier work still name `zelavis/auth`; they describe
changes made under that name and are left as written.
