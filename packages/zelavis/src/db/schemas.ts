import { Effect, Stream } from "effect";
import { SchemaVersionExists, SchemaNotFound } from "./errors.js";
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
const schemaKey = (tenant: TenantId, collection: string, version: number) =>
  `${tenant}/${collection}/${version}`;
const ACTIVE_NS = "zv.schema.active";
const activeKey = (tenant: TenantId, collection: string) => `${tenant}/${collection}`;

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

export interface SchemasApi {
  /** Store a version. Versions are immutable once written. */
  readonly save: (
    schema: CollectionSchema,
  ) => Effect.Effect<StoredCollectionSchema, SchemaVersionExists>;
  readonly listCollections: () => Effect.Effect<ReadonlyArray<CollectionSchemaSummary>>;
  readonly listVersions: (
    collection: string,
  ) => Effect.Effect<ReadonlyArray<StoredCollectionSchema>>;
  readonly getVersion: (
    collection: string,
    version: number,
  ) => Effect.Effect<StoredCollectionSchema | undefined>;
  readonly getActive: (collection: string) => Effect.Effect<StoredCollectionSchema | undefined>;
  readonly activate: (
    collection: string,
    version: number,
  ) => Effect.Effect<StoredCollectionSchema, SchemaNotFound>;
  /** Validate against the active schema. A collection with none accepts anything. */
  readonly validate: (
    collection: string,
    data: JsonObject,
  ) => Effect.Effect<SchemaValidationResult>;
}

export const schemasFor = (store: ObjectStoreApi, tenant: TenantId): SchemasApi => {
  const readAt = (namespace: string, key: string) =>
    Effect.gen(function* () {
      const seq = yield* store.lookup(namespace, key);
      if (seq === undefined) return undefined;
      const object = yield* store.read(seq);
      return object === undefined ? undefined : dec.decode(object.bytes);
    }).pipe(Effect.orDie);

  const put = (namespace: string, key: string, value: unknown, columns: Array<readonly [string, string]>) =>
    Effect.gen(function* () {
      const existing = yield* store.lookup(namespace, key);
      const seq = existing ?? (yield* store.nextSeq);
      yield* store.transact((txn) =>
        txn.put(seq, enc.encode(JSON.stringify(value)), {
          terms: [],
          columns,
          measures: [],
          edges: [],
        }, { namespace, key }),
      );
    }).pipe(Effect.orDie);

  const getVersion = (collection: string, version: number) =>
    Effect.map(readAt(SCHEMA_NS, schemaKey(tenant, collection, version)), (raw) =>
      raw === undefined ? undefined : (JSON.parse(raw) as StoredCollectionSchema),
    );

  const activeVersionOf = (collection: string) =>
    Effect.map(readAt(ACTIVE_NS, activeKey(tenant, collection)), (raw) =>
      raw === undefined ? undefined : (JSON.parse(raw) as { version: number }).version,
    );

  const allStored = Effect.gen(function* () {
    const seqs = yield* Stream.runCollect(store.resolve(equals(SCHEMA_COLUMN, tenant)));
    const out: StoredCollectionSchema[] = [];
    for (const seq of seqs) {
      const object = yield* store.read(seq);
      if (object !== undefined) out.push(JSON.parse(dec.decode(object.bytes)) as StoredCollectionSchema);
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
      Effect.gen(function* () {
        const existing = yield* getVersion(schema.collection, schema.version);
        if (existing !== undefined) {
          // A stored version is what documents were validated against, so
          // rewriting one would retroactively change what was already accepted.
          return yield* new SchemaVersionExists({
            collection: schema.collection,
            version: schema.version,
          });
        }
        const stored: StoredCollectionSchema = {
          collection: schema.collection,
          version: schema.version,
          active: schema.activate !== false,
          fields: schema.fields,
        };
        yield* put(SCHEMA_NS, schemaKey(tenant, schema.collection, schema.version), stored, [
          [SCHEMA_COLUMN, tenant],
        ]);
        if (stored.active) {
          yield* put(ACTIVE_NS, activeKey(tenant, schema.collection), { version: schema.version }, []);
        }
        return stored;
      }),

    listVersions,
    getVersion,
    getActive,

    listCollections: () =>
      Effect.gen(function* () {
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

    activate: (collection, version) =>
      Effect.gen(function* () {
        const stored = yield* getVersion(collection, version);
        if (stored === undefined) {
          return yield* new SchemaNotFound({ collection, version });
        }
        yield* put(ACTIVE_NS, activeKey(tenant, collection), { version }, []);
        return { ...stored, active: true };
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
  } satisfies SchemasApi;
};
