# App Data Fabric ↔ Platform Fabric placement contract

Status: **remote App shard placement is implemented and proven on one machine; the limits below stand**.
A shard's bytes never move between Nodes in place. A shard is placed on a Node empty, and Tenants move into it with the
App's own `db.movement` (copy, fenced catch-up, routing moved last); moving a shard from one Node to another is a new shard
there, a rebalance of the old shard's ranges onto it, and releasing the old one. The whole path:

- **Ledger and allocation.** `src/platform/app-data-placement.ts` accepts an authenticated Project identity, checks a
  trusted allocation and Node inventory, and conditionally persists a Project-wide ledger. Entries carry a state
  (`reserved`, `preparing`, `committed`, `releasing`, `released`), a shard epoch that only rises (kept after release,
  so a re-requested shard continues from it), a per-ledger incarnation and the Project epoch they were issued under.
  The Node a reservation names is proposed by consistent hashing with bounded loads (`src/core/fabric/bounded-load.ts`).
  The operator's allocation (`fabric.app-data-allocation.v1`) has its routes, SDK and CLI (`runtime/shard-placement`).
- **A remote shard is a remote key-value engine.** `zelavis/db` reaches storage only through `KvEngine`, so the Agent hosts
  the shard's SQLite engine (`src/adapters/_remote-shard-host.ts`, under a signed Platform grant, with its own durable
  epoch high-water) and the Project's writer process runs the unchanged store over a client engine
  (`src/db/engines/remote-kv.ts`). The writer claim, partition revisions, fences, `RoutedBy` and `db.movement` run
  unchanged. A remote Tenant-operation transport (a remote `ObjectStoreApi`) was rejected: `transact` takes a closure.
- **Reads on the shard's Node.** Eligible named Tenant reads, including ordinary document queries and scatter legs,
  run on the Agent from one read-only shard snapshot. `src/db/tenant-reads.ts` names the operations and excludes
  query/page inputs with a `similar` property; those, writes, KV and time series stay in the writer. The writer holds its
  routing lease and sends `RoutedBy` over `/v1/shards/reads`; the Agent checks it against the snapshot. Reads are bounded
  to four per shard and sixteen per Agent, a 10-second deadline and a 32 MiB answer. A failed remote read never falls back.
- **A read's work budget.** Each remote read opens its own reader with a budget (`src/db/read-budget.ts`): 32 MiB of stored
  bytes copied, 262,144 entries read and 4,194,304 posting identifiers expanded unless the Agent's config file sets `shards.readLimits` (`bytes`, `entries`, `postings`; the other read bounds are the keys beside it).
  The limits are checked before data is copied, never after: a value larger than the bytes left is sized inside the same
  SQLite statement and refused unread, a scan sizes a page of rows (no content), copies only what the budget admits and
  needs the request's snapshot, and every posting set is charged per identifier, because a sealed segment is 8 KiB for
  65,536 of them. Exhaustion refuses the whole read as `ReadBudgetExceeded` (`limit`, `max`) in the read's own exit, so it
  crosses the codec as itself and becomes HTTP 422 `read-budget-exceeded` (the SDK throws it with that `code`); it is not an unavailable
  shard, returns no part of an answer and is never retried on the writer. The answer is sized exactly before it is
  serialized (413 `answer-too-large`). Only engines that offer `bounded` host remote reads (SQLite, which the Agent runs,
  and the in-memory engine the tests use); the Agent refuses any other with `unbounded-engine`. Resident memory per read is a small multiple of its
  byte budget (measured about 3.6× with 1 MiB text documents: `test/db-read-budget-memory.test.mjs`), plus one expanded
  segment (up to 65,536 keys) while an ordered read merges; with sixteen reads at once that is the Agent's worst case, and `shards.readLimits` and `shards.readsPerAgent` lower it. It is not a process-wide cap.
  Local reads are unbounded as before. Decoding, set algebra and sorting are not metered themselves: each works on items
  that were read, and so spent, first, and the sweep in `test/db-read-budget.test.mjs` shows no listed read copies or spends
  past a limit. A document of many small values decodes to a larger multiple than the text documents measured, which is
  why the byte limit is a tunable, not a proof of a process memory cap.
