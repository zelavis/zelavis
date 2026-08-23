import { Schema } from "effect";
import type { DatabaseJsonObject } from "../contracts/json.js";
import { type CollectionFieldEntry } from "./field-types.js";
export interface CollectionSchema {
    collection: string;
    version: number;
    activate?: boolean;
    fields: readonly CollectionFieldEntry[];
}
export interface StoredCollectionSchema {
    collection: string;
    version: number;
    active: boolean;
    fields: readonly CollectionFieldEntry[];
}
export interface CollectionSchemaSummary {
    collection: string;
    activeVersion: number | null;
    versions: readonly number[];
}
export interface SchemaValidationIssue {
    path: string;
    message: string;
}
export interface SchemaValidationResult {
    schemaVersion: number;
    valid: boolean;
    issues: readonly SchemaValidationIssue[];
}
export declare const StoredCollectionSchemaCodec: Schema.Struct<{
    readonly collection: Schema.String;
    readonly version: Schema.Number;
    readonly active: Schema.Boolean;
    readonly fields: Schema.$Array<Schema.Codec<CollectionFieldEntry, CollectionFieldEntry, never, never>>;
}>;
export declare function validateDocumentData(fields: readonly CollectionFieldEntry[], data: DatabaseJsonObject): {
    valid: boolean;
    issues: readonly SchemaValidationIssue[];
};
