import type { DatabaseJson, DatabaseJsonObject } from "./json.js";

export type DatabaseTenantId = string;

export interface DatabaseFileReference {
  kind: "file";
  path: string;
  href: string;
  metadataHref: string;
  size?: number;
  updatedAt?: string;
  contentType?: string;
  metadata?: Record<string, string>;
  checksum?: string;
}

export type DatabaseCollectionSurface = "content-studio";

export interface DatabaseCollection {
  name: string;
  tenantId: DatabaseTenantId;
  createdAt: Date;
  documentCount: number;
  surface?: DatabaseCollectionSurface;
  metadata?: Record<string, unknown>;
}

export interface DatabaseDocument<
  TData extends DatabaseJsonObject = DatabaseJsonObject,
> {
  id: string;
  tenantId: DatabaseTenantId;
  collection: string;
  data: TData;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  schemaVersion: number;
}

export interface CreateCollectionInput {
  tenantId?: DatabaseTenantId;
  name: string;
  surface?: DatabaseCollectionSurface;
  metadata?: Record<string, unknown>;
}

export interface ListCollectionsInput {
  tenantId?: DatabaseTenantId;
}

export interface InsertDocumentInput<
  TData extends DatabaseJsonObject = DatabaseJsonObject,
> {
  tenantId?: DatabaseTenantId;
  collection: string;
  id?: string;
  data: TData;
}

export interface FindDocumentByIdInput {
  tenantId?: DatabaseTenantId;
  collection: string;
  id: string;
}

export type DatabaseFilterOperator =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in";

export interface DatabaseDocumentFilter {
  path: string;
  op?: DatabaseFilterOperator;
  value: DatabaseJson | DatabaseJson[];
}

export interface DatabaseDocumentSort {
  path: string;
  direction?: "asc" | "desc";
}

export interface FindDocumentsInput {
  tenantId?: DatabaseTenantId;
  collection: string;
  where?: readonly DatabaseDocumentFilter[];
  orderBy?: readonly DatabaseDocumentSort[];
  limit?: number;
  offset?: number;
}

export interface UpdateDocumentInput<
  TData extends DatabaseJsonObject = DatabaseJsonObject,
> {
  tenantId?: DatabaseTenantId;
  collection: string;
  id: string;
  data: Partial<TData>;
  mode?: "merge" | "replace";
}

export interface DeleteDocumentInput {
  tenantId?: DatabaseTenantId;
  collection: string;
  id: string;
}

export const DATABASE_COLLECTION_NAME_PATTERN =
  /^[A-Za-z_][A-Za-z0-9_-]*$/;

export const DATABASE_RESERVED_COLLECTION_NAMES = new Set([
  "_collections",
  "_events",
  "_schemas",
  "_time_series_checkpoints",
  "_time_series_points",
  "collections",
  "events",
  "schemas",
  "time_series_checkpoints",
  "time_series_points",
]);

export function validateDatabaseCollectionName(name: string): void {
  if (!DATABASE_COLLECTION_NAME_PATTERN.test(name)) {
    throw new TypeError(
      "Collection names must start with a letter or underscore and contain only letters, numbers, underscores, or hyphens.",
    );
  }

  if (DATABASE_RESERVED_COLLECTION_NAMES.has(name)) {
    throw new TypeError(`Collection name "${name}" is reserved.`);
  }
}
