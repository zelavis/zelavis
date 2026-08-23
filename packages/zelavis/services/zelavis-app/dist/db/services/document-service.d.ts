import type { DatabaseDocumentsApi } from "../contracts/api.js";
import type { DatabaseProjectionDriver } from "../contracts/driver.js";
import { type CreateCollectionInput, type DatabaseCollection, type DatabaseDocument, type DeleteDocumentInput, type FindDocumentByIdInput, type FindDocumentsInput, type InsertDocumentInput, type ListCollectionsInput, type UpdateDocumentInput } from "../contracts/documents.js";
import type { DatabaseJsonObject } from "../contracts/json.js";
import type { EventService } from "./event-service.js";
import type { SchemaService } from "./schema-service.js";
export declare class DocumentService implements DatabaseDocumentsApi {
    private readonly events;
    private readonly schemas;
    private readonly projections;
    private readonly defaultTenantId;
    private readonly defaultNodeId;
    constructor(events: EventService, schemas: SchemaService, projections: DatabaseProjectionDriver, defaultTenantId: string, defaultNodeId: string);
    private validateDocument;
    private createDocumentId;
    createCollection(input: CreateCollectionInput): Promise<DatabaseCollection>;
    listCollections(input?: ListCollectionsInput): Promise<DatabaseCollection[]>;
    collectionExists(input: ListCollectionsInput & {
        name: string;
    }): Promise<boolean>;
    insert<TData extends DatabaseJsonObject>(input: InsertDocumentInput<TData>): Promise<DatabaseDocument<TData>>;
    findById(input: FindDocumentByIdInput): Promise<DatabaseDocument | null>;
    findMany(input: FindDocumentsInput): Promise<DatabaseDocument[]>;
    update<TData extends DatabaseJsonObject>(input: UpdateDocumentInput<TData>): Promise<DatabaseDocument<TData>>;
    delete(input: DeleteDocumentInput): Promise<boolean>;
}
