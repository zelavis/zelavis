# zelavis

## 2.0.0-alpha.11

### Patch Changes

- 4105a52: Updates no longer interrupt the dashboard. systemd holds each instance's port in a socket unit, an update prepares the new release while the old one keeps serving and then swaps once, so connections queue instead of being refused (no failed requests in a test that probed every 50 ms). Named instances update from their own dashboard, and user-mode installs (macOS, Linux without systemd) update by selecting the new release and asking for a restart. Run the installer once to add the socket; every update after that is live.

## 2.0.0-alpha.10

### Minor Changes

- 587d43e: Update a server from its own dashboard. The Platform checks npm for a newer version on its channel (at start and every six hours), a banner offers **Update now** on every page, and Settings has an Updates card; `zelavis update status|check|apply [--wait]`, `client.updates` and `GET /runtime/updates`, `POST /runtime/updates/check` and `/apply` do the same (`system.updates.view` / `system.updates.manage`). The unprivileged Platform only drops a request; a root-owned `zelavis-update.path` unit starts `zelavis update --run`, which looks up the newest version itself (never taking one from the request), refuses anything not newer, runs the installer embedded in the installed release, waits for the new release to answer, and rolls back to the previous release if it does not. The installer sets the two units up for the default system instance, `zelavis doctor` reports whether updates are armed (`update-watch`), and complete uninstall removes the units and the `<data>/update` folder. User-mode installs, named instances and macOS still update by running the installer again.

## 2.0.0-alpha.9

### Minor Changes

- 5027eb8: A server install ends with a URL you can open. The default instance of a systemd installation now listens on all interfaces at port 3000 instead of loopback, and the installer prints `http://<server-ip>:3000/zelavis` with the first-owner token, so there is no SSH tunnel to set up. The token still decides who may claim the owner account, the address is plain HTTP until the setup wizard's hostname step adds HTTPS, and there is no loopback-only server mode. User-mode installs and named instances stay on `127.0.0.1` unless given `--public`. Re-running the installer applies the new bind.

## 2.0.0-alpha.8

### Patch Changes

- e2f9e9c: Fix the Platform service crash-looping on a real Linux host. The Edge ownership lock lives in the root-owned installation prefix, and SQLite writes a database header (needing a journal file in that directory) the first time anyone locks an empty file, which the unprivileged service user cannot do, so every start failed with a misleading "already reserved". The installer now initializes the lock file as root and the service only takes the lock. Re-running the installer repairs an existing install. Ownership errors now name the real cause instead of always saying the lock is reserved.

## 2.0.0-alpha.7

### Patch Changes

- 02a8ba1: Remove the last native dependency. The local System Store now uses Node's built-in `node:sqlite` instead of `better-sqlite3`, which ships no prebuilt binaries and so needed a compiler (`make`, a C++ toolchain) on the server and failed to install on a plain Debian/Ubuntu host. The bootstrap no longer rebuilds anything, and the launcher silences Node's experimental-SQLite warning. The installed tree is plain JavaScript on the private Node.

## 2.0.0-alpha.6

### Minor Changes

- f22ba11: Install named Linux/systemd instances with isolated data, config, accounts,
  tokens, ports and independently selected private-Node releases. All entries
  continue using one TypeScript installation plan and canonical release templates.
  Only default may own host Edge, enforced by its persistent record and kernel
  reservation; secondary instances run with Edge off. Doctor and complete removal
  select an instance locally. Removing one preserves shared releases, commands,
  unit templates and package state until the last instance is removed. Debian
  packages own only an incoming payload; persistent releases and current links
  are installer-owned, so package upgrades retain versions selected by other instances.
  Receipts now record the selected port and Edge authority; old pre-release
  receipts are refused without migration. Zero-downtime updates remain planned.
  
  Exclude handed-down allow-list cache files and their exact atomic-write temporary
  names before collecting remote Project snapshots, avoiding a rename race during
  Agent dispatch while continuing to refuse other local Project data.
  Register graceful CLI shutdown before HTTP readiness so an immediate service
  stop closes the selected instance's data ownership cleanly.
- 9a51a3c: Add host-local installation ownership guards and read-only `zelavis doctor`. Install/removal are serialized by a kernel-released installer lock; Node/Bun Platform startup and maintenance share one data guard. Current receipts record source, entry, mode, instance, version and paths, and package/create installs use the same receipt-owned removal inventory. Foreign layouts, live data owners and occupied port 3000 are refused; force only permits command replacement. Old pre-release receipt shapes are refused without migration.
  
  Create forwards the invoking PATH only for conflict inspection while privileged bootstrap commands retain a fixed trusted PATH. Doctor reports installation, service, port and Agent host-feature state without changing files or taking locks. System repair/upgrade can stop and restart a matching owned Platform; zero-downtime updates and named instances remain planned.
