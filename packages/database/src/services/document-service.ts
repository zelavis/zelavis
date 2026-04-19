import type { DatabaseDocumentAdapter } from "../contracts/adapter.js";
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
} from "../contracts/documents.js";
import type { DatabaseJsonObject } from "../contracts/json.js";

function withTenantId<TInput extends { tenantId?: string }>(
  input: TInput,
  defaultTenantId: string,
): TInput & { tenantId: string } {
  return {
    ...input,
    tenantId: input.tenantId ?? defaultTenantId,
  };
}

export class DocumentService {
  constructor(
    private readonly adapter: DatabaseDocumentAdapter,
    private readonly defaultTenantId: string,
  ) {}

  createCollection(input: CreateCollectionInput): Promise<DatabaseCollection> {
    return this.adapter.createCollection(withTenantId(input, this.defaultTenantId));
  }

  listCollections(input: ListCollectionsInput = {}): Promise<DatabaseCollection[]> {
    return this.adapter.listCollections(withTenantId(input, this.defaultTenantId));
  }

  collectionExists(input: ListCollectionsInput & { name: string }): Promise<boolean> {
    return this.adapter.collectionExists(withTenantId(input, this.defaultTenantId));
  }

  insert<TData extends DatabaseJsonObject>(
    input: InsertDocumentInput<TData>,
  ): Promise<DatabaseDocument<TData>> {
    return this.adapter.insertDocument({
      ...withTenantId(input, this.defaultTenantId),
      id: input.id ?? "",
    });
  }

  findById(input: FindDocumentByIdInput): Promise<DatabaseDocument | null> {
    return this.adapter.findDocumentById(withTenantId(input, this.defaultTenantId));
  }

  findMany(input: FindDocumentsInput): Promise<DatabaseDocument[]> {
    return this.adapter.findDocuments({
      ...withTenantId(input, this.defaultTenantId),
      where: input.where ?? [],
      orderBy: input.orderBy ?? [],
      limit: input.limit ?? 100,
      offset: input.offset ?? 0,
    });
  }

  update<TData extends DatabaseJsonObject>(
    input: UpdateDocumentInput<TData>,
  ): Promise<DatabaseDocument<TData>> {
    return this.adapter.updateDocument({
      ...withTenantId(input, this.defaultTenantId),
      mode: input.mode ?? "merge",
    });
  }

  delete(input: DeleteDocumentInput): Promise<boolean> {
    return this.adapter.deleteDocument(withTenantId(input, this.defaultTenantId));
  }
}
