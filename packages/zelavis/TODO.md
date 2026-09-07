# Zelavis Core and Fabric Roadmap

This file tracks the product-neutral backend framework and Fabric foundation.
It distinguishes working contracts from prepared boundaries and future work so
an exported type is never mistaken for an operational distributed feature.

## Done

- [x] Web-standard `fetch(request)` runtime surface.
- [x] Adapter-neutral dispatch and plain object-in/object-out surfaces.
- [x] Node HTTP adapter; Bun and other fetch-native hosts can call `fetch`
  directly.
- [x] Service definitions, nested composition, endpoint resolution, and
  route-level access requirements.
- [x] Typed server lifecycle hooks for start, request, response, error, and
  close.
- [x] Explicit server plugins with ordered setup and reverse-order cleanup.
- [x] Idempotent `runtime.close()` for server-plugin shutdown.
- [x] Strict `YYYY-MM-DD` compatibility-date validation and runtime exposure.
- [x] Versioned, validated portable runtime artifact manifest contract.
- [x] Provider-neutral deterministic runtime build profiles select Node, Bun,
  or future Deno without embedding deployment-provider assumptions.
- [x] Runtime artifacts carry validated SHA-256 object/file digests and optional
  signature metadata, with a Web-standard digest helper.
- [x] `ArtifactStore` is the first concrete provider capability, with immutable
  content-addressed retrieval semantics and an in-memory embeddable adapter.
- [x] Portable Ed25519 `signRuntimeArtifact`/`verifyRuntimeArtifactSignature`
  cover artifact signing over a canonical unsigned manifest, and the staged
  distribution tree emits a digest-complete `runtime-artifact.json` for every
  release target.
- [x] The Node adapter provides a persistent local `ArtifactStore` with
  content-derived paths, immutable first-write behavior, restart-safe metadata,
  read-time corruption detection, and no Project placement authority.
- [x] Provider-neutral capacity contracts provision and release Nodes through
  idempotent requests while keeping Project allocation and placement in Fabric.
- [x] Versioned provider definition and narrow capability negotiation contract.
- [x] Runtime-neutral workload identity, authority, resource, capability, and
  placement contracts.
- [x] Fabric snapshot and read-only inventory endpoints for the current
  single-node implementation.
- [x] The Platform control plane is not served on a Project's domain. A host
  bound to a Project is that Project's, so `/zelavis` answers `404` there rather
  than a Platform login page. Enforced ahead of dispatch, because the dashboard
  route matches before the public forwarder runs, and route `host` fields are an
  allow-list resolved at composition time while bindings are verified at runtime.
- [x] A verified bound domain forwards public traffic to the Project that owns
  it, choosing its running server frontend when there is one. Forwarding is
  anonymous — no Platform credentials and no authority envelope, since a visitor
  has no Platform identity and the target may be third-party code — and only a
  verified binding is routable, because anyone can point DNS at a host. The
  Project's own `set-cookie` is preserved, unlike the Gateway path, because the
  response is served from the Project's own domain.
- [x] The Gateway routes a Project's public paths to its running server
  frontend and keeps `/zelavis/*` with the Zelavis runtime. A frontend never
  receives a Platform authority envelope: it is third-party application code,
  and the envelope exists so a Zelavis runtime can enforce the caller's
  permissions. A frontend that is not yet running, or an ownership lookup that
  fails, falls back to the Project's own runtime rather than taking the site
  down.
- [x] A `server` frontend runs as a Project-owned runtime. The driver spawns
  the manifest's declared argv with a Platform-allocated port, treats the port
  accepting connections as readiness — an arbitrary frontend knows nothing
  about Zelavis, so no protocol handshake is available — reports a routable
  loopback URL, and surfaces the frontend's own stderr when it exits before
  binding. It reuses the Project environment allow-list and log bounds rather
  than a second copy.
- [x] A `frontend` marketplace category exists, and a listed frontend must
  carry it and depend on the Zelavis SDK — listing is a promise that the
  frontend integrates rather than only renders. A frontend that does neither is
  still installable; it simply cannot be listed.
- [x] Projects can own Projects. An owned Project is excluded from the
  Platform's project list, deleted with its owner through a durable cleanup
  participant, and its ownership survives a restart. Ownership, not a display
  rule, is the boundary: reconciliation still sees owned Projects, and nested
  ownership is refused until placement grouping exists.
- [x] Every installation answers at its root, and what it serves depends on
  which installation it is. An installation running the dashboard uses it as
  its default frontend, so `/` leads there; a Project runtime, which does not
  run the dashboard, serves the frontend placeholder until one is chosen.
  Neither shadows control-plane paths.
- [x] The Frontend contract exists: `kind: "frontend"` in the `package.json`
  `zelavis` namespace declares `static` or `server`. The runtime is declared,
  never inferred from a `start` script, because a `server` frontend spawns a
  process and a `static` one does not. Static frontends reuse the existing
  service `app` definition with its SPA/MPA modes and load without a JavaScript
  entry; bundle paths cannot escape the package; a `server` start command is
  argv rather than a shell string. Malformed frontends are refused at manifest
  validation rather than surfacing as a broken site.
