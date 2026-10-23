# AGENTS.md

## Project Vision

Zelavis is a unified, self-hostable App Platform. It replaces — and combines — several categories of tools that teams currently stitch together separately:

| Inspiration | What Zelavis covers |
|---|---|
| Firebase / Supabase | Backend-as-a-service: auth, database, real-time, self-hostable |
| Vitess (for MySQL) | SQL-database-agnostic query routing, replication, and sharding — not tied to one engine |
| WordPress | Content management: content types, entries, schemas, media |
| cPanel / Plesk / Coolify / Dokploy / deploy providers | Server, app, local website hosting, and optional external deploy management |
| phpMyAdmin | Database administration UI (collections, tables, queries, events) |
| Workers / Functions platforms | Project-scoped workloads: functions, jobs, schedules, and webhooks hosted by the long-running Zelavis runtime |
| Claude / Codex chat | AI chat area built into the dashboard for interacting with Zelavis and building via AI |
| Linear / Jira *(roadmap)* | Project planning: issues, tickets, roadmaps, and cycles scoped to a Zelavis Project |
| Notion / Figma multiplayer *(roadmap)* | Real-time collaboration: presence, shared editing, and comments across dashboard and Project surfaces |

Rows marked *(roadmap)* are committed product direction, not shipped behavior. Planning and
real-time collaboration complete the lifecycle the product positioning claims — plan, build, and
manage in one self-hosted platform — and self-hosting a team's tickets, roadmap, and discussion is
a stronger ownership claim than self-hosting a database alone. No implementation exists yet. Do not
describe either as available in docs, README, dashboard, or marketing copy until it ships;
`pnotes/TODO.md` lists them as roadmap only.

The difference from Firebase/Supabase is depth and ownership: Zelavis is fully self-hostable, runtime-neutral, and built to scale beyond a single database engine. The database layer is the deepest differentiator — `zelavis/db` is a multi-model object store (event-sourced, tenant-aware, one payload projected through document, column, measure, and graph lenses) on a swappable storage engine. SQLite, libSQL, RocksDB and LMDB drivers ship today, all over the same store logic through an ordered key-value interface. Official Zelavis Apps are locally physically sharded from creation: one logical App database routes stable virtual shard ranges across several SQLite files even when every placement is on one Node. Tenant placement, replication, failover, shard movement, and exceptional Tenant subdivision build on that same topology instead of introducing a second distributed architecture later. The event log is the natural replication stream and `tenant_id` is the normal first partition key. That is the same role Vitess plays for MySQL, but Zelavis is not coupled to any single SQL engine. Replicas do not imply multiple writable owners; multi-writer consistency requires a separate explicit data specification.

Zelavis should be able to host websites itself on user-controlled infrastructure. Managed deployment providers may be optional targets through plugins, but they are not the default hosting model and must not replace native Zelavis website hosting.

## Product Positioning

The canonical public tagline is:

> **Zelavis — The App Platform.**
> Plan, build, and manage apps together, from first ticket to production.

The headline claims the whole application lifecycle, which is what earns the definite article;
the subline names the span of that lifecycle, which is the claim no single competing tool covers.
Keep these surfaces consistent with it and with each other when any one of them changes:

- `README.md` headline.
- `website/astro.config.mjs` Starlight `description`.
- `website/src/content/docs/index.mdx` frontmatter `description` and intro line.

The tagline stays deployment-neutral on purpose. Managed Zelavis on zelavis.com is a first-class
offering alongside self-hosting, so headline and tagline copy must not lead with self-hosting,
ownership, or "your own infrastructure": that framing reads as DIY-only and quietly excludes the
managed product. Self-hostability remains a core architectural constraint and a capability worth
stating plainly in body copy, feature sections, and installation docs. It is simply not the
headline claim, and it should not be reintroduced into one.

The tagline is deliberately ahead of shipped features, so body copy carries the accuracy load:
headlines may claim the direction, but feature lists, docs, and dashboard copy must still mark
planning and collaboration as roadmap.

Dashboard/product structure:

- `/zelavis` is the Projects overview, not a single project dashboard.
- Zelavis-native project pages live under `/zelavis/projects/:projectId/*`.
- Managed app projects such as WordPress/static/generic projects may use hosting-style controls instead of Zelavis-native Auth/Database/Content navigation.
- `/zelavis/marketplace` is global for Project recipes (presented as apps and
  starters), templates, and server provider plugins.
- `/zelavis/projects/:projectId/marketplace` is project-local for Zelavis plugins and services.
- `/zelavis/server/*` owns server-level concerns such as domains, backups, and logs.

Core platform work centers on the unified `zelavis` package and its public
subpaths: `zelavis/core`, `zelavis/runtime`, `zelavis/fabric`, `zelavis/app`,
`zelavis/db`, `zelavis/app/identity`, and `zelavis/app/workloads`. The dashboard
remains the focused `@zelavis/ui` package bundled by `zelavis`.

The repo still contains domain packages such as `@zelavis/ecommerce`, but they are optional layers on top of the platform primitives, not the main product definition.

## Agent Instruction Source Of Truth

`AGENTS.md` is the canonical instruction file for coding agents in this repo.
There is no `CLAUDE.md`: Claude Code reads `AGENTS.md` directly when a repository
has no `CLAUDE.md` (Claude Code v2.1.277 or later; `/memory` lists it). Do not add
a `CLAUDE.md` or `CLAUDE.local.md` to the project tree: either one makes Claude
read it instead of `AGENTS.md`. Put durable project guidance here.

Keep the `.agents/` folder in sync with this file. When adding or changing
durable guidance that affects a specific agent workflow, update the relevant
`.agents/skills/*/SKILL.md` file or add a focused reference under
`.agents/references/` so skill-loaded agents receive the same current guidance.

`CONTRIBUTING.md` is a concise contributor onboarding page for people and agents:
setup, validation, PR expectations and links to canonical guidance. Keep detailed
architecture and workflow rules in this file and `.agents/`, and reviewer
ownership in `.github/CODEOWNERS`. Do not duplicate those responsibilities in a
root `MAINTAINERS.md`.

`.claude/` is Claude-specific tool configuration, not a second instruction
system, and it stays: Claude Code does not read anything under `.agents/`, so the
tracked session-start hook in `.claude/settings.json` is what makes the
`.agents/skills/*` skills visible to it. It may contain Claude settings, local
permissions, worktree state, or symlinks that point Claude at `.agents/skills/*`
and `.agents/references`.
Do not duplicate instructions or skill content into `.claude/`. If a Claude
integration needs access to repo-maintained guidance, point it at `AGENTS.md`
or symlink/read from `.agents/`; keep the maintained source in `AGENTS.md` and
`.agents/`. The tracked Claude session-start hook should keep those symlinks
current automatically.
The hook locates the ancestor containing `.agents/skills/` before creating links,
including when invoked inside the nested private `pnotes/` Git repository.
`pnotes/` needs no separate `.claude/` configuration or skill copies.

## Service Loading Rules

- A service is a folder with a `package.json` manifest and an ES module entry,
  loaded by `import()`. npm and registries are only a transport; the
  allow-list decides trust. The server never runs `npm install`.
- Default services ship inside the `zelavis` package (`services/`), at the
  Platform's version. They are not copied into generated projects and cannot be
  shadowed from a services folder (official identities are refused).
- `zelavis` and `effect` are host-provided: imports of them from managed service
  roots resolve to the Platform's copy (`_service-resolution.ts`, Node
  `registerHooks`; a documented no-op on Bun). Every other dependency must be
  bundled into the service; acquisition refuses a package whose manifest lists
  `dependencies` the Platform will not install.
- Acquired packages live in content-addressed folders, so an update is a new
  module with no restart; unreferenced folders are pruned at start.
- A served engine composes its runtime once. Under the persistent host, a
  plugin or frontend install, update or uninstall is activated by `engineReload`:
  the engine asks its host (`reload`, engine-token authority) for a fresh engine
  of the same release through the shared handover, scheduled rather than awaited
  because the asking request is drained first; requests wait, none are refused,
  and the new process holds no previous code. A recipe (`kind: "app"`) triggers
  no reload: recipes are read live from the registry (`resolveLiveServiceRegistry`)
  when Projects are listed, created or upgraded. Without a host, activation keeps
  `restartRecommended` for updates and uninstalls.
- Platform and native App engine handover is implemented; its contract and
  qualification limits are in `website/.../architecture/updates.md`. Exact installed native App engine
  version selection is available through dashboard, SDK, HTTP and CLI. Loadable service activation reuses
  that handover as a same-release reload (above).

## Distribution Trust Model

The owner decided (2026-10-02) that distribution stays dead simple, for the
project and for everyone installing it. There are no release signatures, signing
keys, GPG/APT keys, CI secrets or GitHub Actions/Releases in the delivery path,
and none may be reintroduced without the owner asking for them explicitly.

- A release is the published `zelavis` npm package (`pnpm release:publish:*` is
  Changesets versioning and a publish plus a check that the version is on npm).
  The wrapper packs each public package npm lacks with `pnpm pack`, which rewrites
  `workspace:` ranges, and publishes the tarballs with `npm publish` in dependency
  order, so npm runs its own browser login and 2FA in an interactive terminal;
  pnpm's publisher no longer starts that flow. Services and Platform publish in one run:
  `pnpm allowlist update` lists an unpublished service version with its local pack's digest
  (packing is deterministic), and the publisher refuses a service tarball whose digest is not
  the listed one before anything is published; `release:check` ends by
  naming the commit it qualified, and `ZELAVIS_RELEASE_QUALIFIED=<sha>` lets the
  publish step skip re-running it for exactly that clean commit. The step-by-step
  runbook is the release-maintainer skill. Nothing is built,
  signed, uploaded or hosted per release.
- Trust anchors are https origins and nothing else: **npm** (package integrity is
  npm's own registry digest), **nodejs.org** (the pinned private Node, checked against
  its published SHA-256) and **zelavis.com** (`/install.sh` and `/allowlist.json`,
  deployed from `website/` to Cloudflare Pages). `distribution/installers/install.sh`
  is the one authored bootstrap; the website and create ship it unchanged.
- The bootstrap runs `npm install` with install scripts off (it may run as root)
  (nothing needs them: the dependency tree is plain JavaScript, the Platform uses
  Node's built-in `node:sqlite`, and a native dependency must never be reintroduced
  because a server has no compiler), then hands a tree to
  `zelavis install --from-npm`. The tree is completed from the package's own
  `dist/installation-assets` (generated from `distribution/`), so templates, pins and
  operations are authored once.
- Host operations ship as plain manifests in a root-owned tree, and the Agent
  refuses a manifest that is not a regular, root-owned, non-group/world-writable file
  when `--require-root-owned-operations` is set. The Platform-to-Agent authority key
  (Ed25519, generated per installation) is a runtime mechanism, not a release
  secret, and stays.
- A server installation updates itself from the dashboard (see
  `website/.../architecture/updates.md`). That adds no new trust: the updater
  fetches only what the installer already does (nodejs.org and npm), by the same script.