- **Two fences.** The Agent refuses every call whose access token is not at its durable high-water epoch for a
  committed shard, and `kv-store` still checks its writer generation in every conditional write. The shard epoch rises
  on activation and on every reissue to a new Project epoch. Access is a signed 120-second token, renewed through the
  Project's HMAC channel (`runtime/project-shards`, bound to the Project's placement epoch).
- **The App side.** The `database/shards` mutations run a durable workflow (`zv.shard-op`) whose phases are recorded
  before their effects. `shard-locations.json` beside the shards records remote primaries and replicas separately, and
  the Project opens them through its channel. Routing names a remote shard only after the Platform shows it `committed` and the
  shard answered a call (`beforeRouting`).
- **Deletion.** The Project's cleanup participant revokes every grant at the Agent (`revokeAll`, retried while an Agent
  is unreachable) before the ledger and the Project's data go.

Proof: `test/app-shard-remote.test.mjs` runs a real Platform, a real remote Agent behind a TCP proxy that can be cut,
and a real `@zelavis/app` Project; `test/db-shard-placement.test.mjs` crashes every phase over 20 seeds;
`test/app-shard-activation.test.mjs` and `test/remote-shard-host.test.mjs` hold the Platform and Agent sides.

**Decided, not built** (decisions of 2026-11-08; each is closed unless the reason stops holding):
- *Lease-guarded Projects keep refusing remote shards.* The standby copies the whole database through the leader transport
  and then promotes itself, so a standby would also have to reach, and fence, the remote shard; until the standby/remote
  interplay is designed, refusing is the safe answer (`lease-guarded`).
- *A restored image opens all-local.* An image copies every shard's keys into local engines; to put ranges on another Node
  afterwards, `place` is the one way. No restore-onto-remote path is added.
- *Platform outage tolerance is the replicated System Store's job* (decision A2). Nothing here extends the 120-second token.

- *Writes on the shard's Node, replica promotion or recovery, reads from replicas and per-write replica acknowledgment are separate designs* (D1, D4, D5, D6).

**Built since the first proof:** partial availability (a remote shard whose Agent is not answering at open does not stop the
Project: its Tenants are refused with the reason, everything that spans every shard refuses rather than answer for part of
the data, a background loop opens the shard when the Agent answers, and `database/shards` reports `available: false`);
pruning of a released shard's Agent record after a day; the release of a shard holding a cross-Tenant index's entries is
refused up front; a part of a divided Tenant moves to a remote shard and back (db-level proof); the multi-container drill
(`pnpm release:qualify:shards`: Platform and Project in one container, the Agent in another, the Agent's network cut and
restored); the Project's Database → Shards dashboard page (`@zelavis/ui`, a client of the same routes: list, place, release,
latest operation, and the allocation read-only).

**Replica shards.** A primary can have one durability copy on another Node, reserved as a disk-only ledger entry
with role `replica` and `of` set to the primary. The Project's writer holds the replica's claim and uses the shared
follower loop to replay the primary's partition logs. Status and lag appear on the Shards page and through the
shard list API. Removing a replica releases its Agent storage, and deletion revokes replicas before their primaries.
A replica is outside the partition map and its availability does not gate primary writes or reads.

The Platform stays the single
point of failure for shard grants (decision A2 of
`.agents/plans/2026-11-03-project-failover-and-shard-placement/00-overview.md`): without it a remote shard refuses reads and
writes once its 120-second token expires.

Whole-Project placement is separate and implemented: a `{owner, epoch}` CAS record per Project, Agent self-fencing, and
signed remote Project dispatch; see AGENTS.md.

