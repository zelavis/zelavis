import type { DatabaseJsonObject } from "./json.js";
import { DatabaseDomainError } from "../core/errors.js";

export type DatabaseSchemaPrimitiveType =
  | "string"
  | "number"
  | "boolean"
  | "null";

export type DatabaseSchemaUiControl = "text" | "textarea" | "rich-text";
export type DatabaseSchemaUiEditor = "lexical";

export interface DatabaseSchemaUiDefinition {
  control?: DatabaseSchemaUiControl;
  editor?: DatabaseSchemaUiEditor;
  placeholder?: string;
  rows?: number;
  helpText?: string;
}

export interface DatabaseSchemaBaseDefinition {
  label?: string;
  description?: string;
  ui?: DatabaseSchemaUiDefinition;
}

export interface DatabaseStringSchemaDefinition extends DatabaseSchemaBaseDefinition {
  type: "string";
  minLength?: number;
  maxLength?: number;
  enum?: readonly string[];
  format?: string;
}

export interface DatabaseNumberSchemaDefinition extends DatabaseSchemaBaseDefinition {
  type: "number";
  integer?: boolean;
  minimum?: number;
  maximum?: number;
}

export interface DatabaseBooleanSchemaDefinition extends DatabaseSchemaBaseDefinition {
  type: "boolean";
}

export interface DatabaseNullSchemaDefinition extends DatabaseSchemaBaseDefinition {
  type: "null";
}

export interface DatabaseFileSchemaDefinition extends DatabaseSchemaBaseDefinition {
  type: "file";
  mimeTypes?: readonly string[];
  maxSize?: number;
}

export interface DatabaseArraySchemaDefinition extends DatabaseSchemaBaseDefinition {
  type: "array";
  items: DatabaseSchemaDefinition;
  minItems?: number;
  maxItems?: number;
}

export interface DatabaseObjectSchemaDefinition extends DatabaseSchemaBaseDefinition {
  type: "object";
  properties?: Record<string, DatabaseSchemaDefinition>;
  required?: readonly string[];
  additionalProperties?: boolean;
}

export type DatabaseSchemaDefinition =
  | DatabaseStringSchemaDefinition
  | DatabaseNumberSchemaDefinition
  | DatabaseBooleanSchemaDefinition
  | DatabaseNullSchemaDefinition
  | DatabaseFileSchemaDefinition
  | DatabaseArraySchemaDefinition
  | DatabaseObjectSchemaDefinition;

export interface DatabaseSchemaValidationIssue {
  path: string;
  message: string;
}

export interface DatabaseSchemaValidationSuccess {
  valid: true;
  issues: [];
}

export interface DatabaseSchemaValidationFailure {
  valid: false;
  issues: DatabaseSchemaValidationIssue[];
}

export type DatabaseSchemaValidationResult =
  | DatabaseSchemaValidationSuccess
  | DatabaseSchemaValidationFailure;

export type DatabaseSchemaValidator<
  TData extends DatabaseJsonObject = DatabaseJsonObject,
> = (input: TData) => void | DatabaseSchemaValidationResult;

export interface DatabaseCollectionSchema<
  TData extends DatabaseJsonObject = DatabaseJsonObject,
> {
  collection: string;
  version: number;
  document: DatabaseObjectSchemaDefinition;
  activate?: boolean;
  metadata?: Record<string, unknown>;
  validate?: DatabaseSchemaValidator<TData>;
}

export interface DatabaseStoredCollectionSchema {
  collection: string;
  version: number;
  document: DatabaseObjectSchemaDefinition;
  metadata?: Record<string, unknown>;
  active: boolean;
}

export interface DatabaseCollectionSchemaSummary {
  collection: string;
  activeVersion: number | null;
  versions: number[];
}

export interface ValidateDatabaseDocumentInput<
  TData extends DatabaseJsonObject = DatabaseJsonObject,
> {
  collection: string;
  data: TData;
  version?: number;
}

export interface ValidateDatabaseDocumentResult {
  schema: DatabaseCollectionSchema | null;
  schemaVersion: number;
  validation: DatabaseSchemaValidationResult;
}

export class DatabaseSchemaValidationError extends DatabaseDomainError {
  readonly collection: string;
  readonly schemaVersion: number;
  readonly issues: DatabaseSchemaValidationIssue[];

  constructor(input: {
    collection: string;
    schemaVersion: number;
    issues: DatabaseSchemaValidationIssue[];
  }) {
    super(
      `Schema validation failed for collection "${input.collection}" version ${input.schemaVersion}: ${input.issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join(", ")}`,
    );
    this.name = "DatabaseSchemaValidationError";
    this.collection = input.collection;
    this.schemaVersion = input.schemaVersion;
    this.issues = input.issues;
  }
}