- 15e0ed3: Move native release installation and complete uninstall into inspectable TypeScript plans with an injectable host. The installer entries now call `zelavis install` (`--from-release` for a staged tree such as a Debian package's); release templates remain the source for units and configuration. Keep existing tokens, account ownership and foreign-command diagnostics. Native services now bind to 127.0.0.1 by default; `--public` explicitly binds to all interfaces. Package acquisition, create-command changes, singleton locks and named instances remain planned.
- 57ba50a: Distribute through npm alone. A release is the published `zelavis` package: `install.sh` and `npm create zelavis` fetch the Node version the release pins from nodejs.org (checked against its published SHA-256) and the exact package from npm, run `npm install` with install scripts off and rebuild only `better-sqlite3`, then run `zelavis install --from-npm`, which assembles the release tree from the package's own installation assets. There are no release archives, GitHub release workflow, APT repository build, GPG keys, signing keys or CI secrets, and `zelavis install --from package` and `--source` are replaced by `--from-npm`.
  
  Host operations are plain manifests in the root-owned operations tree (the Agent refuses a manifest that is not a regular root-owned file that is not group- or world-writable when root ownership is required) and the Agent no longer takes `--operation-trust`. The marketplace allow-list is plain JSON served over https from `https://zelavis.com/allowlist.json`: the signed envelope, trusted keys and mirror sources are gone, while the sequence floor, expiry, https-only, no-redirect and size bounds stay. Release is `npm publish`; `pnpm allowlist publish` writes the list the website serves. The Platform-to-Agent authority key is unchanged. Receipts record entry `script` instead of `archive`, and the complete-uninstall inventory no longer covers an APT source or keyring.
- 1c5ecbc: Replace folder scaffolding with a machine installation through the shared Zelavis installer. Create selects the exact Platform version and uses a private Node in system or user mode. System elevation acquires a fresh root-owned tree rather than executing package-cache files as root.
  
  Add `zelavis install --from-npm <prepared-tree>` and `--user`, preserve the versioned release layout, and include user data/configuration/token/receipt in complete uninstall. The launcher never falls back to host Node. Singleton locking, doctor and named instances remain planned.

## 2.0.0-alpha.5

### Patch Changes

- Services resolve `zelavis` and `effect` from the Platform and must carry the rest; update and uninstall report when a restart is advisable; unreferenced installed packages are pruned; `npm create zelavis` scaffolds a Platform with a services folder.

## 2.0.0-alpha.4

### Major Changes

- Resolve the bundled core services from the distribution instead of node_modules.
  
  `zelavis` ships `@zelavis/app`, `@zelavis/auth`, `@zelavis/marketplace` and
  `@zelavis/ui` inside its own `services/` folder, but resolved them by bare name
  through `import.meta.resolve`, which looks in `node_modules` and finds nothing
  there. Making that work required declaring all four as registry dependencies,
  so the package could not be installed until each had been published on its own
  — and two of them never had been.
  
  Resolution now falls back to the folder that already ships beside the code.
  Both the importer and the manifest resolver consult an index of
  `services/*/package.json` when ordinary resolution finds nothing. An installed
  copy of the same name still wins, because the fallback runs only after the
  normal path fails, and the importer falls through only on `ERR_MODULE_NOT_FOUND`
  so a package that throws while loading still surfaces its own error.
  
  The four names are devDependencies now. The distribution installs and runs
  standalone.

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
- c56a596: `@zelavis/cli` is now `zelavis/cli`. The command layer moves into the Platform
  package as its own build target, keeping the same `zelavis` binary and the same
  separation between parsing commands and composing a runtime — as modules rather
  than as published packages.
  
  A CLI is not swappable the way a frontend is: nobody installs a different one.
  A separate package published an artifact with a single consumer and a version
  that had to match this one exactly.
  
  The binary now loads the dashboard when it is present and runs without it when
  it is not. `@zelavis/ui` is an optional dependency, so an installation ships
  with a dashboard and keeps working after removing it — the API unchanged, the
  root path saying no frontend is installed.
  
  **Breaking:** anything importing `@zelavis/cli` imports `zelavis/cli` instead.
- 874e983: Move password sign-in and the OAuth client into Zelavis itself, and remove the
  auth plugins.
  
  Password auth was two nearly identical plugins — one keyed on an email address,
  one on a username — that the distribution copied into the services
  folder on first boot. That seeding existed because a Platform with no
  credential provider can never create its first owner, which made the plugin
  mandatory in everything but name. It is now one built-in provider that decides
  from the identifier which kind it was given, and the seeding machinery is gone.
  
  `@zelavis/auth` is gone too. Core already ran the Authorization Code flow —
  holding the state, nonce, and PKCE verifier — so the plugin only wrapped the
  client around it. Those are the parts of a redirect flow that are dangerous to
  get wrong and identical for every provider, so they are written and audited
  once rather than per plugin.
  
  What stays extensible is what is actually vendor-specific. A plugin declaring
  `zelavis/auth:oauth` supplies one identity provider's endpoints and claim
  mapping; Google, GitHub, and a generic OIDC builder ship in the box. The
  credentials an installation was issued are the operator's and are configured
  through `/auth/oauth/connections`, where the client secret is write-only.
  
  `@zelavis/app-auth-oidc` remains, narrowed to a JWT bearer authenticator for
  callers already holding a token from an issuer.
  
  Breaking: the provider name is `password`, not `email-password` or
  `username-password`, and `zelavis bootstrap` defaults to it.
- 48dbb58: Store on an ordered key-value engine, and retire the SQL store.
  
  Lenses are key ranges rather than tables. A posting list is the entries under
  one prefix, already sorted; a posting is a key with no value, because the key is
  the fact. That is what the column-family design was reaching for, and it is what
  lets an engine with no tables back the same semantics — which is the point:
  RocksDB is now a driver rather than a rewrite.
  
  A transaction is one atomic batch instead of a BEGIN/COMMIT window, with reads
  overlaying the pending writes. That second part is not optional: a put after a
  retract of the same identifier must observe the retraction, or it re-reads a
  manifest the batch already removed. It also removes the hazard that forced the
  old gateway to be synchronous — there is no open transaction for a concurrent
  caller to write into, so an asynchronous engine is now a driver.
  
  `sqlite-store.ts` and the SQL gateway are deleted rather than kept alongside.
  Two stores meant two definitions of retraction, cursors and event replay, and
  the one nobody opened would drift until it was wrong in a way nothing caught.
  
  Key encoding is the part that had to be exact. Identifiers are fixed-width
  big-endian so 2 sorts before 10 in bytes; strings are terminated so ("ab","c")
  cannot collide with ("a","bc"); each lens takes a tag so a scan cannot leave its
  namespace. `0x00` escapes to `0x01 0x01` rather than the obvious `0x00 0xFF`,
  which would make the encoding of a value containing a null begin with the
  encoding of the value truncated before it — and the prefix range does not save
  that, because the escape sorts below the incremented bound.
  
  libSQL keys travel as hex text. Binding a Buffer to a SELECT panics inside
  libsql 0.5.29's native layer, so the driver encodes around an upstream bug; hex
  preserves order, so scans behave identically.
  
  Correctness is established by running the existing object-store, event-log and
  document contracts against the new store unchanged, rather than by new tests
  written to agree with new code.
- 48dbb58: Replace the document-first SQL database with `zelavis/dbnew`.
  
  The database service is now built on the multi-model object store, both
  construction sites open a sharded database through `zelavis/dbnew/node`, and its
  shards close on runtime shutdown. `src/app/db` is removed rather than deprecated:
  around ten thousand lines, its adapters, its export subpaths, and the seven test
  files that exercised it structurally. What those tests covered is asserted
  against `dbnew` instead, by tests written against the behaviour rather than
  ported from the implementation.
  
  It lands as one change because it cannot land as several. Pointing the service at
  the new store forces both construction sites, a `Zelavis` member with its own
  lifetime, the `core.database` slot, and two shape guards; those force removing
  the old database, whose tests assert a service it would no longer have. Split
  across commits it leaves the tree unbuildable between them.
  
  No URL changed. The Tenant was added to the schema and system-view routes in an
  earlier change specifically so that switching the store would not also move the
  API underneath the dashboard, and so a break in one could not be mistaken for a
  break in the other.
  
  Two capabilities are genuinely gone rather than moved. The raw SQL surface was
  the last way to reach storage without the guarantees the documents API exists to
  provide, and it is not coming back. `@zelavis/app-db-libsql` went with the driver
  contract it was built on, so only the Node SQLite driver ships today — engine
  swappability is a claim the code does not currently back, and restoring it means
  writing a libSQL driver for `dbnew`.
  
  Not yet included: real topology on `/database/health`, which only became
  truthful once `dbnew` served the endpoint.
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
- 48dbb58: Update the database runtime to Effect `4.0.0-rc.112` and validate it with the
  Effect language service during package typechecks.
  
  The low-level Effect database API now exposes argument-free reads such as
  `documents.listCollections`, `schemas.listCollections`, `projections.list`,
  `timeSeries.list`, and `backups.exportTenant` directly as lazy Effect values.
  The promise-facing Node/runtime API retains its existing method syntax. Numeric
  wire and schema fields now reject `NaN` and infinities through `Schema.Finite`.
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
- d6a33d1: Replace `defineService` with a manifest-based plugin contract. Plugins and
  services now declare themselves through a validated `package.json` manifest
  (`"zelavis": { "kind": ... }`, ESM `type` and `exports`, no legacy `main`) and
  author their behavior through the official `zelavis/sdk` surface —
  `zelavis.menu`, `zelavis.routes`, `zelavis.commands`, `zelavis.events`, and
  `zelavis.services` — bound to an explicit plugin execution context.
  
  Route definitions carry typed operation specs and the runtime generates an
  OpenAPI 3.1 document for every mounted service at
  `/zelavis/api/v1/runtime/openapi.json`.
  
  Plugin manifest resolution moved out of the runtime core: hosts install a
  `ZelavisServiceManifestResolver` (the Node and Bun adapters install the local
  filesystem one), keeping filesystem plugin scanning out of core. A runtime
  service's `api` is now optional so `kind: "provider"` plugins can register
  through a domain contract without mounting HTTP routes.
  
  `defineService` and the `zelavisEcommerceService` alias are removed with no
  compatibility shims. Import `ecommercePlugin` from `@zelavis/ecommerce` and move
  plugin configuration into `package.json`. The unrelated marketplace helpers
  `defineServiceCatalogEntry` and `defineServiceCatalog` are unchanged.
- aa3d4e2: Remove `coreServices`.
  
  The name claimed the Platform had a second, privileged way to install services.
  It did not: what the option held was the Platform's own subsystems, and every
  member was either infrastructure or a policy switch. Services come from the
  services folder and the registry endpoints, and only from there.
  
  - `subsystems` on `zelavis(...)` carries `auth`, `database`, `fabric`,
    `storage`, `workloads`, and `site`. `site` replaces `website`, which was
    never a service — the placeholder it mounts is the frontend one, and the flag
    decides whether the installation owns `/` or lives under its root path.
  - `frontend` absorbs `coreServices.dashboard`, and accepts a factory, an object
    (`factory`, `title`, `subtitle`, `devServerUrl`, `clientRoutes`), or `false`.
    The dashboard option predated frontends being a first-class concept; by the
    end every field it carried was about the frontend, and `clientRoutes` already
    fell back to the routes the frontend declared for itself.
  - `runtimeSettingsStore` carries the settings store, which is a resource.
    Reaching it through the dashboard option meant an installation that turned
    its dashboard off also lost the Platform's own settings persistence.
  
  Passing `coreServices` is refused with a message naming its replacement rather
  than silently ignored: dropping it quietly would leave a caller believing they
  had turned `auth` or `site` off while it was still running.
  
  Also fixes subsystem option merging dropping `fabric` — the merge listed its
  members by hand and omitted one, so an adapter and a host that both configured
  the Fabric silently lost one of them.
- 48dbb58: Rename the store to `zelavis/db`, its drivers to engines, and `product-services` to `services`, in the repo and on disk.
  
  `dbnew` was only ever a name for "not the old one", and the old one is gone. The
  subpaths become `zelavis/db`, `zelavis/db/node`, `zelavis/db/node-sqlite` and
  `zelavis/db/libsql`, and the backup format identifier follows.
  
  `adapters` became `engines`, which is what they are: a driver is a handle to a
  storage engine, not an adapter between two APIs. `node-database.ts` moved out of
  that folder to `db/node-host.ts`, because opening a database for a promise-based
  host is not an engine and sat there only by accident.
  
  `product-services` said who shipped a package rather than what it is. The folder
  is now `packages/zelavis/services`, and so is the runtime directory an operator
  drops services into: `<dataDirectory>/services`. Leaving the runtime one behind
  would have kept the old name in the place users actually read it — in the error
  that tells them where to put a service, and on the page shown when no frontend
  is installed — while the repo folder it echoed had come to mean something else.
  
  Also removes `packages/zelavis/adapters`, which had already lost its tracked
  contents in the database cutover and was surviving as stale build output.
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
- 2272870: Consolidate the reusable server/Fabric engine, built-in App recipe, App Auth,
  App Database, Workloads, and trusted Platform services into the unified
  `zelavis` package with focused public subpaths. Add typed runtime lifecycle,
  artifact/provider contracts, deterministic Fabric replica planning, and exact
  per-Project App version locks that parent Platform upgrades preserve. Project
  deletion now persists resumable cleanup progress and removes Project-owned
  Assistant threads, domain bindings, bundle assets, and runtime data before the
  registry record disappears.
  
  This intentionally removes the previous standalone package entry points and is
  a breaking release with no compatibility aliases.

### Minor Changes

- d2b22c4: Run the Agent as its own process.
  
  `zelavis agent` serves the process command contract over a unix socket, and a
  host opts in with `projects.agentEndpoint`. The Project drivers are unchanged —
  they were put behind the contract for exactly this, so a second implementation
  changes the transport rather than three supervisors.
  
  The operator supervises the Agent themselves, so it is restarted on its own
  terms rather than inheriting the Platform's lifetime. A Platform that dies no
  longer takes supervision down with it: the Agent keeps running the Projects,
  and disconnecting is not stopping.
  
  Reclamation follows the ownership. Processes whose Platform disconnected are
  stopped by the next Platform's boot sweep, because nothing can drive them any
  more — a record-only check would skip them forever, since the record names the
  still-running Agent as their owner. A live Platform's processes are left alone.
  
  The Node adapter now owns one Agent for all three Project drivers and reclaims
  through it while composing, so an installation that boots and starts nothing
  still cleans up after a crashed Platform.
  
  Trust rests on filesystem permissions: a 0700 endpoint directory and a 0600
  socket, with a shared token as a second lock for a path that turns out more
  permissive than intended.
  
  Not yet included: re-attaching to Projects an earlier Platform started. The new
  Platform has no handles to them, so it reclaims and starts fresh, and
  `survivesControlPlaneRestart` stays false.
- 49177f0: Run local Project processes through the Agent command contract.
  
  Three drivers each supervised their own children: the Node Project runtime, the
  server frontend runtime, and native WordPress. Each had its own `spawn`, its own
  line splitting, its own SIGTERM-then-SIGKILL escalation, and its own answer to
  what happens to a child when the Platform exits — two of them had no answer at
  all, so a Platform crash left their processes running.
  
  They now issue commands through `ZelavisAgentProcessRunner`. The Agent's
  existing host operation contract describes a short, registered, digest-pinned
  program; a Project runtime is the other shape — it announces readiness on its
  own stdout, serves for as long as the Platform wants it, and has to be given a
  chance to finish when stopped. The new contract covers that shape: line output,
  escalation, a stop that resolves only once the process is actually gone, and an
  exit that reports whether the Platform asked for it.
  
  Doing this before a remote Agent exists is the point: the local runner is the
  first implementation of one contract rather than the thing a remote Agent would
  have to be retrofitted around. Each driver takes an `agent` option and defaults
  to the local runner, so nothing about single-host behaviour changes.
  
  Native WordPress no longer hands the Platform's entire environment — bootstrap
  token, provider credentials, signing keys — to nginx, php-fpm, its database, or
  the one-shot setup commands beside them. Host package installation (`brew`,
  `apt`, `sudo`) opts back in explicitly, because those are configured through
  environment variables an operator sets and they run as the operator
  provisioning their own machine rather than as anything a Project influences.
- 71c1c4f: Re-attach to Projects an earlier Platform started.
  
  A Platform behind a separately supervised Agent used to reclaim what it found
  running and start again, because it had no handles to those processes. It now
  takes them back instead. The Agent keeps a bounded tail of each process's
  output and hands a reconnecting client the processes for a workload along with
  what it missed; the Node driver re-derives readiness from that replay, which is
  the only place the bound address exists — the Project announced it while no
  Platform was connected.
  
  Adoption runs before reclamation while the host composes, so a Project that
  never stopped serving is taken over rather than killed and restarted. Restarting
  is not a harmless alternative: it drops the connections the Project is serving,
  and for a Project with a persisted port it collides with the copy still
  listening. What remains after adoption is what nothing can drive, and that is
  what gets reclaimed.
  
  `survivesControlPlaneRestart` is now read from the runner rather than hardcoded
  `false` in three drivers. It is a property of where processes actually run, and
  it is true behind an Agent.
  
  Two cases are handled explicitly rather than assumed away: a Project whose
  readiness line has aged out of the buffer is reported running without an
  address, instead of being routed to a guessed one; and reconciliation stops an
  adopted Project whose desired state is stopped, so "stopped" does not quietly
  mean "stopped, unless it survived a crash".
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
- 48dbb58: `restoreTenant` can restore into a tenant that already holds data.
  
  Restoring is not one operation: putting a tenant back as it was and folding a
  copy of it into what is there now are different intentions with different right
  answers, so the mode is the caller's to choose. `empty` refuses and stays the
  default, because it is the only one that cannot lose anything. `purge` discards
  what the tenant holds and leaves it as the backup describes it. `merge` writes
  the backup over records sharing a name and leaves the rest alone.
  
  A backup whose identities name a different tenant is now refused whatever its
  envelope says. Those identities are lens keys, and a merge looks them up to
  decide what to write over — so a mislabelled backup would have written over the
  tenant they really belong to on the same shard.
- 493e2b5: Add a host-local complete-uninstall API and packaged CLI flow with an
  inspectable dry run, exact destructive confirmation, installer-owned resource
  cleanup, persisted custom-path and account-ownership receipts, isolated removal
  tests, and operator documentation.
- 7bf02e0: `@zelavis/ui` is now `kind: "frontend"` rather than a plugin that happens to
  serve HTML. Its manifest declares the frontend it is — a static frontend over
  the `build/client` bundle the package already ships — so validating it against
  the frontend contract passes rather than being a label.
  
  It stays composed rather than loaded from that manifest, which is what lets it
  supply an `app.shell`. The installation's root path is a runtime setting, so
  the built SPA's absolute asset references are rewritten per request, and a JSON
  manifest cannot express a render function.
- 3663b43: Order pages by several fields with composite indexes.
  
  A collection declares indexes — `createIndex({ collection, name, fields })`, or
  `indexes` on `createCollection` — each a list of fields in order with a
  direction and a null placement (`nulls: "first" | "last"`, last by default in
  either direction). `findPage` and `findMany` read an index for an order made of
  its fields, or exactly its reverse, after any leading fields an equality filter
  fixes. A first page of 50 by two fields over 50k documents takes about 7 ms,
  where `findPage` refused the order and `findMany` sorted every match in memory
  (1.2 s).
  
  An index created over existing documents writes each one back with its new
  posting while other writes carry on, and answers reads once it is complete;
  `dropIndex` removes one. `findPage` still refuses an order of several fields no
  index serves, and says what index would. Single-field sorts take
  `nulls: "first"` as well.
  
  Every document write now reads its collection's indexes inside its
  transaction, which costs inserts about 8% on a collection without any.
  
  The database service mounts `POST /database/documents/:collection/indexes` and
  `DELETE /database/documents/:collection/indexes/:name`.
- 9957059: Enforce unique, check and reference constraints, and preconditions, in the transaction that writes.
  
  Document writes now read, check and write in one transaction under the store's
  single writer: the id, the version, the data a merge builds on, the schema, the
  idempotency receipt and the move fence. Two racing updates can no longer both
  build on one version, and a refused keyed write records no receipt.
  
  - `unique: true` on an index refuses a second document with the same values.
    A document missing one of them is not held to it, as SQL treats NULL. An
    index created over documents that already break it is not created, and the
    error names two of them.
  - `checks` on a collection are filters every document must satisfy, stored as
    data; a field with no value passes, as a NULL passes a SQL CHECK. `addCheck`
    validates the documents already there.
  - `references` name a document in another collection of the same tenant.
    Deleting a named document restricts (the default), cascades, or sets the
    field to null, all in the delete's own transaction. `addReference` validates
    the documents already there.
  - `precondition` on `update` and `delete` is a compare-and-set on field values,
    alongside `expectedVersion`.
  
  Unconstrained writes run as before; enforcing a unique index, a check and a
  reference together costs about a third of insert throughput.
- de5f3fe: Apply several document changes as one.
  
  `documents.write` takes a list of inserts, updates and deletes and applies them
  in a single transaction: all of them land or none does. Every check a single
  write makes is made against what the batch has written so far as well as what
  is committed, so changes can depend on each other — a post may name an author
  the same batch inserts, a document deleted earlier in the batch is gone for the
  changes after it — while two changes may not take one unique value. A violation
  anywhere refuses the whole batch.
  
  Atomicity stops where a tenant does: a tenant lives on one shard, there is no
  write spanning shards, and `db.scatter` reads rather than writes. A change set
  spanning tenants is several batches, each atomic on its own.
  
  `POST /database/documents/write` carries a batch. Deleting a document that
  others name now resolves each of those documents once, with every field naming
  it cleared together, instead of once per reference.
- f68f2da: Follow a document's typed links as a lens.
  
  A collection can declare an `EdgeDefinition`: a name, the field holding the
  target id or ids, and the collection those ids name. Writes resolve each target
  and post it on the edge lens, and `findMany` and `findPage` take a `linked`
  clause naming a document and one of its declared edges, answering with the
  documents it links to.
  
  A reference already holds one id, so following one is a lookup, and asking which
  documents name a given one is an ordinary column filter. An edge is the case
  those do not cover: it holds a list, so following it is a posting scan, and
  because the postings are the neighbours' own identifiers the result intersects
  with everything else the target collection indexes. That is the point of making
  it a lens rather than a field -- `where`, `search` and `geometry` narrow the
  neighbours before they are read, instead of filtering them afterwards. Links
  also page, because an intersection has no order of its own to lose.
  
  The field may hold a single id as well as an array; one link is a short list.
  A document may link to itself, and a document written in one batch may link to
  another written earlier in the same batch, because targets resolve through the
  same transaction overlay that references already use. A link naming a document
  that does not exist is refused as a `ReferenceViolation` at the write.
  
  Edge postings were already carried by the store -- keyed, sealable, dropped on
  retraction, and re-derived by a reindex -- but nothing populated them. They are
  filled in now from the resolution the constraint pass was already performing, so
  a write costs no extra read. A rewrite re-derives them on its own path, and
  re-derives rather than re-checks: a target that has since gone leaves the link
  unposted instead of failing the rewrite.
  
  Stated limits: this is outbound only. The lens keys a posting by the source
  document, so an inbound posting would have to be written into the target's
  manifest and re-version it on every source write; asking which documents link to
  a given one is not supported here. There is no bounded traversal, no shortest
  path, reachability or component query, and no edge properties or first-class
  edge objects yet. A `linked` clause is refused across more than one shard by the
  existing scatter check, since an edge names a partition-local identifier.
  Links resolve as each change in a batch is applied, in order, so two documents
  that link to each other cannot be written in one batch: the first of the pair
  names a document that exists nowhere yet, and the batch is refused.
- 3dbc353: Make the newer database capabilities reachable over the wire.
  
  Search and geometry were wired into the versioned endpoints when they landed;
  the capabilities after them were not. A collection could declare an embedding,
  typed edges or measures in process but not through `POST /collections`, a query
  could not carry `linked` or `similar`, and `summarize`, `summarizeBy` and `embed`
  had no runtime method or route at all. They do now:
  
  - `POST /:collection/summarize` and `POST /:collection/summarize-by` aggregate a
    declared measure, grouped or not, narrowed by the same clauses a query takes.
  - `linked` reaches the query and page routes; `similar` reaches the query route,
    and deliberately not the page route, because an order by score has no cursor
    that survives a write.
  - `embedding`, `edges` and `measures` can be declared when a collection is
    created.
  - `embed`, `summarize` and `summarizeBy` are on the runtime API beside `analyze`
    and `locate`.
  
  Four domain errors reached the wire as `500`s, because they were in none of the
  status sets: a measure or an edge the collection does not declare is a `404`, as
  an unknown reference already was, and a malformed vector query or a vector of the
  wrong shape is a `400`, as an unanalyzed collection already was. A caller's
  mistake now reads as one.
  
  The clauses every filtering read shares are decoded in one place, so a query, a
  page and an aggregate narrow by the same words -- an endpoint that understood
  `linked` on only some of them would answer a different question depending on
  which was asked.
- 48dbb58: Choose a storage engine when opening a database, defaulting to SQLite.
  
  Four engines shipped with no way to ask for one: the host hardcoded SQLite, so
  the choice was a code edit rather than configuration. `openNodeDatabase` now
  takes `engine`, and every engine is reachable through the same host with the
  same behaviour.
  
  SQLite is the default because it is the only engine that needs nothing
  installed — a default that can fail to install is not a default. The others are
  optional peer dependencies and say which package is missing when one is asked
  for and absent.
  
  Which to pick is a question about the working set rather than about speed. LMDB
  is three to four times faster than everything else while the data fits in
  memory, which on a 64 GB machine is roughly forty million objects. RocksDB holds
  the same data in about a sixth of the space and barely slows when the cache goes
  cold, so it is the engine that keeps working once the data outgrows the machine.
  libSQL is for replicating from a remote primary rather than for local speed.
  
  `openLibsqlDatabase` and `makeLibsqlDatabase` are removed. They existed only
  because the host could not select an engine, and keeping a second way to open a
  libSQL database would mean two paths to maintain and one of them going stale.
- 2ffffbb: Complete spatial geometry capabilities in `zelavis/db`:
  - Line geometries (`GeoLineString` and `GeoMultiLineString`) indexed with H3 cell sampling along segments at resolution + parent ancestors.
  - Edge-to-edge intersection for polygons and lines without requiring interior vertices.
  - Nearest-neighbour candidate ordering and distance cursor pagination in `findMany` and `findPage`, with `distance` in metres exposed on matching documents.
  - Documented and enforced denial-of-service budgets for geometry vertices (`MAX_GEOMETRY_VERTICES = 10_000`) and rings (`MAX_GEOMETRY_RINGS = 500`).
- 88c4f0e: Inbound adjacency and bounded graph traversal (Graph Slice Two).
  
  A collection with declared `EdgeDefinition`s can now be queried for inbound links:
  answering "which documents link to document X", narrowing candidates through `where`,
  `search`, or `geometry` before reading.
  
  Inbound adjacency is implemented with zero target document re-versioning: reverse
  edge postings are keyed under `Tag.EdgeReverse` (`0x10`) as `[Tag.EdgeReverse][edgeType][dstSeq][srcSeq]`,
  and are owned entirely by the source document's lifecycle and manifest. Retractions,
  rewrites, and segment sealing operate on both forward and reverse edge postings
  without modifying target document manifests, payloads, or version numbers.
  
  In addition, `documents.traverse` provides bounded breadth-first graph traversal
  across declared edge types with cycle detection, configurable traversal `direction`
  (`outbound`, `inbound`, or `both`), `maxDepth`, `maxVisits`, and per-hop filter
  intersection. The traverse capability is exposed over HTTP at `POST /:collection/traverse`.
- 694ae12: Run a store on a libSQL database reachable only over the network.
  
  The `libsql` engine covers local files and embedded replicas through libSQL's
  synchronous binding. `libsql-remote` covers the case that binding cannot: a
  database that lives elsewhere, reached with `@libsql/client` (an optional peer).
  A `turso://` address is accepted for the one Turso prints.
  
  It implements the key-value contract directly rather than through the shared
  SQLite layer, which needs a synchronous handle: range bounds and limits are
  pushed into the statement so a page costs one round trip and the rows it
  returns, and a write is one `batch` in write mode — all of it lands or none
  does, which is the only transaction mechanism the store above it asks for.
  
  Verified against a real Turso database, and the contract tests skip when
  `TURSO_URL` and `TURSO_TOKEN` are unset. Prefer an embedded replica wherever a
  local file is possible: here every read is a round trip.
- 48dbb58: Add an LMDB storage engine.
  
  A memory-mapped B+tree, so a third shape beside the SQL b-trees and the LSM
  tree — and the one that answers reads without decoding anything. It is the
  fastest engine on every measured axis: six times SQLite on the cross-model
  query, nearly five times on posting scans, three times on point reads, and it
  ingests fastest as well. It pays in space, taking more disk than SQLite and five
  times more than RocksDB.
  
  Adding it took one file and no changes above it, which is the clearest evidence
  so far that the key-value interface is the right seam. It joins the conformance
  suite and the object-store contract like every other engine.
  
  It also corrects an earlier reading of the benchmark. Building the measure
  vector looked storage-independent because three engines all took about the same
  time; LMDB does it in a third of that, so the work was in the read path after
  all rather than in the JavaScript above it.
  
  `lmdb` is an optional peer dependency. Whether it should displace SQLite as the
  default is left open: it is faster everywhere measured, but SQLite ships inside
  Node and needs no native build.
- 7e5cc15: Aggregate a collection without reading its documents.
  
  A collection can declare a `MeasureDefinition`: a name and the field holding a
  number. Writes keep that number in the measure lens, and `summarize` answers
  `count`, `sum`, `avg`, `min`, `max`, `variance`, `stddev` and `countDistinct`
  over it, with `summarizeBy` grouping the answer by a field.
  
  The filters run first. Whatever `where`, `search`, `geometry` and `linked`
  admit is resolved to a set of identifiers, and only then is the measure read --
  as one dense vector indexed by identifier, so summing a million documents reads
  a million doubles rather than a million payloads. Grouping reads its keys from
  the ordered lens alongside the identifiers, so it does not touch the documents
  either.
  
  Only finite numbers are kept. A field that is absent, null, a string, an object
  or a non-finite number has no measure posting, and such a document is not
  counted -- which is why `avg` divides by the documents that carried a value
  rather than by the documents that matched. A stored zero is a value and counts;
  the dense vector cannot tell the two apart on its own, so presence comes from
  the field's own ordered postings rather than from a zero in the vector.
  
  Every answer carries `documents` alongside its `value`, so a caller can see what
  the number was computed over instead of inferring it.
  
  Stated limits: one measure per answer -- covariance and other two-measure
  statistics need a form that names both, and are not here. Variance and standard
  deviation are population, not sample. Histograms answer with a distribution
  rather than a number and need their own surface. There are no materialized
  aggregate projections yet, so every answer is computed when it is asked for.
- 62b2e91: Add ranges, sorting and cursor pagination to `zelavis/db`, served by a new ordered lens.
  
  Values now have one defined order, identical on every host: booleans, then
  numbers, then strings by code point (no locale and no normalization), then
  null. Every scalar document field is indexed in that order, and every storage
  engine can scan a key range in either direction to read it.
  
  - `gt`, `gte`, `lt`, `lte` and `between` are serializable query nodes that
    combine with `and` and `or`. A range compares like with like: `lt(price, 5)`
    is numbers below five, never booleans or null.
  - `store.ordered` reads a page of objects in value order in either direction,
    ties broken by identifier, with an opaque cursor; `store.extent` returns a
    column's lowest and highest value.
  - Document comparisons (`gt`, `gte`, `lt`, `lte`) are answered by the index
    instead of being filtered after it, and `eq` and `in` are exact about type:
    `10` no longer matches `"10"`.
  - A one-field `orderBy` reads the index instead of sorting every match.
    Documents whose field is null or absent come last in either direction.
  - `documents.findPage` and `POST /database/documents/:collection/page` return a
    page and a `next` cursor that is present only when another document follows.
    Ordering a page by several fields is refused until composite indexes exist.
  
  Every scalar field is now indexed twice, for equality and for order, so writes
  take about 1.8 times as long and use about 30% more disk. Merging the two
  indexes is the next step.
- ffb15fc: Repair documents indexed under older rules, and reach every constraint over HTTP.
  
  `documents.rewrite()` writes documents back so their postings are the ones the
  lenses derive today. It is what repairs documents written before the typed
  scalar lens, whose numbers and booleans were indexed as text and so were missed
  by a typed equality, a range or an order; a reindex cannot, because it
  re-derives postings from the stored manifests and those are what is wrong. It
  takes one collection or every one of the tenant's, and is mounted at
  `POST /database/maintenance/documents/rewrite`.
  
  Checks and references can now be added and dropped over HTTP
  (`POST`/`DELETE /database/documents/:collection/checks` and `/references`), and
  a delete takes `expectedVersion` and a JSON `precondition` in its query string,
  where the method has no body.
  
  An insert hands the collection record it already read to the write instead of
  reading it again: 4.0k inserts/s against 3.3k/s, measured in one run.
- 2833e08: Join collections through their references.
  
  `findMany` and `findPage` take a `related` clause — `{ reference, where?, id? }`
  — for documents whose reference names a document matching something else. The
  named collection answers its own query first, and the ids it returns become an
  equality union over the referencing field's existing postings, so a join is a
  set operation over the dense identifier space rather than a scan of either
  side: over 20k posts across 2k authors, the posts of one country's authors take
  33.7 ms against 154.9 ms for reading every post, resolving its author and
  filtering; by id, 0.2 ms.
  
  `withRelated` resolves what documents you already hold name, reading each named
  document once however many name it. `db.scatter` carries a join to every tenant
  it asks, and a join stays inside one tenant because a reference does. A
  reference the collection does not declare is `UnknownReference`, so a mistyped
  name is refused rather than quietly matching nothing.
  
  Over HTTP, `related` is accepted by the query and page routes.
- 503b6c0: Re-seal only what changed since the last seal.
  
  Once a store has been sealed, every posting write marks the group it lands in,
  and the next seal visits only the marked groups instead of every posting still
  live. A value an earlier seal declined as too sparse is no longer read again by
  every seal after it: re-sealing 2,000 changed objects of 200k takes 0.19 s,
  down from 0.66 s. The first seal, and the first after a reindex or a rebuild,
  still sweeps every posting.
  
  `db.seal` reports, per shard, how many live postings the seal `examined`.
- 48dbb58: Add a RocksDB storage engine.
  
  The engine the lens design was originally drawn for, and it needed no
  accommodation: `get`, a bounded iterator and an atomic write batch are exactly
  the key-value interface, so it is four methods and nothing above it changed.
  That was the point of moving the store off SQL.
  
  Its single keyspace and absent column families cost nothing. Each lens already
  takes a leading key tag, which gives it the disjoint range column families would
  have provided — the emulation the original design expected to need turned out to
  be the design.
  
  It is also the first asynchronous engine, which is only safe because a
  transaction is one batch rather than an open window another caller could write
  into. The interface was typed for that from the start.
  
  RocksDB joins the engine conformance suite and runs the object-store contract,
  so it is held to the same ordering, prefix isolation, batch atomicity and binary
  fidelity as every other engine rather than being trusted because it is a
  database.
  
  `rocksdb` is an optional peer dependency, so an installation that does not ask
  for the engine does not carry a native build.
- 0e6fdc5: Order and page documents across tenants and shards.
  
  `db.scatter.findMany` with an `orderBy` now merges every tenant's ordered run
  by value, tenant by tenant among equals, instead of re-sorting the rows by
  tenant and id; with a `limit`, each tenant is read only that far. The new
  `db.scatter.findPage` pages the same merge: its cursor holds a position per
  tenant, a page reads a share of itself from each tenant and tops up the ones
  the merge drains, and a continued read keeps the tenants and the order it began
  with. Across 20 tenants on 4 shards a page of 50 takes about 5 ms whether they
  hold 1,000 documents each or 5,000. An order some tenant cannot page is refused
  with that tenant named.
  
  `findPage({ cursors: true })` returns the cursor after every document, and
  `compareDocuments(orderBy)` exposes the order `findMany` and `findPage` use.
- ebab0bb: feat(db): BM25 relevance scoring, ranking, and phrase search
  
  Full-text search now ranks results by BM25 relevance score when no explicit `orderBy` is passed, scoring by term frequency, field token lengths, candidate inverse document frequency (IDF), and proximity boosts. Quoted phrase queries (`"quick brown"`) are verified consecutively against analyzed fields, and matching documents carry an optional numeric `score`.
- 6aac906: Support prefix matching (`comput*` / `prefix: true`), fuzzy matching (`macbok~` / `~N` / `fuzzy: true`), and snippet highlights (`<mark>...</mark>`) in `zelavis/db` search queries.
- c5147b4: Support language-aware stemming (`language: "en"`, English Porter stemmer) in collection analyzers and rich boolean search query expressions (`AND`, `OR`, `NOT`, `-`, `&&`, `||`, `!`), grouping with parentheses `(...)`, and field scoping (`field:term`, `field:"phrase"`, `field:prefix*`, `field:fuzzy~`) in `zelavis/db`.
- 89cf8f8: Search a collection's text by terms it declares how to make.
  
  A collection can declare an `Analyzer`: which fields become searchable, NFC
  normalization, case folding, stop words, a minimum term length, the language
  (recorded, not yet acted on), and a version. Writes turn those fields into term
  postings, and `findMany` and `findPage` take a `search` string analyzed the same
  way — every word must appear, a word counts in any analyzed field, and the whole
  thing is one more set that intersects with filters, ranges and joins.
  
  `documents.analyze` declares or changes the rule and rewrites every document
  under it, since the terms already stored are what a search reads. Searching a
  collection with no analyzer fails with `UnanalyzedCollection` rather than
  answering "no matches" to a question that was never askable. Over HTTP, `search`
  is accepted by the query and page routes, and `analyzer` on collection creation.
  
  This is term search, not ranked full text: no positions, phrases, prefix or
  fuzzy matching, no BM25 scores or highlights. Those need storage this does not
  add — positions need their own key shape, and scoring needs document lengths and
  term frequencies — and are tracked as the next slice.
- 8801b18: Answer equality, ranges and order from one typed, sealable scalar lens.
  
  The equality index and the ordered index are now one. A manifest's `columns`
  carry typed scalar values — `10`, `"10"` and `true` are three different values
  — and one posting per value answers `equals`, every range and every order.
  Writes are back to one posting per field: about 6.5k objects/s at 50k objects
  of five fields, against 2.9k/s with two indexes.
  
  The scalar lens seals into segment blobs like the others, and ordered reads
  merge those blobs with the live postings, so a sealed store pages as fast as a
  live one while wide equality filters keep sealing's speedup (14× on a wide
  column, 180× intersecting a selective filter with a wide one). A value is
  sealed only once it has 64 postings in a segment: a unique value gains nothing
  from a blob and would cost ordered reads a decode per row.
  
  `equals(column, value)` takes a typed value, and the manifest's separate
  `ordered` field is gone. A store written in the older layout is re-indexed
  the first time it opens.
