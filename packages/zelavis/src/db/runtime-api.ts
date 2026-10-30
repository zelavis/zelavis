import { Effect } from "effect";
import type { DatabaseApi, TenantApi, TenantBranch } from "./database.js";
import type { KvChangePage, KvCursor, KeyValueEntry, KeyValueWrite } from "./key-value.js";
import type {
  Collection,
  CollectionModalities,
  Document,
  DocumentPage,
  FindDocumentsInput,
  FindPageInput,
  JsonObject,
  CollectionIndex,
  IndexDefinition,
  CheckConstraint,
  DocumentFilter,
  ReferenceConstraint,
  RelatedDocuments,
  DocumentWrite,
  DocumentWritten,
  OutboxEmit,
  Analyzer,
  SpatialIndex,
  EmbeddingIndex,
  EdgeDefinition,
  MeasureDefinition,
  SummarizeInput,
  Summary,
  GroupedSummary,
  TraverseInput,
  TraverseResult,
} from "./documents.js";
import type { DomainEvent, DomainEventPage, ReadDomainEventsInput } from "./domain-events.js";
import type { RestoreOptions, RestoreResult, TenantBackupV1 } from "./backup.js";
import type { OutboxPage } from "./outbox.js";
import type { EventCursor } from "./events.js";
import type { CollectionSchema, CollectionSchemaSummary, SchemaValidationResult, StoredCollectionSchema } from "./schema/index.js";
import type { ProjectionSummary } from "./projections.js";
import type {
  CrossTenantIndexDefinition, CrossTenantIndexSummary, CrossTenantQueryInput, CrossTenantQueryResult,
  CrossTenantRefreshResult,
} from "./cross-tenant-index.js";
import type { QuerySystemViewInput, SystemView, SystemViewResult } from "./system-views.js";
import type {
  AggregateInput,
  HistogramInput,
  HistogramResult,
  InterpolateInput,
  MovingInput,
  RangeInput,
  TimeSeriesBucket,
  TimeSeriesPoint,
  TimeSeriesSummary,
  WindowsInput,
} from "./time-series.js";
import { shardsOf, type ShardId, type TenantId } from "./topology.js";

/**
 * The Promise-facing surface for the HTTP runtime.
 *
 * Request handlers are async functions, so an Effect has to be run somewhere.
 * Doing it once here keeps that boundary in a single place instead of scattering
 * `runPromise` through every route, and keeps the rest of the database in the
 * error channel where failures are typed.
 *
 * A failure surfaces as a rejected promise carrying the tagged error, so a route
 * can still map `DocumentConflict` to 409 or `CollectionNotFound` to 404 without
 * knowing anything about Effect.
 */
