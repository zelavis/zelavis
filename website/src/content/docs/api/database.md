---
title: Database
---

Zelavis App includes a project database service with documents, events,
schemas, projections, and time-series. It is not the Platform OS System Store.
Application code in the current development runtime can access it as `zv.db`.

## Setup

The database service is mounted by the default Zelavis App development project:

```ts
import { Zelavis } from 'zelavis';

const zv = new Zelavis({
  adapter,
});
```

## `zv.db`

```ts
import { Zelavis } from 'zelavis';

const zv = new Zelavis();

await zv.db.documents.createCollection({ name: 'posts' });

const doc = await zv.db.documents.insert({
  collection: 'posts',
  data: { title: 'Hello', published: false },
});

const found = await zv.db.documents.findById({
  collection: 'posts',
  id: doc.id,
});

await zv.db.documents.update({
  collection: 'posts',
  id: doc.id,
  data: { published: true },
  mode: 'merge', // or 'replace'
});

await zv.db.documents.delete({ collection: 'posts', id: doc.id });
```

`zv.db` currently resolves to the same Zelavis App project database API mounted by the
development runtime. Platform records live separately in
`.zelavis/system/zelavis.sqlite` and are never reachable through this API.

## API surface

`zv.db` exposes scoped APIs for each database capability.

| Property | Type | Description |
|---|---|---|
| `documents` | `DatabaseDocumentsApi` | CRUD operations on JSON documents. |
| `events` | `DatabaseEventsApi` | Append-only event log. |
| `schemas` | `DatabaseSchemasApi` | Collection schema registry. |
| `projections` | `DatabaseProjectionsApi` | Event-driven read model projections. |
| `timeseries` | `DatabaseTimeSeriesApi` | Time-series data derived from events. |
| `sql` | `SqlDatabase \| undefined` | Raw SQL access. Only available on drivers that support it. |
| `capabilities` | `DatabaseCapabilities` | Feature flags reported by the active driver. |
| `context` | `DatabaseContext` | Runtime context (tenant, node, config). |
| `driver` | `DatabaseDriver` | The underlying driver instance. |

## `documents`

```ts
zv.db.documents.createCollection(input): Promise<DatabaseCollection>
zv.db.documents.listCollections(input?): Promise<DatabaseCollection[]>
zv.db.documents.collectionExists(input): Promise<boolean>
zv.db.documents.insert<TData>(input): Promise<DatabaseDocument<TData>>
zv.db.documents.findById(input): Promise<DatabaseDocument | null>
zv.db.documents.findMany(input): Promise<DatabaseDocument[]>
zv.db.documents.update<TData>(input): Promise<DatabaseDocument<TData>>
zv.db.documents.delete(input): Promise<boolean>
```

Documents are JSON objects stored in named collections. Each document gets an auto-generated `id` unless one is provided.

```ts
await zv.db.documents.createCollection({ name: 'posts' });

const doc = await zv.db.documents.insert({
  collection: 'posts',
  data: { title: 'Hello', published: false },
});

const found = await zv.db.documents.findById({
  collection: 'posts',
  id: doc.id,
});

await zv.db.documents.update({
  collection: 'posts',
  id: doc.id,
  data: { published: true },
  mode: 'merge', // or 'replace'
});

await zv.db.documents.delete({ collection: 'posts', id: doc.id });
```

## `events`

```ts
zv.db.events.append<TPayload>(input): Promise<DatabaseEvent<TPayload>>
zv.db.events.read(input?): Promise<DatabaseEvent[]>
```

The event log is append-only. Events are the source of truth for projections and time-series.

```ts
await zv.db.events.append({
  type: 'post.published',
  payload: { postId: '123', at: Date.now() },
});
```

## `schemas`

```ts
zv.db.schemas.register(schema): Promise<DatabaseCollectionSchema>
zv.db.schemas.registerMany(schemas): Promise<void>
zv.db.schemas.listCollections(): DatabaseCollectionSchemaSummary[]
zv.db.schemas.listVersions(collection): DatabaseCollectionSchema[]
zv.db.schemas.getActiveSchema(collection): DatabaseCollectionSchema | null
zv.db.schemas.activate(collection, version): Promise<DatabaseCollectionSchema>
zv.db.schemas.validate(input): ValidateDatabaseDocumentResult
```

Schemas describe the shape of documents in a collection. Multiple versions can coexist; one version is active at a time.

```ts
await zv.db.schemas.register({
  collection: 'posts',
  version: 1,
  activate: true,
  document: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      published: { type: 'boolean' },
    },
    required: ['title'],
  },
});
```

## `projections`

```ts
zv.db.projections.register(definition): Promise<void>
zv.db.projections.list(): Promise<DatabaseProjectionSummary[]>
zv.db.projections.rebuild(input?): Promise<DatabaseProjectionRebuildResult>
```

Projections consume events and maintain derived state. Rebuilding replays the event log from the beginning.

```ts
await zv.db.projections.register({
  name: 'published-posts',
  source: { eventTypes: ['post.published'] },
  apply: async (event) => {
    await zv.db.documents.update({
      collection: 'posts',
      id: event.payload.postId,
      data: { published: true },
      mode: 'merge',
    });
  },
});
```

## `timeseries`

```ts
zv.db.timeseries.define(definition): Promise<void>
zv.db.timeseries.list(): Promise<DatabaseTimeSeriesSummary[]>
zv.db.timeseries.get(name): DatabaseTimeSeriesHandle
```

Time-series are defined by mapping events to data points. Once defined, use the handle returned by `get` to query ranges or aggregates.

```ts
await zv.db.timeseries.define({
  name: 'publish-rate',
  source: { eventTypes: ['post.published'] },
  map: (event) => ({
    timestamp: event.payload.at,
    value: 1,
  }),
});

const handle = await zv.db.timeseries.get('publish-rate');

const points = await handle.range({ order: 'desc', limit: 50 });

const total = await handle.aggregate({ op: 'count' });
```

### `DatabaseTimeSeriesHandle`

| Method | Description |
|---|---|
| `range(input?)` | Returns raw data points. Supports `start`, `end`, `limit`, `order`. |
| `aggregate(input)` | Returns a single number. `op` is one of `avg`, `sum`, `min`, `max`, `count`. |
