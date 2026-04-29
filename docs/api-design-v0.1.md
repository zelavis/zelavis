# Zelavis API Design v0.1

This document locks the intended developer-facing API direction before deeper subsystem work continues.

It is a design contract, not a claim that every API below already exists.

---

## 1. Status Legend

Each API surface is labeled as one of:

- **implemented now** — already present in the repo today
- **next** — should be implemented in the next focused slices
- **reserved** — intentionally designed now, implemented later

---

## 2. Design Goals

The public API should:

- stay document-first
- expose the event foundation cleanly
- keep schemas as a first-class feature
- leave room for projections and time-series without forcing a rewrite
- remain runtime-neutral at the core
- preserve current naming where possible

---

## 3. Top-Level Runtime Shape

## 3.1 Current runtime entry

**implemented now**

The main runtime entry is:

```ts
const runtime = await zelavis({
  coreServices: {
    database: true,
    auth: true,
    dashboard: true,
  },
});
```

Today this returns the mounted Zelavis server runtime.
That should remain true.

## 3.2 Intended runtime access pattern

**next**

The runtime should also have a clearly documented service access pattern so developers can reliably reach core services.

Target usage:

```ts
const runtime = await zelavis();

const database = runtime.services.database.service;
const auth = runtime.services.auth.service;
```

Rule:

- `zelavis()` remains the main public entry point
- service access should stay explicit
- database should remain replaceable with a user-provided service

---

## 4. Database Public Surface

The database surface should stay grouped by concern.

Stable high-level shape:

```ts
interface DatabaseApi {
  context: DatabaseContext;
  driver: DatabaseDriver;
  capabilities: DatabaseCapabilities;
  events: DatabaseEventsApi;
  documents: DatabaseDocumentsApi;
  schemas: DatabaseSchemasApi;
  projections: DatabaseProjectionsApi;
  timeseries: DatabaseTimeSeriesApi;
  sql?: SqlDatabase;
}
```

Status:

- `context`: **implemented now**
- `driver`: **implemented now**
- `capabilities`: **implemented now**
- `events`: **implemented now**
- `documents`: **implemented now**
- `schemas`: **implemented now**
- `projections`: **implemented now**
- `timeseries`: **implemented now** at the registry-contract level
- `sql`: **implemented now**

Rule:

- do not overload `DatabaseApi` with low-level driver concerns that belong in adapter contracts

---

## 5. Database Context

**implemented now**

```ts
interface DatabaseContext {
  config: Record<string, unknown>;
  defaultTenantId: string;
  defaultNodeId: string;
}
```

Guidance:

- keep this minimal
- use it for runtime defaults, not operational state
- do not add sync/checkpoint/runtime-specific fields here later unless unavoidable

---

## 6. Events API

The events API is the low-level mutation/history surface.

### 6.1 Public shape

**implemented now**

```ts
interface DatabaseEventsApi {
  append<TPayload extends DatabaseEventPayload>(
    input: DatabaseAppendEventInput<TPayload>,
  ): Promise<DatabaseEvent<TPayload>>;

  read(input?: ReadDatabaseEventsInput): Promise<DatabaseEvent[]>;
}
```

### 6.2 Current role

- supports append-only writes
- exposes raw event reads
- underpins document operations

### 6.3 Next additions

**implemented now**

```ts
interface DatabaseAppendEventInput<
  TPayload extends DatabaseEventPayload = DatabaseEventPayload,
> {
  tenantId?: string;
  nodeId?: string;
  collection: string;
  documentId?: string;
  type: DatabaseEventType;
  expectedRevision?: number | null;
  schemaVersion?: number;
  idempotencyKey?: string;
  payload: TPayload;
}
```

Current idempotency semantics:

- idempotency is scoped by tenant and `idempotencyKey`
- repeating the same append input returns the previously accepted event
- repeating the same key with different append input throws a conflict error

```ts
interface ReadDatabaseEventsInput {
  tenantId?: string;
  collection?: string;
  documentId?: string;
  afterSequence?: number;
  limit?: number;
}
```

### 6.4 Reserved later additions

**reserved**

```ts
interface DatabaseEventMetadata {
  causationId?: string;
  correlationId?: string;
  source?: string;
}
```

Rule:

- `idempotencyKey` is now part of the append contract and should remain in place before replication work expands
- add `causationId` and `correlationId` only if a real workflow/debugging need exists

---

## 7. Documents API

The documents API remains the primary ergonomic data surface.

### 7.1 Public shape

**implemented now**