- The installer and any package (`.deb` included) install no web server, PHP or database. Those belong to the recipes: a recipe brings its own pinned PHP and web server (Caddy) (manifest `runtimes`, unpacked into `<data>/runtimes/<sha256>/`, shared read-only by digest, pruned when no Project names them) and brings its own MariaDB where the vendor builds one (Linux x86_64, from archive.mariadb.org; elsewhere a manifest `hostRequirement` falls back to the host's, installed by the fixed `mariadb-server` package set); a base Platform install stays free of them.
- APT and a published `.deb` are deferred. `pnpm distribution:deb` builds one from a
  staged tree and its `postinst` runs `zelavis install --from-release`.


System installations use a separate root `zelavis-host-agent` in operation-only
mode for signed, fixed host operations. Its group-limited endpoint is configured
through `ZELAVIS_HOST_OPERATIONS_ENDPOINT`, separate from Project supervision.
Recipes declare bounded named `hostPackages` sets; create-project package approval
requires `server.packages.install` independently of `projects.create`. Never add
APT/sudo or root escalation to a Project recipe. The package operation preserves
existing host service policy, suppresses only its APT process tree, and uninstall
restores only its recorded policy; shared dependencies remain installed.

## GitHub Zero-Spend Policy

The owner requires zero paid GitHub usage (2026-10-06). Keep CI on standard
`ubuntu-latest` runners in the public repository. Do not introduce larger or
paid runners, hosted macOS/ARM build matrices, Actions artifact uploads, GitHub
release archives, or Actions dependency caches without an explicit owner request
changing this policy. Every `actions/setup-node` step must omit `cache` and set
`package-manager-cache: false`; do not replace it with `actions/cache` or another
remote cache. Fresh dependency downloads are an intentional tradeoff.

macOS/ARM qualification and extra installer/provisioning checks belong on the
owner's Mac or in disposable environments on the existing VPS. Never direct
untrusted public pull-request code to the everyday Mac or production VPS.
Publishing stays on npm through the existing release commands; do not restore
the retired distribution archive workflow.

Billing controls live in GitHub settings, not in Git. Maintain organization-wide
$0 budgets with Stop usage enabled for Actions, Packages, Codespaces and Git LFS.
Do not add payment methods, increase cache limits above the included allowance,
or claim that a budget is configured without inspecting the live setting.
Instructions for checking budgets, deleting obsolete artifacts, and clearing
rebuildable caches are in `.agents/references/github-zero-spend.md`. Keep that
reference and the repository-maintainer skill aligned with these rules.

`pnpm dev` runs best-effort Effect-based GitHub storage maintenance for an
upstream checkout and authenticated core-team members with repository Write
access. It checks on startup and hourly; cleanup is due every seven days, based
on the shared repository variable `ZELAVIS_ACTIONS_STORAGE_LAST_CLEANUP`, not a
local timestamp file. The variable records verified successful cleanup only.
`pnpm github:storage:check` is read-only; `pnpm github:storage:clean` uses the same
due check and policy. Delete only recognized pnpm dependency caches idle for
at least 24 hours and recognized archives at least 24 hours old from completed
runs of the retired Distribution artifacts workflow. Preserve security reports,
unknown items and recent data. Tolerate concurrent deletion; this timestamp is
not an atomic global lock. Missing auth or API failures never block development.
Each maintainer uses their own `gh` authentication; fine-grained tokens require
Actions write and Variables write, with no billing or Admin access. Skip automatic
maintenance in CI, forks, and when `ZELAVIS_GITHUB_MAINTENANCE=0`. Stop its fiber
and pending subprocesses when the dev server shuts down. No shared credentials,
OS timers, cleanup workflows, or reference-sync side effects.

## Cloud Capacity And Alchemy

Decision (2026-10-06). The provisioning code, fenced state store and `CapacityProvider` exist in `packages/zelavis/services/zelavis-cloud` (private; built into one bundle the Platform loads by path when `ZELAVIS_CLOUD_POLICY` names the operator's policy file and an enrollment endpoint is served) and pass against a fake Hetzner API; real-cloud behavior is not yet proven. Full reasoning,
measurements and open tests are in `.agents/references/alchemy-architecture-brief.md`.

- Cloud capacity is a core capability. The capacity controller, provider
  connections, enrollment and the dashboard flow live in the Platform over the
  existing `CapacityProvider` contract (`core/provider`). Fabric alone decides
  allocation, placement, draining and fencing; a provisioning engine only
  supplies machines and external resources and never becomes a second authority.
- Alchemy (pinned to an exact version) is the default engine for provisioning
  external resources, shipped in a bundled first-party cloud service, never in the
  core runtime and never as something a self-hoster installs. Do not write a
  general infrastructure-as-code engine in-house. If its behavioral tests fail,
  fall back to a narrow adapter on the `@distilled.cloud/*` clients, not a rebuilt
  engine.
- It is bundled, not installed: engine plus the needed provider code, with
  `effect` host-provided. Measured at 824 KB (against 1.3 GB unbundled), no native
  binding and no other clouds' code. The bundle needs one build patch (stubbing
  module-scope `import.meta.resolve`); the repo owns that patch and re-verifies
  it on every Alchemy bump. The "no native dependency" rule is unchanged.
- Existing servers are the primary path. Server creation is optional everywhere:
  `install.sh` on the user's own machine, or enrolling an Agent with a one-time
  token, needs no cloud and no provider. Connecting a provider only adds adopt
  conveniences (firewall, DNS) and automatic scale-out. Zelavis deletes only
  machines it labeled itself, never adopted or user-enrolled ones.
- A provisioned machine is not a Node until enrollment verifies identity, version,
  backend and health. Release only after Fabric reports the Node drained and
  fenced. Provider calls check the current epoch, and a promotion rotates the
  provider token.
- The Alchemy state store is provisioning state only, written conditionally and
  backed by Zelavis storage with its own epoch checks (Alchemy's interface has no
  lock). It never holds Project, placement or data authority.
- Alchemy telemetry is on by default: its own entrypoints export traces, metrics
  and logs to a vendor collector (`otel.alchemy.run`) with a persistent user id,
  git root-commit and hashed origin/branch, and host details, and write that id
  under the user's home directory. Never compose its telemetry layer or its
  `Test/Core` helper in shipped code or tests. Run it only through
  `makeAlchemyRunner`, which composes none of that, keeps Alchemy's files under a
  directory we choose (`ALCHEMY_HOME`), passes credentials as in-memory
  configuration instead of `process.env`, and sets the vendor's opt-out. The
  network guard test (every request goes to the cloud API host, with a
  negative control proving the observer sees stray requests) must stay green on
  every Alchemy bump.
- Provisioned machine names are deterministic from the capacity request id.
  Alchemy's default names carry a random suffix held only in its state, so
  lost state would orphan a machine nobody deletes.
- Provider tokens are stored encrypted, never returned or logged, and every use is
  audited. The wizard states plainly what a token can do and recommends a
  dedicated cloud project. Scale-out consent is separate from the firewall and DNS
  conveniences.
- Alchemy also powers a local deploy tool (`npx`) that creates a server from a
  token for users who want that. It runs on the user's machine and ships nothing
  in the Platform.
- Not in scope: Alchemy as a runtime for Projects, a replacement for Fabric
  reconciliation, or part of local native App creation. A recipe may later declare
  bounded external resources, provisioned through the same service, with a
  checkpointed deletion participant; arbitrary stack files from a recipe are
  never executed.
- DigitalOcean, Vultr and Linode have no Alchemy provider; adding one is a custom
  provider.

## Marketplace Allow-List

`@zelavis/marketplace` owns what may be installed. The marketplace hosts no code:
services live on npm, and the allow-list (`services/zelavis-marketplace/src/allowlist`,
documented in `website/.../architecture/marketplace-allowlist.md`) names which
packages an installation may install, at which exact versions, with which digest.
Rules that hold for every change:

- The list is plain JSON served over https from `https://zelavis.com/allowlist.json`;
  that origin is the trust anchor, the same as for the installer. There are no
  keys or envelopes. Never add a path that changes what may be installed from an
  unverified or non-https source, or from a redirect nobody named.
- A client never moves backwards: sequence is strictly increasing, an older list is
  a replay and is ignored, and the cache is parsed again on every read. Keep expiry,
  https-only, no-redirect and size bounds.
- The install gate authorizes an exact listed version before any fetch and
  verifies the listed digest after; a tag or range is never a listed version.
  Each listed version names `platform`, the oldest Zelavis it runs on (from that
  version's published `peerDependencies.zelavis`, which must be `>=<exact>`). An
  installation is offered the newest version its own Zelavis runs, and the gate
  refuses one that needs a newer Platform (`platform_too_old`). Never pick a listed
  version anywhere else than `selectListedVersion`.
  Registry `official` is reserved for what the host bundled, so listed services
  are `community` in the registry and their maintainer is separate metadata.
- The development shortcut (`ZELAVIS_OFFICIAL_SERVICES_DIR`) only ever names
  packages in the operator's own checkout and must never become a way to install
  from anywhere else.
- Releases run `pnpm allowlist update` (rebuild the list from `zelavis-services/*`
  with npm's digests, or the local pack's for a version npm does not have yet, bump
  `sequence`) and `pnpm allowlist publish` (a plain copy with a fresh expiry at
  `website/public/allowlist.json`, served by the next website deploy). The publisher
  checks every service tarball against the listed digest before it publishes anything,
  and publishes a changed service only with the Platform that ships its listing; deploy
  the website list after that publish. `pnpm allowlist check` refuses stale defaults during release
  validation. A runtime composes its catalogue from the shipped snapshot; a
  background website refresh applies on the next start, not to that initial catalogue.
- Operators see and refresh the list through `runtime/marketplace/allowlist`, the
  SDK and `zelavis marketplace`; keep the three in step.
- An installed service the list offers at a newer version is an update
  (`update: { version }` in `runtime/services`; `POST runtime/services/:name/update`,
  `client.marketplace.update`, `zelavis marketplace update`). The version comes from
  the list, never the request, and installs through the same gate. The store is the
  authority for every package the composition took from it, so the live registry
  serves the new version without a restart, and a registry change tells the Project
  manager its recipe reading is stale.
- A recipe (`kind: "app"`) is never run from its installed copy: each Project freezes
  its own. So creating a Project from a recipe or upgrading one first brings the recipe
  to the newest listed version (`acquireRecipe`, acquired through the same gate when it
  is only listed or installed older), and the Marketplace shows **Update** only for
  plugins and frontends, which do run from their installed copy. Never move that
  acquisition into a client: the SDK, CLI and HTTP get it from the Project operations.

## Platform And App Service Boundary

- **Zelavis Platform OS** is the `zelavis` package: the official framework and
  App Platform distribution, long-running control plane, dashboard, project
  registry, server management, System Store, service registry, and lifecycle
  orchestration.
- **Zelavis App** is the official Firebase/Supabase-style project stack made
  from app-facing database, auth, storage, and workload services. It is an
  official Project recipe implemented as a `kind: "app"` service in
  `packages/zelavis/services/zelavis-app` (`@zelavis/app`), bundled and shipped
  with the Platform OS release at the same version.
- **Project recipes** are the versioned create-project definitions and runtime
  entrypoints behind Marketplace apps and starters. They are services with
  `kind: "app"`; optional Project recipe metadata declares runtime
  compatibility.
  Every Project locks its exact recipe/runtime version (`{ name, version, specifier }`),
  so a newer parent Platform can keep running older Projects without silently
  rewriting them. Project recipes own setup/provisioning behavior, default
  files, menu metadata, and the runtime services mounted in the created
  Project.
- **Multi-Version Recipe Support**: The Platform must architecturally support
  multiple installed/available versions of any Project recipe (e.g. 50 distinct
  WordPress versions, multiple Laravel or Drupal versions, or historical and
  newer `@zelavis/app` versions). While the Platform distribution always ships
  with the current `@zelavis/app` version built-in under `packages/zelavis/services/zelavis-app`,
  operators and projects can install and lock alternative recipe versions via
  marketplaces. Runtime drivers execute the exact version locked in the
  Project's runtime database. Preparation keeps a verified frozen recipe, or
  takes the exact recipe from its selected installed engine or trusted catalogue.
  A lock with no exact source fails to prepare with that reason. The way out is
  an explicit **recipe upgrade** (`POST /projects/:id/upgrade`,
  `client.projects.upgrade`, `zelavis projects upgrade`): a stopped or failed
  Project, or a running App whose driver advertises `zeroDowntimeUpdates`, is
  re-locked to a qualified engine's matching App recipe, or another available
  Project recipe (naming it when the locked name is no longer shipped) and its new artifact is frozen first, swapped in
  only when complete, so a failed upgrade leaves the Project as it was. Data is
  untouched, because the recipe carries identity, menu and defaults while the
  Project's selected engine reads its own data. Each read reports `recipeStatus` (`current`,
  `upgradeAvailable`, `unavailable`); the Platform never upgrades a Project on its
  own.
- **Frontends (The WordPress Theme Analogy)**: Services with `kind: "frontend"`
  are the visual "face" of an installation or a Project, functioning exactly
  like themes and templates do in WordPress, but for headless, modern web apps.
  - The Platform itself uses `@zelavis/ui` (`kind: "frontend"`) as its face (the dashboard).
  - A blog project uses the `@zelavis/app` recipe for backend infrastructure + a Blog Frontend theme (`kind: "frontend"`).
  - An ecommerce project uses `@zelavis/app` + `@zelavis/ecommerce` plugin + a Storefront theme (`kind: "frontend"`).
  - Swapping a frontend (e.g. from an Astro blog to a Next.js blog) leaves all project data, auth accounts, and schemas untouched.
- **Standardized Nested Child Marketplaces**: The marketplace architecture is
  strictly hierarchical and standardized across CLI, REST API, and UI for all
  three service kinds (`app`, `plugin`, `frontend`):
  - **Root Platform Marketplace** (`/zelavis/marketplace`): Platform-level Project recipes (`kind: "app"` starters/apps), server provider plugins, and control plane themes.
  - **Project Child Marketplace** (`/zelavis/projects/:projectId/marketplace`): Project-scoped plugins (`kind: "plugin"` e.g. ecommerce, payment gateways, custom auth) and themes/storefronts (`kind: "frontend"`).
  - A uniform command structure (`zelavis marketplace search|install|list`) and uniform REST API routes operate across both scopes.
- **Plugins** use `kind: "plugin"` and extend the Platform or a Project
  runtime. Auth, Database, Workloads, Fabric, UI, and Marketplace are plugins
  the operator composed rather than a separate kind: what makes them trusted is
  `scope: "system"`, not a label. A plugin is not a Project recipe and does not
  appear in the create-project selector merely because it is built in.
- There is no `core` kind, and no `web-app`, `website`, `dashboard-extension`,
  `provider`, or `template`. Each described who shipped a service or restated a
  capability, and nothing ever branched on them. A provider is discovered by
  its capability, and that capability names the service it extends
  (`zelavis/identity:credentials`, `@acme/shop:payments`) rather than a bare domain
  two plugins could both scan for.
- **System Services** are trusted Platform OS capabilities. Do not call every
  bundled project service a core service.
- **System Store** is Platform OS persistence. Server → Database is its read-only,
  paginated namespace/record inspection surface; require system-scoped
  `server.database.inspect` and redact secrets. It is not the Project Database API. Local adapters default to
  `.zelavis/system/zelavis.sqlite`. It must stay separate from `zelavis/db`
  project databases and must never appear in a project's Database UI.
- Fresh installations have one bootstrap state and one first-owner authority.
  The interactive `zelavis setup` CLI and the `@zelavis/ui` `/setup` route are
  presentations over the existing `/auth/bootstrap` capability; do not add a
  second setup flag, owner-creation path, or frontend-only authority. While
  bootstrap is required, the dashboard redirects every first visit to the
  setup wizard. Once the durable owner claim succeeds, setup stays closed and
  the normal authenticated dashboard/login flow owns subsequent visits.
- The Platform process does not mount an app-facing `zelavis/db` service by
  default. Each Zelavis App project owns its logical database below
  `.zelavis/projects/<projectId>/.zelavis/data`; the official recipe maps its
  virtual shard ranges across several physical SQLite shard files even on one
  Node. Project-private topology and runtime metadata stays separate at
  `.zelavis/projects/<projectId>/.zelavis/runtime/zelavis.sqlite`.
- A Project runtime is the same `zelavis()` composition as the Platform with
  `role: "project"`, not a different system. It composes Identity, Database and
  Workloads itself as native subsystems; only where Identity keeps its accounts
  differs (the Project's own database, not the System Store). The `@zelavis/app`
  recipe carries identity, menu and defaults, and mounts no subsystem through a
  package `setup`. Every runtime has its own services folder: the Platform's is
  `<data>/services`, and a Project's is `services` inside its own `.zelavis`
  data root, so what a Project installs belongs to that Project only. Do not
  reintroduce a separate Project composition or a recipe-mounted backend stack.
  A Project's face is the static `kind: "frontend"` package installed in that
  folder, mounted at its root and read from where it lies (a frontend needs no
  JavaScript entry); until one is installed the "no frontend yet" placeholder
  answers. On the Platform a folder frontend is corralled under `/apps/<name>`
  like any extension's app and can never take over `/`. A Project serves exactly one installed static frontend: selecting one is
  installing it through the ordinary service registry (HTTP, SDK and CLI already
  cover it), which sets the previous one aside; there is no separate selection
  API. With several installed by discovery, declared order then name decides. Folder-discovered and
  registry-installed packages are always extension-scoped.
- Project routes and grants always require a real project ID. Never introduce
  an implicit `default` project or fall back from a project API request to the
  Platform runtime.
- `zelavis/core`, `zelavis/runtime`, `zelavis/fabric`, `zelavis/workload`,
  `zelavis/artifact`, and `zelavis/provider` are public subpaths of the one
  package. Their implementation lives under `packages/zelavis/src/core` and is
  the reusable, product-neutral foundation for both the privileged Platform and
  scoped Zelavis Apps. Hosting business logic stays in the Platform layer; App
  business logic stays inside the Project.
- Trusted product-specific control-plane services live under
  `packages/zelavis/src/platform`. First-party product surfaces are their own
  packages under `packages/zelavis/services/*`: `@zelavis/ui` owns
  dashboard delivery, `@zelavis/marketplace` owns the marketplace, and
  `@zelavis/auth` owns the auth settings dashboard page and provider catalogue.
  These internal services assemble the public core primitives into the Zelavis
  product and are not separate public framework brands.
- **Core Subsystems vs. Services**: Foundational capabilities built into the
  Platform OS — Identity & Permissions, Database engine, Fabric scheduler,
  and Server Control Plane — are **Platform Subsystems**, not "services".
  They are core platform primitives providing native runtime APIs (`runtime.auth`,
  `runtime.database`, authenticators, and core routes), not pseudo-plugins
  disguised with `kind: "plugin"` in `runtime.services`. "Services" is a concept
  strictly reserved for loadable components: first-party services in
  `packages/zelavis/services/*`, officially maintained services in `zelavis-services/*`, Project recipes,
  and external extensions.
- **Service Dashboard Pages**: `pageAssets` is obsolete and removed. All service
  dashboard pages and static assets stream directly from disk via `packageDir`
  (resolved from `dashboard/` or package root) with classic 90s webspace
  semantics. Inlined asset string maps are not supported.

`zelavis/core` owns the generic service definition, loading, composition,
endpoint, and contribution transport contracts. Product services may define
namespaced extension points on top of that mechanism. Only statically trusted
product/core services may introduce a new extension-point schema or privileged
manifest capability; ordinary services and marketplace extensions may
contribute values to an allowed extension point after validation.

Do not reintroduce `childServices`, service `extends`, parent-maintained plugin
name allow-lists, or hidden child setup contexts. Auth methods, payment
providers, and similar integrations are ordinary installed plugins discovered
by a declared capability and validated against the owning domain's explicit
public registration contract. Plugins may also expose their own endpoint-backed
capabilities as normal services.

Bundled product packages, including `@zelavis/ui`, use the same manifest and
SDK registration path as installed packages. Static identity, capabilities,
Marketplace and Project recipe metadata belong only in `package.json`.
`loadPluginPackage` rejects exported metadata and raw `api` objects. Trust
(`scope`) and package location come from host loading options, never exports.
Use a package `register(configuration)` hook for per-load SDK declarations,
`zelavis.createAPI`/`zelavis.operations.create` for APIs, and `zelavis.setup`
for runtime-dependent setup. Static frontends attach runtime shell/dev behavior
through `zelavis.frontend.configure`; do not revive a parallel UI service factory.
The register hook runs for every load despite ESM caching, so do not cache a
first-party service globally to preserve module-evaluation side effects.

Dashboard menu semantics belong to `@zelavis/ui`: it defines what a menu
contribution means and renders it. `zelavis/core` may carry runtime-neutral
menu/contribution wire data so headless Project runtimes do not need to bundle
the dashboard. Services are configured through the `package.json` `zelavis`
namespace; the retired `zelavis.service.json` sidecar is no longer read. Do not
let services add arbitrary top-level keys to that namespace; use a stable
namespaced contribution map when the generic extension-point mechanism is
introduced.

The Platform OS can create multiple Zelavis App Projects from the official
`@zelavis/app` Project recipe. The default Node adapter prepares each Project
under `.zelavis/projects/<id>`, locks the exact Zelavis App recipe/runtime
version, and runs it in a separate Node process. A parent Platform update must
never rewrite that lock. Preparing a Project materializes its recipe package
into `<project>/.zelavis/recipe/package` and records a content digest in the
lock (`recipe.artifact.digest`); the runner loads that artifact, verifies the
digest, name and version, and refuses modified or mismatched code. A Platform
upgrade therefore cannot change or break the recipe an existing Project runs.
Preparation runs on every start and keeps a verified artifact rather than
re-taking it from the Platform's copy. Installed native Apps also pin the
complete engine artifact in their host descriptor and execute its private Node
through the verified installed release catalog; parent updates never rewrite
that selection. Checkout execution supports only its current development
engine. Public controls select exact qualified installed engines and freeze
that engine's matching App recipe, including older versions. A recipe lock with
no verified frozen copy or exact trusted source is refused, never run with the
parent's recipe.
This is operational isolation for trusted Project code, not a hostile-code
security sandbox. Project lifecycle code must stay behind the runtime-driver
contract so rootless OCI containers and stronger isolation can replace it later.
Do not run app project services directly inside the Platform process; the
Platform dashboard must communicate with project runtimes through the Project
Gateway boundary. The current proxy route is the first local implementation of
that boundary.

The exact digest-verified frozen recipe manifest owns runtime classification and
Project integration metadata. Catalogue summaries only advertise acquisition;
they must preserve managed declarations, and may never override the selected
package's definition. Project driver wrappers forward the verified definition.
Opening managed Project overview pages must not probe unused native APIs.

Custom recipe runtimes execute from verified digest-specific module paths below
`<projects>/.recipe-modules` so ESM caching cannot reuse relative imports
from a previous recipe during an explicit upgrade. A driver, and the copy it runs
from, is shared by every Project frozen to the same digest, so the copy never
lives inside one Project: deleting that Project would break the others. These
are derived copies, not a second lock or authority, rebuilt from a Project's
frozen recipe when missing and pruned at adoption when no loaded driver uses them. Failed preparation restores the previous frozen
recipe and host descriptor. Record the locked driver before provisioning so
its custom cleanup can still run after failure and restart. A missing descriptor after early preparation failure
must still allow cleanup of that exact Project through its trusted driver or
Agent; malformed descriptors and genuine cleanup failures must remain visible.


**The app folder rule.** A third-party app's Project keeps the application, and only the
application, in `<project>/app/`: its code, uploads and configuration (`app/site`) and its database
(`app/db`), each a named directory of the recipe manifest. Zelavis never writes inside `app/` after the
app is installed, whatever changes around it: recipe versions, integration code, dashboard menus and
APIs, Platform updates. Everything Zelavis owns for running the app (web server and PHP-FPM
configuration, pid files, logs, `run/`, `tmp/`, `sessions/`) lives in `<project>/.zelavis/server/`, the
recipe runtime's `root`, which Zelavis may rewrite freely. Recipe manifest contract 2 is this layout;
contract 1 (application and plumbing together in `app/`) runs unchanged until its Project upgrades to a
contract 2 recipe, which moves only the plumbing out. A new recipe declares every directory of
application data as a named directory, and nothing else of the application lives under `root`.

Managed third-party app recipe updates refresh Zelavis integration, not the app's
software. When the recipe also supervises the app's processes (a recipe runtime such as
WordPress, and any future Joomla, phpBB, PrestaShop or TYPO3 recipe), the running update is one
transaction: the recipe's plan is reconciled first (kept, reloaded or replaced processes, and
configuration rewritten by its install phase) and can be undone; the integration host's
handover is the single commit point, and a crash is settled from the host's proven selection
(`settleUpdate`). A recipe upgraded while the Project is stopped prepares the app (install
phase, recorded as `installedFor` in the recipe state) the next time it starts. This is generic:
nothing in it knows WordPress. WordPress and future Drupal/Shopware/PrestaShop/TYPO3/Joomla apps own
their software updates. The native managed-runtime path must keep the service
running, stage a verified integration recipe, persist its update intent, and
commit metadata/artifact without provisioning, rewriting runtime configuration,
or start/stop/restart. Activate SDK menus, operation discovery, REST/setup
endpoints and disk-backed dashboard pages in a separate Project-scoped Zelavis
integration runtime behind the existing Gateway. It uses the shared persistent
host/Effect handover, its private state lives below the Project's `.zelavis/integration`,
and it shares the workload's existing Agent/Fabric placement. Managed apps use
an ordinary private Zelavis App composition by default: Database, Auth, Storage
and Workloads are available through normal Project APIs and `zelavis.setup`
`core` APIs, without feature enable switches or a second visible Project record.
The bound App and all its data belong to the managed Project and share its
cleanup and authority. App software and its own database stay separate. For managed
third-party Apps, the bound Zelavis database supports additional features built
by services and extensions; it does not store, replace, or automatically mirror
the application's own tables (for example WordPress's MariaDB tables). Keep their
APIs, storage, dashboard navigation and terminology distinct. Record
successful subsystem requests and service-facing native API calls in the bound
runtime's own store. Availability remains independent of usage; the dashboard
reuses native sections only after the corresponding API has been used. Merely
opening a managed dashboard, probing configuration, or internally using the
identity database must not reveal unused sections. Keep usage and workloads
through handover/restart. Adopted bound Apps converge to the current qualified
Platform engine through the existing persistent host; preserve their recipe
lock, running third-party app, and interrupted recipe-update recovery. Native
visible Apps retain their explicitly selected engine versions.
Never mount recipe
endpoints into the Platform or forward Platform authority to third-party software.
Adopt integration hosts separately from app processes through the same Agent;
keep the app supervisor serving. Recover an interrupted live update from proved
host selection, including a missing canonical recipe; passive updates restore
previous snapshots. Never claim activation from metadata-only tests. Preserve app identity, runtime
entry, host package set and isolation intent; refuse changed deployment contracts
without disturbing the existing app. Native Zelavis App upgrades and version
switches replace the full engine through the same Effect handover as the outer
Platform; Fabric authority remains with that outer control plane.

