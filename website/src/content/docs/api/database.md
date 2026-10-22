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

## Backups and restore

A backup is one Tenant: its records and the events logged while the export ran,
which a restore applies by version, so an export taken during writes restores
to one moment. A restore writes only into the Tenant the backup was taken from
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