- 1b40406: Keep a rebuild possible after compaction, with snapshots.
  
  `reindexLenses` re-derives the lenses from the stored manifests and works
  whatever happened to the log. `rebuildLenses` re-derives them from the log
  itself — the operation that catches a manifest that is wrong instead of
  trusting it — and compaction used to take it away for good.
  
  `store.snapshot` now writes every live record down together with the log
  position it covers, in a single batch that also drops the previous snapshot: an
  interrupted snapshot leaves the store exactly as it was, and a store never holds
  two snapshots or none. `rebuildLenses` starts from the newest snapshot and
  replays only the events after it, and still refuses with `LogCompacted` when no
  snapshot covers what compaction cut, since those events are genuinely gone.
  
  `db.maintenance.snapshot` takes one per shard, alongside `compact`, `reindex`
  and `seal`. A snapshot costs one key per live record.
- b1c76c5: Index and query geometry.
  
  A collection can declare a `SpatialIndex`: which fields hold GeoJSON, an H3
  resolution, and a version. Writes cover each geometry in cells and post them on
  the term lens along with their ancestors, so a coarse query still meets a finely
  indexed document. `findMany` and `findPage` take a `geometry` filter — `near` a
  point within a radius in metres, `within` a bounding box, or `intersects` a
  shape — and `locate` changes the index, rewriting documents under it.
  
  Cells only produce candidates. The exact check runs on the real coordinates, so
  what comes back is what the geometry admits: a document sharing a cell with the
  centre but lying outside the radius does not appear.
  
  Stated limits: distance is haversine on a sphere, about 0.3% from WGS84;
  `intersects` holds when either shape contains a vertex of the other, so two
  shapes crossing edge to edge with no vertex inside either are missed; coverings
  are capped and coarsened to fit, with an over-large geometry carrying a sentinel
  so it stays findable. Boxes crossing the antimeridian are split at the line.
  Nearest-neighbour ordering is not included.
  
  `h3-js` is an optional peer, needed only by collections that index geometry.
