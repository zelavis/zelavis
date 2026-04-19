import type { DatabaseDocumentDriver } from "../contracts/driver.js";
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
    private readonly driver: DatabaseDocumentDriver,
    private readonly defaultTenantId: string,
  ) {}

  createCollection(input: CreateCollectionInput): Promise<DatabaseCollection> {
    return this.driver.createCollection(withTenantId(input, this.defaultTenantId));
  }

  listCollections(input: ListCollectionsInput = {}): Promise<DatabaseCollection[]> {
    return this.driver.listCollections(withTenantId(input, this.defaultTenantId));
  }

  collectionExists(input: ListCollectionsInput & { name: string }): Promise<boolean> {
    return this.driver.collectionExists(withTenantId(input, this.defaultTenantId));
  }

  insert<TData extends DatabaseJsonObject>(
    input: InsertDocumentInput<TData>,
  ): Promise<DatabaseDocument<TData>> {
    return this.driver.insertDocument({
      ...withTenantId(input, this.defaultTenantId),
      id: input.id ?? "",
    });
  }

  findById(input: FindDocumentByIdInput): Promise<DatabaseDocument | null> {
    return this.driver.findDocumentById(withTenantId(input, this.defaultTenantId));
  }

  findMany(input: FindDocumentsInput): Promise<DatabaseDocument[]> {
    return this.driver.findDocuments({
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
    return this.driver.updateDocument({
      ...withTenantId(input, this.defaultTenantId),
      mode: input.mode ?? "merge",
    });
  }

  delete(input: DeleteDocumentInput): Promise<boolean> {
    return this.driver.deleteDocument(withTenantId(input, this.defaultTenantId));
  }
}
