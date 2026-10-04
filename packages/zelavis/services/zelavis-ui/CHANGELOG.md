# @zelavis/ui

## 1.1.0-alpha.17

### Patch Changes

- Updated dependencies
  - zelavis@2.0.0-alpha.17

## 1.1.0-alpha.16

### Patch Changes

- Share Node Platform and App engine factories, and use Effect scopes to close HTTP before stores during shutdown and failed startup. Add shared Effect admission and handover primitives and a Node supervisor with streaming ingress, exclusive writer transfer, generation checks and rollback, exercised against both actual runtime compositions.

  Add immutable recipe snapshots, a scoped kernel-locked journal with flushed release/generation checkpoints, and a Gateway broker that preserves replay protection and queued authorization across worker replacement. Reserve a fresh generation for every update attempt, including aborted drains, and bound the complete readiness probe.

  Run native Apps behind a persistent host and allow qualified running recipe upgrades through the existing HTTP, SDK, CLI and dashboard action. Persist an unfinished Project update, freeze the candidate separately, and acknowledge the Platform recipe lock before admission resumes. Failed lock commits roll back; reconciliation settles lost replies from proved host selection. Preserve deletion precedence and re-key surviving Gateway hosts over the Agent pipe.

  Seal full engine artifacts including their private Node and dependency-link graph, execute installed App locks through the exact release catalog, and retain qualified engine versions during Platform updates. Stage releases through the same script-disabled npm transport used by installations.

  Run the main Platform behind the same persistent host. Dashboard updates prepare an immutable release, drain accepted requests, transfer exclusive store ownership, probe adoption of running Projects, and acknowledge the root-owned receipt, current link and public version descriptor before resuming traffic. Preview listeners share admission and remain bound during transfer and rollback. User installations use the same handover.

  Enable the separately supervised Project Agent for every system installation; remove the optional Agent flag. Adopt WordPress daemon handles by exact execution identity and put Linux Unix sockets in shared installation data so the Platform and Agent can use them across separate private temporary directories. Preserve Project placement custody across engine replacement. Unexpected engine exit wakes the host for supervised restart.

  Explicit native App recipe upgrades select the latest qualified installed engine. New Apps use that same default, even on an older parent; parent upgrades and rollbacks preserve existing App engine pins. Public older-version selection controls remain planned.

  Breaking installation transition: installations without the persistent host and versioned runtime inventory need one full local installer run, which restarts the old process. The live installer refuses unsupported handover protocols; there is no legacy execution shim.
- Updated dependencies
  - zelavis@2.0.0-alpha.16

  Persist status refreshes under the same Project lifecycle permit as upgrades so a stale read cannot overwrite a recipe lock, update intent or deletion tombstone. Fleet views remain read-only for Fabric scheduling. Keep ordinary Platform startup ready while desired-running Projects reconcile asynchronously; require adoption proof only for engine handover.

## 1.1.0-alpha.15

### Patch Changes

- Updated dependencies
  - zelavis@2.0.0-alpha.15

## 1.1.0-alpha.14

### Patch Changes

- Fix custom recipe upgrades to freeze and execute the selected version, including relative imports, and restore the previous recipe and host descriptor when preparation fails. Allow exact-Project deletion after provisioning fails before a descriptor exists while preserving genuine cleanup errors. Refresh failed dashboard actions and show pending deletion with disabled lifecycle controls and explicit Retry deletion.
- Updated dependencies
  - zelavis@2.0.0-alpha.14

## 1.1.0-alpha.13

### Patch Changes

- Publish local Project sites through stable, separate HTTP preview ports. Dashboard site and WordPress Admin links use the server hostname instead of a private loopback address. Preserve site redirects and login cookies while withholding Platform credentials and refusing cross-origin cookie mutations.
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

### Minor Changes

- Declare `zelavis` as a peer dependency of the dashboard.

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

### Patch Changes

- zelavis@2.0.0-alpha.4

## 1.1.0-alpha.3

### Minor Changes

- 3bf1481: Complete the first official Auth client surface and separate software,
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
- 7bf02e0: `@zelavis/ui` is now `kind: "frontend"` rather than a plugin that happens to
  serve HTML. Its manifest declares the frontend it is — a static frontend over
  the `build/client` bundle the package already ships — so validating it against
  the frontend contract passes rather than being a label.

  It stays composed rather than loaded from that manifest, which is what lets it
  supply an `app.shell`. The installation's root path is a runtime setting, so
  the built SPA's absolute asset references are rewritten per request, and a JSON
  manifest cannot express a render function.
