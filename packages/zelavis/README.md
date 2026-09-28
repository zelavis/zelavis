# zelavis

`zelavis` is the Platform OS package for the Zelavis App Platform.

It owns the long-running control plane, dashboard composition, System Store,
service lifecycle, official product services, and server/project orchestration.
Local service sources qualify as host-managed only when both their named paths
and resolved physical targets remain inside configured managed directories.
Package discovery also checks entry and manifest targets against their package
root. Internal symlinks are supported; arbitrary filesystem imports require the
explicit filesystem source policy. Managed files must remain under host control
while code is loaded; these checks do not sandbox executable plugins.
Lower-level packages such as `zelavis/core`, `zelavis/app/db`, and
`zelavis/app/identity` remain independently useful primitives.

`zelavis/core` owns reusable Fabric, workload, Agent, service, routing, and
access primitives. The bundled `zelavis/platform` service grants those primitives
Platform authority and owns the Server dashboard surface. The bundled
`zelavis/marketplace` and `@zelavis/ui` services add the product Marketplace
and dashboard. This assembly, plus official Project recipes such as
`zelavis/app`, is what makes the reusable server framework the Zelavis
Platform OS.

The Platform OS creates projects from services with `kind: "app"`. With the
Node adapter, every project receives its own data directory and long-running
Node process. The driver provides operational isolation for trusted projects
and can later be replaced by an OCI or stronger isolation driver without
changing the project API.

Platform records use a separate System Store. Node and Bun local adapters
default to `.zelavis/system/zelavis.sqlite`; project data remains in the project
database and is never exposed through that store.

The Platform does not mount `zelavis/app/db` as a global application database by
default. Node process projects live under `.zelavis/projects/<projectId>`; each
has one logical App database routed across physical SQLite shards below
`.zelavis/data/primary/shards` and private topology/runtime metadata at
`.zelavis/runtime/zelavis.sqlite` relative to its project directory. The
official local topology starts with 1024 virtual ranges grouped into four
physical shards on one Node. There is no implicit `default` project.

Project lifecycle endpoints are available under
`/zelavis/api/v1/runtime/projects`. The dashboard uses these same endpoints to
create, list, start, and stop projects, and project dashboard API traffic is
proxied to the selected project's runtime.

The local Project Gateway also supplies the scoped Platform principal used by
trusted dashboard administration routes. Direct calls to a child runtime do
not inherit Platform authority, and Auth account, credential, and session
administration requires the `project.users.manage` permission.

Fresh Platform installations require an explicit one-time bootstrap token
before the first owner can be created. Configure it with
`ZELAVIS_BOOTSTRAP_TOKEN` or `new Zelavis({ bootstrap: { token } })`, and install
an auth plugin that supports credential enrollment. The dashboard then uses
the normal `/zelavis/api/v1/auth/*` endpoints for bootstrap, login, session
rotation, and logout; `/runtime/access` never fabricates a demo owner.
The first browser visit opens the `@zelavis/ui` setup wizard; operators can run
the same guided flow with `zelavis setup`, while automation uses
`zelavis bootstrap --password-stdin`. All three claim the same durable
first-owner bootstrap operation.

Access grants with a Project or service scope match only routes declaring the
same explicit identity. Unscoped and system grants match runtime-wide routes;
top-level principal permissions express authority spanning scopes. Project Auth
instances created with `projectId` use that scope on administrative routes.
The Gateway translates verified, audience-bound authority into concrete local
permissions in the isolated child; a Project grant cannot delegate Platform
host-code installation authority.

Public runtime configuration, service/extension listings, and recipe catalogues
share service identity fields and omit acquisition specifiers. Private registry
state retains those references for activation; public discovery does not expose
local package filenames or source URL credentials.
Administrators with `system.services.manage` can inspect those references using
`client.runtime.serviceSources()`, `GET /zelavis/api/v1/runtime/services/sources`,
or `zelavis services sources --url http://localhost:3000/zelavis --token <session-token>`.
The CLI emits JSON and the HTTP response uses `Cache-Control: no-store`.

The System Store atomically claims first-owner bootstrap, so competing Platform
writers cannot create two owners. Authentication failures use bounded durable
attempt state and privacy-safe security events; administrators can inspect the
audit stream and revoke individual or all account sessions without exposing
stored token hashes.

Credential recovery is provider-owned and endpoint-backed under
`/zelavis/api/v1/auth/recovery/*`. Password plugins can opt into expiring,
hashed one-time recovery tokens with an operator-supplied delivery callback;
successful recovery revokes the account's active sessions.

SQLite-compatible App drivers serialize top-level write transactions and
enforce unique event-stream revisions. Raw `sql.execute()` accepts one
statement and refuses direct or trigger-mediated mutation of registered
collection tables, including mutations hidden behind comments or CTEs. Shared bundle storage
validates every scope component before composing its key so a service bundle
cannot traverse into another Project's namespace.

The Platform OS also owns Assistant threads. `createAssistantManager(...)`
stores project-scoped conversations in the System Store and delegates replies
to a `ZelavisAssistantResponder`. The default `zelavis-local-router` provides a
small deterministic development responder. It is not an LLM and does not run
tools. Applications can replace it through
`new Zelavis({ assistant: responder })`, while clients use stable endpoints under
`/zelavis/api/v1/runtime/assistant`.