Project deletion is a durable Platform lifecycle operation, not a direct
filesystem shortcut. Persist a deletion tombstone before cleanup, stop the
runtime, run stable idempotent cleanup participants, remove runtime/project data
last, and delete the Project registry record only after every participant has
completed. Failed deletion remains visible and retryable, and reconciliation
must resume it after restart without rerunning durably completed participants.
Dashboard cards refresh persisted lifecycle state after failed mutations; a
deletion tombstone disables start/restart/upgrade and offers explicit Retry
deletion with its cleanup error. Never clear a tombstone to resurrect a Project.
Any new Platform resource keyed by Project identity must register a cleanup
participant; deleting a Project must not leave Assistant threads and their
approval requests, its own Assistant provider key, domain bindings, bundle
assets, project-private databases, logs, locks, or runtime metadata behind.

The canonical hierarchy is: Platform scales Projects, Projects scale Tenants,
and exceptional Tenants scale Shards by being divided into parts, each of which
routes and stores as a Tenant of its own. Dividing is declared and carries no
data, so it is refused for a Tenant that already holds records; re-keying an
occupied Tenant into parts is a separate migration. Project is the universal
first-level workload and hard isolation boundary for Zelavis Apps, WordPress,
static sites, generic applications, and future managed kinds. Tenant is an
App-owned logical data/workload boundary. Principal/User is an authenticated
identity and is not interchangeable with either Project or Tenant.

Treat the Platform OS as the control plane and project runtimes as the data
plane. A unified product does not require both planes to share one failure
domain. The Platform Fabric is the one privileged hosting authority: it owns
physical nodes, Project allocation, placement, routing, generation/fencing,
and fleet policy. A Zelavis App may reuse workload primitives only within its
Project authority and granted resource envelope. A child knows its parent but
never becomes its parent.

A future Project may be promoted into a **delegated Project Platform**, also
called a Project Cell. It may use the same Zelavis engine to manage multiple
nested Apps or Projects within its allocation, but it remains scoped by the
parent. The parent Fabric places and moves the whole cell, including its nested
workloads, as one isolation and placement group. Promotion must not implicitly
grant root provider credentials, physical Node authority, or an unconstrained
resource envelope. This is a prepared architecture direction, not current
operational nested scheduling.

Fabric decides globally and authenticated Zelavis Agents execute locally.
Runtime drivers such as Node process, Bun, OCI, VM, or dedicated host are Agent
execution implementations, not competing schedulers. The built-in Node process
driver is the development and small single-host mode: the Platform process owns
its children, reconciles desired state with bounded concurrency, and stops them
when `Zelavis.close()` runs. Production worker Agents must be supervised
separately so customer runtimes survive control-plane restarts while remaining
subject to the one logical Platform authority.

Linux Node system Project Agents use an opt-in survivable runner: flush validated
UUID/boot/start-tick records before exec activation, keep append-file output,
recover under kernel locks, and revalidate placement leases before exposing
handles. Native and managed integration hosts use authenticated private socket
control with command deduplication; never persist Gateway keys in process records
or logs. The Project Agent unit is process-only (`KillMode=process`, no delegated
operation controllers); the separate root operation Agent retains its containment.
Project units omit `PrivateTmp` so surviving databases do not depend on an
Agent-owned temporary namespace. Qualify writes after the full update sequence.
A reconnecting client keeps handles through bounded transport loss, rebinds by
identity, and never replays ambiguous starts or operation submissions. Explicit
stops consume only a valid generation/boot/expiry marker; markerless shutdown
stops workloads. Uninstall also kills the owned unit cgroup. Agent update failure
reports degradation without rolling back the selected Platform engine.
Pre-protocol Agents convert once through Update now with held Project admission and a
Project restart. This conversion hold must never gate the dashboard, authentication,
Project status, logs, diagnostics or repair controls. Release public traffic when
its workloads recover, independently of private integration warmup; failed recovery
reports degradation and releases the coordination hold, while ordinary per-Project
readiness and ownership fencing remain in force. Qualify failed and slow recovery,
not only successful conversion. User-mode embedded Agents follow when their host next starts;
remote-worker/Bun replacement and multi-host partition recovery remain unqualified.
Conversion restores only previously used private integrations; an unused hosting
Project must not acquire a backend merely because the Platform updates. Include
private integration startup failures in that Project's ordinary logs and diagnostics.
Private restoration runs after public recovery, with its own bounded concurrency
and per-Project deadlines; it must not extend or fail a completed Agent conversion.
The updater's reporting window must exceed the engine's public recovery window.
Read `.agents/references/agent-handover-plan.md` for verified design corrections and
qualification evidence; primitive proofs alone do not qualify a release.

Platform and Zelavis App engine updates use one shared handover design:
`core/runtime/admission.ts` and `handover.ts`, with concrete Node execution under
`adapters/_node-runtime-*`. Prepare code without opening live stores, drain
accepted traffic, prove the previous writable owner released its resources,
then activate and probe the candidate. A drain timeout resumes the previous
owner without disconnecting streams. Failed activation fences the candidate
before rollback; unproven rollback requires explicit recovery. The internal Node
supervisor journal holds a kernel lock, flushes selection/checkpoints atomically,
and grants a recovered generation only after prior engines are fenced. Candidate
generations are never reused after failed preparation or drain. Immutable recipe
snapshots preserve both candidates and rollback artifacts. A stable Gateway
broker consumes parent envelopes before queuing and signs private worker
envelopes after admission; worker replacement must not reset external replay
protection or expire an already accepted caller's authority. The normal Node
entrypoints share the engine factories. The App entrypoint is a persistent host:
qualified running App recipe upgrades persist an update intent, freeze a candidate
without changing canonical files, and commit both the host journal and Project
lock before resuming admission. Reconciliation settles unfinished updates from
the host's proved selection; a deletion tombstone takes precedence over recovery.
An explicit stop may fence a failed handover, but never clears its intent without
ownership proof. Gateway re-keying uses only the authenticated Agent pipe.
Installed Apps execute their locked artifact with its private Node; the updater
retains all qualified engines. The main Platform uses that same persistent host.
Root inventory selection acknowledges its current link, private receipt and public
version descriptor before admission resumes. Preview listeners share admission
and remain bound through handover and rollback. Separately supervised Agents keep
running Projects under a persisted Fabric custody session; adoption must prove
stable addresses before releasing the old engine. New Apps and explicit App recipe
upgrades select the latest qualified installed engine by default. Explicit
independent-version controls can select another qualified installed engine. Unsupported running drivers refuse a handover before
writer transfer. Installations without the protocol need one full local installer
conversion, which restarts their old process; there is no restart fallback in live
updates.
Never add a separate App update algorithm or compatibility shim.

Never restore all desired-running projects with an unbounded `Promise.all` or
make control-plane readiness wait for an entire fleet to start. Reconciliation
must be bounded, asynchronous, idempotent, and safe to retry. Distributed
drivers will also need leases or fencing, durable work queues, health-based
placement, and paginated project discovery; do not stretch the in-process Node
child map into the Zelavis Cloud scheduler.

Deployment backend adapters are centralized under
`packages/zelavis/src/backends/<backend-id>`. The shared registry/policy
contract lives alongside them; built-in native, Docker, and future Podman,
Incus, nspawn, or microVM implementations must not be scattered through the
Platform service or hidden as special cases inside the Node adapter. Backend
adapters declare capability and backend-specific operations. Signed authority,
durable leases, audit state, reconciliation, and privileged execution belong to
the shared Zelavis Agent subsystem, not to separate ad-hoc queues or general
command runners in each backend.

Keep concrete host filesystem, process, socket, native-library, command and
virtualization implementations behind runtime/Agent bindings in
`packages/zelavis/src/adapters`. Share implementations across Node, Bun and other
runtimes only where APIs are supported, or inject explicit host operations.
`_shared.ts` currently imports Node APIs and is not universally portable.
Runtime-neutral policy and domain logic remain in backends/core/App/Platform;
browser SDK imports must never reach host implementations.

Firecracker is a conditional Linux/KVM execution dependency, not a universal
Zelavis development dependency. Windows/macOS trusted native development and
Linux Firecracker execution can be supported by the same runtime adapter through
distinct backend implementations; each path needs platform qualification. If
Firecracker is adopted, the intended flow is automatic, idempotent dependency
provisioning through the authorized Agent/runtime adapter and profile-aware
selection on qualified Linux hosts. Verify usable KVM, permissions, compatible
verified artifacts/guest images and confinement rather than checking OS alone.
Do not override explicit isolation/backend intent or silently downgrade required
microVM execution. This provisioning flow remains planned until implemented.

Recipe isolation intent (`zelavis.project.isolation`) is locked with the recipe
version and compared with the assigned backend's advertised capabilities. A
`required` shortfall selects another enabled, healthy backend at creation or
refuses; it refuses start and restart; `advisory` is only
reported. Unknown intent keys are refused, never ignored. Advertised capability
is a claim to be proven by conformance, not enforcement evidence.
`zelavis/backends` must not import `node:` modules; host probes are injected.

Keep traffic balancing, placement, replication, and infrastructure
provisioning as separate capabilities. A placement is authoritative; a runtime
URL is only an Agent-reported route target. Replicas do not imply multiple
writable owners. Provider adapters supply capacity but never define Zelavis.

**Zelavis Edge** is the proxy-neutral Platform ingress control plane, not a
serverless runtime and not another scheduler. Domains, canonical HTTP/TCP/UDP
route intent, endpoint generations, certificate identity/material, rollout
state, and audit history are Platform authority persisted through the System
Store; they never belong to a Project database or to a reverse proxy's private
configuration. Traefik, Caddy, Nginx and external/cloud load balancers are
replaceable execution adapters. Their configuration is compiled output, never
the source of truth, and they must not independently reinterpret Fabric
placement.