- [x] The retired website content model is gone. A Project that has not chosen
  a frontend serves an explicit placeholder at its public paths instead of a
  404, while control-plane paths keep their own 404s. The placeholder is not a
  content model: a Frontend is a static site or an application with its own
  server, chosen from the marketplace.
- [x] Fabric inventory and placement-planning endpoints enforce distinct
  `fabric.view` and `fabric.manage` permissions by default; intentionally
  public embedded Fabric services require an explicit access opt-out.
- [x] The current privileged project/control route audit covers service-page
  assets, Website mutation, Storage list/mutation, Workloads management/logs,
  Project Gateway, Fabric, Auth administration, Assistant, services, and
  settings. Public website delivery, direct file delivery, health, Auth entry,
  and workload HTTP invocation remain explicit public data-plane routes.
- [x] Deterministic Project replica planning across one or many Nodes with
  capability gates, fixed/pressure-driven replica policy, driver and label
  constraints, topology spreading, and explicit resource-budget enforcement.
- [x] Project-scoped functions, jobs, schedules, and webhooks exist through
  `zelavis/app/workloads` on top of server contracts.
- [x] App Projects persist an exact `zelavis/app` recipe/runtime version and
  preserve it when the parent Platform registry or package version changes.
- [x] Every Project and exact App recipe lock persists an explicit
  `runtimeKind`/supported-runtime assignment. Historical records are repaired
  to their known `native` semantics, the configured driver publishes its
  available/default kinds, and creation rejects incompatible or unavailable
  kinds before claiming the Project ID. Docker is not advertised by this
  contract alone.
- [x] Deployment backends have host-supplied, backend-neutral capability and
  read-only detection definitions; the Platform persists native-default
  administrator policy, exposes permission-gated endpoints and a Server UI,
  blocks request-level backend selection, and never changes existing Project
  assignments when policy changes. Docker may be detected but cannot be
  enabled without a registered Project driver.
- [x] Host operations have a runtime-neutral manifest/request/executor contract
  and a Node executor foundation that requires an authority verifier, exact
  version and SHA-256 artifact match, declared bounded arguments, contained
  non-writable executable files, deadline/output limits, shell-free spawning,
  and idempotent operation IDs.
- [x] The official `zelavis/wordpress` App recipe creates native Dockerless
  WordPress Projects with a locked WordPress release, isolated files, generated
  credentials, and dedicated project-owned Nginx, PHP-FPM, and MariaDB
  instances, configuration, sockets, logs, and data. Debian packaging and
  authorized APT/Homebrew first-use provisioning install the host stack.
  Hosting-style dashboard navigation and local recipe routing leave room for a
  later OCI driver without changing the Project kind.
- [x] App Data Fabric topology contracts separate desired partitioning from
  observed placement, cover the complete deterministic hash space with stable
  virtual ranges, and enforce one active writer per physical shard.
- [x] The official Node and Bun App adapters persist one logical topology and
  route Tenant operations across four local physical SQLite shards by default.
- [x] The composite sharded database driver routes tenant-scoped documents,
  events, projections, and time series while applying logical schema changes
  across the bounded physical shard set.
- [x] Multi-shard regression coverage proves collection materialization,
  shard-bound opaque events, replicated logical schemas, built-in projections,
  and Tenant-routed time-series state across every default physical shard.
- [x] Logical database system views expose collections, events, schemas,
  projections, and time-series definitions without exposing physical shard
  drivers or `zv_*` tables. The dashboard renders those views read-only, and
  permission-gated Tenant backup/restore preserves exact schemas, event
  identity, revisions, and timestamps idempotently across shard routing.
- [x] The logical `DatabaseApi` binds ordinary access through
  `db.forTenant(tenantId)`, keeps physical drivers and raw SQL out of the App
  API, requires Tenant identity at HTTP boundaries, and exposes versioned
  opaque event cursors that the topology router binds to a virtual shard.
- [x] Local App startup repairs the retired official `@zelavis/app` lock,
  durably and idempotently replays a pre-topology single-file event log into
  Tenant shards, preserves the old file as a recovery artifact, and reports a
  useful stderr cause when a child process fails before readiness.
- [x] Project deletion is a persisted, resumable cleanup lifecycle. It stops
  the runtime, removes Assistant threads, domain bindings, bundle assets, and
  runtime/project data through idempotent participants, and deletes the Project
  record only after every participant succeeds.
- [x] Writer generations are durably fenced inside physical SQLite writes. A
  writer claims a generation before it may mutate a shard, every write
  transaction re-reads the fence, and a superseded writer is rejected by the
  shard itself rather than trusted to stand down. Fencing is an advertised
  driver capability, so the embedded single-process default stays unfenced.
- [x] Local SQLite App writes serialize competing top-level transactions and
  enforce unique collection/document stream revisions; raw SQL collection
  protection handles comments and CTEs and rejects statement batches.
