# A standby copies the whole database, not only the Tenants
Job: Part 2 of the plan for the open failover and placement work (see 00-overview.md): the open item "copy the reserved partitions to a standby Project when it is promoted", built as continuous following instead.
Date: 2026-11-03
Status: done
Verified-at: 53c038e024 (plus the uncommitted working tree of 2026-11-03: `src/db/leader.ts` and `src/db/database.ts` carry the follower-removal and divergence fixes; re-check every `leader.ts` and `database.ts` line below before relying on it)
Part: 2 of 5. Read 00-overview.md first.

To start:    Execute part 2 in .agents/plans/2026-11-03-project-failover-and-shard-placement/02-standby-copies-whole-database.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-03-project-failover-and-shard-placement/02-standby-copies-whole-database.md. Start with its section 8.

## Progress
- [x] 2026-11-03 1. (fails as planned: tenant only)  A test pins down what a promoted standby lacks today
- [x] 2026-11-03 2. The App-scoped partition is followed, on the global shard on both sides
- [x] 2026-11-03 3. Plugin partitions are followed
- [x] 2026-11-03 4. The leader's declarations (placement classes, divisions) reach the follower
- [x] 2026-11-03 5. A promoted standby rebuilds its replicated copies before it writes
- [x] 2026-11-03 6. The declarations over HTTP, the SDK and the CLI
- [x] 2026-11-03 7. Docs
- [x] 2026-11-03 8. Self-audit

## 0. Summary and finish line

A whole-database follower (`followAll`, used by `standbyDatabase`) copies Tenant partitions only. It skips:
- the App-scoped collections (`db.global`), which live in partition `zv.global` on the global shard;
- plugins' private `service:` partitions;
- the declarations kept in the topology shard: which collections are `replicated` (placement catalog) and which Tenants
  are divided (subdivision catalog);
- the per-shard copies of replicated collections, which are derived.

A promoted standby therefore serves an App with its App-scoped data, plugin data, replicated collections and divided
Tenants missing. The note this replaces planned to copy them "when the standby is promoted", but at a failover the old
writer is gone, so there is nothing to copy from. This part follows them continuously instead and rebuilds what is
derived at promotion.

**In scope:** `followAll` (both transports), the leader's followers API, one new read of the leader's declarations
(route, SDK, CLI), `standbyDatabase`'s promotion, tests, docs.
**Out of scope:** the partition map and placement records in the topology shard (each side keeps its own layout, see
section 2); standby Projects (parts 3 and 4).

**Done means:**
- `test/db-follow-whole-database.test.mjs` (**NEW**) passes over both transports: after a promotion the standby holds
  a Tenant's document, an App-scoped document, a `service:` partition's document, a replicated collection's document
  read from a Tenant's `shared` handle, and a divided Tenant reachable through `forPart`; and it failed at step 1.
- `GET …/database/followers/declarations` exists with SDK `client.followers(id).declarations()` and CLI
  `zelavis followers declarations --project ID`; `test/capability-parity.test.mjs` passes.
- `test/db-follow-database.test.mjs` still passes.
- `pnpm run verify` passes.

**Supplement:** see 00-overview.md.

## 1. Context packet

**Glossary**
- *Partition*: a key range `[0x01][name]` with its own log, identifiers and writer. A Tenant is one; `zv.global` is one
  on the global shard; `service:<name>` partitions belong to plugins.
- *Global shard / `zv.global`*: `GLOBAL_SHARD` and `GLOBAL_TENANT` (`src/db/topology.ts:17,31`, both `"zv.global"`). The
  global shard holds partition `zv.global` with every App-scoped collection. Every ordinary shard *also* has a
  `zv.global` partition holding the derived copies of replicated collections (`src/db/database.ts:863-866`).
- *Topology shard*: `zv.topology` (`topology.ts:7`): the partition map, the placement catalog (collection → class) and
  the subdivision catalog (divided Tenant → parts) (`database.ts:651-657`).
- *Follower / leader*: the follower copies the leader through a `DatabaseLeader` (`src/db/leader.ts:355-364`): in the
  same process (`localDatabaseLeader`, `:366`) or over HTTP (`remoteDatabaseLeader`, `:374`).
- *Declarations*: in this plan, the two catalogs of the topology shard that carry no data: placement classes and divisions.