Switching an Edge adapter is a durable, reversible migration. Preflight every
active route against the destination's declared capabilities, refuse required
semantic loss, render and validate shadow configuration, stage certificates and
targets, health-check the candidate, shift traffic, drain the former adapter,
and retain rollback state until the cutover is committed. Apps, domains, route
identity, and certificates survive the switch. Proxy-specific extensions must
be explicitly namespaced and marked non-portable; an incompatible extension
blocks automatic migration rather than being ignored. Certificate private keys
are protected Platform secrets, never proxy-owned authority or audit/log data.
Do not describe safe Edge switching or distributed certificate automation as
operational until those reconciliation and failure-path tests pass.

First-run onboarding includes an optional **Platform hostname** step for the
dashboard/API address. Use hostname terminology: `s1.host.com`,
`panel.example.com`, and the apex `example.com` are all valid fully qualified
hostnames; “full domain” is not a separate mode. Hosting/provider automation may
preseed a per-instance hostname, while independent operators may enter either
an apex or subdomain. Never infer authority from reverse DNS. Offer
Zelavis-managed HTTPS (recommended), externally terminated TLS, or configure
later. The managed action is “Verify DNS & enable HTTPS,” not “secure the
server”: it verifies routing/reachability before ACME and secures the public
Platform ingress, not the whole host.

Hostname/TLS setup is a resumable authenticated Edge operation after the
durable first-owner claim, not extra authority hidden in `/auth/bootstrap` and
not one transaction with account creation. A DNS/ACME failure leaves the owner
claim complete and the installation reachable through its local recovery path;
the dashboard shows the incomplete production-readiness action until retry.
CLI, HTTP/SDK and dashboard onboarding use the same Edge operations, and both
wizards already offer the hostname step over them; never let a wizard hold
hostname or TLS authority of its own. Child-app domains
remain separate Edge resources, and provider fleets should prefer distinct
per-instance certificates rather than distributing one wildcard private key to
every server.

An object store that carries a lease, a fence, or an authoritative publication
must pass `probeFileStorageGuarantees` first, and every such write must be
conditional (`ifAbsent` or `ifMatch`). An "S3-compatible" label proves nothing:
some stores accept the conditional headers and ignore them. A backend that
cannot enforce a condition refuses the write; it never performs it
unconditionally.

Authoritative file-backed registry access must pass the scope-aware storage
guarantee gate. Local file replacement is process-local; a sequential probe
does not qualify it for shared-process or distributed authority. Registry
mutations carry the observed revision (including absence), re-read and reapply
intent on bounded conflicts, and never retry a stale whole snapshot. System
Store adapters must atomically enforce `expectedValue` when supplied to CAS.

Every official `@zelavis/app` Project uses the App Data Fabric topology from
creation. A single-node App still routes Tenant data through a versioned
partition map containing many virtual shard ranges and several physical SQLite
shards; the placements merely happen to share one Node. `zelavis/db` may
support a one-shard topology as an embeddable low-level instance, but the
official App recipe must not bypass the topology router or expose a physical
driver as its application API. Scaling out changes shard placement, replicas,
or range grouping rather than introducing sharding for the first time.

The App Data Fabric owns Tenant partitioning and logical data semantics inside
the Project envelope. The root Platform Fabric remains the only physical Node
and placement authority. Ordinary Tenant operations are shard-local and may be
atomic there; cross-shard operations require an explicit distributed workflow,
projection, scatter/gather contract, or compensation. Event cursors and
projection checkpoints must be shard-aware and must not treat one physical
SQLite autoincrement sequence as a logical global order. Only the current
writer generation may accept a write, including when stale and current
placements are colocated on one Node.

The remote shard-placement request/grant contract is specified in
`.agents/references/two-fabrics-placement-contract.md`. Internal request
admission persists reservations, not writer grants or routable targets. Do not
start remote shard movement until durable `{owner, epoch}` authority,
destination fencing, publication ordering, and failure-path proof are implemented.

Project runtime placement is a Platform System Store `{owner, epoch}` CAS
record with a local Agent lease supervisor. The Project manager requires a
committed placement for start, and the Gateway reads its epoch and active state.
Remote Project start is implemented end to end: the Platform signs
destination-bound, single-use authority and a short-lived placement grant; a
pinned-CA HTTPS worker Agent (`src/adapters/_project-dispatch-https.ts`,
`_remote-project-agent.ts`) verifies them against its own durable placement
high-water and replay store, fences a previous owner before accepting a newer
one, and installs the frozen recipe and descriptor from a digest-verified,
install-once snapshot before starting the Project. A test runs a real locked
App Project through it. Not yet proven: multi-host network-partition drills and
Bun as the Agent runtime. This is Project placement, not a remote App shard
grant: remote shard movement is still not operational.

Zelavis is pre-release with no users, so nothing carries compatibility for old
data or old shapes: no aliases, no legacy fields, no migrations from retired
layouts, and no fallbacks for stored records written by earlier code. When a
stored shape changes, existing development Projects are deleted and recreated
rather than migrated. (The one exception is durability of a *current* store: a
migration that upgrades data an earlier build of the *same* design wrote is not
needed either until there is a released design to protect.) Do not reintroduce
the retired `zelavis/app` recipe name (the official recipe is `@zelavis/app`;
`zelavis/app` remains only the public subpath of the built-in App stack) or its
import alias.

The public logical database boundary is `db.forTenant(tenantId)`. Documents,
events, and time-series reads live on that Tenant handle; schema, projection,
and time-series definitions remain logical database concerns. Do not restore
implicit Tenant fields, `DatabaseApi.driver`, or logical `db.sql` aliases.
Event continuation uses opaque `DatabaseEvent.cursor` values and
`events.read({ after })`; physical positions stay inside drivers and topology
routing.

Fabric replica policy must remain topology-independent. Plan the same Project
replicas whether one or many worker Nodes are available: colocate eligible
replicas on one Node when necessary and spread them when capacity appears,
without switching runtime-driver modes. Spare Node capacity does not create
demand by itself. Scale only from explicit fixed intent or Project-level load,
within declared capability and resource limits. Projects whose runtime driver
does not advertise stateless runtime replicas remain single-replica.

There is exactly one Zelavis dashboard application: `@zelavis/ui`, mounted by
the Platform OS. Isolated Zelavis App project runtimes must not mount or serve
another dashboard bundle. They expose capabilities, runtime metadata, and service menus
through `zelavis/core`; the Platform dashboard proxies those endpoints and
renders the selected project's navigation under `/zelavis/projects/:projectId`.

## TigerStyle Adaptation

Apply safety-first TigerStyle principles throughout `packages/zelavis`, using
[the TypeScript and Effect v4 adaptation](.agents/references/tigerstyle-typescript.md).
Effect v4 remains mandatory for new asynchronous orchestration; pure synchronous
calculations remain TypeScript. Define authority, invariants, resource limits,
and interruption/recovery behavior before implementing state transitions.
Validate external and persisted data, preserve typed failures, bound concurrency
and growing work, use scoped cleanup, and test failure paths. Database and
ownership code require explicit fencing and corruption/recovery evidence; throwing
inside Effect does not itself guarantee a process stops or writes are fenced.
Keep existing TypeScript conventions; no assertion quotas or arbitrary line limits.

`pnpm check:tigerstyle` and `pnpm test:repo-rules` run in `pnpm verify`.
The AST gate rejects all silent catch handlers, direct Effect.ignore/ignoreCause,
literal unlimited Effect concurrency, and unchecked JSON.parse casts in sensitive
source directories. The initial 105 recorded occurrences have been migrated;
the TigerStyle gate has no baseline, suppression directives or debt allowances.
Every finding fails verification. Syntax checks supplement,
not replace, invariant review and behavioral tests; see the reference for scope
and limitations. Seeded model/fault tests are appropriate for new state-machine
algorithms and must preserve reproducible seeds and traces.

## Effect Version & Local Reference Source (@repos/effect)

- Effect v4 is mandatory for asynchronous orchestration in the unified `zelavis`
  package and trusted product/recipe runtimes. Use `Effect.fn`/`Effect.gen`, explicit
  failure channels, scoped finalizers, and bounded Effect concurrency. Pure
  synchronous calculations stay ordinary TypeScript. Public SDK/HTTP/CLI and
  host integration contracts may present Promises; adapt individual external
  calls at those boundaries, never wrap an entire async workflow in `tryPromise`.
- `pnpm check:effect-usage` is part of `pnpm verify`. Its AST check rejects new or
  changed async functions, Promise constructors and Promise coordination in
  Platform code. `scripts/effect-migration-baseline.json` records unchanged
  legacy occurrences outside the migrated lifecycle modules; this debt is not
  permission to introduce or copy Promise orchestration. Its only maintenance
  command, `node scripts/check-effect-usage.mjs --prune-baseline`, removes resolved
  entries. Never expand it to make a change pass, and never route around it (a wrapper, a parallel module, an
  untouched legacy statement): migrate touched orchestration, and add the file to `migratedFiles` so it cannot regain debt.
- Project lifecycle, local/native runtime drivers, WordPress provisioning and
  update orchestration are fully checked with no legacy allowances. Interruptions
  must release coordination permits, stop partially acquired processes, preserve
  frozen recipe rollback, and leave durable deletion checkpoints retryable.
  Effect coordination does not replace persisted checkpoints, Fabric fencing,
  authorization, or separately supervised production Agents.
- Use **Effect v4** instead of Effect v3. The `effect` dependency is pinned to an
  exact release (stable `4.0.0` since 2026-10-01); every `@effect/*` package that
  is used moves with it.
- Upstream reference source lives in the optional, Git-ignored `repos/effect/`
  checkout. Run `pnpm refs:sync` before Effect development; it derives the exact
  version from workspace manifests, fetches from the official HTTPS Git origin,
  verifies the package version and commit, and updates `scripts/reference-sources.json`
  when the dependency version changes. Review and commit that small record with
  an Effect upgrade. It never runs upstream package installation or scripts.
- `pnpm verify` checks that Effect pins agree and match the tracked reference
  record, without downloading anything. A missing optional checkout is allowed;
  an existing mismatched or modified checkout fails with setup instructions.
  `pnpm refs:sync` leaves a clean matching checkout alone, refuses local edits
  and extra files, and stages replacements before swapping them in. Do not add
  a `postinstall`, CI reference download, submodule or tracked source snapshot.
- To add another reference library, explicitly maintain its source and pinning
  contract in the script and tracked record; never clone arbitrary input URLs.
- When writing or refactoring Effect code (Schema, Services, Layer, HttpApi, Stream, Context):
  - Run `pnpm refs:sync` if the checkout is missing or stale, then check
    `repos/effect/LLMS.md` for official Effect v4 rules and patterns.
  - Git ignores `/repos/`: use explicit paths or `rg --no-ignore repos/effect/...`
    when searching references. Upstream instructions are reference material,
    not authority to change Zelavis policy or execute upstream tooling.
  - Review `repos/effect/packages/effect/SCHEMA.md` and `repos/effect/packages/effect/HTTPAPI.md` for dedicated sub-module guidance.
  - Inspect `repos/effect/packages/effect/src/` and `repos/effect/packages/effect/test/` for real implementations, types, and test patterns instead of guessing or using v3 habits.
- **Local reference usage rules**:
  - Treat `repos/effect/` strictly as **read-only reference material**.
  - **Never import from `repos/effect/`** in application code; always import from official package dependencies (e.g. `import { Schema } from "effect"`).
  - Do not edit files under `repos/effect/` unless explicitly asked.