- [x] Shared bundle storage validates every Project, service, bundle, prefix,
  and asset-path component, while local file storage separately enforces root
  containment.
- [x] Project Auth administration is permission-gated and the local Project
  Gateway supplies scoped Platform principal context to isolated runtimes.
- [x] Native-Web request authenticators compose with core principal resolution;
  opaque hashed sessions support Bearer and HttpOnly-cookie transport, Platform
  Auth persists through the System Store, App Auth persists through its Tenant
  database boundary, password hashing uses Web Crypto PBKDF2, and optional
  Basic, JWT, and remote-JWKS verifiers are available.
- [x] Session/device administration is endpoint-backed: accounts can list and
  revoke their own sessions, administrators can revoke one or all account
  sessions, and token hashes are never returned.
- [x] Authentication attempts have bounded window/block policies, durable
  Platform/App repository state, atomic cross-process/database mutation,
  privacy-safe security events, `429` retry guidance, and a permission-gated
  audit endpoint.
- [x] The System Store exposes atomic create-if-absent, compare-and-set, and
  compare-and-delete operations with strictly advancing CAS timestamps;
  first-owner bootstrap uses them for a durable leased claim that prevents
  competing Platform writers from creating multiple owners.
- [x] Credential recovery is provider-owned and endpoint-backed with generic
  start responses, explicit completion, and account-session revocation. The
  built-in email/username password plugins support expiring hashed one-time
  tokens through an operator-supplied delivery callback.
- [x] Provider-neutral Authorization Code login and explicit account linking
  are App Auth workflows with persisted one-time state, S256 PKCE, state/nonce
  binding, session issuance, and no implicit email linking. The OIDC plugin
  builds the standards-based authorization/token requests and verifies ID
  tokens through issuer, audience, algorithm, signature, JWKS, and nonce.
- [x] Platform first-owner bootstrap is guarded by an operator-supplied
  high-entropy one-time token and provider-owned credential enrollment. The
  dashboard performs real login/logout, `/runtime/access` returns the session
  principal instead of a demo identity, session rotation is endpoint-backed,
  only matching-origin browser requests receive session cookies, cookie
  mutations require a same-origin `Origin`, and critical Project, Assistant,
  service-mutation, and settings-mutation endpoints declare core permissions.
- [x] The Platform contains no ecommerce. Its capability hints named a plugin
  it does not ship, its tests imported one, and its test script built three
  ecommerce packages before it could run. Product tests live with the product,
  core tests a fixture that belongs to nobody, and the Platform's suite passes
  with every ecommerce build deleted.
- [x] Every first-party plugin manifest validates against the real contract,
  pinned by a test. Two payment gateways carried a legacy `main` the contract
  refuses, one plugin declared capabilities only on its service object, and an
  unused alias survived a rename — none of which install-time validation would
  have forgiven.
- [x] The plugin loader carries everything a plugin declares. It built its
  service object field by field and omitted `setup`, so a plugin registering
  its services there installed as a package with a menu and no endpoints while
  the same object composed in code worked. The ecommerce plugin declares its
  menu through the SDK, as the authoring guide tells plugin authors to.
- [x] The ecommerce plugin has a working dashboard and a payments settings
  page listing its gateways. Its menu had never reached the dashboard — the
  mount check ignored a service whose only contribution is a menu — and its
  pages pointed at a bundle nothing uploaded, so all five answered "Service
  asset not found".
- [x] Payment gateways declare `@zelavis/ecommerce:payments` rather than the
  bare `provider:payments` domain, so they are listed under the plugin they
  extend and cannot be collected by another commerce plugin. Both also
  declared a removed `kind` and shipped no `zelavis` manifest block, so
  installing either would have been refused at validation.
- [x] The auth settings page is a product service. `@zelavis/auth` ships beside
  `@zelavis/ui` and the marketplace and owns the page: how people sign in, the
  configured OAuth providers, and a catalogue of the plugins extending
  `zelavis/auth`. Removing it costs the page, not sign-in. Core auth stopped
  contributing its own menu, which had put two "Auth" entries in the sidebar.
- [x] A stale session cookie no longer locks anyone out. One that does not
  resolve means "not signed in" rather than failing the request, so the public
  sign-in and bootstrap endpoints stay reachable; an invalid bearer token is
  still an error.
- [x] An identity provider is added by pasting its issuer URL. Core reads the
  issuer's own OpenID configuration, so every OIDC provider is a URL rather
  than a plugin, and shipping a curated list of popular providers is not a
  problem the Platform has to have. A definition still ships only where it
  is not OIDC at all.
- [x] Extensions are listed by what they extend. `GET /runtime/extensions` and
  `zelavis extensions --for <service>` answer "what can I install for this
  plugin", each registry entry carries `extends` so a general catalogue can
  leave them out, and an extension whose owner is absent cannot be installed.
