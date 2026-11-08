# Part 5 (B): replica shards — the operation, the replicator, every surface and the proofs
Job: Remote App shards beyond bytes, part 5: a shard may have one replica, a durability copy on another Node kept level from the single writer, with SDK, HTTP, CLI and dashboard, proven by seeded crash tests, a real Platform with two Agents and the container drill.
Date: 2026-11-08
Status: partly done
Verified-at: 53c038e024 (plus the uncommitted working tree of 2026-11-08)
Part: 5 of 5. Read 00-overview.md first.

To start:    Execute part 5 in .agents/plans/2026-11-08-remote-shard-reads-and-replicas/05-replica-shards.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-08-remote-shard-reads-and-replicas/05-replica-shards.md. Start with its section 8.

## Progress
- [x] 1. (2026-11-08) Record replicas beside the shards and open them through the Project channel — TypeScript build and all 7 node-host tests passed.
- [x] 2. (2026-11-08) Write `src/db/shard-replicas.ts`: replica handles, the replicator, status — Build, both source gates and all 6 shard-leader tests passed using the production follower side.
- [x] 3. (2026-11-08) Add the `replicate` and `unreplicate` operations to the shard workflow — TypeScript build passed with both durable operations and nested replica listing.
- [x] 4. (2026-11-08) Wire replicas into the database — TypeScript build and all 26 placement and remote-shard tests passed.
- [x] 5. (2026-11-08) Expose replicate, unreplicate and replica status through HTTP, SDK and CLI — TypeScript build and 28 parity, database route, SDK and CLI tests passed.
- [x] 6. (2026-11-08) Prove the operation and the copy at the database level (crash at every phase, convergence, invisibility, outages) — All 19 tests passed, including 140 phase-crash cases and 20 convergence seeds.
- [x] 7. (2026-11-08) Prove it with a real Platform, two Agents and a Project — All 3 targeted replica tests passed, then all 12 real Platform integration tests passed.
- [x] 8. (2026-11-08) Show and manage replicas on the Database → Shards page, with a browser test — Dashboard typecheck, all 87 unit tests and ci:ui passed, including the 0 MiB browser refusal.
- [x] 9. (2026-11-08) Extend the container drill — Workspace build and Docker drill passed after adding a release-to-replica handshake.
- [x] 10. (2026-11-08) Docs and guard-removal proofs — Docs check passed. B3, B4 and B5 each failed with their own guard removed, then the original sources were restored.
- [!] 11. A drill across real separate machines (old follow-ups item A3): needs the owner's machines; run `pnpm release:qualify:shards` with the Agent on a second host and record the result
- [x] A1. (2026-11-08) Retry interrupted abandonment cleanup. Review found the workflow could stop driving a reserved replica if its release hit a transient failure while settling a refusal. Prove two release attempts and a settled reservation. — The activation-refusal test proved two release attempts and a released reservation.
- [x] A2. (2026-11-08) Report colocation from the authenticated writer Node. The Node database adapter labels its local database origin `local`. Prove the Project channel returns the current writer Node and the replica view uses it. — Project channel, channel client and replica-list tests passed.
- [x] 12. (2026-11-08) Self-audit — Final verify, ci:ui, docs:check, Docker drill and diff checks passed.

## 0. Summary and finish line