Only the Platform OS mounts `@zelavis/ui`. A Zelavis App project process is headless:
it serves its application APIs plus `zelavis/core` runtime metadata, but no
dashboard shell or dashboard assets. The Platform dashboard uses the project
proxy to read that metadata and render the Zelavis App services' own menu declarations.

Project recipes are services with `kind: "app"`; their optional Project
metadata declares runtime compatibility. The selected recipe is locked into the Project record and
owns its setup behavior, menu metadata, and app-facing runtime services through
the shared service contract. A `kind: "plugin"` service extends the Platform
without being something a Project can be created from.

The built-in `zelavis/wordpress` recipe provisions a native, Dockerless
WordPress Project. It downloads the exact WordPress release locked in the
Project, generates private database credentials and `wp-config.php` salts, and
runs dedicated Nginx, PHP-FPM, and MariaDB instances with Project-owned
configuration, sockets, ports, logs, site files, and database data. The Zelavis
Debian package installs the native stack as package dependencies. Archive and
npm installations provision it through APT or Homebrew on first use when the
Zelavis process has host-package authority; otherwise preparation fails with an
actionable dependency error instead of silently falling back to SQLite or a
shared database.
WordPress remains a managed app with hosting-style controls; it does not mount
Zelavis App database/auth/content services. Maintainers can refresh the recipe
pin from the official WordPress version API with:

```bash
pnpm --filter zelavis update:wordpress
```

The recipe is intentionally independent of its native execution strategy so a
future OCI driver can run the same Project kind without changing the creation
API or dashboard model.

Project records nevertheless own an explicit runtime assignment. Current App
recipes and the local driver advertise only `native`; server policy selects the
assignment for a new Project, and a request-level `docker` override is rejected
before Zelavis claims the Project ID. A future Docker capability can therefore
be enabled without changing existing Projects or silently migrating them.

Deployment backend policy is server-owned. Administrators can inspect it under
`/zelavis/server/runtimes` or through
`GET /zelavis/api/v1/runtime/deployment-backends`. The Node adapter currently
reports Zelavis Native plus a read-only Docker probe. Native is the enabled
default; Docker cannot be enabled until a Docker Project driver and privileged
Agent path exist. Ordinary Project creation does not accept a backend override.

A Project recipe may declare isolation intent under
`zelavis.project.isolation`: a minimum `boundary` (`process`, `os-container`,
or `microvm`), `filesystem`, `process` and `network` requirements, and
`resources` ceilings (`cpuMillicores`, `memoryMiB`, `pids`, `diskMiB`, each
`{ limit, enforcement }`), each `required` or `advisory`. Backends advertise
per-resource `resourceControls`. The intent is validated when the
package loads (unknown keys are refused) and locked with the exact recipe
version. Only a backend capability reported as `available` satisfies a
dimension; `planned` does not. A `required` shortfall refuses creation before
the Project ID is claimed (HTTP 409, `ZelavisProjectIsolationError`) and
refuses start and restart; Zelavis never falls back to weaker isolation. When
the default backend falls short of a required item, creation selects the first
other backend in the administrator's enabled order that is healthy, executable
and satisfies it; existing Projects are never moved. Advisory shortfalls are
reported in the Project record's
`isolation` assessment. The assessment compares advertised capability, not
enforcement proof; no shipped backend currently advertises hardened isolation,
so required intent is refused everywhere today. The refusal body carries
`code: "project.isolation.unsatisfied"` and the `isolation` assessment.

Projects are reachable through all three surfaces with the same routes:
`GET|POST /zelavis/api/v1/runtime/projects`, `GET|DELETE .../projects/:id`,
`POST .../projects/:id/start|stop|restart`, `GET .../projects/:id/logs` and
`GET .../runtime/project-recipes`; `createZelavisClient().projects.*` from
`zelavis/sdk`; and `zelavis projects <list|recipes|get|create|start|stop|restart|logs|remove> [--json]`.

Plugin operation discovery is `GET /zelavis/api/v1/runtime/plugin-operations`,
revisioned by an ETag with `cache-control: no-cache`. The SDK revalidates on
every plugin call (revocation stays immediate) and receives a bodyless 304
while the catalogue is unchanged; the catalogue is about 165 bytes per
operation. Package loading under the Node and Bun adapters uses
`AsyncLocalStorage` context: up to eight packages load concurrently, each with
a 30-second admission deadline (`admissionTimeoutMs`), and a package that
misses it is refused and sealed so later registrations throw. Without async
context propagation, loads stay serialized with no deadline. Service setup
hooks each have a 60-second deadline (`setupTimeoutMs`); a timeout fails
composition naming the service and refuses its later `addService` calls.

The current native driver is still intended for trusted applications on local
or small self-hosted installations. Its capability report does not claim
hardened filesystem, process, network, or resource isolation. The planned
production-native backend adds per-Project Unix identities, Linux namespace/
filesystem views, cgroup v2 limits, systemd supervision, and policy confinement
behind a separately supervised Agent.

