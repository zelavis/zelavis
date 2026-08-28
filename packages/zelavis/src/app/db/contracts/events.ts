import type { DatabaseCollection, DatabaseCollectionSurface, DatabaseTenantId } from "./documents.js";
import type { DatabaseJsonObject } from "./json.js";
import { DatabaseConflictError } from "../core/errors.js";

export type DatabaseEventType =
  | "collection.created"
  | "document.upserted"
  | "document.deleted";

declare const databaseEventCursorBrand: unique symbol;

/**
 * An opaque continuation token. Consumers must persist and return it unchanged;
 * its encoded position and shard identity are implementation details.
 */
export type DatabaseEventCursor = string & {
  readonly [databaseEventCursorBrand]: true;
};

export interface DecodedDatabaseEventCursor {
  readonly position: number;
  readonly virtualShardId?: string;
}

export function encodeDatabaseEventCursor(
  position: number,
  virtualShardId?: string,
): DatabaseEventCursor {
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new TypeError("Database event cursor position must be a non-negative safe integer.");
  }

  const shard = virtualShardId ? encodeURIComponent(virtualShardId) : "";
  return `zv1:${shard}:${position.toString(36)}` as DatabaseEventCursor;
}

export function decodeDatabaseEventCursor(
  cursor: DatabaseEventCursor,
): DecodedDatabaseEventCursor {
  const match = /^zv1:([^:]*):([0-9a-z]+)$/.exec(cursor);
  if (!match) throw new TypeError("Invalid database event cursor.");

  const position = Number.parseInt(match[2], 36);
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new TypeError("Invalid database event cursor position.");
  }

  return {
    position,
    ...(match[1]
      ? { virtualShardId: decodeURIComponent(match[1]) }
      : {}),
  };
}

export interface DatabaseCollectionCreatedPayload {
  surface?: DatabaseCollectionSurface;
  metadata?: DatabaseCollection["metadata"];
}

export interface DatabaseDocumentUpsertedPayload<
  TData extends DatabaseJsonObject = DatabaseJsonObject,
> {
  data: TData;
}

export interface DatabaseDocumentDeletedPayload {
  deleted: true;
}

export type DatabaseEventPayload =
  | DatabaseCollectionCreatedPayload
  | DatabaseDocumentUpsertedPayload
  | DatabaseDocumentDeletedPayload;

export interface DatabaseEvent<
  TPayload extends DatabaseEventPayload = DatabaseEventPayload,
> {
  cursor: DatabaseEventCursor;
  eventId: string;
  idempotencyKey?: string;
  nodeId: string;
  tenantId: DatabaseTenantId;
  collection: string;
  documentId?: string;
  type: DatabaseEventType;
  revision: number;
  timestamp: string;
  schemaVersion: number;
  payload: TPayload;
}

export interface DatabaseAppendEventInput<
  TPayload extends DatabaseEventPayload = DatabaseEventPayload,
> {
  nodeId?: string;
  idempotencyKey?: string;
  collection: string;
  documentId?: string;
  type: DatabaseEventType;
  expectedRevision?: number | null;
  schemaVersion?: number;
  payload: TPayload;
}

export interface ReadDatabaseEventsInput {
  collection?: string;
  documentId?: string;
  after?: DatabaseEventCursor;
  limit?: number;
}

export class DatabaseEventIdempotencyConflictError extends DatabaseConflictError {
  readonly tenantId: DatabaseTenantId;
  readonly idempotencyKey: string;
  readonly eventId: string;

  constructor(input: {
    tenantId: DatabaseTenantId;
    idempotencyKey: string;
    eventId: string;
  }) {
    super(
      `Idempotency key "${input.idempotencyKey}" for tenant "${input.tenantId}" is already bound to event "${input.eventId}" with different append input.`,
    );
    this.name = "DatabaseEventIdempotencyConflictError";
    this.tenantId = input.tenantId;
    this.idempotencyKey = input.idempotencyKey;
    this.eventId = input.eventId;
  }
}