- ca8af30: Answer time-series windows from the ordered lens.
  
  A point now carries its instant as a single ordered posting instead of five
  bucket postings, and a window is one exact range over it. That removes the
  interval cover of buckets, the clause-count backstop, the fallback that
  answered a very wide window by reading the whole series, and the trimming that
  coarse buckets made necessary.
  
  Ingest rises from about 2.6k to 3.2k points/s over 20k points, on four fewer
  postings each; read times are unchanged within noise, which is what the change
  is for — the cover was cheap to query but expensive to write and to keep
  correct. Tag filters are untouched.
  
  `BucketSize`, the `bucket` option on a time-series definition, `bucket` on its
  summary and the `coverBuckets` helper are removed, and the time-series system
  view no longer carries a bucket column. A series whose points were written
  under the old scheme answers from those postings until `rebuild` replays it.
- 79ebf23: Aggregate a time series by its endpoints and its distribution.
  
  `aggregate` gains `quantile`, `first`, `last`, `delta` and `rate` alongside the
  `avg`, `sum`, `min`, `max` and `count` it already had. A quantile takes `p` as a
  fraction from 0 to 1 -- 0.5 is the median, 0.99 the ninety-ninth percentile --
  and interpolates between the two values it falls between, so the median of an
  even number of points is the midpoint of the middle two rather than an arbitrary
  one of the pair. A rate is the change between the window's first and last point
  divided by the seconds between them.
  
  The four endpoint operations sort by time before answering, which the folds that
  were there before did not have to do. Points come back in posting order -- the
  order they were written -- and that is invisible to `sum` or `max` but decides
  the answer for `first`, `delta` and `rate`: a point written late for an early
  instant would otherwise be taken for the end of the window. A quantile likewise
  sorts, by value.
  
  Window bounds stay closed on both sides, so `start` and `end` are included. An
  empty window answers zero, as it already did. A window holding one point -- or
  several sharing an instant -- spans no time, so its rate is zero rather than a
  division by it. A `quantile` without a usable `p` is a defect rather than an
  error, as a bad page limit already is: it is a mistake in the call, not a
  property of the data.
  
  Over HTTP the aggregate route takes `p` as well, and its validation now lists
  the operations from the one place that knows them, so adding another cannot
  leave the error message describing the set it used to accept.
  
  Stated limits: these are the operations that answer with a single number, which
  is what `aggregate` returns. Moving windows, histograms and interpolation answer
  with a series and need a surface of their own, so they are not here. Neither are
  rollups, downsampling or retention. The HTTP aggregate route still does not pass
  `tags` through, though the runtime API does.
- 0dd7c6d: Time-Series Slice Two: series and distribution operations, gap filling, and HTTP tag filter support.
  
  Added operations that answer with a series or distribution rather than a single aggregate number:
  - `timeSeries.windows`: tumbling buckets and sliding windows (`step < interval`) with configurable aggregation operations and gap filling (`fill`: `"none" | "zero" | "previous" | "linear"`).
  - `timeSeries.moving`: rolling window aggregations across time durations or point counts.
  - `timeSeries.histogram`: value frequency distributions with configurable bin counts, explicit boundaries, or fixed step widths, alongside statistical summaries (`min`, `max`, `count`, `sum`, `avg`).
  - `timeSeries.interpolate`: regular time-grid resampling with `"linear"`, `"previous"`, or `"next"` interpolation methods.
  - HTTP Routes: mounted `POST /timeseries/:series/windows`, `/moving`, `/histogram`, `/interpolate`, and `/ingest`.
  - HTTP Tag Filtering: wired tag filter support into `POST /timeseries/:series/range` and `/aggregate` so tags are honoured over the wire as well as in process.
- 907894c: Approximate nearest neighbour index (ANN / usearch) and findPage score pagination.
  
  - **Approximate Index & Rebuildable Projection**: Supported `usearch` as an optional
    peer dependency. Vectors remain stored authoritatively in the documents, and
    the approximate index is an in-memory projection that can be dropped and rebuilt
    from documents at any time via `rebuildVectorIndex` and `dropVectorIndex`.
  - **Similarity on `findPage` with Score Cursor**: Added `similar` filter on `findPage`.
    Paging order is score descending (`score DESC, seq ASC`), with a cursor that
    reliably survives concurrent writes (`phase: "score", score, seq`).
  - **Per-Read Metric Selection**: `SimilarFilter.metric` allows overriding the
    collection's declared metric per query (`cosine`, `dot`, `euclidean`).
  - **Quantized Storage**: Added support for vector quantization formats (`"f32" | "f16" | "i8" | "b1"`)
    declared on `EmbeddingIndex` and validated on creation and embedding.
  - **Recall Measurement**: Added `measureRecall(groundTruth, approximate)` to benchmark
    recall@k of the approximate index against the exact ground truth.
- 0a2c8c7: Search a collection's embeddings by closeness.
  
  A collection can declare an `EmbeddingIndex`: which field holds the vector, how
  many elements it has, how two of them are compared — cosine, dot or euclidean —
  and a version. `findMany` takes a `similar` clause naming that field, a query
  vector and a `k`, and answers with the `k` closest documents, closest first.
  
  The search is exact, not approximate. Every document the rest of the query
  admits is compared, which is what makes the other clauses matter: `where`,
  `search` and `geometry` narrow the candidates before anything is scored, so a
  similarity read under a narrow filter costs what that filter returns rather than
  what the collection holds. Ties break by identifier, so the same query over the
  same documents answers in the same order every time.
  
  The vectors stay in the documents, which remain the authoritative state. They
  are posted to no lens, so there is no second copy to fall out of date and
  nothing to re-derive when documents are rewritten. `embed` declares the index on
  a collection that already holds documents: it records the shape, reads every
  document against it, and withdraws the declaration if one does not match, rather
  than leaving a collection promising a shape its own documents do not keep. A
  write whose vector has the wrong length, or holds a value that is not a finite
  number, is refused as a `VectorShapeMismatch`; a field holding nothing is not a
  fault, and such a document simply never answers a similarity read.
  
  The model and its version can be recorded on the index. They are stored rather
  than enforced: vectors from two different models are not comparable, and a
  search mixing them returns nonsense in the shape of an answer, so writing the
  identity down is what lets a reader notice that it happened.
  
  Stated limits: `similar` is not on `findPage`, because an order by score has no
  cursor that survives a write. It cannot be combined with `orderBy`. `normalize`
  scales vectors for the comparison only — the document keeps the vector it was
  given. There is no approximate index yet: this is the exact baseline that one
  would have to be measured against for recall.
- 48dbb58: Add a libSQL driver, over the same store logic as the built-in one.
  
  Removing the old database took `@zelavis/app-db-libsql` with it, because it was
  built on the driver contract that went. This restores the engine, and does it
  without a second implementation: both drivers meet a small synchronous gateway,
  so retraction, manifests, events, cursors and posting evaluation exist once. Two
  copies of that logic would not diverge visibly — they would diverge into one
  engine quietly returning different rows.
  
  It uses libSQL's synchronous binding rather than `@libsql/client`. The
  asynchronous client would make every statement a promise, and a transaction
  built from promises on one connection is one another caller can write inside;
  that needs serialization designed rather than assumed. The synchronous binding
  covers local files and embedded replicas syncing from a primary, which is the
  case worth having first.
  
  Two differences between the engines are handled in the driver rather than pushed
  into the store. libSQL binds `Buffer` but not a bare `Uint8Array`, and it returns
  blobs as a `Buffer` from `get` but an `ArrayBuffer` from `all` and `iterate`.
  Rows are only rebuilt when they actually carry a blob, because posting scans
  return rows of plain integers and are the hottest path in the engine.
  
  `libsql` is an optional peer dependency: an installation that does not ask for
  the engine should not have to carry it.
  
  Not yet included: remote-only libSQL, which needs the asynchronous client and
  therefore the transaction serialization above.
- 48dbb58: Add a multi-model object store with its own event log.
  
  `zelavis/dbnew` writes a payload once and projects it through document, column,
  measure and graph lenses that hold only pointers back to a shared,
  partition-local identifier space. Because every lens addresses the same space, a
  predicate spanning several data models is one set intersection rather than an
  exchange between separate engines. Measured on a million synthetic objects,
  three specialist stores would have to ship roughly 1,363 identifiers between
  themselves for every row such a query returns; sharing the space removes that
  entirely. The lenses cost 1.79x the payload in derived storage, a ratio that
  moved by four thousandths across a fivefold change in scale.
  
  Locality is declared, not inferred. Everything sharing a `PartitionKey` is
  guaranteed to live together, which is what keeps that intersection cheap.
  Identifiers are dense and partition-local so posting sets stay small, and global
  identity is the pair rather than one global sequence — so a single-partition
  deployment today is a placement fact rather than an architectural commitment,
  and never needs repartitioning to become several.
  
  The event log is the source of truth. Writes append before projecting, so a
  crash leaves an event whose projection can be replayed rather than a lens row
  with no event behind it, and the lenses can be re-derived from the log alone.
  Cursors are opaque and carry their partition, keeping physical positions inside
  the driver where nothing can mistake a SQLite autoincrement for a logical global
  order. Opening a partition claims the next writer generation and fences the
  previous holder, including when both sit on one Node. Followers apply events
  idempotently by sequence and version, so an interrupted range can be
  re-consumed without duplicating work.
  
  Postings are a sorted array or a bitset, chosen per set by density. The shape
  matters more than the compression: a sorted run has to be walked to be
  intersected, while a bitset can be probed, so a selective predicate stays cheap
  against an arbitrarily unselective one — which is what a developer writes
  without thinking about it. Intersecting the two widest predicates from the
  design study drops from 26.4ms to 0.13ms, and postings are 10.7x smaller. The
  remaining cost of a wide query is now the b-tree scan that feeds the
  intersection rather than the intersection itself.
  
  Two contracts are shaped for what comes later. Queries are data rather than
  closures, because a closure cannot cross a network boundary and a router that
  takes one could only ever answer locally. Partition handles are held in a
  `LayerMap` rather than a cache, because eviction has to close the file; dropping
  the handle would leak descriptors and risk corruption on a WAL database.
  
  Not yet included: cross-partition resolution, snapshots — rebuilding replays all
  history rather than live objects — postings stored as bitmap blobs, which would
  remove the remaining scan but needs immutable segments and compaction, and any
  durability testing, so `synchronous=NORMAL` is configured rather than proven.
- 14f77fd: A static frontend can declare `frontend.assetBase` — the path its own asset
  references were built against, such as `/assets/`. The Platform rewrites those
  references to wherever the frontend is actually mounted, so one build serves
  from `/zelavis`, from `/`, or from anywhere else without being rebuilt.
  
  Only the declared base is rewritten, and only where it starts a quoted string.
  Rewriting every absolute reference would also rewrite links to API routes,
  which are not the bundle's to move, and matching anywhere in a file would
  rewrite prose and sourcemap comments.
  
  This is what a JSON manifest could not express before: serving one build from a
  configurable mount required a render function, which is why the dashboard had
  to be composed into the Platform rather than installed like any other frontend.
- 727a371: Give every installation a default frontend.
  
  The outermost installation previously returned `404` at `/`, which reads as a
  broken installation rather than a working one. It now uses the dashboard as its
  default frontend, so `/` leads there — the installation that runs the dashboard
  is its own product.
  
  A Project runtime does not run the dashboard and exists to host something that
  has not been chosen yet, so it keeps serving the frontend placeholder until a
  Frontend is installed. Neither shadows control-plane or API paths, which keep
  their own `404`s.
- 7d8b5e6: Make Fabric placement decide where a Project runs.
  
  Reconciliation reads the placement plan's assignments, not only its refusals. A
  Project the planner placed on another node is no longer started on this host,
  and one already running here when it moves away is stopped — running it anyway
  would contradict the Fabric, and on a fleet where every host reconciles, every
  host would reach the same conclusion and run its own copy. An explicit `start`
  is refused for the same reason, naming the node.
  
  `ZelavisProjectDispatcher` is the seam for handing such a Project to the node
  that owns it; without one, the Project is left stopped with the node recorded
  on the Project record, so "why is this not running" has an answer that survives
  the next runtime status poll. The Fabric's placement inventory now reports that
  node rather than asserting everything is local.
  
  Unchanged for a single-node installation: a host that does not know which node
  it is, and a planner that fails, both start everything locally as before.
- 4d3ba56: Reconciliation now enforces Project placement groups. A Project whose owner
  cannot be placed, or whose ownership forms a cycle, is left stopped rather than
  started somewhere its group does not permit.
  
  It acts on ownership failures only. Capacity and node eligibility are
  scheduling answers, and the local runtime driver does not schedule, so treating
  them as refusals would stop Projects on a single-node installation that models
  no capacity at all.
  
  A host with no Fabric, a plan containing no owned Projects, and a failing
  planner all reconcile exactly as before.
- 493e2b5: Add a guided `zelavis setup` terminal wizard and a first-open dashboard setup
  wizard, both backed by the existing durable first-owner bootstrap operation.