Deployment backends are centralized under `zelavis/backends`, with built-in
`native` and `docker` adapters and a shared registry/policy contract. That
subpath is runtime-neutral: detection reads through injected
`ZelavisBackendHostProbes`, which the Node adapter supplies. Lifecycle calls
that carry only a Project ID route by the stored backend assignment and refuse
a missing or malformed one instead of assuming native. The
`zelavis/agent` surface provides stable Agent identity, operation-bound signed
authority, and a durable lease-based operation journal. Agent records can be
read through `/zelavis/api/v1/runtime/agent`. There is no general
command-submission endpoint: only installed, release-signed operations can be
requested, under the policy their signed manifest declares (see below). Host-operation validation returns an
immutable request/argument snapshot retained by the journal and executor.
Arguments require own manifest declarations, at most 64 entries, names up to
64 characters, values up to 16,384 characters without NUL bytes, and a JSON
UTF-8 envelope up to 65,536 bytes. These are protocol ceilings; manifest limits
can be tighter. The executor rechecks the deadline after authorization and
artifact reading, immediately before spawning. At execution it re-proves that
the operation root, every parent and the artifact are still the registered
inodes with the same owner and safe modes, reads the bytes through a no-follow
handle, and spawns a private 0500 copy of those verified bytes from a 0700
staging directory (`stagingDirectory`, default the OS temp directory) rather
than the registered path. Operations must be installed with a release-signed
manifest (`<root>/<id>/<version>/manifest.json` beside `artifact`,
`loadInstalledHostOperations`): Ed25519 over canonical JSON, verified against
the operator's trust store (`trust`: keys with validity windows; rotation by
overlapping windows; `revokedKeyIds` invalidates everything a key signed).
Scripts must name their interpreter in the signed manifest; a shebang without
one is refused, and the interpreter and its directories are identity-proven
like the artifact. Each operation runs in its own process group, which
is killed at the deadline (`timedOut: true`) and when the operation's leader
exits; output is abandoned 250 ms after the leader is gone, so a descendant
holding the pipes cannot extend an operation. A descendant that starts a new
session escapes the group and keeps running (verified). On Linux,
`supervision: { kind: "cgroup-v2", root, limits }` runs each operation in its
own cgroup below a delegated subtree: a join shell enters the cgroup before
`exec`, `cgroup.kill` reaches every descendant, optional `memory.max`/`pids.max`
apply, and leftover operation cgroups from a crashed Agent are killed and
removed at startup. It refuses to start rather than fall back when the host is
not Linux, the hierarchy is not cgroup v2, `cgroup.kill` is missing, or the
subtree is not delegated. Shared libraries of an interpreter are not pinned,
and destination ownership is not enforced.

`zelavis agent --operations-root <dir> --operation-trust <file> --platform-authority <file>`
assembles them in the separately supervised Agent: installed signed operations,
the executor and a durable SQLite journal under `<data>/agent-operations`. The
Agent socket accepts `operation.catalog`, `operation.submit` and
`operation.get`. Each request carries a short-lived envelope signed with the
Platform's Ed25519 authority key and bound to the Agent, operation, version,
artifact digest, Project, actor and an `argumentsDigest`
(`hostOperationArgumentsDigest`), so it authorizes exactly one argument set.
The Agent verifies it against `--platform-authority`, a public trust file it
re-reads for every request (a missing file refuses everything; a rotated key
needs no restart). The Platform keeps the private key in
`<data>/system/agent-authority/signing-keys.json` (0600) and publishes
`platform-authority.json` beside it; keys are valid 365 days and rotate 30 days
before expiry with overlap.

A manifest's signed `authorization: { permission, scope: "project" | "system" }`
decides who may request it; an operation without one cannot be requested.
With an Agent configured, the Platform exposes that as
`GET /zelavis/api/v1/runtime/host-operations` (what the caller may request),
`POST .../host-operations` (`{ operation, version?, projectId?, arguments,
deadlineMs? }`, 202) and `GET .../host-operations/:operationId`, and the same
through `client.hostOperations.catalog|submit|get` and
`zelavis host-operations catalog|submit|get [--json]`. The broker checks the
caller's permission for the manifest's scope with the core grant rules, applies
the Agent's argument validation before signing, and records an audit entry
(actor, operation, Project, argument names and digest, never values) before the
Agent sees the request. Status is readable by the requester or anyone who could
request the operation for that scope; others get 404. Without an Agent the
routes return 503.

A manifest may declare `result: { format: "json", maxBytes }` (≤ 65,536). Then,
and only then, stdout must be one JSON object within that size; it is kept in
the journal and returned as `agent.result`, and anything else fails the
operation with `resultError`. Undeclared output is never stored. Submissions
are limited per actor (default 30 per minute, burst 10; `rateLimit` on
`createHostOperationBroker`) after authorization, answering 429 with
`Retry-After`. `GET .../host-operations/audit?projectId=&limit=`
(`client.hostOperations.audit`, `zelavis host-operations audit`) lists issuance
records newest first and needs `server.host-operations.audit`, or
`project.host-operations.audit` for a Project; it reads the whole audit
namespace, so pagination is a known gap. Custom route `authorize` hooks do not
apply to host operations: their policy is the signed manifest plus core grants.

