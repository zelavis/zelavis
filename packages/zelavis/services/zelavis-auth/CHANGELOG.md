# @zelavis/auth

## 1.1.0-alpha.16

### Patch Changes

- Updated dependencies
  - zelavis@2.0.0-alpha.16

## 1.1.0-alpha.15

### Patch Changes

- Updated dependencies
  - zelavis@2.0.0-alpha.15

## 1.1.0-alpha.14

### Patch Changes

- Updated dependencies
  - zelavis@2.0.0-alpha.14

## 1.1.0-alpha.13

### Patch Changes

- Updated dependencies
  - zelavis@2.0.0-alpha.13

## 1.1.0-alpha.12

### Patch Changes

- Updated dependencies [bbe74e4]
- Updated dependencies
- Updated dependencies
  - zelavis@2.0.0-alpha.12

## 1.1.0-alpha.11

### Patch Changes

- Updated dependencies [4105a52]
  - zelavis@2.0.0-alpha.11

## 1.1.0-alpha.10

### Patch Changes

- Updated dependencies [587d43e]
  - zelavis@2.0.0-alpha.10

## 1.1.0-alpha.9

### Patch Changes

- Updated dependencies [5027eb8]
  - zelavis@2.0.0-alpha.9

## 1.1.0-alpha.8

### Patch Changes

- Updated dependencies [e2f9e9c]
  - zelavis@2.0.0-alpha.8

## 1.1.0-alpha.7

### Patch Changes

- Updated dependencies [02a8ba1]
  - zelavis@2.0.0-alpha.7

## 1.1.0-alpha.6

### Patch Changes

- Updated dependencies [f22ba11]
- Updated dependencies [9a51a3c]
- Updated dependencies [15e0ed3]
- Updated dependencies [57ba50a]
- Updated dependencies [1c5ecbc]
  - zelavis@2.0.0-alpha.6

## 1.1.0-alpha.5

### Patch Changes

- Updated dependencies
  - zelavis@2.0.0-alpha.5

## 1.1.0-alpha.4

### Patch Changes

- Updated dependencies
  - zelavis@2.0.0-alpha.4

## 1.1.0-alpha.3

### Minor Changes

- 313b7a2: Add the auth settings page as a product service, and stop a stale session
  cookie from locking people out.

  `@zelavis/auth` is a page, not an auth implementation. Accounts, sessions,
  credentials, password verification and the OAuth flow stay in Zelavis, where an
  installation cannot run without them. What a package can usefully own is the
  face: a settings page showing how people sign in, the OAuth providers
  configured for this installation, and a catalogue of the plugins that extend
  auth — scoped to `zelavis/auth`, because a general list of everything
  installable does not say which of it is a sign-in method.

  Removing it costs the page, not the ability to sign in. It ships beside
  `@zelavis/ui` and `@zelavis/marketplace` and is loaded through the same plugin
  loader an installed third-party service goes through, so its menu reaches the
  dashboard through the ordinary extension path rather than a private one.

  Core auth no longer contributes its own dashboard menu. With both contributing
  one, the sidebar carried two "Auth" entries and the one without a page led
  nowhere.

  Fixes a lockout: a session cookie that no longer resolves — expired, revoked,
  or left over from another installation on the same host — made the request fail
  outright, so the public sign-in and bootstrap endpoints answered 401 and the
  only way through was clearing cookies by hand. A cookie is ambient, attached by
  the browser whether or not the caller meant to authenticate, so one that does
  not resolve now means "not signed in". A bearer token is an assertion the
  caller chose to make, and an invalid one is still an error.

  Discovery failures also name the URL that could not be reached, rather than
  surfacing the transport's "fetch failed".
- 3bf1481: Rename the auth core to identity, so it stops sharing a name with the package
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

### Patch Changes

