import { Effect, Fiber, Stream } from "effect";
import type { DatabaseBackupsHost } from "./node-backups.js";
import type { WorkflowExecutionSummary } from "./workflow-engine.js";
import type { BranchMerge, MergeOptions } from "./branch-merge.js";
import type { ImportPlan, ImportRun, ImportSource, ImportVerification } from "./imports.js";
import { exportWholeTenant, restoreWholeTenant, type WholeTenantBackup, type WholeTenantRestoreResult } from "./divided-backup.js";
import type { KvDurability } from "./kv.js";
import type { AggregateDefinition, MaterializedAggregate } from "./aggregates.js";
import type { CovarianceInput, MeasureHistogramInput, MeasureHistogram } from "./document-model.js";
import type { ActivatedSchema, PendingActivation } from "./schema-activation.js";
import type { GeneratedSchemaTypes, LogicalSchemaBundle, SchemaExportOptions, SchemaImportOptions, SchemaImportResult } from "./schema-transfer.js";
import type { ExportPage, ExportPageInput } from "./export-stream.js";
import { eventToWire, LEADER_LOG_LIMIT, LEADER_RECORDS_LIMIT, recordToWire, validFollowerName, type LeaderChanges, type LeaderTransport } from "./leader.js";
import { asSeq } from "./model.js";
import type { EntityMessage, EntitySend, EntityServeOptions, EntityState, EntityStep } from "./entities.js";
import { integration } from "../core/runtime/effect-boundary.js";
import { PART_SEPARATOR } from "./topology.js";
import { InvalidFollowerRequest } from "./errors.js";
import type { BranchTenantOptions, DatabaseApi, RecoveryWindow, TenantApi, TenantBranch, TenantRemoval } from "./database.js";
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
import type { PartitionStats } from "./store.js";
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
import type { ScatterFindInput, ScatterResult, ScatteredDocument } from "./scatter.js";
import type { SearchStatistics } from "./document-model.js";

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
    readonly covariance: (input: CovarianceInput) => Promise<Summary>;
    readonly histogram: (input: MeasureHistogramInput) => Promise<MeasureHistogram>;
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
    readonly searchStatistics: (input: FindDocumentsInput & { readonly search: string }) => Promise<SearchStatistics>;
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
    readonly export: (options?: SchemaExportOptions) => Promise<LogicalSchemaBundle>;
    readonly import: (options: SchemaImportOptions) => Promise<SchemaImportResult>;
    readonly types: (options?: SchemaExportOptions) => Promise<GeneratedSchemaTypes>;
    readonly save: (schema: CollectionSchema) => Promise<StoredCollectionSchema | ActivatedSchema>;
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
    ) => Promise<ActivatedSchema>;
    /** Activations recorded and not yet published. */
    readonly pendingActivations: () => Promise<ReadonlyArray<PendingActivation>>;
    /** Run every pending activation again; how many were published. */
    readonly resumeActivations: () => Promise<number>;
    readonly validate: (
      collection: string,
      data: JsonObject,
    ) => Promise<SchemaValidationResult>;
  };
  readonly aggregates: {
    readonly define: (input: AggregateDefinition) => Promise<MaterializedAggregate>;
    readonly list: () => Promise<ReadonlyArray<MaterializedAggregate>>;
    readonly get: (name: string) => Promise<MaterializedAggregate>;
    readonly refresh: (name: string) => Promise<MaterializedAggregate>;
    readonly drop: (name: string) => Promise<{ readonly name: string }>;
  };
  readonly imports: {
    readonly plan: (source: ImportSource) => Promise<ImportPlan>;
    readonly run: (source: ImportSource & { readonly importId: string; readonly offset?: number; readonly limit?: number }) => Promise<ImportRun>;
    readonly verify: (source: ImportSource) => Promise<ImportVerification>;
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
  /** Durable entities in this Tenant; see `EntitiesApi`. */
  readonly entities: {
    readonly send: (input: EntitySend) => Promise<{ readonly message: EntityMessage; readonly duplicate: boolean }>;
    readonly message: (input: { readonly type: string; readonly id: string; readonly messageKey: string }) => Promise<EntityMessage | undefined>;
    readonly state: (input: { readonly type: string; readonly id: string }) => Promise<EntityState | undefined>;
    readonly mailbox: (input: { readonly type: string; readonly id: string; readonly after?: string; readonly limit?: number }) =>
      Promise<{ readonly messages: ReadonlyArray<EntityMessage>; readonly next?: string }>;
    readonly list: (input: { readonly type: string; readonly after?: string; readonly limit?: number }) =>
      Promise<{ readonly entities: ReadonlyArray<EntityState>; readonly next?: string }>;
    readonly cancel: (input: { readonly type: string; readonly id: string; readonly messageKey: string }) =>
      Promise<{ readonly cancelled: boolean; readonly message?: EntityMessage }>;
  };
  readonly backups: {
    readonly exportTenant: () => Promise<TenantBackupV1>;
    /** One page of this Tenant as a stream; see `BackupsApi.exportPage`. */
    readonly exportPage: (input?: ExportPageInput) => Promise<ExportPage>;
    readonly restoreTenant: (backup: TenantBackupV1, options?: RestoreOptions) => Promise<RestoreResult>;
  };
  readonly systemViews: {
    readonly list: () => ReadonlyArray<SystemView>;
    readonly query: (input: QuerySystemViewInput) => Promise<SystemViewResult>;
  };
}