The release ships one operation, `zelavis.host-report` v1: a read-only `/bin/sh`
report (OS, kernel, architecture, CPUs, memory, root filesystem free space,
cgroup mode, `cgroup.kill`, KVM device and access, WSL) with no arguments,
requiring `server.host.report` at system scope. It is included only in builds
signed with a release key listed in `release.json`.
`--operation-cgroup delegated` moves the Agent into an `agent/` leaf of its
systemd-delegated cgroup and contains operations under `operations/`, with
`--operation-pids-max` and `--operation-memory-max`; `--require-root-owned-operations`
enforces root ownership of the trust store, tree and interpreters. `zelavis
serve` uses an Agent when `ZELAVIS_AGENT_ENDPOINT` is set. The packaged
`zelavis-agent.service` is installed but not enabled, and no operations or
release keys ship yet.

The dashboard opens to Projects. Project-local Zelavis surfaces live under
`/zelavis/projects/:projectId/*`, global app/server discovery lives under
`/zelavis/marketplace`, global management routes live outside projects, and
server-owned operation routes live under `/zelavis/server/*`. Server scaling
and placement operations live under `/zelavis/server/fabric/*`, backed by
versioned endpoints under `/zelavis/api/v1/fabric/*`.

The dashboard is a client of the runtime, not the source of truth. Any operation
available in the dashboard should also be exposed through a stable runtime
capability and versioned endpoint so CLI tools, AI agents, scripts, plugins, and
external admin clients can perform the same work.

## Install and run

Developers who already manage Node 24 can install the public package directly:

```bash
npm install --global zelavis
zelavis serve
```

Production archives and operating-system packages carry a private pinned Node
runtime, so they do not require or modify the server's global Node installation.
The public command is the same in every delivery format. By default it listens
on `127.0.0.1:3000`, stores Platform state in `.zelavis`, and serves the
dashboard at `/zelavis`.

```bash
zelavis serve --host 0.0.0.0 --port 3000 --data-dir /var/lib/zelavis
zelavis services list
```

See the public installation guide for APT, direct `.deb`, archive, and quick
installer workflows.

Native packaged installations also expose a host-local complete-removal flow:

```bash
sudo zelavis uninstall --all --dry-run
sudo zelavis uninstall --all --confirm DELETE-ALL-ZELAVIS-DATA
```

The runtime-neutral `ZelavisInstallationUninstaller` contract is exported from
`zelavis/runtime`; Node hosts use `createNodeInstallationUninstaller` from
`zelavis/adapters/node`. This capability intentionally has no Platform HTTP
route: it deletes the Platform, Agent, authority material, all Projects and all
Zelavis-owned host state. npm and source installations are refused because
their package manager or development workflow owns their lifecycle.

Local Project recovery is data-safe across the pre-release App Data Fabric
rewrite. When a Project still has the retired single-file App database, Zelavis
replays its event source of truth through the persisted Tenant shard topology,
records durable migration completion, and leaves the original SQLite file in
place as a recovery artifact. Startup stops instead of guessing if both the old
and new layouts already contain unrelated data.

## Entry point preference

Use the package in this order:

1. `new Zelavis(...)` for application/runtime code
2. scoped packages like `zelavis/core` when you are building primitives, tests, or custom infrastructure

The class is the safe batteries-included API. The lower-level `zelavis(...)` function exists for internal runtime composition and is not the public application convention.

## Import split

Use `Zelavis` for application and runtime code:

```ts
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { createNodeServer } from "zelavis/runtimes/node";

const zv = new Zelavis({ adapter: nodeAdapter() });
const server = await createNodeServer(zv);
```

Examples use `zv` as the short local name for a `Zelavis` runtime instance.

Or embed the runtime directly in a Web/fetch environment:

```ts
import { Zelavis } from "zelavis";

const zv = new Zelavis({});

export function GET(request: Request) {
  return zv.fetch(request);
}
```

Use scoped packages when building lower-level primitives, adapters, services, or tests that need direct package APIs:

```ts
import { zelavis } from "zelavis/sdk";
import { authService } from "zelavis/app/identity";
```

Plugins are standard npm packages configured via `package.json` manifests (`"type": "module"`, `"exports"`, and `"zelavis": { "kind": "plugin" }`).
Plugin code uses the official Zelavis SDK:

```ts
import { zelavis } from "zelavis/sdk";

zelavis.plugins.ui.menus.create({
  title: "Ecommerce",
  path: "/commerce",
});

zelavis.routes.create({
  id: "commerce.products.list",
  method: "GET",
  path: "/products",
  handler: async () => ({ status: 200, body: [] }),
});
```

Service loading stays pure ESM. Zelavis exposes helpers such as
`loadPluginPackage(...)`, `loadService(...)`, `loadServiceRegistry(...)`, `resolveServiceModule(...)`,
and `removeServiceFromRegistry(...)` so install/load/remove flows stay inside
standard JavaScript module semantics instead of Node-specific loaders.

For runtime composition, Zelavis supports a service registry option with real
install state and activation order:

```ts
import { createServiceRegistry, Zelavis } from "zelavis";

const ecommerce = {
  name: "@zelavis/ecommerce",
  kind: "plugin",
  capabilities: ["api:routes", "dashboard:menu"],
  menu: {
    title: "Ecommerce",
    path: "/commerce",
  },
};

const zv = new Zelavis({
  services: {
    entries: createServiceRegistry([
      {
        service: ecommerce,
        status: "installed",
        source: "official",
        order: 0,
      },
    ]),
  },
});
```

Service setup receives standard JavaScript data only:

- mounted `rootPath`
- API path information
- platform summary (`presets`, resource availability, metadata)
- already collected runtime services plus `addService(...)`

That keeps service setup runtime-neutral while still giving services enough
context to register extra runtime routes.

The lower-level `zelavis(...)` function owns internal runtime controls such as
direct `runtimeServices` or path/mount overrides. Public application examples
should use `new Zelavis(...)`.

## Usage

```ts
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { createNodeServer } from "zelavis/runtimes/node";

const zv = new Zelavis({ adapter: nodeAdapter() });
const server = await createNodeServer(zv);

server.listen(3000);
```

When you do not need the standalone Node HTTP server, use the Web-style runtime
handler directly:

```ts
const zv = new Zelavis({});

const response = await zv.fetch(
  new Request("http://localhost/zelavis/api/v1/runtime/config"),
);
```

`new Zelavis(...)` is the guarded high-level entrypoint. It accepts app-facing options such as adapters, root path, service registry state, and error handling. Internal runtime knobs like direct `runtimeServices` and path overrides stay on the lower-level `zelavis(...)` function.

That split is intentional:

- the class is for real application code
- the function is for internal/runtime-facing work

Application code can use the core services through the runtime instance:

```ts
const tenantDb = zv.db.forTenant("tenant_acme");

await tenantDb.documents.createCollection({ name: "posts" });

const doc = await tenantDb.documents.insert({
  collection: "posts",
  data: { title: "Hello", published: false },
});

await tenantDb.documents.update({
  collection: "posts",
  id: doc.id,
  data: { published: true },
  mode: "merge",
});
```

Database administration stays logical too. `zv.db.systemViews` exposes
collections, events, schemas, projections, and time-series definitions without
revealing physical shard drivers or internal `zv_*` tables. `zv.db.backups`
exports and restores a Tenant's schema and exact event history; the matching
maintenance endpoints require `database.inspect`, `database.backup`, or
`database.restore` permissions.

Indexed numeric document fields must be finite. Inserts, updates, and atomic
batches reject `NaN`, `Infinity`, and `-Infinity` with `InvalidDocumentValue`,
including the collection and field path, before recording an idempotency
receipt. HTTP writes return `400`. SDK and CLI JSON requests reject non-finite
numbers before serialization can silently turn them into `null`.

Reopening a database also opens shards needed by unfinished Tenant moves,
including source shards no longer present in the current partition map.
`db.movement.resume` finishes pending work; a move whose routing already changed
cleans up its source without copying the target again.

Node hosts can persist content-addressed runtime objects with
`createNodeFileArtifactStore({ directory })` from `zelavis/adapters/node`.
Writes verify their SHA-256 key, existing objects remain immutable, and reads
fail on on-disk corruption.

By default, Zelavis owns one safe namespace:

```txt
/zelavis
/zelavis/marketplace
/zelavis/projects/:projectId
/zelavis/projects/:projectId/marketplace
/zelavis/projects/:projectId/settings
/zelavis/server
/zelavis/server/domains
/zelavis/server/backups
/zelavis/server/logs
/zelavis/projects/:projectId/workloads
/zelavis/api/v1/runtime/config
/zelavis/api/v1/runtime/settings
/zelavis/api/v1/runtime/assistant/threads
/zelavis/api/v1/runtime/assistant/threads/:threadId/messages
/zelavis/api/v1/auth
/zelavis/api/v1/database
/zelavis/api/v1/storage/files/*
/zelavis/api/v1/website/pages
/zelavis/api/v1/workloads/*
```

Customize that namespace with `rootPath`:

```ts
const zv = new Zelavis({
  rootPath: "/admin",
});
```

That moves the dashboard and APIs together:

```txt
/admin
/admin/marketplace
/admin/projects/:projectId
/admin/projects/:projectId/marketplace
/admin/projects/:projectId/settings
/admin/server
/admin/server/domains
/admin/server/backups
/admin/server/logs
/admin/projects/:projectId/workloads
/admin/api/v1/runtime/config
/admin/api/v1/runtime/settings
/admin/api/v1/auth
/admin/api/v1/database
/admin/api/v1/storage/files/*
/admin/api/v1/website/pages
/admin/api/v1/workloads/*
```

The dashboard itself is supplied by the `@zelavis/ui` service. The `zelavis`
runtime only wires the service into the service graph and exposes the runtime API
state it needs.

Services can also ship full web apps through the `app` field:

```ts
export default {
  name: "@acme/storefront",
  kind: "plugin",
  capabilities: ["web:app", "api:routes"],
  app: {
    mount: "/",
    mode: "spa",
    bundle: "dist",
    domainPolicy: "optional",
  },
});
```

