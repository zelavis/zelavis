import type { DatabaseSchemasApi } from "../contracts/api.js";
import type { DatabaseSchemaStorageDriver } from "../contracts/driver.js";
import type { DatabaseJsonObject } from "../contracts/json.js";
import type {
  DatabaseCollectionSchema,
  DatabaseCollectionSchemaSummary,
  DatabaseObjectSchemaDefinition,
  DatabaseSchemaDefinition,
  DatabaseSchemaValidationIssue,
  DatabaseSchemaValidationResult,
  DatabaseStoredCollectionSchema,
  ValidateDatabaseDocumentInput,
  ValidateDatabaseDocumentResult,
} from "../contracts/schemas.js";
import { DatabaseNotFoundError } from "../core/errors.js";
import { err, ok, type Result } from "../core/result.js";

function cloneDefinition<TDefinition extends DatabaseSchemaDefinition>(
  definition: TDefinition,
): TDefinition {
  if (definition.type === "object") {
    return {
      ...definition,
      properties: definition.properties
        ? Object.fromEntries(
            Object.entries(definition.properties).map(([key, value]) => [
              key,
              cloneDefinition(value),
            ]),
          )
        : undefined,
      required: definition.required ? [...definition.required] : undefined,
    } as TDefinition;
  }

  if (definition.type === "array") {
    return {
      ...definition,
      items: cloneDefinition(definition.items),
    } as TDefinition;
  }

  if (definition.type === "string") {
    return {
      ...definition,
      enum: definition.enum ? [...definition.enum] : undefined,
    } as TDefinition;
  }

  return { ...definition };
}

function cloneSchema<TSchema extends DatabaseCollectionSchema>(
  schema: TSchema,
): TSchema {
  return {
    ...schema,
    document: cloneDefinition(schema.document),
    metadata: schema.metadata ? { ...schema.metadata } : undefined,
  } as TSchema;
}

function cloneStoredSchema(
  schema: DatabaseStoredCollectionSchema,
): DatabaseStoredCollectionSchema {
  return {
    ...schema,
    document: cloneDefinition(schema.document),
    metadata: schema.metadata ? { ...schema.metadata } : undefined,
  };
}

function comparableSchema(schema: {
  collection: string;
  version: number;
  document: DatabaseObjectSchemaDefinition;
  metadata?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    collection: schema.collection,
    version: schema.version,
    document: schema.document,
    metadata: schema.metadata ?? null,
  });
}

function getValueType(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  return typeof value;
}

function isFileReference(value: unknown): value is {
  kind: "file";
  path: string;
  href: string;
  metadataHref: string;
  size?: number;
  updatedAt?: string;
  contentType?: string;
  metadata?: Record<string, string>;
  checksum?: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === "file" &&
    typeof candidate.path === "string" &&
    typeof candidate.href === "string" &&
    typeof candidate.metadataHref === "string"
  );
}

function validateDefinition(
  definition: DatabaseSchemaDefinition,
  value: unknown,
  path: string,
  issues: DatabaseSchemaValidationIssue[],
): void {
  const actualType = getValueType(value);

  if (definition.type === "file") {
    if (!isFileReference(value)) {
      issues.push({
        path,
        message: `must be file (received ${actualType})`,
      });
      return;
    }

    if (
      definition.maxSize !== undefined &&
      value.size !== undefined &&
      value.size > definition.maxSize
    ) {
      issues.push({
        path,
        message: `must be <= ${definition.maxSize} bytes`,
      });
    }

    if (
      definition.mimeTypes &&
      value.contentType &&
      !definition.mimeTypes.includes(value.contentType)
    ) {
      issues.push({
        path,
        message: `must use one of ${definition.mimeTypes.join(", ")}`,
      });
    }

    return;
  }

  if (actualType !== definition.type) {
    issues.push({
      path,
      message: `must be ${definition.type} (received ${actualType})`,
    });
    return;
  }

  if (definition.type === "string") {
    const stringValue = value as string;

    if (
      definition.minLength !== undefined &&
      stringValue.length < definition.minLength
    ) {
      issues.push({
        path,
        message: `must have length >= ${definition.minLength}`,
      });
    }

    if (
      definition.maxLength !== undefined &&
      stringValue.length > definition.maxLength
    ) {
      issues.push({
        path,
        message: `must have length <= ${definition.maxLength}`,
      });
    }

    if (definition.enum && !definition.enum.includes(stringValue)) {
      issues.push({
        path,
        message: `must be one of ${definition.enum.join(", ")}`,
      });
    }

    return;
  }

  if (definition.type === "number") {
    const numberValue = value as number;

    if (!Number.isFinite(numberValue)) {
      issues.push({
        path,
        message: "must be a finite number",
      });
    }

    if (definition.integer && !Number.isInteger(numberValue)) {
      issues.push({
        path,
        message: "must be an integer",
      });
    }

    if (definition.minimum !== undefined && numberValue < definition.minimum) {
      issues.push({
        path,
        message: `must be >= ${definition.minimum}`,
      });
    }

    if (definition.maximum !== undefined && numberValue > definition.maximum) {
      issues.push({
        path,
        message: `must be <= ${definition.maximum}`,
      });
    }

    return;
  }

  if (definition.type === "array") {
    const arrayValue = value as unknown[];

    if (
      definition.minItems !== undefined &&
      arrayValue.length < definition.minItems
    ) {
      issues.push({
        path,
        message: `must contain at least ${definition.minItems} items`,
      });
    }

    if (
      definition.maxItems !== undefined &&
      arrayValue.length > definition.maxItems
    ) {
      issues.push({
        path,
        message: `must contain at most ${definition.maxItems} items`,
      });
    }

    for (let index = 0; index < arrayValue.length; index += 1) {
      validateDefinition(
        definition.items,
        arrayValue[index],
        `${path}[${index}]`,
        issues,
      );
    }

    return;
  }

  if (definition.type === "object") {
    const record = value as Record<string, unknown>;
    const properties = definition.properties ?? {};
    const required = new Set(definition.required ?? []);

    for (const property of required) {
      if (!(property in record)) {
        issues.push({
          path: `${path}.${property}`,
          message: "is required",
        });
      }
    }

    for (const [key, nestedValue] of Object.entries(record)) {
      const nestedDefinition = properties[key];
      if (!nestedDefinition) {
        if (definition.additionalProperties === false) {
          issues.push({
            path: `${path}.${key}`,
            message: "is not allowed",
          });
        }
        continue;
      }

      validateDefinition(
        nestedDefinition,
        nestedValue,
        `${path}.${key}`,
        issues,
      );
    }
  }
}

