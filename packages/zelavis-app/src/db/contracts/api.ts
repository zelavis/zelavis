import type {
  CreateCollectionInput,
  DatabaseCollection,
  DatabaseDocument,
  DeleteDocumentInput,
  FindDocumentByIdInput,
  FindDocumentsInput,
  InsertDocumentInput,
  ListCollectionsInput,
  UpdateDocumentInput,
} from "./documents.js";
import type {
  DatabaseAppendEventInput,
  DatabaseEvent,
  DatabaseEventPayload,
  ReadDatabaseEventsInput,
} from "./events.js";
import type { DatabaseJson, DatabaseJsonObject } from "./json.js";
import type {
  CollectionSchema,
  CollectionSchemaSummary,
  SchemaValidationResult,
  StoredCollectionSchema,
} from "../schema/index.js";

export interface DatabaseContext {
  config: Record<string, unknown>;
  defaultTenantId: string;
  defaultNodeId: string;
}

export interface DatabaseEventsApi {
  append<TPayload extends DatabaseEventPayload>(
    input: DatabaseAppendEventInput<TPayload>,
  ): Promise<DatabaseEvent<TPayload>>;
  read(input?: ReadDatabaseEventsInput): Promise<DatabaseEvent[]>;
}

export interface DatabaseDocumentsApi {
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

export interface DatabaseSchemasApi {
  save(schema: CollectionSchema): Promise<StoredCollectionSchema>;
  listCollections(): CollectionSchemaSummary[];
  listVersions(collection: string): StoredCollectionSchema[];
  getVersion(collection: string, version: number): StoredCollectionSchema | null;
  getActive(collection: string): StoredCollectionSchema | null;
  activate(collection: string, version: number): Promise<StoredCollectionSchema>;
  validate(collection: string, data: DatabaseJsonObject): SchemaValidationResult;
}

export interface DatabaseProjectionSummary {
  name: string;
  builtin: boolean;
  description?: string;
  sourceCollections?: readonly string[];
  sourceEventTypes?: readonly string[];
}

export interface DatabaseProjectionSource {
  collections?: readonly string[];
  eventTypes?: readonly string[];
}

export interface DatabaseProjectionApplyContext {
  mode: "live" | "rebuild";
}

export interface DatabaseProjectionDefinition {
  name: string;
  description?: string;
  source?: DatabaseProjectionSource;
  apply?: (
    event: DatabaseEvent,
    context: DatabaseProjectionApplyContext,
  ) => Promise<void> | void;
}

export interface DatabaseProjectionRebuildInput {
  names?: readonly string[];
  collections?: readonly string[];
}

export interface DatabaseProjectionRebuildResult {
  rebuilt: string[];
}

export interface DatabaseProjectionsApi {
  register(definition: DatabaseProjectionDefinition): Promise<void>;
  list(): Promise<DatabaseProjectionSummary[]>;
  rebuild(
    input?: DatabaseProjectionRebuildInput,
  ): Promise<DatabaseProjectionRebuildResult>;
}

export type DatabaseTimeSeriesAggregateOperation =
  | "avg"
  | "sum"
  | "min"
  | "max"
  | "count";

export interface DatabaseTimeSeriesPoint {
  timestamp: number | string | Date;
  value: number;
  tags?: Record<string, string>;
  fields?: Record<string, DatabaseJson>;
}

export interface DatabaseTimeSeriesMapperContext {
  series: string;
}

export type DatabaseTimeSeriesDefinitionVersion = string | number;

export type DatabaseTimeSeriesMapper = (
  event: DatabaseEvent,
  context: DatabaseTimeSeriesMapperContext,
) =>
  | DatabaseTimeSeriesPoint
  | readonly DatabaseTimeSeriesPoint[]
  | null
  | undefined;

export interface DatabaseTimeSeriesRangeInput {
  start?: number | string | Date;
  end?: number | string | Date;
  limit?: number;
  order?: "asc" | "desc";
}

export interface DatabaseTimeSeriesAggregateInput {
  op: DatabaseTimeSeriesAggregateOperation;
  start?: number | string | Date;
  end?: number | string | Date;
}

export interface DatabaseTimeSeriesHandle {
  range(
    input?: DatabaseTimeSeriesRangeInput,
  ): Promise<DatabaseTimeSeriesPoint[]>;
  aggregate(input: DatabaseTimeSeriesAggregateInput): Promise<number>;
}

export interface DatabaseTimeSeriesSummary {
  name: string;
  description?: string;
  version?: DatabaseTimeSeriesDefinitionVersion;
  projection?: string;
}

export interface DatabaseTimeSeriesDefinition {
  name: string;
  description?: string;
  version?: DatabaseTimeSeriesDefinitionVersion;
  source?: DatabaseProjectionSource;
  projection?: string;
  map?: DatabaseTimeSeriesMapper;
}

export interface DatabaseTimeSeriesApi {
  define(definition: DatabaseTimeSeriesDefinition): Promise<void>;
  list(): Promise<DatabaseTimeSeriesSummary[]>;
  get(name: string): DatabaseTimeSeriesHandle;
}
