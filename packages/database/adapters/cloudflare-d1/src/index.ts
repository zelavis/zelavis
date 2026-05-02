import {
  createDatabase,
  defineDatabaseDriver,
  type CreateDatabaseOptions,
  type DatabaseAppendEventInput,
  type DatabaseCollection,
  type DatabaseCollectionSchema,
  type DatabaseDocument,
  type DatabaseDocumentFilter,
  type DatabaseDocumentSort,
  type DatabaseDriver,
  type DatabaseEvent,
  type DatabaseEventType,
  type DatabaseEventPayload,
  type DatabaseJsonObject,
  type DatabaseJson,
  type DatabaseStoredCollectionSchema,
  type DatabaseTimeSeriesPoint,
  type DatabaseTimeSeriesStorageDriver,
  type DatabaseTimeSeriesStoredAggregateInput,
  type DatabaseTimeSeriesStoredRangeInput,
  type DatabaseTimeSeriesStorageAppendInput,
  type DatabaseTimeSeriesStorageResetInput,
  type DatabaseTimeSeriesStorageState,
  type DatabaseTimeSeriesStorageStateInput,
  type FindDocumentByIdInput,
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
  DatabaseValidationError,
} from "@zelavis/database";

type TenantScoped<TInput extends { tenantId?: string }> = Omit<
  TInput,
  "tenantId"
> & {
  tenantId: string;
};

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T extends Record<string, unknown> = Record<string, unknown>>(): Promise<{
    results?: T[];
    success: boolean;
    meta?: {
      changes?: number;
      last_row_id?: number | string;
    };
  }>;
  run(): Promise<{
    success: boolean;
    meta?: {
      changes?: number;
      last_row_id?: number | string;
    };
  }>;
}

export interface CloudflareD1Database {
  prepare(statement: string): D1PreparedStatement;
  batch<T = unknown>(statements: readonly D1PreparedStatement[]): Promise<T[]>;
}

export interface CloudflareD1DriverOptions {
  database: CloudflareD1Database;
}

export interface CloudflareD1DatabaseOptions
  extends Omit<CreateDatabaseOptions, "driver">, CloudflareD1DriverOptions {}

interface D1StatementResult {
  results?: Record<string, unknown>[];
  success: boolean;
  meta?: {
    changes?: number;
    last_row_id?: number;
  };
}

function cloneJson<T>(value: T): T {
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
  tenant_id: string;
  name: string;
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
    active: Boolean(row.is_active),
  };
}

function toTimestampMs(value: number | string | Date): number {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "number") {
    return value;
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`Invalid timestamp value: ${value}`);
  }

  return timestamp;
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

function payloadText(payload: DatabaseEventPayload): string {
  return JSON.stringify(payload);
}

