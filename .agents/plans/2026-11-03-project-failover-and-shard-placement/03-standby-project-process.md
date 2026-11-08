# A Project process can run as its writer's standby
Job: Part 3 of the plan for the open failover and placement work (see 00-overview.md): the standby half of "start a Project on another node from its follower copy".
Date: 2026-11-03
Status: done
Verified-at: 53c038e024 (plus the uncommitted working tree of 2026-11-03)
Part: 3 of 5. Read 00-overview.md first.

To start:    Execute part 3 in .agents/plans/2026-11-03-project-failover-and-shard-placement/03-standby-project-process.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-03-project-failover-and-shard-placement/03-standby-project-process.md. Start with its section 8.

## Progress
- [x] 2026-11-03 1. A Project's lease capability authenticates as that Project's follower
- [x] 2026-11-03 2. A Platform route for following a Project, needing only `database.replicate`
- [x] 2026-11-03 3. The lease environment says the role, and the follower endpoint is derived
- [x] 2026-11-03 4. A database opened as a standby follows until it is promoted
- [x] 2026-11-03 5. A standby engine answers 503 until its database is promoted
- [x] 2026-11-03 6. The Node Project driver starts a standby
- [x] 2026-11-03 7. A real writer and a real standby fail over
- [x] 2026-11-03 8. Docs
- [x] 2026-11-03 9. Self-audit

## 0. Summary and finish line

Decision 9 needs a Project process on the standby node that follows the writer and takes over when its lease lapses.
The database pieces exist (`standbyDatabase`, `followAll`, the lease). What is missing is a Project *process* that runs
them: something the driver can start as a standby, that reads its writer with a credential worth little if leaked, that
writes nothing before it is promoted, and that serves the Project once it is. This part builds that process and proves it
with a real writer and a real standby. Starting it on a remote node and moving placement is part 4.

**In scope:** the lease capability as a follower credential; a narrow Platform followers route (with SDK and CLI through
the existing followers client); the lease environment's role; standby opening in `openNodeDatabase`; the standby engine;
the driver's standby start and the `standby` runtime status; one end-to-end test; docs.
**Out of scope:** dispatching a standby to a remote Agent, moving placement, the dashboard (part 4).

**Done means:**
- A lease capability for `(project, node)` authenticates at the Platform as a principal holding only `database.replicate`
  on that Project; it reaches `GET|POST /runtime/projects/:id/followers/*` and nothing else.
- `client.followers(id)` (and so `zelavis followers`) uses that route; `capability-parity.test.mjs` passes.
- `ZELAVIS_PROJECT_LEASES_ENDPOINT` is gone; the lease endpoint is derived from `ZELAVIS_PROJECT_LEASES_URL`.
- A database opened with a standby lease follows its writer and opens as writer when the lease lapses.
- A Project process started as standby answers `503 { "error": "This Project is standing by for its writer." }`, writes
  nothing, and serves the Project after its promotion.
- `test/project-standby.test.mjs` passes: a real Platform's writer and a real standby, data written, the writer stopped,
  the standby promoted, both follower listings equal (partition and head, `zv.global` included).
- `pnpm run verify` passes.

**Supplement:** see 00-overview.md.

## 1. Context packet

**Glossary**
- *Writer / standby*: two Project processes of one Project on two nodes. The writer holds the Project's writer lease;
  the standby follows it and promotes itself when the lease lapses (decision 9).
- *Lease capability*: `mintLeaseCapability(secret, { scope, node })` (`src/platform/lease-capability.ts:48`); verified by
  `verifyLeaseCapability` (`:58`). Today it authorizes only `/runtime/project-leases/:scope` (`src/platform/writer-lease-routes.ts:125-153`).
- *Lease environment*: what a Project process is started with (`ZELAVIS_LEASE_*`), minted by `projectLeaseEnvironment`
  (`src/adapters/_project-lease-environment.ts:44-56`) and read by `leaseFromEnvironment` (`src/adapters/_node-project-engine.ts:21-42`).