- 6a8c8c2: Automatically detect and resolve package.json manifests across all services and plugins, eliminate manifest.ts files, and extract @zelavis/app as an official kind: "app" service.
- Updated dependencies [df8fcf2]
- Updated dependencies [d2b22c4]
- Updated dependencies [49177f0]
- Updated dependencies [71c1c4f]
- Updated dependencies [a59cfad]
- Updated dependencies [cd26722]
- Updated dependencies [61cde5e]
- Updated dependencies [3bf1481]
- Updated dependencies [313b7a2]
- Updated dependencies [48dbb58]
- Updated dependencies [448e097]
- Updated dependencies [c56a596]
- Updated dependencies [344368e]
- Updated dependencies [ac8daa0]
- Updated dependencies [493e2b5]
- Updated dependencies [874e983]
- Updated dependencies [7a32736]
- Updated dependencies [7bf02e0]
- Updated dependencies [3663b43]
- Updated dependencies [9957059]
- Updated dependencies [de5f3fe]
- Updated dependencies [f68f2da]
- Updated dependencies [3dbc353]
- Updated dependencies [48dbb58]
- Updated dependencies [2ffffbb]
- Updated dependencies [88c4f0e]
- Updated dependencies [48dbb58]
- Updated dependencies [694ae12]
- Updated dependencies [48dbb58]
- Updated dependencies [7e5cc15]
- Updated dependencies [62b2e91]
- Updated dependencies [ffb15fc]
- Updated dependencies [2833e08]
- Updated dependencies [503b6c0]
- Updated dependencies [48dbb58]
- Updated dependencies [349549b]
- Updated dependencies [0e6fdc5]
- Updated dependencies [0e6fdc5]
- Updated dependencies [ebab0bb]
- Updated dependencies [6aac906]
- Updated dependencies [c5147b4]
- Updated dependencies [89cf8f8]
- Updated dependencies [54c5aec]
- Updated dependencies [8801b18]
- Updated dependencies [1b40406]
- Updated dependencies [b1c76c5]
- Updated dependencies [ca8af30]
- Updated dependencies [79ebf23]
- Updated dependencies [0dd7c6d]
- Updated dependencies [907894c]
- Updated dependencies [0a2c8c7]
- Updated dependencies [48dbb58]
- Updated dependencies [48dbb58]
- Updated dependencies [48dbb58]
- Updated dependencies [14f77fd]
- Updated dependencies [3db7ee9]
- Updated dependencies [81c8c07]
- Updated dependencies [727a371]
- Updated dependencies [3808410]
- Updated dependencies [7d8b5e6]
- Updated dependencies [12e430f]
- Updated dependencies [51386bd]
- Updated dependencies [78b5839]
- Updated dependencies [48dbb58]
- Updated dependencies [6a8c8c2]
- Updated dependencies [4d3ba56]
- Updated dependencies [6f057e5]
- Updated dependencies [493e2b5]
- Updated dependencies [36f7a76]
- Updated dependencies [d6be1ca]
- Updated dependencies [09ca0f1]
- Updated dependencies [ddc8b7a]
- Updated dependencies [ae6614c]
- Updated dependencies [8f57dc5]
- Updated dependencies [8f99bdf]
- Updated dependencies [d64fec1]
- Updated dependencies [727d95d]
- Updated dependencies [36b8646]
- Updated dependencies [48dbb58]
- Updated dependencies [3bf1481]
- Updated dependencies [48dbb58]
- Updated dependencies [48dbb58]
- Updated dependencies [61a9b45]
- Updated dependencies [d64fec1]
- Updated dependencies [60afafa]
- Updated dependencies [60afafa]
- Updated dependencies [d7bd476]
- Updated dependencies [48dbb58]
- Updated dependencies [48dbb58]
- Updated dependencies [48dbb58]
- Updated dependencies [d8d6880]
- Updated dependencies [8443cb8]
- Updated dependencies [81554ed]
- Updated dependencies [d6a33d1]
- Updated dependencies [8887ddb]
- Updated dependencies [d8d6880]
- Updated dependencies [820e6fd]
- Updated dependencies [d3c94f4]
- Updated dependencies [493e2b5]
- Updated dependencies [d54621c]
- Updated dependencies [e03f7ce]
- Updated dependencies [48dbb58]
- Updated dependencies [0bf279e]
- Updated dependencies [d1ce99d]
- Updated dependencies [d8d6880]
- Updated dependencies [3bf1481]
- Updated dependencies [aa3d4e2]
- Updated dependencies [d83f942]
- Updated dependencies [48dbb58]
- Updated dependencies [e4eb275]
- Updated dependencies [6b293f4]
- Updated dependencies [4f8f3ef]
- Updated dependencies [8e31941]
- Updated dependencies [a770ab4]
- Updated dependencies [6bf7f95]
- Updated dependencies [abcce55]
- Updated dependencies [509067a]
- Updated dependencies [55ee49f]
- Updated dependencies [28bde9d]
- Updated dependencies [36a7877]
- Updated dependencies [43540af]
- Updated dependencies [48dbb58]
- Updated dependencies [d03bd81]
- Updated dependencies [565846d]
- Updated dependencies [48dbb58]
- Updated dependencies [2272870]
- Updated dependencies [8a8156c]
- Updated dependencies [344ace8]
- Updated dependencies [40314af]
- Updated dependencies [1b8c0b7]
- Updated dependencies [5359178]
  - zelavis@2.0.0-alpha.3
