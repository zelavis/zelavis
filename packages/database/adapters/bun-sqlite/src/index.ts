import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import {
  createDatabase,
  defineDatabaseDriver,
  type CreateDatabaseOptions,
  type DatabaseCollection,
  type DatabaseCollectionSchema,
  type DatabaseDocument,
  type DatabaseDocumentFilter,
  type DatabaseDocumentSort,
  type DatabaseDriver,
  type DatabaseEvent,
  type DatabaseEventPayload,
  type DatabaseJson,
  type DatabaseJsonObject,
  type DatabaseTimeSeriesPoint,
  type DatabaseTimeSeriesStorageAppendInput,
  type DatabaseTimeSeriesStorageDriver,
  type DatabaseTimeSeriesStorageResetInput,
  type DatabaseTimeSeriesStorageStateInput,
  type DatabaseTimeSeriesStoredAggregateInput,
  type DatabaseTimeSeriesStoredRangeInput,
  type DatabaseStoredCollectionSchema,
  type FindDocumentsInput,
  type ListCollectionsInput,
  type ReadDatabaseEventsInput,
  type SqlDatabase,
  type SqlExecuteInput,
  type SqlExecuteResult,
  type SqlParameter,
  type SqlQueryInput,
  type SqlQueryResult,
  DatabaseConflictError,
  DatabaseEventIdempotencyConflictError,
  DatabaseNotFoundError,
  DatabaseRevisionMismatchError,
} from "@zelavis/database";

type BunSqliteDatabase = Database;

type TenantScoped<TInput extends { tenantId?: string }> = Omit<
  TInput,
  "tenantId"
> & {
  tenantId: string;
};

export interface BunSqliteDriverOptions {
  filename: string;
  readonly?: boolean;
  create?: boolean;
  readwrite?: boolean;
  safeIntegers?: boolean;
  strict?: boolean;
  defaultTenantId?: string;
  pragma?: readonly string[];
}

export interface BunSqliteDatabaseOptions
  extends
    Omit<CreateDatabaseOptions, "driver" | "defaultTenantId">,
    BunSqliteDriverOptions {}

function normalizeFilename(filename: string): string {
  if (filename === ":memory:") {
    return filename;
  }

  return resolve(filename);
}

function ensureParentDirectory(filename: string): void {
  if (filename === ":memory:") {
    return;
  }

  mkdirSync(dirname(filename), { recursive: true });
}

function cloneJson<T extends DatabaseJson>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneRecord<T extends Record<string, unknown>>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseOptionalJson<T>(value: string | null | undefined): T | undefined {
  if (!value) {
    return undefined;
  }

  return JSON.parse(value) as T;
}

function parseRequiredJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function generateId(prefix = "doc"): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  }

  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function readPath(
  data: DatabaseJsonObject,
  path: string,
): DatabaseJson | undefined {
  const parts = path
    .replace(/^\$\.?/, "")
    .split(".")
    .filter(Boolean);
  let current: unknown = data;

  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return current as DatabaseJson | undefined;
}

function compareValues(
  left: DatabaseJson | undefined,
  right: DatabaseJson | undefined,
): number {
  if (left === right) {
    return 0;
  }

  if (left === undefined) {
    return -1;
  }

  if (right === undefined) {
    return 1;
  }

  if (typeof left === "number" && typeof right === "number") {
    return left < right ? -1 : 1;
  }

  const leftText = JSON.stringify(left);
  const rightText = JSON.stringify(right);
  return leftText < rightText ? -1 : 1;
}

function matchesFilter(
  document: DatabaseDocument,
  filter: DatabaseDocumentFilter,
): boolean {
  const op = filter.op ?? "eq";
  const actual = readPath(document.data, filter.path);

  if (op === "in") {
    return (
      Array.isArray(filter.value) &&
      filter.value.some(
        (item: DatabaseJson) => compareValues(actual, item) === 0,
      )
    );
  }

  if (Array.isArray(filter.value)) {
    return false;
  }

  const comparison = compareValues(actual, filter.value);

  if (op === "eq") return comparison === 0;
  if (op === "ne") return comparison !== 0;
  if (op === "gt") return comparison > 0;
  if (op === "gte") return comparison >= 0;
  if (op === "lt") return comparison < 0;
  if (op === "lte") return comparison <= 0;

  return false;
}

