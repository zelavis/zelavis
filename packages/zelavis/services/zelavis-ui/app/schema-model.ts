import { Schema } from "effect";
import { CollectionFieldEntrySchema, StoredCollectionSchemaCodec, type CollectionFieldEntry, type StoredCollectionSchema } from "zelavis/db/schema";

// Pure schema-draft rules, with no DOM, so they run (and are tested) outside a browser.
export function parseSchemaFields(text: string): readonly CollectionFieldEntry[] {
  if (text.length > 1024 * 1024) throw new Error("Schema draft exceeded 1 MB.");
  const fields = Schema.decodeUnknownSync(Schema.Array(CollectionFieldEntrySchema))(JSON.parse(text) as unknown);
  let count = 0;
  const validate = (values: readonly CollectionFieldEntry[], depth: number) => {
    if (depth > 12) throw new Error("Schema draft exceeded 12 nested field levels.");
    const names = new Set<string>();
    for (const entry of values) {
      if (++count > 256) throw new Error("Schema draft exceeded 256 fields.");
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(entry.name) || names.has(entry.name)) throw new Error(`Invalid or duplicate field name: ${entry.name}`);
      names.add(entry.name);
      if (entry.field._tag === "RepeaterField") validate(entry.field.fields, depth + 1);
    }
  };
  validate(fields, 0);
  return fields;
}
export function schemaVersions(text: string): readonly StoredCollectionSchema[] {
  const values = Schema.decodeUnknownSync(Schema.Array(StoredCollectionSchemaCodec))(JSON.parse(text) as unknown);
  const versions = new Set<number>();
  for (const value of values) {
    if (!Number.isSafeInteger(value.version) || value.version < 1 || versions.has(value.version)) throw new Error("Invalid schema version catalogue.");
    versions.add(value.version);
  }
  if (values.filter(value => value.active).length > 1) throw new Error("The catalogue has multiple active schemas.");
  return values;
}
export function nextSchemaVersion(schemas: readonly StoredCollectionSchema[]): number {
  const version = Math.max(0, ...schemas.map(schema => schema.version)) + 1;
  if (!Number.isSafeInteger(version)) throw new Error("No safe schema version remains.");
  return version;
}

