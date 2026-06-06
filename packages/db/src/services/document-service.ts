import type { DatabaseDocumentsApi } from "../contracts/api.js";
import type { DatabaseProjectionDriver } from "../contracts/driver.js";
import {
  validateDatabaseCollectionName,
  type CreateCollectionInput,
  type DatabaseCollection,
  type DatabaseDocument,
  type DeleteDocumentInput,
  type FindDocumentByIdInput,
  type FindDocumentsInput,
  type InsertDocumentInput,
  type ListCollectionsInput,
  type UpdateDocumentInput,
} from "../contracts/documents.js";
import type { DatabaseDocumentUpsertedPayload } from "../contracts/events.js";
import type { DatabaseJsonObject } from "../contracts/json.js";
import { DatabaseSchemaValidationError } from "../contracts/schemas.js";
import { DatabaseNotFoundError } from "../core/errors.js";
import type { EventService } from "./event-service.js";
import type { SchemaService } from "./schema-service.js";

function withTenantId<TInput extends { tenantId?: string }>(
  input: TInput,
  defaultTenantId: string,
): TInput & { tenantId: string } {
  return {
    ...input,
    tenantId: input.tenantId ?? defaultTenantId,
  };
}

export class DocumentService implements DatabaseDocumentsApi {
  constructor(
    private readonly events: EventService,
    private readonly schemas: SchemaService,
    private readonly projections: DatabaseProjectionDriver,
    private readonly defaultTenantId: string,
    private readonly defaultNodeId: string,
  ) {}

  private validateDocument<TData extends DatabaseJsonObject>(
    collection: string,
    data: TData,
  ): number {
    const result = this.schemas.validate({
      collection,
      data,
    });

    if (!result.validation.valid) {
      throw new DatabaseSchemaValidationError({
        collection,
        schemaVersion: result.schemaVersion,
        issues: result.validation.issues,
      });
    }

    return result.schemaVersion;
  }

  private createDocumentId(): string {
    if (typeof globalThis.crypto?.randomUUID === "function") {
      return `doc_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
    }

    return `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  createCollection(input: CreateCollectionInput): Promise<DatabaseCollection> {
    const resolved = withTenantId(input, this.defaultTenantId);
    validateDatabaseCollectionName(resolved.name);

    const metadata: Record<string, unknown> = {
      ...(resolved.metadata ?? {}),
      ...(resolved.surface ? { surface: resolved.surface } : {}),
    };

    return this.events
      .append({
        tenantId: resolved.tenantId,
        nodeId: this.defaultNodeId,
        collection: resolved.name,
        type: "collection.created",
        expectedRevision: 0,
        payload: {
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        },
      })
      .then(async () => {
        const collection = await this.projections.getCollection({
          tenantId: resolved.tenantId,
          name: resolved.name,
        });

        if (!collection) {
          throw new Error(`Collection "${resolved.name}" was not created.`);
        }

        return collection;
      });
  }

  listCollections(
    input: ListCollectionsInput = {},
  ): Promise<DatabaseCollection[]> {
    return this.projections.listCollections(
      withTenantId(input, this.defaultTenantId),
    );
  }

  collectionExists(
    input: ListCollectionsInput & { name: string },
  ): Promise<boolean> {
    return this.projections.collectionExists(
      withTenantId(input, this.defaultTenantId),
    );
  }

  insert<TData extends DatabaseJsonObject>(
    input: InsertDocumentInput<TData>,
  ): Promise<DatabaseDocument<TData>> {
    const resolved = withTenantId(input, this.defaultTenantId);
    validateDatabaseCollectionName(resolved.collection);
    const id =
      resolved.id && resolved.id.length > 0
        ? resolved.id
        : this.createDocumentId();
    const schemaVersion = this.validateDocument(
      resolved.collection,
      resolved.data,
    );

    return this.events
      .append<DatabaseDocumentUpsertedPayload<TData>>({
        tenantId: resolved.tenantId,
        nodeId: this.defaultNodeId,
        collection: resolved.collection,
        documentId: id,
        type: "document.upserted",
        expectedRevision: 0,
        schemaVersion,
        payload: {
          data: resolved.data,
        },
      })
      .then(async () => {
        const document = await this.projections.findDocumentById({
          tenantId: resolved.tenantId,
          collection: resolved.collection,
          id,
        });

        if (!document) {
          throw new Error(`Document "${id}" was not created.`);
        }

        return document as DatabaseDocument<TData>;
      });
  }

  findById(input: FindDocumentByIdInput): Promise<DatabaseDocument | null> {
    validateDatabaseCollectionName(input.collection);
    return this.projections.findDocumentById(
      withTenantId(input, this.defaultTenantId),
    );
  }

  findMany(input: FindDocumentsInput): Promise<DatabaseDocument[]> {
    validateDatabaseCollectionName(input.collection);
    return this.projections.findDocuments({
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
    const resolved = withTenantId(input, this.defaultTenantId);
    validateDatabaseCollectionName(resolved.collection);

    return this.projections
      .findDocumentById({
        tenantId: resolved.tenantId,
        collection: resolved.collection,
        id: resolved.id,
      })
      .then(async (current) => {
        if (!current) {
          throw new DatabaseNotFoundError(
            `Document "${resolved.id}" does not exist in collection "${resolved.collection}".`,
          );
        }

        const nextData =
          (resolved.mode ?? "merge") === "replace"
            ? (resolved.data as TData)
            : ({
                ...(current.data as DatabaseJsonObject),
                ...(resolved.data as DatabaseJsonObject),
              } as TData);
        const schemaVersion = this.validateDocument(
          resolved.collection,
          nextData,
        );

        await this.events.append<DatabaseDocumentUpsertedPayload<TData>>({
          tenantId: resolved.tenantId,
          nodeId: this.defaultNodeId,
          collection: resolved.collection,
          documentId: resolved.id,
          type: "document.upserted",
          expectedRevision: current.version,
          schemaVersion,
          payload: {
            data: nextData,
          },
        });

        const next = await this.projections.findDocumentById({
          tenantId: resolved.tenantId,
          collection: resolved.collection,
          id: resolved.id,
        });

        if (!next) {
          throw new Error(`Document "${resolved.id}" was not updated.`);
        }

        return next as DatabaseDocument<TData>;
      });
  }

  delete(input: DeleteDocumentInput): Promise<boolean> {
    const resolved = withTenantId(input, this.defaultTenantId);
    validateDatabaseCollectionName(resolved.collection);

    return this.projections
      .findDocumentById({
        tenantId: resolved.tenantId,
        collection: resolved.collection,
        id: resolved.id,
      })
      .then(async (current) => {
        if (!current) {
          return false;
        }

        await this.events.append({
          tenantId: resolved.tenantId,
          nodeId: this.defaultNodeId,
          collection: resolved.collection,
          documentId: resolved.id,
          type: "document.deleted",
          expectedRevision: current.version,
          schemaVersion: current.schemaVersion,
          payload: {
            deleted: true,
          },
        });

        return true;
      });
  }
}