export interface TenantRuntimeApi {
  readonly kv: {
    readonly get: (namespace: string, key: string) => Promise<KeyValueEntry | undefined>;
    readonly has: (namespace: string, key: string) => Promise<boolean>;
    readonly set: (namespace: string, key: string, value: JsonObject, options?: {
      expectedVersion?: number;
      ifAbsent?: boolean;
      idempotencyKey?: string;
      expiresAt?: string;
      ttlMs?: number;
    }) => Promise<KeyValueEntry>;
    readonly remove: (namespace: string, key: string, options?: {
      expectedVersion?: number;
      idempotencyKey?: string;
    }) => Promise<boolean>;
    readonly scan: (namespace: string, options?: {
      prefix?: string;
      lower?: string;
      upper?: string;
      direction?: "asc" | "desc";
      limit?: number;
      after?: KvCursor;
    }) => Promise<{ entries: ReadonlyArray<KeyValueEntry>; next?: KvCursor }>;
    readonly changes: (namespace: string, options?: {
      after?: DomainEvent["cursor"];
      limit?: number;
    }) => Promise<KvChangePage>;
    readonly write: (namespace: string, operations: ReadonlyArray<KeyValueWrite>, options?: {
      idempotencyKey?: string;
    }) => Promise<ReadonlyArray<KeyValueEntry | { readonly key: string; readonly deleted: boolean }>>;
    readonly size: (namespace: string) => Promise<number>;
    readonly clear: (namespace: string) => Promise<number>;
  };
  readonly documents: {
    /** How many documents the collection holds; see `DocumentsApi.count`. */
    readonly count: (collection: string) => Promise<number>;
    readonly modalities: (collection: string) => Promise<CollectionModalities>;
    readonly createCollection: (input: {
      name: string;
      surface?: Collection["surface"];
      metadata?: Record<string, unknown>;
      indexes?: ReadonlyArray<IndexDefinition>;
      checks?: ReadonlyArray<CheckConstraint>;
      references?: ReadonlyArray<ReferenceConstraint>;
      analyzer?: Analyzer;
      spatial?: SpatialIndex;
      embedding?: EmbeddingIndex;
      edges?: ReadonlyArray<EdgeDefinition>;
      measures?: ReadonlyArray<MeasureDefinition>;
      columns?: ReadonlyArray<string>;
    }) => Promise<Collection>;
    readonly analyze: (input: {
      collection: string;
      analyzer: Analyzer;
    }) => Promise<{ analyzer: Analyzer; documents: number }>;
    readonly setColumns: (input: {
      collection: string;
      columns: ReadonlyArray<string> | null;
    }) => Promise<{ columns: ReadonlyArray<string> | null; documents: number }>;
    readonly locate: (input: {
      collection: string;
      spatial: SpatialIndex;
    }) => Promise<{ spatial: SpatialIndex; documents: number }>;
    readonly embed: (input: {
      collection: string;
      embedding: EmbeddingIndex;
    }) => Promise<{ embedding: EmbeddingIndex; documents: number }>;
    readonly summarize: (input: SummarizeInput) => Promise<Summary>;
    readonly summarizeBy: (
      input: SummarizeInput & { groupBy: string; groups?: number },
    ) => Promise<ReadonlyArray<GroupedSummary>>;
    readonly addCheck: (input: CheckConstraint & { collection: string }) => Promise<CheckConstraint>;
    readonly dropCheck: (input: { collection: string; name: string }) => Promise<boolean>;
    readonly addReference: (
      input: ReferenceConstraint & { from: string },
    ) => Promise<Required<ReferenceConstraint>>;
    readonly dropReference: (input: { collection: string; name: string }) => Promise<boolean>;
    readonly withRelated: (input: {
      collection: string;
      documents: ReadonlyArray<Document>;
      references?: ReadonlyArray<string>;
    }) => Promise<ReadonlyArray<RelatedDocuments>>;
    readonly write: (input: {
      operations: ReadonlyArray<DocumentWrite>;
      /** Messages for the tenant's outbox, committed with the changes or not at all. */
      emit?: ReadonlyArray<OutboxEmit>;
      /**
       * Do this at most once.
       *
       * A retry carrying the same key is answered with what the first attempt
       * returned instead of being applied again. This matters most over a
       * network, where a caller that never sees a response cannot tell a lost
       * reply from a lost request.
       */
      idempotencyKey?: string;
    }) => Promise<ReadonlyArray<DocumentWritten>>;
    readonly rewrite: (input?: {
      collection?: string;
    }) => Promise<{ collections: number; documents: number }>;
    readonly createIndex: (input: IndexDefinition & { collection: string }) => Promise<CollectionIndex>;
    readonly dropIndex: (input: { collection: string; name: string }) => Promise<boolean>;
    readonly listCollections: () => Promise<ReadonlyArray<Collection>>;
    /**
     * Remove a collection and everything in it.
     *
     * Refused while another collection references this one, and linear in the
     * collection's size: documents go through the ordinary delete path so the
     * lenses stay the business of the code that maintains them.
     */
    readonly dropCollection: (input: { name: string }) => Promise<boolean>;
    readonly collectionExists: (name: string) => Promise<boolean>;
    readonly insert: (input: {
      collection: string;
      /** Do this at most once; see `write`. Supply `id` alongside it. */
      idempotencyKey?: string;
      id?: string;
      data: JsonObject;
    }) => Promise<Document>;
    readonly findById: (input: {
      collection: string;
      id: string;
    }) => Promise<Document | undefined>;
    readonly findMany: (input: FindDocumentsInput) => Promise<ReadonlyArray<Document>>;
    readonly findPage: (input: FindPageInput) => Promise<DocumentPage>;
    readonly traverse: (input: TraverseInput) => Promise<TraverseResult>;
    readonly update: (input: {
      collection: string;
      /** Do this at most once; see `write`. */
      idempotencyKey?: string;
      id: string;
      data: JsonObject;
      mode?: "merge" | "replace";
      expectedVersion?: number;
      precondition?: ReadonlyArray<DocumentFilter>;
    }) => Promise<Document>;
    readonly delete: (input: {
      collection: string;
      /** Do this at most once; see `write`. */
      idempotencyKey?: string;
      id: string;
      expectedVersion?: number;
      precondition?: ReadonlyArray<DocumentFilter>;
    }) => Promise<boolean>;
  };
  readonly events: {
    readonly read: (input?: ReadDomainEventsInput) => Promise<DomainEventPage>;
  };
  readonly schemas: {
    readonly save: (schema: CollectionSchema) => Promise<StoredCollectionSchema>;
    readonly listCollections: () => Promise<ReadonlyArray<CollectionSchemaSummary>>;
    readonly listVersions: (
      collection: string,
    ) => Promise<ReadonlyArray<StoredCollectionSchema>>;
    readonly getVersion: (
      collection: string,
      version: number,
    ) => Promise<StoredCollectionSchema | undefined>;
    readonly getActive: (collection: string) => Promise<StoredCollectionSchema | undefined>;
    readonly activate: (
      collection: string,
      version: number,
    ) => Promise<StoredCollectionSchema>;
    readonly validate: (
      collection: string,
      data: JsonObject,
    ) => Promise<SchemaValidationResult>;
  };
  readonly projections: {
    readonly list: () => Promise<ReadonlyArray<ProjectionSummary>>;
    readonly run: (name: string) => Promise<{ name: string; applied: number }>;
    readonly rebuild: (name: string) => Promise<{ name: string; applied: number }>;
  };
  readonly timeSeries: {
    readonly list: () => Promise<ReadonlyArray<TimeSeriesSummary>>;
    readonly range: (
      series: string,
      input?: RangeInput,
    ) => Promise<ReadonlyArray<TimeSeriesPoint>>;
    readonly aggregate: (series: string, input: AggregateInput) => Promise<number>;
    readonly windows: (
      series: string,
      input: WindowsInput,
    ) => Promise<ReadonlyArray<TimeSeriesBucket>>;
    readonly moving: (
      series: string,
      input: MovingInput,
    ) => Promise<ReadonlyArray<TimeSeriesPoint>>;
    readonly histogram: (
      series: string,
      input: HistogramInput,
    ) => Promise<HistogramResult>;
    readonly interpolate: (
      series: string,
      input: InterpolateInput,
    ) => Promise<ReadonlyArray<TimeSeriesPoint>>;
    readonly ingest: (series: string) => Promise<{ name: string; points: number }>;
  };
  readonly outbox: {
    readonly emit: (message: OutboxEmit & { readonly idempotencyKey?: string }) => Promise<{ readonly id: string }>;
    readonly read: (input?: { readonly after?: EventCursor; readonly limit?: number; readonly topic?: string }) => Promise<OutboxPage>;
    readonly remove: (input: { readonly ids: ReadonlyArray<string> }) => Promise<{ readonly removed: number }>;
  };
  readonly backups: {
    readonly exportTenant: () => Promise<TenantBackupV1>;
    readonly restoreTenant: (backup: TenantBackupV1, options?: RestoreOptions) => Promise<RestoreResult>;
  };
  readonly systemViews: {
    readonly list: () => ReadonlyArray<SystemView>;
    readonly query: (input: QuerySystemViewInput) => Promise<SystemViewResult>;
  };
}