- [x] Password sign-in and the OAuth Authorization Code client are part of
  Zelavis rather than plugins. Both are ceremonies whose dangerous parts are
  generic — password verification and its timing, and the state, nonce and PKCE
  custody a redirect flow needs — so they are written once. What is
  vendor-specific stays a plugin: an identity provider declares
  `zelavis/auth:oauth` and supplies endpoints and claim mapping. The two
  near-identical password plugins and the seeding that copied one into the
  product-services folder are gone.
- [x] The OpenAPI document describes what the runtime actually serves. It is
  generated from the routes mounting produced rather than re-resolved with a
  different prefix, so its paths exist; it covers every mounted route rather
  than only annotated ones, marking the undocumented ones instead of omitting
  them; and it is served at `runtime/openapi` as well as
  `runtime/openapi.json`.
- [x] Every operation the control plane serves carries a summary. All 108
  operations of a Platform running the Zelavis App — runtime, platform, auth,
  fabric, database, workloads, the proxies, and the frontend front doors —
  declare an operation id, a summary, tags, and their responses, so a generated
  client names methods after the operation rather than after a route id. The
  `x-zelavis-undocumented` marker remains for routes an installed service
  ships without a `spec`, and a test asserts the Platform's own surface never
  carries it.
- [x] A frontend is installable at any mount. It declares
  `frontend.basePathGlobal`, the Platform defines that global on the served
  page with the mount path, and the bundle applies it — replacing a rewrite of
  React Router's `basename` literal that only worked because the Platform knew
  the framework. `@zelavis/ui` serves from `/`, `/zelavis`, or anywhere else
  from one build, through its manifest alone.
- [x] Core auth is named as core. Accounts, sessions, credentials, and
  roles/permissions are part of Zelavis itself, so the service is
  `zelavis/auth` beside `zelavis/platform` and `zelavis/fabric`; providers
  declare `zelavis/auth:credentials`. The scoped `@zelavis/auth` name is free
  for the plugin layer that brings OAuth and the providers extending it.
- [x] Features are not switched off in code. `frontend: false` is gone: having
  no frontend means installing none, and the root path explains it. What that
  flag really carried was the kind of runtime, which `role` now states.
- [x] The `coreServices` option is gone. It read as a second, privileged way to
  install services, but held the Platform's own subsystems: infrastructure and
  policy switches. They are now `subsystems` (auth, database, fabric, storage,
  workloads, site), the dashboard options folded into the first-class
  `frontend` concept that had already replaced them in all but name, and the
  settings store became the resource it always was. Passing the old option is
  refused with its replacement named, not ignored.
- [x] Services are discovered from a `product-services` folder on the server.
  The folder was documentation-only before: the placeholder told operators to
  drop a package there and nothing read it. The Node adapter scans it at boot
  and registers what it finds through the same importer and validation as an
  installed service. An `exports` entry escaping its package, a missing entry
  file, a reserved core service name, and a package that throws on import are
  each skipped with a reason rather than taking the Platform down.
- [x] Credential providers reach auth only by being installed. The
  `authMethods` option and the `coreServices.auth.methods` path are gone: they
  were a second way to provide a service whose result never entered the
  registry, so it could not be listed, disabled, or updated like an installed
  one. The distribution seeds its bundled services into the product-services
  folder on first boot and the operator owns them from then on, including
  deleting them for good.
- [x] Capabilities can be owned by the package that defines them
  (`@zelavis/auth:credentials`), validated at manifest time. Discovery stays a
  flat capability scan — no parent/child graph — so naming an owner asks to be
  considered and grants nothing.
- [x] A default installation can actually be adopted. The distribution loads
  `@zelavis/app-auth-email-password` the way it loads the dashboard, so the
  first-owner endpoint has something to enroll against instead of reporting no
  providers, and embedding hosts supply their own through the public
  `authMethods` option. `zelavis bootstrap` claims that owner from the command
  line and `bootstrap status` reports whether an owner, a token, and a provider
  are in place. The password is never accepted as an argument.
- [x] Retired the package-local auth plugin folder and the generic
  `childServices`/`extends` graph. Auth and payment providers are ordinary
  workspace plugins discovered by capability and registered through explicit
  domain contracts.
- [x] Plugins and services declare themselves through a validated `package.json`
  manifest (`"zelavis": { "kind": ... }`, ESM `type`/`exports`, no legacy
  `main`). `defineService` is removed; only the unrelated marketplace helpers
  `defineServiceCatalogEntry`/`defineServiceCatalog` remain.
- [x] Plugin code uses the official `zelavis/sdk` surface — `zelavis.menu`,
  `zelavis.routes`, `zelavis.commands`, `zelavis.events`, and
  `zelavis.services` — bound to an explicit plugin execution context that
  throws a descriptive error when called outside `loadPluginPackage`.
- [x] Route definitions carry typed operation specs and the runtime generates a
  valid OpenAPI 3.1 document for every mounted service, served from
  `/zelavis/api/v1/runtime/openapi.json`.
