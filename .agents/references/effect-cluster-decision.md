# What Zelavis takes from Effect Cluster

Status: **decided 2026-10-31** (delegated decision). Phases 1 (durable entities, `src/db/entities.ts`), 2 (durable Workloads, `src/app/workloads/durable.ts`) and 3 (writer
leases, `src/db/writer-lease.ts`, with the open items below) are implemented; the later phases are ordered work, tracked in `pnotes/TODO.md`.

Sources: the four Effect "Module of the Week" posts on Cluster (actors, messaging, delivery, idempotency) and
the Effect v4 source in `repos/effect/packages/effect/src/cluster` (`Entity`, `Sharding`, `ShardingConfig`,
`MessageStorage`, `RunnerStorage`, `SqlRunnerStorage`, `ClusterWorkflowEngine`, `Singleton`, `ClusterCron`,
`DeliverAt`).

## What Cluster is

- **Entities** are virtual actors: an address (type + id), a mailbox, private state, one message at a time,
  started by the first message, passivated after `entityMaxIdleTime`, kept up by `Entity.keepAlive`.
- **Shards** are a fixed set of buckets (`shardsPerGroup`, 300 by default); `hash(entityId)` picks the shard.
  Changing the count reshards everything.
- **Runners** register in storage and each computes the same assignment: a consistent-hash ring with 128
  virtual nodes per runner, weights, and bounded loads (arXiv 1608.01350). No coordinator.
- **Ownership** is a shard lock (Postgres/MySQL advisory lock, or a row with `acquired_at`) that the holder
  refreshes and that expires after `shardLockExpiration`. A crashed owner's shards wait for the expiry.
- **Delivery**: `discard` is at-most-once once the message reaches the mailbox. `ClusterSchema.Persisted`
  saves the message before delivery and redelivers unprocessed messages to the next owner (at-least-once).
  "Processed" is when the handler returns, or when `toLayerQueue`'s `replier` answers, so an entity replies
  only after its work is durable.
- **Idempotency**: `primaryKey` dedupes a persisted message by a caller-supplied key.
  `ClusterSchema.WithTransaction` runs the handler inside the transaction that marks the message processed
  (same `SqlClient`, same database). External effects go through an outbox; Workflow tracks the steps.

## Where Zelavis already stands

The database layer already holds the hard parts of Parts 3 and 4, natively and more strictly:

| Cluster | Zelavis today |
|---|---|
| `primaryKey` dedupe | `idempotencyKey` on writes, its receipt committed in the same batch |
| `WithTransaction` (same SQL database) | one partition batch: the write, its receipt and any `emit` are atomic by construction |
| Transactional outbox | `documents.write({ emit })`, `outbox.read/remove`, at least once, consumers dedupe by id |
| Workflow over persisted messages | `db.workflowEngine` records executions, activity results, deferreds and clocks in the global partition; `tenantWriteActivity` keys each step |
| One writer per entity | one writer per partition, a permit, and a writer generation checked in every commit |
| Shard lock | shard writer claim with a generation; Project placement `{owner, epoch}` CAS with Agent self-fencing |

