import type { DatabaseJson, DatabaseJsonObject } from "./json.js";

export type DatabaseTenantId = string;

export interface DatabaseCollection {
  name: string;
  tenantId: DatabaseTenantId;
  createdAt: Date;
  documentCount: number;
  metadata?: Record<string, unknown>;
}

export interface DatabaseDocument<TData extends DatabaseJsonObject = DatabaseJsonObject> {
  id: string;
  tenantId: DatabaseTenantId;
  collection: string;
  data: TData;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface CreateCollectionInput {
  tenantId?: DatabaseTenantId;
  name: string;
  metadata?: Record<string, unknown>;
}

export interface ListCollectionsInput {
  tenantId?: DatabaseTenantId;
}

export interface InsertDocumentInput<TData extends DatabaseJsonObject = DatabaseJsonObject> {
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

export type DatabaseFilterOperator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in";

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

export interface UpdateDocumentInput<TData extends DatabaseJsonObject = DatabaseJsonObject> {
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