- 81c8c07: The Platform no longer depends on `@zelavis/ui`. It was a hard dependency
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
- 493e2b5: Add a guided `zelavis setup` terminal wizard and a first-open dashboard setup
  wizard, both backed by the existing durable first-owner bootstrap operation.
- 8f57dc5: Make a frontend installable at any mount, not only the one it was built for.

  A static bundle bakes its client-side router base path into the page it serves,
  so the Platform rewrote React Router's `basename` literal on the way out. That
  worked only because the Platform knew which framework it was serving: a
  frontend could be supplied by an installation, but never installed at a path of
  someone's choosing, which is the one thing a frontend manifest could not
  express.

  A frontend now declares `frontend.basePathGlobal` in its manifest, and the
  Platform defines that global on the served page with the mount path. Nothing in
  core knows what reads it. `@zelavis/ui` declares it and ships a small script
  that applies the value to its router before hydration, so one build serves from
  `/`, `/zelavis`, or anywhere else. The `basename` rewrite is gone.

  Fixes unquoted CSS references never being rewritten. Both rewriters anchored on
  an opening quote, but CSS writes `url(/assets/font.woff2)` with none — so every
  font and background image on a mounted installation pointed at the server root
  and 404ed. Verified in a browser: the dashboard now renders at `/admin` with
  fonts loading from `/admin/assets/`.

  The injected value escapes `<` as well as JSON-encoding it. The HTML parser
  ends a script element at the first `</script>` even inside a string literal, so
  a mount containing one would otherwise close the element.
- 60afafa: Add an official native WordPress Project recipe with automatic host-stack provisioning, dedicated Nginx, PHP-FPM, and MariaDB lifecycle, robust Homebrew executable discovery and short private runtime sockets, actionable lifecycle errors, and managed-project dashboard creation and navigation. Persist explicit per-Project runtime assignments and recipe compatibility, expose native runtime availability through the API and dashboard, repair historical records to native, and reject unavailable Docker assignments without changing existing Projects.

  Add backend-neutral deployment capability detection and durable administrator policy, a read-only Node Docker probe, permission-gated backend endpoints and Server UI, and a verified authority-gated host-operation executor foundation. Backend choice is now server policy rather than an ordinary Project creation option; Docker installation, Docker Project execution, migration, and hardened native isolation remain explicitly unavailable.

  Centralize deployment adapters under the new `zelavis/backends` surface with built-in `native` and `docker` modules. Add `zelavis/agent` contracts and a durable Agent operation journal with stable identity, operation-bound HMAC authority, atomic leases, bounded concurrency, replay-safe IDs, restart recovery, redacted audit summaries, and permission-gated read endpoints. Separately supervised IPC and registered privileged installation operations remain future work.
- 820e6fd: Standardize **Project recipe** as the create-project term across the runtime,
  API, dashboard, and documentation. Project recipes remain services with
  `kind: "app"`; a `plugin` extends the Platform or a Project runtime without
  being something a Project can be created from.

  Rename the recipe discovery endpoint to
  `GET /zelavis/api/v1/runtime/project-recipes`, rename project creation input
  from `appServiceName` to `recipeName`, and expose the locked Project definition
  as `project.recipe` instead of `project.app`. Existing persisted Project records
  using the former `app` field are migrated and rewritten on read.
- 493e2b5: Add the proxy-neutral Zelavis Edge switch transaction, canonical route publication
  store, Traefik dynamic compiler, release-signed Agent host operations for staging,
  validation, unit control, probing, atomic active exchange, drain, and rollback, Traefik
  edge adapter and certificate distributor, distributed fencing and startup reconciliation
  with crash recovery for interrupted cutovers, stale-generation publication refusal,
  alternate-adapter conformance proving roundtrip proxy switching (Traefik -> Caddy -> Traefik)
  preserves canonical routes, hostnames, certs, and projects with zero mutations,
  Edge certificate controller with pure RFC 8555 ACME v2 client, ASN.1 DER PKCS#10 CSR generator,
  AES-256-GCM encrypted private key confidentiality in System Store, HTTP-01 challenge responder,
  Traefik port 80 challenge bypass, automated renewal scheduling, and first-run hostname
  onboarding with DNS preflight across HTTP, SDK, CLI setup, and the dashboard setup wizard.
