/** Portable logical schemas and standalone TypeScript, independent of storage layout. */
import { Effect, Schema } from "effect";
import { SchemaTransferRefused, type SchemaActivationRefused, type SchemaNotFound, type TenantMoving } from "./errors.js";
import { StoredCollectionSchemaCodec, validateDocumentData, type CollectionField, type CollectionFieldEntry, type StoredCollectionSchema } from "./schema/index.js";
import type { SchemaRecords } from "./schemas.js";
import type { ActivatedSchema } from "./schema-activation.js";

export interface LogicalSchemaBundle {
  readonly format: "zelavis.logical-schema";
  readonly version: 1;
  readonly schemas: ReadonlyArray<StoredCollectionSchema>;
}
export interface SchemaExportOptions { readonly collections?: ReadonlyArray<string> }
export interface SchemaImportOptions {
  readonly bundle: LogicalSchemaBundle;
  /** Default true: validate all versions and immutable conflicts without writing. */
  readonly dryRun?: boolean;
  /** Default false: explicitly opt in to the ordinary durable activation workflow. */
  readonly activate?: boolean;
}
export interface SchemaImportResult {
  readonly dryRun: boolean;
  readonly complete: boolean;
  readonly versions: ReadonlyArray<{ readonly collection: string; readonly version: number; readonly action: "save" | "reuse" }>;
  readonly activations: ReadonlyArray<{ readonly collection: string; readonly version: number; readonly status: "planned" | "activated" | "refused"; readonly reason?: string }>;
}
export interface GeneratedSchemaTypes {
  readonly filename: "zelavis-schema.d.ts";
  readonly source: string;
}
export interface SchemaTransferApi {
  readonly export: (options?: SchemaExportOptions) => Effect.Effect<LogicalSchemaBundle, SchemaTransferRefused>;
  readonly import: (options: SchemaImportOptions) => Effect.Effect<SchemaImportResult, SchemaTransferRefused | SchemaNotFound | TenantMoving>;
  readonly types: (options?: SchemaExportOptions) => Effect.Effect<GeneratedSchemaTypes, SchemaTransferRefused>;
}

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_VERSIONS = 1024;
const MAX_COLLECTIONS = 128;
const MAX_FIELDS = 10_000;
const MAX_DEPTH = 16;
const BundleCodec = Schema.Struct({
  format: Schema.Literal("zelavis.logical-schema"), version: Schema.Literal(1),
  schemas: Schema.Array(StoredCollectionSchemaCodec),
});
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const refused = (reason: string) => new SchemaTransferRefused({ reason });
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const validName = (name: unknown): name is string => typeof name === "string" && name.length > 0 && name.length <= 256 && !/[\u0000-\u001f/]/u.test(name);

/** Bound recursion before invoking the recursive field codec or generating types. */
const decodeBundle = (input: unknown): LogicalSchemaBundle => {
  const json = JSON.stringify(input);
  if (json === undefined || new TextEncoder().encode(json).length > MAX_BYTES) throw refused("schema bundle exceeds 2 MiB");
  if (!record(input) || !Array.isArray(input.schemas) || input.schemas.length > MAX_VERSIONS) throw refused("expected a bundle with at most 1024 schema versions");
  let count = 0;
  const collections = new Set<string>(), versions = new Set<string>(), active = new Set<string>();
  for (const stored of input.schemas) {
    if (!record(stored) || !validName(stored.collection) || !Number.isSafeInteger(stored.version) || Number(stored.version) < 1 || !Array.isArray(stored.fields)) throw refused("each version needs a valid collection, positive safe integer version and fields");
    collections.add(stored.collection);
    if (collections.size > MAX_COLLECTIONS) throw refused("schema bundle exceeds 128 collections");
    const key = `${stored.collection}/${stored.version}`;
    if (versions.has(key)) throw refused(`duplicate schema version ${key}`);
    versions.add(key);
    if (stored.active === true) {
      if (active.has(stored.collection)) throw refused(`multiple active versions of ${stored.collection}`);
      active.add(stored.collection);
    }
    const stack = [{ fields: stored.fields, depth: 0 }];
    while (stack.length > 0) {
      const level = stack.pop()!;
      if (level.depth > MAX_DEPTH) throw refused("schema fields exceed nesting depth 16");
      const names = new Set<string>();
      for (const entry of level.fields) {
        if (++count > MAX_FIELDS) throw refused("schema bundle exceeds 10000 fields");
        if (!record(entry) || !validName(entry.name) || names.has(entry.name) || !record(entry.field)) throw refused("field names must be valid and unique within their object");
        names.add(entry.name);
        if (entry.field._tag === "VectorField" && (!Number.isSafeInteger(entry.field.dimension) || Number(entry.field.dimension) < 1 || Number(entry.field.dimension) > 65536)) throw refused("vector dimension must be an integer between 1 and 65536");
        if (entry.field._tag === "GeometryField" && (!Number.isSafeInteger(entry.field.resolution) || Number(entry.field.resolution) < 0 || Number(entry.field.resolution) > 15)) throw refused("geometry resolution must be an integer between 0 and 15");
        if (entry.field._tag === "RepeaterField") {
          if (!Array.isArray(entry.field.fields)) throw refused("repeater fields must be an array");
          stack.push({ fields: entry.field.fields, depth: level.depth + 1 });
        }
      }
    }
  }
  const bundle = Schema.decodeUnknownSync(BundleCodec)(input);
  // Construct every value validator now, including user-supplied regular expressions.
  for (const stored of bundle.schemas) validateDocumentData(stored.fields, {});
  return { ...bundle, schemas: [...bundle.schemas].sort((a, b) => compare(a.collection, b.collection) || a.version - b.version) };
};

