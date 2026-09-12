import { Effect } from "effect";
import type { DatabaseApi, TenantApi } from "./database.js";
import type {
  Collection,
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
} from "./documents.js";
import type { DomainEvent, ReadDomainEventsInput } from "./domain-events.js";
import type { TenantBackupV1 } from "./backup.js";
import type { CollectionSchema, CollectionSchemaSummary, SchemaValidationResult, StoredCollectionSchema } from "./schema/index.js";
import type { ProjectionSummary } from "./projections.js";
import type { QuerySystemViewInput, SystemView, SystemViewResult } from "./system-views.js";
import type {
  AggregateInput,
  RangeInput,
  TimeSeriesPoint,
  TimeSeriesSummary,
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
  readonly documents: {
    readonly createCollection: (input: {
      name: string;
      surface?: Collection["surface"];
      metadata?: Record<string, unknown>;
      indexes?: ReadonlyArray<IndexDefinition>;
      checks?: ReadonlyArray<CheckConstraint>;
      references?: ReadonlyArray<ReferenceConstraint>;
    }) => Promise<Collection>;
    readonly addCheck: (input: CheckConstraint & { collection: string }) => Promise<CheckConstraint>;
    readonly dropCheck: (input: { collection: string; name: string }) => Promise<boolean>;
    readonly addReference: (
      input: ReferenceConstraint & { from: string },
    ) => Promise<Required<ReferenceConstraint>>;
    readonly dropReference: (input: { collection: string; name: string }) => Promise<boolean>;
    readonly createIndex: (input: IndexDefinition & { collection: string }) => Promise<CollectionIndex>;
    readonly dropIndex: (input: { collection: string; name: string }) => Promise<boolean>;
    readonly listCollections: () => Promise<ReadonlyArray<Collection>>;
    readonly collectionExists: (name: string) => Promise<boolean>;
    readonly insert: (input: {
      collection: string;
      id?: string;
      data: JsonObject;
    }) => Promise<Document>;
    readonly findById: (input: {
      collection: string;
      id: string;
    }) => Promise<Document | undefined>;
    readonly findMany: (input: FindDocumentsInput) => Promise<ReadonlyArray<Document>>;
    readonly findPage: (input: FindPageInput) => Promise<DocumentPage>;
    readonly update: (input: {
      collection: string;
      id: string;
      data: JsonObject;
      mode?: "merge" | "replace";
      expectedVersion?: number;
      precondition?: ReadonlyArray<DocumentFilter>;
    }) => Promise<Document>;
    readonly delete: (input: {
      collection: string;
      id: string;
      expectedVersion?: number;
      precondition?: ReadonlyArray<DocumentFilter>;
    }) => Promise<boolean>;
  };
  readonly events: {
    readonly read: (input?: ReadDomainEventsInput) => Promise<ReadonlyArray<DomainEvent>>;
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
    readonly ingest: (series: string) => Promise<{ name: string; points: number }>;
  };
  readonly backups: {
    readonly exportTenant: () => Promise<TenantBackupV1>;
    readonly restoreTenant: (backup: TenantBackupV1) => Promise<{ events: number }>;
  };
  readonly systemViews: {
    readonly list: () => ReadonlyArray<SystemView>;
    readonly query: (input: QuerySystemViewInput) => Promise<SystemViewResult>;
  };
}

export interface DatabaseRuntimeApi {
  readonly forTenant: (tenant: TenantId) => TenantRuntimeApi;
  readonly shardOf: (tenant: TenantId) => string;
  readonly context: { readonly nodeId: string };
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
  documents: {
    createCollection: (input) => run(tenant.documents.createCollection(input)),
    createIndex: (input) => run(tenant.documents.createIndex(input)),
    dropIndex: (input) => run(tenant.documents.dropIndex(input)),
    addCheck: (input) => run(tenant.documents.addCheck(input)),
    dropCheck: (input) => run(tenant.documents.dropCheck(input)),
    addReference: (input) => run(tenant.documents.addReference(input)),
    dropReference: (input) => run(tenant.documents.dropReference(input)),
    listCollections: () => run(tenant.documents.listCollections),
    collectionExists: (name) => run(tenant.documents.collectionExists(name)),
    insert: (input) => run(tenant.documents.insert(input)),
    findById: (input) => run(tenant.documents.findById(input)),
    findMany: (input) => run(tenant.documents.findMany(input)),
    findPage: (input) => run(tenant.documents.findPage(input)),
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
    ingest: (series) => run(tenant.timeSeries.ingest(series)),
  },
  backups: {
    exportTenant: () => run(tenant.backups.exportTenant),
    restoreTenant: (backup) => run(tenant.backups.restoreTenant(backup)),
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
  context: { nodeId: options?.nodeId ?? "local" },
  topology: {
    shards: shardsOf(database.partitionMap),
    virtualRanges: database.partitionMap.virtualRanges,
    partitionMapVersion: database.partitionMap.version,
  },
});