- a770ab4: Retire the built-in website content model.

  The website core service owned a fixed page shape and rendered it with a single
  hardcoded HTML template. Services have long had a richer mechanism for serving a
  frontend — `ZelavisServiceAppDefinition`, with bundles, SPA and MPA modes, a
  shell, and a dev URL — so the page model was a weaker parallel path.

  A Project that has not chosen a frontend now serves an explicit placeholder at
  its public paths, answering `503` with `no-store` and `noindex` rather than a
  `404`, so an unfinished Project reads as unfinished rather than broken. Control
  plane and API paths keep their own `404`s.

  Removes `renderWebsitePage`, the website page types, the database and file
  storage page stores, and the `website/pages` endpoints. The `@zelavis/website`
  service is replaced by `@zelavis/frontend`, and the dashboard's Website area
  becomes Frontend.
- 28bde9d: Collapse the service kind taxonomy to `app`, `frontend`, and `plugin`, and
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

### Patch Changes

- df8fcf2: Add a tabbed schema builder to the database dashboard.
- 26eb5ee: Build and typecheck the dashboard again. Lexical packages are all on 0.51 and
  `@assistant-ui/react` is on 0.15.20, so each family resolves to one copy; the
  split upgrades had left two Lexical versions with incompatible types and an
  `assistant-cloud` without the `ai-sdk` export the new core imports.
- d3d4f0e: Fix login and first-owner bootstrap in the two-origin dev setup.

  The runtime issues session cookies only to same-origin requests. Vite's
  `changeOrigin` rewrites `Host` but forwards the browser's `Origin`, so a
  dashboard on the dev server (e.g. `http://127.0.0.1:3001`) reached a runtime on
  another origin (e.g. `http://127.0.0.1:3000`) and every `set-cookie` was
  silently dropped. Login returned 200 and the dashboard stayed unauthenticated.
  The dev proxy now forwards the runtime's own origin, which is what the browser
  actually sees.

  `returnTo` is now router-relative and sanitized where it is consumed. It was
  built from the browser pathname, which includes the router basename, then
  resolved through `navigate()`, which prepends the basename again — sending a
  mounted dashboard to `/zelavis/zelavis/` after sign-in, and accumulating one
  extra level per failed attempt. Every leading repetition of the basename is now
  stripped, so an already-nested URL collapses back to a usable route instead of
  growing. `returnTo` is untrusted URL input, so protocol-relative and absolute
  destinations are rejected rather than followed.
- 36f7a76: Restore a green typecheck on main.

  Align every `lexical` and `@lexical/*` package on `^0.49.0`. `@lexical/link`
  and `@lexical/rich-text` were left on `^0.46.0` by separate dependency bumps, so
  `HeadingNode` and `QuoteNode` came from a different copy of the library than the
  `ElementNode` they must be assignable to.

  Export only the runtime-neutral backend contracts from the root entrypoint. The
  concrete Native and Docker deployment backends import `node:` built-ins, and
  re-exporting them from the root meant a fetch-native host could not typecheck
  `zelavis` at all. They remain available through the `zelavis/backends` subpath,
  which is where the Node adapter already imports them from.
- 3ea6c0f: Upgrade React Router to 8.3.1 as one coordinated bump across `react-router`,
  `@react-router/dev`, `@react-router/node`, and `@react-router/serve`, so the
  framework packages never sit on split majors.

  `UIMatch` no longer carries the deprecated `data` property; only `loaderData`
  remains. No application code read it — the field was only set in a test fixture.
- 8e31941: Retire the `zelavis.service.json` sidecar. Services and plugins are configured
  through the `package.json` `zelavis` namespace and standard ESM `exports`, the
  same as any other npm package.

  Uploaded service packages now read their entry from `package.json` `exports`
  through the shared manifest validator. A package configured only by the retired
  sidecar is refused rather than silently installed.
- 2272870: Align Assistant UI Core with Assistant React, keep all Lexical packages on one
  version, and remove a duplicate `isbot` dependency declaration so development
  dependency optimization and dashboard typechecking succeed. Pre-optimize every
  Base UI entrypoint used by the dashboard to prevent stale dependency hashes on
  first load, and render an accessible hydration fallback while client modules
  and root data are loading.