After this part an operator can give any shard of an App's database — local or remote — one replica on another Node, and remove
it. The writer process reserves it through the Platform (part 4's ledger), opens it as a remote KV shard whose writer claim it
holds, and keeps it level with `followPartitions(shardLeader(…))` (part 4). The replica is reported with its lag and status; it is
never routed to, read by Tenant operations, upkept, listed as data or promoted (D4, D5). Deleting the Project or removing the
replica releases its storage on its Agent.

**In scope:** node-host locations and replica opening; `src/db/shard-replicas.ts` (NEW); the operation in `shard-placement.ts`;
database wiring; runtime API, HTTP routes, SDK, CLI; the Shards page; tests at every level; the drill; docs.
**Out of scope:** promotion and recovery from a replica (D4), reads from replicas (D5), per-write acknowledgments (D6), more than
one replica per shard, replicas for a lease-guarded Project (refused like remote primaries).

**Done means:**
- `POST database/shards/:shardId/replicate` and `/unreplicate` exist with SDK `client.shards(id).replicate|unreplicate` and CLI
  `zelavis shards replicate|unreplicate`; `test/capability-parity.test.mjs` passes with them.
- B3, B4 and B5 pass and each fails with its guard removed (recorded).
- A real Project replicates a local shard onto one Agent and a remote shard onto a second Agent; the copies converge; cutting the
  replica's Agent changes nothing for the primary and the copy catches up after; unreplicating and deleting the Project remove the
  Agents' storage.
- The Shards page shows each shard's replica (Node, status, lag) and offers add/remove; `pnpm run ci:ui` passes with the new action.
- The drill passes with the replica phase (or `[!]` without Docker).
- Contract, `AGENTS.md`, website fabric and database API pages describe replica shards as built durability copies, with every limit.
- `pnpm run verify`, `pnpm run docs:check` → `exit 0`.

**Supplement:** see `00-overview.md` section 0.

## 1. Context packet

**Glossary:** as in `00-overview.md` (replica, replicator, primary, writer claim, shard epoch) and part 4 (side, shard leader).

**Governing rules (quoted).**
- "Replicas never imply multiple writable owners" (`AGENTS.md § Project Vision`).
- "Any new Platform resource keyed by Project identity must register a cleanup participant" (`AGENTS.md § Platform And App Service
  Boundary`): replicas are ledger entries, already covered by `revokeAll` (the deletion participant); part 4 orders replicas first.
- "Every official public Zelavis capability must be available through the official JavaScript SDK, versioned HTTP API, and CLI."
  (`AGENTS.md § Endpoint-Backed Capability Rule`)
- "Everything that can survive a reload must be in the URL" and "Do not add title blocks that repeat the breadcrumb"
  (`AGENTS.md § UI Package Rules`).
- "Do not describe automatic failover or distributed replication as operational before their own gates pass" (contract).

**System today (and after parts 1–4).**
- `src/db/node-host.ts`: `readShardLocations`/`writeShardLocations` (`:276`, `:293`) keep `{ remote: string[] }` in
  `shard-locations.json` beside the shards; `openShardWith` (`:116`) opens a listed shard over the channel (`access`, `remoteShardAccess`,
  `makeRemoteKvEngine`, `openShardOverKv`, 30 s open timeout); the lease-guarded refusal (`:193–195`); `shardPlacement` host
  (`:197–214`) with `remote`, `markRemote`, `forgetRemote`.
- `src/db/shard-placement.ts`: `ShardOperation` (`:37`: `kind: "place" | "release"`), phases (`:32`), `step` (`:263`), `settle`
  (`:363`), `drive` (`:369`: transient failures retried with backoff, `Definitive`/refusals settle), `api.place|release|list`
  (`:396–527`), `resume` (`:529`); one operation at a time (`guardFree`). Part 4 added `intent`/`of` to `host.request` and
  `role`/`of` to the view.
- `src/db/database.ts`: `shards` Map (`:688`), the unavailable/reopen pattern (`:708`, `:1172`), `followers` (`:1272`),
  `shardOperations = shardPlacementOver({...})` (`:1189`), the API object (`:1361`). Part 4 added `followPartitions` and
  `shardLeader` in `src/db/leader.ts` and wired it through `DatabaseApi.shardLeaderFor` (see part 4's report).
- Surfaces today: runtime API `shards` (`src/db/runtime-api.ts:368–373`, impl `:743–748`); HTTP routes `database.shards.*`
  (`src/db/database-service.ts:1598–1656`, `shardErrorResponse`); SDK `ZelavisShardsClient` and types (`src/sdk/fetch.ts:890–925`,
  `createShardsClient` `:2816`); CLI table (`src/cli/shards.ts`); permission `database.shards.manage` delegated by the Gateway
  (`src/platform/project-gateway.ts:151`); parity regex for `shards(input).X(` (`test/capability-parity.test.mjs:67`).
- Dashboard: `packages/zelavis/services/zelavis-ui/app/shards-page.ts` (`shardsScreen`, rows built at `:47–57`, `act`, `canManage`,
  form patterns `:69–85`); browser case in `scripts/test-route-parity.mjs:332–338` (visits `/projects/parity-lab/database/shards`,
  checks a client-side refusal before anything is sent).
- Real-process test: `test/app-shard-remote.test.mjs` `setup` (one Agent "node-b" behind `startProxy`, `projects.remoteDispatch.nodes`
  at `:123`, `self.allocate` at `:145`, `self.agentShards()` at `:96`).
- Seeded crash pattern: `test/db-shard-placement.test.mjs` (`makeWorld` `:27`, `crashing` `:49`, `openShardFor` `:67`, `hostFor` `:82`,
  `crashCase` `:332`, 20 seeds `:371`).
- Drill: `distribution/scripts/qualify-shards.mjs`, `distribution/scripts/shards/{platform,agent}.mjs`.

**Traps.**
- Putting the replica's store in `shards` → it would be routed, listed, upkept, scattered and counted by `wholeDatabaseAvailable`.
- A replica's outage failing anything else → it must not: replicas are not part of any answer.
- Acknowledging the replica's positions to the leader → no (D6, per-Tenant state).
- Reading `replicas` from a copy made at open → read the Map when each effect runs (W5).
- A dashboard form whose values are lost on reload → keep the disk size in the form only (it is an action input, not a view state);
  the page's view state is unchanged.

## 2. Design

- **Authority:** the Platform admits and commits (part 4); the writer process holds the replica's claim and is its only writer; the
  operator acts through `database.shards.manage`.
- **Persistence:**
  - `shard-locations.json` becomes `{ "remote": ShardId[], "replicas": { "of": ShardId, "shard": ShardId }[] }`, both keys required,
    written by temp-file-and-rename as now. The file is new in this uncommitted feature; there is no older shape to accept.
  - The operation record (`zv.shard-op`) gains kinds `replicate` and `unreplicate` and the field `of`; for them `shardId` is the
    replica id `<of>.replica` and `virtualRanges` is `[]`.
- **Phases:**

  | Kind | Phase → next | Effect recorded before the next phase is written |
  |---|---|---|
  | replicate | requested → reserved | `host.request({ intent: "replica", of, shardId, virtualRanges: [], resources: { cpuCores: 0, memoryBytes: 0, diskBytes } })` (idempotent by operation id) |
  | | reserved → activated | `host.activate(...)` (idempotent) |
  | | activated → opened | `host.markReplica(of, shardId)`, then `replicas.open(of, shardId)` (opens the store, starts the replicator) |
  | | opened → done | none |
  | unreplicate | requested → closed | `replicas.close(of)` (stops the replicator, closes the store), then `host.forgetReplica(of)` |
  | | closed → released | `host.release(...)` (the Agent removes its storage) |
  | | released → done | none |

  A replicate that cannot finish (a refusal or a definitive failure at any phase after `requested`) is abandoned: `replicas.close(of)`
  if open, `host.release` (a refusal ignored, as `abandonPlace` does), `host.forgetReplica(of)`, `failed` with the reason. Transient
  failures are retried by `drive` as today.
- **Invariants:** B3, B4, B5; one replica per shard; a replica of a lease-guarded Project is refused (the existing open-time refusal
  counts listed replicas too, and the Platform's activation answers `lease-guarded`).
- **Replicator** (per open replica, in its own child scope of the database scope): `followPartitions(shardLeader(of), replicaSide(store),
  { name: "replica:" + shardId, concurrency: 8, timeoutMillis: 5000, turns })`; if it ends (it ends only by a failure the loop does
  not retry), log with the cause, set `unavailable`, wait 5 s and start it again. Status (in memory, per replica): `seeding` until a
  turn with `level`; then `following`, or `behind` when `now − heldAsOf > 60 000`; `unavailable` while the store is not
  open (an unreachable Agent at open or after the replicator failed). `heldAsOf` = `asked` of the last turn with `level`.
  The loop always resyncs before reporting any level turn. Work left by the initial listing can finish on a later turn
  where `resynced` is false.
- **Opening:** at database open, each listed replica is opened like a remote shard (through the channel, 30 s timeout); a failure is
  logged and the replica is `unavailable`, retried every 5 s by its own loop (the pattern of `database.ts:1172`); the database opens
  regardless. Primaries are opened first; replicas never delay serving.
- **Failure model (operator):** `ShardOperationInvalid` (400) for: a shard that is not part of the database; a shard that is itself
  a replica; a second replica; `diskBytes` not a positive integer; `release` of a shard with a replica ("shard X has a replica:
  unreplicate it first"); `unreplicate` of a shard with none. `ShardOperationInProgress` (409), `ShardPlacementRefused` (409, the
  Platform's reason), `ShardPlacementUnavailable` (503) as for place.
- **Bounds:** one replica per shard; the replicator's work per turn is bounded by `followPartitions` (concurrency 8, 64 batches per
  pass, retry set capped at 10 000); reopen every 5 s.
- **Decisions:** described above and in D2, D4–D6, D8. **Rejected:** opening the replica lazily on the first write (a copy must be
  current without traffic); a replica of a replica.
- **Decisions taken for the user:** the dashboard's default replica disk is the primary's reserved disk when known, else 8192 MiB.
- **Needs from the user:** the owner's separate machines for step 11 (`[!]`).

## 3. Contracts

**HTTP** (database service, under the Project's `database/` API):
- `POST /shards/:shardId/replicate`, access `database.shards.manage`, body `{ "resources": { "diskBytes": positive integer } }` →
  `202 { operation }`; `400 { error, code: "invalid-request" }` for a bad body; errors through `shardErrorResponse` (400 invalid, 409
  in progress or refused, 503 no channel). Spec: `operationId: "replicateDatabaseShard"`, summary "Give a shard a replica on another
  Node", description "Reserves a durability copy of the shard on a Node other than its own, opens it and keeps it level from the
  shard's log. The replica is never read or promoted. Answers 202 with the recorded operation."
- `POST /shards/:shardId/unreplicate`, access `database.shards.manage`, no body → `202 { operation }`. `operationId:
  "unreplicateDatabaseShard"`, summary "Remove a shard's replica".
- `GET /shards` entries gain `replica` (below).

**Types** (`src/db/shard-placement.ts`, mirrored in `src/sdk/fetch.ts` as `ZelavisShardReplica` and in `ZelavisShardOperation.kind`):
```ts
export interface ShardReplicaDescription {
  readonly shardId: ShardId;                 // `${of}.replica`
  readonly nodeId?: string;                  // from the Platform's view, when reachable
  readonly epoch?: number;
  readonly state?: string;                   // ledger state
  readonly status: "seeding" | "following" | "behind" | "unavailable";
  readonly heldAsOf?: string;                // ISO time
  readonly lagMillis?: number;
  readonly colocated?: true;                 // the replica's Node is this database's Node (a moved Project)
}
// ShardDescription gains: readonly replica?: ShardReplicaDescription;
// ShardOperation.kind: "place" | "release" | "replicate" | "unreplicate"; ShardOperation gains readonly of?: ShardId;
// ShardPlacementApi gains:
readonly replicate: (input: { readonly shardId: ShardId; readonly resources: { readonly diskBytes: number } }) => Effect.Effect<ShardOperation, DbError | ShardPlacementError>;
readonly unreplicate: (input: { readonly shardId: ShardId }) => Effect.Effect<ShardOperation, DbError | ShardPlacementError>;
// ShardPlacementHost gains:
readonly replicas: Effect.Effect<ReadonlyArray<{ readonly of: ShardId; readonly shard: ShardId }>, StoreError>;
readonly markReplica: (of: ShardId, shard: ShardId) => Effect.Effect<void, StoreError>;
readonly forgetReplica: (of: ShardId) => Effect.Effect<void, StoreError>;
// MakeDatabaseOptions gains:
readonly openReplica?: (shard: ShardId) => Effect.Effect<ShardStoreApi, StoreError, Scope.Scope>;
```
**Runtime API** (`DatabaseRuntimeApi.shards`): `replicate(shardId, { diskBytes })`, `unreplicate(shardId)` → `Promise<ShardOperation>`.
**SDK** (`ZelavisShardsClient`): `replicate(shardId: string, input: { readonly diskBytes: number }): Promise<ZelavisShardOperation>`
(posts `{ resources: { diskBytes } }`), `unreplicate(shardId: string): Promise<ZelavisShardOperation>`.
**CLI** (`zelavis shards`): `replicate <shard> --project ID --disk BYTES [--json]`, `unreplicate <shard> --project ID [--json]`;
usage string updated; text output via `describeOperation`; `list` text adds ` · replica on <node> (<status>, <lag> ms behind)`.

## 4. Execution steps

### Step 1. Record replicas beside the shards and open them through the Project channel
1. **Goal:** the host records which shards have replicas and can open one.
2. **Files:** `src/db/node-host.ts`; `test/db-node-host-shards.test.mjs`.
3. **Context:** `readShardLocations`/`writeShardLocations`, `openShardWith`'s remote branch, the lease refusal, the `shardPlacement`
   host object.
4. **Change:** `readShardLocations` answers `{ remote, replicas }` (parse both keys, required); writers keep the other key. Add
   `replicas`, `markReplica`, `forgetReplica` to the host; add `openReplica(shard)` to the `makeDatabase` options: the same remote open
   as a listed shard (channel `access(shard)`, `remoteShardAccess`, `makeRemoteKvEngine`, `openShardOverKv`, 30 s). The lease refusal
   also fires when `replicas` is non-empty. Update every caller of `readShardLocations` (grep it). Tests: "a locations file with a
   replica lists it, and a lease-guarded open refuses it"; "a locations file without the replicas key is malformed".
5. **Depends on:** parts 4.
6. **Check:** after a build, `cd packages/zelavis && node --test test/db-node-host-shards.test.mjs; echo "exit $?"` → `exit 0`.

### Step 2. Write `src/db/shard-replicas.ts`
1. **Goal:** open replicas, keep each level, report status.
2. **Files:** `src/db/shard-replicas.ts` (NEW).
3. **Context:** section 2 (replicator, status, opening); part 4's `followPartitions`, `FollowerSide`, `shardLeader`; the test-only
   `replicaSide` of `test/db-shard-leader.test.mjs` moves here as `replicaSide(store: ShardStoreApi): FollowerSide`.
4. **Change:** `shardReplicasOver(input: { scope; openReplica; leaderFor: (of: ShardId) => DatabaseLeader; nodeId: string })` →
   `{ open(of, shard): Effect<void, DbError>, close(of): Effect<void>, list: Effect<ReadonlyMap<ShardId, ShardReplicaDescription>>,
   has(of): boolean, resume(listed): Effect<void> }`, holding `Map<ShardId /* of */, { shard, scope, store?, status }>`; `resume`
   opens each listed replica, falling back to `unavailable` plus the reopen loop on failure (never failing the database); the
   replicator per section 2 with `Clock`-based lag.
5. **Depends on:** 1.
6. **Check:** build → no `error TS`; `pnpm check:effect-usage && pnpm check:tigerstyle; echo "exit $?"` → `exit 0`.

### Step 3. Add the `replicate` and `unreplicate` operations
1. **Goal:** the durable workflow of section 2's table.
2. **Files:** `src/db/shard-placement.ts`.
3. **Context:** `isOperation` (`:126`, add the kinds and `of`), `step` (`:263`), `settle` (`:363`), `abandonPlace` (`:239`), `api` (`:396`),
   `list` (`:502`).
4. **Change:** `shardPlacementOver` takes `replicas` (the step 2 API). Add the phases to `step` by kind; `abandonReplicate` used by
   `settle` for a replicate past `requested`; `api.replicate` and `api.unreplicate` with section 2's validation (`release` gains the
   "has a replica" refusal); `list` adds `replica` per shard from `replicas.list` and the Platform view's `role: "replica"` entries;
   `nextShardId` ignores `*.replica` names.
5. **Depends on:** 2.
6. **Check:** build → no `error TS`.

### Step 4. Wire replicas into the database
1. **Goal:** replicas open with the database, outside `shards`.
2. **Files:** `src/db/database.ts`.
3. **Context:** `shardPlacementOver({...})` (`:1189`), the `followers` construction (`:1272`), the reopen pattern (`:1172`).
4. **Change:** build `shardReplicasOver` after `followers` exists (move `shardOperations` below `followers` if needed, keeping
   `shardOperations.resume` last as now); `leaderFor(of)` is part 4's `shardLeader` over this database; pass `options.openReplica`;
   call `replicas.resume(yield* host.replicas)` after the shards are open; give `shardPlacementOver` the replicas API. Nothing adds a
   replica store to `shards`.
5. **Depends on:** 3.
6. **Check:** build → no `error TS`; `cd packages/zelavis && node --test test/db-shard-placement.test.mjs test/db-remote-shard.test.mjs; echo "exit $?"` → `exit 0`.

### Step 5. Expose replicate, unreplicate and replica status through HTTP, SDK and CLI
1. **Goal:** parity.
2. **Files:** `src/db/runtime-api.ts` (`:368`, `:743`), `src/db/database-service.ts` (beside `database.shards.release`, `:1641`),
   `src/sdk/fetch.ts` (types `:890–925`, `createShardsClient` `:2816`), `src/cli/shards.ts`, `website/src/content/docs/api/database.md`
   (route table), `test/capability-parity.test.mjs` (only if a declaration is needed; the regex already maps `shards(input).X(`).
3. **Context:** section 3; mirror `release` in each file.
4. **Change:** add both operations in all four places; CLI actions `replicate` (requires `--disk`, `needed(input, "--disk")`) and
   `unreplicate`; `valued` keeps `--disk`.
5. **Depends on:** 4.
6. **Check:** after a build, `cd packages/zelavis && node --test test/capability-parity.test.mjs test/db-shards-surfaces.test.mjs; echo "exit $?"` → `exit 0`
   (add to `test/db-shards-surfaces.test.mjs` the cases: SDK and CLI `replicate`/`unreplicate` call the routes and answer the operation;
   a missing `--disk` is a CLI usage error; a body without `resources.diskBytes` is 400 `invalid-request`).

### Step 6. Prove the operation and the copy at the database level
1. **Goal:** B3, B4, B5.
2. **Files:** `test/_shard-world.mjs` (NEW: `prng`, `makeWorld`, `engineFor`, `crashing`, `openShardFor`, `hostFor`, `openDatabase`,
   `seedTenants`, `readAll`, `waitFor`, `operationOf`, `finished` moved from `test/db-shard-placement.test.mjs:15–176`, which then
   imports them), `test/db-shard-replicas.test.mjs` (NEW).
3. **Context:** the world's fake host (`hostFor`) must learn `intent: "replica"` (record `role`, `of`, assign "node-c"), `replicas`,
   `markReplica`, `forgetReplica`; `openReplica` opens `openShardOverKv(shard, engineFor(world.replicaEngines, shard))` and honours
   `world.failOpens`.
4. **Change — tests:**
   - **"a crash at every phase of replicate and unreplicate resumes to the same end (20 seeds)"** (B5): `crashCase`-style for phases
     `requested, reserved, activated, opened` (replicate) and `requested, closed, released` (unreplicate); after resume the operation
     is `done`, every Tenant reads as before, and (replicate) the replica converges (below) or (unreplicate) the replica is gone and its
     ledger entry `released`.
   - **"a replica converges to its primary through writes, moves, compaction and outages (20 seeds)"** (B3): per seed, a random
     sequence of document writes on Tenants of both shards, a rebalance moving a range on or off the replicated shard, a
     `maintenance.compact({ keep: 0 })`, and a replica outage (`world.failOpens` plus closing and reopening the replica engine, or a
     wrapper failing its writes for a while); then quiet: `waitFor` status `following`; compare, for every non-reserved partition of
     the primary store, `stats.head`, `stats.records` and every record (`scanRecords` pages) with the replica's; and the replica holds
     no other non-reserved partition. Print the seed on failure.
   - **"a replica is invisible to routing, listings, upkeep and scatter, and its outage does not touch the primary"** (B4): with a
     replica that is `unavailable` (its opens fail): `db.partitions`, `db.maintenance.status`, `db.scatter` and every Tenant read and
     write succeed and none names the replica's shard id; `db.shards.list` does not include it.
   - **"release of a shard with a replica is refused; unreplicate then release succeeds"**, **"a second replica is refused"**,
     **"replicating a replica is refused"**.
5. **Depends on:** 4.
6. **Check:** after a build, `cd packages/zelavis && node --test test/db-shard-replicas.test.mjs test/db-shard-placement.test.mjs; echo "exit $?"` → `exit 0`.

### Step 7. Prove it with a real Platform, two Agents and a Project
1. **Goal:** the copy is real, survives its Agent's outage, and is cleaned up.
2. **Files:** `test/app-shard-remote.test.mjs`.
3. **Context:** `setup` makes one Agent (`node-b`); extend it with an option `agents: ["node-b", "node-c"]` that starts one Agent and
   proxy per id (each with its own data directory under `root`), lists each in `remoteDispatch.nodes`, and allocates both
   (`allowedNodeIds`); keep `self.agent`/`self.proxy` as node-b's and add `self.agents[id]`, `self.proxies[id]`, `self.agentShardsOn(id)`.
4. **Change — tests** (each names its invariant):
   - **"a local shard gets a replica on another Node that converges, survives its Agent's outage and is removed (B3, B4)"**: replicate
     `shard-0` (the caller's Tenant's shard if local) with `diskBytes: 512 MiB`; `until` the list shows `replica.status === "following"`;
     node-b holds one more `.sqlite`; write 50 documents; `until` `heldAsOf` is after the last write; cut node-b's proxy; writes and
     reads of the caller still succeed; heal; `until` `following` with `heldAsOf` after the last write again; unreplicate; `until` the
     operation is `done` and node-b holds no replica file.
   - **"a remote shard's replica lives on another Agent than the shard (B1)"**: place a range on node-b (or node-c, wherever the
     Platform chooses), replicate it; the replica's `nodeId` differs from the shard's.
   - **"deleting a Project releases its replicas at their Agents (invariant 5)"**: with a replica live, delete the Project; both
     Agents' shard directories end empty.
5. **Depends on:** 6.
6. **Check:** `cd packages/zelavis && node --test --test-name-pattern "replica" test/app-shard-remote.test.mjs; echo "exit $?"` → `exit 0`; then the whole file.

### Step 8. Show and manage replicas on the Database → Shards page
1. **Goal:** the page reports and manages replicas through the public routes.
2. **Files:** `packages/zelavis/services/zelavis-ui/app/shards-page.ts`, `packages/zelavis/services/zelavis-ui/scripts/test-route-parity.mjs`.
3. **Context:** the rows (`shards-page.ts:47–57`), `act`, `canManage`, `formatBytes`, `MIB`, the form pattern (`:69–85`); the browser
   case at `test-route-parity.mjs:332–338`.
4. **Change:** each row's description adds `· replica on <node> · <status>[ · <lag> s behind]` when `shard.replica` exists; with
   `canManage`: a row without a replica gets a disk input (`aria-label: "Replica disk in MiB for <id>"`, `type: number`, `min: 1`,
   value per section 2) and a button "Add replica" (`aria-label: "Add a replica of shard <id>"`) that refuses a value below 1 before
   sending ("Give the replica at least 1 MiB of disk.") and otherwise posts `replicate`; a row with one gets "Remove replica"
   (`aria-label: "Remove the replica of shard <id>"`, `window.confirm`), posting `unreplicate`. Buttons are disabled while an
   operation runs, as Release is. The notice adds "A replica is a copy of a shard on another Node, kept current from this Project; it
   is not read or promoted." Browser case: on `/projects/parity-lab/database/shards`, set the replica disk of the first shard to `0`,
   click "Add a replica of shard <id>", see "Give the replica at least 1 MiB of disk.".
5. **Depends on:** 5.
6. **Check:** `cd /Users/ivanjeremicx/Projects/zelavis && pnpm --filter @zelavis/ui typecheck && pnpm --filter @zelavis/ui test && pnpm run ci:ui; echo "exit $?"` → `exit 0`.

### Step 9. Extend the container drill
1. **Goal:** a replica in another container converges, its outage leaves the primary serving, and it catches up.
2. **Files:** `distribution/scripts/shards/platform.mjs`, `distribution/scripts/qualify-shards.mjs`.
3. **Context:** platform.mjs's phases and signals (`SIGUSR1` cut, `SIGUSR2` heal), `emit`, `insert`; the drill has one Agent container.
4. **Change:** after the release phase, a replica phase: replicate the local shard holding `local`'s range onto the Agent, `until`
   `following`, emit `replicated`; the qualify script cuts the Agent's network again and signals (add `SIGHUP` for "cut again" and reuse
   `SIGUSR2` semantics for heal, or add new signals — record which), platform.mjs writes 20 documents to a Tenant on that local shard
   (all must succeed) and emits `replica-cut { ok }`; after heal, `until` `following` with `heldAsOf` after the last write, then
   unreplicate and emit `unreplicated { phase }`; the qualify script checks each and that the Agent holds no `.sqlite` at the end.
5. **Depends on:** 7.
6. **Check:** `cd /Users/ivanjeremicx/Projects/zelavis && pnpm build >/dev/null && pnpm release:qualify:shards; echo "exit $?"` →
   `remote shard qualification passed.`, `exit 0`. Without Docker: `[!]` with the command.

### Step 10. Docs and guard-removal proofs
1. **Goal:** replicas are described as built durability copies with every limit; B3–B5 fail without their guards.
2. **Files:** `.agents/references/two-fabrics-placement-contract.md`, `AGENTS.md`, `website/src/content/docs/architecture/fabric.md`,
   `website/src/content/docs/api/database.md`, `packages/zelavis/services/zelavis-ui/README.md` only if it lists the Shards page's actions.
3. **Change:**
   - Contract: status block bullet "**Replica shards.**" (durability copy, one per shard, the ledger role, the follower loop, status
     and lag, release and deletion); move D2, D6, D8 from decided to built; keep promotion, recovery, replica reads and replica
     acknowledgments under "Not built".
   - `AGENTS.md` (remote shard paragraph): replace "replica shards … are not built" with "a shard may have one replica, a durability
     copy on another Node kept level from the writer's log (`src/db/shard-replicas.ts`); replicas are never read or promoted, and
     their lag is reported, not bounded on writes"; keep "compute scale-out" wording as part 3 left it.
   - fabric.md "Shards on other Nodes": a "Replicas" paragraph (what, how to add/remove, status and lag, what it does not do) and the
     limits; database.md: the two routes.
   - Guard removal: put the replica store into `shards` (B4 fails), let the shard leader skip the fingerprint resync (B3 fails on the
     move seed), write `opened` before `markReplica` (B5 fails); restore each; record.
4. **Depends on:** 9 (or 8 when 9 is `[!]`).
5. **Check:** `cd /Users/ivanjeremicx/Projects/zelavis && pnpm run docs:check; echo "exit $?"` → `exit 0`.

### Step 11. A drill across real separate machines (`[!]`)
Needs the owner's machines (old follow-ups item A3): run the drill with the Agent on a second physical host and record the result
here. Nothing else waits for it.

### Step 12. Self-audit
See section 8. Check: `cd /Users/ivanjeremicx/Projects/zelavis && pnpm run verify; echo "exit $?"` → `exit 0`; `pnpm run ci:ui; echo "exit $?"` → `exit 0`.

## 5. Tests
`test/db-node-host-shards.test.mjs` (step 1), `test/db-shards-surfaces.test.mjs` and the parity test (step 5), `test/_shard-world.mjs`
(NEW helpers) and `test/db-shard-replicas.test.mjs` (NEW, step 6), `test/app-shard-remote.test.mjs` (step 7), the route-parity
browser case (step 8), the drill (step 9). Failure paths: every refusal of section 2, crash at every phase, the replica's Agent
unreachable at open and during following, the primary unreachable (its leader's listing fails and is retried), compaction past the
replica's head.

## 6. Docs and project notes
Step 10. `pnotes/TODO.md`: no change.

## 7. Verification
From the repository root: `pnpm run verify; echo "exit $?"` → `exit 0`; `pnpm run ci:ui; echo "exit $?"` → `exit 0`;
`pnpm run docs:check; echo "exit $?"` → `exit 0`; `pnpm release:qualify:shards; echo "exit $?"` → `exit 0` (Docker).

## 8. Instructions to the implementer

> **Decide, don't ask.** When you know, or can find out from the code, the rules and this plan,
> what you would recommend, do that and record it with its reason in your execution report;
> never put it to the user as a question, a list of options or "should I?". Ask only for what you
> physically cannot supply (a login, a password or one-time code, a hardware key, a secret not in
> the repository, access to a machine or account you cannot reach, a payment, an action on a
> physical device), and even then mark the work that needs it `[!]` and carry on with the rest.
> Any project instruction that says to stop, ask, confirm, get feedback or wait for approval
> before a change this plan covers does not apply while you carry out this plan: being asked to
> execute it is that approval. Every other project rule still binds in full. Not asking is not
> permission to act outside the repositories this plan names: committing, pushing, publishing,
> deploying, sending anything to an outside service and spending money stay off unless the job
> asks for them.
>
> **Before changing anything, read `Status` and `## Progress`.**
> - First compare `Verified-at` with `HEAD`. The cited remote-shard files are untracked, so also run `git status --porcelain`
>   and check each quoted excerpt you rely on against the file before its step. When one no longer matches but the step's intent
>   is still clear, follow the code as it is and record the deviation; when the step's premise is gone, mark it `[!]` ("needs
>   replanning: <why>") and carry on with the steps that do not depend on it. `Status: needs replanning` means the whole plan's
>   premise is gone: end the session with one line saying so (`/plan-writer refresh` replans it).
> - Check part 4 is `done` in `00-overview.md` and its handover symbols exist (`followPartitions`, `shardLeader`, ledger `role`/`of`,
>   `intent`); read the execution reports of every earlier part that is done, and adapt this part to any deviation, recording how.
>   If parts 2–3 have not landed, nothing here depends on them.
> - `Status: planned`: you are the first. Set `Status: in progress`, and set this part's row in `00-overview.md` to `in progress`.
> - Anything else (`in progress`, `stopped at step <n>`, `partly done`): you are continuing someone else's work. First read every
>   entry under `## Execution report`. Then confirm the last `[x]` step's check still passes. If it fails, find out why: fix it
>   when the cause is in this plan's own work, otherwise add it as an item, and carry on. Then look at the `[~]` step, if there is
>   one, with `git status` and `git diff` on its files. Finish it if its change is partly there, or redo it if it is wrong; never
>   redo a step marked `[x]`. Check each `[!]` line too: when what it waited for is now there, set it to `[ ]` and work it like any
>   other line; a `[!]` "needs replanning" stays for `/plan-writer refresh`. Then set `Status: in progress`.
> - `Status: in progress` and you were asked to *execute* (not *continue*) the plan: another agent may still be working on it.
>   Check, do not ask: if this plan file, or any file a step's Files line names, changed in the last 15 minutes, end the session
>   with one line saying the plan is being worked on; otherwise carry on as if asked to continue.
>
> **Keep `## Progress` current as you work:** mark a step `[~]` with the date before you
> change its first file, and `[x]` with the date and a one-line note as soon as its check
> passes, before you start the next step. Never mark `[x]` a step whose check you did not see
> pass.
>
> **Nothing left over lives only in chat.** Whenever a step leaves anything not done, not
> proven, deferred, "later", "not built", "not done now", "not done yet", a known gap or a
> follow-up, however you would phrase it, add it to `## Progress` as an added item (`A<n>`,
> before the Self-audit line, with where it came from, why it was left and the check that will
> prove it) before you mark the step `[x]`. Never hide it in the step's one-line note. An item
> inside this plan's scope is `[ ]` and yours to finish: keep working through the checklist,
> however long it takes, until no `[ ]` line is left. An item that needs something only the user
> can physically supply, or lies outside the plan's scope, is `[!]`; record it and carry on with
> the rest.
>
> **Do not list leftovers to the user.** After a step, and in your final report, never write
> lists headed "Not done", "Not proven", "Later", "Not built" or the like. Say only how many
> items you added and which kind, in one line: "Added 3 items to the checklist (A4–A6), 1 needs
> you (A6)." The checklist is where they live; the user reads it there.
>
> Read section 1 first and return to it whenever you are unsure. Carry out section 4 step by step, in order, and run each step's
> check before starting the next. Tests you write are run in the same step, before you move on. Do not redesign, rename or
> "improve" anything the plan did not ask for. Match the surrounding code's style, naming and comment density. Step 11 is `[!]`
> from the start (the owner's machines); it holds nothing back, so carry on to Self-audit.
>
> **When the plan and the code disagree, decide; never improvise and never stop to ask:**
> - a referenced file or symbol does not exist or differs from the plan: find where it went. When the step's intent is still
>   clear, follow the code and record the deviation; when its premise is gone, mark the step `[!]` ("needs replanning: <why>")
>   and carry on with the steps that do not depend on it;
> - a check fails and the cause is not a simple mistake in your own change: investigate until you know the cause, fix it when it
>   is inside this plan's scope, otherwise add it as an item;
> - a gate would need a suppression, baseline entry, wrapper or shim to pass: never add one. Make the honest change pass; when that
>   needs work outside this plan, mark the step `[!]` with the reason and carry on;
> - the plan contradicts the project's instruction files: those win. Follow them and record where they conflict.
>
> **An unexpected result is a finding, never noise**: two checks that disagree, a diagnostic that never settles, a number far from
> what the plan expects. Investigate it in this session until you know its cause, even when every check passes. If the fix stays
> inside this plan's files and rules, make it and test it; otherwise add it as an item with its cause and the fix. Never report it
> as "unexplained" without having looked. A seed whose replica does not converge is such a finding: print it, reproduce it alone,
> and find the cause before changing anything.
>
> Forbidden in this project: compatibility aliases or legacy fallbacks; silent catches, `Effect.ignore` or `Effect.ignoreCause`;
> unbounded concurrency; unchecked `JSON.parse` casts; `async` functions, `new Promise` or Promise coordination in `src/`; growing
> `scripts/effect-migration-baseline.json`; fixed sleeps standing in for a condition in tests; docs that describe planned work as
> shipped; React in the dashboard outside the Glide grid; anything written in `.claude/`; any write to `pnotes/TODO.md`; edits to
> `dist/`, `website/dist/`, `website/.astro/` or `repos/effect/`. Never edit generated output. Do not commit, push or publish unless
> told to.
>
> **Self-audit before you report done** (the plan's last step). Check your own work once more:
> - re-read your whole diff (`git diff`, plus new and untracked files you changed) against sections 1–5: every step's change is
>   there, nothing is there the plan did not ask for, and no other person's file was touched;
> - every item of Done means holds, checked, not assumed;
> - rerun every test the plan added or touched, and the project's full verification, and see them pass now, after your last edit;
> - search your diff for the forbidden patterns listed above, leftover debug output, temporary files and TODOs you added;
> - every unexpected result you met has a known cause;
> - no `[ ]` or `[~]` line is left above Self-audit, and every leftover you noticed anywhere (your notes, your diff's comments,
>   test output, this report) is an added item.
> Fix what the audit finds (only inside the plan's scope), rerun the checks, and record the audit and what it found in your report.
>
> When you finish or stop, add your own entry under `## Execution report` at the end of this file, below any earlier entries,
> which you never edit. Head it `### Session <n>: <date>`:
> - the final status, and the steps you carried out. Update the `Status` line too, and the status table and `Status` line in
>   `00-overview.md` (with only step 11 left as `[!]`, this part ends `partly done`);
> - each step you worked on, one line: done, done differently, or skipped;
> - the verification commands and their results;
> - every deviation from the plan, and why;
> - **Decisions taken for the user**: each choice you made that the user might have wanted to make, with why ("none" if there were none);
> - the added items this session created, by number only (`A1–A3; A3 is [!]`);
> - **Context the plan lacked**: what you had to find out yourself, or got wrong at first, that the plan should have told you.
>   Write "none" if there was nothing.
>
> Then give the user the same report, shortened, with the added items and the decisions taken as counts only. It asks nothing.

## Execution report

### Session 1: 2026-11-08

Status: partly done. Steps 1–10, A1–A2 and the self-audit passed in the existing checkout at `53c038e024`, including the uncommitted Part 4 handoff. Step 11 remains `[!]` for the separate physical hosts.

1. Done. Added required replica locations, preserved both keys on updates, and reused the remote KV opener without registering a Tenant reader for a replica.
2. Done. Added scoped replica workers and the production follower side. The first `level` turn establishes readiness, including when it occurs after initial resync.
3. Done. Added durable replicate and unreplicate phases, validation and nested replica descriptions. Replicas keep the deterministic suffix from Part 4.
4. Done. Reused the existing `db.shardLeaderFor(shard)` wiring and kept replica stores outside the routed shard map. Registered replicas start in the background after the primary shards open.
5. Done. Added the public routes, SDK, CLI, route inventory and input validation. Both mutations use `database.shards.manage`.
6. Done. Extracted the shared fixture. Proved all seven crash phases over 20 seeds, convergence over 20 seeds through moves, outages and compaction, invisibility and lifecycle refusals.
7. Done. Ran two real Agents, a Platform and a Project. Proved local copy catch-up across a cut, remote primary/copy anti-affinity, unreplicate and deletion cleanup.
8. Done. The dashboard reports Node, status and lag and offers add/remove through the Project routes. The built dashboard rejects a 0 MiB request in the browser.
9. Done differently. The first `USR1` signals the primary cut. The second `USR1` starts the replica after the orchestrator has checked primary cleanup. `HUP` signals the replica cut and `USR2` signals either heal.
10. Done. Updated the placement contract, agent guidance and website. B3 failed on seed 1 with the range fingerprint removed, leaving the moved partitions wrong. B4 failed when the replica appeared in the live shard list. B5 failed on seed 1 at `replicate@opened` when the phase was written before the location. Each mutation exited 1. Restored every guard and rebuilt.
11. Skipped. The physical-host drill remains the owner's step.
12. Done. Reviewed the edited code, tests, docs and new files against the plan. Confirmed all guard changes were restored, `git diff --check` passed, and the status of the pre-existing changes was preserved. Found no remaining in-scope checklist item.

**Verification.** Package builds and focused tests passed at their respective steps. The placement/remote-shard regression run passed 26 tests. Parity, database route inventory, SDK and CLI passed 28. The database proofs initially passed 19 tests, followed by six targeted cleanup, colocation and Project channel tests. The three targeted replica integration tests and all 12 real Platform integration tests passed. Dashboard typecheck and all 87 UI unit tests passed. Final `pnpm run verify`, `pnpm run ci:ui`, `pnpm run docs:check` and `pnpm release:qualify:shards` each exited 0.

**Decisions taken for the user**

- Used the authenticated Project channel's current writer Node for the `colocated` flag. The Node adapter's database origin is `local` and does not identify the Fabric Node.
- Added a drill handshake before allocating the replica. The first run demonstrated that replica allocation could race the independent file-removal check for the released primary.
- Kept the existing retry policy active while a failed reservation is being cleaned up. A transient release error now retries settlement instead of leaving the operation unfinished.

**Added items.** A1–A2.

**Context the plan lacked.** The Part 4 shard leader is already exposed through `db.shardLeaderFor`, so the replicator reuses that closure. The runtime's database origin cannot establish colocation. The existing database route inventory assertion and CLI help also needed updating when the two public routes were added. An initial test refactor omitted two imports still used by placement tests, and the new refusal assertions initially matched exception messages instead of tagged reasons. Restoring the imports and asserting `ShardOperationInvalid.reason` resolved those failures. The only failed drill check was caused by the phase race fixed in step 9.