What Zelavis does not have: an App-facing actor primitive, durable execution of Workloads (jobs, schedules
and webhooks are definitions without a durable runner: `TODO` "Workloads: durable queues, distributed
execution, retries, leases, scheduler ownership"), follower failover, and a placement planner for remote
shards.

## Decisions

1. **Do not adopt Cluster's `Sharding`/`RunnerStorage` as placement or writer authority.**
   - Its lock is a lease with no fencing token passed to the work it guards. A paused owner (GC, a stopped
     VM) can keep writing after its lease expired, and nothing at the storage boundary refuses it.
   - Zelavis requires every writer to be fenced where it writes, by a writer generation or an
     `{owner, epoch}` CAS (AGENTS.md).
   - Its coordinator-less ring also conflicts with the rule that the Platform Fabric alone decides placement,
     and with the App's authoritative, versioned partition map.
   - Its SQL drivers need an `SqlClient`; Zelavis has no raw SQL surface, on purpose.
   - It is `unstable`.
2. **Adopt the Entity programming model as a native App primitive: durable entities.**
   - **Address:** `(Tenant, entity type, entity id)`. The mailbox is records in the Tenant's own partition
     (a reserved namespace, `zv.mailbox`), so routing an entity is routing its Tenant: location transparency
     comes from the existing router, and a moved Tenant keeps its mailboxes.
   - **Persisted by default.** Enqueue is one partition write; the message id is `(partition, Seq)`, not a
     Snowflake (dense partition-local identifiers stay the rule).
   - **`primaryKey`** is the existing idempotency receipt, so a resent message is recognised, not saved twice.
   - **Transactional handlers are the default.** A handler's writes to its Tenant, its outbox messages and
     the message's processed mark commit in one batch. This is Cluster's `WithTransaction` without the
     same-database caveat, and it gives exactly-once database effects over at-least-once delivery.
   - **Effects outside the database** go through the outbox.
   - **No replier, keep-alive or passivation.** Cluster needs them because an entity's work and its processed
     mark live in different places and its instance holds state in memory. Here a handler's step commits with
     the mark, its state is a record read per message, and the pending marker is itself the intent to process:
     nothing is resident, so nothing can be put to sleep mid-work. Bounds kept: mailbox capacity
     (`MailboxFull`, 4096), attempts with doubling backoff, a handler timeout, cancelling, `deliverAt`,
     and retention of finished messages (seven days), which bounds how long a `primaryKey` is remembered.
   - **One message at a time** per entity, in arrival order. Entities are served concurrently (bounded); a
     handler's reads are its own and its commit checks that its message is still owed, and writes it makes on
     shared documents use `expectedVersion`, so a concurrent change refuses the step and it is retried.
   - **Protocols** are declared with `effect/rpc` `Rpc.make` schemas, so an entity's messages are typed,
     serialisable and adaptable to HTTP, SDK and CLI from one definition (the parity rule).
   - **Runtime:** Zelavis's own, inside the Project runtime, never Cluster's `Sharding`.
3. **Workloads get durable execution on entities.**
   - **Jobs** are persisted messages to a job entity.
   - **Inbound webhooks** save before answering and take the provider's event id as `primaryKey`.
   - **Outbound webhooks** are outbox messages delivered at least once, with an `Idempotency-Key` header.
   - **Schedules** are durable wake records (persist wake intent before idle eviction, as the conformance
     item in the TODO already demands), fired by the Project's single writer. Cluster's `ClusterCron`/`Singleton` idea is used
     with fencing: a duty that must run once runs where the writer generation is held.
4. **Singleton duties follow the writer.** Cross-Tenant index refresh, backup schedules, workflow resumption
   and schedules run only in the process holding the database's writer claim. No Project runtime advertises
   `statelessRuntimeReplicas` today, so this already holds; it becomes a checked rule before any runtime with a
   database is allowed replicas.
5. **Follower failover reuses Cluster's handoff shape, with fencing.**
   - The writer holds a lease in the System Store `{owner, epoch}` record.
   - A follower is promoted only after the lease expired and it caught up to the acknowledged high-water it
     can prove (the leader transport's acknowledgments).
   - Promotion is one CAS raising the epoch; every commit checks the epoch, so a returning old writer is
     refused at its first write.
   - This is the TODO's "Follower failover" item; it waits for that item's turn after shard movement in the
     agreed sequence.
6. **Placement proposals use consistent hashing with bounded loads; placement stays a committed record.**
   - When the two-fabrics contract activates remote shards, the planner proposes `shard → Node` with virtual
     nodes, Node weights from capacity, and a load cap, which minimises movement when Nodes come and go.
   - The proposal is only a proposal: the Platform Fabric commits it as versioned, fenced placement, and the
     App's movement copies data before routing changes.
   - Keep the virtual range count generous (256 today); changing it remaps every Tenant.
7. **Every channel states its delivery guarantee.** The public docs carry one table:
   - **Leader transport:** at least once; positions make it idempotent.
   - **Agent dispatch:** single-use authority and a replay store make it at most once per authority.
   - **Gateway envelopes:** a nonce makes them at most once.
   - **Outbox:** at least once; consumers dedupe by message id.
   - **Document writes:** at least once with `idempotencyKey`.
   - **Workload webhooks:** per decision 3.

   Any new channel declares its row before it ships. The SDK already retries only idempotent calls; keep that.
8. **Borrowed from `ClusterWorkflowEngine` for the day workflows run in more than one process.**
   - A resume clears a reply only if it is still the latest (`clearReplies` with `expectedReplyId`).
   - Interrupts are messages.
   - Execution ownership follows the global partition's writer.

9. **Who calls whom in a failover (decided 2026-11-01).** Decentralised where it can be, central where authority is.
   - **Nobody tells a follower to take over.** A standby watches the writer's lease in the Platform's lease authority and,
     once it has lapsed and the standby holds every acknowledged position, promotes itself with one compare-and-set
     against that authority. The authority's conditions are the only arbiter; a coordinator that could be wrong or
     partitioned is not in the path of safety.
   - **Nobody tells the other followers where the writer went.** The lease carries the writer's `endpoint`; every
     follower (a third node, or the old writer returning) reads the lease and follows whoever it names
     (`followWriter`). A change of epoch re-points them.
   - **The Platform never calls a node to promote.** It holds the authority, so it learns of a promotion by the lease
     record itself, audits it (`GET /runtime/writer-lease-audit`, with who asked and any accepted loss) and, when the
     partition belongs to a Project, reconciles the Project's Fabric placement `{owner, epoch}` to the promoted node:
     the Fabric starts the Project there through the existing signed remote start and fences the previous owner by
     epoch. The promoted node does not ask the Fabric for placement, and the Fabric does not order promotions; it
     only decides which nodes may stand by (policy) and where the Project's traffic goes (placement).
   - **Operators** may still `promote`/`demote` by hand; accepting data loss needs
     `database.failover.accept-data-loss` and is audited.

## Phases

1. **Durable entities** (done 2026-10-31) in `zelavis/db` and the Workloads service:
   - The mailbox, persisted delivery, `primaryKey`, transactional handlers, bounds and cancelling.
   - JS, HTTP, SDK and CLI.
   - A dashboard page under Workloads.
   - Tests: SIGKILL tests in the style of `db-durability.test.mjs` proving each message's database effects
     land exactly once across crashes, a seeded model test of the mailbox state machine, and the
     multimodal and bounded checks the store already holds itself to.
2. **Durable Workloads** (done 2026-10-31): jobs, schedules (durable wakes, run where the writer is), inbound
   webhooks with provider keys, outbound webhooks through the outbox with `Idempotency-Key`, and the entity runner's
   in-memory due index (partition to earliest due time; one scan at start; a safety-net scan every five minutes).
   Nothing polls: definitions are reread on change (with a one-minute safety read), outbound delivery is woken by
   outbox commits in the process (`database.outboxWatch`), schedules sleep until their fire time, and messages waiting
   for a handler are looked at again when handlers change. Inbound webhooks verify an HMAC of the body or a timestamped
   one. A runtime that holds a database is never planned more than one replica (decision 4 as a checked rule in the
   Fabric planner).
3. **Follower failover** (decision 5): implemented 2026-10-31 in `src/db/writer-lease.ts` (lease protocol, gate in
   the store's write path, `standby`/`hold`, `followers lease|promote|demote` over JS, HTTP, SDK and CLI), tested with
   two databases in one process, a cut-off writer and a seeded protocol model. The Platform serves the lease authority
   (`/runtime/writer-leases`, `httpLeaseStore`) and `pnpm release:qualify:failover` holds a `SIGKILL`, a partition and
   an unacknowledged tail to the decision in separate containers. Other followers find the new writer from the lease
   (`followWriter`), `allowDataLoss` needs its own permission and is audited, and the control flow is decision 9.
   The writer names the one follower it waits for (`standby`) and only that follower is promoted without accepting loss: the lease's `acknowledgedHead` lags up to a third of its life, so without it a different level follower could miss a write acknowledged just before the writer died.
   **Open:** the Fabric half of decision 9 — a general way to start a Project on another node from its follower copy
   (a standby Project supervised by that node's Agent) and to commit the placement `{owner, epoch}` when the lease
   epoch advances — and running `standby` inside those standby Projects.
4. **Bounded-load placement planner** (decision 6), with two-fabrics activation.
5. **Delivery-guarantee table** in the public docs (decision 7), written alongside phase 1 and kept current.

## Not doing

- Running `effect/cluster` as Zelavis's runtime, or Cluster's SQL storage beside the Zelavis database.
- Snowflake identifiers for records.
- A coordinator-less ring as authority.
- Claiming exactly-once delivery anywhere. The claim is exactly-once database effects for idempotent handlers.