export interface DatabaseRuntimeApi {
  readonly forTenant: (tenant: TenantId) => TenantRuntimeApi;
  readonly shardOf: (tenant: TenantId) => string;
  /** Every tenant holding data. What an operator surface needs to offer a choice. */
  readonly tenants: () => Promise<ReadonlyArray<TenantId>>;
  /** What each Tenant's partition holds, as the database keeps it rather than counts it: records, their bytes and the shard. */
  /** Remove a Tenant and everything it holds, history included; see `Database.dropTenant`. */
  readonly dropTenant: (tenant: TenantId) => Promise<{ readonly tenant: TenantId; readonly shard: string; readonly records: number }>;
  /** Make `into` a new Tenant holding a copy of `tenant` as of one position of its log; see `Database.branchTenant`. */
  readonly branchTenant: (tenant: TenantId, into: TenantId) => Promise<TenantBranch>;
  readonly tenantUsage: () => Promise<ReadonlyArray<{ readonly tenant: TenantId; readonly shard: string; readonly records: number; readonly bytes: number }>>;
  readonly context: { readonly nodeId: string };
  /** One collection's documents from every Tenant, queried from one partition; see `DatabaseApi.crossTenantIndexes`. */
  readonly crossTenantIndexes: {
    readonly define: (definition: CrossTenantIndexDefinition) => Promise<CrossTenantIndexSummary>;
    readonly list: () => Promise<ReadonlyArray<CrossTenantIndexSummary>>;
    readonly get: (name: string) => Promise<CrossTenantIndexSummary>;
    readonly drop: (name: string) => Promise<{ readonly name: string; readonly entries: number }>;
    readonly refresh: (name?: string) => Promise<ReadonlyArray<CrossTenantRefreshResult>>;
    readonly query: (input: CrossTenantQueryInput) => Promise<CrossTenantQueryResult>;
  };
  /**
   * What a health or operator surface may report about placement.
   *
   * A flattened reading of the partition map rather than the map itself: an
   * endpoint should be able to say how many shards are open and which map
   * version is in force without handing callers the placement table, which is
   * an operator concern reached through the topology API.
   */
  readonly topology: {
    readonly shards: ReadonlyArray<ShardId>;
    readonly virtualRanges: number;
    readonly partitionMapVersion: number;
  };
}

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const tenantRuntime = (tenant: TenantApi): TenantRuntimeApi => ({
  kv: {
    get: (namespace, key) => run(tenant.kv.namespace(namespace).get(key)),
    has: (namespace, key) => run(tenant.kv.namespace(namespace).has(key)),
    set: (namespace, key, value, options) => run(tenant.kv.namespace(namespace).set(key, value, options)),
    remove: (namespace, key, options) => run(tenant.kv.namespace(namespace).remove(key, options)),
    scan: (namespace, options) => run(tenant.kv.namespace(namespace).scan(options)),
    changes: (namespace, options) => run(tenant.kv.namespace(namespace).changes(options)),
    write: (namespace, operations, options) => run(tenant.kv.namespace(namespace).write(operations, options)),
    size: (namespace) => run(tenant.kv.namespace(namespace).size),
    clear: (namespace) => run(tenant.kv.namespace(namespace).clear),
  },
  documents: {
    count: (collection) => run(tenant.documents.count({ collection })),
    modalities: (collection) => run(tenant.documents.modalities({ collection })),
    createCollection: (input) => run(tenant.documents.createCollection(input)),
    createIndex: (input) => run(tenant.documents.createIndex(input)),
    dropIndex: (input) => run(tenant.documents.dropIndex(input)),
    analyze: (input) => run(tenant.documents.analyze(input)),
    setColumns: (input) => run(tenant.documents.setColumns(input)),
    locate: (input) => run(tenant.documents.locate(input)),
    embed: (input) => run(tenant.documents.embed(input)),
    summarize: (input) => run(tenant.documents.summarize(input)),
    summarizeBy: (input) => run(tenant.documents.summarizeBy(input)),
    addCheck: (input) => run(tenant.documents.addCheck(input)),
    dropCheck: (input) => run(tenant.documents.dropCheck(input)),
    addReference: (input) => run(tenant.documents.addReference(input)),
    dropReference: (input) => run(tenant.documents.dropReference(input)),
    withRelated: (input) => run(tenant.documents.withRelated(input)),
    write: (input) => run(tenant.documents.write(input)),
    rewrite: (input) => run(tenant.documents.rewrite(input)),
    listCollections: () => run(tenant.documents.listCollections),
    dropCollection: (input) => run(tenant.documents.dropCollection(input)),
    collectionExists: (name) => run(tenant.documents.collectionExists(name)),
    insert: (input) => run(tenant.documents.insert(input)),
    findById: (input) => run(tenant.documents.findById(input)),
    findMany: (input) => run(tenant.documents.findMany(input)),
    findPage: (input) => run(tenant.documents.findPage(input)),
    traverse: (input) => run(tenant.documents.traverse(input)),
    update: (input) => run(tenant.documents.update(input)),
    delete: (input) => run(tenant.documents.delete(input)),
  },
  events: {
    read: (input) => run(tenant.events.read(input)),
  },
  schemas: {
    save: (schema) => run(tenant.schemas.save(schema)),
    listCollections: () => run(tenant.schemas.listCollections),
    listVersions: (collection) => run(tenant.schemas.listVersions(collection)),
    getVersion: (collection, version) => run(tenant.schemas.getVersion(collection, version)),
    getActive: (collection) => run(tenant.schemas.getActive(collection)),
    activate: (collection, version) => run(tenant.schemas.activate(collection, version)),
    validate: (collection, data) => run(tenant.schemas.validate(collection, data)),
  },
  projections: {
    list: () => run(tenant.projections.list),
    run: (name) => run(tenant.projections.run(name)),
    rebuild: (name) => run(tenant.projections.rebuild(name)),
  },
  timeSeries: {
    list: () => run(tenant.timeSeries.list),
    range: (series, input) => run(tenant.timeSeries.get(series).range(input)),
    aggregate: (series, input) => run(tenant.timeSeries.get(series).aggregate(input)),
    windows: (series, input) => run(tenant.timeSeries.get(series).windows(input)),
    moving: (series, input) => run(tenant.timeSeries.get(series).moving(input)),
    histogram: (series, input) => run(tenant.timeSeries.get(series).histogram(input)),
    interpolate: (series, input) => run(tenant.timeSeries.get(series).interpolate(input)),
    ingest: (series) => run(tenant.timeSeries.ingest(series)),
  },
  outbox: {
    emit: (message) => run(tenant.outbox.emit(message)),
    read: (input) => run(tenant.outbox.read(input)),
    remove: (input) => run(tenant.outbox.remove(input)),
  },
  backups: {
    exportTenant: () => run(tenant.backups.exportTenant),
    restoreTenant: (backup, options) => run(tenant.backups.restoreTenant(backup, options)),
  },
  systemViews: {
    list: () => tenant.systemViews.list(),
    query: (input) => run(tenant.systemViews.query(input)),
  },
});