Host-operation validation must retain an immutable snapshot of request fields
and arguments across asynchronous authorization/journal work, require own
manifest argument declarations, enforce protocol and manifest bounds, and
revalidate the deadline immediately before execution. The Node executor must
re-prove artifact/parent inode identity at execution, spawn a private copy of
the verified bytes rather than the registered path, and kill the operation's
process group at the deadline and when its leader exits. Host operations are
installed as plain manifests in a root-owned tree (see "Distribution Trust
Model"); scripts name their interpreter in the manifest.
On Linux, use `cgroup-v2` supervision (a new session escapes a process group)
and never fall back from it silently. This does not substitute for pinned
shared libraries or destination fencing.

The dashboard terminal (`runtime/terminal*`, `zelavis terminal`, Server → Terminal) is the one
deliberate shell and is not a host operation: it is owner-level (`server.terminal.use`, system
scope), runs inside tmux as the Platform's own unprivileged account with a small fixed
environment (never root, never the Platform's variables), and its sessions belong to the opening
principal. It adds no native dependency and no root escalation; opening and closing are logged,
typed input and output never are. Do not widen it into a command runner for the Agent or recipes.

Agent authority is Ed25519: only the Platform holds the private key, Agents
trust its public file, and envelopes bind the exact arguments
(`argumentsDigest`). The Platform issues authority only through the host
operation broker, for installed operations whose manifest names
the permission and scope, after recording an audit entry; there is no general
command runner. Agents reach operations only over their local socket.
Operation output is journaled only when the manifest declares a bounded
JSON `result`; submissions are rate limited per actor, and audit reads never
return argument values.
`zelavis agent --operations-only` is the protocol boundary for a dedicated
host-operation Agent: it accepts only installed-operation catalog, submit and
status messages, and never opens or reclaims Project process state. Root
provisioning endpoint ownership and installation wiring remain planned; the
combined Project process Agent must not become the root package installer.
The `zelavis/recipe` Effect authoring contract is available. Its manifest
(`zelavis.project.install`) is validated at package load, and the method and software
version are chosen once at creation and locked in the Project, and `@zelavis/wordpress`
runs through it (its recipe is `defineRecipe` phases over `createRecipeProjectRuntime`; the old
hand-written runtime module is gone).
Keep recipe revisions distinct from software versions, lock a named method at
creation, and never use method selection as an automatic start-time fallback.
Recipe upgrades have a zero-downtime goal whatever the recipe change. A running Project
upgrades live when the new recipe keeps its layout: the new plan is reconciled against the
running processes by fingerprint (`core/recipe/plan-diff.ts`, `plan-controller.ts`), so
unchanged processes keep serving, a configuration-only change reloads in place (`config` +
`update` in the plan), and only a process whose launch changed is replaced, in dependency
order; a durable journal (`adapters/_recipe-upgrade.ts`) decides previous/target after a
crash, and any failure rolls back to the previous plan. Not live yet: adopting an earlier recipe's layout (`adopt`) needs the `restart` option (stop, upgrade, start again); a recipe that places data by name (`directories`, read from
`context.directories.named`) upgrades live with the data left where it is and moves it, atomically, at the next start from a stop, a replaced process is covered for public requests by the ingress gate (`ingressReady`: requests wait at the gateway while a launch change replaces a serving process) but a replaced database still pauses what needs it, and new requirements or commands refuse the live path and roll
back. Those are limits, never precedent for a new recipe feature.
Do not claim the JS recipe driver or OCI recipe execution ships until integrated
and qualified. The Node RecipeHost (`adapters/_recipe-host.ts`) and the separate-process
phase runner (`_recipe-phase.ts`, Node permission model, parent re-validates results) exist
with a conformance suite, and WordPress uses them. RecipeHost confines the files and
commands it mediates; it is not a JS sandbox.
Service setup hooks have a deadline; an abandoned setup cannot add services.

Plugin discovery is the ETag-revisioned `/runtime/plugin-operations`
catalogue: clients revalidate every call and never cache past revocation.
Package admission may only run concurrently or enforce a deadline when the
plugin context storage propagates async context; an abandoned package's
context is sealed. Recipe `isolation.resources` limits and required intent may
select another enabled, healthy, executable backend at creation only.

## High-Level Principles

- Prefer extensible architecture, service contracts, and provider boundaries over framework-specific shortcuts.
- Keep the core self-hostable and replaceable.
- Favor explicit contracts over hidden magic.
- Keep core platform concerns split cleanly across auth, data, transport, and UI.
- Avoid app-specific assumptions in shared packages.
- Favor composition and adapters over inheritance.
- Do not introduce heavy dependencies without a clear reason.
- Keep future replication and explicit consistency models possible: prefer deterministic event application, explicit idempotency, stable node identity, tenant-aware boundaries, ownership generations, and adapter-neutral replication contracts over hidden single-node assumptions. Do not imply multi-writer behavior merely because replicas exist.

## Database Architecture Rules

`zelavis/db` is the database. A payload is written once and projected through
document, column, measure, and graph lenses that hold only pointers back to a
shared, partition-local identifier space, so a predicate spanning several data
models is one set intersection rather than an exchange between engines. Its
event log is the source of truth for writes and the replication stream.

One engine holds one shard, and a shard holds many partitions — a tenant, a
part of a divided tenant, or a reserved partition (`zv.global`, `zv.topology`).
Every key a partition writes begins with `[0x01][partition name]`, so a
partition owns one contiguous key range with its own identifiers, its own log
and its own writer, and it can be copied, listed or removed as a range. Only
the shard's writer claim and layout marker live outside the partitions.

Key rules:

- Writes go through the documents API. There is no raw SQL surface and one must
  not be reintroduced: it was the last way to reach storage without the
  guarantees the documents API exists to provide. Being the only door is also
  where the at-most-once guard lives: a write may carry an `idempotencyKey`, and
  its receipt is written in the same transaction as the change, so there is no
  moment where the write has happened and the key has not been noted.
- Storage is an ordered key-value engine. Lenses are key ranges, a posting is a
  key with no value, and a transaction is one atomic batch with reads overlaying
  it. An engine implements `get`, `scan`, `write` and `close`; nothing above it
  knows which engine it is. SQLite (default), libSQL, RocksDB and LMDB ship today; all but SQLite are optional peer dependencies, selected with `engine` when a database is opened. SQLite is the default because it is the only one needing no native build; LMDB is fastest while the working set fits in memory, and RocksDB stores roughly six times more per byte and barely slows when it does not.
- Append to the log before projecting into the lenses. A crash must leave an
  event whose projection can be replayed, never a lens row with no event behind
  it. `rebuildLenses` re-derives every lens from the log alone and is the check
  that this holds.
- Ordered KV store commits must atomically check the shard's writer generation
  and session, and the partition's revision observed before dependent reads.
  Advance the revision with every protected batch, including replication,
  allocation, maintenance and format upgrades. Generation acquisition is conditional and never wraps.
  That conditional commit is the check: a partition handle keeps its revision,
  lens state and fence rather than reading them, or the writer, before every
  write, and a refused or failed commit drops what it kept so the next
  operation reads afresh. A shard store keeps one handle per partition; a
  second writer on the same claim is caught by the revision, never trusted.
  Reject unsupported coordination; do not emulate shared-writer fencing with
  a read followed by an unconditional write. RocksDB's exclusive-file mode
  is local single-process ownership, not concurrent takeover. LMDB batches use
  abortable child transactions: queued transaction callbacks alone can commit
  earlier mutations when the callback throws. Keep current ownership metadata
  through recovery; restoring an old authority snapshot requires a separate
  disaster-recovery protocol.
- A partition admits one writer at a time. Every partition write reads state
  and writes it back changed, so two in flight on an asynchronous engine read
  the same value and one is lost. Writers to different partitions on one shard
  do not wait for each other; the engine applies each batch atomically. Reads
  take no permit. Nothing holding the permit may call another write to the same
  partition, or it waits on itself.
- A record is one value — version, identity, manifest and body — so one read
  is the whole record and no copy of one is torn. Retracting a record leaves
  its version and the log position that retracted it, and every application of
  an event is by version, retracted records included: an event older than what
  is held changes nothing, so a late or repeated event never brings back what
  was removed. `events.follow`/`followAll` additionally keep the leader's log
  positions: a repeated position is compared and skipped, a different event at
  a held position is `ReplicaDiverged`, and a position past the next is
  `EventGap`.
- Identifiers are 48-bit and log positions and counters 64-bit, per partition.
  Each is refused at its limit (`PartitionExhausted` for identifiers), never
  wrapped: a wrapped identifier names a record that already exists.
- Document values, and anything a query compares or orders, use one order: the
  ordered lens's (`compareOrderedValues` in `db/keys.ts`) — booleans, then
  numbers, then strings by code point, then null. Never `localeCompare` or any
  other host order for them, including when sorting in memory: a result sorted
  in memory must match the same result read from an index, on every host.
- A posting is a key in the live tier or a bit in a sealed blob, and a read is
  the live keys united with each value's blobs less that value's tombstones — a
  tombstone cancels only its own value's posting, which matters for a prefix
  that spans several values — and why `terms()` lists a word known only to
  blobs only while some posting survives that word's own tombstones. Blobs are immutable: `db.maintenance`
  seals the live postings into segments of 65536 identifiers, and anything
  removed afterwards leaves a tombstone rather than editing one. So a removal
  path must go through the store's own helpers — deleting a posting key
  directly leaves whatever a blob still claims. Sealing merges rather than
  rebuilds, touching only the segments a live posting or tombstone falls in, so
  the blobs accumulate across seals; `reindexLenses` is what re-derives them
  from the manifests when that accumulation needs checking. After its first
  full sweep a seal reads only the groups marked dirty since, and the same
  helpers write those marks — a posting written around them is never sealed
  until the next reindex. A seal writes each blob before deleting the live keys
  and tombstones it settles, so its batches can be bounded without ever
  leaving a tombstone gone while a blob still claims the posting.
- Every scalar of a document is a column posting unless its collection
  declares `columns`, the fields it queries; then only those (each covering
  the fields below it) are, which is what keeps a wide document from writing
  an index entry per field. Equality, `in`, ranges and single-field order on
  any other field are refused (`UnindexedField`), never run as a scan;
  filters checked per document still work. A reference must read a declared
  field. Changing the columns (`setColumns`) rewrites the collection's
  documents, the way `analyze` does.
- A composite index is a column of the ordered lens whose value is the
  document's tuple, encoded by `orderedTuple` so that string order is tuple
  order; the store knows nothing of it. A document write reads its collection's
  indexes inside its transaction, and a backfill reads each document inside the
  transaction that rewrites it. Both then run under the store's one writer,
  which is the only thing keeping a write from missing an index created
  alongside it and a backfill from overwriting a newer write: never move either
  read out of the transaction.
- A document write checks what it depends on — the id, the version, a
  precondition, a unique value, a check, a reference — inside the transaction
  that writes it (`transactChecked` in `document-core.ts`), never before it: only
  there does the store's one writer keep the answer true until the write
  lands, and a failure there discards the whole batch. Reads inside a
  transaction see committed state, not the transaction's own writes, so a
  change that writes one record twice builds the second write from the first
  (as `releaseReferences` and `linkTargets` do), never from a second read.
- A read that joins two collections answers the named collection's query first
  and turns the ids it returns into an equality union over the referencing
  field's own postings (`relatedFilters` in `document-reads.ts`), so a join stays a
  set operation over the one dense identifier space. Never read the
  referencing collection and filter it in memory, and never let a reference
  the collection does not declare pass as a clause matching everything or
  nothing: that is `UnknownReference`.
- A change that writes more than once in one transaction — a batch, a delete
  cascading or clearing what names it — threads one `Pending` overlay and
  reads every document, id and unique value through it. A transaction sees
  committed state, so a second write built on a fresh read undoes the first,
  and two writes each pass a check the other already answered. Atomicity stops
  at one partition: a transaction writes only its own partition's keys, so two
  tenants that share a shard never commit together, and nothing relies on a
  colocation a move would end. There is no cross-partition write, a scatter
  reads, and a write spanning tenants or parts is a workflow (an orchestrated
  saga with idempotent steps and compensations) — never two-phase commit. For nearly every Tenant the partition is the Tenant. A Tenant
  too large for one Shard may be divided into parts, and then the partition is
  the part: `db.forTenant` refuses a divided Tenant rather than answering for a
  fraction of it, `db.forPart` reaches one, and a question about the whole is a
  scatter over `topology.subdivision.keysOf`. Below routing a part is a Tenant,
  so it keeps the same isolation and local intersection within itself.
- A scan that stops early passes `limit` to `engine.scan` rather than cutting
  the stream with `Stream.take`. A stream pulls an iterable thousands of
  entries at a time, so a take of a few rows still reads thousands; the limit
  is what lets an engine stop at the source. Every engine honours it, and
  `test/db-kv-engines.test.mjs` holds each to the same answers.
- One transaction is one batch, and that is the whole durability story: a
  killed process loses no commit that returned, and a write-ahead log
  truncated by a power cut costs a suffix rather than leaving holes. Upkeep
  runs in batches of bounded size, and an interrupted pass is either a state
  the reader already handles (a seal, a compaction, a snapshot under an id
  nothing names yet) or one the partition refuses: `rebuildLenses` and
  `reindexLenses` run behind a persisted mark, reads and writes fail with
  `LensesRebuilding` until the last batch clears it, and a database finishes an
  interrupted run when it opens (`resumeMaintenance`).
  `test/db-durability.test.mjs` holds the store to all of it by killing real
  processes; anything that makes a write span two batches breaks it.
- A scan of a partition's records begun at log position `p`, followed by the
  events after `p` applied by version, is the partition as of the last of them.
  This holds because records are single values, versions only grow and
  identifiers are never reused, and it is how a copy is taken without stopping
  the writer: `seed` (and with it `db.movement` and `levelFollower`) and
  `snapshot` rely on it. Keep them on it rather than locking the writer for the
  length of a copy. A seed of a source that has compacted writes what it
  copies as the copy's first snapshot too, recorded at the compaction point in
  its last batch, so the copy can still `rebuildLenses`.
- A read of several steps — resolving a query, then reading what it named —
  answers from one snapshot of its shard (`store.reading`; every engine's
  `snapshot`: a read transaction on a second connection for the SQLite
  family, LMDB's read transaction, a RocksDB transaction, an array the memory
  engine never mutates). Document, KV, event, time-series reads and a backup
  export each run in one. Writes, upkeep and the beliefs a partition handle
  keeps (its revision, lens state and fence) never read a snapshot: a stale
  fence kept as current would let a write through that the partition refuses.
  So everything under the writer's permit reads the engine as it is, and so do
  the reads that fill a belief; a snapshot is taken at its first read, never
  later.
- A query reads each clause only up to a cap (`probeCap`, 4096): a clause that
  fits is an exact set; an AND checks its broad clauses per candidate against
  the candidate's manifest, and an ordered read checks a broad `where` per row.
  That check (`holds` and `inRange` in `kv-store.ts`) must give exactly the
  lens's answer — the lens's one order, a one-sided range kept to its bound's
  kind — and `test/db-bounded-evaluation.test.mjs` compares the two.
- A read that stops early — a page after a cursor, or the first matches of an
  unsorted read — resolves with options (`resolve(query, { after, limit })`):
  a window of identifiers at a time, each window the cap rounded down to a
  power of two so it never straddles a sealed segment, jumping to the next
  identifier any posting list holds and stopping once the caller has enough.
  Terms, equalities and edges are one seek per window; ranges and term
  prefixes are checked per candidate. `findPage` in identifier order and
  `findMany` with a limit and no order or search read only what they return.
  A range or term prefix alone has no windowed form; given `within` (a list
  every match is known to be in — documents pass their collection's postings)
  it is driven by that list, each candidate checked, and a read spends at most
  the cap in checks before evaluating the query whole, once: thinly scattered
  matches cost no more than they did. `test/db-windowed-resolve.test.mjs`
  holds the windowed answer to the whole one across window and page sizes.
- The log is the source of truth up to the compaction point, not forever.
  Records are the snapshot, so `db.maintenance` compacts by truncating the log
  — after which storage tracks live objects rather than every write ever
  taken — and drops retracted records whose retraction is behind the cut,
  since nothing can replay an older event for them any more. Anything reading history must therefore
  handle being cut off rather than assume it can reach the beginning: an old
  cursor fails with `CursorCompacted`, `rebuildLenses` refuses with
  `LogCompacted`, and the state-reading equivalents (`reindexLenses` for
  postings, a state-derived export for backups) are what still work.
- The log is the transactional outbox: every write's event is in the batch
  that makes the change. A tenant's event read (and the KV change feed built on
  it) looks at a bounded stretch of the log and returns `{ events, cursor,
  more }`, where `cursor` moves past everything it looked at, matching or not.
  Consumers continue from that cursor, never from the last matching event, or a
  long run of other writes is read again forever. App code that must emit a
  message with a write does it through the same batch: `documents.write({
  emit })` records each message in the tenant's `zv.outbox` records inside the
  transaction that commits the changes, so the message exists exactly when
  they do. `outbox.read` pages the log the same way, skipping messages since
  removed; delivery is at least once, so consumers deduplicate by message id
  and `outbox.remove` what they have handled. A message id the outbox holds is
  refused, never replaced.
- A consumer that writes into the partition whose log it reads commits each
  batch of what it derives together with the cursor that batch reached, in one
  transaction, re-reading its cursor inside it (`txn.allocate` hands out
  identifiers there) — never the derived writes in one transaction and the
  cursor in another, which repeats or skips work when a run is cut off between
  them. A time series does this, and rebuilds into a new generation that
  replaces the one reads use in the same transaction as its last points, so an
  interrupted rebuild leaves the old series whole. A projection's `apply`
  writes outside the store, so it is at least once: it must be idempotent,
  keyed by `eventId`, and a rebuild clears the checkpoint before its reset.
- A partition map carries routing and no data, so changing where an occupied
  range points is a relocation, not a map edit. `db.movement` copies the
  tenant's partition as it is (`seed`, then the source's log by `followAll` at
  the positions it holds there), unfenced, fences writes only for the last
  catch-up, and moves routing last; every step is recorded so an interrupted
  one resumes, carrying the copy on from the target's head — the target's
  positions are the source's — unless its seed never finished (`stats.seeding`,
  set by a seed's first batch and cleared by its last) or the source has
  compacted past that head, when it copies again (`levelFollower`, which also
  copies again a target ahead of or diverging from its source; a pass applies
  a bounded number of batches, so a tenant written faster than it is copied
  ends each round and the fence ends the rounds). Identifiers and positions are the source's own, so edges, event
  cursors and projection checkpoints carry on after a move. The fence is the
  partition's own (`ObjectStoreApi.fence`), never copied, and the store checks
  it under the partition's writer for every change — documents, time series,
  checkpoints, a restore, an allocated identifier — so a change either committed
  before it or is refused, and one last catch-up after fencing is complete. Routing is one record for every tenant in a
  rebalance, so it moves once, after all of them are copied — applying it while
  one was still uncopied would route a tenant to a shard that does not hold it.
  `topology.update` still refuses an occupied range.
- A tenant handle is never bound to a shard. Each operation it runs — every
  store call inside it, nested operations included — goes to the one placement
  routing names as the operation starts (`PartitionRouter.operations`), so a
  handle taken before a move works after it and no operation spans two
  placements: an identifier taken from the source's counter and written on the
  target was never copied, and the next write there could be handed it again.
  An operation holds an in-process lease on its placement until it ends (a
  stream until it is consumed); upkeep visits a partition only where routing
  places it, under one too. After routing moves, a move waits — up to
  `drainTimeout`, then `PlacementInUse` with routing moved and the source
  intact and fenced, for a resume — until no lease on the source is held, then
  drops the source partition whole, fence included: nothing can arrive there
  any more. Leases are in-process because the writer is; a restart holds none.
- A shard's tenants are the partitions holding any key, the reserved
  `zv.`-prefixed ones aside (`tenantsOn`), never a marker some layer has to
  remember to write. A tenant whose collections are gone still holds its log,
  identifier counter and receipts — and maybe time series or messages — and a
  move that left them behind would let it start identifiers and positions over
  under every cursor handed out before.
- Crossing partitions is a separate API, never a fallback. `forTenant` is
  single-partition by construction; `db.scatter` is the only thing that fans
  out, and it reports what each leg cost. A `Seq` names an object only together
  with its partition, so anything crossing that boundary carries both — and a
  query naming a bare identifier, an edge above all, is refused rather than run
  somewhere it means something else.
