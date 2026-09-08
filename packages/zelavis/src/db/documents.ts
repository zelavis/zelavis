import { Effect, Stream } from "effect";
import type { Json, JsonObject } from "./json.js";
import {
  COLLECTION_NAME_PATTERN,
  isReservedCollectionName,
  RESERVED_COLLECTION_PREFIX,
} from "./naming.js";
import { TENANT_COLUMN, TENANT_MARKER, TENANT_NAMESPACE } from "./tenancy.js";
import {
  CollectionExists,
  SchemaViolation,
  CollectionNotFound,
  DocumentConflict,
  DocumentNotFound,
  InvalidCollectionName,
} from "./errors.js";
import type { DbError } from "./errors.js";
import type { Seq } from "./model.js";
import { and, equals, or, type Query } from "./query.js";
import type { SchemasApi } from "./schemas.js";
import type { ObjectStoreApi, Txn } from "./store.js";
import type { TenantId } from "./topology.js";

export type { Json, JsonObject } from "./json.js";

export type CollectionSurface = "content-studio" | "database";

export interface Collection {
  readonly name: string;
  readonly createdAt: string;
  readonly surface: CollectionSurface;
  readonly metadata?: Record<string, unknown>;
}

export interface Document<TData extends JsonObject = JsonObject> {
  readonly id: string;
  readonly collection: string;
  readonly data: TData;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export type FilterOperator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in";

export interface DocumentFilter {
  readonly path: string;
  readonly op?: FilterOperator;
  readonly value: Json | ReadonlyArray<Json>;
}

export interface DocumentSort {
  readonly path: string;
  readonly direction?: "asc" | "desc";
}

export interface FindDocumentsInput {
  readonly collection: string;
  readonly where?: ReadonlyArray<DocumentFilter>;
  readonly orderBy?: ReadonlyArray<DocumentSort>;
  readonly limit?: number;
  readonly offset?: number;
}

/** Marks a stored collection record, distinct from any collection name. */
const COLLECTION_MARKER = "\u0000collection";


/**
 * Tenant scoping is structural, not a filter.
 *
 * Several tenants share a physical shard, so their records share one `Seq`
 * space. Rather than appending a tenant predicate to every query — which is a
 * thing a caller can forget, and which silently returns another tenant's rows
 * when they do — the tenant is part of every namespace and every lens key. A
 * query built for one tenant addresses a key space the others are not in.
 */
const collectionNs = (tenant: TenantId) => `zv.collection/${tenant}`;
const documentNs = (tenant: TenantId, collection: string) => `doc/${tenant}/${collection}`;
const collectionColumn = (tenant: TenantId) => `zv.collection/${tenant}`;
const columnFor = (tenant: TenantId, collection: string, path: string) =>
  `${tenant}/${collection}.${path}`;

const validateName = (name: string): Effect.Effect<void, InvalidCollectionName> => {
  if (!COLLECTION_NAME_PATTERN.test(name)) {
    return Effect.fail(
      new InvalidCollectionName({
        name,
        reason:
          "must start with a letter or underscore and contain only letters, numbers, underscores, or hyphens",
      }),
    );
  }
  if (isReservedCollectionName(name)) {
    return Effect.fail(
      new InvalidCollectionName({
        name,
        reason: `the "${RESERVED_COLLECTION_PREFIX}" prefix is reserved`,
      }),
    );
  }
  return Effect.void;
};

const enc = new TextEncoder();
const dec = new TextDecoder();
const encode = (value: unknown) => enc.encode(JSON.stringify(value));
const decode = <A>(bytes: Uint8Array) => JSON.parse(dec.decode(bytes)) as A;

const readPath = (data: JsonObject, path: string): Json | undefined => {
  let cursor: Json | undefined = data;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as JsonObject)[segment];
  }
  return cursor;
};

