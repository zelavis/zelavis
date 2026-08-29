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
import { DatabaseSchemaValidationError } from "../core/errors.js";
import { DatabaseNotFoundError } from "../core/errors.js";
import type { EventService } from "./event-service.js";
import type { SchemaService } from "./schema-service.js";

export class DocumentService implements DatabaseDocumentsApi {
  constructor(
    private readonly events: EventService,
    private readonly schemas: SchemaService,
    private readonly projections: DatabaseProjectionDriver,
    private readonly tenantId: string,
    private readonly defaultNodeId: string,
  ) {}

  private validateDocument<TData extends DatabaseJsonObject>(
    collection: string,
    data: TData,
  ): number {
    const result = this.schemas.validate(collection, data);

    if (!result.valid) {
      throw new DatabaseSchemaValidationError({
        collection,
        schemaVersion: result.schemaVersion,
        issues: result.issues,
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
    validateDatabaseCollectionName(input.name);

    return this.events
      .append({
        nodeId: this.defaultNodeId,
        collection: input.name,
        type: "collection.created",
        expectedRevision: 0,
        payload: {
          surface: input.surface,
          metadata: input.metadata && Object.keys(input.metadata).length > 0
            ? input.metadata
            : undefined,
        },
      })
      .then(async () => {
        const collection = await this.projections.getCollection({
          tenantId: this.tenantId,
          name: input.name,
        });

        if (!collection) {
          throw new Error(`Collection "${input.name}" was not created.`);
        }

        return collection;
      });
  }

  listCollections(
    input: ListCollectionsInput = {},
  ): Promise<DatabaseCollection[]> {
    return this.projections.listCollections({ ...input, tenantId: this.tenantId });
  }

  collectionExists(
    input: ListCollectionsInput & { name: string },
  ): Promise<boolean> {
    return this.projections.collectionExists({ ...input, tenantId: this.tenantId });
  }

  insert<TData extends DatabaseJsonObject>(
    input: InsertDocumentInput<TData>,
  ): Promise<DatabaseDocument<TData>> {
    const resolved = input;
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
          tenantId: this.tenantId,
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
    return this.projections.findDocumentById({ ...input, tenantId: this.tenantId });
  }

  findMany(input: FindDocumentsInput): Promise<DatabaseDocument[]> {
    validateDatabaseCollectionName(input.collection);
    return this.projections.findDocuments({
      ...input,
      tenantId: this.tenantId,
      where: input.where ?? [],
      orderBy: input.orderBy ?? [],
      limit: input.limit ?? 100,
      offset: input.offset ?? 0,
    });
  }

  update<TData extends DatabaseJsonObject>(
    input: UpdateDocumentInput<TData>,
  ): Promise<DatabaseDocument<TData>> {
    const resolved = input;
    validateDatabaseCollectionName(resolved.collection);

    return this.projections
      .findDocumentById({
        tenantId: this.tenantId,
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
          nodeId: this.defaultNodeId,
          collection: resolved.collection,
          documentId: resolved.id,
          type: "document.upserted",
          expectedRevision: resolved.expectedVersion ?? current.version,
          schemaVersion,
          payload: {
            data: nextData,
          },
        });

        const next = await this.projections.findDocumentById({
          tenantId: this.tenantId,
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
    const resolved = input;
    validateDatabaseCollectionName(resolved.collection);

    return this.projections
      .findDocumentById({
        tenantId: this.tenantId,
        collection: resolved.collection,
        id: resolved.id,
      })
      .then(async (current) => {
        if (!current) {
          return false;
        }

        await this.events.append({
          nodeId: this.defaultNodeId,
          collection: resolved.collection,
          documentId: resolved.id,
          type: "document.deleted",
          expectedRevision: resolved.expectedVersion ?? current.version,
          schemaVersion: current.schemaVersion,
          payload: {
            deleted: true,
          },
        });

        return true;
      });
  }
}