- [x] The runtime core stays filesystem-free: plugin manifest resolution is an
  injected `ZelavisServiceManifestResolver` that the local Node/Bun adapters
  install, and `api` is optional so `kind: "provider"` plugins can register
  through a domain contract without mounting routes.

## Prepared, Not Operational Yet

- [ ] Compatibility dates are carried by runtimes, artifacts, and providers,
  but no behavior gates have been introduced yet. Add gates only when behavior
  must change incompatibly.
- [ ] Artifact manifests, digests, and signing primitives exist and the staged
  release tree is digested, but no release is signed with a real key yet, there
  is no remote store, and immutable Project runtimes are not installed from
  artifacts.
- [ ] Provider definitions advertise capability APIs, but capability-specific
  contracts other than artifacts and capacity—DNS, networking, secrets, backups,
  and telemetry—still need to be specified independently.
- [ ] Lifecycle hooks are in-process framework hooks. Durable deployment and
  Agent events must come from persisted Fabric operations, not process hooks.
- [ ] Workloads are discoverable through service endpoints, but durable queues,
  distributed execution, retries, leases, and scheduler ownership remain open.
- [ ] Replica planning is operational as a pure Fabric decision, but plans are
  not yet persisted/fenced or executed by Agents and the Gateway does not yet
  balance across Agent-reported replica targets.
- [ ] Exact App version locks are persisted, but the local Node driver still
  executes the parent-installed Zelavis code and therefore advertises
  `independentRuntimeVersion: false`. Artifact installation must make the lock
  executable before side-by-side old and new App runtimes are operational.
- [ ] The authority and placement model can represent a future delegated
  Project Platform/Project Cell, but nested registries, resource accounting,
  routing, reconciliation, and whole-cell movement are not implemented.
- [ ] Official App local routing, topology persistence, and writer-generation
  fencing are operational, but local move/split/merge operations are not yet
  durable state machines.
- [ ] Docker has a centralized read-only backend adapter and detector but no
  installer, Project driver, secret provider, backup/restore contract, or
  durable migration state machine. Enabling Docker must remain separate from
  migrating Projects.
- [ ] The Agent now has stable identity, operation-bound signed authority,
  durable queued state, atomic leases, bounded concurrency, redacted audit
  events, replay-safe IDs, restart recovery, read-only management endpoints,
  and a separately supervised IPC service. Release-signed manifests,
  process-group cancellation/reconciliation, and registered installation
  operations remain required.
- [x] A Platform reclaims the processes a crashed one left running. A Platform
  killed outright runs no shutdown, so its Project processes keep their ports,
  keep answering requests, and keep their database files open while the
  Platform replacing them has no memory of them. Observed: a WordPress Project
  reported running whose new nginx logged `Address already in use`, with
  traffic served by the process from before the crash — and, separately, a
  Project's daemons still running three days after the Platform that started
  them was gone. The Agent runner now records each process it starts and stops
  the leftovers before starting the same workload, plus a full sweep on the
  first start after boot. Stopped rather than adopted, because a child's output
  arrives over pipes owned by the process that spawned it: once that is gone
  there is nothing to reattach to. A leftover is matched by how long it has been
  running rather than by its command line — daemons rewrite their own argv, and
  matching on the command left a real php-fpm alive through a reclaim — and a
  record whose owning Platform is still alive is left alone. The readiness waits
  now fail when the process they are waiting for has exited, so a stale listener
  can no longer be mistaken for success.
- [x] Sweep leftovers at boot, not only on the first start. The Node adapter
  owns one Agent for all three Project drivers and reclaims through it while
  composing, so an installation that boots and starts nothing still cleans up
  after a crashed Platform. One Agent rather than one per driver is also what
  makes the record of what is running on a host a single thing.
- [x] Run the Agent as its own process. `zelavis agent` serves the process
  command contract over a unix socket, and a host opts in with
  `projects.agentEndpoint`; the drivers are unchanged, which is what putting
  them behind the contract bought. The operator supervises the Agent — systemd,
  launchd — so it is restarted on its own terms rather than inheriting the
  Platform's lifetime. Verified with a real WordPress Project: nginx, php-fpm
  and MariaDB run as the Agent's children, survive the Platform being killed,
  and are reclaimed by the next Platform, which then starts cleanly with no
  port conflict. Trust rests on filesystem permissions — a 0700 directory and a
  0600 socket — with a shared token as the second lock.
- [x] Re-attach to Projects an earlier Platform started. The Agent keeps a
  bounded tail of each process's output, hands a reconnecting client the
  processes for a workload along with what it missed, and the Node driver
  re-derives readiness from that replay — the bound address exists nowhere else,
  because the Project announced it while no Platform was connected. Adoption
  runs before reclamation while the host composes, so a Project still serving is
  taken over rather than killed and restarted; what is left afterwards is what
  nothing can drive. `survivesControlPlaneRestart` is now read from the runner
  rather than hardcoded `false` in three drivers, and is true behind an Agent.
  A Project whose readiness line has aged out of the buffer is reported running
  without an address rather than routed to a guessed one, and reconciliation
  stops an adopted Project whose desired state is stopped.
