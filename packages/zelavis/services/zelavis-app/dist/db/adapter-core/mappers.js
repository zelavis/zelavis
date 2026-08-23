import { parseOptionalJson, parseRequiredJson } from "./helpers.js";
export function toDocument(row) {
    return {
        id: row.id,
        tenantId: row.tenant_id,
        collection: row.collection_name,
        data: parseRequiredJson(row.data_json),
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
        version: row.version,
        schemaVersion: row.schema_version,
    };
}
export function toEvent(row) {
    return {
        sequence: row.sequence,
        eventId: row.event_id,
        idempotencyKey: row.idempotency_key ?? undefined,
        nodeId: row.node_id,
        tenantId: row.tenant_id,
        collection: row.collection_name,
        documentId: row.document_id ?? undefined,
        type: row.type,
        revision: row.revision,
        timestamp: row.timestamp,
        schemaVersion: row.schema_version,
        payload: parseRequiredJson(row.payload_json),
    };
}
const VALID_SURFACES = new Set([
    "content-studio",
    "database",
]);
function parseSurface(value) {
    return typeof value === "string" && VALID_SURFACES.has(value)
        ? value
        : undefined;
}
export function toCollection(row) {
    const metadata = parseOptionalJson(row.metadata_json);
    return {
        name: row.name,
        tenantId: row.tenant_id,
        createdAt: new Date(row.created_at),
        documentCount: row.document_count,
        surface: parseSurface(row.surface),
        metadata,
    };
}
export function toStoredSchema(row) {
    return {
        collection: row.collection_name,
        version: row.version,
        fields: parseRequiredJson(row.fields_json),
        active: Boolean(row.is_active),
    };
}
export function toTimeSeriesPoint(row) {
    return {
        timestamp: new Date(row.timestamp_ms).toISOString(),
        value: row.value,
        tags: parseOptionalJson(row.tags_json),
        fields: parseOptionalJson(row.fields_json),
    };
}
