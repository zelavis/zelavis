import { validateDocumentData, } from "../schema/index.js";
import { DatabaseNotFoundError } from "../core/errors.js";
export class SchemaService {
    storage;
    schemasByCollection = new Map();
    activeVersions = new Map();
    constructor(storage) {
        this.storage = storage;
    }
    async hydrate() {
        if (!this.storage)
            return;
        const schemas = await this.storage.list();
        this.schemasByCollection.clear();
        this.activeVersions.clear();
        for (const schema of schemas) {
            this.storeLocally(schema);
        }
    }
    storeLocally(schema) {
        const versions = this.schemasByCollection.get(schema.collection) ??
            new Map();
        versions.set(schema.version, schema);
        this.schemasByCollection.set(schema.collection, versions);
        if (schema.active) {
            this.activeVersions.set(schema.collection, schema.version);
        }
    }
    async save(input) {
        const shouldActivate = input.activate ?? !this.activeVersions.has(input.collection);
        const stored = {
            collection: input.collection,
            version: input.version,
            fields: input.fields,
            active: shouldActivate,
        };
        this.storeLocally(stored);
        if (shouldActivate) {
            this.activeVersions.set(input.collection, input.version);
            // Mark all other versions inactive in cache
            const versions = this.schemasByCollection.get(input.collection);
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
    listCollections() {
        return [...this.schemasByCollection.entries()]
            .map(([collection, versions]) => ({
            collection,
            activeVersion: this.activeVersions.get(collection) ?? null,
            versions: [...versions.keys()].sort((a, b) => a - b),
        }))
            .sort((a, b) => a.collection.localeCompare(b.collection));
    }
    listVersions(collection) {
        const versions = this.schemasByCollection.get(collection);
        if (!versions)
            return [];
        return [...versions.values()].sort((a, b) => a.version - b.version);
    }
    getVersion(collection, version) {
        return this.schemasByCollection.get(collection)?.get(version) ?? null;
    }
    getActive(collection) {
        const activeVersion = this.activeVersions.get(collection);
        if (activeVersion === undefined)
            return null;
        return this.schemasByCollection.get(collection)?.get(activeVersion) ?? null;
    }
    async activate(collection, version) {
        const schema = this.schemasByCollection.get(collection)?.get(version);
        if (!schema) {
            throw new DatabaseNotFoundError(`Schema version ${version} for collection "${collection}" is not registered.`);
        }
        this.activeVersions.set(collection, version);
        const versions = this.schemasByCollection.get(collection);
        for (const [v, s] of versions) {
            versions.set(v, { ...s, active: v === version });
        }
        if (this.storage) {
            await this.storage.activate(collection, version);
        }
        return { ...schema, active: true };
    }
    validate(collection, data) {
        const schema = this.getActive(collection);
        if (!schema) {
            return { schemaVersion: 1, valid: true, issues: [] };
        }
        const { valid, issues } = validateDocumentData(schema.fields, data);
        return { schemaVersion: schema.version, valid, issues };
    }
}
