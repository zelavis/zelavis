import type { DatabaseCollection, DatabaseDocument, FindDocumentByIdInput, FindDocumentsInput, ListCollectionsInput } from "./documents.js";
import type { DatabaseTimeSeriesAggregateInput, DatabaseTimeSeriesDefinitionVersion, DatabaseTimeSeriesPoint, DatabaseTimeSeriesRangeInput } from "./api.js";
import type { DatabaseAppendEventInput, DatabaseEvent, DatabaseEventPayload, ReadDatabaseEventsInput } from "./events.js";
import type { StoredCollectionSchema } from "../schema/index.js";
import type { SqlDatabase } from "./sql.js";
type TenantScoped<TInput extends {
    tenantId?: string;
}> = Omit<TInput, "tenantId"> & {
    tenantId: string;
};
export interface DatabaseCapabilities {
    documents: true;
    events: true;
    sql: boolean;
    transactions: boolean;
    tenantRouting: boolean;
}
export interface DatabaseProjectionDriver {
    getCollection(input: TenantScoped<ListCollectionsInput> & {
        name: string;
    }): Promise<DatabaseCollection | null>;
    listCollections(input: TenantScoped<ListCollectionsInput>): Promise<DatabaseCollection[]>;
    collectionExists(input: TenantScoped<ListCollectionsInput> & {
        name: string;
    }): Promise<boolean>;
    findDocumentById(input: TenantScoped<FindDocumentByIdInput>): Promise<DatabaseDocument | null>;
    findDocuments(input: TenantScoped<FindDocumentsInput> & {
        where: NonNullable<FindDocumentsInput["where"]>;
        orderBy: NonNullable<FindDocumentsInput["orderBy"]>;
        limit: number;
        offset: number;
    }): Promise<DatabaseDocument[]>;
}
export interface DatabaseEventDriver {
    append<TPayload extends DatabaseEventPayload>(input: TenantScoped<DatabaseAppendEventInput<TPayload>>): Promise<DatabaseEvent<TPayload>>;
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
export interface DatabaseTimeSeriesStoredRangeInput extends DatabaseTimeSeriesStorageResetInput, DatabaseTimeSeriesRangeInput {
}
export interface DatabaseTimeSeriesStoredAggregateInput extends DatabaseTimeSeriesStorageResetInput, DatabaseTimeSeriesAggregateInput {
}
export interface DatabaseTimeSeriesStorageDriver {
    getState(input: DatabaseTimeSeriesStorageStateInput): Promise<DatabaseTimeSeriesStorageState | null>;
    reset(input: DatabaseTimeSeriesStorageResetInput): Promise<void>;
    append(input: DatabaseTimeSeriesStorageAppendInput): Promise<void>;
    range(input: DatabaseTimeSeriesStoredRangeInput): Promise<DatabaseTimeSeriesPoint[]>;
    aggregate(input: DatabaseTimeSeriesStoredAggregateInput): Promise<number>;
}
export interface DatabaseDriver {
    name: string;
    capabilities: DatabaseCapabilities;
    events: DatabaseEventDriver;
    projections: DatabaseProjectionDriver;
    schemas?: DatabaseSchemaStorageDriver;
    timeseries?: DatabaseTimeSeriesStorageDriver;
    sql?: SqlDatabase;
}
export {};
