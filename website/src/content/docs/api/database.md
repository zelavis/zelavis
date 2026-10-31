---
title: Database
---

Zelavis App includes a project database service with documents, events,
schemas, projections, and time-series. It is separate from the Platform OS
System Store.

This page is the in-process API, for code running inside a Project. An App
reaching its own records from outside — a desktop client, a worker, another
host — uses [App Data](/api/app-data), which is the same database behind a
boundary that resolves the Tenant from the caller.

## Bind a Tenant first

Ordinary App data access always begins with a real Tenant ID. There is no
implicit default Tenant:

```ts
import { Zelavis } from 'zelavis';

const zv = new Zelavis({ adapter });
const tenantDb = zv.db.forTenant('tenant_acme');

await tenantDb.documents.createCollection({ name: 'posts' });

const doc = await tenantDb.documents.insert({
  collection: 'posts',
  data: { title: 'Hello', published: false },
});

await tenantDb.documents.update({
  collection: 'posts',
  id: doc.id,
  data: { published: true },
});
```

Tenant identity is not accepted inside document or event inputs. Binding it
once prevents a caller from accidentally mixing data from different Tenants in
one operation sequence.

Each Tenant is a partition of its shard: everything it stores lives in its own
range of keys, with its own identifiers and its own event log. Nothing written
for one Tenant is reachable through another Tenant's handle, and a Tenant moved
to another shard keeps its identifiers and log positions, so its cursors and
projection checkpoints carry on.

A transaction is atomic within one Tenant. A batch (`documents.write`) commits
together or not at all; there is no write that spans Tenants. Work that must
change several Tenants writes each Tenant's part separately, with an
`idempotencyKey` so a retry is safe.

## Durability

What a commit that returned survives is chosen when the database opens, and
`health` reports it (`storage: { engine, durability }`):

| `durability` | A returned commit survives | Cost |
|---|---|---|
| `crash` (default) | the process being killed; a power cut can lose a suffix of the latest commits, never leave holes | none beyond the write |
| `power` | a power cut too | a device flush per commit |

```ts
const zv = new Zelavis({ adapter: nodeAdapter({ database: { durability: 'power' } }) });
```

SQLite and LMDB offer both. RocksDB's binding has no per-commit log sync, so
opening it with `power` is refused rather than given the weaker promise.
A Project chooses its own: the choice is recorded beside its shards and used from its next start, and until then
health and the storage operation report it as `pending`. `GET|PUT …/database/maintenance/storage` (`{ durability }`;
reading needs `database.inspect`, choosing `database.define`), `client.projects.databaseStorage(projectId)` /
`setDatabaseStorage(projectId, { durability })`, `zelavis projects storage <id> [--durability crash|power]`, and the
dashboard's Database → Images page. A host option given when the database opens wins over the recorded choice.

Replication is not durability by itself: a follower holds what it has applied,
which can be behind the leader. `zelavis/db` keeps followers level with
`followLeader`, and a caller that needs a write held elsewhere before it
proceeds waits for it:

```ts
import { followLeader, makeFollowerAcknowledgments, writeAcknowledged } from 'zelavis/db';

const acks = yield* makeFollowerAcknowledgments;
yield* Effect.forkScoped(followLeader(leader, replica, { interval: '50 millis', acknowledgments: { name: 'east', to: acks } }));
const { acknowledgedBy } = yield* writeAcknowledged(leader, acks, write, { followers: 1, timeout: '2 seconds' });
```

A follower acknowledges a position only after committing it in its own
storage, so an acknowledgment is as durable as that follower's `durability`.
When fewer followers than required arrive in time the call fails with
`FollowersNotAcknowledged`; the write stays committed on the leader, it is
simply not yet held elsewhere.

### Followers on other hosts

A follower on another host reads its leader through the **leader transport**: the leader's database answers
everything a follower pass needs — a partition's stats, its records a page at a time, its log, holds on the log, and
the acknowledgments followers send back — and `remoteLeader` turns that into the same source a follower in the
leader's process reads, so `levelFollower` and `followLeader` run unchanged against it:

```ts
import { remoteAcknowledgments, remoteChanges, remoteLeader } from 'zelavis/db';

const transport = client.followers(projectId);          // the leader's Project, through the Platform
yield* db.followers.follow(remoteLeader(transport, 'acme'), {
  partition: 'acme',
  interval: '1 minute',                                  // a fallback only
  wakeups: remoteChanges(transport, { partitions: ['acme'] }),
  acknowledgments: { name: 'east', to: remoteAcknowledgments(transport, 'acme') },
});
// On the leader, a write waits for the remote follower as for a local one:
yield* writeAcknowledged(yield* leaderDb.followers.source('acme'), yield* leaderDb.followers.acknowledgments('acme'), write, policy);
```

- **Same positions, same checks.** Identifiers, versions, log positions and cursors are the leader's own, so a cursor
  taken on one side continues on the other, and everything the follower applies is checked as it is applied
  (`EventGap`, `ReplicaDiverged`) whatever carried it. The failures a follower acts on cross the transport as
  themselves (a 409 carrying `code` and `detail`): a compacted cursor is `CursorCompacted` on the follower too, and it
  copies the partition again.
- **Holds on the leader's own placement.** A remote follower's hold is taken where the partition is placed when the call
  arrives, and moves with the partition: a move takes the source's live holds on the target before routing points
  there, and again before the source is dropped.
- **Acknowledgments with the leader.** A follower reports the head it committed, after its own commit; the leader keeps
  each follower's highest position per partition while it is open (`db.followers.acknowledgments`), and
  `writeAcknowledged` waits on it.
- **The change feed.** `changes` answers which partitions moved past the heads a caller says it knows, waiting up to
  `timeoutMillis` (default 25 s, at most 60 s) for a write when none has, at most 1000 partitions an answer with `more`.
  The heads are the durable log heads, so a request lost to the network, or a follower restarted, misses nothing: the
  next answer names everything that moved. A follower wakes on it instead of polling.
- **Following into a database.** `db.followers.follow` keeps a partition of this database a follower of a leader and
  tells this database's cross-Tenant indexes after every pass that changed it, so an index on a read replica follows
  the leader's writes as they arrive. Writing a followed partition any other way diverges it, and the next pass copies
  it again from the leader.

Every route needs `database.replicate`, which the Platform grants with `project.runtime.manage`.

| Form | Operations |
|---|---|
| HTTP | `GET …/database/followers/:partition/stats`, `POST …/:partition/records` `{ after?, limit }`, `POST …/:partition/log` `{ after?\|from?, limit }`, `POST …/:partition/holds` `{ id, position, ttlMillis }`, `DELETE …/:partition/holds/:holdId`, `POST\|GET …/:partition/acknowledgments`, `POST …/database/followers/changes` `{ heads?, partitions?, timeoutMillis? }` |
| SDK | `client.followers(projectId).stats\|records\|log\|hold\|release\|acknowledge\|acknowledgments\|changes` |
| CLI | `zelavis followers <stats\|records\|log\|hold\|release\|acknowledge\|acknowledgments\|changes> --project ID [partition] …` |

Not yet: a writer elsewhere promoted from a follower (failover), which needs the fenced `{owner, epoch}` handover the
Fabric gives Project placement, and remote shard movement.

## API surface

The logical database API deliberately does not expose a physical driver,
SQLite filename, or raw SQL connection.

| Property | Description |
|---|---|
| `forTenant(tenantId)` | Returns Tenant-bound documents, events, and time-series APIs. |
| `schemas` | Global collection schema definitions applied across shards. |
| `projections` | Projection definitions and rebuild controls. |
| `timeseries` | Global time-series definition registry. |
| `capabilities` | Logical database capabilities such as Tenant routing. |
| `context` | Runtime configuration and Node identity. |

Below this API, storage is an ordered key-value engine — SQLite by default,
with RocksDB and LMDB as optional engines — one engine per shard. There
is no SQL surface: one logical App database spans several shard files, and every
write goes through the documents API.

## Documents