## Reads on the shard's Node and replica shards (decided 2026-11-08)

The read transport and durability copies are implemented as described above. D2, D6 and D8 govern the shipped replica lifecycle.

**D1 — Writer location.** The Project's single writer process holds the writer claim for every primary and replica, runs all writes and singleton duties; an Agent reader holds no claim. Project placement epoch, Agent shard epoch and storage writer generation independently fence old authority. A shard-local writer or a delegated claim would introduce competing committers and recovery duties.

| Event | What is left | How it resolves |
|---|---|---|
| Writer process dies (any time, any shard op or replicator turn) | Agents keep bytes, high-waters, and the old process's 120 s tokens; replicas hold a prefix; remote reads in flight are answered to nobody | Project restart → new Project epoch → `access` reissues every primary and replica at epoch + 1 → old tokens `stale-epoch`; new claims fence the old generation; the replicator carries on from each replica's head |
| Primary's Agent down or partitioned from the writer | Bytes and high-water durable on the Agent | Writes to its Tenants fail (`StoreError`), listed reads die `StoreError` naming the shard; at open, partial availability (`unavailable` map, `database.ts:708`); a background loop reopens it |
| Replica's Agent down | Replica holds a prefix | Replicator turns fail, partitions wait in its retry set, status `behind` after 60 s; primary unaffected; catch-up by `levelFollower` from the replica's heads, or a reseed where the primary compacted past them |
| Platform down | Tokens keep working ≤ 120 s | Then every remote call is refused (decision A2, unchanged) |
| Platform ↔ Agent partition | Grant delivery fails | Activation/release answer `agent-unavailable`, retryable from the recorded ledger state (unchanged) |
| A remote read outlives its client | The writer released its lease after its 15 s timeout | The Agent's 10 s deadline usually ends it first; if it still runs after a move removed the source, the relocation record makes it `TenantRelocated` (it reads its beliefs from its snapshot), and nobody reads the answer |

**D2 — Replication stream.** A shard-scoped leader and the shared `followPartitions` loop use `levelFollower` to replay partition event logs to the replica, retaining positions and reseeding on divergence or compaction. Delivery is at least once and idempotent. Mirroring KV batches would copy physical metadata and require a separate catch-up mechanism.

**D3 — Read protocol.** Named JSON Tenant reads use `POST /v1/shards/reads`, the same shard access authorization, a snapshot, bounded permits and deadlines. `src/db/tenant-reads.ts` lists the 23 operations. Query and page inputs with an own `similar` property (including hybrid and explicit exact similarity) stay on the writer, as does `documents.getVectorIndex`, because they can depend on its mutable in-memory projection index. Ordinary query and scatter legs run on the shard's Node under the per-read work budget described in the status block; one that passes it is refused, not answered in part. Writes, KV, time series, App code and writer-owned workflows remain on the writer. Closures cannot cross the boundary.

**D4 — Durability only.** A replica is not promoted or used for recovery: this requires acknowledged-write guarantees, fencing, location changes and failure drills outside this design.

**D5 — No replica reads.** Tenant operations never read replicas because lag would break read-your-writes; stale reads need a separate contract.

**D6 — Lag, not acknowledgments.** Report `heldAsOf` from the last level turn, with lag and seeding/following/behind/unavailable status. The first level turn may follow the initial resync. Follow work per turn is bounded. Neither throttle primary writes nor wait for replica acknowledgments; the latter needs a separate durability policy.

**D7 — RoutedBy.** The writer retains its router lease and sends the pinned map version. The reader checks relocation within its snapshot and returns `TenantRelocated` typed; the writer treats it as a defect because the lease should prevent it.

**D8 — Ledger.** Primary and replica roles are explicit; a replica has no ranges, counts against the allocation, is limited to one per primary and must be on another Node. A live replica blocks primary release; deletion releases replicas first. The Agent treats replicas as ordinary shard keys.

