import type {
  DatabaseCollection,
  DatabaseCollectionSurface,
  DatabaseDocument,
} from "../contracts/documents.js";
import type {
  DatabaseEvent,
  DatabaseEventPayload,
} from "../contracts/events.js";
import { encodeDatabaseEventCursor } from "../contracts/events.js";
import type { DatabaseJson, DatabaseJsonObject } from "../contracts/json.js";
import type { StoredCollectionSchema } from "../../../dbnew/schema/index.js";
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
    cursor: encodeDatabaseEventCursor(row.sequence),
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

const VALID_SURFACES = new Set<DatabaseCollectionSurface>([
  "content-studio",
  "database",
]);

function parseSurface(value: string | null): DatabaseCollectionSurface | undefined {
  return typeof value === "string" && VALID_SURFACES.has(value as DatabaseCollectionSurface)
    ? (value as DatabaseCollectionSurface)
    : undefined;
}

export function toCollection(row: CollectionRow): DatabaseCollection {
  const metadata = parseOptionalJson<Record<string, unknown>>(row.metadata_json);
  return {
    name: row.name,
    tenantId: row.tenant_id,
    createdAt: new Date(row.created_at),
    documentCount: row.document_count,
    surface: parseSurface(row.surface),
    metadata,
  };
}

export function toStoredSchema(row: SchemaRow): StoredCollectionSchema {
  return {
    collection: row.collection_name,
    version: row.version,
    fields: parseRequiredJson(row.fields_json),
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