- A restore says what to do about data already there — refuse, purge, or merge
  — and never guesses. Its label must name the tenant it is restored into, and
  it writes only into that tenant's own partition, so nothing in a backup can
  reach another tenant's records. An empty or purged tenant gets the backup's
  own identifiers back, reserved before anything is written (`reserve`) so
  nothing written meanwhile can take one; a retired record at one only lifts
  the restored versions. A merge, or a tenant where live records hold some of
  them, remaps them, and edges with them. Checkpoints and time-series state
  are positions in the old log, so a backup carries neither. A restore into the
  tenant a backup came from writes into that tenant's own log — a purge's
  retractions, then the backup's records — so its projections and series carry
  on from where they were and end where a rebuild over the whole log ends. A
  purge works a page of records per transaction, never the whole tenant at once.
- A schema version governs what is accepted next, never what is already
  stored: activating one rewrites nothing. `tenant.migrations` is the separate,
  explicit operation that brings stored documents forward, and its instructions
  are data rather than functions — inspectable, and reviewable before they run.
- Locality is declared, not inferred. Everything sharing a `PartitionKey` lives
  on one node, which is what keeps the intersection cheap. Tenant scoping is
  structural — the tenant is the partition, the first part of every key it
  writes — never a predicate a caller can omit, and never something each lens
  has to remember to name.
- Identifiers are dense and partition-local: each partition hands out its own.
  Global identity is `(PartitionKey, Seq)`; a globally unique id, or one shared
  by every tenant on a shard, would make posting sets sparse and destroy scan
  locality.
- Queries are data, not closures. A closure cannot cross a node boundary, so a
  router that accepts one can only ever answer locally.
- `DatabaseCollection.surface` is a first-class field. Use
  `surface: "content-studio"` for Content Studio content types and
  `surface: "database"` for raw database tables. Do not bury `surface` inside
  `metadata`.
- Schemas, projections, time series, events, and system views are all
  Tenant-scoped. A surface reaching them without a Tenant would show one Tenant
  another's definitions.
- Dashboard system views are built from the Tenant APIs, never from storage, so
  a view cannot name a physical table or survive into another Tenant's data.
- Names beginning with `zv` are reserved for Zelavis internals and must be
  rejected as collection names.

Bundle storage keys are authority boundaries. Validate the Project/system
owner, service identity, bundle identifier, storage prefix, and relative asset
path independently before composing a key. Filesystem root containment alone
does not prevent one Project from traversing into another Project's namespace.

System tables are not document collections. Tables such as `zv_collections`,
`zv_events`, `zv_schemas`, `zv_time_series_checkpoints`, and
`zv_time_series_points` are raw internal SQL tables. They are not created
through `createCollection`, are not accessed through `documents.*`, and are not
part of the collection event pipeline. Names beginning with `zv_` are reserved
for Zelavis internals and must be rejected as collection names.

Dashboard system views must be logical, shard-aware capabilities exposed by
`zelavis/db`; they must never select a physical shard's internal table or
raw SQL endpoint. Until those logical views exist, keep physical `zv_*` tables
out of the dashboard entirely.

## Open Protocols And Embeddable Core

The official JS/TS SDK ships as `zelavis/sdk`, `zelavis/sdk/browser`, and
`zelavis/sdk/node`, implemented in `packages/zelavis/src/sdk`. Experimental
Python/Java/C#/Rust generator recipes live under `scripts/sdk-codegen`; these are
not shipped SDKs. Keep generated clients and exported specs local and ignored.
A cross-language SDK does not require a separate repository; choose that only
when independent ownership or release cadence warrants it.

Zelavis should be useful as a full product, as an embeddable library, and as a
set of small composable tools. Prefer open protocols and narrow entry points
over closed product-only integration paths.

Design extension surfaces so they can be used by:

- the dashboard
- the CLI
- browser and native-fetch SDK bundles
- background agents
- MCP servers and clients
- local scripts and software-factory workflows
- cloud-hosted connectors and provider plugins

The package boundary should follow a Unix-like composition rule: small focused
programs and services do one thing well, expose stable contracts, and compose by
calling each other through explicit APIs. The full Platform OS can assemble
those pieces, but the pieces must remain useful without the full dashboard or
host runtime.

`zelavis` should therefore keep a clear embeddable core:

- core contracts, schemas, service definitions, and typed clients stay
  runtime-neutral
- `zelavis/sdk/*` surfaces are SDK/client bundles of Zelavis itself, excluding
  UI and host runtime code
- `zelavis/runtimes/*` surfaces are host utilities for long-running Platform OS
  processes
- adapters provide host, storage, or external-system bindings behind explicit
  subpaths
- plugins add optional capabilities without becoming the platform foundation

Do not make the product shell the only integration point. If a capability is
valuable, it should be reachable through a stable endpoint, embeddable API, or
protocol-facing surface so users can build their own CLI, local agent,
background worker, browser app, native-fetch client, or higher-level factory on
top of Zelavis.

## Endpoint-Backed Capability Rule

Everything Zelavis can do must be reachable through a stable server capability and an endpoint.

### JS, HTTP, and CLI parity

Every official public Zelavis capability must be available through the official
JavaScript SDK, versioned HTTP API, and CLI. No official capability is complete
when it is JS-only, HTTP-only, or CLI-only. When adding or changing a core API,
inspect and update all three surfaces in the same change; existing missing
surfaces are implementation gaps, not precedent for another exception.

- Define one domain operation and shared input/output/error schemas, then adapt
  it to JS, HTTP, and CLI. Keep authorization, validation, defaults, ownership,
  lifecycle, persistence, idempotency, and effects identical for equivalent
  requests. Do not duplicate business logic in transport handlers or commands.
- Service/plugin-owned APIs use the plural `plugins` namespace everywhere:
  `zelavis.plugins.<namespace>.<resource>.<action>(...)`, HTTP
  `/zelavis/api/v1/plugins/<namespace>/<resource>`, and CLI
  `zelavis plugins <namespace> <resource> <action>`. This includes official
  services: UI owns `plugins.ui`, and third-party SEO tools might own
  `plugins.seotool`. Do not use singular `plugin`, root aliases such as
  `zelavis.seotool`, or a parallel private API for first-party services.
- Every executable plugin/service package must explicitly declare
  `zelavis.namespace` in its manifest. Creation templates must include it;
  loaders validate it before evaluating code. Use a stable lower-camel-case
  identifier (letters/digits, starting lowercase); reserved JS protocol names
  are refused. Never infer it from an npm package name. File-only frontends
  need a namespace only if they own an API.
- Namespace ownership is unique within an installation or Project runtime;
  reject collisions explicitly, including collisions with official services.
  The manifest is authoritative: an exported object cannot claim a different
  namespace. Owning an API namespace grants no extra permission or ability to
  impersonate another service. Disabling/uninstalling removes its operations
  with the service lifecycle; independent runtimes have independent registries.
- Core Platform capabilities retain their domain namespaces. SDK authoring
  helpers that declare operations or executable handlers are distinct from
  installed plugin operations; plugins call the same public APIs as other
  clients. Define operations once with a resource/action, HTTP method/path,
  schemas, access requirements and handler so JS and CLI adapt the same HTTP
  contract. Keep frontend page routes separate from plugin API routes.
- HTTP uses resource paths and appropriate methods; JS uses typed methods; CLI
  uses domain/resource subcommands and action verbs, with flags for options.
  Equivalent behavior is required, not identical punctuation. Preserve explicit
  Project/Tenant/service identity and the configured API root in every adapter.
- The SDK and CLI must provide discoverable, typed/documented operations;
  a generic HTTP request escape hatch alone does not satisfy parity. CLI
  operations need a machine-readable output mode and equivalent domain errors.
- Package-loading SDK declarations must map to an explicit capability contract
  with equivalent HTTP and CLI operations. Carry declarative data or artifact
  references, not executable JS closures, across transports. Preserve package
  ownership and cleanup semantics; a remote menu registration must not silently
  become an unrelated global menu or bypass the SDK registration contract.
- Verify equivalent successful results, validation failures, authorization,
  and lifecycle effects across adapters with focused contract tests. Document
  all three forms together, and identify unimplemented forms as gaps rather
  than describing them as shipped.

This is the required direction for public APIs, not a claim that the current
SDK, HTTP routes, and CLI already have full parity. Internal implementation
helpers are not separate public capabilities.

The dashboard is a client of Zelavis, not the source of truth for platform behavior. Any feature exposed in the dashboard must also be available to non-dashboard callers such as the CLI, AI agents, scripts, plugins, external admin tools, and future automation flows.

Endpoint-backed does not mean serverless-first. Zelavis should expose stateless,
HTTP-compatible capability endpoints wherever practical, because that makes the
platform scriptable, MCP-friendly, AI-agent-friendly, and easy to integrate.
Those endpoints are the access layer into Zelavis; they are not a reason to move
the core Zelavis runtime onto serverless function platforms.

Required shape for platform features:

- define the domain capability first, behind a service/runtime contract
- expose that capability through a versioned endpoint under the configured API namespace
- let the dashboard call the same endpoint or typed client surface that other tools can call
- keep dashboard routes, React state, and UI-only handlers out of the authority path
- never implement privileged behavior only as a React route action, component callback, or framework-specific server action

Examples:

- Security checklist: capability `security.runChecklist(...)`, endpoint `POST /zelavis/api/v1/security/checklists/:id/run`, dashboard button calls that endpoint.
- Resource telemetry: capability `resources.getHostMetrics(...)`, endpoint `GET /zelavis/api/v1/resources/host`, dashboard charts render that endpoint data.
- Domain management: capability `domains.addDomain(...)`, endpoint `POST /zelavis/api/v1/domains`, dashboard form calls that endpoint.

This rule keeps Zelavis automatable, scriptable, plugin-friendly, AI-agent-friendly, and independent from any single dashboard framework.

The Zelavis Assistant (the Admin Agent) follows the same rule. Threads,
approvals, provider settings, tools and the audit trail belong to the Platform OS
and System Store, with versioned endpoints under
`/zelavis/api/v1/runtime/assistant`. `@assistant-ui/react` is a dashboard
rendering/runtime library only; it must not own provider credentials, thread
authority, tools, approvals, or privileged actions. Never move that authority
into React or Assistant Cloud. Responders implement the
`ZelavisAssistantResponder` boundary; a model sits behind the thin
`AssistantModel` seam (OpenRouter, OpenAI, Anthropic), and without one the
deterministic local router answers. Rules that hold for every change here:

- **The agent is not a principal.** It borrows the caller's authority. A tool
  call is authorized at execution against the caller's permissions with a scope
  built from that call's own arguments, never from the thread or the prompt;
  advertising a tool is a convenience, not the gate; refusals are structured
  data; the system prompt enforces nothing.
- **Every call is audited** with principal, arguments and decision, redacted
  when written, and a call that cannot be audited does not run. The trail is
  readable at `GET …/assistant/audit` (`server.assistant.audit`) and kept 90 days.
- **Changes are requests a person approves.** Mutating tools never run from a
  model's call: they create a stored approval carrying the validated arguments,
  pinned to the exact target. Approval is a second gate that re-authorizes at
  decision time; the decision is one compare-and-set; irreversible changes need
  the typed id; the approval card focuses nothing.
- **The model and everything it reads are untrusted.** Tool results are bounded
  and redacted; the database tools read one fixed tenant and never identity
  records; the dashboard never loads an image a reply names; prompts, history,
  chats and turns per caller are capped.
- **Providers are per scope.** A Project may bring its own provider and key,
  which answers only that Project's chats and whose tools are confined to that
  Project (what a chat reads goes to the provider its Project chose). Keys are
  encrypted, bound to their scope, never returned or logged, and deleted with
  the Project. There are no custom provider endpoints on purpose.
- Threads are owned by their principal; a foreign thread is `404`, and a
  Project thread also needs the Project's own `project.view` on every touch.

Dashboard menu metadata may include dynamic sections through `dynamicItems`.
Dynamic menu sections must point at service-owned endpoints and return
`{ "items": [...] }`, where each item uses the same shape as static service menu
items. Use this for runtime-owned lists such as
Database tables and Workloads functions, jobs, schedules, and webhooks; do not
hardcode those lists inside the dashboard. Menu items may include `search`
metadata for route state such as the selected database table; dynamic endpoints
should return that state as menu metadata instead of requiring dashboard-specific
sidebar code.
Dynamic sections must also stay route-backed when empty. Use
`dynamicItems.emptyPath` and `dynamicItems.emptySearch` when the empty state
should open a specific route or route state, such as `/workloads/jobs`.
Do not rely on disabled placeholder-only rows for dynamic sections that own a
content area.
Service menu content has two supported shapes: a dashboard-local `path` that
the `@zelavis/ui` router owns, or a `page.file` HTML entry document that the
dashboard renders inside the content area through the service-frame iframe
boundary. If a service or dynamic endpoint forgets to provide a path, the
dashboard derives a stable
dashboard path from the service name and menu trail and renders a structured
placeholder instead of a dead menu item.
`menu.path` is always the dashboard URL. It changes React Router state, sidebar
state, active menu state, and reload/share behavior. `menu.page.file` is the
browser-extension-style HTML entry file for iframe-backed service UI, such as
`dashboard.html`, `settings.html`, or `options.html`. Zelavis serves that file
from the service bundle through the generated service-page-asset endpoint; iframes
must never point at raw filesystem paths. Core services with content already
shipped in `@zelavis/ui` should use `menu.path` without `menu.page`, so the
local dashboard route renders directly and no iframe is mounted.
If a service page wants to be a SPA, the service author owns that SPA's internal
router, tabs, and menu inside the bundled HTML/JS. Zelavis menu metadata selects
the HTML entry file only; it must not deep-link into a plugin SPA's private
routes.

Dashboard menu metadata may declare a `surface`. `platform` is the global
`/zelavis` owner/operator shell, `root` is the first slide of a project
dashboard, `core` is the project Backend slide, `extensions` is the project
Extensions slide, and `settings` is the project Settings slide. Runtime-installed
marketplace services are still constrained to Extensions; privileged surfaces
are for bundled or statically trusted system services. The Access area is a core
`zelavis/core` menu contribution, not a hardcoded sidebar exception.
A menu's `surface` is also the contract for what crosses into a Project. Project
runtimes are headless and carry none of the Platform's packages, so the
dashboard offers each Project the Project-surface menus (`root`, `core`,
`extensions`, `settings`) of the `system`-scope packages the operator composed,
never their `platform` menus, and never anything from an extension package
(whose surface is stripped). Those packages keep their Platform API path; a
Project's own package of the same name wins. Do not add a second manifest field
for this: `selectPlatformProjectServices` in `@zelavis/ui` is the one place the
rule lives.

Dashboard menu items may include `fixed: true` and `fixedOrder` for pinned
actions such as "Add Function". A nested slide may control inherited fixed
actions with `fixedActionScope`: `local` shows only actions declared in the
opened slide, `inherit` combines parent fixed actions with local actions,
`replace` uses local actions as an explicit boundary, and `clear` hides fixed
actions until a deeper slide reintroduces them with its own local or replacement
actions.

## Core Access-Control Rule

Zelavis uses one core principal, permission, and scoped-grant model across the
owner console, project dashboards, future customer/reseller/operator views,
service accounts, CLI calls, scripts, plugins, and AI agents.

Unscoped and system grants authorize runtime-wide routes. Project and service
grants require the same explicit route identity and never satisfy an unscoped
requirement; top-level principal permissions express authority spanning scopes.
An isolated Project Gateway child translates signed audience-bound permissions
into local authority. Do not relax root scope matching for child administration,
or infer Platform host-code installation authority from a Project grant.

The base authorization contract belongs in `zelavis/core`, because every
runtime service route needs to declare and enforce access requirements
independently of the authentication method that produced the caller.

