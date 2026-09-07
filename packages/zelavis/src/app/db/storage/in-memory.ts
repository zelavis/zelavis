import type {
  DatabaseDriver,
  DatabaseEventDriver,
  DatabaseProjectionDriver,
  DatabaseSchemaStorageDriver,
} from "../contracts/driver.js";
import type {
  DatabaseCollection,
  DatabaseDocument,
  DatabaseDocumentFilter,
  DatabaseDocumentSort,
  FindDocumentByIdInput,
  FindDocumentsInput,
} from "../contracts/documents.js";
import type {
  DatabaseAppendEventInput,
  DatabaseCollectionCreatedPayload,
  DatabaseDocumentDeletedPayload,
  DatabaseDocumentUpsertedPayload,
  DatabaseEvent,
  DatabaseEventPayload,
  ReadDatabaseEventsInput,
} from "../contracts/events.js";
import { DatabaseEventIdempotencyConflictError } from "../contracts/events.js";
import {
  decodeDatabaseEventCursor,
  encodeDatabaseEventCursor,
} from "../contracts/events.js";
import type { DatabaseJson, DatabaseJsonObject } from "../contracts/json.js";
import type { StoredCollectionSchema } from "../../../dbnew/schema/index.js";
import { defineDatabaseDriver } from "../core/define-database-driver.js";
import {
  DatabaseConflictError,
  DatabaseNotFoundError,
  DatabaseRevisionMismatchError,
  DatabaseValidationError,
} from "../core/errors.js";
import { err, ok, type Result } from "../core/result.js";

interface StoredCollection {
  meta: DatabaseCollection;
  documents: Map<string, DatabaseDocument>;
}

type TenantScoped<TInput> = Omit<
  TInput,
  "tenantId"
> & {
  tenantId: string;
};

function generateId(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  }

  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function cloneJson<T extends DatabaseJson>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneRecord<T extends Record<string, unknown>>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}


function cloneDocument<TData extends DatabaseJsonObject>(
  document: DatabaseDocument<TData>,
): DatabaseDocument<TData> {
  return {
    ...document,
    data: cloneJson(document.data),
    createdAt: new Date(document.createdAt),
    updatedAt: new Date(document.updatedAt),
  };
}

function cloneCollection(collection: DatabaseCollection): DatabaseCollection {
  return {
    ...collection,
    createdAt: new Date(collection.createdAt),
    metadata: collection.metadata
      ? cloneRecord(collection.metadata)
      : undefined,
  };
}


function cloneEvent<TPayload extends DatabaseEventPayload>(
  event: DatabaseEvent<TPayload>,
): DatabaseEvent<TPayload> {
  return {
    ...event,
    payload: JSON.parse(JSON.stringify(event.payload)) as TPayload,
  };
}

function collectionKey(tenantId: string, name: string): string {
  return `${tenantId}:${name}`;
}

function documentRevisionKey(
  tenantId: string,
  collection: string,
  documentId?: string,
): string {
  return `${tenantId}:${collection}:${documentId ?? ""}`;
}

function idempotencyKey(tenantId: string, key: string): string {
  return `${tenantId}:${key}`;
}

function payloadText(value: unknown): string {
  return JSON.stringify(value);
}