const checked = <A>(run: () => A): Effect.Effect<A, SchemaTransferRefused> => Effect.try({
  try: run,
  catch: (cause) => cause instanceof SchemaTransferRefused ? cause : refused(cause instanceof Error ? cause.message : "invalid logical schema"),
});

/** JSON object member order is not part of an immutable schema version. */
const canonical = (value: unknown): string => JSON.stringify(value, (_, item) => {
  if (!record(item)) return item;
  return Object.fromEntries(Object.keys(item).sort(compare).map(key => [key, item[key]]));
});
const sameFields = (a: StoredCollectionSchema, b: StoredCollectionSchema) => canonical(a.fields) === canonical(b.fields);
const quote = (value: string) => JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const objectType = (fields: ReadonlyArray<CollectionFieldEntry>): string => `{ ${fields.map(({ name, field }) => `readonly ${quote(name)}${field.required ? "" : "?"}: ${fieldType(field)};`).join(" ")} }`;
const choices = (values: ReadonlyArray<string>) => values.length === 0 ? "never" : [...new Set(values)].map(quote).join(" | ");
const fieldType = (field: CollectionField): string => {
  switch (field._tag) {
    case "TextField": case "LongTextField": case "RichTextField": case "SlugField": case "UrlField": case "DateTimeField": return "string";
    case "NumberField": case "IntegerField": return "number";
    case "BooleanField": return "boolean";
    case "SelectField": return choices(field.options);
    case "MultiSelectField": return `ReadonlyArray<${choices(field.options)}>`;
    case "FileField": case "ImageField": case "AudioField": case "VideoField": return "FileReference";
    case "JsonField": return "JsonValue";
    case "ReferenceField": {
      const reference = `{ readonly collection: ${quote(field.collection)}; readonly id: string }`;
      return field.multiple === true ? `ReadonlyArray<${reference}>` : reference;
    }
    case "GeometryField": return "GeometryValue";
    case "VectorField": return `ReadonlyArray<number> & { readonly length: ${field.dimension} }`;
    case "RepeaterField": return `ReadonlyArray<${objectType(field.fields)}>`;
  }
};

/** The generated file has no runtime or package imports and can be checked in by an app. */
export const generateSchemaTypes = (input: LogicalSchemaBundle): GeneratedSchemaTypes => {
  const bundle = decodeBundle(input);
  const source = `// Generated from Zelavis logical schema v1. Runtime constraints still apply.\n` +
    `export type JsonValue = null | boolean | number | string | ReadonlyArray<JsonValue> | { readonly [key: string]: JsonValue };\n` +
    `export interface FileReference { readonly kind: "file"; readonly path: string; readonly href: string; readonly metadataHref: string; readonly size?: number; readonly updatedAt?: string; readonly contentType?: string; readonly metadata?: Readonly<Record<string, string>>; readonly checksum?: string }\n` +
    `type Position = readonly [number, number];\n` +
    `export type GeometryValue = { readonly type: "Point"; readonly coordinates: Position } | { readonly type: "LineString"; readonly coordinates: ReadonlyArray<Position> } | { readonly type: "Polygon" | "MultiLineString"; readonly coordinates: ReadonlyArray<ReadonlyArray<Position>> } | { readonly type: "MultiPolygon"; readonly coordinates: ReadonlyArray<ReadonlyArray<ReadonlyArray<Position>>> };\n` +
    `export interface Collections {\n${bundle.schemas.filter(schema => schema.active).map(schema => `  readonly ${quote(schema.collection)}: ${objectType(schema.fields)};`).join("\n")}\n}\n` +
    `export interface SchemaVersions {\n${bundle.schemas.map(schema => `  readonly ${quote(`${schema.collection}@${schema.version}`)}: ${objectType(schema.fields)};`).join("\n")}\n}\n`;
  if (new TextEncoder().encode(source).length > MAX_BYTES) throw refused("generated types exceed 2 MiB");
  return { filename: "zelavis-schema.d.ts", source };
};

