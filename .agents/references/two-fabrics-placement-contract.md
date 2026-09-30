# App Data Fabric ↔ Platform Fabric placement contract

Status: **internal request/admission contract implemented; activation is not**.
`src/platform/app-data-placement.ts` accepts an authenticated Project identity,
checks a trusted allocation and Node inventory, and conditionally persists a
Project-wide reservation ledger. A reservation is neither a writer grant nor a
routable target. The official App starts with virtual ranges spread over local
SQLite shards; its `PartitionMap` and `movement.rebalance` operate inside one
Project runtime. The Platform Fabric currently places whole Projects. Remote
shard placement and movement are not operational. (Whole-Project placement is
separate and implemented: a `{owner, epoch}` CAS record per Project, Agent
self-fencing, and signed remote Project dispatch; see AGENTS.md. Nothing here
activates App shards on another Node.)

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
   Readers of an older map either reach the still-readable source or retry;
   they must not treat an empty target as an empty Tenant.
5. Cleanup of the source follows cutover and is retryable. Keep enough grant,
   map, cursor, verification and recovery state to resume each phase after an
   App, Agent or Platform restart. Preserve the source/recovery artifact until
   completion is durable. Parent Project movement carries every child shard
   placement as one group and revokes/reissues grants under the new allocation.

The Platform must record the operation and phase before dispatching effects.
Every phase is bounded and idempotent; no fleet-wide `Promise.all` or
control-plane startup dependency on finishing all moves. A losing or expired
owner self-fences, and renewal requires comparison against current authority.
If the store, Agent, grant or parent allocation cannot be proven current, the
affected shard refuses writes and remains recoverable. No silent fallback to a
local Node, a second writer, or an ungranted backend is allowed.

## Invariants to prove before remote movement ships

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
   cleanup never precedes durable route cutover. Cross-shard writes remain an
   explicit distributed workflow, and shard cursors/checkpoints never use one
   physical SQLite sequence as a logical global order.
5. Project deletion revokes grants and stops Agents before removing data;
   grant and movement records have Project-keyed cleanup participants.

Activation still requires authoritative `{owner, epoch}` placement records,
Agent supervision and destination fencing, publication ordering, and failure
tests. Do not describe remote shard movement, automatic failover or distributed
replication as operational before those gates pass.

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
