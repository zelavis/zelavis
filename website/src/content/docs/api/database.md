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
with libSQL, RocksDB and LMDB as optional engines — one engine per shard. There
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
fence a relocation uses; if calls still use it the answer is 409 and the same request can be repeated. It is refused (400)
for a reserved Tenant, one divided into parts, one that holds nothing, the caller's own Tenant, and while a relocation is
pending. A Tenant written to afterwards starts again from nothing, with identifiers and log positions beginning over.
Global data is not the Tenant's and stays.

The dashboard's Database → Tenants page is a client of these routes. It offers Delete only for Tenants the operator made:
the App's own Tenant and a plugin's `service:` Tenant are not deleted from there.

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
  the branch. There is no merging back.
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
  parts it copied in `parts`, each with its shard, counts and cursor. The dashboard offers **Branch** on a divided
  Tenant's row (and no Delete, which is refused for one).
- **Cut off part way.** Until a copy is whole, every read and write of its target fails with `TenantBranching` (409).
  A branch that was cut off is started over when the same request is repeated, or when the database next opens, which
  finishes it from the source its lineage names, leaving behind what it was leaving. One the database cannot finish
  then (its source gone, or a relocation pending) stays as it was, and is logged, until the request is repeated or the
  Tenant is removed. For a divided Tenant, the parts a cut-off request had already finished are not copied again.
- **Refusals.** It is refused (400) for a reserved Tenant, the App's own Tenant, a plugin's `service:` Tenant or a
  part's key (`name#part`) on either side, the same name twice, a source holding nothing, a target that already holds
  data or is divided otherwise than the source, an `outbox` other than `leave` or `copy`, and while a relocation is
  pending.

## Cross-Tenant indexes

A Tenant is the unit of locality, so a question about every Tenant at once (every listing priced under 10 000, say) has
no one shard to ask. A cross-Tenant index is the answer for a live request: one collection's documents from every Tenant,
copied into one partition of its own and kept current from each Tenant's event log, so a query reads that one partition
however many Tenants there are. Plugins' `service:` Tenants are never read.

It is derived and eventually consistent. Each Tenant partition is followed from its own cursor, and every batch of
entries is committed in the same transaction as the cursor it reached, so a refresh cut off anywhere repeats nothing and
skips nothing. A moved Tenant carries on from its cursor; one compacted past it, or removed and written again, has its
entries derived again from its records. In a Project runtime the index is refreshed shortly after each write and swept
every minute; a query answers as of the last full refresh and says when that was (`refreshedAt`). A Tenant whose entries
are being derived again may show stale entries until that finishes.

An index names one collection, the `columns` a query may filter, range over and order by (every scalar field when
omitted) and optionally an `analyzer` for text search, exactly as a collection declares them. Queries use the source
documents' own field paths; each match carries its `tenant` (and `part` for a divided Tenant), `id`, `version` and `data`.
The definition is fixed: drop the index and define it again to change it. Reading and querying need `database.inspect`
(carried by `project.view`); defining, refreshing and dropping need `database.indexes.manage` (carried by
`project.runtime.manage`), because an index reads every Tenant.

| Form | List / get | Define | Query | Refresh | Drop |
|---|---|---|---|---|---|
| HTTP (under `…/proxy/zelavis/api/v1/database`) | `GET /cross-tenant-indexes`, `GET /cross-tenant-indexes/:name` | `POST /cross-tenant-indexes` with `{ name, collection, columns?, analyzer? }` | `POST /cross-tenant-indexes/:name/query` with `{ where?, tenants?, search?, orderBy?, limit?, after? }` | `POST /cross-tenant-indexes/:name/refresh` | `DELETE /cross-tenant-indexes/:name` |
| SDK | `client.crossTenantIndexes(projectId).list()`, `.get(name)` | `.define(definition)` | `.query(name, input)` | `.refresh(name)` | `.drop(name)` |
| CLI | `zelavis cross-tenant-indexes list --project P`, `get NAME` | `define --definition JSON` | `query NAME [--where JSON] [--order-by JSON] [--tenants A,B] [--search T]` | `refresh NAME` | `drop NAME` |