- [x] WordPress provisioning is proven, not assumed. From a bare Debian host
  with nginx, PHP and MariaDB absent, the driver installs them through apt and
  brings a WordPress Project up in about twenty seconds — the site answering
  WordPress's own redirect to `wp-admin/install.php`, which it only does once
  `wp-config.php` exists and the database is reachable. Every earlier WordPress
  run had been on a host that already had the packages, so the provisioning
  half of the promise had never once executed. A committed container script
  runs it in CI and on a laptop, and refuses to run where the packages are
  already present rather than passing and looking like evidence.
- [x] The native WordPress stack runs as root. A Platform installed as a system
  service is root, and the daemons now drop to an unprivileged account —
  configurable, else www-data, mysql or nobody, and refused up front with an
  explanation if none exists rather than dying at the first port wait. Four
  things had to hold at once, each hidden behind the last: MariaDB will not run
  as root without `--user`; the account cannot reach files it owns unless every
  ancestor is traversable, so the Platform's own directories gain the execute
  bit and never the read bit; PHP-FPM's master creates its socket while still
  root, so `listen.owner` has to name the dropped-to account or nginx answers
  502; and nginx needs a `user` directive, but only when root. CI now checks
  both identities, because testing one left the other broken for as long as
  nobody tried it.
- [ ] Native reports its current `process` isolation boundary honestly. Stable
  per-Project Unix identities, filesystem/PID/network namespace policy, cgroup
  v2 limits, systemd supervision, capability/seccomp/MAC confinement, quotas,
  and adversarial cross-Project tests are not operational.

## Next

- [x] The marketplace is its own package, `@zelavis/marketplace`, alongside
  `@zelavis/ui` under `product-services/`. It declares `zelavis.kind` in its
  own `package.json`, contributes both its menus through `zelavis.menu.create`,
  and is loaded through `loadPluginPackage` — the same loader an installed
  third-party plugin goes through. Nothing in the dashboard names it: its
  routes, pages, components, and hardcoded nav entries were removed from
  `@zelavis/ui`, so a broken extension point now breaks the Platform's own
  marketplace rather than hiding behind a private path.
- [x] A service can ship the pages its menus point at, through
  `pageAssets`. A page reaches the dashboard the same way whether its service
  was installed from an archive into the bundle store or composed into the
  Platform, and core services — which are not registry entries — resolve a
  fetchable `page.src` like any other.
- [x] A service page composes real components. The Platform serves an element
  library at `runtime/service-elements.js` beside the design tokens it already
  served at `runtime/service-page.css`, and a frontend may supply its own —
  components belong to a design system, and the Platform ships a baseline only
  so a page is never left composing nothing. Each element renders into a shadow
  root, so a page's CSS cannot reach in and a component's rules cannot leak
  out, while the tokens still reach the components because custom properties
  inherit through shadow boundaries. That is the seam that restyles every
  service page in an installation. The marketplace page is rebuilt on it and is
  no longer a placeholder: `zv-page`, `zv-section`, `zv-card`, `zv-row`,
  `zv-title`, `zv-badge`, `zv-button`, `zv-field`, `zv-empty`, `zv-status`,
  plus a filter over the registry it lists.
- [ ] Let a service page render inside the dashboard's own document. The frame
  stays for now, and deliberately: shadow DOM scopes styles, not scripts, so
  rendering an installed service's page inline would hand its code the
  dashboard's origin and its session. Closing that needs an execution boundary
  for third-party page code, not more components.
- [x] Execute `server` frontends. A frontend package installs as an ordinary
  service, is selectable as a Project recipe, and produces a Project of kind
  `frontend` whatever the package is called — the runtime driver routes on that
  kind, so deriving it from the package name would send `@acme/theme` to the
  Zelavis runner. The Node adapter now supplies the frontend driver and a
  resolver that finds an installed package by walking up from its locked
  specifier, bounded by the directory packages are installed into. A frontend
  that was never installed is refused rather than guessed at.
- [x] Acquire packages from npm and from explicit archive hosts. The trust
  policy lives with the existing service source settings and defaults to
  acquiring nothing: registries and scopes are matched exactly, the tarball URL
  the registry advertises is re-checked against that same policy before it is
  followed, and the bytes are verified against the digest the registry
  published — sha1 is not accepted as a commitment. A reference must name one
  package, so ranges are refused; a dist-tag is recorded as the version it
  resolved to.
- [x] Acquire from Git forges, by pinned commit. A reference must name a full
  commit SHA: a branch or tag moves, and unlike npm there is no registry digest
  that would notice the same reference now installs different code. The forge's
  archive URL is an operator-configured template, validated to stay on its own
  origin because the values substituted into it come from the caller. There is
  no digest to verify against — a forge builds archives on demand, so the bytes
  are not stable for the same commit — so trust rests on the allow-listed forge
  and the pinned commit, and what actually arrived is recorded.
