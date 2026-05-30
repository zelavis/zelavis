---
title: Database
---

`@zelavis/db` provides a database layer with documents, events, schemas, projections, and time-series. It is re-exported from the `zelavis` package so you rarely need to install it separately.

## Setup

Pass a `database` option to `coreServices` when creating the `Zelavis` instance:

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
| `CreateDatabaseOptions` | Enable with a specific driver or schemas. |
| `DatabaseApi` | Pass a pre-created `DatabaseApi` instance. |
| `Promise<DatabaseApi>` | Async database creation (e.g. async driver init). |

## `createDatabase`

```ts
import { createDatabase } from 'zelavis';

const db = await createDatabase(options?: CreateDatabaseOptions);
```

Creates a `DatabaseApi` instance directly, outside of the Zelavis runtime. Useful for scripts, tests, or custom service setups.

### `CreateDatabaseOptions`

| Option | Type | Description |
|---|---|---|
| `driver` | `DatabaseDriver` | Storage backend. Defaults to the built-in in-memory driver. |
| `schemas` | `DatabaseCollectionSchema[]` | Schemas to register at startup. |
| `defaultTenantId` | `string` | Default tenant. Defaults to `"default"`. |
| `defaultNodeId` | `string` | Default node identifier. Defaults to `"local"`. |

## `DatabaseApi`

The object returned by `createDatabase`. Each property is a scoped API for a different capability.

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
db.documents.createCollection(input): Promise<DatabaseCollection>
db.documents.listCollections(input?): Promise<DatabaseCollection[]>
db.documents.collectionExists(input): Promise<boolean>
db.documents.insert<TData>(input): Promise<DatabaseDocument<TData>>
db.documents.findById(input): Promise<DatabaseDocument | null>
db.documents.findMany(input): Promise<DatabaseDocument[]>
db.documents.update<TData>(input): Promise<DatabaseDocument<TData>>
db.documents.delete(input): Promise<boolean>
```

Documents are JSON objects stored in named collections. Each document gets an auto-generated `id` unless one is provided.

```ts
const doc = await db.documents.insert({
  collection: 'posts',
  data: { title: 'Hello', published: false },
});

const found = await db.documents.findById({
  collection: 'posts',
  id: doc.id,
});

await db.documents.update({
  collection: 'posts',
  id: doc.id,
  data: { published: true },
  mode: 'merge', // or 'replace'
});

await db.documents.delete({ collection: 'posts', id: doc.id });
```

## `events`

```ts
db.events.append<TPayload>(input): Promise<DatabaseEvent<TPayload>>
db.events.read(input?): Promise<DatabaseEvent[]>
```

The event log is append-only. Events are the source of truth for projections and time-series.

```ts
await db.events.append({
  type: 'post.published',
  payload: { postId: '123', at: Date.now() },
});
```

## `schemas`

```ts
db.schemas.register(schema): Promise<DatabaseCollectionSchema>
db.schemas.registerMany(schemas): Promise<void>
db.schemas.listCollections(): DatabaseCollectionSchemaSummary[]
db.schemas.listVersions(collection): DatabaseCollectionSchema[]
db.schemas.getActiveSchema(collection): DatabaseCollectionSchema | null
db.schemas.activate(collection, version): Promise<DatabaseCollectionSchema>
db.schemas.validate(input): ValidateDatabaseDocumentResult
```

Schemas describe the shape of documents in a collection. Multiple versions can coexist; one version is active at a time.

```ts
await db.schemas.register({
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
db.projections.register(definition): Promise<void>
db.projections.list(): Promise<DatabaseProjectionSummary[]>
db.projections.rebuild(input?): Promise<DatabaseProjectionRebuildResult>
```

Projections consume events and maintain derived state. Rebuilding replays the event log from the beginning.

```ts
await db.projections.register({
  name: 'published-posts',
  source: { eventTypes: ['post.published'] },
  apply: async (event) => {
    await db.documents.update({
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
db.timeseries.define(definition): Promise<void>
db.timeseries.list(): Promise<DatabaseTimeSeriesSummary[]>
db.timeseries.get(name): DatabaseTimeSeriesHandle
```

Time-series are defined by mapping events to data points. Once defined, use the handle returned by `get` to query ranges or aggregates.

```ts
await db.timeseries.define({
  name: 'publish-rate',
  source: { eventTypes: ['post.published'] },
  map: (event) => ({
    timestamp: event.payload.at,
    value: 1,
  }),
});

const handle = db.timeseries.get('publish-rate');

const points = await handle.range({ order: 'desc', limit: 50 });

const total = await handle.aggregate({ op: 'count' });
```

### `DatabaseTimeSeriesHandle`

| Method | Description |
|---|---|
| `range(input?)` | Returns raw data points. Supports `start`, `end`, `limit`, `order`. |
| `aggregate(input)` | Returns a single number. `op` is one of `avg`, `sum`, `min`, `max`, `count`. |

## `defineDatabaseService`

```ts
import { defineDatabaseService } from 'zelavis';

const service = defineDatabaseService(db);
```

Wraps a `DatabaseApi` as a Zelavis runtime service, exposing the REST API used by the dashboard. You only need this when wiring the database manually — `coreServices.database` does it automatically.