- *Endpoint*: `WriterLease.endpoint`, where followers read the writer. Followers re-point when the epoch changes
  (`src/db/writer-lease.ts:397-424` `followWriter`).

**Governing rules**
- "Unscoped and system grants authorize runtime-wide routes. Project and service grants require the same explicit route
  identity and never satisfy an unscoped requirement" (`AGENTS.md § Core Access-Control Rule`).
- "Do not run app project services directly inside the Platform process; the Platform dashboard must communicate with
  project runtimes through the Project Gateway boundary." (`AGENTS.md § Platform And App Service Boundary`)
- "Singleton duties … run only in the process holding the database's writer claim." (decision 4,
  `.agents/references/effect-cluster-decision.md`)
- "Every official public Zelavis capability must be available through the official JavaScript SDK, versioned HTTP API,
  and CLI." (`AGENTS.md § Endpoint-Backed Capability Rule`)

**System today**
- Authenticators: an endpoint group may carry `authenticators` (`src/core/runtime/create-runtime.ts:74-80`, composed at
  `:148-153`); each is `{ name, authenticate(context) }` returning a `ZelavisPrincipal` or `undefined`
  (`src/core/runtime/authentication.ts:27-34`); `readAuthorizationCredential(request, "Bearer")` (`:67`).
- Principal and grant shapes: `src/core/runtime/contracts.ts:14-50`; a Project-scoped grant is
  `{ permission, scope: { type: "project", projectId } }` (the Project engine builds the same at
  `src/adapters/_node-project-engine.ts:86-87`).
- The Platform route group holding the lease routes: `src/index.ts:4642-4652` (`createPlatformEndpointGroup({ ... routes: [...] })`).
- The Project proxy: `src/platform/project-gateway.ts:614-668`: `POST` through it needs `project.runtime.manage`, which also
  starts and stops the Project (`src/index.ts:6266,6298,6330`). Too much for a standby's credential.
  `createProjectForwarder(dependencies)` (`:427`) does the forwarding (`forwardToProject({ projectId, wildcardPath, query, request, principal })`, `:663-668`).
- `database.replicate` is a delegable Project permission (`project-gateway.ts:147-149`).
- The followers SDK client: `src/sdk/fetch.ts:2698-2720` (`at(partition, action)` →
  `projectPath(projectId, \`${PROJECT_DATABASE_PROXY_PATH}/followers/...\`)`; `PROJECT_DATABASE_PROXY_PATH = "proxy/zelavis/api/v1/database"`, `:2817`).
- `openNodeDatabase` (`src/db/node-host.ts:104-175`): with `options.lease`, `startDatabase(lease)` at `:144-151`.
- `standbyDatabase` (`src/db/database.ts:1195`), input `DatabaseLeaseStandby` (`:496`): `StandbyInput` minus
  `store|acknowledged|follow` plus `DatabaseLeaseFollow` minus `owner|leases` (`scope`, `leaderFor`, `name?`,
  `timeoutMillis?`, `pollMillis?`); `StandbyInput` fields at `src/db/writer-lease.ts:310-325` (`owner`, `ttlMillis`,
  `endpoint?`, `successor?`, `allowDataLoss?`).
- `remoteDatabaseLeader(transport)` (`src/db/leader.ts:374`); a transport from the SDK: `createZelavisClient({ baseUrl,
  rootPath: "/zelavis", headers }).followers(projectId)` (`headers` option: `src/sdk/fetch.ts:155`).
- The engine: `src/adapters/_node-project-engine.ts:44-100` `prepare` → `open()` builds `nodeAdapter({ role: "project",
  ... database: { lease } })` and `new Zelavis(...)`, returns `{ runtime, qualify: Effect.void, close }`. The engine
  contract: `NodeRuntimeEngineOwner { runtime: Pick<ZelavisServerRuntime, "fetch">; qualify; close(reason) }`
  (`src/adapters/_node-runtime-worker.ts:17-21`). The supervisor kills an engine that is not ready in 30 s
  (`src/adapters/_node-runtime-supervisor.ts:45`), so a standby must not block `open`.