- [x] Scaffold a frontend from a `create-*` package. Deliberately not `npx`:
  npx resolves and installs a whole dependency tree from whatever registry npm
  is configured with, which would route around the source policy entirely and
  make it decorative. The shape that works is to acquire the create package
  through the verified npm path, then run its declared bin in an isolated
  working directory with no network, and register the result as a frontend
  Project. That is Project scaffolding rather than service acquisition, so it
  belongs with the frontend creation flow. `POST /runtime/services` now takes
  `scaffoldFrom` alongside `packageSource`: the create package is acquired
  through the verified npm path, its declared bin runs as a child under the
  permission model — no child processes, no native addons, reads confined to
  the package and writes to the output directory — with a preload that removes
  `net.connect`, `Socket.prototype.connect`, `tls.connect`, `http`/`https`
  requests, `dgram`, DNS, and `fetch` from the module layer the child sees. The
  preload patches through `createRequire` rather than `import`, because a
  built-in's ESM namespace snapshots its named exports on first import and a
  later patch would leave `import { lookup } from "node:dns"` pointing at the
  real function. What the run produced is validated as a Zelavis frontend and
  registered like any other installed package, so it is immediately selectable
  as a Project recipe. This is a boundary against a create package doing
  something unexpected, not an OS sandbox, and is documented as such.
- [x] Place an owned Project with its owner. An owned Project is confined to
  the nodes its owner occupies, so a Project's frontend cannot land on a
  different machine than the Project it fronts — the group rule beats the
  balancer rather than losing to it. Owners are planned first through a
  depth-first ordering, chains work, and a cycle is reported rather than
  hanging the planner. An owner named but absent from the plan is refused
  rather than guessed at: the planner cannot know which nodes it occupies, and
  placing anyway is the exact mistake the rule exists to prevent.
- [x] Wire the placement planner into reconciliation. Reconciliation plans
  every desired-running Project together — an owned Project can only be judged
  against an owner the planner can see — and refuses to start one whose
  ownership group is unsatisfiable. It acts on ownership failures only:
  capacity and node eligibility are scheduling answers, and this host does not
  schedule, so treating them as refusals would stop Projects on a single-node
  installation that models no capacity. A host with no Fabric, a plan with no
  owned Projects, and a failing planner all reconcile exactly as before —
  Fabric being down is not a reason to leave an installation stopped.
- [x] Placement decides where a Project runs. Reconciliation reads the plan's
  assignments, not only its refusals: a Project the planner placed on another
  node is not started here, and one already running here when it moves away is
  stopped. Running it anyway would contradict the Fabric, and on a fleet where
  every host reconciles, every host would reach the same conclusion and run its
  own copy. A host that does not know which node it is, and a planner that
  fails, both start everything locally exactly as before — Fabric being down is
  not a reason to leave an installation stopped. The node a Project was placed
  on is recorded on the Project rather than in its runtime state, which the
  driver overwrites on every poll, so "why is this not running" has an answer;
  the Fabric's placement inventory reports that node instead of asserting
  everything is local.
- [ ] Reach the node a Project was dispatched to. `ZelavisProjectDispatcher`
  is the seam — a host supplies `dispatchStart` and the Project is handed over
  rather than left stopped — but no transport implements it yet. That is the
  Agent execution path: a worker Agent on the target node, claiming the
  operation under signed authority and a durable lease, is what turns the seam
  into a running Project.


- [ ] Prove local shard movement, split/merge, generation fencing, crash-safe
  cutover, and resumable durable operation state before remote data placement.
- [ ] Wire a release signing key into the staged distribution build so
  published runtime artifacts carry a verified signature, not only complete
  file digests.
- [ ] Materialize each Project's exact Zelavis App version as an immutable
  runtime artifact and have capable drivers execute that artifact independently
  of the parent Platform installation.
- [ ] Add remote `ArtifactStore` adapters for Agent retrieval and immutable
  Project runtime installation.
- [ ] Replace the current narrow native recipe router with the public
  capability-aware Project-driver registry described in `ARCHITECTURE.md`.
  Runtime assignment and recipe compatibility are now explicit, but leaf
  driver registration and resolution still need to be generalized.
- [ ] Implement the phased Docker/WordPress plan in
  `pnotes/ZELAVIS_DOCKER_IMPLEMENTATION_PLAN.md`: capability detection and the
  authenticated privileged executor first, then isolated Docker WordPress
  creation, then durable backup/cutover/rollback migration.
- [ ] Continue the reconciled native/backend plan in
  `pnotes/ZELAVIS_NATIVE_ISOLATION_AND_DEPLOYMENT_BACKENDS_PLAN.md`: build the
  separately supervised Agent transport and process supervisor, then harden
  the native backend before adding Docker Project execution and migration.
- [ ] Persist Platform identity, allocations, placements, and generations in
  the System Store.
