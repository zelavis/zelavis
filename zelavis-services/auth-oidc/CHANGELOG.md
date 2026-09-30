# @zelavis/app-auth-oidc

## 2.0.0-alpha.3

### Major Changes

- cd26722: Name core auth as core, and remove the last way to switch a feature off in code.
  
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

### Minor Changes

- 61cde5e: Credential providers reach Platform auth by being installed, and nothing else.
  
  The `authMethods` constructor option and the `coreServices.auth.methods` path
  are gone. They were a second way to provide a service, and the two disagreed: a
  provider handed to composition never entered the registry, so it could not be
  listed, disabled, or updated the way the same provider installed normally
  could. A provider now arrives through one path — installation — whether from the
  services folder, the registry endpoints, or the marketplace.
  
  Auth providers declare `@zelavis/auth:credentials` instead of `provider:auth`,
  naming the plugin they extend rather than a bare domain.
  
  The distribution seeds its bundled services into
  `<dataDirectory>/services` on first boot, the way a CMS lays down its
  bundled plugins. From then on the operator owns them: a deleted service stays
  deleted rather than reappearing on the next restart.
  
  Fixes three defects found while proving this end to end:
  
  - The services folder could only host self-contained packages. Anything
    importing `zelavis/app/auth` — nearly every real plugin — failed to load,
    because a package outside `node_modules` cannot resolve its peer dependency.
    The running Platform is now linked into the folder where Node's resolution
    walk looks for it.
  - Manifest-declared capabilities never reached the loaded service, so an
    installed provider registered and was then never discovered by the plugin it
    named.
  - `@zelavis/app-auth-email-password` default-exported its factory function
    rather than a service, so the loader produced no service object at all.
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
- d64fec1: Add native-Web request authentication, opaque persisted sessions, Web Crypto
  password hashing, Basic/JWT/JWKS verifiers, and the OIDC bearer plugin. Move
  Auth plugins out of the unified package and replace the retired child-service
  graph with capability-discovered provider registration contracts. Add
  provider-owned credential enrollment, token-gated first-owner bootstrap, real
  Platform dashboard login/logout, session cookies and rotation, same-origin
  cookie issuance and mutation enforcement, and permission gates for critical
  control-plane endpoints.

### Patch Changes

- 51386bd: The ecommerce plugin declares its menu through the SDK, and the plugin loader
  stops dropping what a plugin declares.
  
  The authoring guide's Rule 4 tells plugin authors to use `zelavis/sdk` for
  menus, routes, commands and events. The flagship example plugin used a `menu`
  field on its exported object instead — which works, because the loader merges
  both, but a first-party plugin contradicting a documented rule is how the rule
  stops sticking. It now calls `zelavis.plugins.ui.menus.create`.
  
  That only works inside a plugin execution context, so the plugin has to be
  loaded rather than imported and passed around as a live object. Which turned up
  the real problem: `loadPluginPackage` built its service object field by field
  and omitted `setup`, `runtimeServices`, `app`, `project`, `scope` and
  `authenticators`. The ecommerce plugin registers its whole `commerce` API
  during setup, so installing it as a package produced a service with a menu and
  no endpoints, while composing the same object in code worked — the supported
  path was the broken one.
  
  Breaking: `ecommercePlugin` can no longer be imported and used directly. Load
  it through `loadPluginPackage` with the exported `ECOMMERCE_MANIFEST`, which is
  what an installation does.
  
  Also clears what an audit of the first-party plugins turned up:
  
  - Both payment gateways still carried a legacy `main` field, which the manifest
    contract refuses — so even with the `zelavis` block added they could not have
    been installed.
  - `@zelavis/ecommerce` declared its capabilities only on the service object,
    not in its manifest, unlike every other plugin.
  - `@zelavis/app-auth-oidc` exported an `oidcService` alias nothing imported.
  - The ecommerce README documented `kind: "provider"`, removed with the taxonomy.
  
  A test now validates every first-party manifest against the real contract, so
  they cannot drift back.
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
