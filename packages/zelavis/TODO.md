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
- [x] Evaluated celld against Fabric (`CELLD_EVALUATION.md`). It is a
  reference now, a possible Project runtime backend later (one fleet per
  Project, under Fabric's placement), and never a second scheduler, a storage
  engine or the public object contract. Its bucket protocol is the useful part:
  ownership as a compare-and-swap record carrying an epoch, the epoch in the
  key of whatever the owner replicates, and acknowledgements held until a
  durability proof covers them.
- [x] File storage takes conditional writes (`condition: { ifAbsent }` or
  `{ ifMatch: etag }`), and `probeFileStorageGuarantees` asks a store whether it
  enforces them, in celld's four steps with read-after-write between them. A
  store that accepts the condition and ignores it fails by name; one that
  answers with an error is inconclusive, never conformant. S3 sends
  `If-None-Match` / `If-Match` and treats a 412, or a 404 for `ifMatch`, as a
  rejection; anything else stays an error. Local
  storage creates by hard link, exact across processes, and compares and
  replaces under a per-object queue, exact within one process.
- [ ] Require the probe before any object store carries a lease, a fence or an
  authoritative publication. The file-backed service registry is the first
  case: it rewrites the whole registry with an unconditional PUT, so two
  Platforms sharing that storage drop each other's updates.
- [ ] When placements move into the System Store, make them `{owner, epoch}`
  records acquired by compare-and-swap and advanced on every activation, the
  shape celld's `cells/<cell>/own.json` has.
- [ ] Self-fence an Agent whose lease it cannot renew, at the published expiry
  rather than by trusting its own clock, and carry a fencing token into its
  side effects.
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
- [x] Durable, versioned partition maps. The stored map is authoritative, so
  reopening with a different shard list cannot re-place ranges out from under
  the data on them. Changes are validated for complete, non-overlapping
  coverage, must advance the version, and are refused while tenants stand on a
  range that would move.
- [x] Range movement, as `db.movement.rebalance`. Not a transaction — there is
  no atomic write across two shards — but a sequence whose every intermediate
  state is one a reader can safely be in, recorded as it goes so an interruption
  resumes rather than needing repair: fence writes on the shard being left, copy
  the tenant, move the routing, then drop the source. A tenant is unwritable for
  the length of the copy and never unreadable, because the source still holds
  the data and nothing can change it while it is fenced. `topology.update` keeps
  refusing an occupied range; relocation is what makes such a change possible
  rather than what makes the refusal go away.
- [x] Move without a write outage. The copy is taken unfenced from a noted log
  position and then caught up from the source log in rounds, each replaying only
  what arrived during the one before it; writes are fenced for the last round
  alone. Catching up keys events by identity rather than identifier, because a
  restore assigns the target its own dense identifiers — the name a caller gave
  a record is the one thing that means the same on both shards. Under continuous
  write load: 238 records copied and 271 events caught up unfenced, 22 settled
  behind the fence, and 326 of 400 concurrent writes accepted where every one of
  them used to be refused.
- [x] Event and projection surfaces on the `dbnew` log. Domain events are a
  reading of the object log rather than a second log beside it, so there is no
  way to record a document change that did not happen. Projection checkpoints
  live in the shard whose log they track, which makes them shard-aware without
  bookkeeping.
- [x] Idempotency keys, on the document writes rather than on an append. The
  API being replaced took one when appending an event; there is no append here,
  because writes reach the log only through the documents API — so the guard
  belongs where the write enters. `insert`, `update` and `delete` take an
  optional key, and a retry carrying it is answered with what the first attempt
  returned instead of being applied again. The receipt is written in the same
  transaction as the change it describes: recorded afterwards, there would be a
  window in which the write had happened and the key had not been noted, which
  is exactly the window a retry falls into. A key offered for a different
  request is refused rather than answered, an attempt that failed spends no key,
  and receipts are swept by `forgetIdempotencyKeys` — they grow with requests
  rather than with data, and how long a retry may arrive is the caller's
  question.
- [x] Collection schemas, validation, and stored schema versions. The schema
  module moved into `dbnew` rather than being rewritten: it is a field-type
  language, not part of the SQL core, and duplicating 700 lines of field
  definitions would only invite the two copies to drift. Stored versions are
  immutable, activation is explicit, and a collection without a schema accepts
  anything, as a raw database collection does today.
- [x] Schema migration between versions, as `tenant.migrations`. Activating a
  version still changes only what is accepted next and leaves what was written
  alone — a schema change must never silently rewrite data — and migration is
  the deliberate other half. Instructions are data (`Rename`, `Set`, `Default`,
  `Drop`) rather than a function, for the same reason a query is: a closure
  cannot be inspected, logged, or reviewed before it runs. `plan` reports what
  separates two versions and which differences the caller still has to answer;
  a removal is not one, because validation rejects unknown keys and a field the
  new version does not name can only be discarded. The decision is
  all-or-nothing though the writes are not: every document is transformed and
  checked before anything is activated or written, so a migration that would
  leave documents invalid refuses rather than getting halfway.
- [x] Time series definitions, points, and checkpoints. A series is a
  projection over the same log with the same checkpoint, rather than a second
  ingestion path. Points carry a coarse time bucket so a bounded range asks for
  the buckets it spans instead of scanning the series.
- [x] Time-bucket indexing wide enough for long ranges. A point is indexed at
  five widths, each eight times the last, so a range is covered by whole coarse
  blocks in the middle and finer ones at its edges — the standard interval
  cover. Ten years of days costs under thirty clauses where it used to exceed
  the limit and fall back to scanning the series; the clause cap survives only
  as a backstop against a range of a million years. The cost is one posting per
  level on each point written, which sealing folds into blobs. Points are
  derived, so an existing series takes the new index by being rebuilt.
- [x] Tag filtering on range and aggregate. A tag is an ordinary column lens,
  so a filter is the same set intersection a multi-model predicate is: every
  named tag must match, a tag given several values matches any of them, and both
  compose with the time window rather than replacing it. It is worth most
  exactly where the window gives up — past the bucket-clause limit the window
  names the whole series, and the tag narrows it again, so the query costs the
  tag rather than the series.
- [x] Backup and restore format. A backup is the tenant's slice of the log
  rather than a separate rendering of collections, schemas and documents, so
  restoring replays through the same idempotent apply path replication uses.
  Sequences are remapped on restore, since a backup's numbers mean nothing in
  the shard it lands in. Restoring under a different tenant name, or over live
  data, is refused rather than silently producing unreachable records.
- [x] Restore into a tenant that already holds data. `restoreTenant` takes a
  mode: `empty` still refuses and stays the default, since it is the only one
  that cannot lose anything; `purge` discards what the tenant holds — selected
  by the rule an export uses, so it clears exactly what a backup carries — and
  leaves the tenant as the backup describes it; `merge` writes the backup over
  records sharing a name and leaves the rest alone, lifting the restored
  versions above the local ones so a put that is not newer is not dropped as
  stale. A backup whose identities name another tenant is now refused whatever
  its label says, because a merge looks those names up and would otherwise write
  over the tenant they really belong to.
- [ ] Shard topology, so an official App routes virtual ranges across several
  physical shards from creation rather than gaining sharding later.
- [x] Logical, shard-aware dashboard system views. Built from the tenant APIs
  rather than from storage, so a view cannot name a physical table, cannot read
  one belonging to another tenant, and does not break when a range moves. Note
  a semantic change: schemas, projections and time series are tenant-scoped
  here, where the replaced surface kept them outside the tenant boundary.
- [x] Schema and system-view routes address a Tenant, so changing the backing
  store no longer also changes a URL. The dashboard passes the admin Tenant it
  already used elsewhere.
- [x] `zelavis/dbnew/node` opens a sharded database for a promise-based host and
  closes it on shutdown, so the platform can construct one.
- [x] `/database/health` no longer advertises capability flags, which had no
  `dbnew` equivalent and reported constants either way.
The cutover landed. `zelavis/app/db` is gone: the database service is built on
the `dbnew` runtime API, both construction sites open a sharded database through
`zelavis/dbnew/node`, and its `close()` runs on runtime shutdown.

- [x] `defineDatabaseService` ported onto the `dbnew` runtime API, with error
  rules matching tagged errors rather than error classes. Route shapes did not
  change, because the Tenant was added to the schema and system-view routes
  ahead of the move.
- [x] Both construction sites build the database, and the two `isDatabaseApi`
  guards test the `dbnew` shape.
- [x] `src/app/db` and the `zelavis/app/db*` export subpaths removed, along with
  the seven test files that exercised it structurally.
- [x] A libSQL driver for `dbnew`, over the same store logic as the built-in
  one. Both engines meet a synchronous gateway, so retraction, manifests, events
  and postings exist once rather than per driver.
- [ ] Remote-only libSQL. The driver uses the synchronous binding, which covers
  local files and embedded replicas; a database reachable only over the network
  needs transaction serialization designed before an asynchronous gateway is
  safe to offer.
- [ ] Report real topology on `/database/health` — shard count and partition map
  version — now that `dbnew` serves it.

Independent of parity, and needed before an official recipe mounts `dbnew`:

- [ ] Snapshots, so rebuilding replays live objects rather than all history.
- [x] Durability testing under interruption. `synchronous=NORMAL` in WAL mode
  does not fsync each commit, which trades two guarantees against each other,
  and both are now asserted rather than assumed. A `SIGKILL`ed writer loses no
  transaction that had already returned — proven on all four engines, and the
  test detects a single lost commit in 306. A write-ahead log truncated
  mid-frame, which is what a power cut leaves, costs a suffix and never a hole:
  what recovers is always the first *n* objects, never a set with gaps. And an
  interrupted seal is a state rather than damage — some lens keys sealed, the
  rest still live, every query answering as before, and finishing it is just
  running it again.
- [x] An ordered key-value engine interface, with SQLite and in-memory
  implementations and a conformance suite both must pass. Lenses become key
  ranges, which is what lets an engine without column families back the store.
- [x] The store logic ported onto `KvEngine`. Lenses are key ranges, a posting
  is a key with no value, and a transaction is one atomic batch with reads
  overlaying it. The object-store, event-log and document contracts all run
  against it unchanged.
- [x] The SQL store and its gateway are gone. Every engine is a `KvEngine`;
  there is one store.
- [ ] Report the libsql Buffer-parameter panic upstream. Binding a Buffer to a
  SELECT crashes the process in libsql 0.5.29, so its keys travel as hex text.
- [x] A RocksDB engine, and it was a driver rather than a redesign: four
  methods, nothing above it changed. The single keyspace cost nothing, because
  the key tags already give each lens the disjoint range column families would
  have provided.
- [x] Serialized each store's writers. A commit reads the log's next position
  and writes it back advanced, and `nextSeq`, sealing, compaction and both lens
  rebuilds do the same with their own state; on an asynchronous engine two in
  flight read the same value and the second write replaced the first. LMDB and
  RocksDB each lost 31 of 32 concurrent commits that way without an error, and
  LMDB handed one identifier to two objects; SQLite and libSQL were spared only
  because their drivers never interleaved. One permit per store, and reads take
  none (`db-concurrent-commits.test.mjs`).
- [x] Evaluated `@harperfast/rocksdb-js` as the maintained replacement for the
  discontinued `rocksdb` binding, as `engines/rocksdb-js.ts` behind no public
  export. Prebuilt for macOS, Linux (glibc and musl) and Windows on x64 and
  arm64, so nothing compiles on install; needs Node `^22.18.0 || >=24`; runs a
  whole store under Bun 1.3; Deno is not claimed. It builds RocksDB 11.8.1
  where the old binding carried 6.17.3, and has shipped 38 releases since
  January 2026. Pinned at 2.8.0. It passes the key-value conformance suite,
  SIGKILL durability, a cut write-ahead log (a suffix lost, never a hole),
  concurrent writers, the cross-process lock, clean reopen, and refuses a
  corrupt manifest pointer and a corrupt block on a point read. Commits are
  RocksDB's default, stated rather than hidden: logged, not fsynced each — a
  dead process loses nothing, a power cut can lose a suffix.
- [x] Measured it against the old binding. Warm point reads take 0.31× the
  time, identity lookups 0.42×, scans 0.75×, the cross-model query 0.80×, and
  ingest runs 1.28× faster; cold scans 0.94×, the cold cross-model query 0.77×,
  disk 0.9×. Cold point reads varied 8–16 µs between runs, against the old
  binding's 15. Scans were half again slower until entries left the adapter in
  batches of 1,024 instead of one promise each — the binding's own iterator was
  never the cost.
- [x] Migration needs no transformation. A store the old binding wrote opens
  whole under the new one — 2,000 of 2,000 objects, every lens and event — and
  the old binding still opens the directory afterwards, so the move is not a
  one-way door. What it needs is to be deliberate: each directory now carries
  `ZELAVIS-FORMAT.json` (engine, format, key and value encodings, and the
  binding and RocksDB versions that created it), and an open refuses one whose
  marker disagrees or that has none, before RocksDB touches it. RocksDB opens
  any RocksDB directory, and one read with the wrong encodings misreads every
  key without failing.
- [ ] Switch the RocksDB engine to `@harperfast/rocksdb-js` and remove
  `rocksdb`. Blocked on one gap: the binding ends a range scan quietly when
  RocksDB's iterator fails. A checksum mismatch in a table's first block reads
  as an empty range, one mid-file as its first half, while a point read of the
  same block throws. The binding sees the failed status and discards it
  (`DBIterator::Next`), so no adapter can report it; the old binding threw.
  `db-rocksdb-js.test.mjs` carries it as a `todo` that has to pass first
  (HarperFast/rocksdb-js#846).
- [x] Reported the iterator-status gap upstream as HarperFast/rocksdb-js#846,
  with a reproduction and the line that discards the status.
- [x] Compared an in-process addon with a supervised sidecar for native
  engines. The addon is the lowest-latency fit and the one that ships, and its
  failure domain is the Project runtime: opening the old binding and then the
  new one in one process aborted inside libuv's timer and took the process with
  it, which a sidecar would have contained. A sidecar costs a round trip per
  operation — the scan batching above shows how much per-entry overhead
  matters here — and a process to deploy, supervise and upgrade. It earns that
  only when process isolation, upgrading the engine apart from the runtime, or
  non-JavaScript Agents are the requirement, not as a default.
- [x] An ordered lens for ranges, sorting and pages (roadmap P1, first
  slice). Every engine now scans a bounded key range in either direction,
  held to the conformance suite. Values encode so byte order is value order:
  booleans, numbers as order-preserving float64, strings by code point with no
  normalization or locale, byte strings, then null. Every scalar document field
  gets an ordered posting beside its equality one. `gt`, `gte`, `lt`, `lte`
  and `between` are serializable query nodes that intersect with every other
  lens and compare like with like; `store.ordered` pages in either direction,
  ties broken by identifier, with cursors bound to their partition, column and
  direction; `extent` reads a column's two ends. For documents, comparisons are
  answered by the lens instead of after it, `eq` and `in` are typed (`10` no
  longer matches `"10"`), a one-field `orderBy` reads the lens, and `findPage`
  (and `POST /:collection/page`) returns a cursor only when another document
  follows. Null and absent values sort last in either direction. At 50k
  documents a first page of 50 costs 9 ms in either direction, against 1.35 s
  for the in-memory two-field sort, and a range over 1% of the values 3 ms.
- [ ] Merge the equality and ordered lenses. Every scalar field is indexed
  twice now and writes pay for it: 79% more time and 31% more disk at 50k
  objects of five fields (`scripts/bench-ordered.mjs`). The ordered lens
  answers typed equality with a value prefix; it needs sealing into segments
  to match the column lens on wide intersections before the column lens goes.
- [ ] Composite indexes with explicit field order and null semantics. Until
  then, an order by several fields sorts in memory in `findMany` and is refused
  by `findPage`.
- [ ] Order and page across shards in `db.scatter`: merge each shard's ordered
  run by value, with a cursor per shard, rather than by shard and identifier.
- [ ] Unique constraints committed in the same batch as the document, reference
  constraints, check constraints, and version preconditions beyond
  `expectedVersion`.
- [ ] Documents written before the ordered lens have no ordered postings until
  they are written again. Add a maintenance pass that rewrites them, rather
  than waiting for each one's next update.
- [ ] Answer time-series ranges from the ordered lens instead of hierarchical
  bucket postings.
- [x] Measured the engines against each other (`scripts/bench-engines.mjs`).
  At 100k objects, with SQLite tuned: LMDB is roughly 4x faster than everything
  else on scans and the cross-model query and 3x on point reads, paying for it
  in disk. RocksDB stores the same data in a fifth of the space and is the only
  engine that does, but tuning erased its speed lead over SQLite entirely.
  SQLite needs nothing installed and is the fastest at point reads after LMDB.
  libSQL trails and carries the largest files.
- [x] Tuned every engine, so the comparison is between engines rather than
  between one engine's defaults and another's architecture. Two knobs made
  things worse and were reverted: RocksDB with 16 KiB blocks (a posting has an
  empty value, so a larger block decompresses more to read nothing) and a 4 MiB
  iterator prefetch. LMDB's `useWritemap` aborts the process inside its own
  free-list handling and is not used.
- [x] Benchmarked past the page cache (`scripts/bench-cold.mjs`), and it
  reverses the in-memory reading. RocksDB barely notices a cold cache — 1.2x on
  a posting scan — while SQLite takes 17x and libSQL 22x. LMDB stays fastest in
  absolute terms cold but degrades 2.8x, and its point reads degrade 10x because
  a cold mapped page is a fault to disk. RocksDB also holds the same data in
  82 MB against LMDB's 547 MB, so its working set leaves memory nearly seven
  times later.
- [x] Engine selection on the host, defaulting to SQLite. A default that can
  fail to install is not a default, and SQLite is the only engine needing
  nothing: LMDB is the one to choose while the working set fits in memory
  (roughly 42M objects on 64 GB) and RocksDB the one that keeps working past
  that, at about a sixth of the space.
- [x] Compaction for the event log, reachable as `db.maintenance`. Payloads,
  manifests and identities already are the snapshot and postings are derivable
  from manifests, so compaction is log truncation: storage then tracks live
  objects rather than every write ever taken, which moves the point where a
  working set outgrows memory further than any engine choice above. A cursor
  from before the cut is refused rather than silently continued, backups
  export from state once history no longer reaches back far enough, and a full
  replay refuses on a cut log while `reindex` re-derives postings from state.
- [x] Benchmark past the page cache. Every warm measurement fit in memory,
  which is exactly where an LSM engine and a b-tree stop behaving alike; cold,
  RocksDB degrades 1.2× against SQLite's 16.8×, libSQL's 21.6× and LMDB's 2.8×.
- [x] Postings stored as bitmap blobs, reachable as `db.maintenance.seal`. A
  posting written as a bare key is the cheapest write and the most expensive
  read: a term matching every object costs one b-tree entry per object, every
  time. Sealing folds the live postings into immutable blobs of 65536
  identifiers each — dense bitmap or sparse offset list, chosen per segment —
  and keeps the cheap write by never editing one: what is written after a seal
  lands in the live tier beside it, and what is removed leaves a tombstone the
  read subtracts. At 200k objects and 600k postings: a wide term 304 ms → 24 ms
  (12.6×), a wide column 78 ms → 6 ms (13.4×), and a selective predicate
  intersected with an unselective one 278 ms → 1.5 ms (189×), which is the case
  it exists for. File size at rest is unchanged, because SQLite keeps freed
  pages rather than returning them.
- [x] Seal incrementally rather than by rebuilding. A segment is read, merged
  and written back only where a live posting or a tombstone falls inside it, so
  a periodic seal costs what changed rather than what is stored; a first seal is
  the same operation against blobs that do not exist yet. Re-sealing after
  touching 1% of 200k objects: 0.09s over 2006 segments, against 4.11s over
  18413 for the first — and the rebuild it replaced re-derived every posting
  before folding, so it could not have been faster than a first seal.
- [x] An explicit cross-partition scatter/gather contract, as `db.scatter`. A
  separate surface rather than a wider `forTenant`, because it is a different
  bargain: the cost is the widest predicate on every partition touched, nothing
  can be intersected across them, and the result has no ordering that means
  anything — so it merges by tenant and identifier, an order that exists
  everywhere rather than one that claims relevance. Every result carries its
  legs, so what it cost is visible per part. Two things it refuses rather than
  answers: a query naming a partition-local identifier — an edge means a
  different object on every shard, so scattering one returns rows that look
  like matches and are not — and a shard the map does not have, since reading
  the rest quietly would answer a narrower question in the shape of the asked
  one.

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
