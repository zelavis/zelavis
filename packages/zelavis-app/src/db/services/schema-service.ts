import type { DatabaseSchemasApi } from "../contracts/api.js";
import type { DatabaseSchemaStorageDriver } from "../contracts/driver.js";
import type { DatabaseJsonObject } from "../contracts/json.js";
import {
  type CollectionSchema,
  type CollectionSchemaSummary,
  type SchemaValidationResult,
  type StoredCollectionSchema,
  validateDocumentData,
} from "../schema/index.js";
import { DatabaseNotFoundError } from "../core/errors.js";

export class SchemaService implements DatabaseSchemasApi {
  private readonly schemasByCollection = new Map<
    string,
    Map<number, StoredCollectionSchema>
  >();
  private readonly activeVersions = new Map<string, number>();

  constructor(private readonly storage?: DatabaseSchemaStorageDriver) {}

  async hydrate(): Promise<void> {
    if (!this.storage) return;
    const schemas = await this.storage.list();
    this.schemasByCollection.clear();
    this.activeVersions.clear();
    for (const schema of schemas) {
      this.storeLocally(schema);
    }
  }

  private storeLocally(schema: StoredCollectionSchema): void {
    const versions =
      this.schemasByCollection.get(schema.collection) ??
      new Map<number, StoredCollectionSchema>();
    versions.set(schema.version, schema);
    this.schemasByCollection.set(schema.collection, versions);
    if (schema.active) {
      this.activeVersions.set(schema.collection, schema.version);
    }
  }

  async save(input: CollectionSchema): Promise<StoredCollectionSchema> {
    const shouldActivate =
      input.activate ?? !this.activeVersions.has(input.collection);

    const stored: StoredCollectionSchema = {
      collection: input.collection,
      version: input.version,
      fields: input.fields,
      active: shouldActivate,
    };

    this.storeLocally(stored);

    if (shouldActivate) {
      this.activeVersions.set(input.collection, input.version);
      // Mark all other versions inactive in cache
      const versions = this.schemasByCollection.get(input.collection)!;
      for (const [v, s] of versions) {
        versions.set(v, { ...s, active: v === input.version });
      }
    }

    if (this.storage) {
      await this.storage.save(stored);
      if (shouldActivate) {
        await this.storage.activate(input.collection, input.version);
      }
    }

    return stored;
  }

  listCollections(): CollectionSchemaSummary[] {
    return [...this.schemasByCollection.entries()]
      .map(([collection, versions]) => ({
        collection,
        activeVersion: this.activeVersions.get(collection) ?? null,
        versions: [...versions.keys()].sort((a, b) => a - b),
      }))
      .sort((a, b) => a.collection.localeCompare(b.collection));
  }

  listVersions(collection: string): StoredCollectionSchema[] {
    const versions = this.schemasByCollection.get(collection);
    if (!versions) return [];
    return [...versions.values()].sort((a, b) => a.version - b.version);
  }

  getVersion(
    collection: string,
    version: number,
  ): StoredCollectionSchema | null {
    return this.schemasByCollection.get(collection)?.get(version) ?? null;
  }

  getActive(collection: string): StoredCollectionSchema | null {
    const activeVersion = this.activeVersions.get(collection);
    if (activeVersion === undefined) return null;
    return this.schemasByCollection.get(collection)?.get(activeVersion) ?? null;
  }

  async activate(
    collection: string,
    version: number,
  ): Promise<StoredCollectionSchema> {
    const schema = this.schemasByCollection.get(collection)?.get(version);
    if (!schema) {
      throw new DatabaseNotFoundError(
        `Schema version ${version} for collection "${collection}" is not registered.`,
      );
    }

    this.activeVersions.set(collection, version);
    const versions = this.schemasByCollection.get(collection)!;
    for (const [v, s] of versions) {
      versions.set(v, { ...s, active: v === version });
    }

    if (this.storage) {
      await this.storage.activate(collection, version);
    }

    return { ...schema, active: true };
  }

  validate(collection: string, data: DatabaseJsonObject): SchemaValidationResult {
    const schema = this.getActive(collection);
    if (!schema) {
      return { schemaVersion: 1, valid: true, issues: [] };
    }
    const { valid, issues } = validateDocumentData(schema.fields, data);
    return { schemaVersion: schema.version, valid, issues };
  }
}
