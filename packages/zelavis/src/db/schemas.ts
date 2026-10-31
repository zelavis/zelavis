import { CollectionFieldEntrySchema } from "./schema/field-types.js";
import { isPositiveInteger, isString, isBoolean, objectFields, parseJson } from "../core/json-validation.js";
import { Effect, Stream, Schema } from "effect";
import { dieUnlessMoving, SchemaVersionExists, type TenantMoving } from "./errors.js";
import type { JsonObject } from "./json.js";
import { equals } from "./query.js";
import type { ObjectStoreApi } from "./store.js";
import type { TenantId } from "./topology.js";
import {
  validateDocumentData,
  type CollectionSchema,
  type CollectionSchemaSummary,
  type SchemaValidationResult,
  type StoredCollectionSchema,
} from "./schema/index.js";

/**
 * Schemas are stored records like anything else.
 *
 * They live under a reserved namespace rather than a table of their own, so a
 * schema change is in the same log as the documents it governs and a follower
 * receives both in order. Nothing about a schema is knowable by a replica that
 * would not also be knowable by replaying the log.
 */
const SCHEMA_NS = "zv.schema";
const schemaKey = (collection: string, version: number) => `${collection}/${version}`;
export const ACTIVE_NS = "zv.schema.active";
export const activeKey = (collection: string) => collection;

/**
 * Indexes every stored schema for a tenant.
 *
 * Listing is driven by this posting rather than by probing version numbers:
 * versions need not be contiguous, and a caller that saves version 5 first
 * should not make versions 1 through 4 look like the end of the list.
 */
const SCHEMA_COLUMN = "zv.schema";

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * A tenant's stored schema versions and which one is active.
 *
 * Storage only: a saved version is never active until the activation workflow
 * (`schema-activation.ts`) has applied what it implies and published it.
 */
export interface SchemaRecords {
  /** Store a version, inactive. Versions are immutable once written. */
  readonly save: (
    schema: CollectionSchema,
  ) => Effect.Effect<StoredCollectionSchema, SchemaVersionExists | TenantMoving>;
  readonly listCollections: Effect.Effect<ReadonlyArray<CollectionSchemaSummary>>;
  readonly listVersions: (
    collection: string,
  ) => Effect.Effect<ReadonlyArray<StoredCollectionSchema>>;
  readonly getVersion: (
    collection: string,
    version: number,
  ) => Effect.Effect<StoredCollectionSchema | undefined>;
  readonly getActive: (collection: string) => Effect.Effect<StoredCollectionSchema | undefined>;
  /** Validate against the active schema. A collection with none accepts anything. */
  readonly validate: (
    collection: string,
    data: JsonObject,
  ) => Effect.Effect<SchemaValidationResult>;
}

const schemaRecord = objectFields<StoredCollectionSchema>({ collection: isString, version: isPositiveInteger,
  active: isBoolean, fields: (value): value is StoredCollectionSchema["fields"] => Array.isArray(value) && value.every(Schema.is(CollectionFieldEntrySchema)) });

export const schemasFor = (store: ObjectStoreApi, tenant: TenantId): SchemaRecords => {
  const readAt = (namespace: string, key: string) =>
    Effect.gen(function* () {
      const seq = yield* store.lookup(namespace, key);
      if (seq === undefined) return undefined;
      const object = yield* store.read(seq);
      return object === undefined ? undefined : dec.decode(object.bytes);
    }).pipe(Effect.orDie);

  const getVersion = (collection: string, version: number) =>
    Effect.map(readAt(SCHEMA_NS, schemaKey(collection, version)), (raw) =>
      raw === undefined ? undefined : (parseJson(raw, schemaRecord)),
    );

  const activeVersionOf = (collection: string) =>
    Effect.map(readAt(ACTIVE_NS, activeKey(collection)), (raw) =>
      raw === undefined ? undefined : (parseJson(raw, objectFields<{ version: number }>({version: isPositiveInteger}))).version,
    );

  const allStored = Effect.gen(function* () {
    const seqs = yield* Stream.runCollect(store.resolve(equals(SCHEMA_COLUMN, tenant)));
    const out: StoredCollectionSchema[] = [];
    for (const seq of seqs) {
      const object = yield* store.read(seq);
      if (object !== undefined) out.push(parseJson(dec.decode(object.bytes), schemaRecord));
    }
    return out;
  }).pipe(Effect.orDie);

  const listVersions = (collection: string) =>
    Effect.gen(function* () {
      const active = yield* activeVersionOf(collection);
      return (yield* allStored)
        .filter((stored) => stored.collection === collection)
        .map((stored) => ({ ...stored, active: stored.version === active }))
        .sort((a, b) => a.version - b.version);
    });

  const getActive = (collection: string) =>
    Effect.gen(function* () {
      const version = yield* activeVersionOf(collection);
      if (version === undefined) return undefined;
      const stored = yield* getVersion(collection, version);
      return stored === undefined ? undefined : { ...stored, active: true };
    });

  return {
    save: (schema) =>
      store.transact((txn) => Effect.gen(function* () {
        // Read and allocate under the partition writer, so two concurrent
        // imports cannot both claim an immutable version and overwrite it.
        const existing = yield* getVersion(schema.collection, schema.version);
        if (existing !== undefined) return yield* new SchemaVersionExists({ collection: schema.collection, version: schema.version });
        const seq = yield* txn.allocate;
        const stored: StoredCollectionSchema = {
          collection: schema.collection, version: schema.version, active: false, fields: schema.fields,
        };
        yield* txn.put(seq, enc.encode(JSON.stringify(stored)), {
          terms: [], columns: [[SCHEMA_COLUMN, tenant]], measures: [], edges: [],
        }, { namespace: SCHEMA_NS, key: schemaKey(schema.collection, schema.version) });
        return stored;
      })).pipe(dieUnlessMoving),

    listVersions,
    getVersion,
    getActive,

    listCollections: Effect.gen(function* () {
      const stored = yield* allStored;
      const byCollection = new Map<string, number[]>();
      for (const schema of stored) {
        const versions = byCollection.get(schema.collection) ?? [];
        versions.push(schema.version);
        byCollection.set(schema.collection, versions);
      }
      const summaries: CollectionSchemaSummary[] = [];
      for (const [collection, versions] of byCollection) {
        const active = yield* activeVersionOf(collection);
        summaries.push({
          collection,
          activeVersion: active ?? null,
          versions: versions.sort((a, b) => a - b),
        });
      }
      return summaries.sort((a, b) => a.collection.localeCompare(b.collection));
    }),

    validate: (collection, data) =>
      Effect.gen(function* () {
        const active = yield* getActive(collection);
        if (active === undefined) {
          // No schema means no constraints, which is how a raw database
          // collection behaves; it is not a validation failure.
          return { schemaVersion: 0, valid: true, issues: [] };
        }
        const result = validateDocumentData(active.fields, data);
        return { schemaVersion: active.version, valid: result.valid, issues: result.issues };
      }),
  } satisfies SchemaRecords;
};