```ts
interface DatabaseDocumentsApi {
  createCollection(input: CreateCollectionInput): Promise<DatabaseCollection>;
  listCollections(input?: ListCollectionsInput): Promise<DatabaseCollection[]>;
  collectionExists(
    input: ListCollectionsInput & { name: string },
  ): Promise<boolean>;

  insert<TData extends DatabaseJsonObject>(
    input: InsertDocumentInput<TData>,
  ): Promise<DatabaseDocument<TData>>;

  findById(input: FindDocumentByIdInput): Promise<DatabaseDocument | null>;

  findMany(input: FindDocumentsInput): Promise<DatabaseDocument[]>;

  update<TData extends DatabaseJsonObject>(
    input: UpdateDocumentInput<TData>,
  ): Promise<DatabaseDocument<TData>>;

  delete(input: DeleteDocumentInput): Promise<boolean>;
}
```

### 7.2 Required behavior

**implemented now**

- collection creation is event-backed
- inserts and updates emit document upsert events
- deletes emit document deleted events
- reads come from projections
- writes are schema-aware when an active schema exists

### 7.3 Stability rules

**next**

- keep `documents` as the main user-facing API
- do not expose time-series through `documents`
- do not require callers to think in projection internals for normal CRUD

---

## 8. Schemas API

Schemas are a first-class public surface, not an internal detail.

### 8.1 Public shape

**implemented now**

```ts
interface DatabaseSchemasApi {
  register<TData extends DatabaseJsonObject>(
    schema: DatabaseCollectionSchema<TData>,
  ): Promise<DatabaseCollectionSchema<TData>>;

  registerMany(schemas: readonly DatabaseCollectionSchema[]): Promise<void>;

  listCollections(): DatabaseCollectionSchemaSummary[];
  listVersions(collection: string): DatabaseCollectionSchema[];
  listVersionRecords(collection: string): DatabaseStoredCollectionSchema[];

  getSchema(
    collection: string,
    version: number,
  ): DatabaseCollectionSchema | null;
  getActiveSchema(collection: string): DatabaseCollectionSchema | null;

  activate(
    collection: string,
    version: number,
  ): Promise<DatabaseCollectionSchema>;

  validate<TData extends DatabaseJsonObject>(
    input: ValidateDatabaseDocumentInput<TData>,
  ): ValidateDatabaseDocumentResult;
}
```

### 8.2 Required behavior

**implemented now**

- schemas are collection-scoped
- schemas are versioned
- active schema version is explicit
- schema validation runs before write append
- durable drivers can persist schema registry state

### 8.3 Next additions

**next**

Add explicit schema evolution metadata, but keep the write path simple:

```ts
interface DatabaseCollectionSchemaMetadata {
  description?: string;
  compatibility?: "backward" | "forward" | "full" | "breaking";
  replacesVersion?: number;
}
```

Rule:

- evolution metadata should inform tooling first
- do not block implementation on a full migration engine

---

## 9. Projections API

The projections API should become explicit before new derived models are added.

### 9.1 Why it exists

**implemented now**

Today, projections exist implicitly through document reads and driver behavior.
The projection model is now explicit at the registry-contract level.
The built-in `documents` projection is the baseline projection that powers current collection and document reads.

### 9.2 Intended shape

**implemented now**

```ts
interface DatabaseProjectionDefinition {
  name: string;
  description?: string;
  source?: {
    collections?: readonly string[];
    eventTypes?: readonly string[];
  };
  apply?(
    event: DatabaseEvent,
    context: DatabaseProjectionApplyContext,
  ): Promise<void> | void;
}

interface DatabaseProjectionSummary {
  name: string;
  builtin: boolean;
  description?: string;
  sourceCollections?: readonly string[];
  sourceEventTypes?: readonly string[];
}

interface DatabaseProjectionsApi {
  register(definition: DatabaseProjectionDefinition): Promise<void>;
  list(): Promise<DatabaseProjectionSummary[]>;
  rebuild(
    input?: DatabaseProjectionRebuildInput,
  ): Promise<DatabaseProjectionRebuildResult>;
}
```

Current behavior:

- `database.projections.list()` exposes the built-in `documents` projection
- additional projection definitions can be registered as explicit public contract metadata
- `rebuild()` currently acts as a registry-level rebuild selection contract
- custom projection execution lifecycle remains future work

### 9.3 Rules

- document projection remains the first built-in projection
- projection registration must stay runtime-neutral
- drivers may persist projection state, but the API should not be SQLite-shaped

---

## 10. Time-Series API

Time-series should be a first-class API built on the explicit projection model.

### 10.1 Intended entry point

**implemented now**

```ts
const series = db.timeseries.get("metrics");
```

### 10.2 Intended shape

**implemented now**