- d6be1ca: Add the Frontend contract.
  
  A package declares `"zelavis": { "kind": "frontend", "frontend": { ... } }` with
  a `runtime` of `static` or `server`. The runtime is declared, never inferred: a
  `start` script says nothing about whether a process should be spawned, and
  guessing would make that decision depend on a heuristic.
  
  Static frontends reuse the existing service `app` definition, including its SPA
  and MPA modes, rather than growing a parallel file server, and they load without
  a JavaScript entry because they are files rather than code. Bundle paths are
  validated to stay inside the package.
  
  Server frontends validate but do not install yet: they need a supervised process
  and a routed target through the Project runtime, so they are refused with a
  message that explains why rather than installing something that serves nothing.
  Their start command is argv rather than a shell string, so a manifest cannot
  smuggle shell metacharacters into process spawning.
  
  Malformed frontends are refused at manifest validation, so a mistake surfaces at
  install rather than as a broken site on first visit.
- 09ca0f1: Add the `frontends` marketplace category and Project ownership.
  
  A frontend must carry the `frontends` category and depend on `zelavis` to be
  listed in the marketplace. Listing is a promise that the frontend integrates —
  that it can consume the menu and content APIs rather than only rendering — so it
  is checked rather than assumed. A frontend that does neither is still
  installable; it simply cannot be listed.
  
  Projects can now own Projects. An owned Project is excluded from the Platform's
  project list, is deleted with its owner through a durable cleanup participant
  that runs before the owner's own runtime data, and its ownership survives a
  restart. Reconciliation still sees owned Projects, because ownership is a
  lifecycle boundary rather than a display rule.
  
  This is the foundation for running a `server` frontend: it needs a process, a
  data directory, a lifecycle, logs, and a routed target, which is what a Project
  already is. Nested ownership is refused until placement grouping exists.
- ddc8b7a: A frontend package can now be installed and run as an owned Project.
  
  Frontends are selectable as Project recipes, which they were not — recipes were
  filtered to `kind: "app"`, so an installed frontend package could never be
  chosen. A frontend recipe always produces a Project of kind `frontend`,
  whatever the package is called, because the runtime driver routes on that kind.
  
  The Node adapter supplies the server-frontend driver it never wired, along with
  a resolver that finds an installed package by walking up from its locked
  specifier to the nearest `package.json`, bounded by the directory packages are
  installed into. A frontend that was never installed is refused rather than
  guessed at.
  
  Preparing a frontend now also writes the Project record the local runtime reads
  back to route `stop`, `logs`, and `destroy`, which take a Project id rather than
  a descriptor. A frontend that wrote only its own metadata could be started and
  then never stopped.
- ae6614c: Route a Project's public paths to its server frontend.
  
  The Gateway now forwards a Project's public surface to its running server
  frontend, while `/zelavis/*` stays with the Zelavis runtime that owns the
  control plane.
  
  A frontend never receives a Platform authority envelope. The envelope exists so
  a Zelavis runtime can enforce the caller's permissions; a frontend is
  third-party application code, and handing it a signed claim about a Platform
  principal would give arbitrary code Platform authority.
  
  A frontend that is not yet running, or an ownership lookup that fails, falls
  back to the Project's own runtime rather than taking the site down.
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
- 48dbb58: Add `db.movement`, which relocates a tenant's records so an occupied range can
  be re-placed.
  
  A partition map carries routing and no data, which is why `topology.update`
  refuses to move a range tenants are standing on — the records would stay put
  while every read went to the new shard and found nothing. That refusal is
  correct and was also a dead end: a map could only ever be changed where it did
  not matter.
  
  Relocation is deliberately not a transaction, since there is no atomic write
  across two shards. It is a sequence whose every intermediate state is one a
  reader can safely be in, recorded as it goes so an interruption resumes rather
  than needing repair: copy the tenant while it is still being written to, catch
  the copy up from the source log in rounds, fence writes for the last round
  alone, move the routing, then drop the source. The tenant is never unreadable,
  and it is unwritable only for that last round — proportional to what arrived
  during the round before it rather than to how much the tenant holds.
  
  Routing is now read from the topology on every call rather than from the map a
  database opened with, so `forTenant`, `shardOf`, `partitionMap` and the health
  endpoint all follow a relocation instead of describing the layout as it used to
  be.
- 48dbb58: Compact the database event log, so storage tracks live objects rather than
  every write ever taken.
  
  Payloads, manifests and identities already are the snapshot and postings are
  derivable from manifests, which makes compaction log truncation rather than a
  separate snapshot format. `db.maintenance` exposes it per shard along with
  `status` and `reindex`.
  
  Reading history now has to handle being cut off: a cursor from before the cut
  fails with `CursorCompacted`, a full replay refuses with `LogCompacted`, and
  the state-reading paths are what still work — `reindexLenses` re-derives
  postings from stored manifests, and a backup exports from state once history no
  longer reaches back far enough to rebuild the tenant.
- 48dbb58: Add `tenant.migrations`, which brings stored documents forward from one schema
  version to another.
  
  Activating a version changes what is accepted from that moment on and leaves
  everything already written exactly as it was. That stays the default — a schema
  change should never silently rewrite data — but validation rejects unknown keys,
  so removing a single field is enough to put every existing document out of step
  with the active version. Migration is the deliberate other half.
  
  Instructions are data (`Rename`, `Set`, `Default`, `Drop`) rather than a
  function, for the same reason a query here is a value: a closure cannot be
  inspected, logged, or reviewed before it runs. `plan` reports what separates two
  versions, which fields will be discarded, and which differences the caller still
  has to answer.
  
  The decision is all-or-nothing even though the writes are not. Every document is
  transformed and checked against the new version before anything is activated or
  written, so a migration that would leave documents invalid refuses rather than
  getting halfway — and because every instruction is idempotent, an interrupted
  one is finished by asking for it again.
- 61a9b45: Name a capability owner written with the wrong scope marker, instead of letting
  it fail silently.
  
  A capability owner may be a bare service name (`zelavis/identity`) or a package
  (`@acme/shop`), and both are legal. That means `@zelavis/identity` is a
  perfectly valid owner which simply nobody is: it differs from the real service
  by one character, never matches it, and produces no error. The extension is
  grouped under an owner nothing reads, the settings page filtering on the real
  owner drops it, and the symptom is a catalogue that is merely empty — the
  failure the auth core's own source predicted before it was renamed.
  
  The listing could not report it either, because an owner nobody answers to
  looked exactly like one that is simply not installed yet: both were
  `ownerInstalled: false`. Extension points now also carry `ownerKnown`, which
  separates the two.
  
  `misscopedExtensionOwners` reports an extension point whose owner becomes a real
  service by adding or removing its scope marker, and a service discovered with
  one is now warned about at startup, naming the capability it declared and the
  owner it meant. It is deliberately narrower than "this owner is unknown":
  extending a service that is not installed here is ordinary and is the common
  shape of an unknown owner, so reporting those would bury the one case that is
  always a mistake. The service still loads — the rest of the package is fine, and
  refusing it would turn a typo into a Platform that will not start.
- d64fec1: Add native-Web request authentication, opaque persisted sessions, Web Crypto
  password hashing, Basic/JWT/JWKS verifiers, and the OIDC bearer plugin. Move
  Auth plugins out of the unified package and replace the retired child-service
  graph with capability-discovered provider registration contracts. Add
  provider-owned credential enrollment, token-gated first-owner bootstrap, real
  Platform dashboard login/logout, session cookies and rotation, same-origin
  cookie issuance and mutation enforcement, and permission gates for critical
  control-plane endpoints.
- 60afafa: Add an official native WordPress Project recipe with automatic host-stack provisioning, dedicated Nginx, PHP-FPM, and MariaDB lifecycle, robust Homebrew executable discovery and short private runtime sockets, actionable lifecycle errors, and managed-project dashboard creation and navigation. Persist explicit per-Project runtime assignments and recipe compatibility, expose native runtime availability through the API and dashboard, repair historical records to native, and reject unavailable Docker assignments without changing existing Projects.
  
  Add backend-neutral deployment capability detection and durable administrator policy, a read-only Node Docker probe, permission-gated backend endpoints and Server UI, and a verified authority-gated host-operation executor foundation. Backend choice is now server policy rather than an ordinary Project creation option; Docker installation, Docker Project execution, migration, and hardened native isolation remain explicitly unavailable.
  
  Centralize deployment adapters under the new `zelavis/backends` surface with built-in `native` and `docker` modules. Add `zelavis/agent` contracts and a durable Agent operation journal with stable identity, operation-bound HMAC authority, atomic leases, bounded concurrency, replay-safe IDs, restart recovery, redacted audit summaries, and permission-gated read endpoints. Separately supervised IPC and registered privileged installation operations remain future work.
- d7bd476: Add an identity provider by pasting its issuer URL, and list plugin extensions
  by what they extend.
  
  Every OpenID Connect issuer publishes its endpoints at
  `/.well-known/openid-configuration`. Configuring a connection with an `issuer`
  reads that document and registers the provider, so Google, Microsoft, Okta,
  Auth0, Keycloak, or a company's own SSO is a URL rather than a plugin or a
  release. The document's own `issuer` must match the URL requested and every
  endpoint must be https, because one of them supplies the keys that decide
  whether an ID token is genuine.
  
  Google's constants are gone as a result: it is ordinary OIDC. GitHub stays,
  because it issues no ID token and its profile endpoint and claim mapping are
  real code rather than a list of URLs. That is the line for shipping a provider
  definition at all.
  
  `GET /runtime/extensions` lists services that extend another, grouped by what
  they extend, optionally narrowed with `?owner=`. `zelavis extensions [--for
  <service>]` is the same over the command line, and each service in the registry
  listing now carries `extends`, so a general catalogue can leave extensions out
  and show them beside the plugin they extend instead. Installing an extension
  whose owner is absent is refused rather than silently doing nothing.
  
  Fixes capability parsing reading any unknown prefix as a service. `app:project`
  is a domain namespace, and treating it as an owner invented an extension point
  called "app" with the shipped Project recipes listed under it. A service owner
  is now recognised by containing a `/`, which every service name does.
- 48dbb58: Store postings as immutable bitmap blobs, so a wide query stops costing one
  b-tree entry per object it matches.
  
  `db.maintenance.seal` folds the live postings into segments of 65536
  identifiers — a dense bitmap or a sparse offset list, chosen per segment. Writes
  keep their cheap shape because a blob is never edited: what is written after a
  seal lands in the live tier beside it, and what is removed from a sealed lens
  leaves a tombstone that the read subtracts.
  
  Sealing is incremental. A segment is read, merged and written back only where a
  live posting or a tombstone falls inside it, so a periodic seal costs what
  changed rather than what is stored.
  
  At 200k objects and 600k postings: a wide term 305 ms → 27 ms, a wide column
  77 ms → 6 ms, and a selective predicate intersected with an unselective one
  279 ms → 1.4 ms. Re-sealing after touching 1% of them takes 0.09s against 4.11s
  for the first seal.
- 48dbb58: Document writes accept an idempotency key, so a retry is answered rather than
  applied twice.
  
  The API being replaced took a key when appending an event. There is no append
  here — writes reach the log only through the documents API — so the guard
  belongs where the write enters. `insert`, `update` and `delete` take an optional
  `idempotencyKey`, and a repeat carrying it returns what the first attempt
  returned.
  
  The receipt is written in the same transaction as the change it describes.
  Recorded afterwards, there would be a window in which the write had happened and
  the key had not been noted, which is exactly the window a retry falls into.
  
  A key offered for a different request is refused with `IdempotencyKeyReused`
  rather than answered with the stored outcome, an attempt that failed spends no
  key, and `forgetIdempotencyKeys` sweeps receipts — they grow with requests
  rather than with data, and how long a retry may arrive is the caller's question.
- 48dbb58: Add `db.scatter`, the explicit contract for questions that span partitions.
  
  Everything else in the database is deliberately partition-local, which is what
  makes the common case cheap and is exactly what a cross-partition question gives
  up. So this is a surface a caller reaches for on purpose rather than one the
  ordinary APIs fall back to: it fans out per shard for lens queries and per
  tenant for document queries, and every result carries its legs so the cost is
  visible per part.
  
  It refuses two things rather than answering them. A query naming a
  partition-local identifier — an edge above all — means a different object on
  every shard, so scattering one would return rows that look like matches and are
  not. And a shard the partition map does not have is an error, because reading
  the rest quietly would answer a narrower question in the shape of the asked one.
  
  Stores gain `identityOf`, the reverse of `lookup`, so an identifier handed
  across a partition boundary can be turned back into a name.
- d8d6880: Give `zelavis/db` a declared placement class and a home for App-scoped data.
  
  `PlacementClass` names the three scopes a collection can have: `partitioned`
  (tenant-scoped, routed by the partition map, and the default for anything
  undeclared), `global` (App-scoped, one reserved store no map places), and
  `replicated` (App-scoped, copied onto every placed shard — named but not yet
  implemented). A placement catalog lives beside the partition map in the same
  store, records only deviations from the default, and is validated on open and
  refused if it has dropped or reclassified an internal. Declaring a class is
  idempotent and immutable afterwards: reclassifying moves data, so it belongs to
  relocation rather than to a catalog write.
  
  `db.global` is new — the same surface a tenant gets, over one reserved tenant in
  one reserved store, for plan definitions, feature flags and shared lookup tables
  that would otherwise be copied into every tenant or kept outside the database.
  Creating a collection there catalogues it as `global`. Because App-scoped data
  is isolated by the same structural tenancy that separates customers, a global
  `plans` and a tenant's `plans` are simply different collections and cannot
  collide — no App-wide name reservation, and no cross-tenant check on create.
  
  The global store is compacted, reindexed, snapshotted and sealed with every
  other store, and `scatter` never reads it: it is not a partition, and a write
  there is not atomic with a write to any tenant.
  
  `zv.topology` is now classified through the catalog instead of being
  special-cased in `makeDatabase`, and `TOPOLOGY_SHARD` moves to the topology
  module beside `ShardId`. Tenant routing is unchanged.
- 8443cb8: Ship the public `zelavis` executable for running the long-lived Platform OS and
  replace obsolete embedded-framework bootstrap commands with endpoint-backed
  operator commands.
  
  Add a shared release-staging model for self-contained archives, Debian packages,
  and signed APT repositories. Operating-system artifacts carry a pinned private
  Node runtime while the npm package remains available to Node-managed hosts.
- 81554ed: Make a fresh installation adoptable: ship a credential provider and add
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
- 8887ddb: Unified plugin operations across HTTP, JS SDK, and CLI with typed contracts:
  
  - Declarative plugin operations via `zelavis.operations.create` exposed at `/zelavis/api/v1/plugins/<namespace>/<resource>`, `client.plugins.<namespace>.<resource>.<action>()`, and `zelavis plugins <namespace> <resource> <action>`.
  - CLI ergonomics: support for `--data <json>`, `--data-stdin`, `--file -` (stdin), and `--flag=value` syntax.
  - Migrated `@zelavis/ecommerce` endpoints to declared operations with OpenAPI specs and typed `EcommercePluginClient` augmenting `PluginApiRegistry`.