export const runtimeApiFor = (
  database: DatabaseApi,
  options?: { readonly nodeId?: string },
): DatabaseRuntimeApi => ({
  forTenant: (tenant) => tenantRuntime(database.forTenant(tenant)),
  shardOf: (tenant) => database.shardOf(tenant),
  tenants: () => run(database.tenants),
  dropTenant: (tenant) => run(database.dropTenant(tenant)),
  branchTenant: (tenant, into) => run(database.branchTenant(tenant, into)),
  tenantUsage: () => run(Effect.map(database.maintenance.status, rows => rows.map(row => ({ tenant: row.partition, shard: row.shard, records: row.records, bytes: row.bytes })))),
  context: { nodeId: options?.nodeId ?? "local" },
  crossTenantIndexes: {
    define: (definition) => run(database.crossTenantIndexes.define(definition)),
    list: () => run(database.crossTenantIndexes.list),
    get: (name) => run(database.crossTenantIndexes.get(name)),
    drop: (name) => run(database.crossTenantIndexes.drop(name)),
    refresh: (name) => run(database.crossTenantIndexes.refresh(name)),
    query: (input) => run(database.crossTenantIndexes.query(input)),
  },
  topology: {
    shards: shardsOf(database.partitionMap),
    virtualRanges: database.partitionMap.virtualRanges,
    partitionMapVersion: database.partitionMap.version,
  },
});