function validateObjectSchema(
  definition: DatabaseObjectSchemaDefinition,
  value: DatabaseJsonObject,
): DatabaseSchemaValidationResult {
  const issues: DatabaseSchemaValidationIssue[] = [];
  validateDefinition(definition, value, "$", issues);

  if (issues.length === 0) {
    return { valid: true, issues: [] };
  }

  return {
    valid: false,
    issues,
  };
}

interface SchemaValidationContext {
  schema: DatabaseCollectionSchema | null;
  schemaVersion: number;
}

interface SchemaValidationFailure extends SchemaValidationContext {
  issues: DatabaseSchemaValidationIssue[];
}

function validateSchemaInput<TData extends DatabaseJsonObject>(
  schema: DatabaseCollectionSchema | null,
  input: ValidateDatabaseDocumentInput<TData>,
): Result<SchemaValidationContext, SchemaValidationFailure> {
  if (!schema) {
    return ok({
      schema: null,
      schemaVersion: 1,
    });
  }

  const issues: DatabaseSchemaValidationIssue[] = [];
  const structural = validateObjectSchema(schema.document, input.data);
  if (!structural.valid) {
    issues.push(...structural.issues);
  }

  if (schema.validate) {
    const custom = schema.validate(input.data);
    if (custom && !custom.valid) {
      issues.push(...custom.issues);
    }
  }

  const context = {
    schema: cloneSchema(schema),
    schemaVersion: schema.version,
  };

  if (issues.length === 0) {
    return ok(context);
  }

  return err({
    ...context,
    issues,
  });
}

export class SchemaService implements DatabaseSchemasApi {
  private readonly schemasByCollection = new Map<
    string,
    Map<number, DatabaseCollectionSchema>
  >();
  private readonly activeVersions = new Map<string, number>();
  private readonly storage?: DatabaseSchemaStorageDriver;

  constructor(storage?: DatabaseSchemaStorageDriver) {
    this.storage = storage;
  }

  async hydrate(): Promise<void> {
    if (!this.storage) {
      return;
    }

    const schemas = await this.storage.list();
    this.schemasByCollection.clear();
    this.activeVersions.clear();

    for (const schema of schemas) {
      this.registerLocal(
        {
          collection: schema.collection,
          version: schema.version,
          document: schema.document,
          metadata: schema.metadata,
        },
        schema.active,
      );
    }
  }

  private registerLocal<TData extends DatabaseJsonObject>(
    schema: DatabaseCollectionSchema<TData>,
    active = false,
  ): DatabaseCollectionSchema<TData> {
    if (!schema.collection || schema.collection.length === 0) {
      throw new Error("A schema collection name is required.");
    }

    if (!Number.isInteger(schema.version) || schema.version < 1) {
      throw new Error(
        `Schema version for collection "${schema.collection}" must be a positive integer.`,
      );
    }

    const versions =
      this.schemasByCollection.get(schema.collection) ??
      new Map<number, DatabaseCollectionSchema>();
    const existing = versions.get(schema.version);

    if (existing) {
      if (comparableSchema(existing) !== comparableSchema(schema)) {
        throw new Error(
          `Schema version ${schema.version} for collection "${schema.collection}" is already registered.`,
        );
      }

      const merged = {
        ...existing,
        ...schema,
        document: cloneDefinition(schema.document),
        metadata: schema.metadata ? { ...schema.metadata } : undefined,
      } as DatabaseCollectionSchema;
      versions.set(schema.version, merged);

      if (active || schema.activate) {
        this.activeVersions.set(schema.collection, schema.version);
      }

      return cloneSchema(merged) as DatabaseCollectionSchema<TData>;
    }

    versions.set(
      schema.version,
      cloneSchema(schema as DatabaseCollectionSchema),
    );
    this.schemasByCollection.set(schema.collection, versions);

    if (
      active ||
      schema.activate ||
      !this.activeVersions.has(schema.collection)
    ) {
      this.activeVersions.set(schema.collection, schema.version);
    }

    return cloneSchema(
      schema as DatabaseCollectionSchema,
    ) as DatabaseCollectionSchema<TData>;
  }

