import type {
  DatabaseCollection,
  DatabaseDocument,
} from "../contracts/documents.js";
import type {
  DatabaseEvent,
  DatabaseEventPayload,
} from "../contracts/events.js";
import type { DatabaseJson, DatabaseJsonObject } from "../contracts/json.js";
import type { DatabaseStoredCollectionSchema } from "../contracts/schemas.js";
import type { DatabaseTimeSeriesPoint } from "../contracts/api.js";
import { parseOptionalJson, parseRequiredJson } from "./helpers.js";

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
  metadata_json: string | null;
}

export interface SchemaRow {
  collection_name: string;
  version: number;
  document_json: string;
  metadata_json: string | null;
  is_active: number;
}

export interface TimeSeriesPointRow {
  timestamp_ms: number;
  value: number;
  tags_json: string | null;
  fields_json: string | null;
}

export function toDocument<
  TData extends DatabaseJsonObject = DatabaseJsonObject,
>(row: DocumentRow): DatabaseDocument<TData> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    collection: row.collection_name,
    data: parseRequiredJson<TData>(row.data_json),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    version: row.version,
    schemaVersion: row.schema_version,
  };
}

export function toEvent<
  TPayload extends DatabaseEventPayload = DatabaseEventPayload,
>(row: EventRow): DatabaseEvent<TPayload> {
  return {
    sequence: row.sequence,
    eventId: row.event_id,
    idempotencyKey: row.idempotency_key ?? undefined,
    nodeId: row.node_id,
    tenantId: row.tenant_id,
    collection: row.collection_name,
    documentId: row.document_id ?? undefined,
    type: row.type as DatabaseEvent["type"],
    revision: row.revision,
    timestamp: row.timestamp,
    schemaVersion: row.schema_version,
    payload: parseRequiredJson<TPayload>(row.payload_json),
  };
}

export function toCollection(row: CollectionRow): DatabaseCollection {
  return {
    name: row.name,
    tenantId: row.tenant_id,
    createdAt: new Date(row.created_at),
    documentCount: row.document_count,
    metadata: parseOptionalJson<Record<string, unknown>>(row.metadata_json),
  };
}

export function toStoredSchema(row: SchemaRow): DatabaseStoredCollectionSchema {
  return {
    collection: row.collection_name,
    version: row.version,
    document: parseRequiredJson(row.document_json),
    metadata: parseOptionalJson<Record<string, unknown>>(row.metadata_json),
    active: Boolean(row.is_active),
  };
}

export function toTimeSeriesPoint(
  row: TimeSeriesPointRow,
): DatabaseTimeSeriesPoint {
  return {
    timestamp: new Date(row.timestamp_ms).toISOString(),
    value: row.value,
    tags: parseOptionalJson<Record<string, string>>(row.tags_json),
    fields: parseOptionalJson<Record<string, DatabaseJson>>(row.fields_json),
  };
}