Apps declare their serving shape and domain policy, not concrete hostnames.
Verified domain bindings live in runtime state. Workspace apps with
`domainPolicy: "optional"` fall back to `/apps/<service-name>` when no verified
domain exists; apps with `domainPolicy: "required"` are not served until a
verified binding exists.

This is also the boundary for optional external deployment providers. Zelavis
can host websites itself from the local runtime; provider adapters such as
external static hosts, DNS, CDN, object storage, image storage, or email belong
in plugins and should not redefine where the Zelavis runtime itself lives.

The main package keeps one adapter layer: **runtime adapters**
(`zelavis/adapters/*`). These describe the self-hosted JavaScript runtime
Zelavis runs on and supply System Store, database, file storage, service package,
and project-runtime defaults.

Framework-specific mounting helpers are not part of the main Platform OS
surface. Long-running hosts should use `zelavis/runtimes/node` for the bundled
Node HTTP server or call `zv.fetch(request)` from fetch-native code.

Available runtime adapters:

```txt
zelavis/adapters/node
zelavis/adapters/bun
```

Node.js is the current supported production host. Bun remains an adapter target
while its full platform and project-runtime suite is completed; Deno is a
planned adapter target.

Available host utilities:

```txt
zelavis/runtimes/node          createNodeServer(zv)
zelavis/runtimes/bun           bun marker
zelavis/runtimes/deno          deno marker
```

Runtime host utilities are separate subpath exports. Import only the runtime
subpath you need so bundlers can drop code for the other host runtimes.

## Database writer commits

Ordered KV engines expose `conditionalWrite(writes, conditions)` alongside their
raw atomic batch. Each condition binds a binary key to its observed bytes, or
explicit absence. The engine checks every condition and commits the batch in one
destination operation; rejection returns `false` and changes nothing. Engines
without conditional commits and a declared coordination scope refuse writable
store activation. `claimGeneration(engine)` returns `{ generation, session }`;
`storeOverKv(partition, engine, claim)` requires that complete claim, while
`openStoreOverKv(partition, engine)` performs activation and format preparation.

Store activation claims a fresh writer session and increments the persisted
generation atomically. Every store batch checks generation, session, and the
revision read before building the operation, then advances that revision in the
same commit. This covers events, lenses, document receipts, identifier allocation,
replication application, format upgrades, and maintenance. A superseded session
fails with `WriterFenced`; competing changes under the same claim fail with
`StoreError` (`op: "store.conflict"`). Retry the complete operation after a clean
conflict, never its previously built batch. Document checks and their Pending
overlay remain within that operation; transactions remain shard-local.

| Engine | Conditional commit and coordination |
| --- | --- |
| Memory | Synchronous checks and batch within the same engine instance. |
| Node SQLite / local libSQL | Checks and writes inside `BEGIN IMMEDIATE`; independent local connections and SQLite processes are tested on macOS. Embedded replica/server configurations need separate qualification. |
| LMDB | Checks and writes inside an abortable child transaction; local independent connections and process takeover are tested. Queued ordinary transaction callbacks alone do not guarantee rollback on callback failure. |
| RocksDB bindings | Native exclusive process/file ownership plus a scoped permit around checks and batches. The evaluated binding shares permits across local handles for the same resolved directory. Concurrent process owners, shared filesystems, and remote takeover are unsupported. |
| libSQL client | Dedicated write transaction with batched condition reads and mutations. Independent connections are tested using its local file transport; production network servers are not qualified by those tests. |

Existing four-byte generations are read and atomically widened to eight bytes at
activation, preserving document/event bytes and cursor interpretation. Generations
remain safe integer numbers and activation refuses exhaustion at
`Number.MAX_SAFE_INTEGER` or malformed state. Older binaries must not reopen a
widened store. Recovery must retain the current generation/session metadata;
restoring an old authority snapshot is not a supported takeover procedure.

Opening an engine does not acquire a store writer claim. Writable store activation
is a trusted low-level operation that supersedes prior store sessions; it does not
implement authenticated Fabric placement, renewable ownership leases, distributed
failover, backup rollback protection, or stronger acknowledgement durability.
Direct raw-engine access remains trusted and must not bypass the store in App code.

## Project runtime lifecycle

The built-in Node project runtime is the dependable single-host mode used by
local development and smaller self-hosted installations. Each running project
is a separate Node process, but the Platform process owns those children. On
startup, desired-running projects are reconciled in the background one at a
time by default, so Platform readiness does not trigger an unbounded process
storm or wait for the whole project fleet. Operators can raise the bounded
limit when the host has enough capacity:

```ts
const zv = new Zelavis({
  adapter: nodeAdapter({
    projects: {
      startupConcurrency: 4,
      shutdownConcurrency: 8,
    },
  }),
});
```

Call `await zv.close()` during host shutdown. It stops startup reconciliation,
waits for in-flight lifecycle work, asks owned project processes to terminate,
and escalates an individual child to `SIGKILL` when it does not exit after its
grace period. The bundled `zelavis serve` command and Node development example
already combine this with graceful HTTP server shutdown. `close()` is
idempotent.