**D9 — Independent work.** Remote reads and replica creation can land independently after the shared design: replicas are never read and the replicator uses the writer's routed primary partitions.

**D10 — Surfaces.** Remote reads preserve existing public APIs. Replication adds shard replicate and unreplicate operations across HTTP, SDK, CLI and the Shards page, together with replica status.

| # | Invariant | Test (file → name) | Guard | Part |
|---|---|---|---|---|
| W1 | A newer claim on a remote shard fences the older writer at its next commit, even with a valid token | `test/shard-writer-location.test.mjs` → "a second claim on a remote shard fences the first writer at its next commit" (NEW) | the generation and session conditions in `conditions()`, `kv-store.ts:604` | 1 |
| W2 | A token below the Agent's high-water is refused before the engine is touched | `test/remote-shard-host.test.mjs` → "a remote Agent hosts a shard under grants, fenced by epoch, over TLS" (exists, line 51) | `authorize`, `_remote-shard-host.ts:236` | 1 (mapped) |
| W3 | A Project's previous process cannot use its shard after a restart | `test/app-shard-remote.test.mjs` → "a Project's previous process cannot use its shard after a restart (invariant 2)" (exists, line 323) | `reissue` before `grantAccess`, `app-shard-activation.ts:132` | 1 (mapped) |
| W4 | Nothing on the Agent ever writes a shard's generation key | `test/shard-writer-location.test.mjs` → "the Agent never claims a shard: the generation in its engine is the writer's" (NEW, extended in part 2 for the reader) | the Agent opens engines only (part 1); `openShardReaderOverKv` never calls `claimGeneration` (part 2) | 1, 2 |
| W5 | Every consumer of the shard list reads it when it runs, never from a copy made at build time | `test/db-shard-placement.test.mjs` → "every shard-list consumer sees a shard opened after the database was built" (NEW) | the live reads of `shards` (part 1 step 4) | 1 |
| A1 | A reader answers every belief from the snapshot it answers from | `test/db-shard-reader.test.mjs` → "a reader sees a relocation, a fence and a rebuild mark written after it was first used" (NEW) | no belief caching in reader mode | 2 |
| A2 | A remote read answers what the same local read answers, failures included | `test/db-tenant-reads.test.mjs` → "every listed read answers the same through the wire codec and a shard reader" (NEW) | the table and codec | 2 |
| A3 | A read routed by an older map than the shard's relocation record is `TenantRelocated`, typed, never an empty answer | `test/remote-shard-reads.test.mjs` → "a remote read carries the routing version" | `RoutedBy` provided by the Agent's read executor | 3 |
| A4 | A move never removes a source while a remote read routed there is in flight | `test/db-remote-shard.test.mjs` → "a move waits for a remote read holding its route lease" | the remote call runs inside the router lease | 3 |
| A5 | Writes and similarity queries never go to the reads route; admitted remote reads never go to the KV route | `test/db-remote-shard.test.mjs` → "listed reads run on the Agent and writes stay on the writer" (NEW) | the D3 table in the wrapper | 3 |
| B1 | A replica's Node is never its primary's Node; one replica per shard; replicas hold no ranges | `test/app-data-placement-contract.test.mjs` → "replica admission: anti-affinity, one per shard, no ranges, envelope" (NEW) | the replica rules in `request` | 4 |
| B2 | A primary with a live replica cannot be released; deletion releases replicas first | same file → "a primary with a live replica is not released; revokeAll releases replicas first" (NEW) | `beginRelease` refusal; `revokeAll` order | 4 |
| B3 | A replica holds exactly the primary shard's partitions at the primary's positions once quiet | `test/db-shard-replicas.test.mjs` → "a replica converges through writes, moves, compaction and outages (B3, 20 seeds)" | the shard-scoped leader's routing filter and resync on a range change | 5 |
| B4 | A replica is never routed to, listed as data, upkept or scattered, and its outage changes nothing for the primary | same file → "a replica is invisible to routing, listings, upkeep and scatter even when unavailable (B4)" | replicas kept out of `shards` | 5 |
| B5 | A crash at every phase of replicate and unreplicate resumes to the same end | same file → "a crash at every phase of replicate and unreplicate resumes to the same end (B5, 20 seeds)" | phases recorded before effects | 5 |