```ts
tenantDb.documents.createCollection(input)
tenantDb.documents.listCollections()
tenantDb.documents.collectionExists(input)
tenantDb.documents.insert(input)
tenantDb.documents.findById(input)
tenantDb.documents.findMany(input)
tenantDb.documents.update(input)
tenantDb.documents.delete(input)
```

Documents are JSON objects. Each write appends its event and updates the
document's record and indexes in one atomic batch, so a crash leaves either the
whole write or none of it.

A page in the default identifier order (`findPage` with no `orderBy`), and
`findMany` with a `limit` and no order or search, read only the documents they
return: the store resolves the matching identifiers a window at a time from
the cursor and stops when the page is full, so a page deep into a large
collection costs about the same as the first. A filter made only of ranges or
text prefixes is read the same way through the collection's own index,
checking each document; when its matches are scattered too thinly for that to
pay, a call stops after a few thousand checks and evaluates the filter whole
instead, so it never costs more than it used to.

Every scalar field is indexed unless the collection declares `columns`, the
fields it queries: `createCollection({ name, columns })` indexes only those
(each covering the fields below it), and `documents.setColumns({ collection,
columns })` changes the choice and rewrites the documents under it, with
`null` indexing every field again. Equality, `in`, ranges and single-field
order on any other field fail with `UnindexedField` rather than scanning, and
a reference must read a declared field. Over HTTP the choice is `columns` on
`POST …/documents/collections` and `POST …/documents/:collection/columns`; on
the CLI it is `--columns` on `zelavis data create-collection` and
`zelavis data set-columns`.

## Measures and materialized aggregates

A collection's `measures` are the numeric fields aggregates read. Besides
`summarize` and `summarizeBy` (count, sum, avg, min, max, variance, stddev,
countDistinct), a Tenant answers two more questions from the measure lens alone,
without reading any document body:

```ts
await tenantDb.documents.covariance({ collection: "orders", measure: "total", with: "items", sample: true });
// { value, documents } — only documents carrying both measures count
await tenantDb.documents.histogram({ collection: "orders", measure: "total", boundaries: [0, 50, 100, 500] });
// { buckets: [{ lower, upper, count }], underflow, overflow, documents, min, max, sum, avg }
```

A histogram takes either `boundaries` (2–257 strictly increasing numbers) or
`bins` (1–256, default 10) with optional `min`/`max`; a bucket includes its
lower edge and the last bucket its upper edge. Both accept the same filters as
`summarize` (`where`, `related`, `search`, `geometry`, `linked`) and read every
measure from one snapshot.

A materialized aggregate stores the answers to a fixed set of these questions:

```ts
await tenantDb.aggregates.define({
  name: "sales", collection: "orders", where: [{ path: "status", value: "paid" }],
  operations: [
    { name: "revenue", op: "sum", measure: "total" },
    { name: "byRegion", op: "sum", measure: "total", groupBy: "region" },
    { name: "spread", op: "histogram", measure: "total", bins: 20 },
  ],
});
const sales = await tenantDb.aggregates.refresh("sales");
sales.results.revenue; sales.checkpoint; sales.refreshedAt;
```

A definition is immutable (drop it to change it), holds 1–16 operations, and a
Tenant holds at most 128. `refresh` computes every result from one snapshot,
then publishes them together with `checkpoint`, the Tenant's log position that
snapshot was taken at, in one transaction that first checks the log has not
moved. A write that lands meanwhile makes that attempt start over; after three
it fails with `AggregateChanged` and the last published results stay. So the
results are always exactly the Tenant as of `checkpoint`. Refreshing is
explicit: nothing recomputes an aggregate on a write. Defining, refreshing and
dropping need `database.define`; reading needs `database.read`.

## Importing from another system

A collection is filled from another system's export, read rather than connected to: CSV (Postgres and Supabase
`COPY … TO STDOUT WITH CSV HEADER`, MySQL, spreadsheets), NDJSON or a JSON array (Firestore exports, most document
stores). Accounts and credentials, and media files, are not part of a data import.

```ts
const source = { collection: 'products', format: 'csv', text, types: { price: 'number', stock: 'integer', active: 'boolean' } };
const plan = await tenantDb.imports.plan(source);        // writes nothing
if (!plan.valid) console.log(plan.problems);              // first 100, with row numbers; problemCount is all
let next = 0;
do next = (await tenantDb.imports.run({ ...source, importId: 'shop-2026-10', offset: next })).next;
while (next !== undefined);
const check = await tenantDb.imports.verify(source);      // { ok, matched, missing, different, sourceChecksum, storedChecksum }
```

- **Rows.** Each row needs an id (`idField`, `id` by default), which becomes the document id and is not kept in its
  data. CSV needs a header; a column is text unless `types` names it `number`, `integer`, `boolean` or `json`, and an
  empty cell is absent. JSON rows keep their own types. At most 8 MiB and 100,000 rows per source; split larger exports.
- **Plan** is the dry run: unparseable rows, missing or repeated ids, values the collection's active schema refuses,
  and (for `mode: "insert"`, the default) ids the collection holds already. `mode: "upsert"` replaces held ids.
  It answers a SHA-256 `checksum` of the rows as they will be stored.
- **Run** writes from `offset`, at most `limit` rows (1 to 5000) per call, in atomic batches of 250 whose idempotency
  key names the import, the batch and the checksum. Repeating a call, or resuming after one was cut off, writes
  nothing twice; continue from the `next` it answers. Its first call refuses a source whose plan has problems,
  treating a held document identical to its row as this import's own earlier write.
- **Verify** reads every row's document back and compares its content; `ok` means every row is stored exactly and
  the checksums agree. A cutover is: plan until valid, run to the end, verify `ok`, then move writers over (and verify
  again if the source kept changing).

Plan and verify need `database.read`; run needs `database.write`.

## Search, global ranking and hybrid reads

Declare an analyzer on a collection (`{ fields: ['body'], version: 1 }`), then
use `search` on `findMany`. Words, field-qualified terms, prefixes (`comput*`),
fuzzy terms (`macbok~`) and quoted phrases share the document indexes.
`analyzer.phrases: true` stores adjacent word pairs. A two-word phrase is
answered exactly by those postings; longer phrases intersect their pairs and
verify their order in each candidate. This uses extra postings per adjacent
pair rather than storing a position list for every word occurrence. Without
pair postings, phrases are verified against candidate documents.

`analyzer.synonyms: [['car', 'automobile']]` expands single words at query time.
Multi-word synonyms are refused. Changing synonyms requires no change to the
stored term postings. Text results carry BM25 `score` values.

```ts
const matches = yield* tenantDb.documents.findMany({
  collection: 'items', search: 'car',
  where: [{ path: 'published', value: true }],
  similar: { field: 'embedding', vector: queryVector, approximate: false },
  hybrid: { text: 2, vector: 1, k: 60, depth: 100 },
  limit: 20,
});
```

Providing both `search` and `similar` fuses their independently ranked
candidates with weighted reciprocal rank: `text / (k + textRank) + vector /
(k + vectorRank)`. Structured filters constrain both candidate sets. Defaults
are equal weights, `k: 60`, and `depth: 100`; depth is bounded from 1 to 1000,
and each weight and `k` is finite, non-negative and at most 1,000,000.
The result is exact for the two candidate rankings when `approximate: false`;
depth still limits the candidate pool. Approximate vector retrieval can miss
neighbors. Field ordering cannot accompany hybrid relevance ordering.

`db.scatter.findMany({ collection, tenants, search, limit })` first obtains
each partition's `documents.searchStatistics`, sums them, then ranks every leg
against that global corpus before merging by score. Scores therefore match a
single partition containing the union, assuming the data stays unchanged
between passes. There is no snapshot across partitions. Different analyzers
also define different matching semantics; use the same analyzer for comparable
rankings. A caller can perform the same statistics pass explicitly and supply
`statistics: { documents, length, frequencies }` to each text query.