Embedded, the same operations are `db.crossTenantIndexes.define/list/get/query/refresh/drop`; `makeDatabase` refreshes in
the background unless `crossTenantRefresh: false`. Not yet: a dashboard page, an index spread over more than one shard (it
lives on the database's global shard), and vector, geometry or composite indexes inside a cross-Tenant index.

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
what follows. `limit` (1 to 1024, default 256) bounds each phase of each part, so a page holds at most twice that.

- **Nothing is pinned between calls but the log.** From the first call until the export is consistent, the Tenant's log is
  held at the position the export began (see Compaction holds below), renewed by every call and ended by its time (five
  minutes), so compaction cannot cut the events the export has still to follow. Once consistent the hold is released and
  the cursor is an ordinary event cursor: a consumer that falls behind compaction is refused (409, `CursorCompacted`) and
  starts again from a new export, as with any event read.
- **A cursor is the Tenant's own.** It is bound to the Tenant and to its life: another Tenant's cursor, a malformed one, or
  one from before the Tenant was removed and written again is refused (400, `InvalidExport`).
- **A divided Tenant is one export.** Every call advances every part by one page, each entry names its `part`, the answer
  lists `parts`, and the cursor carries one cursor per part. It is consistent once every part is, each as of its own
  position: parts are separate partitions with no common log, the same guarantee a divided branch gives.
- **What it carries.** The same entries a backup carries, with `at` and `body` as the database stores them; state that is
  rebuilt rather than restored (projection checkpoints, time-series state) is not in it. A backup file of a divided Tenant,
  and restoring one, are not part of it yet: a divided Tenant is backed up part by part.

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
of a busy Tenant is not started over by every compaction pass. Holds are in-process like the writer, and a hold taken on a
placement a move has since left protects nothing there; the readers' own detection (`CursorCompacted`, `LogCompacted`) is
what keeps them correct, and a hold only keeps a long read from starving.

### Database images

A **database image** is a physical backup of the whole database: every shard, the topology and global shards included,
copied key by key through the ordered key-value interface that every storage engine implements. Because nothing above
that interface is involved, **any engine images into any other** (a SQLite database into an LMDB or RocksDB image, or the
reverse), and the result is an ordinary shard directory that engine opens as a database, with its indexes, log and topology
exactly as they were. It is quick because nothing is decoded or re-derived, and it holds one read snapshot per shard only
for the copy while writers carry on. Each partition in an image is as of one moment; partitions are independent writers, so
there is no one moment across them (the export stream gives a Tenant as of one log position per part without any snapshot,
and is the portable form).

| Form | Create | List |
|---|---|---|
| HTTP | `POST …/database/maintenance/images` with `{ name, engine? }` | `GET …/database/maintenance/images` |
| SDK | `client.projects.createDatabaseImage(projectId, { name, engine? })` | `client.projects.databaseImages(projectId)` |
| CLI | `zelavis projects create-image <id> <name> [--storage sqlite\|lmdb\|rocksdb\|libsql]` | `zelavis projects images <id>` |
| JS | `db.maintenance.image((shard) => engine)` | |

It needs `database.backup`. On a Node host the image is written beside the shards, under `<data>/primary/images/<name>/`,
in `engine` (the database's own when omitted; `libsql-remote` cannot be an image's engine), under a name nothing lists and
renamed into place only once whole, with an `image.json` beside the shards. A name is 1 to 64 letters, digits, dots, dashes
or underscores; a taken name is refused, and a host that cannot write images says so (400).

There is deliberately no route that restores an image. Replacing the live database is something the operator does with the
Project stopped (point the database at the image's directory with the engine it was written in, or copy the directory over
the shard directory), not something the database being replaced can authorize. Deleting an image is deleting its directory.
