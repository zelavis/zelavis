# Offline editing and multi-writer replication review

Review date: 2026-10-30. This record completes the research decision for the
Data backlog. It authorizes no runtime change. A protocol specification and
owner approval are required before implementing independent writable replicas.

## Decision and product need

Keep one fenced writable owner per partition. Replication, branching and
failover do not grant a replica independent write authority. The shipped
adapter-neutral record/event stream remains the replication contract.

The product roadmap needs shared editing, presence and comments, but those do
not by themselves require offline authoritative database writes. Start a
future offline feature with device-local drafts and a bounded queue of proposed
operations submitted to the current owner on reconnect. The UI must distinguish
pending local edits, accepted changes and rejected/conflicting proposals. An
offline acknowledgement is never a server commit receipt.

Do not make whole-document last-writer-wins the database default. It loses
independent field edits, makes a clock part of data authority and cannot uphold
all existing uniqueness, reference and check constraints without coordination.
Local-first interaction is a product property with several possible storage
models; CRDT convergence alone does not establish application invariants. See
[Local-first software](https://www.inkandswitch.com/local-first-software/) and
[Coordination Avoidance in Database Systems](https://www.vldb.org/pvldb/vol8/p185-bailis.pdf).

## Current guarantees and their boundary

| Scope | Current contract |
|---|---|
| One partition | The store serializes its writer, checks generation/session and revision at atomic commit, and records each document batch with its event log changes. Reads overlay one batch; multi-step reads use one shard snapshot. |
| Two Tenants sharing a shard | Separate partitions, transactions and identifier spaces. Physical colocation gives no cross-Tenant transaction. |
| Divided Tenant | Each part has its own owner and transaction boundary. Whole-Tenant reads/exports are per-part consistent, with no common global snapshot. |
| Several partitions | Explicit scatter reads or a derived, eventually consistent index. Writes require a saga with idempotent steps and compensation; no two-phase commit. |
| Follower | Ordered log replay with duplicate/divergence/gap checks. Its read may lag. Replication alone promises neither synchronous commit nor RPO 0. |
| Branch | A new partition life sharing a bounded history prefix. It is independent after the cut; merge-back is not implemented. |

These are implementation boundaries, not a proof of global linearizability,
serializable distributed transactions, or availability through a network split.
Future acknowledgement policy must separately specify durable replica count,
failure domains, fencing and what a timed-out write may already have committed.

## Proposed consistency by operation

The following is a design recommendation for a separate protocol, not a list
of shipped operations or accepted new collection settings.

| Operation or data | Offline proposal / conflict rule |
|---|---|
| Ordinary document replace/delete | Retain the base version; accept by owner-side compare-and-set or return a conflict with base/local/current values. Never silently overwrite a later edit. |
| Disjoint scalar edits | An opt-in three-way field merge may accept a field only if the owner value still equals its base. Same-field concurrency remains visible. Null and field absence are distinct. |
| Text and ordered collaborative content | Consider an established sequence CRDT at the value boundary; retain operation identity and causal metadata. Do not infer a merge from JSON array positions. |
| Counters and set membership | Consider explicit counter / observed-remove set operations, with their documented concurrent add/remove semantics. A numeric JSON field does not automatically become a counter. |
| LWW field | Only an explicit lossy field policy; total logical order `(Lamport time, peer id, operation counter)`, never device wall-clock time. Preserve losing alternatives for audit/conflict UI within a defined bound. |
| Custom merge | Only a versioned, deterministic, bounded policy with a content digest and convergence tests. Re-evaluate all collection constraints at the owner. An arbitrary user callback is not a distributed data specification. |
| Unique values, references, check constraints, identity and quotas | Online owner acceptance. Pending offline edits cannot reserve a unique value, issue credentials or claim quota. Reject a proposal if current authorization or constraints refuse it. |
| Workloads, payments and outbox effects | No speculative external effects. Emit only with owner commit; delivery remains at least once with consumer deduplication. |

[Replicated Data Types: Specification, Verification, Optimality](https://www.microsoft.com/en-us/research/publication/replicated-data-types-specification-verification-optimality/)
provides a useful formal distinction between different register, counter and
set semantics. Selecting the word "CRDT" without choosing those semantics is
not enough to implement a collection policy.

## Operation identity, ordering and atomic apply

A future proposal envelope must bind the Project, Tenant/part, collection,
record identity, partition incarnation, enrolled peer id/epoch, monotonic peer
counter, operation id, dependencies, base versions, logical schema/policy
version and a bounded payload. Limit peer count, dependency width, payload,
pending operations and retry duration explicitly. Refuse counter exhaustion.

An enrolled device key proves proposal origin only. The owner rechecks current
permission, Tenant scope and policy at application time; a revoked principal
cannot reconnect with old offline authority. No device chooses owner epochs,
physical placements or partition-local dense identifiers.

Use `(peer id, peer epoch, counter)` as stable operation identity. Keep accepted
receipts in the same partition transaction as data, log and emitted outbox
messages. Repeated identity plus identical payload returns the original
receipt; a different payload is an integrity error. Missing causal dependencies
wait in a bounded queue or request resync; they are never applied out of order
by guessing. Concurrent operations follow their explicit merge policy.

Do not transplant a device's physical event positions into the owner log. The
owner assigns its ordinary log positions and stores the proposal identity as
metadata. Replaying an accepted event is still the existing version/idempotency
path. An offline multi-record proposal can be accepted atomically only within
one current partition; changed subdivision/routing requires an explicit retry
or rejection, never partial success presented as a transaction.

## Partial replication, schemas and rejoin

Device subscriptions are explicit authorized Tenant/collection/key scopes, with
scope-specific checkpoints and deletion/revocation notices. A partial replica
cannot decide a database-wide predicate or uniqueness check from what it has
not downloaded. Subscribe/unsubscribe and filter changes require a fresh scope
snapshot plus a log tail; omission from a page never means deletion. Changing
permissions invalidates cached authority, and UI policy must state that already
downloaded plaintext cannot be remotely recalled.

Schema and merge-policy versions are part of operation meaning. The owner
accepts only policies it can interpret. Old proposals require an explicit,
deterministic conversion or are refused with a conflict/export path. Activating
a new schema must not silently reinterpret or erase a device's pending edits.

Use the Platform's authenticated enrollment and rendezvous; do not invent
public peer discovery, allow devices to pick writable owners or make peer-to-peer
transport an authority shortcut. Rejoin exchanges incarnation, scope,
policy versions and causal frontiers before data. A retained-history gap, removed
partition, expired peer epoch or changed scope requires a new snapshot. Pending
local proposals remain exportable and are revalidated individually afterward.

## Tombstones and retention

Keep deletion identity and causal context until every still-admitted peer that
could reintroduce the object has acknowledged beyond it. Time elapsed alone is
not proof of causal stability. Bound membership and offline retention: an
operator may retire a peer after an explicit retention policy, rotate its
epoch, compact its history and require a fresh snapshot on rejoin. A retired
peer's old operations are refused, never allowed to resurrect a deleted record.

The current in-process log holds are not durable peer acknowledgement or a
tombstone GC protocol. Compaction for offline clients would need its own durable
frontier and retention budget. Backups, restored incarnations and branches must
be included in the GC/rejoin specification.

## Before accepting an independent multi-writer model

The owner must choose a concrete offline use case, maximum offline duration,
peer topology, allowable loss/conflict UX, per-collection operations and retained
history budget. The separate specification must state exact transaction and
read guarantees, authorization after revocation, causal delivery, receipt and
tombstone retention, schema conversion, disaster recovery and partition splits.

Qualification needs reproducible model tests under duplication, reordering,
loss, partitions, crashes, clock skew, restored old snapshots, revoked peers and
compaction. Verify convergence **and** invariants; benchmark metadata and rejoin
cost. No reliability or multi-writer claim ships before those tests pass.

Consensus and conflict resolution solve different problems: the existing owner
model must remain fenced while collaborative values are explored. For comparison,
the [Raft paper](https://raft.github.io/raft.pdf) describes a single-leader
replicated log; it is not a reason to infer multiple writable owners from the
presence of replicas, nor a decision to introduce Raft into Zelavis.