- d8d6880: Add a scoped Project metadata update route and SDK method, plus a matching CLI
  rename command, so clients can manage the canonical Project name without
  maintaining a local alias.
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
- d54621c: Forward verified public domains to the Project that owns them.
  
  A request arriving on a verified bound domain is forwarded to that Project,
  choosing its running server frontend when there is one and falling back to the
  Project runtime otherwise.
  
  Forwarding is anonymous. A visitor has no Platform identity and the target may
  be third-party frontend code, so no Platform credentials are relayed and no
  authority envelope is signed or sent. Only a verified binding is routable:
  anyone can point DNS at a host, and verification is what proves the operator
  controls it.
  
  The Project's own `set-cookie` is preserved, unlike on the Gateway path, because
  the response is served from the Project's own domain rather than the Platform
  origin. The Project's control plane is not published on a bound domain.
  
  An unbound host falls through to the installation's own root behaviour, and a
  stopped Project answers `503` rather than hanging.
- 48dbb58: Time series `range` and `aggregate` accept a tag filter.
  
  Points were already indexed by tag; nothing read those postings. A filter now
  does: every named tag must match, a tag given several values matches any of
  them, and both compose with the time window rather than replacing it.
  
  It is worth most exactly where the window gives up. Past the bucket-clause limit
  a range stops naming buckets and asks for the whole series — with a filter, that
  fallback is intersected with the tag, so the query costs the tag rather than the
  series.
- 0bf279e: Reclaim the Project processes a crashed Platform left running.
  
  A Platform killed outright — SIGKILL, an OOM kill, a power loss — runs no
  shutdown, so its Project processes keep going. They keep their ports, keep
  answering requests, and keep their database files open, while the Platform that
  replaces them has no memory of them at all. The observed result was a WordPress
  Project reported as running whose new nginx logged
  `bind() ... Address already in use`, with traffic served by the process from
  before the crash.
  
  The Agent runner now records every process it starts, and stops what a previous
  Platform left behind: a full sweep on the first start after boot, and a
  per-workload reclaim before that workload starts again. Stopped rather than
  adopted — a child's output arrives over pipes owned by the process that spawned
  it, so once that process is gone there is nothing to reattach to.
  
  A leftover is identified by how long it has been running rather than by its
  command line, because daemons rewrite their own argv: php-fpm reports itself as
  `php-fpm: master process (...)`, which contains nothing of the path that was
  executed. A record whose owning Platform is still alive is left alone, and a
  process whose age does not match its record is never signalled.
  
  The native WordPress readiness waits also now fail when the process they are
  waiting for has exited, so a stale listener on a reused port cannot be mistaken
  for a successful start.
  
  Also fixes a regression: reconciliation started Projects outside their lifecycle
  lock, so a start could interleave with a concurrent stop.
- d8d6880: Add a provider-neutral remote environment identity, health, session, process,
  and cursor-based event replay contract with matching tenant-scoped HTTP routes
  and SDK methods. The Node adapter now projects the supervised Zelavis Agent
  process runner onto that contract, including stdin, signals, termination,
  bounded incarnation-aware output replay, and reattachment of active session
  processes after a Platform restart.
- e4eb275: Refuse edges on a `replicated` collection where they are declared, rather than
  as a defect raised later by whichever write first produced one.
  
  An edge names a record by identifier and every replica reallocates those, so a
  replicated collection cannot carry one. That was previously caught when the
  record was copied, which meant an ordinary `insert` died with no way to report
  why: `DocumentsApi` has no error channel for a replication failure. The same
  condition reported a typed error from `db.replication.refresh`, so identical
  misconfiguration failed in two different shapes.
  
  `db.global.documents.createCollection` now refuses an `edges` definition on a
  name declared `replicated`, returning `InvalidConstraint` — which the collection
  API already reports for a constraint it cannot accept, so no error channel had
  to widen. The opposite order was already refused: creating an undeclared
  collection through `db.global` claims it as `global`, and a class does not
  change afterwards, so a collection created with edges can never become
  replicated.
  
  There is no other way for a collection to gain edges, so the state is now
  unreachable and the checks in `replication` are assertions rather than an
  expected path. A `global` collection may still declare edges freely, since
  nothing copies it.
- 6b293f4: Implement the `replicated` placement class, so App-scoped data can be read from
  a tenant's own shard without a fan-out.
  
  `db.replication.refresh` materializes every `replicated` collection onto every
  placed shard, and `tenant.shared` is the read-only view of what landed there.
  The read is physically local — same shard, no second store opened, no partition
  crossed — which is the whole point of paying to replicate.
  
  The copy is a snapshot rather than a log tail, deliberately. A retraction
  carries only a `Seq` and no identity, so a log follower has to remember what
  every identifier stood for in order to apply a delete; `movement` can hold that
  map in memory because a move is one bounded operation, but replication never
  ends and survives restarts, so the same map would have to be persisted and would
  grow with the data. A snapshot needs no such memory. The cost is the size of the
  replicated data per refresh rather than the size of the change, which is the
  right trade only while replicated collections stay small and read-mostly.
  
  Refreshing is explicit and runs when a database opens, so a write to a
  replicated collection reaches tenant-local reads at the next refresh rather than
  when it commits. There is no cross-store transaction.
  
  Two things are refused rather than silently got wrong: a replicated collection
  carrying edges fails with `ReplicationUnsupported`, because an edge names a
  record by an identifier every replica reallocates; and the tenant occupancy
  marker is never copied, so a replica cannot make the App look like an occupant
  of a shard and mislead a rebalance.
  
  Creating a collection through `db.global` now claims it as `global` only when
  the name is undeclared, so declaring `replicated` first and creating it second
  is how a replicated collection is made.
- 4f8f3ef: Carry writes to `replicated` collections to every shard as they happen, so a
  tenant-local read no longer waits for an explicit `db.replication.refresh`.
  
  The naive version of this — running a refresh after each write — would cost the
  whole collection per shard on every insert, so a batch of a hundred rows would
  pay for a hundred full copies. It is not needed: a refresh compares whole states
  only because nothing tells it what moved, and a write knows exactly. Writes now
  propagate by identity, one record per shard. Deletes travel the same way, and
  the retraction problem that ruled out log-tailing does not arise, because the
  caller names the identity rather than leaving it to be recovered from a `Seq`.
  
  A change that is not one record's still re-levels: `rewrite`, index, check,
  reference, analyzer and embedding changes rewrite the manifest of every document
  in the collection, so there is no single identity to carry. These are rare next
  to writing a document, which is what makes the expensive answer right there and
  wrong on the write path.
  
  `db.replication.refresh` remains, and still runs when a database opens — it is
  what levels a shard that joined while the database was closed, or one left
  behind by an interrupted pass.
  
  Adds `ObjectStoreApi.manifestOf`, since copying a single record previously meant
  reading the whole partition through `liveRecords` just to find its manifest.
  
  A write that would produce an edge in a replicated collection now fails rather
  than replicating a pointer that means something else on every shard. It surfaces
  as a defect, because `DocumentsApi` has no error channel for a replication
  failure; `refresh` still reports the same condition as a typed
  `ReplicationUnsupported`.
- abcce55: Publish an OpenAPI document that describes the API this runtime actually
  serves.
  
  The spec re-resolved endpoints from the service list using a different prefix
  than mounting used, and none of the service prefixes — so it published
  `/api/auth/accounts` for an endpoint served at `/zelavis/api/v1/auth/accounts`.
  Every path in it was wrong. It now reads the routes mounting produced, so the
  document and the router cannot drift apart.
  
  It also described only routes carrying a `spec` field. Nothing in the
  Platform's own control plane carries one, so a fresh installation published
  fourteen auth paths out of fifty-nine routes while looking complete. Every
  mounted route is described now; ones nobody has annotated are marked
  `x-zelavis-undocumented` and take their operation id from the route id, so a
  reader can tell which endpoints exist but have no inputs and responses written
  down yet.
  
  The document now carries a `servers` entry naming the origin it was fetched
  from, and the router's `*rest` wildcards are converted to OpenAPI `{rest}`
  rather than being emitted as literal asterisks.
  
  `runtime/openapi` is served alongside `runtime/openapi.json`. The extensionless
  path is what a reader tries first, and answering it with a 404 read as though
  the Platform published no spec at all.
- 509067a: Scaffold a frontend from a `create-*` package.
  
  `POST /runtime/services` accepts `scaffoldFrom` alongside `packageSource`. The
  create package is acquired through the same verified npm path as any other
  install — so the installation's source policy governs what can run — and its
  declared bin runs as a child under Node's permission model with the network
  closed: no child processes, no native addons, reads confined to the package and
  the run directory, writes confined to the output directory, and the outbound
  network primitives removed from the module layer the child sees.
  
  Deliberately not `npx`, which would resolve and install a dependency tree from
  whatever registry npm is configured with and leave the source policy
  decorative. What the run produces is validated as a Zelavis frontend and
  registered like any other installed package, so it is immediately selectable as
  a Project recipe.
  
  This is a boundary against a create package doing something unexpected, not an
  OS sandbox; an operator running genuinely untrusted create packages still wants
  container isolation around the Platform.
- 55ee49f: Run `server` frontends as Project-owned runtimes.
  
  A server frontend — an application that brings its own HTTP server — is now
  executed by a Project runtime driver rather than refused. The driver spawns the
  manifest's declared argv with a Platform-allocated port, waits for that port to
  accept connections, and reports a routable loopback URL.
  
  Readiness is a port check rather than a protocol handshake: an arbitrary
  frontend knows nothing about Zelavis, so the only portable signal is that it
  bound the port it was told to use. A frontend that exits before binding fails
  with its own stderr attached, and one that never binds times out rather than
  hanging the lifecycle.
  
  The driver reuses the Project environment allow-list and log bounds instead of a
  second copy, so a frontend never inherits Platform secrets. A static frontend is
  refused a process, because it does not need one.
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
- 36a7877: Serve a component library service pages render with, and rebuild the
  marketplace page on it.
  
  A service page runs in its own document and inherits nothing from the
  dashboard. The design tokens at `runtime/service-page.css` closed half that gap;
  a page still wrote the markup for every card, badge, field, and empty state
  itself, which is why the marketplace page was a placeholder built from bare
  `div`s and a private copy of the layout rules.
  
  `runtime/service-elements.js` now serves an element library — `zv-page`,
  `zv-section`, `zv-card`, `zv-stack`, `zv-row`, `zv-title`, `zv-badge`,
  `zv-button`, `zv-field`, `zv-empty`, `zv-status` — and a frontend may supply its
  own through `serviceElementsScript`, exactly as it supplies the stylesheet.
  Components belong to a design system, and the Platform ships a baseline only so
  a page is never left composing nothing.
  
  Each element renders into a shadow root, so a page's CSS cannot reach in and a
  component's rules cannot leak out, while the tokens still reach the components
  because custom properties inherit through shadow boundaries — the seam that lets
  a frontend restyle every service page in the installation.
  
  The frame stays. Shadow DOM scopes styles, not scripts, and rendering an
  installed service's page inside the dashboard's document would give its code the
  dashboard's origin and session.
- 43540af: Discover services from a `services` folder on the server, and let a
  plugin declare whose contract it satisfies.
  
  The folder was only ever a convention — the shipped placeholder told operators
  to drop a frontend package into `services`, and nothing scanned it. The
  Node adapter now reads `<dataDirectory>/services/*/package.json` at
  boot, validates each manifest, and registers what it finds through the same
  importer and validation as any installed service. Scoped packages nest one
  level deeper, as in `node_modules`. Pass `services: false` to scan
  nothing.
  
  Discovery refuses rather than trusts: an `exports` entry resolving outside its
  own package directory, a missing entry file, an invalid manifest, and any
  package claiming a reserved core service name are all skipped with a reason.
  A package that fails to load is skipped too, so one broken download cannot stop
  a Platform from booting.
  
  Capabilities may now be owned by the package that defines them —
  `@zelavis/auth:credentials` alongside the existing `provider:auth` — and are
  validated at manifest time. Domain-namespaced capabilities say what interface a
  plugin implements but never whose contract it satisfies, so two commerce
  plugins both scanning `provider:payments` pick up each other's providers.
  Discovery stays a flat scan with no parent/child graph: naming an owner asks to
  be considered by it and grants nothing, and the owning plugin still validates
  every provider against its own registration contract.
  
  Also fixes runtime option merging silently dropping `manifestResolver`, which
  discarded the adapter-supplied resolver whenever adapter and host options were
  combined.
- d03bd81: Add conditional writes to file storage, and a probe that checks a store enforces them.
  
  `storage.put` takes an optional `condition`: `{ ifAbsent: true }` creates only
  where nothing is stored, and `{ ifMatch: etag }` replaces only the version a
  reader saw. Entries now carry that `etag`. A condition that does not hold
  rejects with `ZelavisStorageConditionError` and writes nothing. S3-compatible
  storage sends `If-None-Match` and `If-Match`; local storage creates by hard
  link, which is exact across processes, and compares and replaces under a
  per-object queue, which is exact within one process.
  
  `probeFileStorageGuarantees(storage)` asks a store directly whether it keeps
  the guarantees a lease or a fence rests on, in the four steps celld runs before
  a node serves: a create applies, a second create is rejected, an update with
  the current version applies, an update with a stale one is rejected, and every
  read returns the last write. Some stores accept the conditional headers and
  ignore them. The probe names that failure rather than letting it surface later
  as two owners of one thing.
- 565846d: Let a Tenant too large for one shard be divided into parts.
  
  A Tenant is the locality unit, and everything belonging to one living on one
  shard is what makes a cross-model query a local intersection rather than a
  network exchange. A Tenant that does not fit on a shard is the one case that
  bargain cannot be kept, and until now there was nothing to do about it:
  `AGENTS.md` promised that exceptional Tenants would eventually scale Shards, but
  no code did.
  
  `topology.subdivision.subdivide(tenant, parts)` declares a Tenant divided.
  `db.forPart(tenant, part)` reaches one part, and `db.forTenant` now **refuses** a
  divided Tenant rather than handing back one part — answering a question about a
  fraction as though it were about the whole is precisely the quiet wrong answer
  this design exists to avoid. A question about the whole Tenant is a `scatter`
  over `topology.subdivision.keysOf(tenant)`, which is explicit and reports what it
  cost.
  
  Below routing a part is simply a Tenant. Tenancy here is structural — part of
  every namespace and lens key — so a part with a compound key gets the same
  isolation, the same dense identifier space and the same local intersection
  *within itself* from machinery that already existed. Storage, lenses, movement,
  scatter and backup needed no changes; only routing and a registry are new.
  
  Dividing is a routing decision and carries no data, so it is refused for a
  Tenant that already holds records, for the same reason `topology.update` refuses
  an occupied range: the records would stay under the undivided key while reads
  went to parts that do not hold them. Re-keying an occupied Tenant into parts is
  a migration rather than a routing change, and is not part of this.
  
  Atomicity now stops at one partition rather than one Tenant. For every undivided
  Tenant — which is nearly all of them — the partition is the Tenant and nothing
  changes. `AGENTS.md` is updated to match.