This process-owned driver deliberately reports
`runtimeOwnership: "platform-process"` and
`survivesControlPlaneRestart: false`. That is
not the intended Zelavis Cloud failure model. At production fleet scale,
project runtimes should be owned by separately supervised Zelavis Agents. The
Platform Fabric remains the global decision maker; each Agent executes
authenticated placement and lifecycle commands through a runtime driver such
as Node process or future rootless OCI. Such a driver reports
`runtimeOwnership: "zelavis-agent"` and
`survivesControlPlaneRestart: true`; stopping or restarting the control plane
does not stop customer apps. Zelavis stays unified at the API, desired-state,
access, and dashboard layers without making every app share the control
plane's process lifetime.

The current local System Store lists projects as a single collection. A cloud
driver with thousands or millions of projects must add paginated discovery,
durable reconciliation queues, leases or fencing, placement, and per-node rate
limits rather than using the local in-memory child-process map as a scheduler.

Deleting a Project is also reconciled lifecycle work. Zelavis first persists a
deletion tombstone, stops the runtime, removes Project-owned Assistant threads,
domain bindings and bundle assets, then destroys the runtime directory and
finally removes the Project record. A failed step leaves the Project visible as
pending deletion; retrying deletion or restarting the Platform resumes from the
last durably completed cleanup participant.

## SDK bundle surfaces

The official SDK is a bundle surface of Zelavis itself, not a separate client
architecture. SDK entry points reuse the portable app contracts and database
core, but intentionally exclude:

- the dashboard UI service
- long-running host runtime utilities
- Node, Bun, and future Deno adapters
- server/project process orchestration

Available SDK entry points:

```txt
zelavis/sdk                  fetch-native SDK core
zelavis/sdk/browser          browser SDK surface
zelavis/sdk/node             Node SDK surface using native fetch
```

Use the browser SDK when code should talk to a running Zelavis Platform OS
without importing host runtime code:

```ts
import {
  createBrowserZelavisClient,
  createDatabase,
} from "zelavis/sdk/browser";

const client = createBrowserZelavisClient({
  baseUrl: "https://example.com",
});

const config = await client.runtime.config();
```

The SDK also re-exports the runtime-neutral `zelavis/app/db` and
`zelavis/app/identity` core APIs. Today that enables in-memory local development.
Future browser storage adapters such as IndexedDB and SQLite WASM should attach
to the same database driver boundary instead of creating a separate browser DB
model.

SDK builds can be checked without building the dashboard or host runtimes:

```sh
pnpm --filter zelavis build:sdk
pnpm --filter zelavis build:sdk:browser
pnpm --filter zelavis build:sdk:node
```

At the workspace root, the same commands are available as:

```sh
pnpm build:sdk
pnpm build:sdk:browser
pnpm build:sdk:node
```

These scripts compile only the selected SDK source entry and its imports. They
are the current enforcement point for keeping browser and native-fetch SDK
surfaces separate from UI, host runtimes, and local server adapters.

Runtime resources now also feed real core-service persistence in the high-level `Zelavis` class:

- dashboard settings persist through the Platform System Store, or through a configured KV resource in runtimes without a System Store
- the storage core service can expose local file storage through the Zelavis API
- website pages can persist through local files when no database core service is configured

The dashboard settings endpoint exposes runtime-editable dashboard preferences:

```txt
GET /zelavis/api/v1/runtime/settings
PATCH /zelavis/api/v1/runtime/settings
```

The dashboard service registry also has runtime endpoints:

```txt
GET /zelavis/api/v1/runtime/services
POST /zelavis/api/v1/runtime/services
PATCH /zelavis/api/v1/runtime/services/:name
GET /zelavis/api/v1/runtime/service-page-assets/:service/:bundle/*
```

When a service registry store is configured, these endpoints read and update
real install state instead of a hardcoded list. Dashboard metadata updates
immediately, while service activation is runtime-controlled: a local runtime can
recompose its service graph when supported, or require a process restart when
live activation is unavailable. Runtime config exposes the current adapter's
service activation capabilities so the dashboard can show whether uploaded
specifiers, runtime installs, and isolated execution are actually supported.

Registry stores implement `read()`, `readSnapshot()` and
`compareAndSet(revision, entries)`. A snapshot carries an opaque revision;
`null` means absence. Mutations retry at most eight clean conflicts, reading
again and reapplying the requested change each time. Exhaustion returns HTTP
409 through the existing service endpoints and CLI; the fetch SDK reaches the
same endpoints through `client.json`. Storage errors and unknown write outcomes
are not automatically retried. Startup rejects unreadable or malformed registry
state. Existing `{ services: [...] }` documents remain readable; successful
updates retain source references and unknown fields and add a fresh revision
nonce. No database or file migration is required.

File-backed registries call `requireFileStorageGuarantees` before authoritative
access. The gate requires declared conditional-create and conditional-replace
scope, then probes actual behavior. Successful checks belong to one adapter
configuration/session; errors invalidate the registry's cached check. Create a
new adapter (or replace its capability descriptor) when configuration changes.
S3 adapter options are captured at construction. Writes always use `ifAbsent`
or the observed `ifMatch` etag, including after conflicts.

