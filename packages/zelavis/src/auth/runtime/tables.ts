/**
 * Auth tables: schema and index definitions for Auth modules.
 *
 * Every Auth module keeps its tables in the runtime's one Auth partition (a
 * Tenant), each a collection named `<module>_<table>`, so a sign-up that
 * writes rows of several modules is still one transaction. A row is a document
 * whose id is its `_id` and whose data carries `_id` and `_creationTime`.
 * Non-unique indexes append `_creationTime` unless it is already part of their
 * key. Every table also has the built-in `by_creation_time` index.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CollectionIndex, IndexDefinition, IndexField } from "../../db/document-model.js";
import type { TenantApi } from "../../db/database.js";
import { COLLECTION_NAME_PATTERN } from "../../db/naming.js";

/** A stored row: its id and when it was inserted, in milliseconds that strictly increase. */
export interface AuthRow {
  readonly _id: string;
  readonly _creationTime: number;
}

export const BY_CREATION_TIME = "by_creation_time";

export interface AuthIndex {
  readonly name: string;
  /** The index key, including the creation time where it orders ties. */
  readonly fields: ReadonlyArray<string>;
  readonly unique?: true;
}

/** A table as ported code names it: `tx.db.get(tables.sessions, id)`. */
export interface AuthTableRef<T extends AuthRow = AuthRow> {
  readonly collection: string;
  readonly schema: Schema.Codec<T>;
  readonly indexes: ReadonlyMap<string, AuthIndex>;
  /** Every indexed field and `_creationTime`: the fields the collection posts. */
  readonly columns: ReadonlyArray<string>;
}

type RowOf<F extends Schema.Struct.Fields> = Schema.Struct<F>["Type"] & AuthRow;

export interface TableBuilder<F extends Schema.Struct.Fields> {
  readonly fields: F;
  readonly declared: ReadonlyArray<AuthIndex>;
  /** Declares a secondary index on the table. */
  index(name: string, fields: ReadonlyArray<keyof F & string | `${keyof F & string}.${string}` | "_id" | "_creationTime">, options?: { readonly unique: true }): TableBuilder<F>;
}

const INDEX_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Declares an Auth table schema builder. */
export function defineTable<F extends Schema.Struct.Fields>(fields: F): TableBuilder<F> {
  const build = (declared: ReadonlyArray<AuthIndex>): TableBuilder<F> => ({
    fields,
    declared,
    index(name, indexFields, options) {
      if (!INDEX_NAME.test(name) || name === BY_CREATION_TIME || declared.some((index) => index.name === name)) {
        throw new Error(`Invalid or repeated Auth index name: ${name}`);
      }
      // A dotted path (such as `"purpose.userId"`) names a field inside an object field.
      if (indexFields.length === 0 || indexFields.some((field) => field !== "_id" && field !== "_creationTime" && !Object.hasOwn(fields, field.split(".")[0] ?? ""))) {
        throw new Error(`Auth index ${name} must list fields of its table`);
      }
      return build([...declared, options?.unique === true
        ? { name, fields: [...indexFields], unique: true }
        : { name, fields: indexFields.includes("_creationTime") ? [...indexFields] : [...indexFields, "_creationTime"] }]);
    },
  });
  return build([]);
}

export type AuthTables<T extends Record<string, TableBuilder<Schema.Struct.Fields>>> = {
  readonly [K in keyof T]: T[K] extends TableBuilder<infer F> ? AuthTableRef<RowOf<F>> : never;
};

/** A module's tables, each named `<module>_<table>`. */
export function defineTables<T extends Record<string, TableBuilder<Schema.Struct.Fields>>>(module: string, tables: T): AuthTables<T> {
  const refs: Record<string, AuthTableRef> = {};
  for (const [table, builder] of Object.entries(tables)) {
    const collection = `${module}_${table}`;
    if (!COLLECTION_NAME_PATTERN.test(collection) || /^zv/i.test(collection)) throw new Error(`Invalid Auth table name: ${collection}`);
    const indexes = new Map<string, AuthIndex>([[BY_CREATION_TIME, { name: BY_CREATION_TIME, fields: ["_creationTime"] }]]);
    for (const index of builder.declared) indexes.set(index.name, index);
    const columns = [...new Set([...builder.declared.flatMap((index) => index.fields), "_creationTime"])];
    refs[table] = {
      collection,
      schema: Schema.Struct({ ...builder.fields, _id: Schema.String, _creationTime: Schema.Number }) as unknown as Schema.Codec<AuthRow>,
      indexes,
      columns,
    };
  }
  return refs as AuthTables<T>;
}

// Place a missing value first ascending (and, read backwards, last).
const indexField = (path: string): IndexField => ({ path, direction: "asc", nulls: "first" });

const definitionOf = (index: AuthIndex): IndexDefinition => ({
  name: index.name, fields: index.fields.map(indexField), ...(index.unique === true ? { unique: true } : {}),
});

const sameFields = (existing: CollectionIndex, wanted: IndexDefinition) =>
  (existing.unique === true) === (wanted.unique === true) &&
  existing.fields.length === wanted.fields.length &&
  existing.fields.every((field, i) => field.path === wanted.fields[i]?.path && field.direction === "asc" && field.nulls === "first");

/**
 * Create each table's collection with its columns and indexes, and add the
 * indexes an existing collection lacks. Runs when Auth starts and in tests;
 * repeating it changes nothing.
 */
export const ensureTables = Effect.fn("auth.runtime.ensureTables")(function* (tenant: TenantApi, tables: Readonly<Record<string, AuthTableRef>>) {
  const existing = new Map((yield* tenant.documents.listCollections).map((collection) => [collection.name, collection]));
  for (const table of Object.values(tables)) {
    const definitions = [...table.indexes.values()].map(definitionOf);
    const collection = existing.get(table.collection);
    if (collection === undefined) {
      yield* tenant.documents.createCollection({ name: table.collection, surface: "database", columns: table.columns, indexes: definitions });
      continue;
    }
    const columns = collection.columns === undefined ? undefined : new Set(collection.columns);
    if (columns !== undefined && table.columns.some((column) => !columns.has(column))) {
      yield* tenant.documents.setColumns({ collection: table.collection, columns: [...new Set([...columns, ...table.columns])] });
    }
    for (const definition of definitions) {
      const present = collection.indexes?.find((index) => index.name === definition.name);
      if (present !== undefined && sameFields(present, definition)) continue;
      if (present !== undefined) return yield* Effect.die(new Error(`Auth index ${table.collection}.${definition.name} exists with other fields`));
      yield* tenant.documents.createIndex({ ...definition, collection: table.collection });
    }
  }
});