```ts
type TimeSeriesAggregateOperation = "avg" | "sum" | "min" | "max" | "count";

interface DatabaseTimeSeriesPoint {
  timestamp: number | string | Date;
  value: number;
  tags?: Record<string, string>;
  fields?: Record<string, DatabaseJson>;
}

interface DatabaseTimeSeriesRangeInput {
  start?: number | string | Date;
  end?: number | string | Date;
  limit?: number;
  order?: "asc" | "desc";
}

interface DatabaseTimeSeriesAggregateInput {
  op: TimeSeriesAggregateOperation;
  start?: number | string | Date;
  end?: number | string | Date;
}

interface DatabaseTimeSeriesHandle {
  range(
    input?: DatabaseTimeSeriesRangeInput,
  ): Promise<DatabaseTimeSeriesPoint[]>;
  aggregate(input: DatabaseTimeSeriesAggregateInput): Promise<number>;
}

interface DatabaseTimeSeriesApi {
  define(definition: DatabaseTimeSeriesDefinition): Promise<void>;
  list(): Promise<DatabaseTimeSeriesSummary[]>;
  get(name: string): DatabaseTimeSeriesHandle;
}
```

Current behavior:

- `database.timeseries.define()` registers a named series definition
- `database.timeseries.list()` returns registered definitions
- `database.timeseries.get(name)` returns a handle for a known series
- if a definition includes `projection`, that projection name must already exist in `database.projections`
- if a definition includes `source`, events are filtered before mapping
- if a definition includes `map`, `range()` and `aggregate()` derive points from the event stream in memory
- if a definition omits `map`, query methods fail with a clear mapper-not-defined error
- durable SQLite-backed drivers persist mapped samples and query them incrementally
- changing `definition.version` resets stored samples and rebuilds them from events on the next query

Current definition direction:

```ts
interface DatabaseTimeSeriesDefinition {
  name: string;
  description?: string;
  version?: string | number;
  source?: {
    collections?: readonly string[];
    eventTypes?: readonly string[];
  };
  projection?: string;
  map?: (
    event: DatabaseEvent,
    context: { series: string },
  ) =>
    | DatabaseTimeSeriesPoint
    | readonly DatabaseTimeSeriesPoint[]
    | null
    | undefined;
}
```

### 10.3 Rules

- time-series is not a separate source of truth
- time-series writes should still come from events
- a later direct-ingest API is acceptable only if it still emits canonical events

---

## 11. Server and HTTP API Direction

The HTTP layer should mirror the grouped service model.

### 11.1 Current grouped surface

**implemented now**

- `/database/health`
- `/database/documents/*`
- `/database/schemas/*`
- `/database/timeseries/*`

### 11.2 Next grouped surface

**partly implemented now**

- `/database/events/*` for controlled event inspection and replay-oriented reads
- `/database/projections/*` for projection registration and rebuild control
- `/database/timeseries/series` for definition listing
- `/database/timeseries/:series/range` for range reads
- `/database/timeseries/:series/aggregate` for aggregate reads

Rule:

- keep HTTP routes aligned with the grouped in-process API
- avoid ad hoc routes that bypass the public service model

---

## 12. Examples

## 12.1 Current-safe usage

**implemented now**

```ts
import { createDatabase } from "@zelavis/database";

const db = await createDatabase();

await db.documents.createCollection({ name: "products" });

await db.schemas.register({
  collection: "products",
  version: 1,
  activate: true,
  document: {
    type: "object",
    additionalProperties: false,
    required: ["name", "price"],
    properties: {
      name: { type: "string", minLength: 1 },
      price: { type: "number", minimum: 0 },
    },
  },
});

const created = await db.documents.insert({
  collection: "products",
  data: {
    name: "Starter Product",
    price: 49,
  },
});

const found = await db.documents.findById({
  collection: "products",
  id: created.id,
});

const events = await db.events.read({
  collection: "products",
});
```

## 12.2 Target usage after projection and time-series work

**reserved**

```ts
const db = await createDatabase();

await db.projections.register({
  name: "timeseries.metrics",
  source: {
    collections: ["metrics"],
    eventTypes: ["document.upserted"],
  },
  apply(event, context) {
    // map events to time-series samples
  },
});

await db.timeseries.define({
  name: "metrics",
  projection: "timeseries.metrics",
});

const points = await db.timeseries.get("metrics").range({
  start: Date.now() - 60_000,
  end: Date.now(),
});

const avg = await db.timeseries.get("metrics").aggregate({
  op: "avg",
  start: Date.now() - 60_000,
  end: Date.now(),
});
```

---

## 13. Immediate Implementation Follow-Up

After this design doc, the next implementation slices should be:

1. formalize public API type interfaces in the database package without changing runtime behavior
2. add idempotency to the event append contract
3. define the projection registry contract
4. treat the document projection as the first built-in projection
5. then add time-series on top of that explicit projection layer

---

## 14. Non-Goals for This API Slice

This design doc does not try to finalize:

- replication transport payloads
- full cluster/node membership semantics
- a migration engine
- a full query DSL redesign
- direct time-series ingest semantics

Those should follow only after the API surface above is accepted.