**Governing rules**
- "Scalability is rule one … A full listing is the rare resync path and may be as long as the data. A change that adds a
  per-Tenant read, record or loop to a hot path or to the authority needs a different design."
  (`AGENTS.md § Database Architecture Rules`)
- "A follower on another host reads its leader through the leader transport … so the same `levelFollower`/`followLeader`
  code runs on both sides … Never add a second follower algorithm for the remote case." (same section)
- "Every official public Zelavis capability must be available through the official JavaScript SDK, versioned HTTP API,
  and CLI." (`AGENTS.md § Endpoint-Backed Capability Rule`)
- "Dividing is declared and carries no data, so it is refused for a Tenant that already holds records."
  (`AGENTS.md § Platform And App Service Boundary`)

**System today** (cite and re-check each line; the file changed today)
- `leader.ts:442-447` `validFollowerPartition`: refuses every `zv.`-prefixed name and `GLOBAL_TENANT`.
- `leader.ts:452-465` `followersOver(input)`: `routed`, `partitionsPage`, `feed`, `shardFor`, `changed`, `remove`, `writes`.
- `leader.ts:478` the leader's `source(partition)` = `input.routed(valid)`.
- `leader.ts:556-581` `level(partition)`: the leader's `source`, the dropped-partition branch (removes a local copy the
  leader no longer holds), then `levelFollower(source, { shard: input.shardFor(partition), partition })`.
