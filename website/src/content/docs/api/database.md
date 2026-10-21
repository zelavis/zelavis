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