- The driver: `src/adapters/_node-project-runtime.ts:763-850`: mints `leaseEnvironment(project.id)` (`:764`), starts the
  process with it (`:785`), turns the `ready` line into `{ status: "running", url }` (`:795-806`), times out after
  `startupTimeoutMs` (`:839-843`). Its option `leaseEnvironment` (`:58`).
- Status union: `ZelavisProjectRuntimeStatus` (`src/project.ts:47-53`); snapshot `ZelavisProjectRuntimeSnapshot` (`:247-253`).
- Test patterns: real Platform + Project: part 1's `test/project-lease-platform.test.mjs` (Platform served over node:http,
  `ZELAVIS_PROJECT_LEASES_*` set first); a driver started in a test with a real local Agent:
  `test/runtime-project-host.test.mjs:49-69` (`createLocalAgentProcessRunner`, `createNodeProcessProjectRuntime`,
  `driver.prepare`, `driver.start`, `driver.signGatewayAuthority(projectId, claims)` with the claims at `:71`).

**Pattern to mirror:** the capability check in `writer-lease-routes.ts:75-82` (`authorize`): parse the bearer, verify
under the installation secret, check the scope, check the Project exists.

**Traps**
- Granting the standby `project.runtime.manage` so it can use the proxy: that lets a leaked token stop the Project.
  Add the narrow route instead.
