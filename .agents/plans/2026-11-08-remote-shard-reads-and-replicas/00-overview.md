# Remote App shards beyond bytes: reads on the shard's Node, and replica shards
Job: Remote App shards beyond bytes: (A) compute scale-out, running Tenant operations on the Node that holds a remote shard through a remote Tenant-operation transport that carries the caller's partition-map version as RoutedBy, and (B) replica shards, a read-only copy of a shard on another Node kept current from its single writer. One split plan with one shared design. Also absorbed the former follow-ups plan `2026-11-08-remote-app-shard-placement-follow-ups` (steps 1 and 2 replaced, A1 became a Part 1 step, A3 a `[!]` item); that plan was closed and deleted on 2026-11-08.
Date: 2026-11-08
Status: partly done
Verified-at: 53c038e024 (plus the uncommitted working tree of 2026-11-08, which holds the whole remote-shard implementation as untracked files: `src/adapters/_remote-shard-host.ts`, `src/db/engines/remote-kv.ts`, `src/db/shard-placement.ts`, `src/platform/app-shard-*.ts` and their tests)

This is the overview of a split plan. Parts 1–3 (shared design and writer location, the shard reader and Tenant read table, the remote read transport with the per-read work budget and the Agent config bounds) are done and their files were removed on 2026-11-08; what they built is in the contract, the tests and the docs. Each remaining part is run in its own session, in order:

To start part n:    Execute part <n> in .agents/plans/2026-11-08-remote-shard-reads-and-replicas/<nn>-<slug>.md. Read 00-overview.md first, then start with the part's section 8.
To continue part n: Continue the plan in .agents/plans/2026-11-08-remote-shard-reads-and-replicas/<nn>-<slug>.md. Start with its section 8.

## Parts

| Part | File | Depends on | Status |
|---|---|---|---|
| 4 | `04-replica-ledger-and-shard-follower.md` (B): ledger roles, replica admission, the shared follow loop extracted, a shard-scoped leader | 1 (done) | done |
| 5 | `05-replica-shards.md` (B): the replicate/unreplicate operation, the replicator, SDK/HTTP/CLI, dashboard, proofs, drill, docs | 4 | partly done |

**A and B are independent** (decision D9): parts 2–3 and parts 4–5 touch different files except the docs, the contract,
`src/db/database.ts` (different functions) and `distribution/scripts/shards/platform.mjs` (different drill phases). Either
pair may land first after part 1; the table's order is the recommended one. Within a pair, the order is fixed.

## 0. Summary and finish line

Today only a remote shard's bytes live on the other Node: the Project's writer process runs every Tenant operation and
reaches the bytes key by key through a remote `KvEngine`. This plan keeps that one writer exactly where it is and adds two
things on top of it. **(A)** Tenant *reads* named in an explicit table run on the Node that holds the shard: the writer
process routes the read, sends it as data with the map version it was routed by, and the Agent answers it from one
snapshot of its own engine through a read-only shard handle that holds no writer claim. **(B)** A shard may have one
**replica**: a durability copy on another Node, a second remote KV shard whose writer claim is held by the same writer
process, kept level by the existing follower algorithm reading the primary's partitions by their event logs. Replicas are
never routed to, never read by Tenant operations and never promoted in this plan.

**In scope:**
- The shared design (decisions D1–D10 below) written into `.agents/references/two-fabrics-placement-contract.md`, with an
  invariant → test → guard table, and tests for the writer-location invariants that hold today (part 1).
- The stale shard-list audit carried over as follow-ups item A1 (part 1).
- (A) a read-only shard handle `openShardReaderOverKv`; the Tenant read table (`src/db/tenant-reads.ts`, NEW); the Agent route
  `POST /v1/shards/reads`; writer-side routing of the listed reads (Tenant handles and scatter legs); typed failures,
  `RoutedBy` across the wire, `TenantRelocated` typed on the wire; bounds; partial-availability behaviour; proofs (parts 2–3).
- (B) ledger `role`/`of`, replica admission (anti-affinity, envelope, one per shard), release/deletion rules; the follower
  loop shared by `followAll` and the replicator; a shard-scoped leader; the durable `replicate`/`unreplicate` operation;
  lag and status reporting; SDK, HTTP, CLI, the Database → Shards page; proofs (parts 4–5).