function matchesIdempotentAppend(
  event: DatabaseEvent,
  input: {
    collection: string;
    documentId?: string;
    type: string;
    expectedRevision?: number;
    schemaVersion?: number;
    payload: DatabaseEventPayload;
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

function normalizeParameters(parameters?: readonly SqlParameter[]): unknown[] {
  return (parameters ?? []).map((value) =>
    value === undefined ? null : value,
  );
}

async function execute(
  database: CloudflareD1Database,
  statement: string,
  parameters?: readonly SqlParameter[],
): Promise<D1StatementResult> {
  return database
    .prepare(statement)
    .bind(...normalizeParameters(parameters))
    .run() as Promise<D1StatementResult>;
}

async function queryRows<T extends Record<string, unknown>>(
  database: CloudflareD1Database,
  statement: string,
  parameters?: readonly SqlParameter[],
): Promise<T[]> {
  const result = (await database
    .prepare(statement)
    .bind(...normalizeParameters(parameters))
    .all()) as D1StatementResult;

  return (result.results ?? []) as T[];
}

async function queryFirst<T extends Record<string, unknown>>(
  database: CloudflareD1Database,
  statement: string,
  parameters?: readonly SqlParameter[],
): Promise<T | undefined> {
  const result = await queryRows<T>(database, statement, parameters);
  return result[0];
}

async function createSchema(database: CloudflareD1Database): Promise<void> {
  await database.batch([
    database.prepare(`
      CREATE TABLE IF NOT EXISTS collections (
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        document_count INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT,
        PRIMARY KEY (tenant_id, name)
      )
    `),
    database.prepare(`
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
        schema_version INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      )
    `),
    database.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS events_tenant_idempotency_idx
      ON events (tenant_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
    `),
    database.prepare(`
      CREATE TABLE IF NOT EXISTS documents (
        tenant_id TEXT NOT NULL,
        collection_name TEXT NOT NULL,
        id TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL,
        schema_version INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, collection_name, id)
      )
    `),
    database.prepare(`
      CREATE TABLE IF NOT EXISTS schemas (
        collection_name TEXT NOT NULL,
        version INTEGER NOT NULL,
        document_json TEXT NOT NULL,
        metadata_json TEXT,
        is_active INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (collection_name, version)
      )
    `),
    database.prepare(`
      CREATE TABLE IF NOT EXISTS time_series_checkpoints (
        tenant_id TEXT NOT NULL,
        series_name TEXT NOT NULL,
        definition_version TEXT NOT NULL,
        last_sequence INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, series_name)
      )
    `),
    database.prepare(`
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
      )
    `),
  ]);
}

export function createCloudflareD1DatabaseDriver(
  options: CloudflareD1DriverOptions,
): DatabaseDriver {
  const schemaReady = createSchema(options.database);

  const projections = {
    async getCollection(
      input: TenantScoped<ListCollectionsInput> & { name: string },
    ) {
      await schemaReady;
      const row = await queryFirst<{
        tenant_id: string;
        name: string;
        created_at: string;
        document_count: number;
        metadata_json: string | null;
      }>(
        options.database,
        `
          SELECT tenant_id, name, created_at, document_count, metadata_json
          FROM collections
          WHERE tenant_id = ? AND name = ?
          LIMIT 1
        `,
        [input.tenantId, input.name],
      );

      return row ? toCollection(row) : null;
    },

    async listCollections(input: TenantScoped<ListCollectionsInput>) {
      await schemaReady;
      const rows = await queryRows<{
        tenant_id: string;
        name: string;
        created_at: string;
        document_count: number;
        metadata_json: string | null;
      }>(
        options.database,
        `
          SELECT tenant_id, name, created_at, document_count, metadata_json
          FROM collections
          WHERE tenant_id = ?
          ORDER BY name ASC
        `,
        [input.tenantId],
      );

      return rows.map(toCollection);
    },

    async collectionExists(
      input: TenantScoped<ListCollectionsInput> & { name: string },
    ) {
      await schemaReady;
      const row = await queryFirst<{ present: number }>(
        options.database,
        `
          SELECT 1 AS present
          FROM collections
          WHERE tenant_id = ? AND name = ?
          LIMIT 1
        `,
        [input.tenantId, input.name],
      );

      return Boolean(row?.present);
    },

    async findDocumentById(input: TenantScoped<FindDocumentByIdInput>) {
      await schemaReady;
      const row = await queryFirst<{
        tenant_id: string;
        collection_name: string;
        id: string;
        data_json: string;
        created_at: string;
        updated_at: string;
        version: number;
        schema_version: number;
      }>(
        options.database,
        `
          SELECT tenant_id, collection_name, id, data_json, created_at, updated_at, version, schema_version
          FROM documents
          WHERE tenant_id = ? AND collection_name = ? AND id = ?
          LIMIT 1
        `,
        [input.tenantId, input.collection, input.id],
      );

      return row ? toDocument(row) : null;
    },

    async findDocuments(
      input: TenantScoped<FindDocumentsInput> & {
        where: NonNullable<FindDocumentsInput["where"]>;
        orderBy: NonNullable<FindDocumentsInput["orderBy"]>;
        limit: number;
        offset: number;
      },
    ) {
      const rows = await queryRows<{
        tenant_id: string;
        collection_name: string;
        id: string;
        data_json: string;
        created_at: string;
        updated_at: string;
        version: number;
        schema_version: number;
      }>(
        options.database,
        `
          SELECT tenant_id, collection_name, id, data_json, created_at, updated_at, version, schema_version
          FROM documents
          WHERE tenant_id = ? AND collection_name = ?
        `,
        [input.tenantId, input.collection],
      );

      const filtered = rows
        .map(toDocument)
        .filter((document) =>
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
      input: TenantScoped<DatabaseAppendEventInput<TPayload>>,
    ) {
      await schemaReady;

      if (input.idempotencyKey) {
        const existingRow = await queryFirst<{
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
        }>(
          options.database,
          `
            SELECT sequence, event_id, idempotency_key, node_id, tenant_id, collection_name, document_id, type, revision, timestamp, schema_version, payload_json
            FROM events
            WHERE tenant_id = ? AND idempotency_key = ?
            LIMIT 1
          `,
          [input.tenantId, input.idempotencyKey],
        );

        if (existingRow) {
          const existing = toEvent<TPayload>(existingRow);
          if (
            matchesIdempotentAppend(existing, {
              collection: input.collection,
              documentId: input.documentId,
              type: input.type,
              expectedRevision: input.expectedRevision ?? undefined,
              schemaVersion: input.schemaVersion,
              payload: input.payload,
            })
          ) {
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
      const nodeId = input.nodeId ?? "cloudflare";
      const timestamp = new Date().toISOString();
      const schemaVersion = input.schemaVersion ?? 1;
      const payloadJson = JSON.stringify(input.payload);
      const revisionRow = input.documentId
        ? await queryFirst<{ revision: number }>(
            options.database,
            `
              SELECT revision
              FROM events
              WHERE tenant_id = ? AND collection_name = ? AND document_id = ?
              ORDER BY sequence DESC
              LIMIT 1
            `,
            [input.tenantId, input.collection, input.documentId],
          )
        : await queryFirst<{ revision: number }>(
            options.database,
            `
              SELECT revision
              FROM events
              WHERE tenant_id = ? AND collection_name = ? AND document_id IS NULL
              ORDER BY sequence DESC
              LIMIT 1
            `,
            [input.tenantId, input.collection],
          );
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
        const result = await execute(
          options.database,
          `
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
            ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
          `,
          [
            eventId,
            input.idempotencyKey ?? null,
            nodeId,
            input.tenantId,
            input.collection,
            input.type,
            nextRevision,
            timestamp,
            schemaVersion,
            payloadJson,
          ],
        );
        await execute(
          options.database,
          `
            INSERT INTO collections (
              tenant_id,
              name,
              created_at,
              document_count,
              metadata_json
            ) VALUES (?, ?, ?, 0, ?)
          `,
          [
            input.tenantId,
            input.collection,
            timestamp,
            JSON.stringify(
              readOptionalRecord(
                (input.payload as { metadata?: Record<string, unknown> })
                  .metadata,
              ) ?? null,
            ),
          ],
        );
        return {
          sequence: Number(result.meta?.last_row_id ?? 0),
          eventId,
          idempotencyKey: input.idempotencyKey,
          nodeId,
          tenantId: input.tenantId,
          collection: input.collection,
          documentId: undefined,
          type: input.type,
          revision: nextRevision,
          timestamp,
          schemaVersion,
          payload: cloneJson(input.payload),
        } as DatabaseEvent<TPayload>;
      }

      if (input.type === "document.upserted") {
        if (!input.documentId) {
          throw new DatabaseValidationError(
            "A document.upserted event requires a document ID.",
          );
        }

        const collection = await queryFirst<{ name: string }>(
          options.database,
          `
            SELECT name
            FROM collections
            WHERE tenant_id = ? AND name = ?
            LIMIT 1
          `,
          [input.tenantId, input.collection],
        );
        if (!collection) {
          throw new DatabaseNotFoundError(
            `Collection "${input.collection}" does not exist for tenant "${input.tenantId}".`,
          );
        }

        const existingDocument = await queryFirst<{ id: string }>(
          options.database,
          `
            SELECT id
            FROM documents
            WHERE tenant_id = ? AND collection_name = ? AND id = ?
            LIMIT 1
          `,
          [input.tenantId, input.collection, input.documentId],
        );
        const payload = input.payload as { data: DatabaseJsonObject };
        const eventResult = await execute(
          options.database,
          `
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
          `,
          [
            eventId,
            input.idempotencyKey ?? null,
            nodeId,
            input.tenantId,
            input.collection,
            input.documentId,
            input.type,
            nextRevision,
            timestamp,
            schemaVersion,
            payloadJson,
          ],
        );

        if (existingDocument) {
          await execute(
            options.database,
            `
              UPDATE documents
              SET data_json = ?, updated_at = ?, version = ?, schema_version = ?
              WHERE tenant_id = ? AND collection_name = ? AND id = ?
            `,
            [
              JSON.stringify(cloneJson(payload.data)),
              timestamp,
              nextRevision,
              schemaVersion,
              input.tenantId,
              input.collection,
              input.documentId,
            ],
          );
        } else {
          await execute(
            options.database,
            `
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
            `,
            [
              input.tenantId,
              input.collection,
              input.documentId,
              JSON.stringify(cloneJson(payload.data)),
              timestamp,
              timestamp,
              nextRevision,
              schemaVersion,
            ],
          );
          await execute(
            options.database,
            `
              UPDATE collections
              SET document_count = document_count + 1
              WHERE tenant_id = ? AND name = ?
            `,
            [input.tenantId, input.collection],
          );
        }

        return {
          sequence: Number(eventResult.meta?.last_row_id ?? 0),
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
          payload: cloneJson(input.payload),
        } as DatabaseEvent<TPayload>;
      }

      if (!input.documentId) {
        throw new DatabaseValidationError(
          "A document.deleted event requires a document ID.",
        );
      }

      const eventResult = await execute(
        options.database,
        `
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
        `,
        [
          eventId,
          input.idempotencyKey ?? null,
          nodeId,
          input.tenantId,
          input.collection,
          input.documentId,
          input.type,
          nextRevision,
          timestamp,
          schemaVersion,
          payloadJson,
        ],
      );
      await execute(
        options.database,
        `
          DELETE FROM documents
          WHERE tenant_id = ? AND collection_name = ? AND id = ?
        `,
        [input.tenantId, input.collection, input.documentId],
      );
      await execute(
        options.database,
        `
          UPDATE collections
          SET document_count = document_count - 1
          WHERE tenant_id = ? AND name = ? AND document_count > 0
        `,
        [input.tenantId, input.collection],
      );

      return {
        sequence: Number(eventResult.meta?.last_row_id ?? 0),
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
        payload: cloneJson(input.payload),
      } as DatabaseEvent<TPayload>;
    },

    async read(input: TenantScoped<ReadDatabaseEventsInput>) {
      await schemaReady;
      const rows = await queryRows<{
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
      }>(
        options.database,
        `
          SELECT sequence, event_id, idempotency_key, node_id, tenant_id, collection_name, document_id, type, revision, timestamp, schema_version, payload_json
          FROM events
          WHERE tenant_id = ?
            AND (? IS NULL OR collection_name = ?)
            AND (? IS NULL OR document_id = ?)
            AND sequence > ?
          ORDER BY sequence ASC
          LIMIT ?
        `,
        [
          input.tenantId,
          input.collection ?? null,
          input.collection ?? null,
          input.documentId ?? null,
          input.documentId ?? null,
          input.afterSequence ?? 0,
          input.limit ?? 100,
        ],
      );

      return rows.map(toEvent);
    },
  } satisfies DatabaseDriver["events"];

  const schemas = {
    async list() {
      await schemaReady;
      const rows = await queryRows<{
        collection_name: string;
        version: number;
        document_json: string;
        metadata_json: string | null;
        is_active: number;
      }>(
        options.database,
        `
          SELECT collection_name, version, document_json, metadata_json, is_active
          FROM schemas
          ORDER BY collection_name ASC, version ASC
        `,
      );

      return rows.map(toStoredSchema);
    },

    async save<TData extends DatabaseJsonObject = DatabaseJsonObject>(
      schema: DatabaseCollectionSchema<TData>,
    ) {
      await schemaReady;
      await execute(
        options.database,
        `
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
        `,
        [
          schema.collection,
          schema.version,
          JSON.stringify(schema.document),
          schema.metadata ? JSON.stringify(schema.metadata) : null,
          schema.collection,
          schema.version,
        ],
      );
    },

    async activate(collection: string, version: number) {
      await schemaReady;
      await execute(
        options.database,
        `
          UPDATE schemas
          SET is_active = 0
          WHERE collection_name = ?
        `,
        [collection],
      );
      await execute(
        options.database,
        `
          UPDATE schemas
          SET is_active = 1
          WHERE collection_name = ? AND version = ?
        `,
        [collection, version],
      );
    },
  };

  const timeseries = {
    async getState(
      input: DatabaseTimeSeriesStorageStateInput,
    ): Promise<DatabaseTimeSeriesStorageState | null> {
      await schemaReady;
      const row = await queryFirst<{
        definition_version: string;
        last_sequence: number;
      }>(
        options.database,
        `
          SELECT definition_version, last_sequence
          FROM time_series_checkpoints
          WHERE tenant_id = ? AND series_name = ?
          LIMIT 1
        `,
        [input.tenantId, input.series],
      );

      return row
        ? {
            version: row.definition_version,
            lastSequence: row.last_sequence,
          }
        : null;
    },

    async reset(input: DatabaseTimeSeriesStorageResetInput) {
      await schemaReady;
      await execute(
        options.database,
        `
          DELETE FROM time_series_points
          WHERE tenant_id = ? AND series_name = ?
        `,
        [input.tenantId, input.series],
      );
      await execute(
        options.database,
        `
          INSERT INTO time_series_checkpoints (
            tenant_id,
            series_name,
            definition_version,
            last_sequence,
            updated_at
          ) VALUES (?, ?, ?, 0, ?)
          ON CONFLICT(tenant_id, series_name)
          DO UPDATE SET
            definition_version = excluded.definition_version,
            last_sequence = excluded.last_sequence,
            updated_at = excluded.updated_at
        `,
        [
          input.tenantId,
          input.series,
          String(input.version),
          new Date().toISOString(),
        ],
      );
    },

    async append(input: DatabaseTimeSeriesStorageAppendInput) {
      await schemaReady;
      for (const entry of input.points) {
        await execute(
          options.database,
          `
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
          `,
          [
            input.tenantId,
            input.series,
            String(input.version),
            entry.sourceSequence,
            entry.pointIndex,
            toTimestampMs(entry.point.timestamp),
            entry.point.value,
            entry.point.tags ? JSON.stringify(entry.point.tags) : null,
            entry.point.fields ? JSON.stringify(entry.point.fields) : null,
          ],
        );
      }

      await execute(
        options.database,
        `
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
        `,
        [
          input.tenantId,
          input.series,
          String(input.version),
          input.lastSequence,
          new Date().toISOString(),
        ],
      );
    },

    async range(input: DatabaseTimeSeriesStoredRangeInput) {
      await schemaReady;
      const start =
        input.start === undefined ? null : toTimestampMs(input.start);
      const end = input.end === undefined ? null : toTimestampMs(input.end);
      const rows = await queryRows<{
        timestamp_ms: number;
        value: number;
        tags_json: string | null;
        fields_json: string | null;
      }>(
        options.database,
        `
          SELECT timestamp_ms, value, tags_json, fields_json
          FROM time_series_points
          WHERE tenant_id = ?
            AND series_name = ?
            AND definition_version = ?
            AND (? IS NULL OR timestamp_ms >= ?)
            AND (? IS NULL OR timestamp_ms <= ?)
          ORDER BY timestamp_ms ${input.order === "desc" ? "DESC" : "ASC"}, source_sequence ${input.order === "desc" ? "DESC" : "ASC"}, point_index ${input.order === "desc" ? "DESC" : "ASC"}
          LIMIT ?
        `,
        [
          input.tenantId,
          input.series,
          String(input.version),
          start,
          start,
          end,
          end,
          input.limit ?? 100,
        ],
      );

      return rows.map(toTimeSeriesPoint);
    },

    async aggregate(input: DatabaseTimeSeriesStoredAggregateInput) {
      await schemaReady;
      const start =
        input.start === undefined ? null : toTimestampMs(input.start);
      const end = input.end === undefined ? null : toTimestampMs(input.end);
      const operation =
        input.op === "avg"
          ? "AVG"
          : input.op === "sum"
            ? "SUM"
            : input.op === "min"
              ? "MIN"
              : input.op === "max"
                ? "MAX"
                : "COUNT";
      const row = await queryFirst<{ value: number | null }>(
        options.database,
        `
          SELECT ${operation}(value) AS value
          FROM time_series_points
          WHERE tenant_id = ?
            AND series_name = ?
            AND definition_version = ?
            AND (? IS NULL OR timestamp_ms >= ?)
            AND (? IS NULL OR timestamp_ms <= ?)
        `,
        [
          input.tenantId,
          input.series,
          String(input.version),
          start,
          start,
          end,
          end,
        ],
      );

      return row?.value ?? 0;
    },
  } satisfies DatabaseTimeSeriesStorageDriver;

  const sql: SqlDatabase = {
    async query(input: SqlQueryInput): Promise<SqlQueryResult> {
      await schemaReady;
      const rows = await queryRows<Record<string, DatabaseJson | Uint8Array>>(
        options.database,
        input.statement,
        input.parameters,
      );
      return { rows };
    },
    async execute(input: SqlExecuteInput): Promise<SqlExecuteResult> {
      await schemaReady;
      const result = await execute(
        options.database,
        input.statement,
        input.parameters,
      );
      return {
        rowsAffected: Number(result.meta?.changes ?? 0),
        ...(result.meta?.last_row_id === undefined
          ? {}
          : { lastInsertId: result.meta.last_row_id }),
      };
    },
  };

  return defineDatabaseDriver({
    name: "cloudflare-d1",
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
    sql,
  });
}

function readOptionalRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export async function createCloudflareD1Database(
  options: CloudflareD1DatabaseOptions,
) {
  return createDatabase({
    ...options,
    defaultTenantId: options.defaultTenantId,
    driver: createCloudflareD1DatabaseDriver(options),
  });
}