| Adapter | Registry guarantee and verified scope |
| --- | --- |
| In-memory registry/System Store | Conditional mutations within one process; no persistence. |
| Node SQLite System Store | Atomic conditional mutations across local connections/processes and reopen, tested on macOS. |
| Bun SQLite System Store | Conditional mutations across independent local connections, tested with Bun 1.3.4 on macOS. |
| Local files | Conditional creation across processes; replacement only within one process using the same resolved paths. Registry use requires explicit `{ scope: "process" }` as the third factory argument; host/distributed authority is refused. |
| S3-compatible files | Distributed condition protocol implemented and tested against a simulated endpoint; each configured session must pass the live gate. No production provider qualification is implied. |
| Plain key-value resource | Existing registry data is readable; mutations refuse because the contract has no atomic compare-and-set. Use a System Store or qualified file storage for writes. |

System Store `compareAndSet` accepts an optional fifth `expectedValue` argument;
adapters must compare it atomically with the timestamp when supplied. Registry
writes use both guards to reject timestamp reuse after recreation. These checks
do not establish ownership generations, power-loss durability, hostile-writer
containment, backup rollback safety, or distributed live service activation.

`POST /runtime/services` registers a non-marketplace ESM source with
`{ name, specifier }`. The best portable input is a module specifier or hosted
ESM entry point that the active host knows how to resolve.

Installed services can also attach iframe-backed dashboard documents to their
menu items with `menu.page`. The dashboard receives a safe `src` URL from
runtime config and mounts it through the `zelavis-service-frame` web component,
so service UI can be a full HTML document instead of a React component tied to
Zelavis dashboard internals.

`menu.path` and `menu.page.file` intentionally mean different things:

- `menu.path` is the dashboard URL. Core services whose screens already ship
  with `@zelavis/ui` should use this without `menu.page`; the dashboard renders
  the local React Router route directly and no iframe is mounted.
- `menu.page.file` is a browser-extension-style HTML entry file inside the
  service bundle. Zelavis serves it through the generated service-page asset URL
  and the dashboard iframe loads that URL. The iframe never points at a raw
  filesystem path. Relative assets such as `<script src="./settings.js">` work
  when they are shipped beside the HTML file in the same bundle.
- If the HTML file boots a SPA, that SPA owns its internal router, tabs, and
  menu. Zelavis sidebar items select concrete HTML entry files; they do not
  deep-link into plugin-private SPA routes.

That lets a custom service ship simple static dashboard pages:

```ts
import { zelavis } from "zelavis/sdk";

zelavis.plugins.ui.menus.create({
  title: "Reports",
  path: "/reports",
  page: {
    id: "dashboard",
    file: "dashboard.html",
  },
    items: [
      {
        title: "Settings",
        path: "/reports/settings",
        page: {
          id: "settings",
          file: "settings.html",
        },
      },
    ],
  },
});
```

`dashboard.html` can be plain HTML or boot a client app with normal relative
assets from the same bundle:

```html
<main id="app"></main>
<script type="module" src="./dashboard.js"></script>
```

Dynamic menu sections use the same item schema as static service menus. A
service-owned endpoint returns a JSON menu fragment:

```json
{
  "items": [
    {
      "title": "Reports",
      "path": "/reports/monthly",
      "page": {
        "id": "monthly",
        "file": "monthly.html"
      }
    }
  ]
}
```

When a file storage resource exists, Zelavis can also expose a built-in storage core service:

```txt
GET /zelavis/api/v1/storage/files
GET /zelavis/api/v1/storage/files/*
GET /zelavis/api/v1/storage/files/*?format=metadata
PUT /zelavis/api/v1/storage/files/*
DELETE /zelavis/api/v1/storage/files/*
```

Writes return file metadata plus a first-class Zelavis file reference, and reads expose the SHA-256 checksum through metadata responses and the `x-zelavis-checksum-sha256` response header when available.

For generic object storage that is not really a hosting platform decision, Zelavis also exposes a first-party S3-compatible helper:

```ts
import { createS3CompatibleFileStorage } from "zelavis/storage/s3";
```

Use it when you want the normal Zelavis storage contract, metadata, and file-reference flow on top of an S3-compatible bucket.

Root path changes are saved as pending settings and report `restartRequired`
because mounted routes cannot move safely while the runtime is already running.
Runtime resources such as KV or file storage are used as settings defaults when
they are available.

For local Zelavis development, use the `pnpm dev` workflow. It starts the
runtime and UI dev server together and wires dashboard requests to the live UI
build.

`pnpm dev` builds the unified package and product services under
`packages/zelavis/services`. The official native Project recipe lives
in this package under `src/app` and is exported as `zelavis/app`. Each created
Project locks its exact recipe/runtime version so parent Platform upgrades do
not silently upgrade child Apps.

The dashboard, project registry, Platform settings, and service registry state
persist through the separate System Store. Zelavis App capabilities run inside
created Project runtimes.

## Plugin API authoring

Use `zelavis.createAPI({ resource: { async list(input) { /* ... */ } } })`
from `zelavis/sdk` while a package is loaded. The manifest namespace owns its
generated routes, and the existing SDK and CLI discover those operations.
Use `{ routes: false }` for local authoring helpers and `operations.create`
for explicit schemas, response codes, and route contracts. See the
[plugin API guide](../../website/src/content/docs/guides/plugin-api.md).