- A system-scope grant of `database.replicate`: that opens every Project's followers routes (`AGENTS.md § Core Access-Control
  Rule`). Project scope only.
- Blocking `open()` until promotion: the supervisor kills the engine after 30 s. Return at once, compose in the background.
- Composing the App before promotion: Identity, Workloads and entities write to the database at start, which would make the
  follower's copy diverge. Nothing but the database opens before promotion.
- A default role when `ZELAVIS_LEASE_ROLE` is missing: the Platform always sends it; refuse a missing one.

## 2. Design

- **Authority.**
  - The lease capability's principal: `{ id: "project-lease:<scope>@<node>", type: "service", grants: [{ permission:
    "database.replicate", scope: { type: "project", projectId: <scope> } }] }`, only while the Project exists (the same
    check as `authorize`). It authorizes reading the Project's followers routes; it still cannot write any lease but its
    own node's (unchanged).
  - **NEW** route `runtime.projects.followers.<get|post>` at `/projects/:projectId/followers/*path`, access
    `{ permissions: ["database.replicate"], scope: { type: "project", projectIdParam: "projectId" } }`, forwards to the
    Project's `zelavis/api/v1/database/followers/<path>` with the caller's authority. Owners (`*`) pass as before.
- **Roles.** `ZELAVIS_LEASE_ROLE` is `writer` or `standby`, always sent. A standby's lease environment names it as owner
  and the writer as its successor: `projectLeaseEnvironment(configuration, store, projectId, "standby")` mints for
  `node = configuration.standby` with `ZELAVIS_LEASE_STANDBY = configuration.node`.
- **Endpoint.** Every lease carries `endpoint = <ZELAVIS_PROJECT_LEASES_URL without its trailing /api/v1>` (for
  `http://127.0.0.1:3000/zelavis/api/v1`: `http://127.0.0.1:3000/zelavis`). A standby's `leaderFor(endpoint)` is
  `remoteDatabaseLeader(createZelavisClient({ baseUrl: origin, rootPath: pathname, headers: { authorization: "Bearer <token>" } }).followers(projectId))`.
  The Platform routes the follower to whichever node is the writer, so the endpoint is the same at every epoch.
  `ZELAVIS_PROJECT_LEASES_ENDPOINT` is removed (no alias).
- **Standby process.** The engine, given a standby lease, returns from `open` at once with a fetch that answers 503, and
  forks the composition. The composition opens the database with `standbyDatabase` (blocking inside, following); when the
  lease lapses it promotes, rebuilds replicated copies (part 2), takes the writer gate, and only then composes Identity,
  Workloads and the rest. From then on the fetch delegates. Closing the engine interrupts the fork and closes the database.
- **Driver.** **NEW** `startStandby(project)` on the Node driver: the same launch as `start` with the standby lease
  environment; when the `ready` line arrives the snapshot is `{ status: "standby", url }` (the process is up, its database
  is following). `start` for a Project whose process is in `standby` is part 4's adoption; here `start` refuses it with
  "Project "<id>" is running as a standby; it becomes the writer only by promotion."
- **Persistence.** None new.
- **Invariants.** (1) A standby writes nothing to its database before promotion. (2) A standby's credential reads only its
  own Project's followers routes. (3) A promoted standby serves only after it holds the lease (the lease is the fence).
- **Failure model.** Missing role → the engine throws at start ("A lease-guarded Project start needs ZELAVIS_LEASE_ROLE,
  writer or standby."). Followers unreachable → `followAll` retries with backoff (existing). Promotion refused
  (`FollowerBehind`, another standby won) → `standby` goes back to following (existing). Composition failure after
  promotion → the engine's fetch answers 503 with the failure message and the process exits non-zero, so the driver
  reports `failed` with it.
- **Decisions and rejected alternatives.**
  - A narrow followers route rather than the proxy: the proxy's `POST` needs `project.runtime.manage`.
  - The capability as the follower credential rather than a new service account: it already names Project and node,
    dies with the Project and rotates with the installation secret. Rejected: minting a service account per standby
    (a second lifecycle and its cleanup).
  - Derive the endpoint rather than configure it: one value instead of two that can disagree.
- **Open questions:** none.

## 3. Contracts

```ts
// src/adapters/_project-lease-environment.ts
export type ProjectLeaseRole = "writer" | "standby";
export interface ProjectLeaseConfiguration { readonly authority: string; readonly node: string; readonly standby: string; readonly ttlMillis: number }
export const projectLeaseEnvironment: (configuration: ProjectLeaseConfiguration, store: ZelavisSystemStore, projectId: string, role: ProjectLeaseRole) => Promise<Readonly<Record<string, string>>>;
// adds ZELAVIS_LEASE_ROLE and ZELAVIS_LEASE_ENDPOINT (derived); for "standby" swaps node and standby.

// src/db/node-host.ts — OpenNodeDatabaseOptions.lease becomes:
readonly lease?: (DatabaseLeaseStart & { readonly role: "writer" }) | (DatabaseLeaseStandby & { readonly role: "standby"; readonly leases: LeaseStore; readonly owner: string });

// src/adapters/_node-project-runtime.ts — driver option and method:
leaseEnvironment?: (projectId: string, role: ProjectLeaseRole) => Promise<Readonly<Record<string, string>> | undefined>;
startStandby(project: ZelavisProjectRecord): Promise<ZelavisProjectRuntimeSnapshot>; // and its Effect form, as `start` has

// src/project.ts
export type ZelavisProjectRuntimeStatus = "provisioning" | "starting" | "running" | "standby" | "stopping" | "stopped" | "failed";
```
- HTTP **NEW**: `GET` and `POST /zelavis/api/v1/runtime/projects/:projectId/followers/*path`.
- SDK: `createFollowersClient` paths become `projectPath(projectId, \`followers/${encodeURIComponent(partition)}/${action}\`)`,
  `followers/feed`, `followers/partitions` (and part 2's `followers/declarations` if part 2 is done: move it too).
- CLI: unchanged commands (`zelavis followers …`), now through the new route.

## 4. Execution steps

### Step 1. A Project's lease capability authenticates as that Project's follower
- **Files:** `packages/zelavis/src/platform/writer-lease-routes.ts` (export a **NEW** `createLeaseCapabilityAuthenticator(capability: ProjectLeaseCapabilityOptions): ZelavisRequestAuthenticator`),
  `packages/zelavis/src/index.ts` (add it to the endpoint group that mounts `createWriterLeaseRoutes`, `:4642-4652`, as
  `authenticators: [createLeaseCapabilityAuthenticator({ secret, projectExists })]`, reusing the same two functions),
  `packages/zelavis/test/project-lease-capability.test.mjs`.
- **Change:** `authenticate({ request })`: `readAuthorizationCredential(request, "Bearer")`; none → `undefined`; verify with
  `verifyLeaseCapability`; not authentic or Project missing → `undefined` (other authenticators may still accept the
  bearer, so do not throw); else the principal of section 2. Imports: `readAuthorizationCredential`, `type ZelavisRequestAuthenticator`
  from `../core/runtime/authentication.js`; `type ZelavisPrincipal` from `../core/runtime/contracts.js` (find its export path with
  `grep -n "ZelavisPrincipal" src/core/index.ts`).
- **Test:** a token for `(p1, node-b)` → principal with exactly one grant `database.replicate` on `p1`; a token for a deleted
  Project → `undefined`; a forged token → `undefined`.
- **Check:** build; `node --test test/project-lease-capability.test.mjs; echo "exit $?"` → `exit 0`.

### Step 2. A Platform route for following a Project, needing only `database.replicate`
- **Files:** `packages/zelavis/src/platform/project-gateway.ts` (inside `createProjectGatewayRoutes`, beside `proxyRoutes`),
  `packages/zelavis/src/sdk/fetch.ts` (`createFollowersClient`), `packages/zelavis/test/capability-parity.test.mjs` (only if
  it needs the wildcard route declared: follow how the proxy routes are treated there), a new case in
  `packages/zelavis/test/project-lease-capability.test.mjs`.
- **Change:** two routes (`GET`, `POST`), ids `runtime.projects.followers.get|post`, path `/projects/:projectId/followers/*path`,
  access of section 2, handler `forwardToProject({ projectId: params.projectId ?? "", wildcardPath: \`zelavis/api/v1/database/followers/${params.path ?? ""}\`, query, request, principal })`.
  Refuse a `path` containing `..` with 400 before forwarding. SDK paths as in section 3.
- **Test:** on a real Platform (copy part 1's setup) with a running lease-guarded Project: the capability bearer reaches
  `GET /runtime/projects/leased/followers/acme/stats` (200 or the follower error body, not 401/403), is refused at
  `POST /runtime/projects/leased/stop` (401 or 403) and at another Project's followers route.
- **Check:** build; `node --test test/project-lease-capability.test.mjs test/capability-parity.test.mjs test/db-follow-database.test.mjs; echo "exit $?"` → `exit 0`.

### Step 3. The lease environment says the role, and the follower endpoint is derived
- **Files:** `packages/zelavis/src/adapters/_project-lease-environment.ts`, `packages/zelavis/src/adapters/node.ts` (`:430`:
  `leaseEnvironment: (projectId, role) => projectLeaseEnvironment(projectLeases, systemStore, projectId, role)`),
  `packages/zelavis/src/adapters/_node-project-runtime.ts` (`:58` option type; `:764` passes `"writer"`),
  `packages/zelavis/test/project-lease-capability.test.mjs` (`:80-104` and `:106-131` update).
- **Change:** section 3 contracts; remove `endpoint` from `ProjectLeaseConfiguration` and the `ZELAVIS_PROJECT_LEASES_ENDPOINT`
  read; compute `ZELAVIS_LEASE_ENDPOINT` as `authority.replace(/\/api\/v1\/?$/, "")` and refuse an authority that does not end
  in `/api/v1` at configuration ("ZELAVIS_PROJECT_LEASES_URL is the Platform's API root, ending in /api/v1.").
- **Check:** build; the capability test → `exit 0`.

### Step 4. A database opened as a standby follows until it is promoted
- **Files:** `packages/zelavis/src/db/node-host.ts` (`:144-151`), `packages/zelavis/test/project-lease-start.test.mjs`.
- **Change:** `options.lease.role === "standby"` → `database.writerLeases.standbyDatabase(lease)` in the same scope and with
  the same `tapError(Scope.close)` as `startDatabase`; `"writer"` → `startDatabase(lease)`.
- **Test** (new case): two `openNodeDatabase` directories (`temporaryDatabaseDirectory` from `./_database.mjs`), one
  `memoryLeaseStore()`; open the writer (`role: "writer"`, owner `a`, standby `b`), write a document; open the standby in the
  background (`role: "standby"`, owner `b`, successor `a`, `leaderFor: () => localDatabaseLeader(writer.database.followers)`);
  assert it has not resolved after 500 ms; close the writer (releases the lease); await the standby; assert it holds the
  document and `writerLeases`… `lease.owner === "b"`.
- **Check:** build; `node --test test/project-lease-start.test.mjs; echo "exit $?"` → `exit 0`.

### Step 5. A standby engine answers 503 until its database is promoted
- **Files:** `packages/zelavis/src/adapters/_node-project-engine.ts`.
- **Change:** `leaseFromEnvironment` reads and requires `ZELAVIS_LEASE_ROLE`; for `standby` returns the standby lease with
  `leaderFor` as in section 2 (import `createZelavisClient` from `../sdk/fetch.js`, `remoteDatabaseLeader` from `../db/leader.js`).
  In `open`, for a standby lease: fork the existing composition (`zv.runtime()`) with `Effect.forkIn` into a scope the engine
  closes in `close`; return `{ runtime: { fetch } }` where `fetch` answers
  `Response.json({ error: "This Project is standing by for its writer." }, { status: 503 })` until the fork completes, and
  then delegates to the composed runtime; a failed fork makes `fetch` answer 503 with the failure's message and exits the
  process with code 1 (as the runner does on failure, `src/adapters/_node-project-runner.ts:89`). `close` interrupts the fork
  and closes `zv`. The writer path is unchanged.
- **Check:** build; `node --test test/project-lease-start.test.mjs; echo "exit $?"` → `exit 0` (the role case: a missing role throws `/ZELAVIS_LEASE_ROLE/`).

### Step 6. The Node Project driver starts a standby
- **Files:** `packages/zelavis/src/project.ts` (status union), `packages/zelavis/src/adapters/_node-project-runtime.ts`,
  any file the build then reports for the new status (switch statements, labels).
- **Change:** `startStandby` shares `start`'s launch with `leaseEnvironment(project.id, "standby")`; the `ready` line sets
  `{ status: "standby", url, startedAt }`; `start` refuses a Project whose snapshot is `standby` (message of section 2).
  For every place the build flags, treat `standby` as "running, not serving" (never as `running`).
- **Check:** build (no `error TS`); `node --test test/project-lease-capability.test.mjs; echo "exit $?"` → `exit 0`.

### Step 7. A real writer and a real standby fail over
- **Files:** **NEW** `packages/zelavis/test/project-standby.test.mjs`.
- **Change:** one test, `{ timeout: 180_000 }`: part 1's real Platform (leases `node-a`, standby `node-b`, TTL 3000) runs
  Project `leased` as writer. A second driver (`createNodeProcessProjectRuntime({ directory: <tmp>/node-b, agent: createLocalAgentProcessRunner(), leaseEnvironment: (id, role) => projectLeaseEnvironment(configB, systemStore, id, role) })`
  where `configB` is the Platform's configuration and `systemStore` the Platform's (from `await adapter.resolve({})`,
  as `test/node-adapter-remote-nodes.test.mjs:49` does) prepares the same Project record and `startStandby`s it; assert
  its snapshot is `standby` and a GET of its URL answers 503 with the message. Write a collection and a document through
  `createZelavisClient({ baseUrl: "http://localhost", rootPath: "/zelavis", fetch: (i, n) => zv.fetch(new Request(i, n), OWNER) }).data("leased")`.
  Wait until B is level: poll `client.followers("leased").partitions()` (A, through the Platform) and B's own
  `POST <B url>/zelavis/api/v1/database/followers/partitions` (header `ZELAVIS_GATEWAY_AUTHORITY_HEADER` from
  `driverB.signGatewayAuthority("leased", { ...claims, permissions: ["database.replicate"] })`, claims as
  `runtime-project-host.test.mjs:71` with `projectId: "leased"`) until equal. Then `POST /runtime/projects/leased/stop`
  (releases the lease); poll B's URL until it answers 200 on `GET /zelavis/api/v1/runtime/access` (promoted and composed);
  assert the Platform's lease names `node-b` at a higher epoch, and B's listing equals the one A had, `zv.global` included.
- **Check:** build; `node --test test/project-standby.test.mjs; echo "exit $?"` → `exit 0`.

### Step 8. Docs
- **Files:** `website/src/content/docs/api/database.md` ("Writer leases and follower failover", `:148`, the
  `ZELAVIS_PROJECT_LEASES_*` paragraph `:207-209`); `.agents/references/effect-cluster-decision.md` (phase 3 list: reword the
  Fabric item to what part 4 leaves).
- **Change:** document the role, the derived endpoint (and that `ZELAVIS_PROJECT_LEASES_ENDPOINT` is gone), the standby's
  503 until promotion, the follower credential and the new route.
- **Check:** `pnpm run docs:check; echo "exit $?"` from the root → `exit 0`.

### Step 9. Self-audit
See section 8. From the root: `pnpm run verify; echo "exit $?"` → `exit 0`.

## 5. Tests
- Capability authenticator: right principal; deleted Project and forged token refused (step 1).
- Followers route: reachable with the capability; `stop` and other Projects refused (step 2).
- Lease environment: role, swap for standby, derived endpoint, bad authority refused (step 3).
- `openNodeDatabase` standby: blocks while the writer lives, promotes on release, holds the data (step 4).
- Engine: missing role refused (step 5).
- End to end: standby 503, levels, promotes on the writer's stop, serves, equal listings (step 7).
No dashboard change in this part (the status appears in part 4's dashboard work), so no browser test here.

## 6. Docs and project notes
Step 8. No `pnotes/` change.

## 7. Verification
From the root: `pnpm run verify; echo "exit $?"` → `exit 0`; `pnpm run docs:check` → `exit 0`.

## 8. Instructions to the implementer

> **Before changing anything, read `Status` and `## Progress`.**
> - Compare `Verified-at` with `HEAD`; for every path cited here that changed since (parts 1 and 2 change several),
>   check each quoted excerpt before its step and stop and report when one no longer matches. `Status: needs replanning`
>   means stop at once.
> - `Status: planned`: set `Status: in progress` here and in `00-overview.md`. Anything else: you are continuing; read every
>   `## Execution report` entry, confirm the last `[x]` check still passes, finish or redo the `[~]` step, never redo `[x]`.
> - `Status: in progress` and you were asked to *execute*: stop and ask the user.
>
> Read parts 1 and 2's execution reports first; check that part 1's `test/project-lease-platform.test.mjs` and part 2's
> `GLOBAL_TENANT` following exist (this part builds on both). If a deviation there affects this part, stop and report.
>
> **Keep `## Progress` current** (`[~]` with date before the first edit, `[x]` with date and note after its check passed).
> Build before tests (`pnpm --filter zelavis run build`; success is exit 0 with no `error TS`). zsh: use `; echo "exit $?"`.
>
> Read section 1 first and return to it when unsure. Steps in order; tests run in the step that writes them. Do not
> redesign or improve beyond the plan; match the surrounding style.
>
> **Stop and report instead of improvising** when a cited symbol differs, a check fails for a reason that is not a simple
> mistake in your change, a gate (`check:tigerstyle`, `check:effect-usage`, repo rules, capability parity) would need a
> suppression, baseline entry, wrapper or shim, a standby writes before its promotion (any `ReplicaDiverged` in step 7 is
> that), or the plan seems to contradict `AGENTS.md` (which wins).
>
> **An unexpected result is a finding, never noise**: investigate it in this session until you know its cause; fix it if it
> stays in this part's files and rules, otherwise report the cause and your proposed fix.
>
> Never: compatibility aliases or fallbacks (no `ZELAVIS_PROJECT_LEASES_ENDPOINT` alias, no default role), silent catches,
> `try/catch` in Platform code, `Effect.ignore`, unbounded concurrency, unchecked `JSON.parse` casts, Promise orchestration
> in Platform code (`check:effect-usage` enforces it; add any file you migrate to `migratedFiles`), a system-scope grant to
> the standby, anything in `.claude/` or `pnotes/`, edits to `dist/`, `website/dist/`, `website/.astro/` or `repos/effect/`.
> Never touch other people's uncommitted files. Do not commit, push or publish.
>
> **Self-audit before you report done** (step 9): re-read the diff against sections 1–5; check each Done means item; rerun the
> tests this part touched and `pnpm run verify` after your last edit; search the diff for forbidden patterns, debug output,
> TODOs; every unexpected result has a known cause. Record the audit.
>
> When you finish or stop, add `### Session <n>: <date>` under `## Execution report`: final status (update `Status` here and
> in `00-overview.md`), each step one line, verification results, deviations and why, anything undone, **Context the plan
> lacked** ("none" if nothing). Then give the user the same report, shortened.

## Execution report

### Session 1: 2026-11-03
Status: done.
- Step 1: `createLeaseCapabilityAuthenticator` (`writer-lease-routes.ts`); principal `project-lease:<scope>@<node>` with one grant, `database.replicate` on that Project; mounted through a new `authenticators` option of `createPlatformEndpointGroup`, sharing `leaseCapability` with the lease routes. Test added.
- Step 2: routes `runtime.projects.followers.get|post` (`project-gateway.ts`), forwarding only `database.replicate`; SDK paths moved to `projects/:id/followers/*`; parity test: the wildcard route is a stated passthrough (GET and POST only) and the followers operations map to the new path; the test fixture and the failover drill's node server match the new path.
- Step 3: `ZELAVIS_LEASE_ROLE` always sent, standby swaps node and successor, endpoint derived from the API root (`ZELAVIS_PROJECT_LEASES_ENDPOINT` removed, an authority not ending in `/api/v1` refused); `inheritedProjectLeaseEnvironment` carries the role.
- Step 4: `NodeDatabaseLease` (`role: "writer" | "standby"`); `openNodeDatabase` hands a standby out only once promoted. Test added.
- Step 5: the engine requires the role, and for a standby forks the composition in a scope, answers 503 until it finishes, and exits 1 on a failed composition.
- Step 6: `startStandby` on the Node driver (the start path is now `launch(project, placement, role)`), the `standby` runtime status, the refusal "is running as a standby", a forwarding `startStandby` in the deployment backend wrapper.
- Step 7: `test/project-standby.test.mjs` passes (about 27 s): a real writer and a standby on a second driver and agent; credential checks; 503; levelled by the standby's acknowledgments; the writer stopped; the standby serves at a higher epoch with `zv.global`, the Tenant and the document.
- Step 8: `database.md` and the decision record. Step 9: `pnpm run verify` exit 0 (a rerun after the flaky divergence test of part 2 failed once), `docs:check` exit 0.

Deviations:
1. The standby's own listing cannot be polled before promotion (the plan's step 7): nothing but the database opens before promotion, so its engine answers 503 for everything. The test levels through the writer's side instead: the standby's acknowledgments (`client.followers(id).acknowledgments`) against the writer's heads, and compares listings after promotion (at least the heads the writer had).
2. The step 2 route test is in `project-standby.test.mjs` with the real Platform rather than a separate case in `project-lease-capability.test.mjs`; that file has the authenticator test.
3. Existing tests updated for new facts: `platform-foundation.test.mjs` (the driver fixture implements `startStandby`), `zelavis-server.test.mjs` (the two new route ids), `capability-parity.test.mjs`.

Not done / limits:
- A promoted standby does not get `onSuperseded` (a writer superseded later is refused, not stopped): `standbyDatabase` takes no such callback.
- Closing a standby engine while it is still waiting cannot cancel the wait inside `openNodeDatabase` (a Promise boundary); the worker process ends instead.
- A Platform restart re-attaches a standby process as `running` (`adopt` cannot know the role); part 4's adoption must record it.
- Dispatching a standby to a remote Agent, moving placement, the dashboard: part 4.

Context the plan lacked: the standby cannot answer its own follower listing before promotion (above); `projects.view`, not `get`, is the lock-free read; the integration host must not get the lease environment (part 1); `Pick<Zelavis…, "fetch">` engines may return a Promise-valued fetch.
