import { DatabaseEventIdempotencyConflictError } from "../contracts/events.js";
import { defineDatabaseDriver } from "../core/define-database-driver.js";
import { DatabaseConflictError, DatabaseNotFoundError, DatabaseRevisionMismatchError, DatabaseValidationError, } from "../core/errors.js";
import { err, ok } from "../core/result.js";
function generateId(prefix) {
    if (typeof globalThis.crypto?.randomUUID === "function") {
        return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
    }
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}
function cloneRecord(value) {
    return JSON.parse(JSON.stringify(value));
}
function cloneDocument(document) {
    return {
        ...document,
        data: cloneJson(document.data),
        createdAt: new Date(document.createdAt),
        updatedAt: new Date(document.updatedAt),
    };
}
function cloneCollection(collection) {
    return {
        ...collection,
        createdAt: new Date(collection.createdAt),
        metadata: collection.metadata
            ? cloneRecord(collection.metadata)
            : undefined,
    };
}
function cloneEvent(event) {
    return {
        ...event,
        payload: JSON.parse(JSON.stringify(event.payload)),
    };
}
function collectionKey(tenantId, name) {
    return `${tenantId}:${name}`;
}
function documentRevisionKey(tenantId, collection, documentId) {
    return `${tenantId}:${collection}:${documentId ?? ""}`;
}
function idempotencyKey(tenantId, key) {
    return `${tenantId}:${key}`;
}
function payloadText(value) {
    return JSON.stringify(value);
}
function matchesIdempotentAppend(event, input) {
    return (event.collection === input.collection &&
        event.documentId === input.documentId &&
        event.type === input.type &&
        event.revision - 1 === (input.expectedRevision ?? event.revision - 1) &&
        event.schemaVersion === (input.schemaVersion ?? 1) &&
        payloadText(event.payload) === payloadText(input.payload));
}
function readPath(data, path) {
    const parts = path
        .replace(/^\$\.?/, "")
        .split(".")
        .filter(Boolean);
    let current = data;
    for (const part of parts) {
        if (!current || typeof current !== "object" || Array.isArray(current)) {
            return undefined;
        }
        current = current[part];
    }
    return current;
}
function compareValues(left, right) {
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
function matchesFilter(document, filter) {
    const op = filter.op ?? "eq";
    const actual = readPath(document.data, filter.path);
    if (op === "in") {
        return (Array.isArray(filter.value) &&
            filter.value.some((item) => compareValues(actual, item) === 0));
    }
    if (Array.isArray(filter.value)) {
        return false;
    }
    const comparison = compareValues(actual, filter.value);
    if (op === "eq")
        return comparison === 0;
    if (op === "ne")
        return comparison !== 0;
    if (op === "gt")
        return comparison > 0;
    if (op === "gte")
        return comparison >= 0;
    if (op === "lt")
        return comparison < 0;
    if (op === "lte")
        return comparison <= 0;
    return false;
}
function sortDocuments(documents, orderBy) {
    if (orderBy.length === 0) {
        return documents;
    }
    return [...documents].sort((left, right) => {
        for (const order of orderBy) {
            const direction = order.direction ?? "asc";
            const result = compareValues(readPath(left.data, order.path), readPath(right.data, order.path));
            if (result !== 0) {
                return direction === "asc" ? result : -result;
            }
        }
        return 0;
    });
}
function toAppendError(failure) {
    if (failure.kind === "idempotency-conflict") {
        return new DatabaseEventIdempotencyConflictError({
            tenantId: failure.tenantId,
            idempotencyKey: failure.idempotencyKey,
            eventId: failure.eventId,
        });
    }
    if (failure.kind === "duplicate-collection") {
        return new DatabaseConflictError(`Collection "${failure.collection}" already exists for tenant "${failure.tenantId}".`);
    }
    if (failure.kind === "duplicate-document") {
        return new DatabaseConflictError(`Document "${failure.documentId ?? ""}" already exists in collection "${failure.collection}".`);
    }
    return new DatabaseRevisionMismatchError(`Revision mismatch for stream "${failure.revisionKey}". Expected ${failure.expectedRevision}, found ${failure.currentRevision}.`);
}
export function createInMemoryDatabaseDriver() {
    const collections = new Map();
    const revisions = new Map();
    const events = [];
    const eventsByIdempotencyKey = new Map();
    const schemas = new Map();
    let sequence = 0;
    function preflightAppend(input) {
        if (input.idempotencyKey) {
            const existing = eventsByIdempotencyKey.get(idempotencyKey(input.tenantId, input.idempotencyKey));
            if (existing) {
                if (matchesIdempotentAppend(existing, input)) {
                    return ok({
                        currentRevision: existing.revision - 1,
                        expectedRevision: input.expectedRevision ?? existing.revision - 1,
                        revisionKey: documentRevisionKey(input.tenantId, input.collection, input.documentId),
                    });
                }
                return err({
                    kind: "idempotency-conflict",
                    tenantId: input.tenantId,
                    idempotencyKey: input.idempotencyKey,
                    eventId: existing.eventId,
                });
            }
        }
        const revisionKey = documentRevisionKey(input.tenantId, input.collection, input.documentId);
        const currentRevision = revisions.get(revisionKey) ?? 0;
        const expectedRevision = input.expectedRevision ?? currentRevision;
        if (input.type === "collection.created" && currentRevision > 0) {
            return err({
                kind: "duplicate-collection",
                collection: input.collection,
                tenantId: input.tenantId,
            });
        }
        if (input.type === "document.upserted" &&
            expectedRevision === 0 &&
            currentRevision > 0) {
            return err({
                kind: "duplicate-document",
                collection: input.collection,
                documentId: input.documentId,
            });
        }
        if (expectedRevision !== currentRevision) {
            return err({
                kind: "revision-mismatch",
                expectedRevision,
                currentRevision,
                revisionKey,
            });
        }
        return ok({
            currentRevision,
            expectedRevision,
            revisionKey,
        });
    }
    function getCollection(tenantId, name) {
        const collection = collections.get(collectionKey(tenantId, name));
        if (!collection) {
            throw new DatabaseNotFoundError(`Collection "${name}" does not exist for tenant "${tenantId}".`);
        }
        return collection;
    }
    function applyCollectionCreated(event) {
        const key = collectionKey(event.tenantId, event.collection);
        if (collections.has(key)) {
            throw new DatabaseConflictError(`Collection "${event.collection}" already exists for tenant "${event.tenantId}".`);
        }
        collections.set(key, {
            meta: {
                name: event.collection,
                tenantId: event.tenantId,
                createdAt: new Date(event.timestamp),
                documentCount: 0,
                metadata: event.payload.metadata
                    ? cloneRecord(event.payload.metadata)
                    : undefined,
            },
            documents: new Map(),
        });
    }
    function applyDocumentUpserted(event) {
        const collection = getCollection(event.tenantId, event.collection);
        const documentId = event.documentId;
        if (!documentId) {
            throw new DatabaseValidationError("A document.upserted event requires a document ID.");
        }
        const current = collection.documents.get(documentId);
        const next = current
            ? {
                ...current,
                data: cloneJson(event.payload.data),
                updatedAt: new Date(event.timestamp),
                version: event.revision,
                schemaVersion: event.schemaVersion,
            }
            : {
                id: documentId,
                tenantId: event.tenantId,
                collection: event.collection,
                data: cloneJson(event.payload.data),
                createdAt: new Date(event.timestamp),
                updatedAt: new Date(event.timestamp),
                version: event.revision,
                schemaVersion: event.schemaVersion,
            };
        collection.documents.set(documentId, next);
        collection.meta.documentCount = collection.documents.size;
    }
    function applyDocumentDeleted(event) {
        const documentId = event.documentId;
        if (!documentId) {
            throw new DatabaseValidationError("A document.deleted event requires a document ID.");
        }
        const collection = getCollection(event.tenantId, event.collection);
        collection.documents.delete(documentId);
        collection.meta.documentCount = collection.documents.size;
    }
    function applyEvent(event) {
        if (event.type === "collection.created") {
            applyCollectionCreated(event);
            return;
        }
        if (event.type === "document.upserted") {
            applyDocumentUpserted(event);
            return;
        }
        applyDocumentDeleted(event);
    }
    const projections = {
        async getCollection(input) {
            const collection = collections.get(collectionKey(input.tenantId, input.name));
            return collection ? cloneCollection(collection.meta) : null;
        },
        async listCollections(input) {
            return [...collections.values()]
                .filter((collection) => collection.meta.tenantId === input.tenantId)
                .map((collection) => cloneCollection(collection.meta));
        },
        async collectionExists(input) {
            return collections.has(collectionKey(input.tenantId, input.name));
        },
        async findDocumentById(input) {
            const collection = getCollection(input.tenantId, input.collection);
            const document = collection.documents.get(input.id);
            return document ? cloneDocument(document) : null;
        },
        async findDocuments(input) {
            const collection = getCollection(input.tenantId, input.collection);
            const filtered = [...collection.documents.values()].filter((document) => input.where.every((filter) => matchesFilter(document, filter)));
            const sorted = sortDocuments(filtered, input.orderBy);
            return sorted
                .slice(input.offset, input.offset + input.limit)
                .map((document) => cloneDocument(document));
        },
    };
    const eventDriver = {
        async append(input) {
            const preflight = preflightAppend(input);
            if (!preflight.ok) {
                throw toAppendError(preflight.error);
            }
            if (input.idempotencyKey) {
                const existing = eventsByIdempotencyKey.get(idempotencyKey(input.tenantId, input.idempotencyKey));
                if (existing && matchesIdempotentAppend(existing, input)) {
                    return cloneEvent(existing);
                }
            }
            const event = {
                sequence: ++sequence,
                eventId: generateId("evt"),
                idempotencyKey: input.idempotencyKey,
                nodeId: input.nodeId ?? "local",
                tenantId: input.tenantId,
                collection: input.collection,
                documentId: input.documentId,
                type: input.type,
                revision: preflight.value.currentRevision + 1,
                timestamp: new Date().toISOString(),
                schemaVersion: input.schemaVersion ?? 1,
                payload: JSON.parse(JSON.stringify(input.payload)),
            };
            applyEvent(event);
            revisions.set(preflight.value.revisionKey, event.revision);
            events.push(event);
            if (input.idempotencyKey) {
                eventsByIdempotencyKey.set(idempotencyKey(input.tenantId, input.idempotencyKey), event);
            }
            return cloneEvent(event);
        },
        async read(input) {
            const afterSequence = input.afterSequence ?? 0;
            const limit = input.limit ?? 100;
            return events
                .filter((event) => event.tenantId === input.tenantId)
                .filter((event) => !input.collection || event.collection === input.collection)
                .filter((event) => !input.documentId || event.documentId === input.documentId)
                .filter((event) => event.sequence > afterSequence)
                .slice(0, limit)
                .map((event) => cloneEvent(event));
        },
    };
    const schemaDriver = {
        async list() {
            return [...schemas.values()]
                .flatMap((versions) => [...versions.values()])
                .sort((left, right) => {
                const collectionOrder = left.collection.localeCompare(right.collection);
                return collectionOrder !== 0 ? collectionOrder : left.version - right.version;
            })
                .map((schema) => ({ ...schema, fields: [...schema.fields] }));
        },
        async save(schema) {
            const versions = schemas.get(schema.collection) ?? new Map();
            const existing = versions.get(schema.version);
            versions.set(schema.version, {
                collection: schema.collection,
                version: schema.version,
                fields: [...schema.fields],
                active: existing?.active ?? schema.active,
            });
            schemas.set(schema.collection, versions);
        },
        async activate(collection, version) {
            const versions = schemas.get(collection);
            const schema = versions?.get(version);
            if (!versions || !schema) {
                throw new DatabaseNotFoundError(`Schema version ${version} for collection "${collection}" is not registered.`);
            }
            for (const [v, record] of versions) {
                versions.set(v, { ...record, active: v === version });
            }
        },
    };
    return defineDatabaseDriver({
        name: "in-memory",
        capabilities: {
            documents: true,
            events: true,
            sql: false,
            transactions: false,
            tenantRouting: true,
        },
        events: eventDriver,
        projections,
        schemas: schemaDriver,
    });
}