  async register<TData extends DatabaseJsonObject>(
    schema: DatabaseCollectionSchema<TData>,
  ): Promise<DatabaseCollectionSchema<TData>> {
    const activate =
      schema.activate || !this.activeVersions.has(schema.collection);
    const registered = this.registerLocal(schema, activate);

    if (this.storage) {
      await this.storage.save(registered);
      if (activate) {
        await this.storage.activate(schema.collection, schema.version);
      }
    }

    return registered;
  }

  async registerMany(
    schemas: readonly DatabaseCollectionSchema[],
  ): Promise<void> {
    const explicitActiveCollections = new Set<string>();
    const highestVersions = new Map<string, number>();

    for (const schema of schemas) {
      await this.register(schema);
      if (schema.activate) {
        explicitActiveCollections.add(schema.collection);
      }

      const current = highestVersions.get(schema.collection) ?? 0;
      if (schema.version > current) {
        highestVersions.set(schema.collection, schema.version);
      }
    }

    for (const [collection, version] of highestVersions) {
      if (!explicitActiveCollections.has(collection)) {
        await this.activate(collection, version);
      }
    }
  }

  listCollections(): DatabaseCollectionSchemaSummary[] {
    return [...this.schemasByCollection.entries()]
      .map(([collection, versions]) => ({
        collection,
        activeVersion: this.activeVersions.get(collection) ?? null,
        versions: [...versions.keys()].sort((left, right) => left - right),
      }))
      .sort((left, right) => left.collection.localeCompare(right.collection));
  }

  listVersions(collection: string): DatabaseCollectionSchema[] {
    const versions = this.schemasByCollection.get(collection);
    if (!versions) {
      return [];
    }

    return [...versions.values()]
      .sort((left, right) => left.version - right.version)
      .map((schema) => cloneSchema(schema));
  }

  listVersionRecords(collection: string): DatabaseStoredCollectionSchema[] {
    const versions = this.schemasByCollection.get(collection);
    if (!versions) {
      return [];
    }

    const activeVersion = this.activeVersions.get(collection);
    return [...versions.values()]
      .sort((left, right) => left.version - right.version)
      .map((schema) =>
        cloneStoredSchema({
          collection: schema.collection,
          version: schema.version,
          document: schema.document,
          metadata: schema.metadata,
          active: schema.version === activeVersion,
        }),
      );
  }

  getSchema(
    collection: string,
    version: number,
  ): DatabaseCollectionSchema | null {
    const schema =
      this.schemasByCollection.get(collection)?.get(version) ?? null;
    return schema ? cloneSchema(schema) : null;
  }

  getActiveSchema(collection: string): DatabaseCollectionSchema | null {
    const activeVersion = this.activeVersions.get(collection);
    if (activeVersion === undefined) {
      return null;
    }

    return this.getSchema(collection, activeVersion);
  }

  async activate(
    collection: string,
    version: number,
  ): Promise<DatabaseCollectionSchema> {
    const schema = this.schemasByCollection.get(collection)?.get(version);
    if (!schema) {
      throw new DatabaseNotFoundError(
        `Schema version ${version} for collection "${collection}" is not registered.`,
      );
    }

    this.activeVersions.set(collection, version);

    if (this.storage) {
      await this.storage.activate(collection, version);
    }

    return cloneSchema(schema);
  }

  validate<TData extends DatabaseJsonObject>(
    input: ValidateDatabaseDocumentInput<TData>,
  ): ValidateDatabaseDocumentResult {
    const schema = input.version
      ? (this.schemasByCollection.get(input.collection)?.get(input.version) ??
        null)
      : (this.schemasByCollection
          .get(input.collection)
          ?.get(this.activeVersions.get(input.collection) ?? -1) ?? null);
    const result = validateSchemaInput(schema, input);

    if (result.ok) {
      return {
        schema: result.value.schema,
        schemaVersion: result.value.schemaVersion,
        validation: { valid: true, issues: [] },
      };
    }

    return {
      schema: result.error.schema,
      schemaVersion: result.error.schemaVersion,
      validation: {
        valid: false,
        issues: result.error.issues,
      },
    };
  }
}