/** A durable entity's handler as Promise code: the message, the entity's state and its Tenant's documents, answering a step. */
export type RuntimeEntityHandler = (
  message: EntityMessage,
  context: { readonly tenant: TenantId; readonly state: EntityState["state"]; readonly documents: TenantRuntimeApi["documents"] },
) => EntityStep | Promise<EntityStep>;

export interface DatabaseRuntimeApi {
  readonly scatter: (input: ScatterFindInput) => Promise<ScatterResult<ScatteredDocument>>;
  readonly forTenant: (tenant: TenantId) => TenantRuntimeApi;
  readonly shardOf: (tenant: TenantId) => string;
  /** Every tenant holding data. What an operator surface needs to offer a choice. */
  readonly tenants: () => Promise<ReadonlyArray<TenantId>>;
  /** Every partition holding data: Tenants, and a divided Tenant's parts under their part keys (`whale#a`). */
  readonly partitions: () => Promise<ReadonlyArray<TenantId>>;
  /** The parts a Tenant is divided into, or `undefined` when it is not divided. */
  readonly partsOf: (tenant: TenantId) => ReadonlyArray<string> | undefined;
  /** One part of a divided Tenant; see `Database.forPart`. */
  readonly forPart: (tenant: TenantId, part: string) => TenantRuntimeApi;
  /** What each Tenant's partition holds, as the database keeps it rather than counts it: records, their bytes and the shard. */
  /** Physical backups of the whole database, where the host writes them; see `DatabaseImagesHost`. */
  readonly images: DatabaseImagesHost;
  /** Scheduled, encrypted, off-site backups, where the host runs them; see `node-backups.ts`. */
  readonly backups: DatabaseBackupsHost;
  /** The durability this database runs with and the one it opens with next; absent for a host that opened it itself. */
  readonly storageChoice?: StorageChoiceHost;
  /** One page of a Tenant, or of a divided Tenant as a whole, as a stream; see `Database.exportPage`. */
  readonly exportPage: (tenant: TenantId, input?: ExportPageInput) => Promise<ExportPage>;
  /** Remove a Tenant and everything it holds, history included; see `Database.dropTenant`. */
  readonly dropTenant: (tenant: TenantId) => Promise<TenantRemoval>;
  /** A whole Tenant's backup: the ordinary one, or one per part for a divided Tenant; see `exportWholeTenant`. */
  readonly backupTenant: (tenant: TenantId) => Promise<WholeTenantBackup>;
  /** Restore a whole-Tenant backup into `tenant`; see `restoreWholeTenant`. */
  readonly restoreTenantBackup: (tenant: TenantId, backup: WholeTenantBackup, options?: RestoreOptions) => Promise<WholeTenantRestoreResult>;
  /** Make `into` a new Tenant holding a copy of `tenant` as of one position of its log; see `Database.branchTenant`. */
  readonly branchTenant: (tenant: TenantId, into: TenantId, options?: BranchTenantOptions) => Promise<TenantBranch>;
  /** Merge a branch back into its source; see `Database.mergeBranch`. */
  readonly mergeBranch: (branch: TenantId, options?: MergeOptions) => Promise<BranchMerge>;
  readonly branchedFrom: (tenant: TenantId) => Promise<TenantId | undefined>;
  /** Recorded workflow executions; see `Database.workflowExecutions`. */
  readonly workflowExecutions: (limit?: number) => Promise<ReadonlyArray<WorkflowExecutionSummary>>;
  /** How far back `branchTenant` can recover a Tenant; see `Database.recoveryWindow`. */
  readonly recoveryWindow: (tenant: TenantId) => Promise<RecoveryWindow>;
  readonly tenantUsage: () => Promise<ReadonlyArray<{ readonly tenant: TenantId; readonly shard: string; readonly records: number; readonly bytes: number }>>;
  /** Where this database runs, and what its storage promises; `storage` is absent for a database a host opened itself. */
  readonly context: { readonly nodeId: string; readonly storage?: { readonly engine: string; readonly durability: KvDurability } };
  /**
   * Process durable entities' messages with Promise handlers by type until `stop` (see `DatabaseApi.entities`). A
   * handler is looked up for every message, so it can change while this serves; a type with none keeps its messages.
   */
  readonly entities: {
    readonly serve: (
      handlers: (type: string) => RuntimeEntityHandler | undefined,
      options?: Omit<EntityServeOptions, "handlers">,
    ) => { readonly stop: () => Promise<void> };
  };
  /**
   * The leader's side of following a partition from another host, answering the wire forms `remoteLeader`
   * reads: it is itself a `LeaderTransport`. See `leader.ts`.
   */
  readonly followers: LeaderTransport & {
    readonly stats: (partition: string) => Promise<PartitionStats>;
    readonly changes: (input: Parameters<LeaderTransport["changes"]>[0]) => Promise<LeaderChanges>;
    /** How far each follower has said it holds `partition`. */
    readonly acknowledgments: (partition: string) => Promise<{ readonly partition: string; readonly followers: ReadonlyArray<{ readonly name: string; readonly position: number }> }>;
  };
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
    covariance: (input) => run(tenant.documents.covariance(input)),
    histogram: (input) => run(tenant.documents.histogram(input)),
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
    searchStatistics: (input) => run(tenant.documents.searchStatistics(input)),
    findPage: (input) => run(tenant.documents.findPage(input)),
    traverse: (input) => run(tenant.documents.traverse(input)),
    update: (input) => run(tenant.documents.update(input)),
    delete: (input) => run(tenant.documents.delete(input)),
  },
  events: {
    read: (input) => run(tenant.events.read(input)),
  },
  schemas: {
    export: (options) => run(tenant.schemas.export(options)),
    import: (options) => run(tenant.schemas.import(options)),
    types: (options) => run(tenant.schemas.types(options)),
    save: (schema) => run(tenant.schemas.save(schema)),
    listCollections: () => run(tenant.schemas.listCollections),
    listVersions: (collection) => run(tenant.schemas.listVersions(collection)),
    getVersion: (collection, version) => run(tenant.schemas.getVersion(collection, version)),
    getActive: (collection) => run(tenant.schemas.getActive(collection)),
    activate: (collection, version) => run(tenant.schemas.activate(collection, version)),
    pendingActivations: () => run(tenant.schemas.pendingActivations),
    resumeActivations: () => run(tenant.schemas.resumeActivations),
    validate: (collection, data) => run(tenant.schemas.validate(collection, data)),
  },
  aggregates: {
    define: (input) => run(tenant.aggregates.define(input)),
    list: () => run(tenant.aggregates.list),
    get: (name) => run(tenant.aggregates.get(name)),
    refresh: (name) => run(tenant.aggregates.refresh(name)),
    drop: (name) => run(tenant.aggregates.drop(name)),
  },
  imports: {
    plan: (source) => run(tenant.imports.plan(source)),
    run: (source) => run(tenant.imports.run(source)),
    verify: (source) => run(tenant.imports.verify(source)),
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
  entities: {
    send: (input) => run(tenant.entities.send(input)),
    message: (input) => run(tenant.entities.message(input)),
    state: (input) => run(tenant.entities.state(input)),
    mailbox: (input) => run(tenant.entities.mailbox(input)),
    list: (input) => run(tenant.entities.list(input)),
    cancel: (input) => run(tenant.entities.cancel(input)),
  },
  backups: {
    exportTenant: () => run(tenant.backups.exportTenant),
    exportPage: (input) => run(tenant.backups.exportPage(input)),
    restoreTenant: (backup, options) => run(tenant.backups.restoreTenant(backup, options)),
  },
  systemViews: {
    list: () => tenant.systemViews.list(),
    query: (input) => run(tenant.systemViews.query(input)),
  },
});

