import type { DatabaseCollection, DatabaseDocument } from "../contracts/documents.js";
import type { DatabaseEvent, DatabaseEventPayload } from "../contracts/events.js";
import type { DatabaseJsonObject } from "../contracts/json.js";
import type { StoredCollectionSchema } from "../schema/index.js";
import type { DatabaseTimeSeriesPoint } from "../contracts/api.js";
export interface DocumentRow {
    id: string;
    tenant_id: string;
    collection_name: string;
    data_json: string;
    created_at: string;
    updated_at: string;
    version: number;
    schema_version: number;
}
export interface EventRow {
    sequence: number;
    event_id: string;
    idempotency_key: string | null;
    node_id: string;
    tenant_id: string;
    collection_name: string;
    document_id: string | null;
    type: string;
    revision: number;
    timestamp: string;
    schema_version: number;
    payload_json: string;
}
export interface CollectionRow {
    name: string;
    tenant_id: string;
    created_at: string;
    document_count: number;
    surface: string | null;
    metadata_json: string | null;
}
export interface SchemaRow {
    collection_name: string;
    version: number;
    fields_json: string;
    is_active: number;
}
export interface TimeSeriesPointRow {
    timestamp_ms: number;
    value: number;
    tags_json: string | null;
    fields_json: string | null;
}
export declare function toDocument<TData extends DatabaseJsonObject = DatabaseJsonObject>(row: DocumentRow): DatabaseDocument<TData>;
export declare function toEvent<TPayload extends DatabaseEventPayload = DatabaseEventPayload>(row: EventRow): DatabaseEvent<TPayload>;
export declare function toCollection(row: CollectionRow): DatabaseCollection;
export declare function toStoredSchema(row: SchemaRow): StoredCollectionSchema;
export declare function toTimeSeriesPoint(row: TimeSeriesPointRow): DatabaseTimeSeriesPoint;
