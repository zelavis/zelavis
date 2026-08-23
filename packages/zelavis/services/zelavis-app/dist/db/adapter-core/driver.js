import { defineDatabaseDriver } from "../core/define-database-driver.js";
import { DatabaseConflictError, DatabaseDomainError, DatabaseNotFoundError, DatabaseRevisionMismatchError, DatabaseValidationError, } from "../core/errors.js";
import { DatabaseEventIdempotencyConflictError } from "../contracts/events.js";
import { buildDocumentQueryFragment } from "./json-query.js";
import { cloneJson, cloneRecord, generateId, payloadText, readOptionalRecord, toTimestampMs, } from "./helpers.js";
import { toCollection, toDocument, toEvent, toStoredSchema, toTimeSeriesPoint, } from "./mappers.js";
import { SCHEMA_STATEMENTS } from "./schema.js";
function matchesIdempotentAppend(event, input) {
    return (event.collection === input.collection &&
        event.documentId === input.documentId &&
        event.type === input.type &&
        event.revision - 1 === (input.expectedRevision ?? event.revision - 1) &&
        event.schemaVersion === (input.schemaVersion ?? 1) &&
        payloadText(event.payload) === payloadText(input.payload));
}
function quoteIdentifier(identifier) {
    return `"${identifier.replaceAll('"', '""')}"`;
}
function collectionTable(collection) {
    return quoteIdentifier(collection);
}
function collectionIndex(collection) {
    return quoteIdentifier(`${collection}_documents_lookup_idx`);
}
function createCollectionTableStatement(collection) {
    return `CREATE TABLE IF NOT EXISTS ${collectionTable(collection)} (
    tenant_id TEXT NOT NULL,
    id TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (tenant_id, id)
  )`;
}
function createCollectionLookupIndexStatement(collection) {
    return `CREATE INDEX IF NOT EXISTS ${collectionIndex(collection)}
    ON ${collectionTable(collection)} (tenant_id, updated_at, id)`;
}
/**
 * Extracts the target table name from a SQL write statement (DML + destructive
 * DDL). Returns null for read-only statements or unrecognised syntax.
 *
 * Handles both double-quoted identifiers ("My Table") and bare identifiers,
 * and optional schema prefixes (schema.table / "schema"."table").
 */
export function parseWriteTargetTable(statement) {
    const match = statement
        .trimStart()
        .match(/^(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE\s+(?:OR\s+\w+\s+)?|DELETE\s+FROM|DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?|ALTER\s+TABLE\s+)\s*(?:(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*)?(?:"((?:[^"]|"")*)"|([A-Za-z_][A-Za-z0-9_$]*))/i);
    if (!match)
        return null;
    return match[1] !== undefined
        ? match[1].replaceAll('""', '"')
        : (match[2] ?? null);
}
/**
 * Applies the shared DDL to a gateway. Uses `gateway.batch` when available
 * (for example libSQL) and falls back to per-statement `exec` otherwise.
 */
export async function applySqliteCompatibleSchema(gateway) {
    if (gateway.batch) {
        await gateway.batch(SCHEMA_STATEMENTS.map((sql) => ({ sql })));
        return;
    }
    for (const statement of SCHEMA_STATEMENTS) {
        await gateway.exec(statement);
    }
}
/**
 * Builds a complete `DatabaseDriver` on top of any `SqliteGateway`.
 *
 * All event, projection, schema, and time-series logic lives here so that
 * every SQLite-compatible adapter (better-sqlite3, bun:sqlite, libSQL) gets
 * identical behaviour with only ~50 lines of glue code.
 */
