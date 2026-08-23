import type { DatabaseSchemasApi } from "../contracts/api.js";
import type { DatabaseSchemaStorageDriver } from "../contracts/driver.js";
import type { DatabaseJsonObject } from "../contracts/json.js";
import { type CollectionSchema, type CollectionSchemaSummary, type SchemaValidationResult, type StoredCollectionSchema } from "../schema/index.js";
export declare class SchemaService implements DatabaseSchemasApi {
    private readonly storage?;
    private readonly schemasByCollection;
    private readonly activeVersions;
    constructor(storage?: DatabaseSchemaStorageDriver | undefined);
    hydrate(): Promise<void>;
    private storeLocally;
    save(input: CollectionSchema): Promise<StoredCollectionSchema>;
    listCollections(): CollectionSchemaSummary[];
    listVersions(collection: string): StoredCollectionSchema[];
    getVersion(collection: string, version: number): StoredCollectionSchema | null;
    getActive(collection: string): StoredCollectionSchema | null;
    activate(collection: string, version: number): Promise<StoredCollectionSchema>;
    validate(collection: string, data: DatabaseJsonObject): SchemaValidationResult;
}