- `leader.ts:587-606` `resync`: pages `leader.partitions`, re-levels where head or tip differ; `:608` `prune`.
- `database.ts:659` `const globalStore = globalShard.partition(GLOBAL_TENANT);` (the global shard's partition).
- `database.ts:720-726` `touchFeed`: skips reserved and `service:` partitions. `:727-737` `watched(store, partition)`
  wraps a store so commits call `wrote(partition)` (feed + write counter). `:739` `storeFor` = `watched(router.routed(t), t)`.
- `database.ts:930` `const globalBase = tenantApiOver(globalStore, GLOBAL_TENANT, globalStore);`: the App-scoped API
  writes through the *unwatched* `globalStore`, so a global write never touches the feed.
- `database.ts:885` `replicationOver(...)`; `:920` the writer refreshes replicated copies after a global write:
  `Effect.tap(effect, () => Effect.orDie(replication.refresh))`.
- `database.ts:1101-1126` `partitionsPage`: pages `[...shards.keys()]` (the placed shards: not the global or topology
  shard) and skips reserved and `service:` partitions.
- `database.ts:1128-1142` the `followersOver` call: `routed: (p) => router.routed(p)`, `shardFor: (p) => shards.get(shardOf(p))!`.
- `database.ts:1195` `standbyDatabase: (input) => standbyFor({ ...input, store: wholeDatabase(input.scope), follow: followingDatabase(input) })`.
- `src/db/topology-store.ts:254` `PlacementApi` (`current()`, `classOf`, `declare(collection, class)`),
  `:154` `PlacementCatalog { version, collections }`; `:380` `SubdivisionApi` (`current()`, `partsOf`, `subdivide`),
  `:322` `SubdivisionCatalog { version, tenants }`. Reached as `database.topology.placement` / `.subdivision`.
- `src/db/database-service.ts:1055-1081` route `database.followers.partitions` (`POST /followers/partitions`,
  `database.replicate`): the shape to mirror for the new route. `src/db/runtime-api.ts:720` its runtime wrapper.
- `src/sdk/fetch.ts:2698-2720` `createFollowersClient` (paths via `projectPath(projectId, PROJECT_DATABASE_PROXY_PATH + …)`).
- `src/cli/followers.ts:4` the usage line and `:96-103` the `partitions` command: the shape to mirror.
- Tests to mirror: `test/db-follow-database.test.mjs:48-50` (both transports: `localDatabaseLeader(api.database.followers)`
  and `remoteDatabaseLeader(createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch: leaderFetch(api.api) }).followers("p1"))`),
  `:192` the whole-Project failover test; `test/db-replication.test.mjs:29-45` (declare `replicated`, create, write
  through `db.global.documents`); `test/db-backup-parity.test.mjs:285` (`database.topology.subdivision.subdivide("whale", ["a", "b"])`).

**Pattern to mirror:** the divergence fix just made in `resync` (`leader.ts:587-606`): one more field per listing entry,
compared on the follower, no extra request in steady state.

**Traps**
- Routing `zv.global` with `router.routed` or `shardOf`: that hashes the name onto an ordinary shard, which holds the
  *derived* copies. The App-scoped partition is `globalStore` / `globalShard`, on both sides.
- Following the per-shard `zv.global` copies: they are derived and each side's shard layout may differ; rebuild them
  (`replication.refresh`) instead.
- Following the partition map or the placement records: each side's map describes where *it* stored each Tenant. A
  follower that took the leader's map would route Tenants to shards that do not hold them.
- Removing a local `zv.global` because the leader's has no `incarnation` yet: never remove the App-scoped partition.
- A new request per Tenant in steady state: the declarations are read once per resync, not per feed answer.

## 2. Design

- **Authority.** Unchanged: the leader's routes need `database.replicate`; a follower applies what it reads, checked as
  it applies (`EventGap`, `ReplicaDiverged`).
- **What is followed** (decided): every Tenant (as today), every `service:` partition, and the App-scoped partition
  `zv.global` on the global shard. Not followed: the partition map and the placement records (each side's own layout),
  and the derived per-shard copies.
- **Declarations** (decided): the leader answers both catalogs (`{ placements: PlacementCatalog, subdivisions:
  SubdivisionCatalog }`) through `DatabaseLeader.declarations`. A follower reads them at the start of every resync (the
  first listing and every later one), and declares locally what it lacks: `placement.declare(collection, class)` for each
  collection whose class differs, `subdivision.subdivide(tenant, parts)` for each divided Tenant it does not have. A local
  declaration the leader does not have, or a Tenant divided into other parts, is a broken invariant (nothing but
  following declares on a follower), reported with `Effect.die` naming both versions. One read per resync: the rare path.
- **Replicated copies at promotion** (decided): `standbyDatabase` runs `replication.refresh` once, as the writer, after
  the promotion and before the handle is returned, mirroring the writer's own `Effect.orDie(replication.refresh)`
  (`database.ts:920`).
- **Feed.** App-scoped writes touch the feed: `globalBase` uses `watched(globalStore, GLOBAL_TENANT)`, and `touchFeed`
  admits `GLOBAL_TENANT` and `service:` partitions (still skipping every other `zv.` name).
- **Invariants.** (1) A promoted standby holds every partition and declaration the leader had at its last acknowledged
  position, plus the copies derived from them. (2) The App-scoped partition is never removed by a follower. (3) Steady
  state costs the changes: no new per-Tenant request.
- **Failure model.** A failed declarations read fails the resync, which `reachable` retries (as for the listing). A
  declaration that cannot be applied (`PlacementImmutable`, `SubdivisionInvalid`) dies: it means the follower's copy is
  not a copy.
- **Decisions and rejected alternatives.**
  - Follow continuously, not copy at promotion: at a failover the source is gone. Rejected: copying at promotion.
  - Declarations by catalog read, not by following `zv.topology`: following it would also bring the leader's partition map.
  - Plugin partitions are followed: a failover that loses plugin data is a data loss. The comment at
    `database.ts:1097-1099` ("A plugin's private Tenant is not the App's to follow") is about App clients; a standby is a copy.

## 3. Contracts

```ts
// src/db/leader.ts
export interface LeaderDeclarations {
  readonly placements: PlacementCatalog;     // from src/db/topology-store.ts
  readonly subdivisions: SubdivisionCatalog; // from src/db/topology-store.ts
}
// DatabaseLeader gains:
readonly declarations: Effect.Effect<LeaderDeclarations, DbError | InvalidFollowerRequest>;
// FollowersApi gains (the leader side):
readonly declarations: Effect.Effect<LeaderDeclarations>;
// LeaderTransport gains:
readonly declarations: () => Promise<unknown>;
// followersOver's input gains:
readonly declarations: {
  readonly current: () => LeaderDeclarations;
  readonly declare: (wanted: LeaderDeclarations) => Effect.Effect<void>; // applies what is missing, dies on a conflict
};
```
- HTTP: `GET /zelavis/api/v1/database/followers/declarations`, `access: { permissions: ["database.replicate"] }`, answers
  `LeaderDeclarations`. Through the Platform: `GET /runtime/projects/:id/proxy/zelavis/api/v1/database/followers/declarations`.
- SDK: `ZelavisFollowersClient.declarations(): Promise<LeaderDeclarations>`.
- CLI: `zelavis followers declarations --project ID [--json]`; text output one line per placement
  (`<collection>\t<class>`) then one per division (`<tenant>\t<part>,<part>`), or `No declarations.`.
- Wire schema in `leader.ts` beside `PartitionsWire` (`:129`): `DeclarationsWire = Schema.Struct({ placements:
  Schema.Struct({ version: Schema.Finite, collections: Schema.Record(Schema.String, Schema.String) }), subdivisions:
  Schema.Struct({ version: Schema.Finite, tenants: Schema.Record(Schema.String, Schema.Array(Schema.String)) }) })`;
  `remoteDatabaseLeader` reads it with `call("leader.declarations", DeclarationsWire, () => transport.declarations())`
  (as `partitions` does at `:376`), and casts `collections` values to `PlacementClass` after checking each is one of
  the classes `topology-store.ts` accepts.

## 4. Execution steps

### Step 1. A test pins down what a promoted standby lacks today
- **Files:** **NEW** `packages/zelavis/test/db-follow-whole-database.test.mjs`.
- **Change:** for both transports (the `for (const [how, adapt] of [...])` of `db-follow-database.test.mjs:48-50`; import
  `leaderFetch` from `./fixtures/leader-routes.mjs`, `openTemporaryDatabase` from `./_database.mjs`), one test,
  `{ timeout: 120_000 }`:
  arrange a leader and a follower (`openTemporaryDatabase(t, { crossTenantRefresh: false })`); on the leader write:
  `put(leader.api, "acme", "a")` (copy `put` from `db-follow-database.test.mjs:18-22`); an App-scoped collection
  `settings` with document `site` through `leader.database.global.documents`; a replicated collection `plans` declared
  with `leader.database.topology.placement.declare("plans", "replicated")` then created and written through
  `global.documents` (as `db-replication.test.mjs:29-45`); a `service:seo` partition document through
  the entry point plugins use for their `service:` partition. `forTenant` refuses `service:seo` (the Tenant id pattern,
  `src/db/naming.ts` `TENANT_ID_PATTERN`, has no `:`), so find the plugin entry point first:
  `grep -rn "service:" src/db/runtime-api.ts src/app src/core/service | head` from `packages/zelavis`; name it in your
  report. If plugins have no database entry point of their own, drop this assertion and report that; and a divided Tenant
  `whale` (`subdivide("whale", ["a", "b"])`, then a document through `leader.database.forPart("whale", "a")`).
  Act: run `follower.database.followers.followAll(adapt(leader), { name: "east", timeoutMillis: 200 })` until the Tenant
  `acme` is level, interrupt it.
  Assert on the follower: `acme` has `a`; `global.documents.findById({ collection: "settings", id: "site" })` is found;
  `forTenant("acme").shared` (the replicated read handle, `database.ts:97`) finds `plans/pro` after
  `follower.database.replication.refresh`; the `service:seo` document is found; `topology.subdivision.partsOf("whale")`
  is `["a", "b"]` and `forPart("whale", "a")` finds its document.
- **Check:** build, then from `packages/zelavis`: `node --test test/db-follow-whole-database.test.mjs; echo "exit $?"` →
  it **fails**, and the failing assertions are exactly the App-scoped, replicated, plugin and divided ones (the Tenant
  passes). Record which ones failed in your report. Leave the test failing until steps 2–5.

### Step 2. The App-scoped partition is followed, on the global shard on both sides
- **Files:** `packages/zelavis/src/db/leader.ts`, `packages/zelavis/src/db/database.ts`.
- **Change:**
  - `validFollowerPartition` (`leader.ts:442`): admit `GLOBAL_TENANT`; keep refusing every other `zv.` name
    (`isReservedTenantId(partition) && partition !== GLOBAL_TENANT`).
  - `database.ts` `followersOver({...})` (`:1128`): `routed: (partition) => partition === GLOBAL_TENANT ? globalStore : router.routed(partition)`,
    `shardFor: (partition) => partition === GLOBAL_TENANT ? globalShard : shards.get(shardOf(partition))!`.
  - `partitionsPage` (`:1101`): on the first page (`after === undefined`) put `GLOBAL_TENANT` first, counting toward
    `limit`; the `next` encoding is unchanged (it continues within the placed shards).
  - `touchFeed` (`:720`): admit `GLOBAL_TENANT` (`(!isReservedTenantId(p) || p === GLOBAL_TENANT)`).
  - `globalBase` (`:930`): `tenantApiOver(watched(globalStore, GLOBAL_TENANT), GLOBAL_TENANT, globalStore)`. `watched` is
    declared at `:727`, after `globalStore` (`:659`) and before `:930`, so it is in scope.
  - `level` (`leader.ts:556`) and `prune` (`:608`): never remove `GLOBAL_TENANT`: in `level`'s no-incarnation branch,
    skip `input.remove` for it; in `prune`, filter it out before checking the leader.
- **Imports:** `GLOBAL_TENANT` in `leader.ts` (already imported, `:445` uses it); nothing new in `database.ts`.
- **Check:** build; `node --test test/db-follow-whole-database.test.mjs test/db-follow-database.test.mjs; echo "exit $?"`.
  The App-scoped assertion now passes; `db-follow-database.test.mjs` passes. If one of its call-count assertions fails by
  one (the listing now holds `zv.global`), raise that bound by one and say so in your report; any other difference is a finding.

### Step 3. Plugin partitions are followed
- **Files:** `packages/zelavis/src/db/database.ts`.
- **Change:** `partitionsPage` and `touchFeed` stop skipping `service:` partitions (remove the `!partition.startsWith(SERVICE_TENANT_PREFIX)`
  condition in both); update the comment at `:1097-1099` to say a follower copies every partition, plugin ones included,
  because a standby is a copy and not an App client. Leave `cross-tenant-index.ts:212` as it is (indexes still never read plugins).
- **Check:** build; the two test files as in step 2; the plugin assertion passes.

### Step 4. The leader's declarations reach the follower
- **Files:** `packages/zelavis/src/db/leader.ts`, `packages/zelavis/src/db/database.ts`.
- **Change:** add the contracts of section 3. `followersOver` input `declarations` is provided by `database.ts`:
  `current: () => ({ placements: topology.placement.current(), subdivisions: topology.subdivision.current() })`;
  `declare(wanted)`: for each `[collection, cls]` of `wanted.placements.collections` whose
  `topology.placement.classOf(collection)` differs, `topology.placement.declare(collection, cls)`; for each
  `[tenant, parts]` of `wanted.subdivisions.tenants`: absent locally → `subdivide(tenant, parts)`; present with other
  parts → die; each local entry absent from `wanted` → die. Errors of `declare`/`subdivide` → `Effect.orDie`.
  In `followAll` (`leader.ts`, the loop around `:620`), right after `retry.clear()` and before `prune`, run
  `yield* leader.declarations.pipe(Effect.flatMap(input.declarations.declare), reachable)`.
  The leader's `FollowersApi.declarations` = `Effect.sync(input.declarations.current)`; `localDatabaseLeader` passes it
  through; `remoteDatabaseLeader` reads `DeclarationsWire`.
- **Check:** build; `node --test test/db-follow-whole-database.test.mjs; echo "exit $?"`: the divided-Tenant assertion
  passes in-process. The HTTP case passes once step 6 adds the route; until then that case fails at the transport (expected).

### Step 5. A promoted standby rebuilds its replicated copies before it writes
- **Files:** `packages/zelavis/src/db/database.ts`, `packages/zelavis/test/db-follow-whole-database.test.mjs`.
- **Change:** `standbyDatabase` (`:1195`): `standbyFor({...}).pipe(Effect.tap(() => Effect.orDie(replication.refresh)))`.
  Add a second case to the test: a standby (`follower.database.writerLeases.standbyDatabase({ scope: "p1", leases, owner: "east", ttlMillis: 1000, standby: "west", leaderFor: () => adapt(leader) })`
  with `memoryLeaseStore()` from `../dist/db/writer-lease.js`, and the leader holding the lease with
  `holdDatabase({ scope: "p1", leases, owner: "west", ttlMillis: 1000, standby: "east" })`, as the failover test at
  `db-follow-database.test.mjs:192` does). Release the leader's lease, wait for the promotion, then assert
  `forTenant("acme").shared` finds `plans/pro` **without** calling `refresh` in the test.
- **Check:** build; the test file passes in-process.

### Step 6. The declarations over HTTP, the SDK and the CLI
- **Files:** `packages/zelavis/src/db/database-service.ts` (route beside `database.followers.partitions`, `:1055`),
  `packages/zelavis/src/db/runtime-api.ts` (wrapper beside `:720`), `packages/zelavis/src/sdk/fetch.ts`
  (`createFollowersClient`, `:2698`; the `ZelavisFollowersClient` interface), `packages/zelavis/src/cli/followers.ts`
  (usage line `:4`, a `declarations` command beside `partitions` `:96`), `packages/zelavis/test/fixtures/leader-routes.mjs`
  if it lists routes by hand (check).
- **Change:** route `{ id: "database.followers.declarations", method: "GET", access: { permissions: ["database.replicate"] },
  path: "/followers/declarations", spec: { operationId: "databaseFollowerDeclarations", summary: "The placement classes and divisions a follower must declare", tags: ["database"], responses: { 200: { description: "{ placements, subdivisions }" } } },
  handler: ({ service }) => present(Effect.gen(function* () { return { body: yield* integration(() => service.followers.declarations()) }; }).pipe(Effect.catchCause((cause) => Effect.succeed(followerErrorResponse(cause))))) }`;
  SDK `declarations: () => json(projectPath(projectId, \`${PROJECT_DATABASE_PROXY_PATH}/followers/declarations\`))`;
  CLI command `declarations` printing the text form of section 3.
- **Check:** build; `node --test test/db-follow-whole-database.test.mjs test/capability-parity.test.mjs; echo "exit $?"` → `exit 0`
  (both transports pass now).

### Step 7. Docs
- **Files:** `website/src/content/docs/api/database.md` ("Followers on other hosts", `:95`; "Writer leases and follower
  failover", `:148`); `.agents/references/effect-cluster-decision.md` (phase 3 list).
- **Change:** docs: what a whole-database follower copies (Tenants, plugin partitions, App-scoped collections, the
  placement classes and divisions) and what each side keeps its own (partition map, shard placement), that a promoted
  standby rebuilds its replicated copies, and the `declarations` route with its SDK and CLI forms. Decision record:
  delete the item "Copy the reserved partitions …" (done, by following).
- **Check:** `pnpm run docs:check; echo "exit $?"` from the repository root → `exit 0`.

### Step 8. Self-audit
See section 8. From the repository root: `pnpm run verify; echo "exit $?"` → `exit 0`.

## 5. Tests
- `db-follow-whole-database.test.mjs`, both transports: a promoted copy holds Tenant, App-scoped, plugin, replicated and
  divided data (fails before, passes after); the standby rebuilds replicated copies at promotion.
- Failure paths: add a case where the follower already has a division the leader lacks (subdivide on the follower
  first) and assert the follow dies with a message naming the Tenant; and a case where the leader's `declarations`
  fails once (a `counting`-style wrapper, `db-follow-database.test.mjs:26-45`) and the follow still converges.
- `db-follow-database.test.mjs` unchanged except a call-count bound if step 2 needs it; `capability-parity.test.mjs` covers the route.
No dashboard change, so no browser test.

## 6. Docs and project notes
Step 7. No `pnotes/` change.

## 7. Verification
From the repository root: `pnpm run verify; echo "exit $?"` → `exit 0`; `pnpm run docs:check` → `exit 0`. The owner should
re-run `pnpm release:qualify:failover` afterwards (00-overview.md, owner work), because this part changes what is followed.

## 8. Instructions to the implementer

> **Before changing anything, read `Status` and `## Progress`.**
> - First compare `Verified-at` with `HEAD`; `leader.ts` and `database.ts` were uncommitted when this was written, so
>   check every quoted line of them against the file before its step, and stop and report when one no longer matches.
>   `Status: needs replanning` means stop at once.
> - `Status: planned`: you are the first. Set `Status: in progress` here and in `00-overview.md`.
> - Anything else: you are continuing. Read every `## Execution report` entry, confirm the last `[x]` step's check still
>   passes, finish or redo the `[~]` step, never redo `[x]`.
> - `Status: in progress` and you were asked to *execute*: stop and ask the user.
>
> Read the earlier parts' execution reports in this folder; if a deviation there affects this part, stop and report.
>
> **Keep `## Progress` current** (`[~]` with the date before a step's first edit, `[x]` with date and note once its check
> passed). Build before running tests (`pnpm --filter zelavis run build`; success is exit 0 with no `error TS`). The shell is
> zsh: use `; echo "exit $?"`.
>
> Read section 1 first and return to it when unsure. Do the steps in order; tests you write run in the same step. Do not
> redesign or improve anything not asked for; match the surrounding style.
>
> **Stop and report instead of improvising** when a cited line or symbol differs, a check fails for a reason that is not a
> simple mistake in your change, a gate (`check:tigerstyle`, `check:effect-usage`, repo rules, capability parity) would need
> a suppression, baseline entry, wrapper or shim, or the plan seems to contradict `AGENTS.md` (which wins).
>
> **An unexpected result is a finding, never noise**: investigate it here until you know its cause; fix it if it stays in
> this part's files and rules, otherwise report the cause and your proposed fix.
>
> Never: compatibility aliases or fallbacks, silent catches, `try/catch` in Platform code, `Effect.ignore`, unbounded
> concurrency (use the existing `concurrency` value), unchecked `JSON.parse` casts, Promise orchestration in Platform code,
> a second follower algorithm for HTTP, anything in `.claude/` or `pnotes/`, edits to `dist/`, `website/dist/`,
> `website/.astro/` or `repos/effect/`. Never touch other people's uncommitted files. Do not commit, push or publish.
>
> **Self-audit before you report done** (step 8): re-read the diff against sections 1–5; check each Done means item; rerun
> the tests this part touched and `pnpm run verify` after your last edit; search the diff for forbidden patterns, debug
> output and TODOs; every unexpected result has a known cause. Record the audit.
>
> When you finish or stop, add `### Session <n>: <date>` under `## Execution report`: final status (update `Status` here and
> in `00-overview.md`), each step one line, verification results, deviations and why, anything undone, **Context the plan
> lacked** ("none" if nothing). Then give the user the same report, shortened.

## Execution report

### Session 1: 2026-11-03
Status: done.
- Step 1: `test/db-follow-whole-database.test.mjs` failed as planned: only the Tenant survived; App-scoped, plugin, replicated and divided were all missing.
- Steps 2–3: `zv.global` admitted by `validFollowerPartition`, routed to `globalStore`/`globalShard` on both sides, listed first, written through `watched(globalStore)`, never removed by a follower; `service:` partitions listed and fed. The plugin entry point is `database.forTenant("service:<name>")` (it is not refused, contrary to the plan's guess; `src/app/app-service.ts:16` uses it).
- Step 4: `declarations` on `DatabaseLeader`, `FollowersApi`, `LeaderTransport` and `followersOver`; read once at the start of every resync, before `prune`; conflicts die naming both versions.
- Step 5: `standbyDatabase` runs `replication.refresh` after promotion (proved by removing it: the promotion test fails).
- Step 6: route `database.followers.declarations`, runtime wrapper, SDK `client.followers(id).declarations()`, CLI `zelavis followers declarations`; `capability-parity` passes.
- Step 7: `database.md` and the decision record (item deleted).
- Step 8: `pnpm run verify` exit 0; `check:tigerstyle` and `check:effect-usage` exit 0; no `try/catch`, console output or TODO in the diff.

Deviations:
1. Two existing tests changed deliberately: `db-database-service.test.mjs` lists the new route; `db-remote-follower.test.mjs` no longer expects `stats("zv.global")` to be refused (it expects `zv.topology` to be) and expects `zv.global` first in the listing. `db-follow-database.test.mjs` needed no change.
2. Extra tests beyond the plan's list: a promotion case (both transports), a follower with a division the leader lacks, a flaky declarations read.

Findings:
- **Flaky pre-existing test.** `db-follow-database.test.mjs` "a Tenant whose log is as long as the leader's but ends in a different event is leveled at resync" fails intermittently (about 1 run in 3) on the tree *without* this part's changes too (checked by reverting the part's edits). Cause: `tipOf` (`leader.ts`) identifies the tip by tag, origin, generation, seq, version and `at`, but not by the record identity, so two writers committing to the same position within the same millisecond compare equal and the divergence goes undetected. It belongs to the uncommitted divergence fix in the working tree; adding the event's `identity` to the tip string is the likely fix. Not changed here.
- A Tenant divided on the leader after a resync is declared on the follower only at the next resync (the declarations are read once per resync, as designed); a standby promoted in that window lacks the division. Closing it needs the feed to name a declarations change; recorded in the docs.

Undone: nothing in scope. Owner: re-run `pnpm release:qualify:failover` (this part changes what is followed).
Context the plan lacked: `forTenant("service:…")` is allowed; `forPart` throws synchronously (`UnknownPart`) on an undivided Tenant; `opened.database` is the Effect API and `opened.api` the Promise one.