export function createSqliteCompatibleDriver(options) {
    const { name, gateway, defaultNodeId = "local", toSqlParameter = (value) => value, fromSqlValue = (value) => value, ready = async () => { }, } = options;
    async function withReady(fn) {
        await ready();
        return fn();
    }
    const projections = {
        async getCollection(input) {
            return withReady(async () => {
                const row = await gateway.get(`SELECT tenant_id, name, created_at, document_count, surface, metadata_json
           FROM zv_collections
           WHERE tenant_id = ? AND name = ?
           LIMIT 1`, [input.tenantId, input.name]);
                return row ? toCollection(row) : null;
            });
        },
        async listCollections(input) {
            return withReady(async () => {
                const rows = await gateway.all(`SELECT tenant_id, name, created_at, document_count, surface, metadata_json
           FROM zv_collections
           WHERE tenant_id = ?
           ORDER BY name ASC`, [input.tenantId]);
                return rows.map(toCollection);
            });
        },
        async collectionExists(input) {
            return withReady(async () => {
                const row = await gateway.get(`SELECT 1 AS present
           FROM zv_collections
           WHERE tenant_id = ? AND name = ?
           LIMIT 1`, [input.tenantId, input.name]);
                return Boolean(row?.present);
            });
        },
        async findDocumentById(input) {
            return withReady(async () => {
                const collection = await projections.getCollection({
                    tenantId: input.tenantId,
                    name: input.collection,
                });
                if (!collection) {
                    throw new DatabaseNotFoundError(`Collection "${input.collection}" does not exist for tenant "${input.tenantId}".`);
                }
                const row = await gateway.get(`SELECT tenant_id, ? AS collection_name, id, data_json, created_at, updated_at, version, schema_version
           FROM ${collectionTable(input.collection)}
           WHERE tenant_id = ? AND id = ?
           LIMIT 1`, [input.collection, input.tenantId, input.id]);
                return row ? toDocument(row) : null;
            });
        },
        async findDocuments(input) {
            return withReady(async () => {
                const collection = await projections.getCollection({
                    tenantId: input.tenantId,
                    name: input.collection,
                });
                if (!collection) {
                    throw new DatabaseNotFoundError(`Collection "${input.collection}" does not exist for tenant "${input.tenantId}".`);
                }
                const fragment = buildDocumentQueryFragment(input.where, input.orderBy);
                const sql = `SELECT tenant_id, ? AS collection_name, id, data_json, created_at, updated_at, version, schema_version
          FROM ${collectionTable(input.collection)}
          WHERE tenant_id = ?${fragment.whereSql}
          ${fragment.orderSql}
          LIMIT ? OFFSET ?`;
                const rows = await gateway.all(sql, [
                    input.collection,
                    input.tenantId,
                    ...fragment.whereParams,
                    input.limit,
                    input.offset,
                ]);
                return rows.map((row) => toDocument(row));
            });
        },
    };
    async function readLatestRevision(tenantId, collection, documentId) {
        const sql = documentId
            ? `SELECT revision FROM zv_events
         WHERE tenant_id = ? AND collection_name = ? AND document_id = ?
         ORDER BY sequence DESC LIMIT 1`
            : `SELECT revision FROM zv_events
         WHERE tenant_id = ? AND collection_name = ? AND document_id IS NULL
         ORDER BY sequence DESC LIMIT 1`;
        const params = documentId
            ? [tenantId, collection, documentId]
            : [tenantId, collection];
        const row = await gateway.get(sql, params);
        return row?.revision ?? 0;
    }
    async function lookupEventSequence(eventId) {
        const row = await gateway.get(`SELECT sequence FROM zv_events WHERE event_id = ? LIMIT 1`, [eventId]);
        return row?.sequence ?? 0;
    }
    async function insertEvent(tx, row) {
        await tx.run(`INSERT INTO zv_events (
        event_id, idempotency_key, node_id, tenant_id, collection_name,
        document_id, type, revision, timestamp, schema_version, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            row.eventId,
            row.idempotencyKey,
            row.nodeId,
            row.tenantId,
            row.collection,
            row.documentId,
            row.type,
            row.revision,
            row.timestamp,
            row.schemaVersion,
            row.payloadJson,
        ]);
    }
    const events = {
        async append(input) {
            return withReady(async () => {
                if (input.idempotencyKey) {
                    const existingRow = await gateway.get(`SELECT sequence, event_id, idempotency_key, node_id, tenant_id, collection_name, document_id, type, revision, timestamp, schema_version, payload_json
             FROM zv_events
             WHERE tenant_id = ? AND idempotency_key = ?
             LIMIT 1`, [input.tenantId, input.idempotencyKey]);
                    if (existingRow) {
                        const existing = toEvent(existingRow);
                        if (matchesIdempotentAppend(existing, {
                            collection: input.collection,
                            documentId: input.documentId,
                            type: input.type,
                            expectedRevision: input.expectedRevision ?? undefined,
                            schemaVersion: input.schemaVersion,
                            payload: input.payload,
                        })) {
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
                const nodeId = input.nodeId ?? defaultNodeId;
                const timestamp = new Date().toISOString();
                const schemaVersion = input.schemaVersion ?? 1;
                const payloadJson = JSON.stringify(input.payload);
                const currentRevision = await readLatestRevision(input.tenantId, input.collection, input.documentId);
                const expectedRevision = input.expectedRevision ?? currentRevision;
                if (input.type === "collection.created" && currentRevision > 0) {
                    throw new DatabaseConflictError(`Collection "${input.collection}" already exists for tenant "${input.tenantId}".`);
                }
                if (input.type === "document.upserted" &&
                    expectedRevision === 0 &&
                    currentRevision > 0) {
                    throw new DatabaseConflictError(`Document "${input.documentId ?? ""}" already exists in collection "${input.collection}".`);
                }
                if (expectedRevision !== currentRevision) {
                    throw new DatabaseRevisionMismatchError(`Revision mismatch for stream "${input.tenantId}:${input.collection}:${input.documentId ?? ""}". Expected ${expectedRevision}, found ${currentRevision}.`);
                }
                const nextRevision = currentRevision + 1;
                const idempotencyKey = input.idempotencyKey ?? null;
                if (input.type === "collection.created") {
                    await gateway.transaction(async (tx) => {
                        await insertEvent(tx, {
                            eventId,
                            idempotencyKey,
                            nodeId,
                            tenantId: input.tenantId,
                            collection: input.collection,
                            documentId: null,
                            type: input.type,
                            revision: nextRevision,
                            timestamp,
                            schemaVersion,
                            payloadJson,
                        });
                        const createdPayload = input.payload;
                        const collectionMetadata = readOptionalRecord(createdPayload.metadata) ?? null;
                        await tx.run(`INSERT INTO zv_collections (tenant_id, name, created_at, document_count, surface, metadata_json)
               VALUES (?, ?, ?, 0, ?, ?)`, [
                            input.tenantId,
                            input.collection,
                            timestamp,
                            createdPayload.surface ?? null,
                            collectionMetadata ? JSON.stringify(collectionMetadata) : null,
                        ]);
                        await tx.exec(createCollectionTableStatement(input.collection));
                        await tx.exec(createCollectionLookupIndexStatement(input.collection));
                    });
                    const sequence = await lookupEventSequence(eventId);
                    return {
                        sequence,
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
                    };
                }
                if (input.type === "document.upserted") {
                    if (!input.documentId) {
                        throw new DatabaseValidationError("A document.upserted event requires a document ID.");
                    }
                    const collection = await gateway.get(`SELECT name FROM zv_collections WHERE tenant_id = ? AND name = ? LIMIT 1`, [input.tenantId, input.collection]);
                    if (!collection) {
                        throw new DatabaseNotFoundError(`Collection "${input.collection}" does not exist for tenant "${input.tenantId}".`);
                    }
                    const payload = input.payload;
                    // Determine insert-vs-update outside the transaction so adapters
                    // with deferred writes still pick the correct branch; their
                    // reads-during-transaction would otherwise see stale state.
                    const existing = await gateway.get(`SELECT id FROM ${collectionTable(input.collection)}
             WHERE tenant_id = ? AND id = ?
             LIMIT 1`, [input.tenantId, input.documentId]);
                    await gateway.transaction(async (tx) => {
                        await insertEvent(tx, {
                            eventId,
                            idempotencyKey,
                            nodeId,
                            tenantId: input.tenantId,
                            collection: input.collection,
                            documentId: input.documentId ?? null,
                            type: input.type,
                            revision: nextRevision,
                            timestamp,
                            schemaVersion,
                            payloadJson,
                        });
                        if (existing) {
                            await tx.run(`UPDATE ${collectionTable(input.collection)}
                 SET data_json = ?, updated_at = ?, version = ?, schema_version = ?
                 WHERE tenant_id = ? AND id = ?`, [
                                JSON.stringify(cloneJson(payload.data)),
                                timestamp,
                                nextRevision,
                                schemaVersion,
                                input.tenantId,
                                input.documentId,
                            ]);
                        }
                        else {
                            await tx.run(`INSERT INTO ${collectionTable(input.collection)} (
                  tenant_id, id, data_json,
                  created_at, updated_at, version, schema_version
                ) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
                                input.tenantId,
                                input.documentId,
                                JSON.stringify(cloneJson(payload.data)),
                                timestamp,
                                timestamp,
                                nextRevision,
                                schemaVersion,
                            ]);
                            await tx.run(`UPDATE zv_collections SET document_count = document_count + 1
                 WHERE tenant_id = ? AND name = ?`, [input.tenantId, input.collection]);
                        }
                    });
                    const sequence = await lookupEventSequence(eventId);
                    return {
                        sequence,
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
                    };
                }
                // document.deleted
                if (!input.documentId) {
                    throw new DatabaseValidationError("A document.deleted event requires a document ID.");
                }
                // Pre-flight existence check — same reasoning as the upsert path:
                // adapters with deferred writes can't observe `changes` count
                // inside the transaction, so we verify before queuing.
                const collection = await gateway.get(`SELECT name FROM zv_collections WHERE tenant_id = ? AND name = ? LIMIT 1`, [input.tenantId, input.collection]);
                if (!collection) {
                    throw new DatabaseNotFoundError(`Collection "${input.collection}" does not exist for tenant "${input.tenantId}".`);
                }
                const targetDocument = await gateway.get(`SELECT id FROM ${collectionTable(input.collection)}
           WHERE tenant_id = ? AND id = ?
           LIMIT 1`, [input.tenantId, input.documentId]);
                if (!targetDocument) {
                    throw new DatabaseNotFoundError(`Document "${input.documentId}" does not exist in collection "${input.collection}".`);
                }
                await gateway.transaction(async (tx) => {
                    await insertEvent(tx, {
                        eventId,
                        idempotencyKey,
                        nodeId,
                        tenantId: input.tenantId,
                        collection: input.collection,
                        documentId: input.documentId ?? null,
                        type: input.type,
                        revision: nextRevision,
                        timestamp,
                        schemaVersion,
                        payloadJson,
                    });
                    await tx.run(`DELETE FROM ${collectionTable(input.collection)}
             WHERE tenant_id = ? AND id = ?`, [input.tenantId, input.documentId]);
                    await tx.run(`UPDATE zv_collections SET document_count = document_count - 1
             WHERE tenant_id = ? AND name = ? AND document_count > 0`, [input.tenantId, input.collection]);
                });
                const sequence = await lookupEventSequence(eventId);
                return {
                    sequence,
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
                };
            });
        },
        async read(input) {
            return withReady(async () => {
                const rows = await gateway.all(`SELECT sequence, event_id, idempotency_key, node_id, tenant_id, collection_name, document_id, type, revision, timestamp, schema_version, payload_json
           FROM zv_events
           WHERE tenant_id = ?
             AND (? IS NULL OR collection_name = ?)
             AND (? IS NULL OR document_id = ?)
             AND sequence > ?
           ORDER BY sequence ASC
           LIMIT ?`, [
                    input.tenantId,
                    input.collection ?? null,
                    input.collection ?? null,
                    input.documentId ?? null,
                    input.documentId ?? null,
                    input.afterSequence ?? 0,
                    input.limit ?? 100,
                ]);
                return rows.map((row) => toEvent(row));
            });
        },
    };
    const schemas = {
        async list() {
            return withReady(async () => {
                const rows = await gateway.all(`SELECT collection_name, version, fields_json, is_active
           FROM zv_schemas
           ORDER BY collection_name ASC, version ASC`);
                return rows.map((row) => toStoredSchema(row));
            });
        },
        async save(schema) {
            return withReady(async () => {
                await gateway.run(`INSERT INTO zv_schemas (collection_name, version, fields_json, is_active)
           VALUES (?, ?, ?, 0)
           ON CONFLICT(collection_name, version)
           DO UPDATE SET fields_json = excluded.fields_json`, [schema.collection, schema.version, JSON.stringify(schema.fields)]);
            });
        },
        async activate(collection, version) {
            return withReady(async () => {
                await gateway.transaction(async (tx) => {
                    const activated = await tx.run(`UPDATE zv_schemas SET is_active = 1
             WHERE collection_name = ? AND version = ?`, [collection, version]);
                    if (activated.changes < 1) {
                        throw new DatabaseNotFoundError(`Schema version ${version} for collection "${collection}" is not registered.`);
                    }
                    await tx.run(`UPDATE zv_schemas SET is_active = 0
             WHERE collection_name = ? AND version != ?`, [collection, version]);
                });
            });
        },
    };
    const timeseries = {
        async getState(input) {
            return withReady(async () => {
                const row = await gateway.get(`SELECT definition_version, last_sequence
           FROM zv_time_series_checkpoints
           WHERE tenant_id = ? AND series_name = ?
           LIMIT 1`, [input.tenantId, input.series]);
                if (!row) {
                    return null;
                }
                return {
                    version: row.definition_version,
                    lastSequence: row.last_sequence,
                };
            });
        },
        async reset(input) {
            return withReady(async () => {
                await gateway.transaction(async (tx) => {
                    await tx.run(`DELETE FROM zv_time_series_points
             WHERE tenant_id = ? AND series_name = ?`, [input.tenantId, input.series]);
                    await tx.run(`INSERT INTO zv_time_series_checkpoints (
              tenant_id, series_name, definition_version, last_sequence, updated_at
            ) VALUES (?, ?, ?, 0, ?)
            ON CONFLICT(tenant_id, series_name)
            DO UPDATE SET
              definition_version = excluded.definition_version,
              last_sequence = excluded.last_sequence,
              updated_at = excluded.updated_at`, [
                        input.tenantId,
                        input.series,
                        String(input.version),
                        new Date().toISOString(),
                    ]);
                });
            });
        },
        async append(input) {
            return withReady(async () => {
                const checkpointUpsert = {
                    sql: `INSERT INTO zv_time_series_checkpoints (
            tenant_id, series_name, definition_version, last_sequence, updated_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id, series_name)
          DO UPDATE SET
            definition_version = excluded.definition_version,
            last_sequence = excluded.last_sequence,
            updated_at = excluded.updated_at`,
                    params: [
                        input.tenantId,
                        input.series,
                        String(input.version),
                        input.lastSequence,
                        new Date().toISOString(),
                    ],
                };
                const pointStatements = input.points.map((entry) => ({
                    sql: `INSERT INTO zv_time_series_points (
            tenant_id, series_name, definition_version, source_sequence, point_index,
            timestamp_ms, value, tags_json, fields_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(
            tenant_id, series_name, definition_version, source_sequence, point_index
          ) DO UPDATE SET
            timestamp_ms = excluded.timestamp_ms,
            value = excluded.value,
            tags_json = excluded.tags_json,
            fields_json = excluded.fields_json`,
                    params: [
                        input.tenantId,
                        input.series,
                        String(input.version),
                        entry.sourceSequence,
                        entry.pointIndex,
                        toTimestampMs(entry.point.timestamp),
                        entry.point.value,
                        entry.point.tags
                            ? JSON.stringify(cloneRecord(entry.point.tags))
                            : null,
                        entry.point.fields ? JSON.stringify(cloneJson(entry.point.fields)) : null,
                    ],
                }));
                if (gateway.batch && pointStatements.length > 0) {
                    await gateway.batch([...pointStatements, checkpointUpsert]);
                    return;
                }
                await gateway.transaction(async (tx) => {
                    for (const statement of pointStatements) {
                        await tx.run(statement.sql, [...statement.params]);
                    }
                    await tx.run(checkpointUpsert.sql, [...checkpointUpsert.params]);
                });
            });
        },
        async range(input) {
            return withReady(async () => {
                const start = input.start === undefined ? null : toTimestampMs(input.start);
                const end = input.end === undefined ? null : toTimestampMs(input.end);
                const direction = input.order === "desc" ? "DESC" : "ASC";
                const rows = await gateway.all(`SELECT timestamp_ms, value, tags_json, fields_json
           FROM zv_time_series_points
           WHERE tenant_id = ?
             AND series_name = ?
             AND definition_version = ?
             AND (? IS NULL OR timestamp_ms >= ?)
             AND (? IS NULL OR timestamp_ms <= ?)
           ORDER BY timestamp_ms ${direction}, source_sequence ${direction}, point_index ${direction}
           LIMIT ?`, [
                    input.tenantId,
                    input.series,
                    String(input.version),
                    start,
                    start,
                    end,
                    end,
                    input.limit ?? -1,
                ]);
                return rows.map((row) => toTimeSeriesPoint(row));
            });
        },
        async aggregate(input) {
            return withReady(async () => {
                const start = input.start === undefined ? null : toTimestampMs(input.start);
                const end = input.end === undefined ? null : toTimestampMs(input.end);
                const operation = input.op === "avg"
                    ? "AVG"
                    : input.op === "sum"
                        ? "SUM"
                        : input.op === "min"
                            ? "MIN"
                            : input.op === "max"
                                ? "MAX"
                                : "COUNT";
                const select = operation === "COUNT" ? `${operation}(*)` : `${operation}(value)`;
                const row = await gateway.get(`SELECT ${select} AS value
           FROM zv_time_series_points
           WHERE tenant_id = ?
             AND series_name = ?
             AND definition_version = ?
             AND (? IS NULL OR timestamp_ms >= ?)
             AND (? IS NULL OR timestamp_ms <= ?)`, [
                    input.tenantId,
                    input.series,
                    String(input.version),
                    start,
                    start,
                    end,
                    end,
                ]);
                return row?.value ?? 0;
            });
        },
    };
    const sql = {
        async query(input) {
            return withReady(async () => {
                const params = (input.parameters ?? []).map(toSqlParameter);
                const rows = await gateway.all(input.statement, params);
                return {
                    rows: rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
                        key,
                        fromSqlValue(value),
                    ]))),
                };
            });
        },
        async execute(input) {
            return withReady(async () => {
                const targetTable = parseWriteTargetTable(input.statement);
                if (targetTable !== null) {
                    const collection = await gateway.get(`SELECT name FROM zv_collections WHERE name = ? LIMIT 1`, [targetTable]);
                    if (collection) {
                        throw new DatabaseDomainError(`Direct SQL writes to collection table "${targetTable}" are not permitted. Use the documents API.`);
                    }
                }
                const params = (input.parameters ?? []).map(toSqlParameter);
                const result = await gateway.run(input.statement, params);
                return {
                    rowsAffected: result.changes,
                    lastInsertId: result.lastInsertRowid,
                };
            });
        },
    };
    return defineDatabaseDriver({
        name,
        capabilities: {
            documents: true,
            events: true,
            sql: true,
            transactions: true,
            tenantRouting: true,
        },
        events,
        projections,
        schemas,
        timeseries,
        sql,
    });
}
