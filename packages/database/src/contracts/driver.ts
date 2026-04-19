import type {
  CreateCollectionInput,
  DatabaseCollection,
  DatabaseDocument,
  DeleteDocumentInput,
  FindDocumentByIdInput,
  FindDocumentsInput,
  InsertDocumentInput,
  ListCollectionsInput,
  UpdateDocumentInput,
} from "./documents.js";
import type { DatabaseJsonObject } from "./json.js";
import type { SqlDatabase } from "./sql.js";

type TenantScoped<TInput extends { tenantId?: string }> = Omit<TInput, "tenantId"> & {
  tenantId: string;
};

export interface DatabaseCapabilities {
  documents: true;
  sql: boolean;
  transactions: boolean;
  tenantRouting: boolean;
}

export interface DatabaseDocumentDriver {
  createCollection(input: TenantScoped<CreateCollectionInput>): Promise<DatabaseCollection>;
  listCollections(input: TenantScoped<ListCollectionsInput>): Promise<DatabaseCollection[]>;
  collectionExists(input: TenantScoped<ListCollectionsInput> & { name: string }): Promise<boolean>;
  insertDocument<TData extends DatabaseJsonObject>(
    input: TenantScoped<InsertDocumentInput<TData>>,
  ): Promise<DatabaseDocument<TData>>;
  findDocumentById(input: TenantScoped<FindDocumentByIdInput>): Promise<DatabaseDocument | null>;
  findDocuments(
    input: TenantScoped<FindDocumentsInput> & {
      where: NonNullable<FindDocumentsInput["where"]>;
      orderBy: NonNullable<FindDocumentsInput["orderBy"]>;
      limit: number;
      offset: number;
    },
  ): Promise<DatabaseDocument[]>;
  updateDocument<TData extends DatabaseJsonObject>(
    input: TenantScoped<UpdateDocumentInput<TData>> & {
      mode: NonNullable<UpdateDocumentInput["mode"]>;
    },
  ): Promise<DatabaseDocument<TData>>;
  deleteDocument(input: TenantScoped<DeleteDocumentInput>): Promise<boolean>;
}

export interface DatabaseDriver {
  name: string;
  capabilities: DatabaseCapabilities;
  documents: DatabaseDocumentDriver;
  sql?: SqlDatabase;
}