/** Only scalars are indexable; a term for an object or array would not be equatable. */
const isScalar = (value: Json | undefined): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/**
 * Flatten a document into column postings.
 *
 * Every scalar reachable by a dotted path becomes an equality posting, which is
 * what lets `eq` and `in` filters be answered from the lens rather than by
 * reading payloads. Non-scalars are skipped rather than stringified: a posting
 * for `{"a":1}` would only ever match a query that happened to serialize it
 * identically, which is a match nobody intends.
 */
const columnsFor = (
  tenant: TenantId,
  collection: string,
  data: JsonObject,
): Array<readonly [string, string]> => {
  const out: Array<readonly [string, string]> = [[collectionColumn(tenant), collection]];
  const walk = (value: Json, path: string): void => {
    if (isScalar(value)) {
      out.push([columnFor(tenant, collection, path), String(value)]);
      return;
    }
    if (value === null || Array.isArray(value)) return;
    for (const [k, v] of Object.entries(value)) walk(v, path === "" ? k : `${path}.${k}`);
  };
  walk(data, "");
  return out;
};

const compare = (left: Json | undefined, right: Json): number => {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
};

const matches = (data: JsonObject, filter: DocumentFilter): boolean => {
  const actual = readPath(data, filter.path);
  const op = filter.op ?? "eq";
  if (op === "in") {
    const values = Array.isArray(filter.value) ? filter.value : [filter.value];
    return values.some((v) => actual === v);
  }
  const expected = filter.value as Json;
  switch (op) {
    case "eq":
      return actual === expected;
    case "ne":
      return actual !== expected;
    case "gt":
      return compare(actual, expected) > 0;
    case "gte":
      return compare(actual, expected) >= 0;
    case "lt":
      return compare(actual, expected) < 0;
    case "lte":
      return compare(actual, expected) <= 0;
  }
};

/**
 * Build the lens query for the filters that lenses can answer.
 *
 * `eq` and `in` become postings intersected against the collection. Ordering
 * comparisons cannot, so they are applied to the candidates afterwards; the
 * split is deliberate and visible rather than a silent full scan.
 */
const planQuery = (
  tenant: TenantId,
  collection: string,
  where: ReadonlyArray<DocumentFilter>,
): { readonly query: Query; readonly residual: ReadonlyArray<DocumentFilter> } => {
  const clauses: Query[] = [equals(collectionColumn(tenant), collection)];
  const residual: DocumentFilter[] = [];
  for (const filter of where) {
    const op = filter.op ?? "eq";
    if (op === "eq" && isScalar(filter.value as Json)) {
      clauses.push(equals(columnFor(tenant, collection, filter.path), String(filter.value)));
    } else if (op === "in" && Array.isArray(filter.value) && filter.value.length > 0) {
      const members = filter.value.filter(isScalar);
      if (members.length !== filter.value.length) {
        residual.push(filter);
        continue;
      }
      clauses.push(
        or(...members.map((v) => equals(columnFor(tenant, collection, filter.path), String(v)))),
      );
    } else {
      residual.push(filter);
    }
  }
  return { query: clauses.length === 1 ? clauses[0]! : and(...clauses), residual };
};

export interface DocumentsApi {
  readonly createCollection: (input: {
    readonly name: string;
    readonly surface?: CollectionSurface;
    readonly metadata?: Record<string, unknown>;
  }) => Effect.Effect<Collection, InvalidCollectionName | CollectionExists>;
  readonly listCollections: () => Effect.Effect<ReadonlyArray<Collection>>;
  readonly collectionExists: (name: string) => Effect.Effect<boolean>;
  readonly insert: (input: {
    readonly collection: string;
    readonly id?: string;
    readonly data: JsonObject;
  }) => Effect.Effect<Document, CollectionNotFound | DocumentConflict | SchemaViolation>;
  readonly findById: (input: {
    readonly collection: string;
    readonly id: string;
  }) => Effect.Effect<Document | undefined>;
  readonly findMany: (input: FindDocumentsInput) => Effect.Effect<ReadonlyArray<Document>>;
  readonly update: (input: {
    readonly collection: string;
    readonly id: string;
    readonly data: JsonObject;
    readonly mode?: "merge" | "replace";
    readonly expectedVersion?: number;
  }) => Effect.Effect<Document, DocumentNotFound | DocumentConflict | SchemaViolation>;
  readonly delete: (input: {
    readonly collection: string;
    readonly id: string;
    readonly expectedVersion?: number;
  }) => Effect.Effect<boolean, DocumentConflict>;
}

