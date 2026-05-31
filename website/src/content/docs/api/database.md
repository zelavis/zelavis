---
title: Database
---

Zelavis includes a database core service with documents, events, schemas, projections, and time-series. Application code should usually access it through the `Zelavis` runtime as `zelavis.db`.

## Setup

The database core service is enabled by default. Pass a `database` option to `coreServices` when you want to be explicit or provide a custom backing driver:

```ts
import { Zelavis } from 'zelavis';

const zelavis = new Zelavis({
  adapter,
  coreServices: {
    database: true, // in-memory default
  },
});
```

`coreServices.database` accepts:

| Value | Description |
|---|---|
| `true` | Enable with the default in-memory driver. |
| `false` | Disable the database core service. |
| database options | Enable with a specific driver or schemas. |
| database service instance | Use a pre-created database service instance. |

## `zelavis.db`

```ts
import { Zelavis } from 'zelavis';

const zelavis = new Zelavis({
  coreServices: {
    database: true,
  },
});

await zelavis.db.documents.createCollection({ name: 'posts' });

const doc = await zelavis.db.documents.insert({
  collection: 'posts',
  data: { title: 'Hello', published: false },
});

const found = await zelavis.db.documents.findById({
  collection: 'posts',
  id: doc.id,
});

await zelavis.db.documents.update({
  collection: 'posts',
  id: doc.id,
  data: { published: true },
  mode: 'merge', // or 'replace'
});

await zelavis.db.documents.delete({ collection: 'posts', id: doc.id });
```

`zelavis.db` resolves to the same database API instance mounted by the Zelavis runtime, so dashboard routes, services, and application code share one database service.

### Database options

| Option | Type | Description |
|---|---|---|
| `driver` | `DatabaseDriver` | Storage backend. Defaults to the built-in in-memory driver. |
| `schemas` | `DatabaseCollectionSchema[]` | Schemas to register at startup. |
| `defaultTenantId` | `string` | Default tenant. Defaults to `"default"`. |
| `defaultNodeId` | `string` | Default node identifier. Defaults to `"local"`. |

## API surface

`zelavis.db` exposes scoped APIs for each database capability.

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
zelavis.db.documents.createCollection(input): Promise<DatabaseCollection>
zelavis.db.documents.listCollections(input?): Promise<DatabaseCollection[]>
zelavis.db.documents.collectionExists(input): Promise<boolean>
zelavis.db.documents.insert<TData>(input): Promise<DatabaseDocument<TData>>
zelavis.db.documents.findById(input): Promise<DatabaseDocument | null>
zelavis.db.documents.findMany(input): Promise<DatabaseDocument[]>
zelavis.db.documents.update<TData>(input): Promise<DatabaseDocument<TData>>
zelavis.db.documents.delete(input): Promise<boolean>
```

Documents are JSON objects stored in named collections. Each document gets an auto-generated `id` unless one is provided.

```ts
await zelavis.db.documents.createCollection({ name: 'posts' });

const doc = await zelavis.db.documents.insert({
  collection: 'posts',
  data: { title: 'Hello', published: false },
});

const found = await zelavis.db.documents.findById({
  collection: 'posts',
  id: doc.id,
});

await zelavis.db.documents.update({
  collection: 'posts',
  id: doc.id,
  data: { published: true },
  mode: 'merge', // or 'replace'
});

await zelavis.db.documents.delete({ collection: 'posts', id: doc.id });
```

## `events`

```ts
zelavis.db.events.append<TPayload>(input): Promise<DatabaseEvent<TPayload>>
zelavis.db.events.read(input?): Promise<DatabaseEvent[]>
```

The event log is append-only. Events are the source of truth for projections and time-series.

```ts
await zelavis.db.events.append({
  type: 'post.published',
  payload: { postId: '123', at: Date.now() },
});
```

## `schemas`

```ts
zelavis.db.schemas.register(schema): Promise<DatabaseCollectionSchema>
zelavis.db.schemas.registerMany(schemas): Promise<void>
zelavis.db.schemas.listCollections(): DatabaseCollectionSchemaSummary[]
zelavis.db.schemas.listVersions(collection): DatabaseCollectionSchema[]
zelavis.db.schemas.getActiveSchema(collection): DatabaseCollectionSchema | null
zelavis.db.schemas.activate(collection, version): Promise<DatabaseCollectionSchema>
zelavis.db.schemas.validate(input): ValidateDatabaseDocumentResult
```

Schemas describe the shape of documents in a collection. Multiple versions can coexist; one version is active at a time.

```ts
await zelavis.db.schemas.register({
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
zelavis.db.projections.register(definition): Promise<void>
zelavis.db.projections.list(): Promise<DatabaseProjectionSummary[]>
zelavis.db.projections.rebuild(input?): Promise<DatabaseProjectionRebuildResult>
```

Projections consume events and maintain derived state. Rebuilding replays the event log from the beginning.

```ts
await zelavis.db.projections.register({
  name: 'published-posts',
  source: { eventTypes: ['post.published'] },
  apply: async (event) => {
    await zelavis.db.documents.update({
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
zelavis.db.timeseries.define(definition): Promise<void>
zelavis.db.timeseries.list(): Promise<DatabaseTimeSeriesSummary[]>
zelavis.db.timeseries.get(name): DatabaseTimeSeriesHandle
```

Time-series are defined by mapping events to data points. Once defined, use the handle returned by `get` to query ranges or aggregates.

```ts
await zelavis.db.timeseries.define({
  name: 'publish-rate',
  source: { eventTypes: ['post.published'] },
  map: (event) => ({
    timestamp: event.payload.at,
    value: 1,
  }),
});

const handle = await zelavis.db.timeseries.get('publish-rate');

const points = await handle.range({ order: 'desc', limit: 50 });

const total = await handle.aggregate({ op: 'count' });
```

### `DatabaseTimeSeriesHandle`

| Method | Description |
|---|---|
| `range(input?)` | Returns raw data points. Supports `start`, `end`, `limit`, `order`. |
| `aggregate(input)` | Returns a single number. `op` is one of `avg`, `sum`, `min`, `max`, `count`. |