function sortDocuments(
  documents: DatabaseDocument[],
  orderBy: readonly DatabaseDocumentSort[],
): DatabaseDocument[] {
  if (orderBy.length === 0) {
    return documents;
  }

  return [...documents].sort((left, right) => {
    for (const order of orderBy) {
      const direction = order.direction ?? "asc";
      const result = compareValues(
        readPath(left.data, order.path),
        readPath(right.data, order.path),
      );
      if (result !== 0) {
        return direction === "asc" ? result : -result;
      }
    }

    return 0;
  });
}

function toDocument<
  TData extends DatabaseJsonObject = DatabaseJsonObject,
>(row: {
  id: string;
  tenant_id: string;
  collection_name: string;
  data_json: string;
  created_at: string;
  updated_at: string;
  version: number;
  schema_version: number;
}): DatabaseDocument<TData> {
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

function toEvent<
  TPayload extends DatabaseEventPayload = DatabaseEventPayload,
>(row: {
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
}): DatabaseEvent<TPayload> {
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

function toCollection(row: {
  name: string;
  tenant_id: string;
  created_at: string;
  document_count: number;
  metadata_json: string | null;
}): DatabaseCollection {
  return {
    name: row.name,
    tenantId: row.tenant_id,
    createdAt: new Date(row.created_at),
    documentCount: row.document_count,
    metadata: parseOptionalJson<Record<string, unknown>>(row.metadata_json),
  };
}

function toStoredSchema(row: {
  collection_name: string;
  version: number;
  document_json: string;
  metadata_json: string | null;
  is_active: number;
}): DatabaseStoredCollectionSchema {
  return {
    collection: row.collection_name,
    version: row.version,
    document: parseRequiredJson(row.document_json),
    metadata: parseOptionalJson<Record<string, unknown>>(row.metadata_json),
    active: row.is_active === 1,
  };
}

function toTimestampMs(value: number | string | Date): number {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "number") {
    return value;
  }

  return Date.parse(value);
}

function toTimeSeriesPoint(row: {
  timestamp_ms: number;
  value: number;
  tags_json: string | null;
  fields_json: string | null;
}): DatabaseTimeSeriesPoint {
  return {
    timestamp: new Date(row.timestamp_ms).toISOString(),
    value: row.value,
    tags: parseOptionalJson<Record<string, string>>(row.tags_json),
    fields: parseOptionalJson<Record<string, DatabaseJson>>(row.fields_json),
  };
}

function toSqlParameter(parameter: SqlParameter): unknown {
  return parameter;
}

function fromSqlValue(value: unknown): DatabaseJson | Uint8Array {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  return value as DatabaseJson;
}

function applyPragmas(
  database: BunSqliteDatabase,
  options: BunSqliteDriverOptions,
): void {
  const pragmas = options.pragma ?? ["journal_mode = WAL", "foreign_keys = ON"];

  for (const pragma of pragmas) {
    database.run(`PRAGMA ${pragma}`);
  }
}

function createSqlApi(database: BunSqliteDatabase): SqlDatabase {
  return {
    async query(input: SqlQueryInput): Promise<SqlQueryResult> {
      const statement = database.prepare<Record<string, unknown>, unknown>(
        input.statement,
      );
      const rows = statement.all(
        ...(input.parameters ?? []).map(toSqlParameter),
      ) as Record<string, unknown>[];

      return {
        rows: rows.map((row: Record<string, unknown>) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              fromSqlValue(value),
            ]),
          ),
        ),
      };
    },

    async execute(input: SqlExecuteInput): Promise<SqlExecuteResult> {
      const statement = database.prepare(input.statement);
      const result = statement.run(
        ...(input.parameters ?? []).map(toSqlParameter),
      );

      return {
        rowsAffected: result.changes,
        lastInsertId:
          typeof result.lastInsertRowid === "bigint"
            ? Number(result.lastInsertRowid)
            : result.lastInsertRowid,
      };
    },
  };
}