## Ownership

- The App Data Fabric owns logical Tenant routing, virtual ranges, shard IDs,
  data copy/catch-up, shard-aware cursors and projection checkpoints, and the
  Project's partition-map version. It may request capacity or a move but may
  not choose a physical Node or activate a remote writer by itself.
- The root Platform Fabric owns physical Nodes, the Project's allocation and
  resource envelope, shard placement, writer ownership epochs, fleet policy,
  and the authoritative placement record in the System Store. A delegated
  Project Cell gets only an explicitly granted sub-envelope; it cannot issue
  root placements or provider credentials.
- Authenticated Agents execute a committed grant under signed, scoped
  authority. A runtime URL or an Agent's observation is a route target, never
  evidence of placement authority.
- The logical partition map (`virtual range → App shard ID`) and physical
  placement (`App shard ID → Node/Agent`) are separate records. Neither is
  inferred from the other. `PlacementClass` in `zelavis/db` describes collection
  scope and is unrelated to physical placement. A physical grant covers a
  whole App shard; moving only some of its virtual ranges first requires an
  App-controlled map change to a distinct shard ID. The Platform may validate
  the reported range set but cannot edit the App's partition map.

## Versioned exchange

The eventual internal protocol uses these semantic fields. Its transport and
serialized schema must be versioned before remote execution is enabled.

**Request** (App → Platform): protocol version; unique operation/idempotency
ID; exact `projectId` and App runtime identity; requested App `shardId`(s) and
virtual range set; intent (`allocate`, `move`, `replica`, or `release`); resource
needs and required capabilities; observed Project allocation revision,
placement revision/epoch, and partition-map version; optional locality and
spread *preferences*. A request cannot carry an authoritative Node assignment,
writer epoch, provider credential, or a wider resource envelope. The Platform
authenticates the caller as that Project, checks its live recipe and allocation,
and refuses an unknown intent, an out-of-envelope request, or release of a
shard still referenced by the active map. A client-supplied Project ID is never
sufficient authority.

**Decision** (Platform → App): either a structured refusal with a stable reason
and the current revisions, or a grant with protocol version, operation ID,
`projectId`, shard/range identity, selected Node and Agent identity, granted
resources/capabilities, owner session, strictly increasing writer epoch,
placement revision, parent Project allocation generation, expiry/renewal
conditions, and state. The durable System Store record is authoritative;
responses and signatures describe it but do not replace it. Repeating the same
operation ID while its reservation is current returns that decision; an ID
from a superseded reservation or one reused with different input is a conflict.
A changed observed revision requires a fresh read and replan, never a stale
snapshot retry. A Project-wide conditional ledger makes aggregate budget and
virtual-range uniqueness checks atomic across its reservations.

Only the Platform may transition a grant from reserved/preparing to committed.
An Agent can prepare storage under a reservation, but it cannot publish a
target or accept writes until it validates a committed grant and the current
ownership token. The token binds Project, shard, destination, owner session,
epoch, expiry and allowed operation; the destination checks it where a write
or activation occurs. The App receives no general host-operation authority.

## Activation and movement

1. The App proposes a logical change and asks for placement. The Platform
   checks Project identity, parent allocation, capacity, isolation/backend
   capabilities and existing grants, then reserves a destination durably.
   Failure here changes neither routing nor writer ownership.
2. The Platform dispatches a bounded prepare operation to the selected Agent.
   The App copies/backs up and catches up through a shard-aware stream while
   the current owner still serves reads and writes. A target is unpublished
   scratch until restore and verification succeed. A replica is read-only and
   does not acquire writer ownership.