HTTP uses `POST …/documents/:collection/query`,
`POST …/documents/:collection/search-statistics` and
`POST …/documents/:collection/scatter`. The SDK methods are
`data.documents.query`, `.searchStatistics` and `.scatter`; the CLI is
`zelavis data query|search-statistics|scatter COLLECTION --project ID --data JSON`.
Scatter is an operator read requiring `database.inspect`, reached through the
Project proxy (`project.view`), rather than ordinary Tenant data authority.
Its HTTP page and per-Tenant limits are 1–1000 (100 by default); results report
each leg and truncation. For repeated cross-Tenant queries, use a derived
cross-Tenant index to avoid fan-out.

## Events and cursors

```ts
const page = await tenantDb.events.read({
  collection: 'posts',
  limit: 100,
});
// page.events, page.cursor, page.more

const nextPage = await tenantDb.events.read({
  collection: 'posts',
  after: page.cursor,
  limit: 100,
});
```

The same Tenant feed is available to external Apps through
`client.data(projectId).events.read`, `POST …/data/events/read`, and
`zelavis data changes --project ID [--after CURSOR] [--limit N] [--data JSON]`.
It needs read authority, including when sent as POST. Collection declaration
writes report `collection.updated` after creation; collection removal reports
`collection.deleted`. Document writes/removal report `document.upserted|deleted`.

A read looks at a bounded stretch of the log and returns `cursor`, the point
where it stopped. That point is past events that did not match as well as those
that did, so continue from `page.cursor` rather than from the last event's
cursor: a long run of writes elsewhere would otherwise be read again on every
call. `more` is true when the read stopped before the end of the log, and a
page can be empty while `more` is true. The KV change feed
(`kv.namespace(name).changes()`, `POST …/kv/:namespace/changes`,
`zelavis data kv-changes`) returns the same `{ changes, cursor, more }` shape.

`DatabaseEvent.cursor` is an opaque, versioned continuation token. Persist it
and pass it back unchanged. Do not parse, compare, increment, or assume it is a
global integer: it names a position in the Tenant's own log, which moves with
the Tenant and means nothing in another Tenant's.

A read of several steps — a query resolving its matches and then reading the
documents — answers from one snapshot of its shard, so it sees one moment
however many writes land while it runs. Writes always see the shard as it is:
their checks run inside the transaction that commits them.

## Workflows and sagas

A change that spans Tenants (or the parts of a divided Tenant) is never one transaction: it is a saga, a sequence
of steps each committed in its own Tenant, with an undo for each in case a later step fails. Zelavis runs sagas
on Effect's workflow model (`effect/workflow`) with a durable engine recorded in the database itself,
`db.workflowEngine`:

```ts
import { Workflow } from 'effect/workflow';
import { tenantWriteActivity } from 'zelavis/db';

const Transfer = Workflow.make('Transfer', {
  payload: { id: Schema.String, amount: Schema.Number },
  idempotencyKey: ({ id }) => id,
});
const move = (tenant: string, delta: number, name: string) => tenantWriteActivity({
  name, success: Schema.Void,
  write: (idempotencyKey) => db.forTenant(tenant).documents.write({ operations: [/* … */], idempotencyKey }),
});
const TransferLive = Transfer.toLayer(Effect.fnUntraced(function* ({ amount }) {
  yield* move('alice', -amount, 'debit').pipe(Workflow.withCompensation(() => Effect.orDie(move('alice', amount, 'refund'))));
  yield* move('bob', amount, 'credit');
}));

yield* Transfer.execute({ id: 'transfer-42', amount: 30 }).pipe(
  Effect.provide(Layer.provideMerge(TransferLive, db.workflowEngine)),
);
```

- **Each step runs once.** The engine records each activity's result when it completes, in the global partition,
  and every replay of the workflow (they replay from the start) answers from the record. A step cut off before its
  result was recorded runs again, so a step's effect must be idempotent: `tenantWriteActivity` hands its write an
  idempotency key made of the execution and the step, so the Tenant applies it once.
- **Compensation.** `Workflow.withCompensation` registers the undo of a completed step; if the workflow fails after
  it, the undos run.
- **Restarts.** An execution is recorded before it runs and its result when it ends. When a workflow is registered
  (its layer built), every execution of it left unfinished resumes, without running recorded steps again, and its
  durable clocks are scheduled again.
- **From the outbox.** `startFromOutbox({ outbox, topic, workflow, payloadOf, interval })` starts an execution for
  each message a Tenant's outbox holds on a topic and removes the message once the execution is recorded. Take the
  execution's idempotency key from the message id, so a message delivered twice starts one execution.
- **One process runs them.** Like the database's writer, the engine runs in one process; build its layer once.
- **Inspecting.** `GET …/database/workflows/executions` (`database.inspect`), `client.projects.workflowExecutions(projectId)`,
  `zelavis projects workflows <id>` and `db.workflowExecutions()` list recorded executions, whether each is complete,
  and how many steps completed. Workflows themselves are code a Project registers, so they have no HTTP form.

Effect marks `effect/workflow` unstable; Zelavis pins Effect to an exact version and tests the engine on every bump.

## Outbox

App code that must tell another system about a write emits a message with it.
The message is recorded in the same transaction as the changes, so it exists
exactly when they do:

```ts
await tenantDb.documents.write({
  operations: [{ _tag: 'Insert', collection: 'orders', id: 'o1', data: { total: 10 } }],
  emit: [{ topic: 'order.placed', payload: { order: 'o1' } }],
});

await tenantDb.outbox.emit({ topic: 'note', payload: { n: 1 }, idempotencyKey: 'k1' });

const page = await tenantDb.outbox.read({ limit: 100 });
// page.messages: [{ id, topic, payload, emittedAt, cursor }], page.cursor, page.more
const next = await tenantDb.outbox.read({ after: page.cursor, topic: 'order.placed' });

await tenantDb.outbox.remove({ ids: page.messages.map((message) => message.id) });
```

A read pages the log like an event read: `cursor` is past everything it looked
at, and `more` says there is more to read now. Delivery is at least once — a
consumer cut off reads a page again, and a restored backup writes its messages
again — so a consumer deduplicates by message `id` and removes what it has
handled; removed messages are not read again. An id is generated when absent
(`idempotent:<key>` for an emit with an idempotency key), and an id the outbox
already holds is refused with `MessageExists` (409). A topic is 1 to 256
characters and a payload a JSON object, or the message is refused with
`InvalidMessage` (400) before anything is written.

| Form | Read | Emit | Remove |
|---|---|---|---|
| HTTP | `GET …/database/outbox/messages?after&limit&topic` | `POST …/database/outbox/messages` `{ topic, payload, id?, idempotencyKey? }` | `POST …/database/outbox/messages/remove` `{ ids }` |
| SDK | `client.data(projectId).outbox.read({ after?, limit?, topic? })` | `.outbox.emit({ topic, payload, id?, idempotencyKey? })` | `.outbox.remove(ids)` |
| CLI | `zelavis data outbox [topic] --project ID [--after C] [--limit N]` | `zelavis data outbox-emit <topic> [id] --data JSON` | `zelavis data outbox-remove --ids a,b` |

`documents.write` takes `emit` in every form: `POST …/documents/write` with
`emit`, `client.data(id).documents.write({ operations, emit })`, and
`zelavis data write --operations JSON --emit JSON`. Reading needs only data-read
authority (`project.data.read` for an App client); emitting and removing are
writes.

## Durable entities

A durable entity is an actor whose mailbox and state live in its Tenant's own partition: an address (a `type` and an
`id` inside the Tenant), a mailbox of messages kept until they are processed, and a state of its own. Nothing has to be
running for a message to be kept, and nothing is lost when what processes it stops: the mailbox is the intent to
process it.

```ts
// Send: kept at once, in the Tenant's partition.
await tenantDb.entities.send({ type: 'order', id: 'o-1', tag: 'paid', payload: { amount: 12 }, primaryKey: 'stripe-evt_123' });

// A handler: one message and the entity's state in, a step out.
const handle = (message, { state, documents }) => ({
  writes: [{ _tag: 'Update', collection: 'orders', id: message.id, data: { paid: true } }],
  emit: [{ topic: 'order.paid', payload: { order: message.id } }],
  state: { paid: (state?.paid ?? 0) + message.payload.amount },
  reply: { ok: true },
});
const { stop } = db.entities.serve((type) => (type === 'order' ? handle : undefined));
```