function createSchema(database: BunSqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS collections (
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      document_count INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT,
      PRIMARY KEY (tenant_id, name)
    );

    CREATE TABLE IF NOT EXISTS documents (
      tenant_id TEXT NOT NULL,
      collection_name TEXT NOT NULL,
      id TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (tenant_id, collection_name, id),
      FOREIGN KEY (tenant_id, collection_name)
        REFERENCES collections (tenant_id, name)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS events (
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
    );

    CREATE TABLE IF NOT EXISTS schemas (
      collection_name TEXT NOT NULL,
      version INTEGER NOT NULL,
      document_json TEXT NOT NULL,
      metadata_json TEXT,
      is_active INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (collection_name, version)
    );

    CREATE TABLE IF NOT EXISTS time_series_checkpoints (
      tenant_id TEXT NOT NULL,
      series_name TEXT NOT NULL,
      definition_version TEXT NOT NULL,
      last_sequence INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, series_name)
    );

    CREATE TABLE IF NOT EXISTS time_series_points (
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
    );

    CREATE INDEX IF NOT EXISTS documents_lookup_idx
      ON documents (tenant_id, collection_name, updated_at, id);

    CREATE INDEX IF NOT EXISTS events_tenant_sequence_idx
      ON events (tenant_id, sequence);

    CREATE INDEX IF NOT EXISTS events_stream_idx
      ON events (tenant_id, collection_name, document_id, sequence);

    CREATE INDEX IF NOT EXISTS schemas_collection_active_idx
      ON schemas (collection_name, is_active, version);

    CREATE INDEX IF NOT EXISTS time_series_points_lookup_idx
      ON time_series_points (
        tenant_id,
        series_name,
        definition_version,
        timestamp_ms,
        source_sequence,
        point_index
      );
  `);

  const eventColumns = database
    .prepare(`PRAGMA table_info(events)`)
    .all() as Array<{ name: string }>;

  if (!eventColumns.some((column) => column.name === "idempotency_key")) {
    throw new Error(
      "Outdated SQLite schema detected for the events table. Delete the existing database file and recreate it with the current Zelavis schema.",
    );
  }

  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS events_tenant_idempotency_idx
      ON events (tenant_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `);
}

function payloadText(value: unknown): string {
  return JSON.stringify(value);
}

function matchesIdempotentAppend<TPayload extends DatabaseEventPayload>(
  event: DatabaseEvent<TPayload>,
  input: {
    collection: string;
    documentId?: string;
    type: DatabaseEvent["type"];
    expectedRevision?: number | null;
    schemaVersion?: number;
    payload: TPayload;
  },
): boolean {
  return (
    event.collection === input.collection &&
    event.documentId === input.documentId &&
    event.type === input.type &&
    event.revision - 1 === (input.expectedRevision ?? event.revision - 1) &&
    event.schemaVersion === (input.schemaVersion ?? 1) &&
    payloadText(event.payload) === payloadText(input.payload)
  );
}