- 48dbb58: Time series ranges stay indexed however long they are.
  
  A range spanning more than 400 buckets used to give up naming them and scan the
  whole series. Points are now indexed at five widths, each eight times the last,
  so a range is covered by whole coarse blocks in the middle and finer ones at its
  edges. Ten years of days costs under thirty clauses; the cap survives only as a
  backstop against a range of a million years.
  
  The cost is one posting per level on each point written, which sealing folds
  into blobs. Points are derived state, so an existing series takes the new index
  by being rebuilt.
- 1b8c0b7: Enforce writer generations inside physical SQLite writes.
  
  A writer claims a generation before it may mutate a shard, and every write
  transaction re-reads the durable fence. A superseded writer — one partitioned,
  paused, or holding a stale topology — is rejected by the shard it is trying to
  write to, rather than trusted to notice it lost ownership.
  
  The fence is persisted, so it survives reopening the database and holds across
  processes. Taking over advances it; re-claiming the same generation is allowed
  so a restart does not need a new one; claiming an older generation is refused.
  
  Fencing is advertised through `DatabaseCapabilities.writerFencing` and an
  optional `DatabaseDriver.claimWriterGeneration`. A driver that does not
  implement it stays unfenced, which remains the embedded single-process default.
  The sharded driver claims each shard at the generation its topology says owns
  it, before its first write.

### Patch Changes

- df8fcf2: Add a tabbed schema builder to the database dashboard.
- a59cfad: Describe every control-plane operation in the OpenAPI document.
  
  Routes across runtime, platform, auth, fabric, database, workloads, the Project
  and workload proxies, and the frontend front doors now declare an operation id,
  a summary, tags, and their responses. A client generated from the document
  names its methods after the operation rather than after a route id, and nothing
  the Platform serves is left marked `x-zelavis-undocumented` — that marker now
  belongs to installed services that ship a route without a `spec`.
- 448e097: Stop one installation of Zelavis silently replacing or shadowing another, and
  report which one is running.
  
  The command name is shared by installs that cannot see each other. A Debian
  package links `/usr/bin/zelavis`, the archive installer links
  `/usr/local/bin/zelavis`, and `npm install --global zelavis` writes into npm's
  prefix, which is commonly that same `/usr/local/bin`. Two failures followed.
  The archive installer's `ln -sfn` replaced an npm install without a word. And
  because `/usr/local/bin` precedes `/usr/bin` on Debian and Ubuntu, an npm
  install shadows a packaged one with nothing overwritten: both are present,
  both look healthy, and `zelavis` quietly means the npm copy.
  
  The archive installer now refuses to replace a `zelavis` it did not create,
  naming what the path resolves to and how to proceed — remove the other
  install, set `ZELAVIS_BIN_DIR` elsewhere, or set `ZELAVIS_FORCE_BIN=1` to
  replace it deliberately. Its own link from an earlier release is still
  replaced, so upgrades are unaffected.
  
  Shadowing cannot be refused, because nothing is overwritten: path order alone
  decides. Both the archive installer and the Debian package's `postinst` now
  warn when `zelavis` on the path resolves somewhere other than the copy just
  installed. The Debian package warns rather than failing, because refusing an
  install over path order would break `apt upgrade`.
  
  `zelavis --version` now also prints the installation it is running from —
  packaged, npm, or a source checkout — resolved through symlinks. The version
  alone cannot distinguish two installs that may hold the same version, so this
  is what turns "the upgrade did not take effect" into a question that answers
  itself. The bare version stays on the first line.
- 344368e: Add the first Zelavis CLI package with React Router and Next.js bootstrap commands.
- ac8daa0: Stop the CLI defaulting its Platform data directory to the current working
  directory.
  
  `zelavis serve` and `zelavis agent` resolved their data directory to
  `.zelavis` relative to wherever the command was typed, so running the same
  installation from two directories served two unrelated Platforms — different
  owners, different Tenants, different databases — with nothing on screen saying
  so. `cd` was effectively part of the address.
  
  The default is now the user's data directory: `$XDG_DATA_HOME/zelavis` when
  that variable names an absolute path, otherwise `~/.local/share/zelavis`. A
  relative `$XDG_DATA_HOME` is ignored, as the specification requires. The full
  chain is `--data-dir`, then `ZELAVIS_DATA_DIR`, then that default.
  
  Packaged installations are unaffected: their systemd units set
  `ZELAVIS_DATA_DIR=/var/lib/zelavis`, which is resolved ahead of the default, so
  `.deb` and archive installs keep the FHS location a system service belongs in.
  What changes is the npm path, where no installer has chosen a location.
  
  The embedded adapters are deliberately unchanged. `nodeAdapter`/`bunAdapter`
  still default to `.zelavis` relative to the application, because two
  applications embedding Zelavis on one machine must not silently share one
  global directory. A relative `.zelavis` also remains correct for Project-scoped
  state stored inside a Project's own directory.
- 7a32736: Refresh the core prerelease line after the release workflow cleanup.
- 349549b: Every database operation now has a route, and a test that keeps it that way.
  
  Five operations were reachable in process and nowhere else: `analyze`,
  `locate`, `embed`, `withRelated` and `collectionExists`. They have routes now --
  `POST /:collection/analyzer`, `/geometry` and `/embedding` to declare and
  rewrite under an analyzer, a spatial index or an embedding; `POST
  /:collection/related` to resolve what a page of documents references; and `GET
  /collections/:collection/exists`.
  
  The test is the point of this change. Wiring a capability is a separate step
  from building one, nothing failed when it was skipped, and so it kept being
  skipped -- three slices in a row shipped something the HTTP surface could not
  reach, including an operation added to the runtime API one change earlier
  without a route to call it.
  
  Coverage is derived rather than listed. A hand-maintained map of operation to
  route would rot in exactly the way the thing it is meant to catch rots, so the
  test wraps the tenant API in a recorder, invokes every route the service mounts,
  and asserts that every method a caller can reach in process was reached by one
  of them. A capability added without a route now fails the build instead of
  waiting to be noticed.
- 0e6fdc5: Stop bounded scans at the engine.
  
  `KvScanOptions` takes a `limit`, and every engine honours it — SQLite with
  `LIMIT`, the others by closing their iterator. The store passes it wherever it
  reads only part of a range. A stream pulls an iterable thousands of entries at
  a time, so a scan cut short by the stream still read up to 4,096 rows: a first
  page of 50 over 50k documents drops from 6.6 ms to 0.6 ms.
- 54c5aec: Serialize writes to a store, so concurrent writers no longer lose commits.
  
  A commit reads the event log's next position and writes it back advanced;
  `nextSeq`, sealing, compaction and both lens rebuilds read state and write it
  back the same way. On an engine whose reads and writes are asynchronous, two
  of those in flight at once read the same value, and the second write replaced
  the first. With LMDB and RocksDB, 31 of 32 concurrent commits returned
  successfully and left no event behind, and on LMDB concurrent `nextSeq` calls
  handed one identifier to two objects. SQLite and libSQL were unaffected only because their drivers
  never interleaved.
  
  Each store now admits one writer at a time. Reads take no permit and still see
  committed state, and nothing holding the permit waits on another write, so
  the lock cannot deadlock against itself. `db-concurrent-commits.test.mjs`
  holds every engine to it.
- 3db7ee9: Take ecommerce out of the Platform.
  
  Core knew about a product it does not ship. Its capability union listed
  `@zelavis/ecommerce:payments`, its doc comments used the plugin as an example,
  its test suite carried three ecommerce test files plus a 250-line block
  creating customers, products and orders, and its `test` script built three
  ecommerce packages before it could run — so the Platform could not test itself
  without building a shopping cart, and a change to a cart could fail the
  Platform's suite.
  
  Core's capability hints now list only the Platform's own services; a capability
  owned by a plugin is that plugin's to name. Examples in doc comments use a
  neutral `@acme/shop`.
  
  The ecommerce tests moved to the plugin, which gained a test runner, and the
  persistence coverage moved with them rather than being dropped. What core
  needs from a plugin — that it mounts, receives its setup context, and is handed
  platform resources — is covered against a fixture that belongs to nobody.
  
  The manifest consistency check now discovers workspace services instead of
  listing them. A hand-maintained list is what let two payment gateways ship with
  no `zelavis` block and a removed `kind`; discovery immediately found that a
  `frontend` is exempt from the `main` rule, which a list would have missed.
  
  Verified by deleting every ecommerce `dist` and running the Platform's suite.
- 3808410: Take the dependency backlog: TypeScript 7, ESLint 10, `@types/node` 26,
  better-sqlite3 13, swiper 14, Changesets 3, and the GitHub Actions from v4 to
  v7.
  
  TypeScript 7 removed `baseUrl` and refuses non-relative `paths`, which four
  example projects used to reach workspace sources. Their mappings are relative
  now. It also stopped resolving ambient node types implicitly for those
  projects, so each declares what it actually has: `types: ["node"]` where the
  example uses node builtins, and `types: []` for the fetch-native example, which
  depends on none and previously borrowed them by accident.
  
  The `typeRoots` overrides are gone with it. They existed to work around pnpm's
  non-hoisted layout, and each example now declares its own `@types/node`, so
  default resolution finds it by walking up from the tsconfig.
- 12e430f: Payment gateways declare `@zelavis/ecommerce:payments`.
  
  They declared `provider:payments`, a bare domain namespace that says what a
  gateway implements and never whose contract it satisfies — so a second commerce
  plugin scanning for it would collect these gateways too, and neither plugin
  could tell. Naming the owner also places them: a gateway now appears under
  `@zelavis/ecommerce` in `GET /runtime/extensions` and on that plugin's own
  settings page, rather than in a general catalogue where a payment gateway sits
  beside a dashboard theme.
  
  Both gateways also declared `kind: "provider"`, a kind removed when the
  taxonomy collapsed to `app | frontend | plugin`, and neither package.json
  carried a `zelavis` block at all — so installing either would have been refused
  at manifest validation. They only ever worked composed in code.
  
  Installing a gateway without `@zelavis/ecommerce` is now refused rather than
  appearing to work: the commerce plugin is what discovers it, so on its own it
  would look enabled and process nothing.
  
  Also corrects the capability hints in `zelavis/core`, which still listed
  `@zelavis/auth:credentials` after core auth was renamed to `zelavis/auth`.
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
- 78b5839: Give the ecommerce plugin a working dashboard, with a payments settings page.
  
  Its menu never reached the dashboard. The plugin adds its routes during setup,
  so it carries no `basePath`, service, or routes of its own — and the mount
  check looked for exactly those, dropping a menu with five pages while the
  plugin looked installed. A service contributing only a menu or page assets is
  mounted now, because a menu is a contribution too.
  
  The pages would not have rendered anyway. They pointed at `bundle: "dashboard"`,
  which resolves through the bundle store, and nothing ever uploaded them into
  one — every page answered "Service asset not found". They ship as page assets
  now, generated from the same editable HTML on disk, which needs no upload step.
  
  A new Payments page lists the gateways this installation can take payments
  through and the plugins that extend `@zelavis/ecommerce`, so a payment gateway
  is chosen where it means something rather than in a general catalogue. Stripe
  and PayPal carry marketplace titles for it, since a list of package names says
  less than the gateway an operator is choosing between.
