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
| `CreateDatabaseOptions` from `@zelavis/db` | Enable with a specific driver or schemas. |
| `DatabaseApi` from `@zelavis/db` | Pass a pre-created `DatabaseApi` instance. |
| `Promise<DatabaseApi>` from `@zelavis/db` | Async database creation (e.g. async driver init). |

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

If you need a standalone database primitive outside the runtime, import it from the lower-level package:

```ts
import { createDatabase } from '@zelavis/db';

const db = await createDatabase(options);
```

### `CreateDatabaseOptions`

| Option | Type | Description |
|---|---|---|
| `driver` | `DatabaseDriver` | Storage backend. Defaults to the built-in in-memory driver. |
| `schemas` | `DatabaseCollectionSchema[]` | Schemas to register at startup. |
| `defaultTenantId` | `string` | Default tenant. Defaults to `"default"`. |
| `defaultNodeId` | `string` | Default node identifier. Defaults to `"local"`. |

## `DatabaseApi`

The object exposed through `zelavis.db` and returned by `createDatabase` from `@zelavis/db`. Each property is a scoped API for a different capability.

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
db.events.append<TPayload>(input): Promise<DatabaseEvent<TPayload>>
db.events.read(input?): Promise<DatabaseEvent[]>
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
db.projections.register(definition): Promise<void>
db.projections.list(): Promise<DatabaseProjectionSummary[]>
db.projections.rebuild(input?): Promise<DatabaseProjectionRebuildResult>
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
db.timeseries.define(definition): Promise<void>
db.timeseries.list(): Promise<DatabaseTimeSeriesSummary[]>
db.timeseries.get(name): DatabaseTimeSeriesHandle
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

## `defineDatabaseService`

```ts
import { defineDatabaseService } from '@zelavis/db';

const service = defineDatabaseService(db);
```

Wraps a `DatabaseApi` as a Zelavis runtime service, exposing the REST API used by the dashboard. You only need this in lower-level runtime composition — `coreServices.database` does it automatically.