export function createBunSqliteDatabaseDriver(
  options: BunSqliteDriverOptions,
): DatabaseDriver {
  const filename = normalizeFilename(options.filename);
  ensureParentDirectory(filename);

  const database = new Database(filename, {
    ...(options.readonly === undefined ? {} : { readonly: options.readonly }),
    ...(options.create === undefined
      ? { create: options.readonly ? false : true }
      : { create: options.create }),
    ...(options.readwrite === undefined
      ? {}
      : { readwrite: options.readwrite }),
    ...(options.safeIntegers === undefined
      ? {}
      : { safeIntegers: options.safeIntegers }),
    ...(options.strict === undefined ? {} : { strict: options.strict }),
  });

  applyPragmas(database, options);
  createSchema(database);

  const createCollectionStatement = database.prepare(`
    INSERT INTO collections (
      tenant_id,
      name,
      created_at,
      document_count,
      metadata_json
    ) VALUES (?, ?, ?, 0, ?)
  `);
  const listCollectionsStatement = database.prepare(`
    SELECT tenant_id, name, created_at, document_count, metadata_json
    FROM collections
    WHERE tenant_id = ?
    ORDER BY name ASC
  `);
  const collectionExistsStatement = database.prepare(`
    SELECT 1
    FROM collections
    WHERE tenant_id = ? AND name = ?
    LIMIT 1
  `);
  const findCollectionStatement = database.prepare(`
    SELECT tenant_id, name, created_at, document_count, metadata_json
    FROM collections
    WHERE tenant_id = ? AND name = ?
    LIMIT 1
  `);
  const insertEventStatement = database.prepare(`
    INSERT INTO events (
      event_id,
      idempotency_key,
      node_id,
      tenant_id,
      collection_name,
      document_id,
      type,
      revision,
      timestamp,
      schema_version,
      payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const findEventByIdempotencyKeyStatement = database.prepare(`
    SELECT sequence, event_id, idempotency_key, node_id, tenant_id, collection_name, document_id, type, revision, timestamp, schema_version, payload_json
    FROM events
    WHERE tenant_id = ? AND idempotency_key = ?
    LIMIT 1
  `);
  const latestCollectionRevisionStatement = database.prepare(`
    SELECT revision
    FROM events
    WHERE tenant_id = ? AND collection_name = ? AND document_id IS NULL
    ORDER BY sequence DESC
    LIMIT 1
  `);
  const latestDocumentRevisionStatement = database.prepare(`
    SELECT revision
    FROM events
    WHERE tenant_id = ? AND collection_name = ? AND document_id = ?
    ORDER BY sequence DESC
    LIMIT 1
  `);
  const readEventsStatement = database.prepare(`
    SELECT sequence, event_id, idempotency_key, node_id, tenant_id, collection_name, document_id, type, revision, timestamp, schema_version, payload_json
    FROM events
    WHERE tenant_id = ?
      AND (? IS NULL OR collection_name = ?)
      AND (? IS NULL OR document_id = ?)
      AND sequence > ?
    ORDER BY sequence ASC
    LIMIT ?
  `);
  const lastSequenceStatement = database.prepare(`
    SELECT last_insert_rowid() AS sequence
  `);
  const insertDocumentStatement = database.prepare(`
    INSERT INTO documents (
      tenant_id,
      collection_name,
      id,
      data_json,
      created_at,
      updated_at,
      version,
      schema_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const incrementCollectionCountStatement = database.prepare(`
    UPDATE collections
    SET document_count = document_count + 1
    WHERE tenant_id = ? AND name = ?
  `);
  const decrementCollectionCountStatement = database.prepare(`
    UPDATE collections
    SET document_count = document_count - 1
    WHERE tenant_id = ? AND name = ? AND document_count > 0
  `);
  const findDocumentStatement = database.prepare(`
    SELECT tenant_id, collection_name, id, data_json, created_at, updated_at, version, schema_version
    FROM documents
    WHERE tenant_id = ? AND collection_name = ? AND id = ?
    LIMIT 1
  `);
  const listDocumentsStatement = database.prepare(`
    SELECT tenant_id, collection_name, id, data_json, created_at, updated_at, version, schema_version
    FROM documents
    WHERE tenant_id = ? AND collection_name = ?
  `);
  const updateDocumentStatement = database.prepare(`
    UPDATE documents
    SET data_json = ?, updated_at = ?, version = ?, schema_version = ?
    WHERE tenant_id = ? AND collection_name = ? AND id = ?
  `);
  const deleteDocumentStatement = database.prepare(`
    DELETE FROM documents
    WHERE tenant_id = ? AND collection_name = ? AND id = ?
  `);
  const listSchemasStatement = database.prepare(`
    SELECT collection_name, version, document_json, metadata_json, is_active
    FROM schemas
    ORDER BY collection_name ASC, version ASC
  `);
  const saveSchemaStatement = database.prepare(`
    INSERT INTO schemas (
      collection_name,
      version,
      document_json,
      metadata_json,
      is_active
    ) VALUES (?, ?, ?, ?, COALESCE((SELECT is_active FROM schemas WHERE collection_name = ? AND version = ?), 0))
    ON CONFLICT(collection_name, version)
    DO UPDATE SET
      document_json = excluded.document_json,
      metadata_json = excluded.metadata_json
  `);
  const resetActiveSchemasStatement = database.prepare(`
    UPDATE schemas
    SET is_active = 0
    WHERE collection_name = ?
  `);
  const activateSchemaStatement = database.prepare(`
    UPDATE schemas
    SET is_active = 1
    WHERE collection_name = ? AND version = ?
  `);
  const getTimeSeriesStateStatement = database.prepare(`
    SELECT definition_version, last_sequence
    FROM time_series_checkpoints
    WHERE tenant_id = ? AND series_name = ?
    LIMIT 1
  `);
  const resetTimeSeriesPointsStatement = database.prepare(`
    DELETE FROM time_series_points
    WHERE tenant_id = ? AND series_name = ?
  `);
  const upsertTimeSeriesCheckpointStatement = database.prepare(`
    INSERT INTO time_series_checkpoints (
      tenant_id,
      series_name,
      definition_version,
      last_sequence,
      updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, series_name)
    DO UPDATE SET
      definition_version = excluded.definition_version,
      last_sequence = excluded.last_sequence,
      updated_at = excluded.updated_at
  `);
  const insertTimeSeriesPointStatement = database.prepare(`
    INSERT INTO time_series_points (
      tenant_id,
      series_name,
      definition_version,
      source_sequence,
      point_index,
      timestamp_ms,
      value,
      tags_json,
      fields_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(
      tenant_id,
      series_name,
      definition_version,
      source_sequence,
      point_index
    ) DO UPDATE SET
      timestamp_ms = excluded.timestamp_ms,
      value = excluded.value,
      tags_json = excluded.tags_json,
      fields_json = excluded.fields_json
  `);
  const readTimeSeriesRangeAscStatement = database.prepare(`
    SELECT timestamp_ms, value, tags_json, fields_json
    FROM time_series_points
    WHERE tenant_id = ?
      AND series_name = ?
      AND definition_version = ?
      AND (? IS NULL OR timestamp_ms >= ?)
      AND (? IS NULL OR timestamp_ms <= ?)
    ORDER BY timestamp_ms ASC, source_sequence ASC, point_index ASC
    LIMIT ?
  `);
  const readTimeSeriesRangeDescStatement = database.prepare(`
    SELECT timestamp_ms, value, tags_json, fields_json
    FROM time_series_points
    WHERE tenant_id = ?
      AND series_name = ?
      AND definition_version = ?
      AND (? IS NULL OR timestamp_ms >= ?)
      AND (? IS NULL OR timestamp_ms <= ?)
    ORDER BY timestamp_ms DESC, source_sequence DESC, point_index DESC
    LIMIT ?
  `);
  const aggregateTimeSeriesStatements = {
    avg: database.prepare(`
      SELECT AVG(value) AS value
      FROM time_series_points
      WHERE tenant_id = ?
        AND series_name = ?
        AND definition_version = ?
        AND (? IS NULL OR timestamp_ms >= ?)
        AND (? IS NULL OR timestamp_ms <= ?)
    `),
    sum: database.prepare(`
      SELECT SUM(value) AS value
      FROM time_series_points
      WHERE tenant_id = ?
        AND series_name = ?
        AND definition_version = ?
        AND (? IS NULL OR timestamp_ms >= ?)
        AND (? IS NULL OR timestamp_ms <= ?)
    `),
    min: database.prepare(`
      SELECT MIN(value) AS value
      FROM time_series_points
      WHERE tenant_id = ?
        AND series_name = ?
        AND definition_version = ?
        AND (? IS NULL OR timestamp_ms >= ?)
        AND (? IS NULL OR timestamp_ms <= ?)
    `),
    max: database.prepare(`
      SELECT MAX(value) AS value
      FROM time_series_points
      WHERE tenant_id = ?
        AND series_name = ?
        AND definition_version = ?
        AND (? IS NULL OR timestamp_ms >= ?)
        AND (? IS NULL OR timestamp_ms <= ?)
    `),
    count: database.prepare(`
      SELECT COUNT(*) AS value
      FROM time_series_points
      WHERE tenant_id = ?
        AND series_name = ?
        AND definition_version = ?
        AND (? IS NULL OR timestamp_ms >= ?)
        AND (? IS NULL OR timestamp_ms <= ?)
    `),
  };

  const appendCollectionCreatedTransaction = database.transaction(
    (
      eventId: string,
      idempotencyKey: string | null,
      nodeId: string,
      tenantId: string,
      collection: string,
      timestamp: string,
      schemaVersion: number,
      payloadJson: string,
    ) => {
      createCollectionStatement.run(
        tenantId,
        collection,
        timestamp,
        payloadJson,
      );
      insertEventStatement.run(
        eventId,
        idempotencyKey,
        nodeId,
        tenantId,
        collection,
        null,
        "collection.created",
        1,
        timestamp,
        schemaVersion,
        payloadJson,
      );
    },
  );

  const appendDocumentUpsertedTransaction = database.transaction(
    (
      eventId: string,
      idempotencyKey: string | null,
      nodeId: string,
      tenantId: string,
      collection: string,
      id: string,
      revision: number,
      dataJson: string,
      timestamp: string,
      schemaVersion: number,
      payloadJson: string,
    ) => {
      const existing = findDocumentStatement.get(tenantId, collection, id) as
        | {
            created_at: string;
          }
        | undefined;

      if (existing) {
        updateDocumentStatement.run(
          dataJson,
          timestamp,
          revision,
          schemaVersion,
          tenantId,
          collection,
          id,
        );
      } else {
        insertDocumentStatement.run(
          tenantId,
          collection,
          id,
          dataJson,
          timestamp,
          timestamp,
          revision,
          schemaVersion,
        );
        incrementCollectionCountStatement.run(tenantId, collection);
      }

      insertEventStatement.run(
        eventId,
        idempotencyKey,
        nodeId,
        tenantId,
        collection,
        id,
        "document.upserted",
        revision,
        timestamp,
        schemaVersion,
        payloadJson,
      );
    },
  );

  const appendDocumentDeletedTransaction = database.transaction(
    (
      eventId: string,
      idempotencyKey: string | null,
      nodeId: string,
      tenantId: string,
      collection: string,
      id: string,
      revision: number,
      timestamp: string,
      schemaVersion: number,
      payloadJson: string,
    ) => {
      const result = deleteDocumentStatement.run(tenantId, collection, id);
      if (result.changes < 1) {
        throw new DatabaseNotFoundError(
          `Document "${id}" does not exist in collection "${collection}".`,
        );
      }

      decrementCollectionCountStatement.run(tenantId, collection);
      insertEventStatement.run(
        eventId,
        idempotencyKey,
        nodeId,
        tenantId,
        collection,
        id,
        "document.deleted",
        revision,
        timestamp,
        schemaVersion,
        payloadJson,
      );
    },
  );

  const activateSchemaTransaction = database.transaction(
    (collection: string, version: number) => {
      const result = activateSchemaStatement.run(collection, version);
      if (result.changes < 1) {
        throw new DatabaseNotFoundError(
          `Schema version ${version} for collection "${collection}" is not registered.`,
        );
      }

      resetActiveSchemasStatement.run(collection);
      activateSchemaStatement.run(collection, version);
    },
  );

  const appendTimeSeriesPointsTransaction = database.transaction(
    (
      tenantId: string,
      series: string,
      version: string,
      lastSequence: number,
      points: readonly {
        sourceSequence: number;
        pointIndex: number;
        point: DatabaseTimeSeriesPoint;
      }[],
    ) => {
      for (const entry of points) {
        insertTimeSeriesPointStatement.run(
          tenantId,
          series,
          version,
          entry.sourceSequence,
          entry.pointIndex,
          toTimestampMs(entry.point.timestamp),
          entry.point.value,
          entry.point.tags
            ? JSON.stringify(cloneRecord(entry.point.tags))
            : null,
          entry.point.fields
            ? JSON.stringify(cloneJson(entry.point.fields))
            : null,
        );
      }

      upsertTimeSeriesCheckpointStatement.run(
        tenantId,
        series,
        version,
        lastSequence,
        new Date().toISOString(),
      );
    },
  );

  const resetTimeSeriesTransaction = database.transaction(
    (tenantId: string, series: string, version: string) => {
      resetTimeSeriesPointsStatement.run(tenantId, series);
      upsertTimeSeriesCheckpointStatement.run(
        tenantId,
        series,
        version,
        0,
        new Date().toISOString(),
      );
    },
  );

  const projections = {
    async getCollection(
      input: TenantScoped<ListCollectionsInput> & { name: string },
    ) {
      const row = findCollectionStatement.get(input.tenantId, input.name) as
        | {
            tenant_id: string;
            name: string;
            created_at: string;
            document_count: number;
            metadata_json: string | null;
          }
        | undefined;

      return row ? toCollection(row) : null;
    },

    async listCollections(
      input: TenantScoped<ListCollectionsInput>,
    ): Promise<DatabaseCollection[]> {
      const rows = listCollectionsStatement.all(input.tenantId) as Array<{
        tenant_id: string;
        name: string;
        created_at: string;
        document_count: number;
        metadata_json: string | null;
      }>;

      return rows.map(toCollection);
    },

    async collectionExists(
      input: TenantScoped<{ tenantId: string; name: string }>,
    ): Promise<boolean> {
      return Boolean(collectionExistsStatement.get(input.tenantId, input.name));
    },

    async findDocumentById(
      input: TenantScoped<{ tenantId: string; collection: string; id: string }>,
    ) {
      const row = findDocumentStatement.get(
        input.tenantId,
        input.collection,
        input.id,
      ) as
        | {
            tenant_id: string;
            collection_name: string;
            id: string;
            data_json: string;
            created_at: string;
            updated_at: string;
            version: number;
            schema_version: number;
          }
        | undefined;

      return row ? toDocument(row) : null;
    },

    async findDocuments(
      input: TenantScoped<FindDocumentsInput> & {
        where: NonNullable<FindDocumentsInput["where"]>;
        orderBy: NonNullable<FindDocumentsInput["orderBy"]>;
        limit: number;
        offset: number;
      },
    ): Promise<DatabaseDocument[]> {
      const rows = listDocumentsStatement.all(
        input.tenantId,
        input.collection,
      ) as Array<{
        tenant_id: string;
        collection_name: string;
        id: string;
        data_json: string;
        created_at: string;
        updated_at: string;
        version: number;
        schema_version: number;
      }>;

      const documents = rows.map((row) => toDocument(row));
      const filtered = documents.filter((document) =>
        input.where.every((filter: DatabaseDocumentFilter) =>
          matchesFilter(document, filter),
        ),
      );
      const sorted = sortDocuments(filtered, input.orderBy);
      return sorted.slice(input.offset, input.offset + input.limit);
    },
  } satisfies DatabaseDriver["projections"];

  const events = {
    async append<TPayload extends DatabaseEventPayload>(
      input: TenantScoped<{
        tenantId: string;
        nodeId?: string;
        idempotencyKey?: string;
        collection: string;
        documentId?: string;
        type: DatabaseEvent["type"];
        expectedRevision?: number | null;
        schemaVersion?: number;
        payload: TPayload;
      }>,
    ): Promise<DatabaseEvent<TPayload>> {
      if (input.idempotencyKey) {
        const existingRow = findEventByIdempotencyKeyStatement.get(
          input.tenantId,
          input.idempotencyKey,
        ) as
          | {
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
          | undefined;

        if (existingRow) {
          const existing = toEvent<TPayload>(existingRow);
          if (matchesIdempotentAppend(existing, input)) {
            return existing;
          }

          throw new DatabaseEventIdempotencyConflictError({
            tenantId: input.tenantId,
            idempotencyKey: input.idempotencyKey,
            eventId: existing.eventId,
          });
        }
      }

      const eventId = generateId("evt");
      const nodeId = input.nodeId ?? "local";
      const timestamp = new Date().toISOString();
      const schemaVersion = input.schemaVersion ?? 1;
      const payloadJson = JSON.stringify(input.payload);
      const revisionRow = input.documentId
        ? (latestDocumentRevisionStatement.get(
            input.tenantId,
            input.collection,
            input.documentId,
          ) as { revision: number } | undefined)
        : (latestCollectionRevisionStatement.get(
            input.tenantId,
            input.collection,
          ) as { revision: number } | undefined);
      const currentRevision = revisionRow?.revision ?? 0;
      const expectedRevision = input.expectedRevision ?? currentRevision;

      if (input.type === "collection.created" && currentRevision > 0) {
        throw new DatabaseConflictError(
          `Collection "${input.collection}" already exists for tenant "${input.tenantId}".`,
        );
      }

      if (
        input.type === "document.upserted" &&
        expectedRevision === 0 &&
        currentRevision > 0
      ) {
        throw new DatabaseConflictError(
          `Document "${input.documentId ?? ""}" already exists in collection "${input.collection}".`,
        );
      }

      if (expectedRevision !== currentRevision) {
        throw new DatabaseRevisionMismatchError(
          `Revision mismatch for stream "${input.tenantId}:${input.collection}:${input.documentId ?? ""}". Expected ${expectedRevision}, found ${currentRevision}.`,
        );
      }

      const nextRevision = currentRevision + 1;

      if (input.type === "collection.created") {
        appendCollectionCreatedTransaction(
          eventId,
          input.idempotencyKey ?? null,
          nodeId,
          input.tenantId,
          input.collection,
          timestamp,
          schemaVersion,
          payloadJson,
        );
      } else if (input.type === "document.upserted") {
        if (!input.documentId) {
          throw new Error("A document.upserted event requires a document ID.");
        }

        const collection = findCollectionStatement.get(
          input.tenantId,
          input.collection,
        );
        if (!collection) {
          throw new DatabaseNotFoundError(
            `Collection "${input.collection}" does not exist for tenant "${input.tenantId}".`,
          );
        }

        const payload = input.payload as { data: DatabaseJsonObject };
        appendDocumentUpsertedTransaction(
          eventId,
          input.idempotencyKey ?? null,
          nodeId,
          input.tenantId,
          input.collection,
          input.documentId,
          nextRevision,
          JSON.stringify(cloneJson(payload.data)),
          timestamp,
          schemaVersion,
          payloadJson,
        );
      } else {
        if (!input.documentId) {
          throw new Error("A document.deleted event requires a document ID.");
        }

        appendDocumentDeletedTransaction(
          eventId,
          input.idempotencyKey ?? null,
          nodeId,
          input.tenantId,
          input.collection,
          input.documentId,
          nextRevision,
          timestamp,
          schemaVersion,
          payloadJson,
        );
      }

      return {
        sequence: (lastSequenceStatement.get() as { sequence: number })
          .sequence,
        eventId,
        idempotencyKey: input.idempotencyKey,
        nodeId,
        tenantId: input.tenantId,
        collection: input.collection,
        documentId: input.documentId,
        type: input.type,
        revision: nextRevision,
        timestamp,
        schemaVersion,
        payload: JSON.parse(JSON.stringify(input.payload)) as TPayload,
      };
    },

    async read(
      input: TenantScoped<ReadDatabaseEventsInput>,
    ): Promise<DatabaseEvent[]> {
      const rows = readEventsStatement.all(
        input.tenantId,
        input.collection ?? null,
        input.collection ?? null,
        input.documentId ?? null,
        input.documentId ?? null,
        input.afterSequence ?? 0,
        input.limit ?? 100,
      ) as Array<{
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
      }>;

      return rows.map((row) => toEvent(row));
    },
  } satisfies DatabaseDriver["events"];

  const schemas = {
    async list(): Promise<DatabaseStoredCollectionSchema[]> {
      const rows = listSchemasStatement.all() as Array<{
        collection_name: string;
        version: number;
        document_json: string;
        metadata_json: string | null;
        is_active: number;
      }>;

      return rows.map((row) => toStoredSchema(row));
    },

    async save(schema: DatabaseCollectionSchema): Promise<void> {
      saveSchemaStatement.run(
        schema.collection,
        schema.version,
        JSON.stringify(schema.document),
        schema.metadata ? JSON.stringify(cloneRecord(schema.metadata)) : null,
        schema.collection,
        schema.version,
      );
    },

    async activate(collection: string, version: number): Promise<void> {
      activateSchemaTransaction(collection, version);
    },
  } satisfies NonNullable<DatabaseDriver["schemas"]>;

  const timeseries = {
    async getState(input: DatabaseTimeSeriesStorageStateInput) {
      const row = getTimeSeriesStateStatement.get(
        input.tenantId,
        input.series,
      ) as
        | {
            definition_version: string;
            last_sequence: number;
          }
        | undefined;

      if (!row) {
        return null;
      }

      return {
        version: row.definition_version,
        lastSequence: row.last_sequence,
      };
    },

    async reset(input: DatabaseTimeSeriesStorageResetInput) {
      resetTimeSeriesTransaction(
        input.tenantId,
        input.series,
        String(input.version),
      );
    },

    async append(input: DatabaseTimeSeriesStorageAppendInput) {
      appendTimeSeriesPointsTransaction(
        input.tenantId,
        input.series,
        String(input.version),
        input.lastSequence,
        input.points,
      );
    },

    async range(input: DatabaseTimeSeriesStoredRangeInput) {
      const start =
        input.start === undefined ? null : toTimestampMs(input.start);
      const end = input.end === undefined ? null : toTimestampMs(input.end);
      const statement =
        input.order === "desc"
          ? readTimeSeriesRangeDescStatement
          : readTimeSeriesRangeAscStatement;
      const rows = statement.all(
        input.tenantId,
        input.series,
        String(input.version),
        start,
        start,
        end,
        end,
        input.limit ?? -1,
      ) as Array<{
        timestamp_ms: number;
        value: number;
        tags_json: string | null;
        fields_json: string | null;
      }>;

      return rows.map((row) => toTimeSeriesPoint(row));
    },

    async aggregate(input: DatabaseTimeSeriesStoredAggregateInput) {
      const start =
        input.start === undefined ? null : toTimestampMs(input.start);
      const end = input.end === undefined ? null : toTimestampMs(input.end);
      const row = aggregateTimeSeriesStatements[input.op].get(
        input.tenantId,
        input.series,
        String(input.version),
        start,
        start,
        end,
        end,
      ) as { value: number | null };

      return row.value ?? 0;
    },
  } satisfies DatabaseTimeSeriesStorageDriver;

  return defineDatabaseDriver({
    name: "bun:sqlite",
    capabilities: {
      documents: true,
      events: true,
      sql: true,
      transactions: false,
      tenantRouting: true,
    },
    events,
    projections,
    schemas,
    timeseries,
    sql: createSqlApi(database),
  });
}

export async function createBunSqliteDatabase(
  options: BunSqliteDatabaseOptions,
) {
  return createDatabase({
    ...options,
    defaultTenantId: options.defaultTenantId,
    driver: createBunSqliteDatabaseDriver(options),
  });
}