/** A database image a host wrote: every shard copied byte for byte into an ordinary shard directory. */
export interface DatabaseImage {
  readonly name: string;
  readonly createdAt: string;
  /** The engine the image is written in: the one to open it with. */
  readonly engine: string;
  readonly keys: number;
  readonly bytes: number;
  /** Each shard's share, with the SHA-256 of its keys and values as written, which `verify` compares. */
  readonly shards: ReadonlyArray<{ readonly shard: string; readonly keys: number; readonly bytes: number; readonly digest?: string }>;
}

/** The storage this database runs with, and what it opens with next when that was changed. */
export interface StorageChoice {
  readonly engine: string;
  readonly durability: KvDurability;
  /** Recorded and taking effect when the database next opens (the Project's next start). */
  readonly pending?: KvDurability;
}
export interface StorageChoiceHost {
  readonly get: () => StorageChoice;
  readonly set: (durability: KvDurability) => StorageChoice;
}

/** Whether an image still holds exactly what was written, shard by shard. */
export interface DatabaseImageVerification {
  readonly name: string;
  readonly ok: boolean;
  readonly verifiedAt: string;
  readonly shards: ReadonlyArray<{ readonly shard: string; readonly keys: number; readonly ok: boolean; readonly problem?: string }>;
}

/**
 * What a host that can write database images offers. A physical backup of the whole database
 * through the ordered key-value interface; see `MaintenanceApi.image`. Restoring one replaces the live
 * database, which the operator does with the Project stopped, so there is no operation for it.
 */