3. Cutover fences the old writer, drains in-flight writes, verifies the
   acknowledged prefix and target data, then commits the new `{owner, epoch}`
   by conditional System Store update. Epochs increase even when old and new
   placements share a Node. The destination must prove that committed epoch
   before writable activation. A failed comparison leaves the old committed
   owner authoritative; no second writer is elected from a timeout alone.
4. Only after the committed grant is observable and the new owner is healthy
   may the App publish its new logical map/routing generation and the Gateway
   publish an Agent-reported target for that placement. The App must bind the
   map transition to the grant identity and expected previous map version.
   Readers of an older map either reach the still-readable source, retry, or,
   once the source is cleaned up, get the relocation answer of step 6; they
   must not treat an empty target or a cleaned source as an empty Tenant.
5. Cleanup of the source follows cutover and is retryable. Keep enough grant,
   map, cursor, verification and recovery state to resume each phase after an
   App, Agent or Platform restart. Preserve the source/recovery artifact until
   completion is durable. Parent Project movement carries every child shard
   placement as one group and revokes/reissues grants under the new allocation.
6. A cleaned source leaves a relocation record. Before the first batch that
   removes the moved Tenant's (or part's) data, the source shard records the
   partition-map version that moved it (`ShardStoreApi.relocate`). The record
   lives with the shard's own metadata, outside the partition range being
   removed, and only ever rises. Every routed call carries the map version it
   was routed by (`RoutedBy`), and from that batch on the source refuses a call
   routed by an older map with `TenantRelocated` naming the moving version,
   never with an empty result, not-found, or partially removed data. The
   record is not routing authority: it carries no address, and the caller
   refreshes its map to at least that version and resolves the placement and
   Agent-reported target as usual. A call routed by that version or a later
   one passes, which is what lets a Tenant routed back to this shard be served
   there; the record also keeps a stale router out of a copy being made onto
   the shard before routing moves to it. Inside one Project runtime the router
   is in-process and the source is dropped only after its leases drain, so no
   caller arrives late there. Implemented in `zelavis/db` (store, router and
   movement); a remote shard transport must carry the caller's map version
   into `RoutedBy` and return `TenantRelocated` typed, since the in-process
   tenant API treats it as a defect.

The Platform must record the operation and phase before dispatching effects.
Every phase is bounded and idempotent; no fleet-wide `Promise.all` or
control-plane startup dependency on finishing all moves. A losing or expired
owner self-fences, and renewal requires comparison against current authority.
If the store, Agent, grant or parent allocation cannot be proven current, the
affected shard refuses writes and remains recoverable. No silent fallback to a
local Node, a second writer, or an ungranted backend is allowed.

## Invariants (each proven by a named test that fails without its guard)

1. A Project cannot choose a Node, exceed its envelope, place outside its
   parent allocation, or mutate another Project's grant, through JS, HTTP,
   CLI, Gateway, or direct Agent messages.
2. At most one committed writer epoch is active per App shard. A stale Agent is
   rejected at the destination and by the storage write fence, including when
   placements are colocated. Epoch high-water survives release and restore.
3. Duplicate delivery, stale revisions, crash at every phase, lease expiry,
   partition and delayed old-owner traffic cannot create two writers or lose
   the acknowledged prefix. A refused operation reports a stable reason and
   leaves a retryable durable state.
4. Logical map publication never precedes verified physical activation;
   cleanup never precedes durable route cutover. A caller holding an older map
   that reaches a cleaned source gets the relocation answer, never an empty
   Tenant, including after the source restarts. Cross-shard writes remain an
   explicit distributed workflow, and shard cursors/checkpoints never use one
   physical SQLite sequence as a logical global order.
5. Project deletion revokes grants and stops Agents before removing data;
   grant and movement records have Project-keyed cleanup participants.

