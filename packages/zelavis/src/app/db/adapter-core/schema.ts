/**
 * SQLite-flavored DDL applied by every Zelavis SQLite-compatible adapter
 * (better-sqlite3, bun:sqlite, libSQL).
 *
 * Restricted to features supported by all four dialects so each adapter
 * can apply the same statements without modification.
 */

export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS zv_collections (
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    document_count INTEGER NOT NULL DEFAULT 0,
    surface TEXT,
    metadata_json TEXT,
    PRIMARY KEY (tenant_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS zv_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    idempotency_key TEXT,
    node_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    collection_name TEXT NOT NULL,
    document_id TEXT,
    type TEXT NOT NULL,
    revision INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    payload_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS zv_schemas (
    collection_name TEXT NOT NULL,
    version INTEGER NOT NULL,
    fields_json TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (collection_name, version)
  )`,
  `CREATE TABLE IF NOT EXISTS zv_time_series_checkpoints (
    tenant_id TEXT NOT NULL,
    series_name TEXT NOT NULL,
    definition_version TEXT NOT NULL,
    last_sequence INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, series_name)
  )`,
  `CREATE TABLE IF NOT EXISTS zv_time_series_points (
    tenant_id TEXT NOT NULL,
    series_name TEXT NOT NULL,
    definition_version TEXT NOT NULL,
    source_sequence INTEGER NOT NULL,
    point_index INTEGER NOT NULL,
    timestamp_ms INTEGER NOT NULL,
    value REAL NOT NULL,
    tags_json TEXT,
    fields_json TEXT,
    PRIMARY KEY (
      tenant_id,
      series_name,
      definition_version,
      source_sequence,
      point_index
    )
  )`,
  `CREATE INDEX IF NOT EXISTS zv_events_tenant_sequence_idx
    ON zv_events (tenant_id, sequence)`,
  `CREATE INDEX IF NOT EXISTS zv_events_stream_idx
    ON zv_events (tenant_id, collection_name, document_id, sequence)`,
  `CREATE INDEX IF NOT EXISTS zv_schemas_collection_active_idx
    ON zv_schemas (collection_name, is_active, version)`,
  `CREATE INDEX IF NOT EXISTS zv_time_series_points_lookup_idx
    ON zv_time_series_points (
      tenant_id,
      series_name,
      definition_version,
      timestamp_ms,
      source_sequence,
      point_index
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS zv_events_tenant_idempotency_idx
    ON zv_events (tenant_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS zv_events_collection_revision_idx
    ON zv_events (tenant_id, collection_name, revision)
    WHERE document_id IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS zv_events_document_revision_idx
    ON zv_events (tenant_id, collection_name, document_id, revision)
    WHERE document_id IS NOT NULL`,
] as const;
