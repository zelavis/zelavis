import type { DatabaseCollection, DatabaseCollectionSurface, DatabaseTenantId } from "./documents.js";
import type { DatabaseJsonObject } from "./json.js";
import { DatabaseConflictError } from "../core/errors.js";

export type DatabaseEventType =
  | "collection.created"
  | "document.upserted"
  | "document.deleted";

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
  sequence: number;
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
  tenantId?: DatabaseTenantId;
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
  tenantId?: DatabaseTenantId;
  collection?: string;
  documentId?: string;
  afterSequence?: number;
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