- 6a8c8c2: Automatically detect and resolve package.json manifests across all services and plugins, eliminate manifest.ts files, and extract @zelavis/app as an official kind: "app" service.
- 6f057e5: Stop returning internal exception messages to clients.
  
  An unexpected failure now answers with a generic message and a correlation id
  rather than the exception's own text, which routinely names filesystem paths,
  module specifiers, SQL fragments, and internal service names. The full cause
  still reaches the error lifecycle event, carrying the same correlation id, so an
  operator can join a support report to the real error.
  
  Useful errors are unchanged. A 4xx status means a mapping rule recognized the
  failure as a problem with the caller's request, so validation and conflict
  messages are returned verbatim; typed domain errors keep their message at any
  status. Only unrecognized 5xx failures are genericized.
  
  The Project child runtime answered every failure as a `400` carrying the raw
  exception message, bypassing the policy entirely; it now uses the shared
  mapping.
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
- 8f99bdf: Harden the Project Gateway trust boundary.
  
  Gateway proxy targets are pinned to the selected Project runtime origin. The
  wildcard path was resolved with `new URL(reference, base)`, so a value such as
  `https:/example.com/pwn` resolved to a different origin and the Platform issued
  the request there. The path is now treated as opaque segments, with traversal,
  control characters, and malformed encoding rejected.
  
  Platform credentials are no longer relayed into Project runtimes. `cookie` and
  `authorization` authenticate the caller to the Platform, and a Project runtime
  is ordinary Project code rather than a trusted peer. Client-supplied
  `x-zelavis-*` authority headers and hop-by-hop headers are stripped, and
  `set-cookie` is dropped from proxied responses so a Project cannot overwrite the
  Platform session cookie.
  
  Proxy verbs are authorized separately: reads require `project.view`, mutations
  require `project.runtime.manage`. `project.view` was previously blanket
  mutation authority against the child runtime.
  
  Scope matching fails closed. A stored grant that omitted its `projectId` or
  `serviceName` matched every Project or service of that type, and an unresolved
  route parameter weakened the requirement instead of denying it.
  
  Project runtimes no longer derive authority from unsigned headers. Four
  ordinary request headers produced a `permissions: ["*"]` system principal, and
  the runtime listens on loopback, so any local process could assert them.
  Authority is now a short-lived envelope signed with a per-runtime secret,
  verified for audience, expiry, and single use, and carrying the caller's own
  Project permissions rather than a wildcard.
  
  Project children no longer inherit the Platform environment. Spawning with all
  of `process.env` exposed the bootstrap token, provider credentials, signing
  keys, and database URLs to Project code; only variables a Node process needs to
  run are forwarded now.
  
  Project lifecycle transitions are serialized. Creation used a read-then-write
  existence check, so two concurrent creates could both provision the same
  identifier; it now claims the identifier atomically with `setIfAbsent`. Start,
  stop, restart, and delete run through a per-Project queue, so a stale write can
  no longer land after a newer one — previously a concurrent stop could write a
  Project record back after deletion had removed it. Stop also refuses a Project
  that is already being deleted.
  
  Resource budgets are explicit where input was previously unbounded. Request
  bodies are read with a byte ceiling and refused with `413` — `Content-Length`
  is checked first as a cheap rejection, but the stream is also measured so a
  lying or absent header cannot bypass the budget. Gateway request and response
  bodies are capped and the downstream request carries a timeout and the caller's
  abort signal. Child stdout no longer retains an unbounded partial line, and an
  over-long log message is truncated explicitly rather than retained whole.
  Fabric placement planning caps batch size, replica counts, identifier lengths,
  and constraint entries.
  
  Error-to-response mapping is centralized. Runtime composition repeated a
  parallel fallback that had already diverged, reporting an oversized body as
  `500` from one path and `413` from the other.
  
  The native Node HTTP host has an error boundary. Request conversion, runtime
  dispatch, and response streaming could all throw outside the dispatcher's own
  mapping, leaving the client with no response and the process with an unhandled
  rejection. Failures now answer `400` or `500`, or destroy the socket when
  headers are already sent, and the server declares explicit header, request,
  keep-alive, and header-count budgets. Requests also carry an abort signal so
  handlers can stop when the client goes away.
  
  Local state files are owner-only. The System Store database and its WAL
  sidecars are created `0600` inside a `0700` directory, and Project directories
  and `project.json` follow the same rule, so a permissive umask or shared
  service account no longer exposes Platform, Auth, and Project state to other
  local users. `ZelavisSystemStore` gains an optional, idempotent `close()` that
  Platform shutdown calls, so a repeatedly constructed embedded runtime no longer
  retains database handles until process exit.
  
  Fabric projections are accurate. Only a running Project maps to an `active`
  placement — `stopping` and `stopped` Projects were reported as active, and any
  future status would have been too, because the mapping defaulted to active
  rather than using an allow-list. A draining node now degrades the fleet summary
  instead of reporting `ready`. In fixed replica mode `replicas` is the default
  ceiling, so `{ mode: "fixed", replicas: 3 }` no longer silently resolves to a
  single replica when `maxReplicas` is omitted; an explicit `maxReplicas` still
  caps it.
  
  Service source policy is explicit and opt-in. Remote loading defaulted to on,
  plaintext `http:` shared a flag with `https:`, and `data:` URLs and arbitrary
  filesystem paths were not gated at all. Each scheme is now enabled separately
  through `services.sources`, with everything off by default; code the Platform
  itself installed into its managed service directory is exempt, since it arrived
  through the permission-gated install path. Installing a service remains a
  code-execution-level action — the goal is to make that authority hard to
  misuse, not to imply plugins are sandboxed.
  
  Service package extraction is bounded: entry count, per-entry expansion, total
  expanded bytes, and compression ratio, with duplicate normalized paths and
  ZIP64 archives rejected rather than misread. Extraction uses a
  collision-resistant temporary directory instead of a timestamp.
  
  Plugin manifest resolution is supplied per runtime instead of installed
  process-globally, so two embedded runtimes in one process no longer affect each
  other's service loading. The `setServiceManifestResolver` /
  `getServiceManifestResolver` globals are removed.
  
  Confirmed dead code is removed and `noUnusedLocals` is enabled so it cannot
  accumulate again. `noUnusedParameters` stays off deliberately:
  `ZelavisServerFetchHandler<TService>` carries a public generic that callers
  supply even though the declaration body does not reference it.
- d64fec1: Harden App event concurrency, raw SQL collection protection, bundle namespace isolation, local file containment, and Project Gateway authorization for Auth administration.
- 727d95d: Stop a completed host operation from crashing its host process when the kernel
  recycles the leader's pid.
  
  The Node host-operation executor kills the operation's process group both at the
  deadline and when its leader exits, so that descendants cannot outlive the
  operation or hold its output pipes open. By the time the `exit` handler runs the
  leader has been reaped and its pid is free, and `signalGroup` swallowed only
  `ESRCH` — the group being gone. A pid the kernel has already recycled into a
  group the executor may not signal answers `EPERM` instead, which is the same
  benign race, and that error was rethrown from inside an EventEmitter callback.
  Any operation that finished normally could therefore take the host process down,
  and the odds rise with the pid churn of a loaded host.
  
  `EPERM` is now treated exactly as `ESRCH` is. This was surfaced by an
  adversarial test failing four of six full-suite runs while passing standalone;
  a new test pins the behavior by refusing every process-group signal.
- 36b8646: Stop serving the Platform control plane on a Project's domain.
  
  A hostname bound to a Project is that Project's, not the Platform's. Requests to
  `/zelavis` on a verified bound domain now answer `404` instead of returning a
  Platform login page on every customer domain. The control-plane API was already
  authenticated there, so this closes an exposure rather than a breach.
  
  Enforced ahead of dispatch: the dashboard route matches before the public
  forwarder runs, and route `host` fields are an allow-list resolved at
  composition time while bindings are added and verified while the Platform runs.
- 60afafa: Fix Node HTTP requests carrying a body being cancelled mid-handler. The
  per-request abort signal was driven from `IncomingMessage`'s `close` event,
  which fires as soon as the request stream is drained — that is, the moment the
  dispatcher parses the body — so every `POST`/`PUT`/`PATCH` handler awaiting
  outbound work was aborted immediately. Most visibly, creating a table in a
  Project failed with `Project "<id>" did not respond within 30000ms.` even though
  the Project runtime answered normally. The signal now follows the response,
  which closes only when the response finishes or the client really disconnects.
  
  The Project Gateway also no longer reports a caller-side abort as a Project
  timeout; it answers `499` with a distinct message instead.
- d3c94f4: Project authority now carries into the Project's own runtime services. A
  Project runs its own workloads, storage, and database services, and each
  enforces its own permissions — but nothing mapped Platform Project permissions
  onto them, so an owner holding full authority arrived inside their own Project
  with none of them and those screens returned 403.
  
  Viewing a Project implies seeing what runs in it; managing its runtime implies
  changing what runs in it. Destructive operations stay behind runtime
  management rather than riding along with view, and the forwarded envelope is
  still a named list rather than a wildcard.
- e03f7ce: Verify what a consumer actually receives from `npm install zelavis`.
  
  Every existing test imports `../dist/...` directly, so the suite passes whether
  or not those files were ever published. The package has 35 export subpaths,
  each promising a JavaScript entry and a type declaration, and nothing checked
  that they still lead anywhere in the tarball.
  
  This packs the real artifact and works only with what comes out of it: every
  `exports` target and its `.d.ts` is present, everything `files` promises
  shipped, the package loads in a bare consumer with only its declared
  dependencies, the runtime-neutral subpaths load without the optional database
  engines, and the published `bin` runs.
  
  The DB engine subpaths are deliberately excluded from the load checks: their
  engines are peer dependencies, so failing to import them without an install is
  correct behaviour rather than a defect.
- d1ce99d: Bring the plugin API guide into the docs, and correct guidance the recent
  changes made wrong.
  
  The guide covering `package.json` classification, the three service kinds, the
  SDK surface, menus, routes, commands, events and nested services now ships as
  `guides/plugin-api.md` rather than living outside the repository. Two things it
  carried are corrected against the source it defers to: the auth capability is
  `zelavis/auth:oauth` since core auth was renamed, and `zelavis.services.add()`
  is documented as a module-evaluation API, with `setup(context)` and
  `context.addService` as what a service built from the registry, a database, or
  platform resources uses instead.
  
  Corrected elsewhere: `AGENTS.md` described `coreServices.dashboard.devServerUrl`
  and discovery by `provider:auth`; the access-control page said password methods
  are plugins under `plugins/`; two pages showed the removed `kind: "provider"`;
  the service-authoring guide cited a deleted package; the CLI page used the
  pre-rename `@zelavis/auth:credentials`; and the composition guide documented
  `frontend: false`.
  
  The core-platform skill gains what this work settled: capabilities name the
  service that owns them, core names no capability owned by a product it does not
  ship, features are not switched off in code, and the loader must carry
  everything a plugin declares.
- 3bf1481: Make remote environment persistence failure-safe and reconcile process state
  after session reattachment. A session whose tenant projection cannot be written
  is closed, a process whose projection cannot be written is terminated, and
  providers may expose their attached processes so missing, stale, and orphaned
  tenant process records are repaired on resume. Add idempotent, tenant-scoped
  per-run usage records for provider token, context, cache, model, and billing-unit
  reports.
- d83f942: Remove `coreServices` from the public `Zelavis` class options and keep built-in services managed by the runtime defaults.
  
  Add `zelavis services` CLI commands for listing, registering, installing, and disabling runtime services through the official runtime API.
  
  Update generated bootstrap examples to export the Zelavis runtime singleton directly when no per-request platform context is required.
- 8e31941: Retire the `zelavis.service.json` sidecar. Services and plugins are configured
  through the `package.json` `zelavis` namespace and standard ESM `exports`, the
  same as any other npm package.
  
  Uploaded service packages now read their entry from `package.json` `exports`
  through the shared manifest validator. A package configured only by the retired
  sidecar is refused rather than silently installed.
- 6bf7f95: Close the last open RocksDB defect: a scan over a corrupted block no longer
  ends silently.
  
  `@harperfast/rocksdb-js` saw RocksDB's iterator fail and returned "done"
  instead of surfacing the error, so a scan across a corrupt block handed the
  caller a truncated result set with nothing to indicate it was short. Silent
  truncation is worse than a crash — a short answer that looks complete is
  acted on.
  
  Fixed upstream in 2.9.1, which throws when a range iterator fails. The test
  that recorded this was marked `todo`; it now passes, and is kept as a
  regression guard rather than deleted, because only the iterator path ever
  swallowed the error — the point read and the corrupt manifest pointer always
  failed correctly and are checked separately.
  
  This also clears the condition the engine evaluation set for itself: the
  `rocksdb-js` engine's remaining known correctness gap is closed.
- 48dbb58: Prove what `synchronous = NORMAL` promises, rather than assuming it.
  
  In WAL mode that setting does not fsync on every commit, which trades two
  guarantees against each other. A killed process must lose nothing it had already
  committed; a power cut may lose recent transactions but must never leave the
  database torn. Both are now tested by killing real processes: a `SIGKILL`ed
  writer loses no committed transaction on any of the four engines, and a
  write-ahead log truncated mid-frame recovers a prefix of what was written rather
  than a set with holes in it.
  
  Also covers the maintenance passes: a seal killed halfway leaves every query
  answering as it did, because the read handles a store that is part sealed and
  part live.
- 8a8156c: Run the native WordPress stack when the Platform is root.
  
  A Platform installed as a system service runs as root, and the code invited that
  — `provisionNativeWordPressPackages` has an explicit root branch for apt. It
  installed the packages and then could not start the Project.
  
  Four things had to hold at once, each only visible once the one before it was
  fixed:
  
  - MariaDB refuses to run as root at all unless told which user to become, and
    installing `mariadb-server-core` leaves no `mysql` account to name.
  - An account that owns the Project files still cannot reach them unless every
    directory above is traversable, and the Platform's data directory is created
    0700 by root. The execute bit is added, never the read bit, stopping at the
    first directory the Platform does not own — so a directory can be walked
    through by something that knows the path and still cannot be listed.
  - PHP-FPM's master creates the pool's socket while it is still root, so without
    `listen.owner` it lands root-owned and nginx — which dropped to the same
    account the pool did — answers 502.
  - nginx needs a `user` directive to drop its workers, but only when started as
    root; an unprivileged nginx warns about it.
  
  The daemons share one account rather than the conventional `mysql`/`www-data`
  split: they serve a single Project and its files, so one identity keeps
  ownership coherent, and it is the shape per-Project Unix identities will need.
  
  CI checks both identities now. Testing only the unprivileged one is how this
  stayed broken.
- 344ace8: Resolve the PHP-FPM group by name instead of assuming it matches the user.
  
  The root fix set `group` and `listen.group` to the account's username. On Debian
  that is invisible — `www-data` belongs to a group called `www-data` — and on
  macOS an ordinary user belongs to `staff`, so PHP-FPM refused to start with
  "cannot get gid for group" and every WordPress Project on a Mac failed.
  
  The group is now read with `id -gn`: the resolved account's group when the
  Platform is root, the running user's otherwise.
  
  Found by running the Homebrew provisioning path for the first time, which also
  confirmed that path works: from a Mac with none of the packages installed,
  WordPress comes up in under a minute.
- 40314af: Give nginx every temp path it may create, and prove WordPress provisioning.
  
  The generated nginx config redirected `client_body_temp_path`,
  `proxy_temp_path` and `fastcgi_temp_path` into the Project's own directory but
  left `uwsgi_temp_path` and `scgi_temp_path` unset. nginx creates a directory for
  every module it was built with, whether the config mentions it or not, so on
  Debian it fell back to `/var/lib/nginx/uwsgi` and failed its own config test
  with a permission error. Homebrew's nginx defaults to a prefix the user owns,
  which is why every macOS run passed.
  
  Found by finally running the provisioning path. Every earlier WordPress test had
  been on a host that already had nginx, PHP and MariaDB, so the half of the
  promise that says an operator installs nothing had never executed. It does now,
  in CI and reproducibly on a laptop: from a bare Debian host the driver installs
  the packages through apt and brings WordPress up in about twenty seconds,
  verified by the site answering WordPress's own redirect to
  `wp-admin/install.php` — which it only does once `wp-config.php` exists and the
  database is reachable.
  
  The check refuses to run where the packages are already installed, because a
  pass there would look like evidence and be none.
- 5359178: Expose built-in core service APIs through `Zelavis` instances and stop re-exporting the full `@zelavis/db` runtime API from the main package.
- Updated dependencies [313b7a2]
- Updated dependencies [6a8c8c2]
- Updated dependencies [3bf1481]
- Updated dependencies [28bde9d]
  - @zelavis/auth@1.1.0-alpha.3
  - @zelavis/app@1.0.1-alpha.3
  - @zelavis/marketplace@1.1.0-alpha.3

## 1.0.1-alpha.2

### Patch Changes

- Add a tabbed schema builder to the database dashboard.
  - @zelavis/server@1.0.1-alpha.2
  - @zelavis/db@1.0.1-alpha.2
  - @zelavis/auth@1.0.1-alpha.2

## 1.0.1-alpha.1

### Patch Changes

- Refresh the core prerelease line after the release workflow cleanup.
- Updated dependencies
  - @zelavis/server@1.0.1-alpha.1
  - @zelavis/db@1.0.1-alpha.1
  - @zelavis/auth@1.0.1-alpha.1

## 1.0.1-alpha.0

### Patch Changes

- patch release script
  - @zelavis/server@1.0.1-alpha.0
  - @zelavis/db@1.0.1-alpha.0
  - @zelavis/auth@1.0.1-alpha.0

## 1.0.0

### Major Changes

- Rename the runtime config API

### Patch Changes

- Improve database route stability
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zelavis/auth@1.0.0
  - @zelavis/server@1.0.0
  - @zelavis/db@1.0.0