function matchesIdempotentAppend<TPayload extends DatabaseEventPayload>(
  event: DatabaseEvent<TPayload>,
  input: TenantScoped<DatabaseAppendEventInput<TPayload>>,
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
      filter.value.some((item) => compareValues(actual, item) === 0)
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

interface AppendPreflightSuccess {
  currentRevision: number;
  expectedRevision: number;
  revisionKey: string;
}

type AppendPreflightFailure =
  | {
      kind: "idempotency-conflict";
      eventId: string;
      idempotencyKey: string;
      tenantId: string;
    }
  | {
      kind: "duplicate-collection";
      collection: string;
      tenantId: string;
    }
  | {
      kind: "duplicate-document";
      collection: string;
      documentId?: string;
    }
  | {
      kind: "revision-mismatch";
      expectedRevision: number;
      currentRevision: number;
      revisionKey: string;
    };

function toAppendError(failure: AppendPreflightFailure): Error {
  if (failure.kind === "idempotency-conflict") {
    return new DatabaseEventIdempotencyConflictError({
      tenantId: failure.tenantId,
      idempotencyKey: failure.idempotencyKey,
      eventId: failure.eventId,
    });
  }

  if (failure.kind === "duplicate-collection") {
    return new DatabaseConflictError(
      `Collection "${failure.collection}" already exists for tenant "${failure.tenantId}".`,
    );
  }

  if (failure.kind === "duplicate-document") {
    return new DatabaseConflictError(
      `Document "${failure.documentId ?? ""}" already exists in collection "${failure.collection}".`,
    );
  }

  return new DatabaseRevisionMismatchError(
    `Revision mismatch for stream "${failure.revisionKey}". Expected ${failure.expectedRevision}, found ${failure.currentRevision}.`,
  );
}

export function createInMemoryDatabaseDriver(): DatabaseDriver {
  const collections = new Map<string, StoredCollection>();
  const revisions = new Map<string, number>();
  const events: DatabaseEvent[] = [];
  const eventsByIdempotencyKey = new Map<string, DatabaseEvent>();
  const schemas = new Map<string, Map<number, StoredCollectionSchema>>();
  let sequence = 0;

  function preflightAppend<TPayload extends DatabaseEventPayload>(
    input: TenantScoped<DatabaseAppendEventInput<TPayload>>,
  ): Result<AppendPreflightSuccess, AppendPreflightFailure> {
    if (input.idempotencyKey) {
      const existing = eventsByIdempotencyKey.get(
        idempotencyKey(input.tenantId, input.idempotencyKey),
      ) as DatabaseEvent<TPayload> | undefined;

      if (existing) {
        if (matchesIdempotentAppend(existing, input)) {
          return ok({
            currentRevision: existing.revision - 1,
            expectedRevision: input.expectedRevision ?? existing.revision - 1,
            revisionKey: documentRevisionKey(
              input.tenantId,
              input.collection,
              input.documentId,
            ),
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

    const revisionKey = documentRevisionKey(
      input.tenantId,
      input.collection,
      input.documentId,
    );
    const currentRevision = revisions.get(revisionKey) ?? 0;
    const expectedRevision = input.expectedRevision ?? currentRevision;

    if (input.type === "collection.created" && currentRevision > 0) {
      return err({
        kind: "duplicate-collection",
        collection: input.collection,
        tenantId: input.tenantId,
      });
    }

    if (
      input.type === "document.upserted" &&
      expectedRevision === 0 &&
      currentRevision > 0
    ) {
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

  function getCollection(tenantId: string, name: string): StoredCollection {
    const collection = collections.get(collectionKey(tenantId, name));
    if (!collection) {
      throw new DatabaseNotFoundError(
        `Collection "${name}" does not exist for tenant "${tenantId}".`,
      );
    }

    return collection;
  }

  function applyCollectionCreated(
    event: DatabaseEvent<DatabaseCollectionCreatedPayload>,
  ): void {
    const key = collectionKey(event.tenantId, event.collection);
    if (collections.has(key)) {
      throw new DatabaseConflictError(
        `Collection "${event.collection}" already exists for tenant "${event.tenantId}".`,
      );
    }

    collections.set(key, {
      meta: {
        name: event.collection,
        tenantId: event.tenantId,
        surface: event.payload.surface,
        createdAt: new Date(event.timestamp),
        documentCount: 0,
        metadata: event.payload.metadata
          ? cloneRecord(event.payload.metadata)
          : undefined,
      },
      documents: new Map(),
    });
  }

  function applyDocumentUpserted(
    event: DatabaseEvent<DatabaseDocumentUpsertedPayload>,
  ): void {
    const collection = getCollection(event.tenantId, event.collection);
    const documentId = event.documentId;

    if (!documentId) {
      throw new DatabaseValidationError(
        "A document.upserted event requires a document ID.",
      );
    }

    const current = collection.documents.get(documentId);
    const next: DatabaseDocument = current
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

  function applyDocumentDeleted(
    event: DatabaseEvent<DatabaseDocumentDeletedPayload>,
  ): void {
    const documentId = event.documentId;
    if (!documentId) {
      throw new DatabaseValidationError(
        "A document.deleted event requires a document ID.",
      );
    }

    const collection = getCollection(event.tenantId, event.collection);
    collection.documents.delete(documentId);
    collection.meta.documentCount = collection.documents.size;
  }

  function applyEvent(event: DatabaseEvent): void {
    if (event.type === "collection.created") {
      applyCollectionCreated(
        event as DatabaseEvent<DatabaseCollectionCreatedPayload>,
      );
      return;
    }

    if (event.type === "document.upserted") {
      applyDocumentUpserted(
        event as DatabaseEvent<DatabaseDocumentUpsertedPayload>,
      );
      return;
    }

    applyDocumentDeleted(
      event as DatabaseEvent<DatabaseDocumentDeletedPayload>,
    );
  }

  const projections: DatabaseProjectionDriver = {
    async getCollection(input) {
      const collection = collections.get(
        collectionKey(input.tenantId, input.name),
      );
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

    async findDocumentById(input: TenantScoped<FindDocumentByIdInput>) {
      const collection = getCollection(input.tenantId, input.collection);
      const document = collection.documents.get(input.id);
      return document ? cloneDocument(document) : null;
    },

    async findDocuments(
      input: TenantScoped<FindDocumentsInput> & {
        where: NonNullable<FindDocumentsInput["where"]>;
        orderBy: NonNullable<FindDocumentsInput["orderBy"]>;
        limit: number;
        offset: number;
      },
    ) {
      const collection = getCollection(input.tenantId, input.collection);
      const filtered = [...collection.documents.values()].filter((document) =>
        input.where.every((filter) => matchesFilter(document, filter)),
      );
      const sorted = sortDocuments(filtered, input.orderBy);
      return sorted
        .slice(input.offset, input.offset + input.limit)
        .map((document) => cloneDocument(document));
    },
  };

  const eventDriver: DatabaseEventDriver = {
    async append<TPayload extends DatabaseEventPayload>(
      input: TenantScoped<DatabaseAppendEventInput<TPayload>>,
    ) {
      const preflight = preflightAppend(input);

      if (!preflight.ok) {
        throw toAppendError(preflight.error);
      }

      if (input.idempotencyKey) {
        const existing = eventsByIdempotencyKey.get(
          idempotencyKey(input.tenantId, input.idempotencyKey),
        ) as DatabaseEvent<TPayload> | undefined;

        if (existing && matchesIdempotentAppend(existing, input)) {
          return cloneEvent(existing);
        }
      }

      const event: DatabaseEvent<TPayload> = {
        cursor: encodeDatabaseEventCursor(++sequence),
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
        payload: JSON.parse(JSON.stringify(input.payload)) as TPayload,
      };

      applyEvent(event);
      revisions.set(preflight.value.revisionKey, event.revision);
      events.push(event);

      if (input.idempotencyKey) {
        eventsByIdempotencyKey.set(
          idempotencyKey(input.tenantId, input.idempotencyKey),
          event,
        );
      }

      return cloneEvent(event);
    },

    async restore<TPayload extends DatabaseEventPayload>(input: TenantScoped<
      DatabaseAppendEventInput<TPayload>
    > & {
      eventId: string;
      revision: number;
      timestamp: string;
    }) {
      const existing = events.find((event) => event.eventId === input.eventId) as
        | DatabaseEvent<TPayload>
        | undefined;
      if (existing) {
        if (
          existing.tenantId === input.tenantId &&
          existing.nodeId === (input.nodeId ?? "local") &&
          existing.revision === input.revision &&
          existing.timestamp === input.timestamp &&
          existing.idempotencyKey === input.idempotencyKey &&
          matchesIdempotentAppend(existing, {
            ...input,
            expectedRevision: input.revision - 1,
          })
        ) {
          return cloneEvent(existing);
        }
        throw new DatabaseConflictError(
          `Restored event "${input.eventId}" already exists with different data.`,
        );
      }

      const appendInput = {
        ...input,
        expectedRevision: input.revision - 1,
      };
      const preflight = preflightAppend(appendInput);
      if (!preflight.ok) throw toAppendError(preflight.error);

      const event: DatabaseEvent<TPayload> = {
        cursor: encodeDatabaseEventCursor(++sequence),
        eventId: input.eventId,
        idempotencyKey: input.idempotencyKey,
        nodeId: input.nodeId ?? "local",
        tenantId: input.tenantId,
        collection: input.collection,
        documentId: input.documentId,
        type: input.type,
        revision: input.revision,
        timestamp: input.timestamp,
        schemaVersion: input.schemaVersion ?? 1,
        payload: JSON.parse(JSON.stringify(input.payload)) as TPayload,
      };

      applyEvent(event);
      revisions.set(preflight.value.revisionKey, event.revision);
      events.push(event);
      if (input.idempotencyKey) {
        eventsByIdempotencyKey.set(
          idempotencyKey(input.tenantId, input.idempotencyKey),
          event,
        );
      }
      return cloneEvent(event);
    },

    async read(input: TenantScoped<ReadDatabaseEventsInput>) {
      const afterPosition = input.after
        ? decodeDatabaseEventCursor(input.after).position
        : 0;
      const limit = input.limit ?? 100;

      return events
        .filter((event) => event.tenantId === input.tenantId)
        .filter(
          (event) => !input.collection || event.collection === input.collection,
        )
        .filter(
          (event) => !input.documentId || event.documentId === input.documentId,
        )
        .filter(
          (event) =>
            decodeDatabaseEventCursor(event.cursor).position > afterPosition,
        )
        .slice(0, limit)
        .map((event) => cloneEvent(event));
    },
  };

  const schemaDriver: DatabaseSchemaStorageDriver = {
    async list() {
      return [...schemas.values()]
        .flatMap((versions) => [...versions.values()])
        .sort((left, right) => {
          const collectionOrder = left.collection.localeCompare(right.collection);
          return collectionOrder !== 0 ? collectionOrder : left.version - right.version;
        })
        .map((schema) => ({ ...schema, fields: [...schema.fields] }));
    },

    async save(schema: StoredCollectionSchema) {
      const versions =
        schemas.get(schema.collection) ?? new Map<number, StoredCollectionSchema>();
      const existing = versions.get(schema.version);
      versions.set(schema.version, {
        collection: schema.collection,
        version: schema.version,
        fields: [...schema.fields],
        active: existing?.active ?? schema.active,
      });
      schemas.set(schema.collection, versions);
    },

    async activate(collection: string, version: number) {
      const versions = schemas.get(collection);
      const schema = versions?.get(version);
      if (!versions || !schema) {
        throw new DatabaseNotFoundError(
          `Schema version ${version} for collection "${collection}" is not registered.`,
        );
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
      transactions: false,
      tenantRouting: true,
    },
    events: eventDriver,
    projections,
    schemas: schemaDriver,
  });
}