- **Processed one at a time per entity, in the order they arrived.** A failed attempt (the handler fails, times out,
  answers something that is not a step, or its writes are refused) is retried after a pause that doubles from one second
  to at most five minutes, holding the entity's later messages back; after `maxAttempts` (8) it is `failed` with its last
  error and the next message goes on.
- **The step commits whole, with the processed mark.** The handler's document writes, its outbox messages, the entity's
  new state and the reply commit in one batch of the Tenant's partition together with the message's processed mark, or
  none of it does. Delivery is at least once: a handler can run again for a message after a crash or a refused commit.
  Its effects on the database land exactly once, because they land only with the mark. Effects outside the database go
  through the outbox, whose consumers deduplicate by message id.
- **A `primaryKey` names the message.** Sending the same key again answers the message already there (`duplicate: true`,
  with its status and reply once processed), for as long as finished messages are kept: seven days by default
  (`retention`), after which the key is forgotten.
- **`deliverAt`** holds a message until then. **Cancelling** a message not yet processed finishes it as `cancelled`; a
  handler still running for it cannot finish it afterwards. A mailbox holds at most 4096 unfinished messages
  (`MailboxFull`, 409).
- **Where they run.** `db.entities.serve` processes every partition's due messages until stopped: at once for a message
  sent in this process, and on a sweep (every second) for the rest, messages that became due included. It runs where the
  database's writer is; each commit also checks that its message is still the one owed, so a message is never finished
  twice. In a Project, the enabled `entity` workloads are the handlers, by name (see
  [Workloads](../project-files-and-workloads/#workloads)). A type with no handler keeps its messages until one exists.
- **Moves and backups.** Routing an entity is routing its Tenant, so a moved Tenant takes its mailboxes. A Tenant's
  backup and export carry its entities' messages and state like its other records.

| Form | Send | Message | Cancel | State | Mailbox | List |
|---|---|---|---|---|---|---|
| HTTP | `POST …/database/entities/:type/:id/messages` `{ tag, payload, primaryKey?, deliverAt? }` | `GET …/:type/:id/messages/:messageKey` | `POST …/:type/:id/messages/:messageKey/cancel` | `GET …/:type/:id/state` | `GET …/:type/:id/mailbox?after&limit` | `GET …/database/entities/:type/list?after&limit` |
| SDK | `client.data(projectId).entities.send({ type, id, tag, payload, primaryKey?, deliverAt? })` | `.message({ type, id, messageKey })` | `.cancel(…)` | `.state({ type, id })` | `.mailbox({ type, id, after?, limit? })` | `.list({ type, after?, limit? })` |
| CLI | `zelavis entities send <type> <id> --tag T --data JSON [--primary-key K] [--deliver-at ISO]` | `entities message <type> <id> <key>` | `entities cancel <type> <id> <key>` | `entities state <type> <id>` | `entities mailbox <type> <id>` | `entities list <type>` |

Every form takes `tenantId` (`--tenant`) for another Tenant, which needs `database.inspect`. Sending and cancelling need
data-write authority, reading needs data-read. What each channel in Zelavis promises about delivery is listed in
[Delivery guarantees](../../architecture/delivery-guarantees/).

## Schemas and projections

Schema and projection definitions live on the logical database because they
must be consistent across every physical shard:

```ts
await zv.db.schemas.save({
  collection: 'posts',
  version: 1,
  activate: true,
  fields: [
    {
      name: 'title',
      field: { _tag: 'TextField', label: 'Title', required: true },
    },
  ],
});

await zv.db.projections.register({
  name: 'published-posts',
  source: {
    collections: ['posts'],
    eventTypes: ['document.upserted'],
  },
});
```

### What activating a schema declares

A schema says what each field holds. Activating a version also declares how
the collection's lenses read it, but only where that follows without a guess:

| Field type | Declared on activation |
|---|---|
| `TextField`, `LongTextField`, `RichTextField` | full-text search (the analyzer's fields) |
| `NumberField`, `IntegerField` | a measure of the same name |
| `ReferenceField` (single) | an edge of the same name, read from `<field>.id` |
| `GeometryField` (`coordinates: 'wgs84'`, `resolution`) | the spatial index |
| `VectorField` (`model`, `modelVersion`, `dimension`, `metric`) | the embedding |

Nothing else is inferred. A slug, a URL or an option is not prose; a list of
references has no single id path; a `JsonField` holding coordinates or numbers
states no coordinate model, model or metric, so it is never treated as
geometry or a vector. Each skipped field is reported with its reason.
A declaration made by hand (`analyze`, `locate`, `embed`, a measure or edge at
creation) is kept: the activation fills only what nothing occupies, and the
next activation replaces only what the previous one derived. A schema
activated before its collection exists declares on it when it is created.

Activation is a durable workflow: it records its intent, applies the
declarations and re-derives every stored document's postings (the documents
themselves are not rewritten), then publishes the version in one transaction.
If the stored documents break what the version implies (a vector of the wrong
dimension, say), it is refused with `SchemaActivationRefused` (400), the
version stays inactive and the previous declarations are restored. An
activation cut off by a crash is finished when the database next opens; the
pending ones are listed and can be resumed by hand:

| | |
|---|---|
| JS | `tenant.schemas.activate(c, v)` → the schema with `activation: { applied, skipped, documents }` (null when the collection does not exist yet); `tenant.schemas.pendingActivations`; `tenant.schemas.resumeActivations` |
| SDK | `client.data(p).schemas.activate(c, v)`, `.activations()`, `.resumeActivations()` |
| HTTP | `POST …/data/schemas/:c/activate`, `GET …/data/schemas/collections/activations`, `POST …/data/schemas/collections/activations/resume` |
| CLI | `zelavis data activate-schema c VERSION`, `zelavis data schema-activations`, `zelavis data resume-schema-activations` |

A projection's `apply` runs at least once per event. The checkpoint advances
after a page of events has been applied, and `apply` writes wherever it likes,
so the two cannot commit together: a run cut off between them applies that
page again. Make `apply` idempotent by keying what it writes on
`event.eventId`, which names the record and the version it reached and stays
the same when the Tenant moves to another shard. A rebuild clears the
checkpoint before calling `reset`, so a rebuild cut off at any point is
finished by the next run, which starts from the beginning.

## Time-series

Definitions are logical and Tenant-neutral; reads are Tenant-bound:

```ts
await zv.db.timeseries.define({
  name: 'post-writes',
  source: {
    collections: ['posts'],
    eventTypes: ['document.upserted'],
  },
  map: (event) => ({
    timestamp: event.timestamp,
    value: 1,
  }),
});

const handle = tenantDb.timeseries.get('post-writes');
const points = await handle.range({ order: 'desc', limit: 50 });
const total = await handle.aggregate({ op: 'count' });
```

The same definition can be queried for another Tenant through a different
`forTenant(...)` handle without changing its mapping logic.

A time series is stored beside the log it consumes, so `ingest` commits each
batch of points together with the place in the log it reached: an ingest cut
off and run again stores every point exactly once. `rebuild` builds a new
copy of the series next to the one reads use and replaces it in the same
commit as its last points; until then reads see the old series, and a rebuild
cut off part way leaves the old series serving. While a Tenant is being moved
to another shard, `ingest`, `rebuild` and projection runs fail with
`TenantMoving` (409 over HTTP); retry once the move has finished.


## Tenants

A Tenant exists once it holds something, so there is no create-Tenant operation: adding one writes its first table. Dropping
a Tenant's tables leaves its history, so an emptied Tenant stays listed until it is deleted. The overview lists each
Tenant with its shard, tables, documents (counted from each collection's identifiers in the index, so linear in the
collection and no document is read), stored records (what the partition keeps, so a table's own definition counts beside
its documents) and the bytes of their bodies, which the database keeps as it writes. A divided Tenant is one entry with
no shard of its own: its `parts` list each part that holds data with its own shard, tables, documents, records and bytes,
and the Tenant's counts are their sums. Parts are never listed as Tenants. It needs `database.inspect`, carried by `project.view`.

| Form | List | Add | Delete |
|---|---|---|---|
| HTTP | `GET /zelavis/api/v1/runtime/projects/:projectId/proxy/zelavis/api/v1/database/tenants/overview` | `POST …/database/documents/collections` with `{ tenantId, name, surface: "database" }` | `DELETE …/database/tenants/:tenantId` with `{ confirm }` |
| SDK | `client.projects.tenants(projectId)` | `client.projects.createTenant(projectId, { tenantId, table })` | `client.projects.deleteTenant(projectId, { tenantId, confirm })` |
| CLI | `zelavis projects tenants <id>` | `zelavis projects create-tenant <id> --tenant T --table N` | `zelavis projects delete-tenant <id> --tenant T --confirm T` |

Deleting removes the Tenant's records, event log and history for good: nothing is archived, so back it up first
(`export-tenant`). `confirm` must repeat the Tenant ID, which the dashboard asks for by having it typed again. It needs
`database.drop`, carried by `project.runtime.manage`. From the start every change to the Tenant is refused with the same
fence a relocation uses. If calls still use it past the drain timeout the answer is 409, nothing has been removed, and
the fence is lifted, so the Tenant takes changes again until the request is repeated. Once drained, a removal cut off by
a crash is finished when the database next opens. A divided Tenant is removed with every part (all fenced and drained
before any is removed); the answer lists each part's shard and records in `parts`, and the Tenant stays divided, empty.
It is refused (400) for a reserved Tenant, one that holds nothing, the caller's own Tenant, and while a relocation is
pending. A Tenant written to afterwards starts again from nothing, with identifiers and log positions beginning over.
Global data is not the Tenant's and stays.

The dashboard's Database → Tenants page is a client of these routes. It offers Delete only for Tenants the operator made,
divided ones included: the App's own Tenant and a plugin's `service:` Tenant are not deleted from there.

### Branching a Tenant

A branch is a new Tenant holding a copy of another as of one position of its log, the way copying a database file
gives you a second database to try something on. It needs `database.restore`, carried by `project.runtime.manage`.

| Form | Branch |
|---|---|
| HTTP | `POST …/database/tenants/:tenantId/branch` with `{ into, outbox? }` |
| SDK | `client.projects.branchTenant(projectId, { tenantId, into, outbox? })` |
| CLI | `zelavis projects branch-tenant <id> --tenant T --to NEW [--outbox leave\|copy]` |
| JS | `db.branchTenant(tenant, into, { outbox? })` |
| Dashboard | **Branch** on a row of Database → Tenants |

- **What it copies.** Everything the Tenant holds: records, history, collections and their indexes, schemas,
  projection checkpoints, time-series state and idempotency receipts. Projection and time-series definitions carry
  functions, so a process registers them on the branch as on any Tenant, and they carry on from where the source had
  got to rather than starting over.
- **The outbox stays with the source.** Messages the source has not yet had removed are the source's to deliver, so by
  default (`outbox: "leave"`) the branch retracts them in its own log, after the branch point and before anything can
  read them: a consumer of the branch never delivers them a second time. `outbox: "copy"` keeps them, ids and order
  included, for a branch whose consumer is to deliver them again. Receipts stay either way, because the writes they
  guard are in the branch too: a replayed write is answered as already done.
- **As of one moment.** The source keeps taking writes while it is copied. The branch is the source as of the last
  position it read once its records were copied, and nothing written after that reaches it. The answer reports the
  records and events copied, the branch's `shard` and `cursor`, where its log ends. Only the branch is held in place
  for the whole copy: the source is read a page at a time, each page from wherever it lives then, so it can be moved
  while it is branched.
- **Its own Tenant from then on.** Writes to the branch never reach the source, and writes to the source never reach
  the branch, until it is merged back (below).
- **History carries on.** The branch keeps the source's identifiers, versions and log positions. A cursor the source
  handed out up to the branch point names the same place in the branch, so a consumer or checkpoint carries on; one
  from after it is refused (`ForeignCursor`). A branch of a branch accepts cursors of both ancestors, each up to its
  own branch point.
- **Divided Tenants.** A Tenant divided into parts branches into one divided into the same parts, each part copied
  from its counterpart as of a position of its own. The guarantee is per part: each part of the branch is the source
  part as of one position, but the parts are as of different moments, so a write that landed on two parts (a saga) can
  appear in one part of the branch and not yet in the other. This is deliberate. Parts are separate partitions and
  nothing writes across them atomically, so even one shared cut would only show a saga in some in-between step; a
  workflow that spans parts is reconciled by its own steps and compensations, not by the branch. The answer lists the
  parts it copied in `parts`, each with its shard, counts and cursor. The dashboard offers **Branch** and **Delete** on
  a divided Tenant's row, each acting on every part.
- **Cut off part way.** Until a copy is whole, every read and write of its target fails with `TenantBranching` (409).
  A branch that was cut off is started over when the same request is repeated, or when the database next opens, which
  finishes it from the source its lineage names, leaving behind what it was leaving. A cut-off copy whose source has
  since been removed can never be finished and was never readable, so it is removed then. One that meets a pending
  relocation waits for it, and finishing the relocation (resuming it, or a rebalance) finishes the branch. For a divided
  Tenant, the parts a cut-off request had already finished are not copied again. The dashboard's Branch dialog asks
  which way the outbox goes: left with the source (default) or copied.
- **As of a past moment (recovery).** `asOf` (a cursor the source's change feed handed out) or `asOfTime` (ISO 8601:
  the last change written at or before it) makes the branch the source as it was then instead of now. It is made from
  the source's log, replayed up to that point: from empty while the log was never compacted, and from the Tenant's
  stored snapshot once it was. Compaction never cuts past the snapshot, so the snapshot and the log after it are the
  recovery horizon; taking a newer snapshot (`maintenance.snapshot`) moves it forward. A point before the horizon is
  refused. The recovery window says how far
  back each partition reaches (`earliest`, `latest`, `compactedTo`, and the times of those changes):
  `GET …/database/tenants/:tenantId/recovery`, `client.projects.tenantRecoveryWindow(projectId, tenantId)`,
  `zelavis projects recovery-window <id> --tenant T`, `db.recoveryWindow(tenant)`. A divided Tenant takes `asOfTime`
  only (a cursor names one part), each part as of its own last change before that time. Recovering is branching: the
  recovered Tenant is new, and the operator moves readers and writers to it. The dashboard's Branch dialog has an
  optional "As of" time.
- **Merging back.** `db.mergeBranch(branch, { into?, dryRun?, resolve? })` (HTTP `POST …/database/tenants/:branch/merge`,
  SDK `client.projects.mergeTenantBranch(projectId, { tenantId, into?, dryRun?, resolve? })`, CLI
  `zelavis projects merge-branch <id> --tenant BRANCH [--dry-run] [--resolve JSON]`, dashboard **Merge back** on a
  branch's row) compares what each side changed after the branch point, document by document. What only the branch
  changed (written or removed) is applied to the source through its own writes, so its checks, unique values and
  references hold and each batch is checked against the versions read; what only the source changed stays; what both
  changed to the same state is left. What both changed differently is a conflict with no default winner: `resolve`
  names the side to keep per document (`{ collection, id, keep: "source" | "branch" }`), and while any is unsettled
  nothing is written and the answer is the plan, as with `dryRun`. Collections the branch created are created in the
  source; a definition changed on both sides is settled only by keeping the source's. Outbox messages and schema
  versions are not merged and are listed in `unmerged`. A merge cut off part way, or refused because the source was
  written meanwhile, is simply run again. A divided branch is planned part by part before any part is written. The
  branch stays a Tenant of its own afterwards. The Tenants overview reports each branch's `branchedFrom`.
- **Refusals.** It is refused (400) for a reserved Tenant, the App's own Tenant, a plugin's `service:` Tenant or a
  part's key (`name#part`) on either side, the same name twice, a source holding nothing, a target that already holds
  data or is divided otherwise than the source, an `outbox` other than `leave` or `copy`, and while a relocation is
  pending.

## Cross-Tenant indexes

A Tenant is the unit of locality, so a question about every Tenant at once (every listing priced under 10 000, say) has
no one shard to ask. A cross-Tenant index is the answer for a live request: one collection's documents from every Tenant,
copied into a bounded set of derived shard placements and kept current from each Tenant's event log. Queries merge
only those derived placements, independently of the number of source Tenants. Plugins' `service:` Tenants are never read.

It is derived and eventually consistent. Each Tenant partition is followed from its own cursor, and every batch of
entries is committed in the same transaction as the cursor it reached, so a refresh cut off anywhere repeats nothing and
skips nothing. A moved Tenant carries on from its cursor; one compacted past it, or removed and written again, has its
entries derived again from its records. In a Project runtime the index is refreshed shortly after each write and swept
every minute; a query answers as of the last full refresh and says when that was (`refreshedAt`). Re-derivation records a durable marker before changing entries. Queries wait for an in-process refresh and refuse
with `CrossTenantIndexRefreshing` (HTTP 409) if an interrupted refresh left that marker. Refresh resumes the work;
removing the source Tenant also lets a full refresh clear it. Partial or stale re-derivations are never returned.

The last successful full-refresh time and refresh failures are persisted and
survive a restart. A failed pass keeps the previous successful time rather than
claiming it caught up. Database → Cross-Tenant Indexes lists those statuses and
offers creation, refresh, query/pagination and drop through the same API. The
selected index, query and continuation are restored from the page URL.

An index names one collection, the `columns` a query may filter, range over and order by (every scalar field when
omitted) and optionally an `analyzer` for text search, exactly as a collection declares them. Queries use the source
documents' own field paths; each match carries its `tenant` (and `part` for a divided Tenant), `id`, `version` and `data`.
The definition is fixed: drop the index and define it again to change it. Reading and querying need `database.inspect`
(carried by `project.view`); defining, refreshing and dropping need `database.indexes.manage` (carried by
`project.runtime.manage`), because an index reads every Tenant.

| Form | List / get | Define | Query | Refresh | Drop |
|---|---|---|---|---|---|
| HTTP (under `…/proxy/zelavis/api/v1/database`) | `GET /cross-tenant-indexes`, `GET /cross-tenant-indexes/:name` | `POST /cross-tenant-indexes` with `{ name, collection, columns?, analyzer?, shards?, spatial?, embedding?, indexes? }` | `POST /cross-tenant-indexes/:name/query` with `{ where?, tenants?, search?, geometry?, similar?, orderBy?, limit?, after? }` | `POST /cross-tenant-indexes/:name/refresh` | `DELETE /cross-tenant-indexes/:name` |
| SDK | `client.crossTenantIndexes(projectId).list()`, `.get(name)` | `.define(definition)` | `.query(name, input)` | `.refresh(name)` | `.drop(name)` |
| CLI | `zelavis cross-tenant-indexes list --project P`, `get NAME` | `define --definition JSON` | `query NAME [--where JSON] [--order-by JSON] [--tenants A,B] [--search T]` | `refresh NAME` | `drop NAME` |

Embedded, the same operations are `db.crossTenantIndexes.define/list/get/query/refresh/drop`; `makeDatabase` refreshes in
the background unless `crossTenantRefresh: false`.

An immutable `shards` list selects 1–32 derived placements; the default freezes the current data shards
(up to 32) when the index is defined. Each source partition hashes to one placement, keeping its entries
and cursor atomic. Source Tenant movement does not change that choice. Pages read bounded chunks from
each derived placement and merge field, distance or vector-score order. Continuations bind the index's
incarnation, query and placement list; changing the query or dropping/recreating the index refuses an
old continuation. Page size may change. Reads are eventually consistent, not a cross-shard snapshot.

`spatial` and `embedding` use the ordinary collection declarations, over source field paths. `indexes`
accepts up to 16 ordinary composite index declarations, with up to 8 fields each. Unique indexes are
refused: a derived index cannot enforce uniqueness in source Tenants. Geometry and vector reads use
`geometry` and `similar`; CLI queries accept the same body through `--data JSON` (explicit query flags
override fields in that body). The native dashboard's JSON forms accept these same declarations and queries.
The background refresh reads a partition shortly after a write in this process, and also after any partition named
by its `notifications` stream (`crossTenantRefresh: { notifications }`): a writer on another host through its change
feed (`remoteChanges`), and a partition this database follows through its follow loop. The sweep (one minute by
default) is what remains for anything neither names.

## Backups and restore

A backup is one Tenant: its records and the events logged while the export ran,
which a restore applies by version, so an export taken during writes restores
to one moment. It is built from the export stream below, so a large Tenant does
not pin a read snapshot for the length of the export. A restore writes only into the Tenant the backup was taken from
(`BackupTenantMismatch` otherwise), and `into` says what to do about data that
Tenant already holds:

| `into` | Effect |
|---|---|
| `empty` (default) | Refuses with `TenantNotEmpty` unless the Tenant holds nothing, so nothing can be lost. |
| `purge` | Discards what the Tenant holds, then restores: the Tenant ends up exactly as the backup describes it. |
| `merge` | Restores over what is there, record by record. A record the backup carries supersedes the local one; a record only held locally stays. |

Any other value is refused with `InvalidRestoreMode` before anything is
written. An empty or purged Tenant gets the backup's own identifiers back;
a merge remaps them, and graph edges with them. The result reports how many
events were applied, how many records a purge removed and how many a merge
wrote over:

```ts
const backup = await tenantDb.backups.exportTenant();
const result = await tenantDb.backups.restoreTenant(backup, { into: 'purge' });
// { tenantId: 'tenant_acme', events: 42, removed: 7, superseded: 0 }
```

From outside the Project, the same operation goes through the Project proxy and
needs `project.runtime.manage`, which carries `database.backup` and
`database.restore`. Naming a Tenant other than the caller's own also needs
`database.inspect`, which `project.view` carries:

| Form | Export | Restore |
|---|---|---|
| HTTP | `POST /zelavis/api/v1/runtime/projects/:projectId/proxy/zelavis/api/v1/database/maintenance/backups/export` with `{ tenantId? }` | `…/maintenance/backups/restore` with `{ backup, into?, tenantId? }` |
| SDK | `client.projects.exportTenant(projectId, { tenantId? })` | `client.projects.restoreTenant(projectId, backup, { into?, tenantId? })` |
| CLI | `zelavis projects export-tenant <id> [--tenant T] [--output FILE]` | `zelavis projects restore-tenant <id> --file FILE [--into empty\|purge\|merge] [--tenant T]` |

**A divided Tenant is backed up whole.** Exporting it gives one file, `format: "zelavis.db-backup.divided.v1"`, holding
an ordinary backup per part (`parts: [{ part, backup }]`, each labelled with its part key `name#part` and each as of a
position of its own, as a branch is). Restoring it needs a Tenant divided into exactly those parts, and writes each part
only into its counterpart; an `empty` restore checks that every part is empty before it writes to any. Past that check
a restore is per part: one that fails after earlier parts were restored answers `DividedRestoreIncomplete`, naming the
parts restored and the part it stopped at, and the same backup restored again with `into: "purge"` completes it. The result carries `parts`, each
with its own counts, and the counts above are their sums. The same routes, SDK calls and CLI commands carry both
formats, and the dashboard's Back up on a divided Tenant downloads the whole-Tenant file. A backup of one part alone
is still taken by naming its part key.

The three answer alike, refusals included: `TenantNotEmpty`,
`BackupTenantMismatch` and `InvalidRestoreMode` are 400 with the same message,
and `TenantMoving` is 409 while the Tenant is being moved. App Data clients
(`project.data.*`) cannot back up or restore; that authority stays with the
Project's runtime management. A backup carries no time-series state or
projection checkpoints, which are positions in the old log; they are rebuilt
from the restored log.

### Exporting a Tenant as a stream

A backup file is the whole Tenant in one response. The export stream is the same data a page at a time, from a
cursor, and it does not stop at the end: it goes on delivering changes, so one operation copies a Tenant, backs it up
and keeps another store current. Each call returns a page of records and a page of the log after them. Apply the entries
**by version** (an entry older than what is held changes nothing, a newer one brings the record forward, a retraction
leaves its version behind so a repeat cannot bring the record back) and, once a page says `consistent: true`, what you
hold is the Tenant as of one log position. It stays true, because from there every page continues the log in order.

| Form | Read a page |
|---|---|
| HTTP | `POST …/database/tenants/:tenantId/export` with `{ cursor?, limit? }` |
| SDK | `client.projects.exportTenantPage(projectId, { tenantId, cursor?, limit? })` |
| CLI | `zelavis projects export-stream <id> --tenant T [--after CURSOR] [--limit N] [--until-consistent] [--output FILE]` |
| JS | `db.exportPage(tenant, { cursor?, limit? })`, or `tenant.backups.exportPage` on one handle |

It needs `database.backup` (carried by `project.runtime.manage`), and naming a Tenant other than the caller's own also
needs `database.inspect`. The answer is `{ tenantId, entries, cursor, consistent, parts? }`; pass `cursor` back to read
what follows. `limit` (1 to 1024, default 256) is the most entries a page holds. A divided Tenant's parts share it: each call
starts where the last stopped and gives each part in turn a fair share, so pages stay bounded however many parts
there are and every part keeps advancing.

- **Nothing is pinned between calls but the log.** From the first call until the export is consistent, the Tenant's log is
  held at the position the export began (see Compaction holds below), renewed by every call and ended by its time (five
  minutes), so compaction cannot cut the events the export has still to follow. Once consistent the hold is released and
  the cursor is an ordinary event cursor: a consumer that falls behind compaction is refused (409, `CursorCompacted`) and
  starts again from a new export, as with any event read.
- **A cursor is the Tenant's own.** It is bound to the Tenant and to its life: another Tenant's cursor, a malformed one, or
  one from before the Tenant was removed and written again is refused (400, `InvalidExport`).
- **A divided Tenant is one export.** The parts share each page's `limit`: a call starts at the part after the one the last
  call stopped at and gives each part in turn a fair share, so a page never exceeds the limit and no part waits more than
  a round. Each entry names its `part`, the answer lists `parts`, and the cursor carries each part's state. It is
  consistent once every part is, each as of its own position: parts are separate partitions with no common log, the same
  guarantee a divided branch gives.
- **What it carries.** The same entries a backup carries, with `at` and `body` as the database stores them; state that is
  rebuilt rather than restored (projection checkpoints, time-series state) is not in it.
- **Falling behind.** A consumer that falls behind compaction after the export became consistent reads `CursorCompacted`
  and starts a new export. That is the whole recovery, not a shortcut missing: once the log it would have followed is
  cut, only the records can say what changed, and applying a fresh export by version over what the consumer holds
  brings it level without discarding anything.

`zelavis projects export-stream` prints one page as JSON; `--until-consistent` collects every page up to the first
consistent one into a single result, and `--output` writes it to an owner-only file. A runnable consumer that keeps
an analytics copy current from the stream is in [Streaming a Tenant to an analytics store](../../guides/stream-to-analytics/).

### Compaction holds

Compaction truncates a partition's log, and a reader that copies records and then follows the log from where it began
must not have that log cut under it. A reader takes a **hold** on the log at a position (`store.holdLog({ id, position,
ttlMillis })`); compaction then goes as far as the lowest live hold and no further, and says where it was held (`heldAt` in
the compaction result) instead of refusing. A hold is a named claim: asking again renews it, a position is only ever
raised, it ends when released or when its time is up (at most ten minutes), and a partition keeps at most 64. A hold below
the compaction point is refused (`LogCompacted`), because the events it was to keep are already gone.

Branching a Tenant, copying a follower or a moved Tenant, and the export stream hold their source this way, so a long copy
of a busy Tenant is not started over by every compaction pass. Holds live with the writer, in its process; a follower on
another host takes its hold there through the leader transport. A move carries the live holds to the target before routing
points there and again before the source is dropped, and a holder renewing through routing renews where the partition is
now. The readers' own detection (`CursorCompacted`, `LogCompacted`) is what keeps them correct; a hold only keeps a long
read from starving.

### Database images

A **database image** is a physical backup of the whole database: every shard, the topology and global shards included,
copied key by key through the ordered key-value interface that every storage engine implements. Because nothing above
that interface is involved, **any engine images into any other** (a SQLite database into an LMDB or RocksDB image, or the
reverse), and the result is an ordinary shard directory that engine opens as a database, with its indexes, log and topology
exactly as they were. It is quick because nothing is decoded or re-derived, and it holds one read snapshot per shard only
for the copy while writers carry on. Each partition in an image is as of one moment; partitions are independent writers, so
there is no one moment across them (the export stream gives a Tenant as of one log position per part without any snapshot,
and is the portable form).

| Form | Create | List | Verify | Delete | Keep newest |
|---|---|---|---|---|---|
| HTTP | `POST …/database/maintenance/images` with `{ name, engine? }` | `GET …/maintenance/images` | `POST …/maintenance/images/:name/verify` | `DELETE …/maintenance/images/:name` with `{ confirm }` | `POST …/maintenance/images/prune` with `{ keep }` |
| SDK | `client.projects.createDatabaseImage(projectId, { name, engine? })` | `databaseImages(projectId)` | `verifyDatabaseImage(projectId, name)` | `deleteDatabaseImage(projectId, { name, confirm })` | `pruneDatabaseImages(projectId, { keep })` |
| CLI | `zelavis projects create-image <id> <name> [--storage sqlite\|lmdb\|rocksdb]` | `images <id>` | `verify-image <id> <name>` | `delete-image <id> <name> --confirm <name>` | `prune-images <id> --keep N` |
| JS | `db.maintenance.image((shard) => engine)` | | | | |

It needs `database.backup`. On a Node host the image is written beside the shards, under `<data>/primary/images/<name>/`,
in `engine` (the database's own when omitted), under a name nothing lists and
renamed into place only once whole, with an `image.json` beside the shards. A name is 1 to 64 letters, digits, dots, dashes
or underscores; a taken name is refused, and a host that cannot write images says so (400).

Each shard is read back once written and its keys and values hashed (SHA-256, in key order), and `image.json` records the
digest; a copy whose read-back key count differs from what was copied fails instead of being listed. **Verify** reads
every shard again and answers `{ ok, shards }`, naming each shard that cannot be opened or no longer holds exactly what was
written. Opening an image as a database writes to it (it claims the writer), so verify before opening one, or open a copy.
**Delete** takes the image out of the listing first and then removes it, and needs its name repeated. **Keep newest**
removes every image but the newest `keep` (1 to 1000, so retention never removes all of them). The dashboard's
Database → Images page offers all five.

Images on a schedule, encrypted and kept off the host, are a backup schedule (below): its `database` component is an
image of every shard, written to a directory or an S3-compatible bucket that passed the conditional-write probe.

There is deliberately no route that restores an image. Replacing the live database is something the operator does with the
Project stopped (point the database at the image's directory with the engine it was written in, or copy the directory over
the shard directory), not something the database being replaced can authorize.

### Scheduled, encrypted, off-site backups

A **backup schedule** captures a whole Project on a cron schedule and ships it off the host, encrypted. Each run
holds named components side by side: `database` (an image of every shard), `runtime` (a consistent `VACUUM INTO`
copy of the Project's runtime store, through `node:sqlite` on Node and `bun:sqlite` on Bun: sessions, workload definitions and runs, Project metadata) and `media` (its
files as they are when the run reads them). Accounts live in the Project's own database, so they are in `database`.

A managed app's Project (WordPress, Joomla, Drupal, PrestaShop, TYPO3, DokuWiki) adds `app`, the application's own
data. Each named directory of its recipe says how it is backed up (`backup` in the manifest's `directories`): `files`
is copied as it is (`app/files/<name>/`, the site's code, uploads and configuration), and `recipe` is left to the
recipe's own `backup` phase, which makes a consistent copy of what cannot be copied while it runs (`app/recipe/`). For
the MariaDB recipes that is a dump of the application's database taken in one transaction while the site keeps serving
(`--single-transaction`), by the dump program of the same build that runs the database: the recipe's pinned
`mariadb-dump`, the host's where the recipe falls back to it, or the container image's own. `app/recipe.json` names the
recipe and each directory with where it was captured; a directory the manifest does not mark is not captured, and says
so. Nothing inside the Project's `app/` is written. Restoring a managed app is done by hand for now: with the Project
stopped, put `files/<name>` back into its directory, then start it and load the dump into its database with the
database's own client. Restoring into a Project as one operation is not shipped yet.

```ts
const schedule = await client.projects.createBackupSchedule(projectId, {
  name: 'nightly', cron: '0 3 * * *', keep: 14,
  target: { kind: 's3', bucket: 'acme-backups', region: 'eu-central-1', endpoint: 'https://…', accessKeyId, secretAccessKey },
});
schedule.recoveryKey; // shown once: keep it off this host
```

- **Targets.** An S3-compatible bucket, or a `directory` (an absolute path, typically another machine's mount). A
  target must pass the conditional-write probe before a schedule is accepted, and every object is written only if
  absent, so a run never overwrites another.
- **Encryption and keys.** Each schedule has its own 256-bit key, generated at creation and answered once as
  `recoveryKey`. The host keeps a copy (owner-only) so scheduled runs need nobody; the target holds nothing readable.
  Each run is packed into one stream and sealed with AES-256-GCM in parts of at most 4 MiB, each bound to its run
  and position, so a part changed, swapped, dropped or reordered fails to decrypt. Credentials are never answered back.
- **Runs.** At each cron time (Effect's `Cron`; `timeZone` optional, UTC otherwise) a run makes an image, uploads its
  parts and then its manifest, the commit point: a run without a manifest was cut off and is never offered. Older
  runs past `keep` lose their manifest first, then their parts. Every run is recorded with its status, size and any
  error; a schedule keeps running after a failed run, and schedules resume when the database opens.
- **Verify** downloads and decrypts every part and checks the digest against the manifest. **Restore** turns a run
  back into a directory on the host (`restoredTo`) with one folder per component; `restoredTo/database` opens as a
  database. Swapping it in is done with the Project stopped, as for any image. It takes `recoveryKey` when the
  host's copy is gone.
- **Restore drills.** A drill restores a schedule's newest finished run (or a named one) into a fresh directory on the
  host, opens it as it would be used after losing the host (a database by its own opener; a System Store by its
  records), records what it held, `rtoMs` (how long getting it back took: download, decrypt, unpack, open) and
  `rpoMs` (how old its data was, the most a loss at that moment would cost), and removes the copy. The live data is
  never touched. `POST …/backup-schedules/:name/drill[?runId=]` (`database.restore`), `drillBackup`,
  `zelavis projects drill-backup <id> NAME [RUN]`; for the Platform `…/runtime/backups/schedules/:name/drill`,
  `client.runtime.backups.drill`, `zelavis backups drill NAME`; the dashboard's **Drill** button on each schedule.
  `drillAfterRun: true` on a schedule drills every scheduled run right after it is made. A drill of a managed app's run
  also checks its `app` component: every directory its summary names is there and holds something.
- **Drills on another machine.** A drill proves this host can recover; a machine that has lost it has only the target
  and the recovery key. `drillFrom` drills a run from exactly those — any Zelavis run, a Project's or another
  Platform's — on a fresh Platform holding none of the first host's state, records nothing and keeps nothing:
  `POST …/runtime/backups/drills` `{ target, schedule, recoveryKey, runId? }` (`server.backups.manage`),
  `client.runtime.backups.drillFrom`, `zelavis backups drill-from --target-dir PATH|--target JSON --schedule NAME
  --recovery-key KEY [RUN]`. The newest finished run unless one is named. The release gate
  `pnpm release:qualify:backups` does this on two disposable machines: a WordPress Project backed up while it serves,
  drilled and restored on its own host, then drilled from the shared target alone on a second, fresh one.
- **The Platform's own backups.** The Platform backs up its System Store the same way, on its own schedules:
  `GET|POST …/runtime/backups/schedules`, `…/runtime/backups/runs`, `…/schedules/:name/run|runs/:runId/verify|restore`
  (`server.backups.manage`, system scope), `client.runtime.backups.*`, `zelavis backups …` and Server → Backups. The
  store is captured as records (JSON lines through its own paging), so it does not depend on the engine behind it.
  Custody: the master secret is one of those records, so a System Store backup is as sensitive as the store and is
  protected off the host only by its schedule's key. A restored run is applied host-locally with the Platform
  stopped: `zelavis system-store import <restored>/system-store/records.jsonl --confirm import [--replace]`, which
  takes the Platform's data ownership (refused while the Platform runs) and refuses a store that holds records
  unless told to replace them.

| Form | Schedules | Runs |
|---|---|---|
| HTTP | `GET\|POST …/maintenance/backup-schedules`, `DELETE …/backup-schedules/:name` with `{ confirm }`, `POST …/backup-schedules/:name/run` | `GET …/maintenance/backup-runs?schedule=`, `POST …/backup-schedules/:name/runs/:runId/verify\|restore` |
| SDK | `backupSchedules`, `createBackupSchedule`, `deleteBackupSchedule`, `runBackup` | `backupRuns`, `verifyBackup`, `restoreBackup` |
| CLI | `zelavis projects backup-schedules\|create-backup-schedule --data JSON\|delete-backup-schedule NAME --confirm NAME\|run-backup NAME` | `backup-runs [--schedule NAME]`, `verify-backup NAME RUN`, `restore-backup NAME RUN [--recovery-key KEY]` |

They need `database.backup` (restore: `database.restore`). The dashboard's Database → Images page offers them.

### Portable schemas and generated types

The tenant's logical schema is the source for portable schema versions and
standalone TypeScript declarations. Storage files, shard placement, credentials
and documents are outside this format. All versions are exported with their
active flags, sorted by collection and version. Field order is preserved.

```ts
const data = client.data(projectId);
const bundle = await data.schemas.export({ collections: ["posts"] });
const plan = await data.schemas.import({ bundle }); // dry run; no writes
const result = await data.schemas.import({ bundle, dryRun: false, activate: true });
const { filename, source } = await data.schemas.types();
```

Import validates the entire bundle and all immutable-version conflicts before
writing. Identical versions are reused, including on a retry; a differing version
is refused. Versions are saved inactive unless `activate: true` is explicit.
Activation uses the ordinary durable declaration/backfill workflow. A refusal
leaves that imported version inactive, retains the previous active version and
returns `complete: false` with the reason. Earlier successful activations remain
published; importing several collections is not an atomic transaction. A failure
while saving may leave a prefix of inactive versions; retry the same bundle.
A dry run checks format and immutable conflicts, not stored-document compatibility
or concurrent changes after the check.

The format is `{ format: "zelavis.logical-schema", version: 1, schemas: [...] }`.
Bounds are 2 MiB, 128 collections, 1,024 versions, 10,000 fields and 16 repeater
levels. Use `collections` to split a larger export. Generated declarations expose
`Collections` for active versions and `SchemaVersions` for every exported version.
They preserve required/optional fields, select choices, reference collection
names, repeaters, file references, geometry and vector dimensions. Runtime checks
still enforce numeric/string ranges, patterns, finite values, geometry validity
and all other constraints TypeScript cannot express.

HTTP uses `POST schemas/collections/export`, `POST schemas/collections/import`
and `POST schemas/collections/types` under the normal Database route. Export and
types require `database.read`; import, even a dry run, requires `database.define`.
The App gateway accepts the corresponding Project data grants. The CLI uses the
same bodies and returns JSON:

```sh
zelavis data export-schema --project PROJECT --json
zelavis data import-schema --project PROJECT --data '{"bundle":{"format":"zelavis.logical-schema","version":1,"schemas":[]}}' --json
zelavis data schema-types --project PROJECT --json
```

Collection `documents.count` reads a persisted namespace counter in constant time.
The counter commits with the document changes and is rebuilt by replication,
restore and lens maintenance. Expired documents remain counted until removed.
The pre-release shard layout is v4; older development layouts must be recreated.