- Docs: contract, `AGENTS.md`, `website/src/content/docs/architecture/fabric.md`, `website/src/content/docs/api/database.md`,
  package README where shard APIs are listed.
- Closing the former follow-ups plan (done and deleted on 2026-11-08).

**Out of scope** (each recorded in the contract's "Decided, not built" by part 1, never described as shipped):
- **Writes on the shard's Node** (a shard-local writer): rejected for this plan, decision D1.
- **Replica promotion or recovery from a replica** (a replica becoming a primary, manual or automatic): decision D4.
- **Reads served by a replica**: decision D5.
- **Per-write acknowledgment by a replica** (`writeAcknowledged` waiting on a replica): decision D6.
- More than one replica per shard; replicas for a lease-guarded Project (refused like remote primaries today).
- A drill across real separate machines: the owner's to run (`[!]` in part 5, old follow-ups item A3).

**Done means:**
- Every part's Done means holds and every part's Status is `done` (or `partly done` with only `[!]` lines).
- `pnpm run verify; echo "exit $?"` from the repository root prints `exit 0` after the last part; `pnpm run ci:ui` and
  `pnpm run docs:check` pass after part 5; `pnpm release:qualify:shards` passes with the A and B phases (or is `[!]` when
  Docker is unavailable in the session, with the reason).
- Part 3 A6 resolves the Agent query work/memory bound before the remote-read plan is considered complete.
- The contract, `AGENTS.md` and the website say exactly what is built: reads on the shard's Node (listed operations) and
  replica shards as durability copies, with every limit stated.
- The follow-ups plan says `Status: done` and names this plan.

**Reading of the job chosen.** "Running Tenant operations on the Node that holds a remote shard" is read as: every Tenant
operation that only reads, whose inputs and outputs are data, and whose answer does not depend on writer memory runs there; similarity/hybrid query inputs and everything that writes or runs App code stays
on the one writer. Decision D1 gives the reason; the explicit list is decision D3.

**Supplement.** `.agents/references/plan-writer.md` was found current for its sources at `53c038e024`; updated with four
lessons from this planning run (the 2026-11-05 plan folder is gone, the remote-shard code is untracked, reads die rather
than fail on store errors, the existing `test/_remote-shard-fixture.mjs`) and `lessons-through` set to 2026-11-08. The
plan `2026-11-05-remote-app-shard-activation/` that the job names no longer exists in `.agents/plans/` (deleted as done by
an earlier planning run); its decisions are taken from the contract (status block: "A remote Tenant-operation transport (a
remote `ObjectStoreApi`) was rejected: `transact` takes a closure") and from the follow-ups plan's Traps. Open plan
`2026-11-03-project-failover-and-shard-placement/` is `partly done` and was left unchanged (its overview was edited minutes
before this run; nothing it cites is changed by this plan). No finished plans were deleted.

**Sources read:** `AGENTS.md` (Project Vision, Platform And App Service Boundary, Database Architecture Rules, Endpoint-Backed
Capability Rule, UI Package Rules, Verification); `.agents/references/two-fabrics-placement-contract.md` (whole);
`.agents/references/offline-replication-decision.md` ("Current guarantees and their boundary");
`.agents/references/effect-cluster-decision.md` (decisions 4 and 5); `.agents/references/tigerstyle-typescript.md` (via the
supplement); the former follow-ups plan (deleted 2026-11-08; its open lines live in this plan); the code cited in section 1.

## 1. Shared context packet

### Glossary

- **Writer process**: the one Project process that opens the database (`openNodeDatabase`, `src/db/node-host.ts:172`). It holds
  the kv-store writer claim of every shard the database opens, local or remote, and runs every write.
- **Writer claim / generation**: `{generation, session}` written into a shard's own bytes by `claimGeneration`
  (`src/db/kv-store.ts:3411`); every conditional commit checks it (`conditions()`, `src/db/kv-store.ts:604`). A newer claim
  fences an older one with `WriterFenced`.
- **Project epoch**: the epoch of the Project's placement record `{owner, epoch}` in the Platform's System Store. The Project
  process carries it in its HMAC capability (`ZELAVIS_APP_SHARDS_TOKEN`); the Project channel honours a capability only while
  `(projectId, nodeId, epoch)` is the current active placement (`authorize`, `src/platform/app-shard-routes.ts:109`). There is
  no other "Platform epoch": the Platform's authority over who is the writer *is* this record.
- **Shard epoch**: a ledger entry's `epoch` (`AppShardPlacement.epoch`, `src/platform/app-data-placement.ts:79`). It rises on
  activation and on every reissue to a newer Project epoch (`reissue`, line 351). The Agent keeps it as its durable
  high-water (`createAppShardHighWaterStore`, `src/core/agent/app-shard-grant.ts:199`) and serves a call only for a committed
  shard at exactly the token's epoch (`authorize`, `src/adapters/_remote-shard-host.ts:236`).
- **Access token**: Ed25519, 120 s, `(agentId, nodeId, projectId, incarnation, shardId, epoch)` (`signAppShardAccess`,
  `app-shard-grant.ts:155`).
- **Remote shard / primary**: a shard of the partition map hosted by an Agent, listed in `shard-locations.json` beside the
  shards (`readShardLocations`, `src/db/node-host.ts:276`).
- **Shard reader** (NEW, part 2): a read-only shard handle over an engine that holds no writer claim and reads every belief
  from the snapshot it answers from.
- **Tenant read** (NEW, part 2): one entry of the table in `src/db/tenant-reads.ts`: an operation name, the member of the
  Tenant API it is, and how it runs on a shard reader.
- **Replica** (NEW, parts 4–5): a ledger entry with `role: "replica"` and `of: <shardId>`, hosted by an Agent as an ordinary
  remote KV shard, written only by the replicator in the writer process. Not to be confused with the `replicated` placement
  class (`src/db/topology.ts:51`), which copies App-scoped collections onto every shard and is unrelated.
- **Replicator** (NEW, part 5): the fiber in the writer process that keeps one replica level with its primary through the
  shared follow loop.
- **Lease** (router): the in-process count a pinned operation holds on `(shard, partition)` while it runs
  (`partitionRouter`, `src/db/routing.ts:111`); a move waits for it (`drained`) before it removes the source.

### Governing rules (quoted)

- "Replicas never imply multiple writable owners; multi-writer consistency requires a separate explicit data
  specification." (`AGENTS.md § Project Vision`)
- "Keep fenced single-writer authority and adapter-neutral event replication." (`AGENTS.md § Database Architecture Rules`,
  offline editing bullet)
- "Queries are data, not closures. A closure cannot cross a node boundary, so a router that accepts one can only ever answer
  locally." (`AGENTS.md § Database Architecture Rules`)
- "Every routed call carries the map version it was routed by (`RoutedBy`) … a partition refuses a call routed by an older
  map with `TenantRelocated` rather than answer it empty." (`AGENTS.md § Database Architecture Rules`, tenant handle bullet)
- "a remote shard transport must carry the caller's map version into `RoutedBy` and return `TenantRelocated` typed, since the
  in-process tenant API treats it as a defect." (contract, Activation and movement step 6)
- "Singleton duties follow the writer. Cross-Tenant index refresh, backup schedules, workflow resumption and schedules run only
  in the process holding the database's writer claim." (`effect-cluster-decision.md`, decision 4)
- "Follower | Ordered log replay with duplicate/divergence/gap checks. Its read may lag. Replication alone promises neither
  synchronous commit nor RPO 0." (`offline-replication-decision.md`, Current guarantees)
- "Scalability is rule one … acknowledged positions are not kept per Tenant" (`AGENTS.md § Database Architecture Rules`)
- "Do not describe automatic failover or distributed replication as operational before their own gates pass"
  (contract, after Invariants).

### System today (end to end)

A Project process opens its database (`openNodeDatabase`). For each shard of the map, `openShardWith`
(`src/db/node-host.ts:116`) opens it locally, or, when `shard-locations.json` lists it, asks the Platform for an access token
(`channel.access`, `src/db/shard-authority-http.ts`), builds `makeRemoteKvEngine` (`src/db/engines/remote-kv.ts:66`) and opens
the unchanged store over it with `openShardOverKv` (`src/db/kv-store.ts:3373`), which claims the writer generation in the
Agent's engine. Every Tenant operation runs in this process: `forTenant` → `router.operations(tenantApiOver(...))`
(`src/db/database.ts:1591`) pins the operation to the shard routing names, and every store call goes through the remote KV
engine, one HTTPS request per `get`, scan page, write or snapshot, to `POST /v1/shards/kv`
(`src/adapters/_project-dispatch-https.ts:163`) served by `createRemoteShardHost` (`src/adapters/_remote-shard-host.ts:150`).
The Platform owns the ledger (`createAppShardPlacementAuthority`, `src/platform/app-data-placement.ts:248`) and drives
activation (`createAppShardActivation`, `src/platform/app-shard-activation.ts:48`). The App's durable place/release workflow
is `shardPlacementOver` (`src/db/shard-placement.ts:157`).

### Traps (whole plan)

- A remote `ObjectStoreApi` or remote `ShardStoreApi` → never: `transact` takes a closure (contract status block). Remote work
  is a named operation with JSON input.
- "Run it locally if the remote fails" → never: no fallback. A remote read that fails dies with `StoreError`, as the same read
  over the remote KV engine does today (reads die on store errors: `dieUnlessMoving`, `src/db/errors.ts:863`).
- A replica in the database's `shards` map → never: that map is routing, upkeep, listings and scatter. Replicas live in their
  own map and are invisible to all of those.
- Reading beliefs (fence, relocation, lens state, lineage) from the live engine in a reader → never: a reader reads them from
  the snapshot the answer comes from.
- Per-Tenant state for lag (acknowledgment records per partition) → never: lag is one timestamp per replica.
- The 2026-11-05 plan folder → gone; do not search for it.

## 2. Shared design

### D1. Where the writer lives — decided: in the Project's writer process, for every shard and every replica

**Decision.** The kv-store writer claim of every shard — local, remote primary, replica — is held by the Project's one writer
process, exactly as today. Nothing on an Agent ever claims a generation. Remote Tenant execution (A) is limited to reads,
answered by a shard reader that holds no claim. Writes, upkeep, movement, schema changes, entities, workflows and every
singleton duty stay in the writer process.

**Fencing, layer by layer.**
1. *Project epoch* (Platform authority): a Project process can reach the shard channel only while its `(projectId, nodeId,
   epoch)` is the current active placement (`app-shard-routes.ts:109`). A restarted or moved Project gets a new epoch.
2. *Shard epoch* (Agent authority): the first `access` under a new Project epoch reissues the grant at shard epoch + 1
   (`app-shard-activation.ts:125`), delivered to the Agent before the token is signed, so the Agent refuses every older token
   with `stale-epoch` before touching its engine. This holds for the `kv` route and, from part 3, the `reads` route, and for
   replica shard keys exactly as for primaries.
3. *Writer generation* (storage authority): the new process claims a new generation in the shard's bytes when it opens it, so
   a process holding a still-valid token but an older claim is refused at its next commit (`WriterFenced`). A shard reader
   never writes, so it needs no claim and cannot be fenced by one; it is bounded by layer 2 and by the router lease.

**What a crash or partition leaves behind.**

| Event | What is left | How it resolves |
|---|---|---|
| Writer process dies (any time, any shard op or replicator turn) | Agents keep bytes, high-waters, and the old process's 120 s tokens; replicas hold a prefix; remote reads in flight are answered to nobody | Project restart → new Project epoch → `access` reissues every primary and replica at epoch + 1 → old tokens `stale-epoch`; new claims fence the old generation; the replicator carries on from each replica's head |
| Primary's Agent down or partitioned from the writer | Bytes and high-water durable on the Agent | Writes to its Tenants fail (`StoreError`), listed reads die `StoreError` naming the shard; at open, partial availability (`unavailable` map, `database.ts:708`); a background loop reopens it |
| Replica's Agent down | Replica holds a prefix | Replicator turns fail, partitions wait in its retry set, status `behind` after 60 s; primary unaffected; catch-up by `levelFollower` from the replica's heads, or a reseed where the primary compacted past them |
| Platform down | Tokens keep working ≤ 120 s | Then every remote call is refused (decision A2, unchanged) |
| Platform ↔ Agent partition | Grant delivery fails | Activation/release answer `agent-unavailable`, retryable from the recorded ledger state (unchanged) |
| A remote read outlives its client | The writer released its lease after its 15 s timeout | The Agent's 10 s deadline usually ends it first; if it still runs after a move removed the source, the relocation record makes it `TenantRelocated` (it reads its beliefs from its snapshot), and nobody reads the answer |

**Rejected:**
- *A shard-local writer on the Agent* (the claim moves to the shard's Node): a Project would get one writer per remote shard,
  each with its own epoch lifecycle, crash recovery (`resumeMaintenance`, branch and schema resumption) and singleton duties,
  against effect-cluster decision 4; everything in the writer that holds a `ShardStoreApi` for the shard (movement `seed`,
  `followAll`, `fence`, `drop`, `relocate`, upkeep, images, replicated-collection propagation on every App-scoped write,
  leader sources for followers) would need the remote `ShardStoreApi` the finished plan rejected. A separate design, recorded
  as not built.
- *Delegating the writer's claim* (the Agent commits under the writer's `{generation, session}`): two committers under one
  claim, kept apart only by the partition revision refusing one of them; refusal would become the normal path, and "a
  partition admits one writer at a time" would be false.
- *Remote `ObjectStoreApi`*: closures (`transact`).

### D2. Where a replica hooks in — decided: follow the partition event logs with the existing follower code

**Decision.** A replica is filled and kept level by `levelFollower` (`src/db/followers.ts:119`) driven by the `followAll` loop
(`src/db/leader.ts:605`), extracted unchanged into an exported `followPartitions` that both `followAll` and the replicator call
(part 4). The leader side is a shard-scoped `DatabaseLeader` over the writer's own routed partitions; the follower side is the
replica's `ShardStoreApi` opened over a remote KV engine by the writer process. Positions, identifiers and versions are the
primary's, per partition. Catch-up: after an outage `levelFollower` carries on from each replica partition's head; a gap or
divergence copies the partition again (`FollowerSeed` `diverged`); a compaction past the head copies again (`compacted`),
with the primary's log held by `holdingLog` for the copy. Delivery is at least once per event, applied by version and
position, so repeats change nothing; nothing claims exactly-once.

**Rejected:** *mirroring KV batches at the commit path* — it copies physical keys (writer claim, lens blobs, relocation
records) rather than the replication stream, has no gap or divergence check, needs a second catch-up algorithm (a full key
scan) after any outage, and puts a remote call inside every commit; AGENTS.md names the event log as the replication stream.
*Following through the leader transport over HTTP* — the leader is in the same process; an in-process `DatabaseLeader` is the
existing pattern (`localDatabaseLeader`, `leader.ts:389`).

### D3. The operation protocol for A, and the explicit list

A Tenant read crosses the wire as `{ protocol: 1, access, partition, routedBy, op, input }`, JSON, ≤ 1 MiB, to
`POST /v1/shards/reads` on the Agent's pinned-CA listener, authorized by the same access token as the `kv` route (committed
at exactly the token's epoch). The Agent runs it on a shard reader inside one snapshot with `RoutedBy = routedBy`, under a
per-shard permit (4) and a per-Agent permit (16), each waited for at most 1 s, with a 10 s deadline. The answer is the
operation's exit: `{ value }`, `{ failure: <tagged error> }` or `{ defect: <tagged error> | { message } }`, ≤ 32 MiB, counted before it is serialized. Each read also spends from its own work budget (bytes, entries, expanded postings: part 3 A6), and one that passes it is refused whole as the defect `ReadBudgetExceeded`. The
writer side rebuilds the same exit, so a remote read behaves as the local one does; `TenantRelocated` arrives typed and the
writer turns it into a defect (D7). Full wire contract: part 3 section 3.

**Runs on the shard's Node (the whole list):**
- `documents`: `count`, `modalities`, `listCollections`, `collectionExists`, `findById`, `findMany`, `findPage`, `searchStatistics`,
  `withRelated`, `traverse`, `summarize`, `covariance`, `histogram`, `summarizeBy`
  (the read half built by `documentReads`, `src/db/document-reads.ts:1120`);
- `shared` (App-scoped replicated collections on the same shard): `listCollections`, `collectionExists`, `findById`, `findMany`, `findPage`;
- `events.read`; `aggregates.list`, `aggregates.get`; `outbox.read`;
- scatter legs for `searchStatistics`, `findMany` and `findPage` (`src/db/scatter.ts:487, 501, 578`), whose current inputs contain no similarity clause.

**Input boundary:** for `documents.findMany`, `documents.findPage`, `shared.findMany` and `shared.findPage`, a request with an own `similar` property stays on the writer, including hybrid requests and `approximate: false`. All other inputs to these four are eligible for shard execution. Part 2 A2 adds and tests `isShardTenantRead`; part 3 applies it under the router pin and rejects such input at the Agent. The choice happens before dispatch, never as a fallback after a failure.

**Stays on the writer, with the reason:**
- every write (documents, `kv`, `outbox.emit`/`remove`, `aggregates.define`/`refresh`/`drop`, imports, migrations): one writer;
- the whole `kv` API, reads included: `kv` `get` deletes an expired entry while reading (`src/db/key-value.ts:287`);
- similarity and hybrid query/page requests: they can depend on the writer’s mutable in-memory index;
- `documents.getVectorIndex`: it returns the writer’s in-memory index object rather than JSON or a function of shard bytes;
- `timeSeries` (reads too): definitions are registered in the writer's memory (`define`, `src/db/time-series.ts:677`);
- `projections`, `entities`, workflows, sagas (`db.workflowEngine`): they run App code or are singleton duties;
- `schemas`, `systemViews`, `backups` (export pages), branch, merge, movement, maintenance, images, cross-Tenant indexes,
  follower sources: writer-owned or multi-step workflows over the writer's beliefs;
- a read whose input or answer is not plain JSON is refused (a defect naming the path), never sent by another way.

### D4. Durability copy only; no promotion

A replica is a durability copy: the primary's data, per partition, at a reported lag, on another Node. It is never promoted
and nothing recovers from it in this plan. **Reason:** recovery means a replica becoming the shard's storage, which needs (1)
proof that it holds every acknowledged write (synchronous acknowledgments, D6), (2) fencing of an old primary Agent that may be
unreachable, beyond token expiry, (3) an App-side location change while the Project is stopped, and (4) its own failure drills.
None is specified here. Recorded in the contract as not built.

### D5. Replicas are not read

No Tenant operation reads a replica. **Reason:** a replica lags, so reading it breaks read-your-writes; a stale-read contract is
a separate design. **Rejected:** routing A's reads to a replica when the primary is unreachable (a fallback).

### D6. Lag is reported, not enforced on writes

Each replica reports `heldAsOf` (the time before the feed request of the last turn after which nothing was left to retry: the
replica holds every write committed before it), `lagMillis = now − heldAsOf`, and a `status`: `seeding` until the first
level turn, which can follow its initial resync, then `following`, `behind` when `lagMillis > 60 000`, `unavailable` while its store is not open. The
replicator's feed waits at most 5 s, so an idle replica reports at most about 5 s. Work per turn is bounded (`followAll`'s
concurrency 8, 64 batches per pass, a retry set capped at 10 000 that turns into a resync). **Rejected:** throttling the
primary when a replica falls behind (a durability copy must not reduce availability); per-write acknowledgment by the replica
(per-partition acknowledgment records grow with Tenants, and AGENTS.md says a future acknowledgment policy needs its own
specification of replica count, failure domains and timed-out writes).

