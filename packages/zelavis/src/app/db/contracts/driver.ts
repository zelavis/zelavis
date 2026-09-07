import type {
  DatabaseCollection,
  DatabaseDocument,
  FindDocumentByIdInput,
  FindDocumentsInput,
  ListCollectionsInput,
} from "./documents.js";
import type {
  DatabaseTimeSeriesAggregateInput,
  DatabaseTimeSeriesDefinitionVersion,
  DatabaseTimeSeriesPoint,
  DatabaseTimeSeriesRangeInput,
} from "./api.js";
import type {
  DatabaseAppendEventInput,
  DatabaseEvent,
  DatabaseEventPayload,
  ReadDatabaseEventsInput,
} from "./events.js";
import type { StoredCollectionSchema } from "../../../dbnew/schema/index.js";

type TenantScoped<TInput> = Omit<
  TInput,
  "tenantId"
> & {
  tenantId: string;
};

export interface DatabaseCapabilities {
  /**
   * The driver enforces a durable writer fence, so a superseded writer is
   * rejected by the shard itself rather than trusted to stand down.
   */
  writerFencing?: boolean;
  documents: true;
  events: true;
  transactions: boolean;
  tenantRouting: boolean;
}

export interface DatabaseProjectionDriver {
  getCollection(
    input: TenantScoped<ListCollectionsInput> & { name: string },
  ): Promise<DatabaseCollection | null>;
  listCollections(
    input: TenantScoped<ListCollectionsInput>,
  ): Promise<DatabaseCollection[]>;
  collectionExists(
    input: TenantScoped<ListCollectionsInput> & { name: string },
  ): Promise<boolean>;
  findDocumentById(
    input: TenantScoped<FindDocumentByIdInput>,
  ): Promise<DatabaseDocument | null>;
  findDocuments(
    input: TenantScoped<FindDocumentsInput> & {
      where: NonNullable<FindDocumentsInput["where"]>;
      orderBy: NonNullable<FindDocumentsInput["orderBy"]>;
      limit: number;
      offset: number;
    },
  ): Promise<DatabaseDocument[]>;
}

export interface DatabaseEventDriver {
  append<TPayload extends DatabaseEventPayload>(
    input: TenantScoped<DatabaseAppendEventInput<TPayload>>,
  ): Promise<DatabaseEvent<TPayload>>;
  /** Adapter-only exact event restoration. Never expose through the App API. */
  restore?<TPayload extends DatabaseEventPayload>(
    input: TenantScoped<DatabaseAppendEventInput<TPayload>> & {
      eventId: string;
      revision: number;
      timestamp: string;
    },
  ): Promise<DatabaseEvent<TPayload>>;
  read(input: TenantScoped<ReadDatabaseEventsInput>): Promise<DatabaseEvent[]>;
}

export interface DatabaseSchemaStorageDriver {
  list(): Promise<StoredCollectionSchema[]>;
  save(schema: StoredCollectionSchema): Promise<void>;
  activate(collection: string, version: number): Promise<void>;
}

export interface DatabaseTimeSeriesStorageState {
  lastSequence: number;
  version: string;
}

export interface DatabaseTimeSeriesStoredPoint {
  sourceSequence: number;
  pointIndex: number;
  point: DatabaseTimeSeriesPoint;
}

export interface DatabaseTimeSeriesStorageStateInput {
  tenantId: string;
  series: string;
}

export interface DatabaseTimeSeriesStorageResetInput extends DatabaseTimeSeriesStorageStateInput {
  version: DatabaseTimeSeriesDefinitionVersion;
}

export interface DatabaseTimeSeriesStorageAppendInput extends DatabaseTimeSeriesStorageResetInput {
  lastSequence: number;
  points: readonly DatabaseTimeSeriesStoredPoint[];
}

export interface DatabaseTimeSeriesStoredRangeInput
  extends DatabaseTimeSeriesStorageResetInput, DatabaseTimeSeriesRangeInput {}

export interface DatabaseTimeSeriesStoredAggregateInput
  extends
    DatabaseTimeSeriesStorageResetInput,
    DatabaseTimeSeriesAggregateInput {}

export interface DatabaseTimeSeriesStorageDriver {
  getState(
    input: DatabaseTimeSeriesStorageStateInput,
  ): Promise<DatabaseTimeSeriesStorageState | null>;
  reset(input: DatabaseTimeSeriesStorageResetInput): Promise<void>;
  append(input: DatabaseTimeSeriesStorageAppendInput): Promise<void>;
  range(
    input: DatabaseTimeSeriesStoredRangeInput,
  ): Promise<DatabaseTimeSeriesPoint[]>;
  aggregate(input: DatabaseTimeSeriesStoredAggregateInput): Promise<number>;
}

export interface DatabaseDriver {
  /**
   * Claims this shard for a writer generation.
   *
   * Advances the durable fence on takeover, accepts a re-claim of the same
   * generation so a restart does not need a new one, and refuses a generation
   * older than the one that currently owns the shard. Optional: a driver
   * without it is unfenced, which is the single-process local default.
   */
  claimWriterGeneration?(generation: number): Promise<void>;
  name: string;
  capabilities: DatabaseCapabilities;
  events: DatabaseEventDriver;
  projections: DatabaseProjectionDriver;
  schemas?: DatabaseSchemaStorageDriver;
  timeseries?: DatabaseTimeSeriesStorageDriver;
}