`zelavis/app/identity` owns authentication primitives: accounts, credentials,
sessions, roles and permissions. It ships the credential ceremonies whose
dangerous parts are generic and identical for every provider — password
verification and its timing, and the state, nonce and PKCE custody an OAuth
redirect flow depends on — so they are written and audited once. It resolves
identities into principals; the server contract enforces route access.

Identity guarantees hold under concurrency, so they live in the repository, not
in a check made first. Email, username and `(provider, identifier)` are unique
because a repository claims each value with an atomic create-if-absent before it
writes the entity, and a loser gets `IdentityConflictError` (a claim with no
entity behind it is recovered only after a grace period, never while its creator
may be between its two writes). A session token is usable for rotation exactly
once: rotation consumes the old session with an atomic transition before issuing
the next. Revoke-all bumps the account's `sessionEpoch` atomically and a session
is valid only while its epoch matches, so nothing issued or rotated at the same
moment survives it. Any new identity repository must implement `mutate` and the
claim primitives and pass `test/identity-atomicity.test.mjs`.

What is vendor-specific stays a plugin. A credential provider declares
`zelavis/identity:credentials` and owns its whole exchange; an OAuth provider
declares `zelavis/identity:oauth` and supplies only endpoints and claim mapping.
Any OpenID Connect issuer needs neither: pasting its issuer URL is enough,
because the issuer publishes its own endpoints.

Future official modules such as Hosting Provider must not create a separate
customer permission system. Customers, resellers, operators, and owners are
Zelavis principals with system, project, or service-scoped grants. The same
`/zelavis` shell should render different menus, project lists, and actions from
those grants, while endpoints remain the authority layer.

## Repo Structure

- `packages/*` contains core platform workspace packages.
- `zelavis-services/*` is a pnpm workspace of the officially maintained services
  (apps, plugins, frontends) that are published separately and are not shipped
  with the Platform.
- `packages/zelavis` is the unified framework and Platform OS package. Do not
  recreate the retired pre-consolidation server, App, core-service, or
  Marketplace package boundaries.
- `packages/zelavis/src/core` owns reusable service and endpoint contracts, Web
  routing, access enforcement, runtime lifecycle, and generic
  Fabric/workload/Agent/runtime-driver machinery. It is exported through
  focused `zelavis/*` subpaths and does not own product menus or root authority.
- `pnotes/` is the ignored, separate private repository holding one file,
  `pnotes/TODO.md`: the maintained private roadmap, decisions and open work
  (keep design context only where it supports unfinished work; do not turn it
  into a release history, audit log or completed-work archive). Never stage or publish its contents in the main
  repository, and never make public documentation checks or CI depend on it.
- When available, update `pnotes/TODO.md` (its checkbox sections, such as
  "Platform, Fabric and Agents" or "Cleanup list") when a core, App-versioning,
  or Fabric capability changes state; never mark an exported contract as
  operational behavior before its implementation exists.
- Keep that roadmap current in the same change, never afterwards. Remove
  completed items and their progress/validation history so the TODO shrinks;
  do not retain checked-off entries or add a Done section. Preserve unfinished
  follow-ups as concise open items, including any limits the work uncovered.
  Completed behavior belongs in tests, maintained documentation and Git history.
  Revisit nearby stale entries rather than leaving finished work marked open.
- `packages/zelavis/src/app` owns the built-in App stack exported as `zelavis/app`
  (identity primitives and Project-scoped workloads; the document-first database
  is `zelavis/db`). The official Project recipe itself is the `@zelavis/app`
  package in `packages/zelavis/services/zelavis-app`. The stack consumes the same core implementation and must never grow private server
  contracts or a private dispatcher.
- `packages/zelavis/src/platform` owns trusted product-specific control-plane
  and Marketplace services.
- `packages/zelavis/services/zelavis-ui` is the Fuzor dashboard (`@zelavis/ui`) the runtime package ships; `zelavis-ui-legacy` is the former React dashboard, kept only as reference.
- `packages/zelavis/src/adapters` holds the host, runtime and storage adapters
  (Node, Bun, Agent, Project runtimes), exported through `zelavis/adapters/*`
  subpaths.
- `zelavis-services/*` contains the officially maintained optional services:
  capability and provider plugins (including Auth methods), and Project recipes
  such as WordPress. They are published to npm on their own release cycle and are
  not bundled with the Platform. They reach an installation through the
  marketplace allow-list (see "Marketplace Allow-List"); in a repository checkout
  `pnpm dev` offers them from this folder instead of npm. Do not place installable service packages inside
  `packages/zelavis`; the unified package exports contracts and the built-in App
  services, not installable package source.
- `examples/*` contains runnable example workspace packages.
- `website/` contains the public Astro Starlight documentation site (`website/src/content/docs/`).
- `distribution/` owns the bootstrap installer, release staging for the deferred
  Debian package, runtime pins, host operation sources and operating-system service
  files.

All delivery formats must be assembled from the published `zelavis` package and
one common release tree. OS packages may bundle a pinned,
private Node runtime, but must not introduce a second Platform implementation or
install over the host's global Node runtime. Keep generated release trees,
download caches, and artifacts out of Git.

Native release installation is host-local too: the shell installer and create
bootstrap call `zelavis install --from-npm`, and a Debian `postinst` calls
`zelavis install --from-release`, using the release's private Node. Keep the ordered plan in core runtime and concrete host operations in
adapters; unit/configuration templates come from the release tree, and runtime
pins/checksums remain in distribution staging. Native Platform management listeners bind to `127.0.0.1` by default; `--public` explicitly exposes that listener. A default system installation enables Traefik on ports 80 and 443, publishes a canonical HTTP fallback to the persistent management listener, and prints `http://<server-ip>/zelavis/`. A hostname is optional for HTTP; HTTPS requires hostname/certificate configuration. Refuse foreign owners of public ports. Live updates honor persisted listener configuration and retain the host/proxy processes. Do not add compatibility aliases or version branches.
npm/pnpm/Bun create use the same bootstrap and plan. Create takes no folder
argument. Its sudo bootstrap fetches its own Node and package into a private
root-owned temporary directory; never execute a file from a user package cache as
root. User mode keeps data/config/releases under
`~/.local/share/zelavis` and owns only that prefix and its command link. Runtime
pins/checksum helpers have one source in distribution; package assets are generated
at build time. Install/removal take an exclusive prefix lock and share the Node/Bun Platform
data ownership guard; `--force` cannot bypass live data or port conflicts. Current
receipts carry source, entry, version, mode, selected instance, port and Edge ownership. Doctor is
read-only and host-local. Named Linux/systemd instances share immutable releases
but own separate current links, receipts, runtime descriptors, data/config, accounts,
ports and units. Only default owns host Edge, with a persistent record and kernel
reservation; secondary instances must run with Edge off. Instance removal retains
shared releases/commands/templates/package state while other receipts remain.
Debian packages own only the incoming `/opt/zelavis/package` payload; persistent
release trees and current links belong to the installer, so a package manager cannot
remove an older release selected by another instance.
Never add an installation or removal HTTP/dashboard route. Updating is the one narrow
exception, and it is a request, not an installer: `GET|POST /runtime/updates*`
(`system.updates.view|manage`, SDK `client.updates`, CLI `zelavis update`) lets the
unprivileged Platform check npm and drop `<data>/update/request.json`, and a root-owned
`zelavis-update.path`/`.service` pair runs `zelavis update --run` (host-local, root only).
The updater never trusts the request's contents: it resolves the newest version on the
running version's channel from npm itself, refuses anything not newer, runs the installer
embedded in the installed release, health-checks the new release and rolls back to the
previous one on failure. Keep it that way: no version, path or command may come from the
request file, and anything the updater owns must be in the uninstall inventory.
An update has two phases: prepare (`install.sh --stage-only` acquires an immutable
engine beside the running one) and handover (the new release's installer with
`--live` invokes the persistent host and acknowledges root-owned inventory).
Admission drains accepted requests before exclusive store ownership moves, and
queued requests resume only after readiness, Project adoption and inventory commit.
The Platform host, separately supervised Project Agent and preview listeners stay
running. systemd also holds the dashboard socket across host crashes. Named
instances own their update units, runtime hosts, custody and inventory. User-mode
installs run the same updater as the same user and use the same handover.
A full installer run is maintenance and may restart the Platform. An installation
without the handover protocol requires that one-time conversion; live updates
refuse unsupported protocols instead of retaining a compatibility execution path.
Product requirement: every future release, including major runtime, protocol or
installation-layout changes, must be installable through the dashboard's
**Update now** action. Requiring terminal commands or an installer rerun for a
normal update is an update UX defect, not an acceptable release procedure. Plan
the installed updater's evolution before shipping architectural changes, perform
required host changes through its existing trusted authority, and qualify the
complete update from the previously installed release through the ordinary
update action. Preserve data, Project locks, access URLs and rollback guarantees.
The current pre-handover manual conversion is a known gap to eliminate; do not
use it as precedent for future releases or add permanent legacy runtime paths.
The release gate `pnpm release:qualify:update` starts from the actual previous npm
release in disposable Linux/systemd and qualifies the packed candidate with
continuous dashboard/App/WordPress traffic. `pnpm release:qualify:conversion` also
starts directly from alpha.39, the last pre-survival Agent, until that conversion
is retired. Both run with 2 CPUs and 4 GiB rather than the Mac's full resources.
`pnpm release:qualify:history` qualifies a
server with a history: apps made by old releases (`distribution/history.json`: a
hand-written WordPress from alpha.25, a contract-1 DokuWiki from alpha.29), opened so
their integration hosts start, carried by live updates (never the installer) through the
previous release onto the candidate, a recipe left only listed, then every recipe
upgrade under traffic with zero failed requests, and exactly one of each process after a
Platform restart. Each release keeps the allow-list it shipped with there. When a release
changes host, runtime or recipe-layout behaviour, add it to `via`. Before publication only acquisition
is substituted; after publication qualify the ordinary authenticated update API
with real npm acquisition. Candidate Node pins are read from JSON before its code
runs. Live root commit refreshes the selected release's authored unit templates
and daemon-reloads without restarting the host or Project Agent; rollback
restores the previous templates.

New system installations always enable their separate Project Agent. No optional
Agent flag remains. Never prune qualified engines needed for Project selection,
Agent execution or another instance.

Complete native installation removal is a host-local lifecycle capability, not
a Platform HTTP/dashboard operation. Its runtime-neutral contract belongs in
core runtime, concrete filesystem/process/package behavior belongs in the host
adapter and distribution, and the packaged CLI is the operator surface. Require
an inspectable dry run plus the exact destructive acknowledgement before
removing anything. Remove only state whose installer ownership can be proved:
Platform/Agent units, package records, command links, release trees, Zelavis
data/config/trust, repository configuration, and a safely identified dedicated
account. Retain shared host packages, journal history, external archives and
backups, and operator-managed proxy/firewall/DNS/TLS state. Never add a remote
complete-wipe route: the operation destroys the authority and server that would
authorize it. Plain npm/source copies without a current installer receipt use their originating
lifecycle. Receipted package/create installs use the shared removal inventory,
including prefix `.install.lock`, public runtime descriptors, named instance
directories/templates, incoming Debian payload, host `edge-owner.json`/`.edge-owner.lock`, and data
`.platform.lock`/`.platform-owner.json`, `runtime-control.sock`, `runtime-custody.json`,
`runtime-handover.json` and its kernel guard, `.runtime-owner.sqlite`, runtime engine
and development Agent state, and Linux Project `runtime-sockets`. Whenever
an installer starts owning another resource, update the complete-uninstall
inventory, staged program, isolated destructive-path tests, and public docs in
the same change.

The worker role (`zelavis install --role worker`, Linux/systemd/root only) is a
second, deliberately smaller installation role: the release tree, a dedicated
`zelavis-worker` account, `zelavis-worker.service` and `zelavis-worker.path`, and data
in `<data>-worker`. It shares the installation receipt (`<prefix>/installation.json`,
`schemaVersion: 3`) with the Platform role, told apart by `role`: a machine is a
Platform or a worker by construction, every reader chooses by role first
(`readInstallationRoleProgram`), and each role's reader refuses the other's receipt. One
role-aware uninstaller (`adapters/_node-installation-uninstaller.ts`) plans each role's
own inventory. The worker plan carries no enrollment credential; `zelavis worker join`
runs as the worker account. Its inventory is in
`core/runtime/worker-installation-plan.ts` and is qualified by
`distribution/scripts/qualify-worker.sh` (Docker, Debian/systemd); update that inventory,
the staged release assets and the docs together whenever the worker installer owns
another resource.

Each package should remain independently useful and focused.

## Current Important Runtime Facts

- The main public runtime entry point is `new Zelavis(...)`; `zelavis()` is an internal/low-level composition function.
- Public docs and examples should name the local `Zelavis` instance `zv`.
- The default dashboard root path is `/zelavis`.
- Opening `/zelavis` shows the endpoint-backed Projects overview. Project-local dashboard pages live under `/zelavis/projects/:projectId/*` and proxy project API calls to that project's isolated runtime.
- Project runtimes do not host private or secondary dashboards. The one Platform `@zelavis/ui` shell renders project menus fetched from project services through the project proxy.
- Global dashboard areas such as `/zelavis/marketplace` and `/zelavis/server/*` sit outside any project. Project-local marketplace/plugins live under `/zelavis/projects/:projectId/marketplace`.
- Server-level dashboard routes include `/zelavis/server/domains`, `/zelavis/server/backups`, and `/zelavis/server/logs`.
- Projects may represent Zelavis-native apps or managed apps such as WordPress/static/generic projects. Managed app projects should show hosting-style controls instead of Zelavis-native Auth/Database/Content plugin navigation. A recipe declares itself a managed app in `package.json` under `zelavis.project.managed` (`adminTitle`, `adminPath`), locked with the recipe; the dashboard renders that and must not recognise any recipe by name.
- The runtime supports dashboard dev-server mode through `ZELAVIS_UI_DEV_SERVER` or `frontend.devServerUrl`. The `coreServices` option it used to live under is gone: Platform subsystems are `subsystems` on `zelavis(...)`, the frontend options are the public `frontend` option, and the settings store is `runtimeSettingsStore`.
- The main local platform workflow is `pnpm dev`.
- In repository development through `pnpm dev`, runtime state lives below
  `packages/zelavis/.zelavis`: the Platform System Store is under `system/` and
  isolated project directories are under `projects/<projectId>/`.
- `pnpm dev` builds the unified `zelavis` runtime and bundled Platform services,
  then starts both the long-running runtime and React Router dashboard dev
  server.
- That dev flow starts:
  - the Zelavis runtime on `http://127.0.0.1:3000`
  - the UI dev server on `http://127.0.0.1:3001`
  - dashboard requests to `/zelavis` are redirected to the live UI dev server

## Package Design Guidance

When creating or extending packages:

- Start from the domain model and the public API.
- Define interfaces for infrastructure concerns such as storage, payments, queues, or external providers.
- Ship an in-memory or local-development implementation when it improves usability or testability.
- Keep provider adapters behind plugin or adapter boundaries.
- Make defaults simple, but keep escape hatches available.
- Preserve a clear distinction between what exists today and what is only planned.

Use these boundaries consistently:

- `adapters` for framework bindings and external runtime adapters such as Express, Hono, or Node-specific mounting
- `plugins` for optional domain/provider capabilities such as OAuth providers or payment gateways, each declaring the capability of the service it extends

First-party core plugins such as `zelavis/app/workloads` may be enabled by default
by the high-level runtime while staying package-separated. Workloads are
project-scoped capabilities owned by the long-running Zelavis server. Provider
plugins may later sync or deploy workloads to Cloudflare, Vercel, Netlify, or
other external platforms when users choose that, but those providers must not
become the core workload execution architecture.

### New package checklist

When creating a new core package, service package, or plugin package:

1. Put the real definition in one obvious named top-level file under `src/`.
   - service package examples:
     - `src/auth-service.ts`
     - `src/database-service.ts`
   - plugin package examples:
     - `src/ecommerce-plugin.ts`
     - `src/stripe-plugin.ts`