/**
 * The document API for one tenant on one shard.
 *
 * Takes the store directly rather than from context because a tenant's shard is
 * chosen by the partition map at call time, not by what happens to be provided.
 */
export const documentsFor = (
  store: ObjectStoreApi,
  tenant: TenantId,
  schemas?: SchemasApi,
): DocumentsApi => {
  /**
   * Reject the whole write when the data does not satisfy the active schema.
   *
   * All-or-nothing rather than partial: a document that half-matched would put
   * the lenses in a state no schema describes, and every reader after it would
   * have to cope with a shape that was never valid.
   */
  const enforceSchema = (collection: string, data: JsonObject) =>
    Effect.gen(function* () {
      if (schemas === undefined) return;
      const result = yield* schemas.validate(collection, data);
      if (!result.valid) {
        return yield* new SchemaViolation({
          collection,
          schemaVersion: result.schemaVersion,
          issues: result.issues,
        });
      }
    });


  // A store failure is not something a caller can act on: a fenced writer or an
  // unreadable file is the runtime's problem, not a decision. Converting them to
  // defects here keeps the domain error channel to what a caller can actually
  // respond to — a duplicate id, a missing collection, a stale version.
  const lookup = (namespace: string, key: string) => Effect.orDie(store.lookup(namespace, key));
  const readObject = (seq: Seq) => Effect.orDie(store.read(seq));
  const nextSeq = Effect.orDie(store.nextSeq);
  const resolveQuery = (query: Query): Stream.Stream<Seq> => Stream.orDie(store.resolve(query));
  const write = (f: (txn: Txn) => Effect.Effect<void, DbError>): Effect.Effect<void> =>
    Effect.orDie(store.transact(f));

  const loadCollection = (name: string) =>
    Effect.gen(function* () {
      const seq = yield* lookup(collectionNs(tenant), name);
      if (seq === undefined) return undefined;
      const object = yield* readObject(seq);
      return object === undefined ? undefined : decode<Collection>(object.bytes);
    });

  const requireCollection = (name: string) =>
    Effect.flatMap(loadCollection(name), (found) =>
      found === undefined ? Effect.fail(new CollectionNotFound({ name })) : Effect.succeed(found),
    );

  const readDocument = (seq: Seq) =>
    Effect.map(readObject(seq), (o) => (o === undefined ? undefined : decode<Document>(o.bytes)));

  const writeDocument = (doc: Document, seq: Seq) =>
    write((txn) =>
      txn.put(seq, encode(doc), {
        terms: [],
        columns: columnsFor(tenant, doc.collection, doc.data),
        measures: [],
        edges: [],
      }, { namespace: documentNs(tenant, doc.collection), key: doc.id }),
    );

  return {
    createCollection: (input) =>
      Effect.gen(function* () {
        yield* validateName(input.name);
        const existing = yield* loadCollection(input.name);
        if (existing !== undefined) return yield* new CollectionExists({ name: input.name });
        const collection: Collection = {
          name: input.name,
          createdAt: new Date().toISOString(),
          surface: input.surface ?? "database",
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        };
        const seq = yield* nextSeq;
        yield* write((txn) =>
          txn.put(seq, encode(collection), {
            terms: [],
            columns: [[collectionColumn(tenant), COLLECTION_MARKER]],
            measures: [],
            edges: [],
          }, { namespace: collectionNs(tenant), key: input.name }),
        );
        // Record that this tenant occupies the shard. Placement decisions need
        // to know which tenants a shard actually holds, and deriving that by
        // scanning every namespace would mean reading the whole store.
        if ((yield* lookup(TENANT_NAMESPACE, tenant)) === undefined) {
          const markerSeq = yield* nextSeq;
          yield* write((txn) =>
            txn.put(markerSeq, encode({ tenant }), {
              terms: [],
              columns: [[TENANT_COLUMN, TENANT_MARKER]],
              measures: [],
              edges: [],
            }, { namespace: TENANT_NAMESPACE, key: tenant }),
          );
        }
        return collection;
      }),

    listCollections: () =>
      Effect.gen(function* () {
        const seqs = yield* Stream.runCollect(
          resolveQuery(equals(collectionColumn(tenant), COLLECTION_MARKER)),
        );
        const out: Collection[] = [];
        for (const seq of seqs) {
          const object = yield* readObject(seq);
          if (object !== undefined) out.push(decode<Collection>(object.bytes));
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
      }),

    collectionExists: (name) => Effect.map(loadCollection(name), (c) => c !== undefined),

    insert: (input) =>
      Effect.gen(function* () {
        yield* requireCollection(input.collection);
        yield* enforceSchema(input.collection, input.data);
        const id = input.id ?? crypto.randomUUID();
        const clash = yield* lookup(documentNs(tenant, input.collection), id);
        if (clash !== undefined) {
          return yield* new DocumentConflict({
            collection: input.collection,
            id,
            reason: "a document with this id already exists",
          });
        }
        const now = new Date().toISOString();
        const doc: Document = {
          id,
          collection: input.collection,
          data: input.data,
          createdAt: now,
          updatedAt: now,
          version: 1,
        };
        const seq = yield* nextSeq;
        yield* writeDocument(doc, seq);
        return doc;
      }),

    findById: (input) =>
      Effect.gen(function* () {
        const seq = yield* lookup(documentNs(tenant, input.collection), input.id);
        return seq === undefined ? undefined : yield* readDocument(seq);
      }),

    findMany: (input) =>
      Effect.gen(function* () {
        const { query, residual } = planQuery(tenant, input.collection, input.where ?? []);
        const seqs = yield* Stream.runCollect(resolveQuery(query));
        let docs: Document[] = [];
        for (const seq of seqs) {
          const doc = yield* readDocument(seq);
          if (doc !== undefined && residual.every((f) => matches(doc.data, f))) docs.push(doc);
        }
        for (const sort of [...(input.orderBy ?? [])].reverse()) {
          const dir = sort.direction === "desc" ? -1 : 1;
          docs = docs.sort(
            (a, b) => dir * compare(readPath(a.data, sort.path), readPath(b.data, sort.path) as Json),
          );
        }
        const offset = input.offset ?? 0;
        return input.limit === undefined
          ? docs.slice(offset)
          : docs.slice(offset, offset + input.limit);
      }),

    update: (input) =>
      Effect.gen(function* () {
        const seq = yield* lookup(documentNs(tenant, input.collection), input.id);
        const current = seq === undefined ? undefined : yield* readDocument(seq);
        if (seq === undefined || current === undefined) {
          return yield* new DocumentNotFound({ collection: input.collection, id: input.id });
        }
        if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
          return yield* new DocumentConflict({
            collection: input.collection,
            id: input.id,
            reason: `expected version ${input.expectedVersion}, found ${current.version}`,
          });
        }
        const data =
          (input.mode ?? "merge") === "replace"
            ? input.data
            : { ...current.data, ...input.data };
        yield* enforceSchema(input.collection, data);
        const next: Document = {
          ...current,
          data,
          updatedAt: new Date().toISOString(),
          version: current.version + 1,
        };
        yield* writeDocument(next, seq);
        return next;
      }),

    delete: (input) =>
      Effect.gen(function* () {
        const seq = yield* lookup(documentNs(tenant, input.collection), input.id);
        if (seq === undefined) return false;
        if (input.expectedVersion !== undefined) {
          const current = yield* readDocument(seq);
          if (current !== undefined && current.version !== input.expectedVersion) {
            return yield* new DocumentConflict({
              collection: input.collection,
              id: input.id,
              reason: `expected version ${input.expectedVersion}, found ${current.version}`,
            });
          }
        }
        yield* write((txn) => txn.retract(seq));
        return true;
      }),
  } satisfies DocumentsApi;
};