- [x] Local child-process execution runs through the Agent command contract.
  Every long-lived Project process — the Node Project runtime, the server
  frontend, and native WordPress's nginx, php-fpm, and database — is started by
  asking an Agent rather than by calling `spawn`. The host operation contract
  the Agent already had describes a short registered program; a supervised
  process is the other shape, so `ZelavisAgentProcessRunner` covers it: line
  output, SIGTERM escalated to SIGKILL, a stop that resolves only once the
  process is gone, and an exit that says whether the Platform asked for it. The
  local runner is the first implementation rather than the thing a remote Agent
  is retrofitted around. Unifying three supervisors also settled differences
  that were never decisions: only one registered its children for cleanup when
  the Platform exits, only one reassembled output into whole lines, and native
  WordPress handed every process it started — daemons and one-shot setup
  commands alike — the Platform's entire environment, including the bootstrap
  token and provider credentials. Both now get a narrow one; host package
  installation opts back in explicitly, because `brew` and `apt` are configured
  through an operator's environment and run as the operator provisioning their
  own machine. The remaining direct spawns are short and bounded: those package
  and setup commands, backend detection probes, the create-package scaffold,
  and the host operation executor, which is the Agent's own other contract.
- [ ] Make the Gateway resolve authoritative placement plus Agent-reported
  healthy targets.
- [ ] Require real principal permissions on every Agent and provider control
  endpoint when those endpoints are introduced, and extend the route-audit
  tests with them.
- [ ] Add provider implementations as optional adapters or plugins rather than
  dependencies of the core implementation.

## Replacing `zelavis/app/db` with `zelavis/dbnew`

`dbnew` replaces the document-first SQL database entirely; the two are not
intended to coexist. Each capability's old implementation is removed once its
replacement is in use, and the package is not left carrying both. The order is
driven by what the existing dependents call, not by what is easiest to port.

- [x] Collections and the document API over `ObjectStore`. Documents are stored
  objects whose scalar fields become column postings, so `eq` and `in` filters
  are answered from the lens; ordering comparisons are applied to the candidates
  afterwards rather than pretending to be indexed.
- [x] Stable identity: `(namespace, key)` binds an application's own document id
  to the dense partition-local `Seq`, uniquely and inside the write
  transaction. Events carry it so a follower agrees with its leader about which
  record an event concerns.
- [x] Optimistic concurrency through `expectedVersion` on update and delete, and
  duplicate-id rejection on insert.
- [ ] Ordering, comparison and range filters served from the lens rather than
  applied after it.
- [x] `forTenant` as partition selection. Tenants hash to one of a fixed number
  of virtual ranges, and ranges are placed on physical shards, so an App is
  sharded from creation and growing moves placements rather than rehashing
  tenants. Tenant scoping is structural — the tenant is part of every namespace
  and lens key — rather than a predicate a caller can forget.
- [ ] Durable, versioned partition maps and range movement. The map is
  currently constructed in memory and never persisted or changed at runtime.
- [ ] Event and projection surfaces re-expressed on the `dbnew` log, including
  the opaque shard-aware cursor contract.
- [ ] Collection schemas, validation, and stored schema versions.
- [ ] Time series definitions, points, and checkpoints.
- [ ] Backup and restore format.
- [ ] Shard topology, so an official App routes virtual ranges across several
  physical shards from creation rather than gaining sharding later.
- [ ] Logical, shard-aware dashboard system views that never select a physical
  shard's internal table.
- [ ] Cut the 26 database endpoints and the nine `src` dependents over, then
  delete `src/app/db`, its adapters, its tests, and the `zelavis/app/db*`
  export subpaths.


Independent of parity, and needed before an official recipe mounts `dbnew`:

- [ ] Snapshots, so rebuilding replays live objects rather than all history.
- [ ] Durability testing under interruption; `synchronous=NORMAL` is currently
  configured rather than proven.
- [ ] Postings stored as bitmap blobs, removing the b-tree scan that now
  dominates a wide query. Requires immutable segments and compaction.
- [ ] An explicit cross-partition scatter/gather contract.

## Later

- [ ] Remote, separately supervised Zelavis Agents.
- [ ] Bounded durable reconciliation, leases, fencing, retries, and node drain.
- [ ] OCI and stronger runtime-isolation drivers after the Agent boundary works.
- [ ] Connect automated replica placement to durable reconciliation, balancing,
  migration, recovery, and provider-backed capacity scaling.
- [ ] Replication and failover with explicit single-writer ownership semantics.
- [ ] Remote Tenant/shard placement and exceptional intra-Tenant subdivision
  after the local multi-shard topology, Project authority, and Agent boundary
  are operational.
- [ ] Delegated Project Platforms/Project Cells that can own nested Apps or
  Projects inside a granted envelope while the parent places and moves the
  complete cell as one group.

## Deliberate Non-Goals

- Provider-specific serverless presets as the core execution model.
- A single all-powerful `CloudProvider` interface.
- Provider-controlled placement or routing policy.
- Filesystem route or plugin scanning in the runtime core. Optional developer
  tooling may compile conventions into explicit service and plugin inputs.
- A second storage/database model that competes with the Platform System Store
  or `zelavis/app/db`.