export const schemaTransferFor = (
  records: SchemaRecords,
  activate: (collection: string, version: number) => Effect.Effect<ActivatedSchema, SchemaNotFound | SchemaActivationRefused | TenantMoving>,
): SchemaTransferApi => {
  const exportBundle = (options: SchemaExportOptions = {}) => Effect.gen(function* () {
    const requested = yield* checked(() => {
      if (options.collections === undefined) return undefined;
      if (!Array.isArray(options.collections) || options.collections.length > MAX_COLLECTIONS || !options.collections.every(validName)) throw refused("collections must contain at most 128 valid names");
      return new Set(options.collections);
    });
    const schemas: StoredCollectionSchema[] = [];
    for (const collection of yield* records.listCollections) {
      if (requested !== undefined && !requested.has(collection.collection)) continue;
      schemas.push(...yield* records.listVersions(collection.collection));
      if (schemas.length > MAX_VERSIONS) return yield* refused("schema export exceeds 1024 versions; select fewer collections");
    }
    return yield* checked(() => decodeBundle({ format: "zelavis.logical-schema", version: 1, schemas }));
  });
  return {
    export: exportBundle,
    types: (options) => Effect.flatMap(exportBundle(options), bundle => checked(() => generateSchemaTypes(bundle))),
    import: (options) => Effect.gen(function* () {
      const bundle = yield* checked(() => {
        if (!record(options) || (options.dryRun !== undefined && typeof options.dryRun !== "boolean") || (options.activate !== undefined && typeof options.activate !== "boolean")) throw refused("dryRun and activate must be booleans");
        return decodeBundle(options.bundle);
      });
      const dryRun = options.dryRun !== false;
      const versions: Array<SchemaImportResult["versions"][number]> = [];
      // Complete preflight before any write. Conflicts never silently replace a version.
      for (const stored of bundle.schemas) {
        const existing = yield* records.getVersion(stored.collection, stored.version);
        if (existing !== undefined && !sameFields(existing, stored)) return yield* refused(`immutable schema conflict: ${stored.collection}@${stored.version}`);
        versions.push({ collection: stored.collection, version: stored.version, action: existing === undefined ? "save" : "reuse" });
      }
      if (!dryRun) {
        for (const [index, stored] of bundle.schemas.entries()) {
          if (versions[index].action === "reuse") continue;
          yield* records.save({ ...stored, activate: false }).pipe(Effect.catchTag("SchemaVersionExists", () => Effect.gen(function* () {
            const concurrent = yield* records.getVersion(stored.collection, stored.version);
            if (concurrent === undefined || !sameFields(concurrent, stored)) return yield* refused(`concurrent immutable schema conflict: ${stored.collection}@${stored.version}`);
            return concurrent;
          })));
        }
      }
      const activations: Array<SchemaImportResult["activations"][number]> = [];
      if (options.activate === true) {
        for (const stored of bundle.schemas.filter(schema => schema.active)) {
          if (dryRun) { activations.push({ collection: stored.collection, version: stored.version, status: "planned" }); continue; }
          const result = yield* activate(stored.collection, stored.version).pipe(
            Effect.map(() => ({ collection: stored.collection, version: stored.version, status: "activated" as const })),
            Effect.catchTag("SchemaActivationRefused", error => Effect.succeed({ collection: stored.collection, version: stored.version, status: "refused" as const, reason: error.reason })),
          );
          activations.push(result);
        }
      }
      return { dryRun, complete: !activations.some(item => item.status === "refused"), versions, activations };
    }),
  };
};