export interface DatabaseImagesHost {
  /** Copy every shard into a new image `name`, in `engine` (the database's own when omitted). */
  readonly create: (name: string, options?: { readonly engine?: string }) => Promise<DatabaseImage>;
  readonly list: () => Promise<ReadonlyArray<DatabaseImage>>;
  /** Remove one image. */
  readonly remove: (name: string) => Promise<{ readonly name: string; readonly bytes: number }>;
  /** Read every shard of an image back and compare it with what was written. */
  readonly verify: (name: string) => Promise<DatabaseImageVerification>;
  /** Keep the newest `keep` images (1 to 1000) and remove the rest, oldest first. */
  readonly prune: (keep: number) => Promise<{ readonly removed: ReadonlyArray<string>; readonly kept: ReadonlyArray<string> }>;
}

const cannotBackUp = () => Promise.reject(new TypeError("This host cannot run scheduled backups."));
const noBackups: DatabaseBackupsHost = {
  schedules: () => Promise.resolve([]), runs: () => Promise.resolve([]),
  createSchedule: cannotBackUp, deleteSchedule: cannotBackUp, runNow: cannotBackUp, verify: cannotBackUp, restore: cannotBackUp, drill: cannotBackUp, drillFrom: cannotBackUp,
};

const noImages: DatabaseImagesHost = {
  create: () => Promise.reject(new TypeError("This host cannot write database images.")),
  list: () => Promise.resolve([]),
  remove: () => Promise.reject(new TypeError("This host cannot write database images.")),
  verify: () => Promise.reject(new TypeError("This host cannot write database images.")),
  prune: () => Promise.reject(new TypeError("This host cannot write database images.")),
};

const refuse = (partition: string, reason: string) => new InvalidFollowerRequest({ partition, reason });
const pageLimit = (partition: string, limit: unknown, most: number) =>
  typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > most
    ? Effect.fail(refuse(partition, `"limit" is a whole number from 1 to ${most}`))
    : Effect.succeed(limit);