Do not describe automatic failover or distributed replication as operational before their own gates pass; remote
shard placement and Tenant relocation between Nodes are implemented and proven on one machine, with the limits above.

## Clock assumptions

Lease deadlines are Platform wall-clock instants. An Agent checks them against
its own clock, so clock skew shifts when it self-fences, but never how a
takeover is authorized: a newer owner is accepted only after the destination
proves the previous process is gone (`fence.placement`), and every operation is
checked against the durable placement high-water. Run NTP on Platform and Agent
Nodes; skew beyond a few seconds only delays fencing or takeover.

## Remote delivery

Prepare bodies are raw snapshot bytes, read only after a verified single-use
signed authority (header `x-zelavis-authority`); control requests are capped at
16 KiB. A snapshot carries the frozen recipe and descriptor only, and refuses a
Project that already has local runtime data.

### App shard activation (Platform side)

`createAppShardActivation` (`src/platform/app-shard-activation.ts`) drives the ledger and tells the Agent, always in that order:
`activate` records `preparing` (epoch + 1, Project epoch set), delivers `preparing(e)`, records `committed`, delivers `committed(e)`;
`access` reissues the grant at a higher Project epoch (`committed`, epoch + 1) before delivering it, so the Agent's high-water fences
every older token, then signs a 120 s access token; `release` records `releasing`, has the Agent remove the storage, records `released`;
`revokeAll` does that for each live shard, one at a time, as a Project deletion participant (it rejects while an Agent is unreachable,
leaving the deletion retryable). A failed delivery fails the call with `agent-unavailable` and changes nothing further; a retry carries
on from the recorded state. A Platform that lease-guards Projects refuses activation (`lease-guarded`).

The Project reaches this through `runtime/project-shards/:projectId` (list, `requests`, `:shardId/activate|access|release`), authorized by
an HMAC capability naming `(projectId, nodeId, projectEpoch)` that the Platform gives the writer process at start
(`ZELAVIS_APP_SHARDS_AUTHORITY`, `ZELAVIS_APP_SHARDS_TOKEN`; configured by `ZELAVIS_APP_SHARDS_URL`, signed into a remote start's
dispatch as `appShards`). It is honoured only while that triple is the Project's current active placement (else 409
`stale-project-epoch`). `DELETE runtime/nodes/:id` answers 409 `node-in-use` while a live shard names the Node. Candidate Nodes are the
Platform's remote Nodes with the capacity their Agents report. The App opens, places and releases shards through it
(`database/shards`, `src/db/shard-placement.ts`).

### App shard hosting (Agent side)

An Agent hosts an App shard's storage as one SQLite key-value engine under
`<data>/shards/<sha256 of [projectId, incarnation, shardId]>/`. Two routes on the same pinned-CA listener:

- `POST /v1/shards/grants` applies an Ed25519 grant (`preparing`, `committed`, `released` at an epoch; valid 30 s,
  bound to Agent and Node). The Agent keeps a durable, forward-only high-water per shard key (namespace
  `agent.app-shard.v1`): a higher epoch, or the same epoch with an equal or later state. `released` removes the
  storage directory and keeps the high-water, so an older epoch stays refused after release and restart.
- `POST /v1/shards/kv` serves get, scan (cursors over a snapshot), write, conditional write and snapshots for a shard
  whose high-water is `committed` at exactly the access token's epoch. The token is Ed25519-signed by the Platform,
  valid 120 s, and is verified and cached in memory (nothing is persisted per call). Refusals carry a typed code:
  `unauthorized` (401), `stale-epoch` and `not-committed` (409), `unknown-cursor` (404), `busy` (503, 64 open
  cursors and snapshots per shard), `invalid-request` (400), `storage-failed` (500). Grant and write application for
  one shard share a permit, so a grant that raises the epoch waits for an in-flight write.

Cursors and snapshots are memory-only: an idle one is closed after 30 s and an Agent restart drops them. Health
reports the Node's `capacity` (cores, memory, free disk).