### D7. `RoutedBy` and `TenantRelocated` across the wire

The writer routes and leases the read exactly as an in-process call (`router.operations`), reads the pin's `{shard, version}`
(`pinnedRoute`, NEW, part 3) and sends `routedBy = version`. The Agent provides `RoutedBy` to the read, so the shard's own
relocation check (`routable`, `src/db/kv-store.ts:584`) refuses an older map with `TenantRelocated` exactly as in process,
reading the relocation record from the read's snapshot. Over the wire it is a typed failure (`_tag: "TenantRelocated"` with
its fields). The writer decodes it into the class and **dies** with it: inside a live lease it cannot happen (a move removes
the source only after the lease drains), so receiving it is a broken invariant, which is how the in-process API treats it.

### D8. Ledger roles, envelope, release and deletion

- Ledger entries gain `role: "primary" | "replica"` and, for a replica, `of: <shardId>`; a replica's `shardId` is
  `<of>.replica`, its `virtualRanges` is `[]`, and it is excluded from the range-conflict check.
- Requests gain `intent: "allocate" | "replica"` (the contract's versioned exchange already names `replica`). A replica request
  carries `of` and resources `{ cpuCores ≥ 0, memoryBytes ≥ 0, diskBytes > 0 }`; it counts against the allocation like any
  entry. Remote compute for A uses the CPU and memory already reserved when the primary was placed; the Agent bounds it with
  fixed permits (D3) rather than per-grant numbers.
- Anti-affinity: a replica's Node is never its primary's Node (the ledger entry of `of` for a remote primary; the caller's Node
  from the Project capability for a local primary). With no other eligible Node the request is refused `no-eligible-node`.
- At most one live replica per shard (`replica-exists`); a replica of a replica is `invalid-request`.
- Release: the Platform refuses `beginRelease` of a primary whose replica is live (`replica-live`); the App refuses `release` of
  such a shard before asking. Project deletion (`revokeAll`) releases replicas first, then primaries; a failure leaves the
  deletion retryable as today. The Agent needs no change for B: a replica is an ordinary shard key to it.

### D9. A and B are independent

A changes where listed reads execute and adds a reader and a route; B adds ledger roles, a follow loop caller and an
operation. Neither uses the other's code. The only shared files are documentation, the contract, `src/db/database.ts` (A wraps
the Tenant handles; B adds a replicas map and operation methods) and the shards drill script (separate phases). Replicas are
not read (D5), so A never has to know about them; B's replicator reads its primary through the writer's own routed partitions,
which are unaffected by A (A changes only the Tenant API members in D3's list).

### D10. Surfaces

- A adds **no new public capability**: the same SDK, HTTP and CLI reads now execute on the shard's Node. Nothing new for the
  parity test; docs and the Shards page's notice say where reads run.
- B adds `POST database/shards/:shardId/replicate` (`{ resources: { diskBytes } }`, 202 `{ operation }`) and
  `POST database/shards/:shardId/unreplicate` (202 `{ operation }`), both `database.shards.manage`; `database/shards` list entries
  gain `replica`; SDK `client.shards(projectId).replicate(shardId, { diskBytes })` and `.unreplicate(shardId)`; CLI
  `zelavis shards replicate <shard> --project ID --disk BYTES` and `zelavis shards unreplicate <shard> --project ID`; the
  Database → Shards page shows each shard's replica and offers add/remove. Contracts: part 5 section 3.

### Invariants (the contract's table after part 1; each test must fail with its guard removed)

| # | Invariant | Test (file → name) | Guard | Part |
|---|---|---|---|---|
| W1 | A newer claim on a remote shard fences the older writer at its next commit, even with a valid token | `test/shard-writer-location.test.mjs` → "a second claim on a remote shard fences the first writer at its next commit" (NEW) | the generation and session conditions in `conditions()`, `kv-store.ts:604` | 1 |
| W2 | A token below the Agent's high-water is refused before the engine is touched | `test/remote-shard-host.test.mjs` → "a remote Agent hosts a shard under grants, fenced by epoch, over TLS" (exists, line 51) | `authorize`, `_remote-shard-host.ts:236` | 1 (mapped) |
| W3 | A Project's previous process cannot use its shard after a restart | `test/app-shard-remote.test.mjs` → "a Project's previous process cannot use its shard after a restart (invariant 2)" (exists, line 323) | `reissue` before `grantAccess`, `app-shard-activation.ts:132` | 1 (mapped) |
| W4 | Nothing on the Agent ever writes a shard's generation key | `test/shard-writer-location.test.mjs` → "the Agent never claims a shard: the generation in its engine is the writer's" (NEW, extended in part 2 for the reader) | the Agent opens engines only (part 1); `openShardReaderOverKv` never calls `claimGeneration` (part 2) | 1, 2 |
| W5 | Every consumer of the shard list reads it when it runs, never from a copy made at build time | `test/db-shard-placement.test.mjs` → "every shard-list consumer sees a shard opened after the database was built" (NEW) | the live reads of `shards` (part 1 step 4) | 1 |
| A1 | A reader answers every belief from the snapshot it answers from | `test/db-shard-reader.test.mjs` → "a reader sees a relocation, a fence and a rebuild mark written after it was first used" (NEW) | no belief caching in reader mode | 2 |
| A2 | A remote read answers what the same local read answers, failures included | `test/db-tenant-reads.test.mjs` → "every listed read answers the same through the wire codec and a shard reader" (NEW) | the table and codec | 2 |
| A3 | A read routed by an older map than the shard's relocation record is `TenantRelocated`, typed, never an empty answer | `test/remote-shard-host.test.mjs` → "a remote read routed by an older map is TenantRelocated, typed" (NEW) | `RoutedBy` provided by the Agent's read executor | 3 |
| A4 | A move never removes a source while a remote read routed there is in flight | `test/db-remote-shard.test.mjs` → "a move waits for a remote read in flight before it removes the source" (NEW) | the remote call runs inside the router lease | 3 |
| A5 | Writes and similarity queries never go to the reads route; admitted remote reads never go to the KV route | `test/db-remote-shard.test.mjs` → "listed reads run on the Agent and writes stay on the writer" (NEW) | the D3 table in the wrapper | 3 |
| B1 | A replica's Node is never its primary's Node; one replica per shard; replicas hold no ranges | `test/app-data-placement-contract.test.mjs` → "replica admission: anti-affinity, one per shard, no ranges, envelope" (NEW) | the replica rules in `request` | 4 |
| B2 | A primary with a live replica cannot be released; deletion releases replicas first | same file → "a primary with a live replica is not released; revokeAll releases replicas first" (NEW) | `beginRelease` refusal; `revokeAll` order | 4 |
| B3 | A replica holds exactly the primary shard's partitions at the primary's positions once quiet | `test/db-shard-replicas.test.mjs` → "a replica converges to its primary through writes, moves, compaction and outages (20 seeds)" (NEW) | the shard-scoped leader's routing filter and resync on a range change | 5 |
| B4 | A replica is never routed to, listed as data, upkept or scattered, and its outage changes nothing for the primary | same file → "a replica is invisible to routing, listings, upkeep and scatter, and its outage does not touch the primary" (NEW) | replicas kept out of `shards` | 5 |
| B5 | A crash at every phase of replicate and unreplicate resumes to the same end | same file → "a crash at every phase of replicate and unreplicate resumes to the same end (20 seeds)" (NEW) | phases recorded before effects | 5 |

## 3. Shared contracts

Written out in the part that builds each one: the shard reader (part 2 § 3), the read table and wire codec (part 2 § 3), the
`/v1/shards/reads` route and writer-side client (part 3 § 3), ledger and request shapes (part 4 § 3), the follow loop and
shard leader (part 4 § 3), the replica operation and its surfaces (part 5 § 3).

## 4. Shared handover between parts

- Part 2 builds on part 1's contract section and `test/shard-writer-location.test.mjs`.
- Part 3 builds on part 2's `openShardReaderOverKv` (`src/db/kv-store.ts`) and `src/db/tenant-reads.ts`
  (`TENANT_READS`, `tenantReadsOver`, `runTenantRead`, `encodeReadExit`, `decodeReadExit`, `isPlainJson`).
- Part 4 builds on part 1 only.
- Part 5 builds on part 4's ledger `role`/`of`/`intent`, `followPartitions` and `shardLeader` (`src/db/leader.ts`).

## Progress
- [x] 4. 2026-11-08. Part 4 passed root verification.
- [!] 5. 2026-11-08. Part 5 passed all automated gates. The separate physical-host drill remains open.

## Execution report

### Part 4: 2026-11-08

Done. The ledger, shared follow loop and shard leader passed root verification. Part 5 can use
`db.shardLeaderFor(shard)` and the first level turn as the readiness signal.
See the [Part 4 execution report](04-replica-ledger-and-shard-follower.md#execution-report).

### Part 5: 2026-11-08

Replica operations, status, surfaces and proofs passed in the existing checkout. Workspace verification, browser
qualification, docs and the two-container drill each exited 0. The separate physical-host drill remains open.
See the [Part 5 execution report](05-replica-shards.md#execution-report).