/** The follower routes' answers, in the wire forms `remoteLeader` checks. */
const followersRuntime = (database: DatabaseApi): DatabaseRuntimeApi["followers"] => {
  const source = (partition: string) => database.followers.source(partition);
  return {
    stats: (partition) => run(Effect.flatMap(source(partition), (leader) => leader.stats)),
    records: (partition, input) => run(Effect.gen(function* () {
      const limit = yield* pageLimit(partition, input.limit, LEADER_RECORDS_LIMIT);
      if (input.after !== undefined && (!Number.isSafeInteger(input.after) || input.after < 0)) {
        return yield* refuse(partition, `"after" is the identifier the last page ended at`);
      }
      const leader = yield* source(partition);
      const page = yield* leader.scanRecords({ ...(input.after === undefined ? {} : { after: asSeq(input.after) }), limit });
      return { records: page.map(({ seq, record }) => recordToWire(seq, record)) };
    })),
    log: (partition, input) => run(Effect.gen(function* () {
      const limit = yield* pageLimit(partition, input.limit, LEADER_LOG_LIMIT);
      if (input.after !== undefined && input.from !== undefined) return yield* refuse(partition, `"after" and "from" are not given together`);
      const leader = yield* source(partition);
      const events = yield* Stream.runCollect(leader.events.read({
        ...(input.after === undefined ? {} : { after: input.after as EventCursor }),
        ...(input.from === undefined ? {} : { from: input.from as EventCursor }),
        limit,
      }));
      return { events: [...events].map(eventToWire) };
    })),
    hold: (partition, input) => run(Effect.flatMap(source(partition), (leader) => leader.holdLog(input))),
    release: (partition, id) => run(Effect.as(Effect.flatMap(source(partition), (leader) => leader.releaseLog(id)), { released: true })),
    acknowledge: (partition, input) => run(Effect.gen(function* () {
      if (!validFollowerName(input.follower)) return yield* refuse(partition, `"follower" names the follower in 1 to 128 characters`);
      if (!Number.isSafeInteger(input.position) || input.position < 0) return yield* refuse(partition, `"position" is the log position the follower holds`);
      const record = yield* database.followers.acknowledgments(partition);
      yield* record.acknowledge(input.follower, input.position);
      return { follower: input.follower, position: (yield* record.positions).get(input.follower) ?? input.position };
    })),
    acknowledgments: (partition) => run(Effect.gen(function* () {
      const record = yield* database.followers.acknowledgments(partition);
      const positions = yield* record.positions;
      return { partition, followers: [...positions].map(([name, position]) => ({ name, position })).sort((a, b) => (a.name < b.name ? -1 : 1)) };
    })),
    changes: (input) => run(database.followers.changes(input)),
  };
};

export const runtimeApiFor = (
  database: DatabaseApi,
  options?: { readonly nodeId?: string; readonly images?: DatabaseImagesHost; readonly backups?: DatabaseBackupsHost; readonly storageChoice?: StorageChoiceHost; readonly storage?: { readonly engine: string; readonly durability: KvDurability } },
): DatabaseRuntimeApi => ({
  scatter: (input) => run(database.scatter.findMany(input)),
  images: options?.images ?? noImages,
  backups: options?.backups ?? noBackups,
  ...(options?.storageChoice === undefined ? {} : { storageChoice: options.storageChoice }),
  forTenant: (tenant) => tenantRuntime(database.forTenant(tenant)),
  shardOf: (tenant) => database.shardOf(tenant),
  tenants: () => run(database.tenants),
  partitions: () => run(database.partitions),
  partsOf: (tenant) => database.topology.subdivision.partsOf(tenant),
  forPart: (tenant, part) => tenantRuntime(database.forPart(tenant, part)),
  exportPage: (tenant, input) => run(database.exportPage(tenant, input)),
  dropTenant: (tenant) => run(database.dropTenant(tenant)),
  backupTenant: (tenant) => run(exportWholeTenant(database, tenant)),
  restoreTenantBackup: (tenant, backup, options) => run(restoreWholeTenant(database, tenant, backup, options)),
  branchTenant: (tenant, into, options) => run(database.branchTenant(tenant, into, options)),
  recoveryWindow: (tenant) => run(database.recoveryWindow(tenant)),
  mergeBranch: (branch, options) => run(database.mergeBranch(branch, options)),
  branchedFrom: (tenant) => run(database.branchedFrom(tenant)),
  workflowExecutions: (limit) => run(database.workflowExecutions(limit)),
  tenantUsage: () => run(Effect.map(database.maintenance.status, rows => rows.map(row => ({ tenant: row.partition, shard: row.shard, records: row.records, bytes: row.bytes })))),
  context: { nodeId: options?.nodeId ?? "local", ...(options?.storage === undefined ? {} : { storage: options.storage }) },
  followers: followersRuntime(database),
  entities: {
    serve: (handlers, options) => {
      // A part key names one part of a divided Tenant; anything else is the Tenant itself.
      const handleOf = (partition: TenantId) => {
        const at = partition.indexOf(PART_SEPARATOR);
        return at < 0 ? database.forTenant(partition) : database.forPart(partition.slice(0, at), partition.slice(at + PART_SEPARATOR.length));
      };
      const fiber = Effect.runFork(Effect.scoped(database.entities.serve({
        ...options,
        handlers: (type) => {
          const handler = handlers(type);
          return handler === undefined ? undefined : (message, context) =>
            integration(() => handler(message, { tenant: context.tenant, state: context.state, documents: tenantRuntime(handleOf(context.tenant)).documents }));
        },
      })));
      return { stop: () => Effect.runPromise(Effect.asVoid(Fiber.interrupt(fiber))) };
    },
  },
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