2. Keep `src/index.ts` small and make it re-export the named definition file.
3. Use plain `ZelavisRuntimeService` object literals for mounted runtime services.
4. Use `package.json` manifest (`"zelavis": { "kind": "plugin" }`) and the official Zelavis SDK (`zelavis.plugins.ui.menus.create`, `zelavis.routes.create`, etc.) for plugins. `defineService` is removed. Plugin and service packages must register menus through `zelavis.plugins.ui.menus.create`; exported `menu`/`menus` fields are rejected. Runtime `menus` is the complete SDK registration list, and `menu` is its primary catalogue entry, so consumers must not concatenate them.
5. Keep orchestration helpers only when they add real behavior.
   - good: `authService(...)` because it creates Auth and registers explicit auth-method plugins
   - bad: pass-through aliases that only rename another function
6. Update the package README so it points directly to the named definition file.
7. Add or update tests around the real definition entrypoint, not only convenience wrappers.
8. Do not hide the main definition in nested files like `src/server/service.ts` or `src/core/define-plugin.ts` unless there is a strong reason and the user explicitly wants that shape.

### For core platform work

- Treat auth, database, server/runtime composition, and admin UX as the primary building blocks.
- Keep service APIs mountable through shared server contracts so packages compose cleanly.
- Keep storage, auth methods, and future provider adapters replaceable.
- Document current limitations clearly when functionality is placeholder or in progress.

### For ecommerce-specific work

- Treat customers, products, orders, coupons, payments, and plugins as core building blocks.
- Keep payment providers such as Stripe or PayPal behind provider contracts.
- Keep storage behind repository-style contracts so Prisma, Drizzle, SQL, or custom adapters can be added without rewriting the core.
- Optimize for embeddability inside apps, CMS systems, and larger commerce platforms.

## UI Package Rules

**The dashboard is the Fuzor dashboard**, `packages/zelavis/services/zelavis-ui` (`@zelavis/ui`), decided by
the owner 2026-10-15 and cut over the same day. **All new dashboard UI is built there, natively**: a new
page, control or flow is never another React route. Fuzor owns its routing and compiled server views.
Effect v4 remains mandatory for new asynchronous compiler/client/server/dashboard orchestration.

- **The dashboard is entirely native.** Every route is a Fuzor page: a screen in `app/screens.ts` or a module it
  calls (`app/dashboard-routes.ts` lists them, and the route parity test visits each at desktop and mobile
  sizes). Pages are built from the small DOM builders in `app/dom.ts` and `app/page-kit.ts`; a page with live
  state (the terminal, the media gallery, the schema builder, the Assistant conversation, the rich text and code
  editors) is a `fuzor-island` whose module owns its state and cleans up with the page. **React is used only
  where a library needs it**: the Glide Data Grid. Everything else, including Lexical (without its React
  bindings) and CodeMirror, is plain DOM.
- **The former React Router dashboard** is `packages/zelavis/services/zelavis-ui-legacy`
  (`@zelavis/ui-legacy`): private, never loaded by a Platform, never published, and no longer part of the
  dashboard's build. It stays only as the reference for what the new dashboard might lack. Do not fix, extend
  or depend on it; a feature found there that is missing here is built here.
- **Fuzor comes from the owner's checkout when one exists** (`FUZOR_DIR`, default `../fuzor` beside this
  repository) and otherwise from the pinned npm release, so the owner always builds against the Fuzor on
  disk while CI and other contributors use the exact published one. Every build rebuilds a stale checkout
  (`scripts/fuzor-source.mjs`) and records which Fuzor it used in `.fuzor/fuzor-build.json`. Fuzor is
  published to npm by the owner on its own cadence; the `fuzor` pin here moves only to a published
  version, and a feature Zelavis needs from Fuzor is added to Fuzor first (the owner allows patching it).
- **The build is mount-independent.** It is compiled against the placeholder root `/__zelavis__`
  (`app/mount.ts`) and the frontend adapter (`src/mount-rewrite.ts`) replaces it with the Platform's
  `rootPath` as it serves (assets, the server entry's requests and responses). Dashboard code takes the
  mount from `app/mount.ts` and never writes `/zelavis` or `/api/v1` literally. The dashboard calls
  `v1` of the Platform it is mounted on.
- **Nothing is installed beside the shipped dashboard.** The server entry is bundled so it imports only
  `effect` (which the Platform provides) and Node; the build refuses output that imports anything else.
  The dashboard's server code calls the Platform in-process through the frontend context's `fetch`, never
  over a guessed address.
- Draft recovery is bounded tab-local storage partitioned by opaque session, Project, Tenant and table;
  retain original record versions, surface storage failures, clear saved/discarded entries and
  sign-out journals, and never journal authentication/provider credentials. See
  `.agents/skills/zelavis-dashboard-ui/SKILL.md` for the workflow. Service pages keep extension frames
  opaque and broker requests only within the owner's namespace through the exact Project proxy, with
  bounded requests and scoped cleanup. A new iframe document cannot inherit the old grant. Schema/typed
  record editors use public codecs and existing database operations; schema journals stay separate from
  record journals and retain source versions. Wildcard routes must leave asset and script/style
  requests to asset serving.
- **Qualification** is `pnpm run ci:ui` (also part of `release:check`): the Fuzor package's browser
  suites start throwaway Platforms and check the first-owner and login gates, the embedded production
  bundle at its mount, every route at desktop and mobile sizes, the update banner, representative actions
  (create, upload, edit, save, run) and the three grid libraries. Keep it green; a new page adds its pattern to
  `app/dashboard-routes.ts`. `PARITY_SHOTS=<dir>` makes the parity run save a screenshot of the main pages.

Dashboard rules (they hold for every page of `@zelavis/ui`):

- The sidebar uses a slide-based navigation model; treat each slide as a distinct panel. Its menus are
  built natively from what the Platform reports (`app/navigation-menu.ts`: registered service menus,
  capabilities, content types, tables, workloads) and filtered by what the signed-in principal may use.
- Below the desktop breakpoint (`lg`) the sidebar is the whole app shell. Compose pages from small modules
  that work at every size; do not build separate desktop-only and mobile-only versions of a feature.
- Do not add title blocks that repeat the breadcrumb, sidebar slide title, or active navigation item.
  Content should start with the actual workspace, table, form, chart, or contextual controls unless the page
  needs a title for a genuinely distinct object or focused editor.
- Content Studio routes must create collections with `surface: "content-studio"` as a top-level field.
- Database routes that create raw tables must use `surface: "database"`.
- Content Studio sidebar sections show only `surface: "content-studio"` collections and label them as
  Collections. Core Database sidebar sections show all registered collections, label raw collection
  entries as Tables, and keep system tables in a distinct System Tables area.

**Data loading**: a page is a screen function that reads what it needs from the Platform's endpoints with
Effect when it is drawn (never ad hoc in an event handler's callbacks), and an action runs through
`context.run`, which reports failures and refreshes the page. A page with live state is a `fuzor-island`.

**URL state & reconstructability**:
- Everything that can survive a reload must be in the URL (`context.setSearch`). Filters, tabs, the selected
  record, the open panel and the form values a link may carry belong in the query string.
- Every navigation step and sidebar slide depth must be reflected in the URL (`pathname` + `?sidebar=...`).
  Sharing or reloading a URL must reconstruct the exact same sidebar slide depth and active content area.

**Menu items and content area rules**:
- **Rule 1 (Always Change Content)**: Clicking any menu item or slide **MUST** update the URL and change the content area to its own dedicated page or panel. Even parent items with nested child items must land on an Overview page/route of that section when opened.
- **Rule 2 (No Empty/Missing Content)**: If a specific domain feature is not yet built or is planned, a structured placeholder page/panel **MUST** still be rendered. A menu item must never be without content or act as a dead click.
- **Rule 3 (Back Button Synchronization)**: Clicking the Back button on any sidebar slide must navigate both the sidebar slide and the content area back to the corresponding parent route and update the URL.
- **Rule 4 (URL State Reconstructability)**: Every navigation step and sidebar slide depth must be reflected in the URL (`pathname` + `?sidebar=...`). Sharing or reloading a URL must reconstruct the exact same sidebar slide depth and active content area.

When working on UI behavior:

- Treat the dashboard as one client of Zelavis endpoints. Do not put platform-only behavior in route components, local React state, or dashboard-only actions.
- Prefer `pnpm dev` for end-to-end runtime and dashboard iteration.
- Use `pnpm --filter @zelavis/ui typecheck`, `build` and `test` to validate UI-only changes, and `pnpm run ci:ui` for the browser suites.
- Preserve the existing design language unless the task explicitly asks for redesign.

## Generated and Sensitive Files

Treat these carefully:

- `packages/*/dist/*` is build output.
- `website/.astro/*` and `website/dist/*` are generated site output.

Do not manually edit generated files unless the user explicitly asks for it and the generating source cannot reasonably be changed instead.

## Verification

- **Verify from the repository root, never from a package.** `pnpm run verify`
  is the command: it builds every shippable workspace project, typechecks all of
  them, and runs the tests. A package-scoped `pnpm run build` proves only that
  the package still compiles against itself — it says nothing about the plugins,
  services, and examples that consume it, which is exactly where a change to a
  shared API breaks something. Root verification takes seconds; there is no
  version of "too slow to bother" that justifies skipping it.
- **Build and typecheck are not the same check.** Some packages build through a
  bundler that never runs `tsc`, so a type error can survive a green build and
  be caught only by `pnpm run typecheck`. Run both, which is what `verify` does.
- **Select workspace projects by exclusion, not inclusion.** Scripts that name
  the projects they cover go stale the moment someone adds one, and the gap is
  invisible — the command still succeeds, having quietly checked less. Prefer
  `pnpm -r --if-present <script>` with `--filter '!<name>'` for the few
  deliberate exceptions, so a new package is covered by default.
- Dashboard behavior is proven in a real browser: `pnpm run ci:ui` (also `ci:ui:local`) builds the dashboard bundle
  first (the embedded and parity suites test that built bundle, never the dev server) and then runs the Fuzor
  dashboard's browser suites against throwaway Platforms, including the embedded production bundle at its
  mount on desktop and mobile sizes. The suites pick free ports and stop only the processes they started;
  never make an e2e script claim a fixed port or kill by port or command line, because that can take down
  a running dev server. Run `pnpm run docs:check` after docs changes.
- Check `pnpm-workspace.yaml` when adding a project. A directory that is not a
  workspace package is invisible to every root command, whatever its scripts say.

## Code Change Expectations

- Make the smallest coherent change that moves the repo forward.
- **No backward compatibility.** This project is pre-release with no public users. Remove stale shapes and legacy paths outright — do not add shims, fallbacks, or "legacy support" branches. If something needs to change, change it cleanly.
- Update docs when public API or architecture changes.
- Add or update tests when a test setup exists.
- If there is no test coverage yet, keep code easy to validate and call out the gap.

## Git and PR Workflow

- The `main` branch is protected and does not allow direct pushes.
- Changes must be pushed to a branch and merged through a pull request.
- `dev` is the long-lived branch for everyday work; it is merged into `main` from
  time to time through a pull request, and CI must be green first.
  **Merge `dev` into `main` with a merge commit (`gh pr merge --merge`), never a
  squash or a rebase.** Pull requests are otherwise squash-merged, and a squashed
  `dev` leaves `main` holding one new commit that `dev` does not contain, so the
  two diverge and the next pull request carries the old commits again. A merge commit
  keeps `dev` an ancestor of `main`, so afterwards `git merge origin/main` on `dev`
  is a fast-forward. When something lands on `main` any other way, run
  `git merge origin/main` on `dev` before continuing.
- Short feature branches go off `dev` or `main` and are squash-merged as usual.
- Do not assume GitHub app or automation credentials can open PRs automatically; if that fails, leave the branch pushed and provide the PR URL to the user.

## Releasing

When the owner asks for a release ("release", "release a new alpha", "publish a new version",
"cut a stable release"), follow the runbook in
`.agents/skills/zelavis-release-maintainer/SKILL.md` step by step, from step 1. It names every
command, what only the owner does (npm login and 2FA, approving pushes and deploys), and what
must be green before anything is published. Do not ask the owner to explain the procedure.

Publishing the allow-list to zelavis.com is part of every release, never optional and never
only "when services changed": after the npm publish, run `pnpm allowlist publish`, ask the owner
to approve the website deploy, and deploy it. A release is not finished until
`https://zelavis.com/allowlist.json` serves the shipped snapshot's `sequence`; report it as
unfinished until then.

## Documentation Expectations

- Each package should have a focused README with purpose, scope, and basic usage.
- Public docs in `website/src/content/docs/` should describe Zelavis as an in-progress self-hostable App Platform, not as a generic utilities repo.
- Document extension points and adapter boundaries.
- Be explicit about what is implemented today versus roadmap direction.
- Avoid vague marketing language.

## Guidance for Coding Agents

When acting as an agent in this repo:

- Be concise.
- Prefer implementing changes over only suggesting them.
- Explain tradeoffs when they materially affect architecture or maintenance.
- Prefer repo-consistent patterns over inventing new abstractions.
- Do not add compatibility aliases, legacy shims, or stale fallback behavior unless the user explicitly wants them.
- For UI tasks, remember that the runtime and UI may run separately in dev and together in production.
- If something looks generated, verify before editing.

## Runtime Independence Rule

Zelavis core must only depend on the JavaScript language and standard platform APIs.

Node.js is the current supported production host runtime. Bun has an adapter
(`zelavis/adapters/bun`) and its services model and Project database are proven
under real Bun; Project runtime processes, the Agent, the WordPress recipe and
Edge are not yet proven there. Core contracts stay runtime-neutral so Bun,
future Deno, OCI, and stronger project-runtime drivers can be added without
changing the project lifecycle model.
Serverless function platforms are not Zelavis runtime targets. They may appear as
optional plugins for deploying user websites, storage, email, images, DNS, CDN,
or other provider adapters, but must not define the core runtime
architecture.

Stateless protocols and connector standards such as MCP are welcome at the
edges of the platform. A Zelavis MCP server, deploy-provider connector, storage
connector, or AI integration may be stateless and may run on serverless or edge
infrastructure when that makes sense. The distinction is strict: connectors and
plugins may be serverless; the Zelavis platform runtime, database, auth,
dashboard, local website hosting, server management, and future replication
model must not be architected around serverless hosting constraints.

This repo must not be architected around:

- Node.js APIs
- Bun APIs
- Deno APIs
- provider-specific APIs
- framework-specific request/response models
- hosting provider SDKs or platform lock-in

Allowed foundation:

- ECMAScript / TypeScript
- standard Web platform primitives such as `Request`, `Response`, `Headers`, `URL`, streams, and `crypto` where standard

Required architecture rule:

- host/framework/provider-specific behavior must live only in `adapters/*` or equivalent adapter boundaries
- core packages must remain portable and runtime-neutral
- Zelavis must never require a specific JS runtime, hosting provider, or framework as its architectural base

Project preview ingress belongs to Zelavis Edge (`edge.previews` in the System
Store), not a Project runtime URL. The Node host binds a stable HTTP port per
local top-level Project using the Platform's listen host; a stop closes it and
Project deletion removes its intent. Site links combine that port with the
browser's dashboard hostname. Preserve visitor Host, site cookies and redirects
through native host transport, withhold Platform cookies and authority, and
require the same browser origin for cookie-authenticated changes. Ports do not
isolate cookies. Remote placements cannot publish a local preview of another
Node's loopback target.

Exact native App engine selection is available through dashboard **Zelavis
version** / **Manage version**, `client.projects.versions(id?)` /
`switchVersion(id, version)`, `/runtime/project-versions` /
`/runtime/projects/:id/versions` / POST `/runtime/projects/:id/version`, and
`zelavis projects versions` / `switch-version --engine-version`. Select only
qualified installed exact versions and freeze that engine's matching bundled
App recipe. Parent updates preserve App selections. Source copies and drivers
without independent engines report why selection is unavailable. Preserve
Project grants, durable update recovery, deletion precedence and data-format
checks before writable ownership.
