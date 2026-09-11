import { createHash } from "node:crypto";
import { Effect, Stream } from "effect";
import type { Json, JsonObject } from "./json.js";
import {
  COLLECTION_NAME_PATTERN,
  isReservedCollectionName,
  RESERVED_COLLECTION_PREFIX,
} from "./naming.js";
import {
  IDEMPOTENCY_NAMESPACE_PREFIX, MOVE_FENCE_NAMESPACE, TENANT_COLUMN, TENANT_MARKER,
  TENANT_NAMESPACE,
} from "./tenancy.js";
import {
  CollectionExists,
  SchemaViolation,
  CollectionNotFound,
  DocumentConflict,
  DocumentNotFound,
  IdempotencyKeyReused,
  InvalidCollectionName,
  TenantMoving,
  CursorMismatch,
  IndexExists,
  InvalidIndex,
  UnsupportedOrdering,
} from "./errors.js";
import type { DbError } from "./errors.js";
import { compareOrderedValues, orderedTuple, sameOrderedKind } from "./keys.js";
import type { IndexManifest, OrderedScalar, Seq } from "./model.js";
import { and, equals, or, type Query, type RangeBound } from "./query.js";
import type { SchemasApi } from "./schemas.js";
import type { ObjectStoreApi, OrderedCursor, Txn } from "./store.js";
import type { TenantId } from "./topology.js";

export type { Json, JsonObject } from "./json.js";

export type CollectionSurface = "content-studio" | "database";

export interface Collection {
  readonly name: string;
  readonly createdAt: string;
  readonly surface: CollectionSurface;
  readonly metadata?: Record<string, unknown>;
  /** Composite indexes over the collection's documents; see `CollectionIndex`. */
  readonly indexes?: ReadonlyArray<CollectionIndex>;
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

/**
 * Where documents with no value at a path go: null, absent, or an object or
 * array, none of which has a place in value order. Last unless `"first"`, in
 * either direction: the placement is its own choice, not a side effect of the
 * direction.
 */
export type NullPlacement = "first" | "last";

export interface DocumentSort {
  readonly path: string;
  readonly direction?: "asc" | "desc";
  readonly nulls?: NullPlacement;
}

/** One field of a composite index: ascending, nulls last, unless given. */
export interface IndexField {
  readonly path: string;
  readonly direction?: "asc" | "desc";
  readonly nulls?: NullPlacement;
}

export interface IndexDefinition {
  /** Letters, numbers, underscores and hyphens, like a collection name. */
  readonly name: string;
  /** In order: by the first field, then by the second among equals, and so on. */
  readonly fields: ReadonlyArray<IndexField>;
}

/**
 * A composite index over one collection.
 *
 * One ordered run over every document in the collection, keyed by the values
 * of its fields in the declared order, with each field's direction and null
 * placement. It serves an order made of its fields — each as declared, or each
 * with direction and null placement both flipped, which is the index read
 * backwards — after any leading fields an equality filter fixes. A document
 * with no value at a field is in the index all the same, where that field's
 * null placement puts it, so one read covers the collection.
 */
export interface CollectionIndex {
  readonly name: string;
  readonly fields: ReadonlyArray<Required<IndexField>>;
  /** Only a ready index answers reads; a building one is still adding the documents written before it. */
  readonly state: "building" | "ready";
}

export interface FindDocumentsInput {
  readonly collection: string;
  readonly where?: ReadonlyArray<DocumentFilter>;
  readonly orderBy?: ReadonlyArray<DocumentSort>;
  readonly limit?: number;
  readonly offset?: number;
}

declare const DocumentCursorBrand: unique symbol;

/** Where a page of documents stopped. Opaque, and bound to its tenant, collection and order. */
export type DocumentCursor = string & { readonly [DocumentCursorBrand]: true };

export interface FindPageInput {
  readonly collection: string;
  readonly where?: ReadonlyArray<DocumentFilter>;
  /** One field, or several that a composite index serves: see `CollectionIndex`. */
  readonly orderBy?: ReadonlyArray<DocumentSort>;
  /** Documents per page: 50 unless given, and at most 1000. */
  readonly limit?: number;
  readonly after?: DocumentCursor;
}

export interface DocumentPage {
  readonly documents: ReadonlyArray<Document>;
  /** Present only when another matching document follows. */
  readonly next?: DocumentCursor;
}

/** Marks a stored collection record, distinct from any collection name. */
const COLLECTION_MARKER = "\u0000collection";

/**
 * What a keyed write did, so a retry can be answered instead of repeated.
 *
 * The fingerprint is of the request rather than of the result: two callers
 * asking for the same thing should share an outcome, and one caller reusing a
 * key for something else should be told so.
 */
interface Receipt {
  readonly key: string;
  readonly fingerprint: string;
  /** The request in words, so a reuse can say what the key was first spent on. */
  readonly request: string;
  readonly result: unknown;
  readonly at: string;
}

const idempotencyNs = (tenant: TenantId) => `${IDEMPOTENCY_NAMESPACE_PREFIX}${tenant}`;

/** Marks a receipt, so this tenant's can be found without reading the shard. */
const idempotencyColumn = (tenant: TenantId) => `${IDEMPOTENCY_NAMESPACE_PREFIX}${tenant}`;
const RECEIPT_MARKER = "\u0000receipt";

/**
 * A stable fingerprint of a request.
 *
 * Keys are sorted at every level, because two callers writing the same fields
 * in a different order are making the same request and a retry that reordered
 * them would otherwise look like a different one.
 */
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
};

const fingerprintOf = (request: unknown): string =>
  createHash("sha256").update(canonical(request)).digest("hex");


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

/**
 * The ordered-lens column one index keeps its postings in.
 *
 * Unique to one creation of the index. A document written before an index was
 * dropped can keep its postings until it is next written, and an index
 * recreated under the same name must never read them as its own. A collection
 * name holds no `:` or `.`, so this never meets a field's column.
 */
const indexColumnFor = (tenant: TenantId, collection: string, name: string) =>
  `${tenant}/${collection}:${name}#${crypto.randomUUID().slice(0, 8)}`;

/** An index as the collection record stores it: with the column its postings are in. */
interface StoredIndex extends CollectionIndex {
  readonly column: string;
}

interface StoredCollection extends Omit<Collection, "indexes"> {
  readonly indexes?: ReadonlyArray<StoredIndex>;
}

const publicIndex = (index: StoredIndex): CollectionIndex => ({
  name: index.name,
  fields: index.fields,
  state: index.state,
});

const publicCollection = (stored: StoredCollection): Collection =>
  stored.indexes === undefined ? stored : { ...stored, indexes: stored.indexes.map(publicIndex) };

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
 * Flatten a document into scalar postings, one per value, null included.
 *
 * Every scalar reachable by a dotted path is indexed in the ordered lens, which
 * answers equality, ranges and order from one posting: typed, so `10` and
 * `"10"` are different values. Null is indexed because it has a place in that
 * order, last; objects and arrays are skipped rather than stringified, because
 * a posting for `{"a":1}` would only match a query that happened to serialize
 * it identically, which is a match nobody intends.
 */
const columnsFor = (
  tenant: TenantId,
  collection: string,
  data: JsonObject,
): Array<readonly [string, OrderedScalar]> => {
  const out: Array<readonly [string, OrderedScalar]> = [[collectionColumn(tenant), collection]];
  const walk = (value: Json, path: string): void => {
    if (value === null || isScalar(value)) {
      if (path !== "") out.push([columnFor(tenant, collection, path), value]);
      return;
    }
    if (Array.isArray(value)) return;
    for (const [k, v] of Object.entries(value)) walk(v, path === "" ? k : `${path}.${k}`);
  };
  walk(data, "");
  return out;
};

/** A value at a path as the ordered lens sees it, or undefined when it has no place in the order. */
const orderable = (value: Json | undefined): OrderedScalar | undefined =>
  value === null || isScalar(value) ? value : undefined;

/**
 * Document order at one path, in a direction, with a null placement.
 *
 * Values follow the ordered lens's order, reversed for descending. A document
 * whose value there is null or absent — or an object or array, which has no
 * place in the order — comes after every value in both directions, or before
 * every one with nulls first. Documents equal on every sort field keep
 * ascending identifier order, which a stable sort preserves; that is the one
 * place this differs from a backwards read of an index, which visits them in
 * descending identifier order.
 */
const compareAt = (
  left: Json | undefined,
  right: Json | undefined,
  direction: "asc" | "desc",
  nulls: NullPlacement,
): number => {
  const a = orderable(left);
  const b = orderable(right);
  const aHas = a !== undefined && a !== null;
  const bHas = b !== undefined && b !== null;
  if (!aHas || !bHas) return aHas === bHas ? 0 : (aHas ? -1 : 1) * (nulls === "first" ? -1 : 1);
  const order = compareOrderedValues(a, b);
  return direction === "desc" ? -order : order;
};

/** A sort with its defaults filled in. */
type Sort = Required<DocumentSort>;

const normalizeSorts = (sorts: ReadonlyArray<DocumentSort> | undefined): Array<Sort> =>
  (sorts ?? []).map((sort) => ({
    path: sort.path,
    direction: sort.direction === "desc" ? "desc" : "asc",
    nulls: sort.nulls === "first" ? "first" : "last",
  }));

const describeFields = (fields: ReadonlyArray<Required<IndexField>>): string =>
  fields.map((field) => `${field.path} ${field.direction} nulls ${field.nulls}`).join(", ");

const sameFields = (
  a: ReadonlyArray<Required<IndexField>>,
  b: ReadonlyArray<Required<IndexField>>,
): boolean =>
  a.length === b.length &&
  a.every((field, i) =>
    field.path === b[i]!.path && field.direction === b[i]!.direction && field.nulls === b[i]!.nulls);

/** Enough for any order a page is likely to ask for, and a bound on a key's length. */
const MAX_INDEX_FIELDS = 8;

/**
 * An index definition with its defaults filled in, or why it cannot be built.
 *
 * Checked field by field at runtime as well as by type, because a definition
 * also arrives as JSON over HTTP.
 */
const normalizeIndex = (
  collection: string,
  definition: IndexDefinition,
): Effect.Effect<{ readonly name: string; readonly fields: Array<Required<IndexField>> }, InvalidIndex> => {
  const invalid = (reason: string) =>
    Effect.fail(new InvalidIndex({ collection, name: String(definition.name), reason }));
  if (typeof definition.name !== "string" || !COLLECTION_NAME_PATTERN.test(definition.name)) {
    return invalid(
      "an index name must start with a letter or underscore and contain only letters, numbers, underscores, or hyphens",
    );
  }
  if (!Array.isArray(definition.fields) || definition.fields.length === 0 ||
    definition.fields.length > MAX_INDEX_FIELDS) {
    return invalid(`an index takes 1 to ${MAX_INDEX_FIELDS} fields`);
  }
  const fields: Array<Required<IndexField>> = [];
  for (const field of definition.fields) {
    const path: unknown = field?.path;
    if (typeof path !== "string" || path === "" || path.split(".").some((segment) => segment === "")) {
      return invalid(`${JSON.stringify(path) ?? "undefined"} is not a field path`);
    }
    if (fields.some((seen) => seen.path === path)) return invalid(`"${path}" appears twice`);
    const direction = field.direction ?? "asc";
    if (direction !== "asc" && direction !== "desc") {
      return invalid(`the direction of "${path}" must be "asc" or "desc"`);
    }
    const nulls = field.nulls ?? "last";
    if (nulls !== "first" && nulls !== "last") {
      return invalid(`the nulls of "${path}" must be "first" or "last"`);
    }
    fields.push({ path, direction, nulls });
  }
  return Effect.succeed({ name: definition.name, fields });
};

/** A document's position in one index. */
const indexTuple = (index: StoredIndex, data: JsonObject): string =>
  orderedTuple(index.fields.map((field) => ({
    value: orderable(readPath(data, field.path)),
    direction: field.direction,
    nulls: field.nulls,
  })));

/**
 * The fields an equality filter fixes to one scalar, which an index can seek
 * to rather than filter by. Null is left to the filter: an index files null
 * with absent, and an equality with null matches only null.
 */
const equalityBindings = (where: ReadonlyArray<DocumentFilter>): Map<string, OrderedScalar> => {
  const out = new Map<string, OrderedScalar>();
  for (const filter of where) {
    if ((filter.op ?? "eq") !== "eq" || out.has(filter.path)) continue;
    const value = orderable(filter.value as Json);
    if (value !== undefined && value !== null) out.set(filter.path, value);
  }
  return out;
};

interface IndexedOrder {
  readonly index: StoredIndex;
  /** Read backwards: every field's direction and null placement flipped. */
  readonly reverse: boolean;
  /** The leading fields an equality fixes, encoded; the read stays within it. */
  readonly prefix: string;
}

/**
 * The index that serves an order, if one does.
 *
 * An index serves it when, after leading fields an equality filter fixes, its
 * next fields are the order's — each with the same direction and null
 * placement, or each with both flipped. Fixing more leading fields narrows
 * the read, so the index fixing the most wins. A single field has its own
 * ordered lens, so an index serves it only when it can also seek past a fixed
 * prefix, which that lens can only filter for.
 */
const chooseIndex = (
  indexes: ReadonlyArray<StoredIndex>,
  sorts: ReadonlyArray<Sort>,
  bindings: ReadonlyMap<string, OrderedScalar>,
): IndexedOrder | undefined => {
  let best: { readonly order: IndexedOrder; readonly fixed: number } | undefined;
  for (const index of indexes) {
    if (index.state !== "ready") continue;
    const { fields } = index;
    let bound = 0;
    while (bound < fields.length && bindings.has(fields[bound]!.path)) bound += 1;
    for (let fixed = Math.min(bound, fields.length - sorts.length); fixed >= 0; fixed--) {
      const next = fields.slice(fixed, fixed + sorts.length);
      const same = next.every((field, i) =>
        field.path === sorts[i]!.path && field.direction === sorts[i]!.direction && field.nulls === sorts[i]!.nulls);
      const flipped = next.every((field, i) =>
        field.path === sorts[i]!.path && field.direction !== sorts[i]!.direction && field.nulls !== sorts[i]!.nulls);
      if (!same && !flipped) continue;
      if (sorts.length === 1 && fixed === 0) break;
      if (best === undefined || fixed > best.fixed) {
        const prefix = orderedTuple(fields.slice(0, fixed).map((field) => ({
          value: bindings.get(field.path),
          direction: field.direction,
          nulls: field.nulls,
        })));
        best = { order: { index, reverse: flipped, prefix }, fixed };
      }
      break;
    }
  }
  return best?.order;
};

/**
 * How two values compare for a filter, or undefined when they do not.
 *
 * A comparison holds only between values of one kind, as a one-sided range in
 * the ordered lens does: `lt 5` is not satisfied by `true`, by null, or by a
 * field that is absent.
 */
const comparison = (actual: Json | undefined, expected: Json): number | undefined => {
  const a = orderable(actual);
  const e = orderable(expected);
  return a === undefined || e === undefined || !sameOrderedKind(a, e)
    ? undefined
    : compareOrderedValues(a, e);
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
    case "gt": {
      const order = comparison(actual, expected);
      return order !== undefined && order > 0;
    }
    case "gte": {
      const order = comparison(actual, expected);
      return order !== undefined && order >= 0;
    }
    case "lt": {
      const order = comparison(actual, expected);
      return order !== undefined && order < 0;
    }
    case "lte": {
      const order = comparison(actual, expected);
      return order !== undefined && order <= 0;
    }
  }
};

/**
 * Build the lens query for the filters that lenses can answer.
 *
 * `eq` and `in` become typed postings, and a comparison on a scalar becomes a
 * range that compares like with like, all answered by the ordered lens with no
 * second look at the document. Anything else — `ne`, or a value that is an
 * object or array — is applied to the candidates afterwards; the split is
 * deliberate and visible rather than a silent full scan.
 */
interface Plan {
  /** Every matching document, the collection clause included. */
  readonly query: Query;
  /**
   * The same filter without the collection clause, or undefined when there is
   * nothing but it. A field's column name carries the tenant and collection, so
   * any posting under it already belongs to this collection: re-checking
   * membership would cost a scan of the whole collection for nothing.
   */
  readonly fields: Query | undefined;
  readonly residual: ReadonlyArray<DocumentFilter>;
}

const planQuery = (
  tenant: TenantId,
  collection: string,
  where: ReadonlyArray<DocumentFilter>,
): Plan => {
  const clauses: Query[] = [];
  const residual: DocumentFilter[] = [];
  for (const filter of where) {
    const op = filter.op ?? "eq";
    const column = columnFor(tenant, collection, filter.path);
    const value = filter.value as Json;
    const scalar = orderable(value);
    if (op === "eq" && scalar !== undefined) {
      clauses.push(equals(column, scalar));
    } else if (
      op === "in" && Array.isArray(filter.value) && filter.value.length > 0 &&
      filter.value.every((member) => orderable(member) !== undefined)
    ) {
      clauses.push(or(...filter.value.map((member) => equals(column, orderable(member)!))));
    } else if (op === "gt" || op === "gte" || op === "lt" || op === "lte") {
      if (scalar === undefined) {
        residual.push(filter);
        continue;
      }
      const bound: RangeBound = { value: scalar, inclusive: op === "gte" || op === "lte" };
      clauses.push(
        op === "gt" || op === "gte"
          ? { _tag: "Range", column, lower: bound }
          : { _tag: "Range", column, upper: bound },
      );
    } else {
      residual.push(filter);
    }
  }
  const fields = clauses.length === 0 ? undefined : clauses.length === 1 ? clauses[0]! : and(...clauses);
  return {
    // Field clauses are already confined to the collection (see `fields`), so
    // the collection's own posting is needed only when there are none.
    query: fields ?? equals(collectionColumn(tenant), collection),
    fields,
    residual,
  };
};

/** Where a read of documents in order stands: after one document, in one of its runs. */
type Position =
  | { readonly phase: "values"; readonly cursor: OrderedCursor }
  | { readonly phase: "rest"; readonly seq: number }
  | { readonly phase: "seq"; readonly seq: number };

interface Placed {
  readonly document: Document;
  /** The position just after this document. */
  readonly position: Position;
}

interface PageShape {
  readonly collection: string;
  /** The order read, empty for identifier order. */
  readonly order: ReadonlyArray<Sort>;
  /** The column of the index the read goes through, if it goes through one. */
  readonly via: string | undefined;
}

export interface DocumentsApi {
  readonly createCollection: (input: {
    readonly name: string;
    readonly surface?: CollectionSurface;
    readonly metadata?: Record<string, unknown>;
    /** Indexes to start with; an empty collection has nothing to add to them, so they are ready at once. */
    readonly indexes?: ReadonlyArray<IndexDefinition>;
  }) => Effect.Effect<Collection, InvalidCollectionName | CollectionExists | InvalidIndex | TenantMoving>;
  readonly listCollections: Effect.Effect<ReadonlyArray<Collection>>;
  readonly collectionExists: (name: string) => Effect.Effect<boolean>;
  readonly insert: (input: {
    readonly collection: string;
    /**
     * Do this at most once.
     *
     * A retry carrying the same key is answered with what the first attempt
     * returned instead of being applied again. Supply `id` alongside it: a
     * generated one differs on every attempt, which is a different request.
     */
    readonly idempotencyKey?: string;
    readonly id?: string;
    readonly data: JsonObject;
  }) => Effect.Effect<
    Document,
    CollectionNotFound | DocumentConflict | SchemaViolation | TenantMoving | IdempotencyKeyReused
  >;
  readonly findById: (input: {
    readonly collection: string;
    readonly id: string;
  }) => Effect.Effect<Document | undefined>;
  /**
   * Every matching document, ordered and sliced as asked.
   *
   * Ordered by one field, it reads that field's ordered lens rather than
   * sorting; by several, it reads a composite index that serves the order, or
   * failing one sorts in memory, in the order such an index would give.
   */
  readonly findMany: (input: FindDocumentsInput) => Effect.Effect<ReadonlyArray<Document>>;
  /**
   * One page of matching documents, and a cursor for the next.
   *
   * Ordered by one field from its ordered lens, or by several from a composite
   * index that serves them, in either direction — so a page costs about what it
   * returns rather than a sort of every match. An order of several fields that
   * no index serves is refused rather than sorted. Without an order, documents
   * come in identifier order. `next` is present only when another matching
   * document exists, so the last page is never an empty one.
   */
  readonly findPage: (
    input: FindPageInput,
  ) => Effect.Effect<DocumentPage, CursorMismatch | UnsupportedOrdering>;
  readonly update: (input: {
    readonly collection: string;
    /** Do this at most once; see `insert`. */
    readonly idempotencyKey?: string;
    readonly id: string;
    readonly data: JsonObject;
    readonly mode?: "merge" | "replace";
    readonly expectedVersion?: number;
  }) => Effect.Effect<
    Document,
    DocumentNotFound | DocumentConflict | SchemaViolation | TenantMoving | IdempotencyKeyReused
  >;
  readonly delete: (input: {
    readonly collection: string;
    /** Do this at most once; see `insert`. */
    readonly idempotencyKey?: string;
    readonly id: string;
    readonly expectedVersion?: number;
  }) => Effect.Effect<boolean, DocumentConflict | TenantMoving | IdempotencyKeyReused>;

  /**
   * Add a composite index to a collection, and return it once it is ready.
   *
   * The documents already there are added by writing each back with its new
   * posting — one log entry per document, a few hundred per transaction — while
   * other writes carry on, and reads use the index only once all of them are
   * in it. Asking again for an index that exists over the same fields returns
   * it, finishing it first if an earlier call was interrupted.
   */
  readonly createIndex: (
    input: IndexDefinition & { readonly collection: string },
  ) => Effect.Effect<CollectionIndex, CollectionNotFound | IndexExists | InvalidIndex | TenantMoving>;

  /**
   * Remove an index and clear its postings, which costs a write per document
   * as building it did. False when the collection has no index by that name.
   */
  readonly dropIndex: (input: {
    readonly collection: string;
    readonly name: string;
  }) => Effect.Effect<boolean, CollectionNotFound | TenantMoving>;

  /**
   * Forget completed idempotency keys, returning how many were dropped.
   *
   * Receipts grow with requests rather than with data, and nothing expires them
   * on its own: how long a retry may arrive is the caller's question, not the
   * database's. Forgetting a key makes a retry carrying it an ordinary write
   * again — which for an insert means a duplicate-id conflict rather than a
   * duplicate document, so the cost of pruning too early is a refusal, not a
   * repeat.
   */
  readonly forgetIdempotencyKeys: (input?: {
    /** Keep receipts recorded at or after this instant. Omit to forget all. */
    readonly before?: string;
  }) => Effect.Effect<number>;
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

  /**
   * What a key was used for last time, if it has been used.
   *
   * A key that comes back attached to a different request is refused rather
   * than answered: replying with the stored outcome would tell a caller that
   * something happened which did not.
   */
  const receiptFor = (key: string, fingerprint: string, request: string) =>
    Effect.gen(function* () {
      const seq = yield* lookup(idempotencyNs(tenant), key);
      if (seq === undefined) return undefined;
      const object = yield* readObject(seq);
      if (object === undefined) return undefined;
      const receipt = decode<Receipt>(object.bytes);
      if (receipt.fingerprint !== fingerprint) {
        return yield* new IdempotencyKeyReused({
          tenant,
          key,
          detail: `first used for ${receipt.request}, now offered for ${request}`,
        });
      }
      return receipt;
    });

  /**
   * Apply a change and, if the caller gave a key, record what it did — together.
   *
   * One transaction for both. Recording the receipt afterwards would leave a
   * window in which the write had happened and the key had not been noted,
   * which is exactly the window a retry falls into and the one direction of
   * failure a key exists to prevent.
   */
  const commitOnce = <A>(
    key: string | undefined,
    fingerprint: string,
    request: string,
    result: A,
    change: (txn: Txn) => Effect.Effect<void, DbError>,
  ): Effect.Effect<A> =>
    Effect.gen(function* () {
      if (key === undefined) {
        yield* write(change);
        return result;
      }
      const seq = yield* nextSeq;
      yield* write((txn) =>
        Effect.gen(function* () {
          yield* change(txn);
          yield* rememberKey(txn, {
            key, fingerprint, request, result, at: new Date().toISOString(),
          }, seq);
        }));
      return result;
    });

  const loadCollection = (name: string) =>
    Effect.gen(function* () {
      const seq = yield* lookup(collectionNs(tenant), name);
      if (seq === undefined) return undefined;
      const object = yield* readObject(seq);
      return object === undefined ? undefined : decode<StoredCollection>(object.bytes);
    });

  const requireCollection = (name: string) =>
    Effect.filterOrFail(
      loadCollection(name),
      (found): found is StoredCollection => found !== undefined,
      () => new CollectionNotFound({ name }),
    );

  const indexesOf = (collection: string) =>
    Effect.map(loadCollection(collection), (found) => found?.indexes ?? []);

  const readDocument = (seq: Seq) =>
    Effect.map(readObject(seq), (o) => (o === undefined ? undefined : decode<Document>(o.bytes)));

  /**
   * Refuse a write to a tenant that is being relocated off this shard.
   *
   * One point lookup ahead of each write. That is a real cost on a hot path for
   * an operation that happens rarely, and it is the price of the alternative
   * being a write that lands in records nobody will read again — a move would
   * otherwise have to take the tenant offline for reads as well, just to keep
   * the two copies from diverging.
   */
  const assertNotMoving = Effect.gen(function* () {
    const seq = yield* lookup(MOVE_FENCE_NAMESPACE, tenant);
    if (seq === undefined) return;
    const fence = yield* readObject(seq);
    if (fence === undefined) return;
    const { from, to } = decode<{ from: string; to: string }>(fence.bytes);
    return yield* new TenantMoving({ tenant, from, to });
  });

  const transactOrDie = <A>(f: (txn: Txn) => Effect.Effect<A, DbError>): Effect.Effect<A> =>
    Effect.orDie(store.transact(f));

  const collectionPut = (txn: Txn, seq: Seq, collection: StoredCollection) =>
    txn.put(seq, encode(collection), {
      terms: [],
      columns: [[collectionColumn(tenant), COLLECTION_MARKER]],
      measures: [],
      edges: [],
    }, { namespace: collectionNs(tenant), key: collection.name });

  /** Every posting a document contributes: a column per scalar, and a tuple per index. */
  const manifestFor = (doc: Document, indexes: ReadonlyArray<StoredIndex>): IndexManifest => ({
    terms: [],
    columns: [
      ...columnsFor(tenant, doc.collection, doc.data),
      ...indexes.map((index) => [index.column, indexTuple(index, doc.data)] as const),
    ],
    measures: [],
    edges: [],
  });

  /**
   * Write a document with every posting it contributes, its indexes' included.
   *
   * The indexes are read here, inside the transaction, and not by the caller.
   * A transaction holds the store's one writer, so an index created alongside
   * this write was either recorded before it — and is included — or after it,
   * and its backfill finds this document. Read before the transaction, the
   * write could land between the two and be missing from the index for good.
   */
  const documentPut = (txn: Txn, doc: Document, seq: Seq) =>
    Effect.gen(function* () {
      const indexes = (yield* loadCollection(doc.collection))?.indexes ?? [];
      yield* txn.put(seq, encode(doc), manifestFor(doc, indexes), {
        namespace: documentNs(tenant, doc.collection), key: doc.id,
      });
    });

  const keeps = (plan: Plan) => (doc: Document | undefined): doc is Document =>
    doc !== undefined && plan.residual.every((filter) => matches(doc.data, filter));

  /**
   * One page of an ordered read, with store failures turned into defects as
   * everywhere else here, and a foreign cursor into the one error a caller can
   * act on: the tenant moved between pages, so the read has to start again.
   */
  const orderedPage = (input: Parameters<ObjectStoreApi["ordered"]>[0]) =>
    store.ordered(input).pipe(
      Effect.catch((error) =>
        error._tag === "CursorMismatch"
          ? Effect.fail(error)
          : error._tag === "ForeignCursor"
            ? Effect.fail(new CursorMismatch({
              reason: "the tenant moved to another shard since this cursor was issued; start the read again",
            }))
            : Effect.die(error)),
    );

  /**
   * Matching documents in the order of one field, from a position onward.
   *
   * Two runs make up the order. Documents with a value at the path come from
   * the ordered lens, page by page, filtered by the plan's field clauses as the
   * lens is read — the range stops short of null, which the lens sorts last.
   * The rest, whose value is null or absent or an object or array, come in
   * identifier order in either direction, after the values or before them as
   * the sort's null placement says: they are what the plan matches minus what
   * the value run holds, a subtraction only the pages reaching them pay for.
   * Every document carries the position just after it, so a page can end on
   * any document exactly. `take` bounds how many are gathered; undefined
   * gathers all.
   */
  const inOrder = (
    plan: Plan,
    collection: string,
    sort: Sort,
    take: number | undefined,
    from: Position | undefined,
  ): Effect.Effect<Array<Placed>, CursorMismatch> =>
    Effect.gen(function* () {
      const column = columnFor(tenant, collection, sort.path);
      // From the lowest value there is, `false`, up to where null begins.
      const values = {
        lower: { value: false, inclusive: true },
        upper: { value: null, inclusive: false },
      } as const;
      const keep = keeps(plan);
      const out: Array<Placed> = [];
      const full = () => take !== undefined && out.length >= take;

      const valueRun = (after: OrderedCursor | undefined) =>
        Effect.gen(function* () {
          let cursor = after;
          for (;;) {
            if (full()) return;
            const limit = take === undefined ? 256 : Math.max(1, Math.min(256, take - out.length));
            const page = yield* orderedPage({
              column, direction: sort.direction, limit, ...values,
              ...(plan.fields === undefined ? {} : { where: plan.fields }),
              ...(cursor === undefined ? {} : { after: cursor }),
            });
            for (const row of page.rows) {
              if (full()) return;
              const doc = yield* readDocument(row.seq);
              if (keep(doc)) out.push({ document: doc, position: { phase: "values", cursor: row.cursor } });
            }
            if (page.next === undefined) return;
            cursor = page.next;
          }
        });

      const restRun = (after: number | undefined) =>
        Effect.gen(function* () {
          if (full()) return;
          const valued = new Set(
            [...(yield* Stream.runCollect(
              resolveQuery(and(plan.query, { _tag: "Range", column, ...values })),
            ))].map(Number),
          );
          for (const seq of yield* Stream.runCollect(resolveQuery(plan.query))) {
            if (full()) return;
            if (valued.has(Number(seq)) || (after !== undefined && Number(seq) <= after)) continue;
            const doc = yield* readDocument(seq);
            if (keep(doc)) out.push({ document: doc, position: { phase: "rest", seq: Number(seq) } });
          }
        });

      // A position lies in one run: resume there, skipping the runs before it.
      const runs = sort.nulls === "first" ? (["rest", "values"] as const) : (["values", "rest"] as const);
      let started = from === undefined;
      for (const run of runs) {
        if (!started && from?.phase !== run) continue;
        started = true;
        const resume = from?.phase === run ? from : undefined;
        if (run === "values") yield* valueRun(resume?.phase === "values" ? resume.cursor : undefined);
        else yield* restRun(resume?.phase === "rest" ? resume.seq : undefined);
      }
      return out;
    });

  /**
   * Matching documents in the order of a composite index, from a position onward.
   *
   * One run: every document of the collection is in the index, those without a
   * value at some field included, so there is no second run to subtract. The
   * read stays within the prefix the equality filters fix, and the plan's field
   * clauses filter it as it goes.
   */
  const inIndexOrder = (
    plan: Plan,
    indexed: IndexedOrder,
    take: number | undefined,
    from: Position | undefined,
  ): Effect.Effect<Array<Placed>, CursorMismatch> =>
    Effect.gen(function* () {
      const keep = keeps(plan);
      const out: Array<Placed> = [];
      const full = () => take !== undefined && out.length >= take;
      const bounds = indexed.prefix === ""
        ? {}
        : {
          lower: { value: indexed.prefix, inclusive: true },
          // Past every tuple the prefix begins: hex digits all sort below "g".
          upper: { value: `${indexed.prefix}g`, inclusive: false },
        };
      let cursor = from?.phase === "values" ? from.cursor : undefined;
      for (;;) {
        if (full()) return out;
        const limit = take === undefined ? 256 : Math.max(1, Math.min(256, take - out.length));
        const page = yield* orderedPage({
          column: indexed.index.column, direction: indexed.reverse ? "desc" : "asc", limit, ...bounds,
          ...(plan.fields === undefined ? {} : { where: plan.fields }),
          ...(cursor === undefined ? {} : { after: cursor }),
        });
        for (const row of page.rows) {
          if (full()) return out;
          const doc = yield* readDocument(row.seq);
          if (keep(doc)) out.push({ document: doc, position: { phase: "values", cursor: row.cursor } });
        }
        if (page.next === undefined) return out;
        cursor = page.next;
      }
    });

  /** Documents a rewrite puts back per transaction, releasing the writer between them. */
  const REWRITE_CHUNK = 256;

  /**
   * Put every document of a collection back with the postings its indexes now
   * call for: what completes an index built over existing documents, and what
   * clears a dropped one's postings.
   *
   * Each document is read inside the transaction that rewrites it, under the
   * store's one writer, so a concurrent update is never overwritten with what
   * was read before it; and its bytes go back unchanged, so its version and
   * timestamps do not move. Rewriting a document that already has the right
   * postings writes the same ones again, so an interrupted rewrite is finished
   * by running it again.
   */
  const rewriteDocuments = (collection: string) =>
    Effect.gen(function* () {
      const seqs = [...(yield* Stream.runCollect(resolveQuery(equals(collectionColumn(tenant), collection))))];
      for (let at = 0; at < seqs.length; at += REWRITE_CHUNK) {
        yield* write((txn) =>
          Effect.gen(function* () {
            const indexes = (yield* loadCollection(collection))?.indexes ?? [];
            for (const seq of seqs.slice(at, at + REWRITE_CHUNK)) {
              const object = yield* readObject(seq);
              if (object === undefined) continue;
              const doc = decode<Document>(object.bytes);
              if (doc.collection !== collection) continue;
              yield* txn.put(seq, object.bytes, manifestFor(doc, indexes), {
                namespace: documentNs(tenant, collection), key: doc.id,
              });
            }
          }));
      }
    });

  /** Matching documents in identifier order, the order `resolve` already has. */
  const inIdentifierOrder = (plan: Plan, take: number, from: Position | undefined) =>
    Effect.gen(function* () {
      const keep = keeps(plan);
      const after = from?.phase === "seq" ? from.seq : undefined;
      const out: Array<Placed> = [];
      for (const seq of yield* Stream.runCollect(resolveQuery(plan.query))) {
        if (out.length >= take) break;
        if (after !== undefined && Number(seq) <= after) continue;
        const doc = yield* readDocument(seq);
        if (keep(doc)) out.push({ document: doc, position: { phase: "seq", seq: Number(seq) } });
      }
      return out;
    });

  const orderOf = (order: ReadonlyArray<Sort>) =>
    order.map((sort) => [sort.path, sort.direction, sort.nulls]);

  const describeOrder = (order: unknown): string =>
    Array.isArray(order) && order.length > 0
      ? order.map((sort) => (Array.isArray(sort) ? `${String(sort[0])} ${String(sort[1])}` : "?")).join(", ")
      : "identifier order";

  const encodeDocumentCursor = (shape: PageShape, position: Position): DocumentCursor =>
    Buffer.from(
      JSON.stringify({
        v: 2, t: tenant, c: shape.collection, o: orderOf(shape.order), x: shape.via ?? null, p: position,
      }),
      "utf8",
    ).toString("base64url") as DocumentCursor;

  const decodeDocumentCursor = (
    cursor: DocumentCursor,
    shape: PageShape,
  ): Effect.Effect<Position, CursorMismatch> =>
    Effect.gen(function* () {
      const malformed = new CursorMismatch({ reason: "the cursor is not one findPage produced" });
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      } catch {
        return yield* malformed;
      }
      if (typeof parsed !== "object" || parsed === null) return yield* malformed;
      const { v, t, c, o, x, p } = parsed as Record<string, unknown>;
      if (v !== 2 || typeof p !== "object" || p === null) return yield* malformed;
      if (t !== tenant || c !== shape.collection || JSON.stringify(o) !== JSON.stringify(orderOf(shape.order))) {
        return yield* new CursorMismatch({
          reason: `the cursor continues a different read: ${describeOrder(o)} over "${String(c)}"`,
        });
      }
      if (x !== (shape.via ?? null)) {
        return yield* new CursorMismatch({
          reason: "the collection's indexes changed since this cursor was issued; start the read again",
        });
      }
      const { phase, seq, cursor: inner } = p as Record<string, unknown>;
      if (shape.order.length === 0) {
        if (phase === "seq" && typeof seq === "number") return { phase, seq };
      } else if (phase === "rest" && typeof seq === "number" && shape.via === undefined) {
        return { phase, seq };
      } else if (phase === "values" && typeof inner === "string") {
        return { phase, cursor: inner as OrderedCursor };
      }
      return yield* malformed;
    });

  /**
   * A completed write, remembered under the key the caller gave it.
   *
   * Written in the same transaction as the change it describes. Recording it
   * afterwards would leave a window where the write had happened and the key
   * had not been noted — precisely the window a retry falls into, and the one
   * direction of failure the key exists to prevent.
   */
  const rememberKey = (txn: Txn, receipt: Receipt, seq: Seq) =>
    txn.put(seq, encode(receipt), {
      terms: [],
      // Marked so a tenant's receipts can be swept without walking the shard;
      // they are the one thing here that accumulates with requests rather than
      // with data, so there has to be a way to let them go.
      columns: [[idempotencyColumn(tenant), RECEIPT_MARKER]],
      measures: [],
      edges: [],
    }, { namespace: idempotencyNs(tenant), key: receipt.key });

  return {
    createCollection: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        yield* validateName(input.name);
        const existing = yield* loadCollection(input.name);
        if (existing !== undefined) return yield* new CollectionExists({ name: input.name });
        const indexes: Array<StoredIndex> = [];
        for (const definition of input.indexes ?? []) {
          const index = yield* normalizeIndex(input.name, definition);
          if (indexes.some((other) => other.name === index.name)) {
            return yield* new InvalidIndex({ collection: input.name, name: index.name, reason: "the name is given twice" });
          }
          indexes.push({ ...index, state: "ready", column: indexColumnFor(tenant, input.name, index.name) });
        }
        const collection: StoredCollection = {
          name: input.name,
          createdAt: new Date().toISOString(),
          surface: input.surface ?? "database",
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
          ...(indexes.length === 0 ? {} : { indexes }),
        };
        const seq = yield* nextSeq;
        yield* write((txn) => collectionPut(txn, seq, collection));
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
        return publicCollection(collection);
      }),

    listCollections: Effect.gen(function* () {
      const seqs = yield* Stream.runCollect(
        resolveQuery(equals(collectionColumn(tenant), COLLECTION_MARKER)),
      );
      const out: Collection[] = [];
      for (const seq of seqs) {
        const object = yield* readObject(seq);
        if (object !== undefined) out.push(publicCollection(decode<StoredCollection>(object.bytes)));
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    }),

    collectionExists: (name) => Effect.map(loadCollection(name), (c) => c !== undefined),

    insert: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        const request = `insert into "${input.collection}"`;
        const fingerprint = fingerprintOf({
          op: "insert", collection: input.collection, id: input.id, data: input.data,
        });
        if (input.idempotencyKey !== undefined) {
          const seen = yield* receiptFor(input.idempotencyKey, fingerprint, request);
          if (seen !== undefined) return seen.result as Document;
        }
        yield* requireCollection(input.collection);
        yield* enforceSchema(input.collection, input.data);
        // A generated id would differ on every retry, so a keyed insert without
        // one would store a second document and hand back the first.
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
        return yield* commitOnce(input.idempotencyKey, fingerprint, request, doc,
          (txn) => documentPut(txn, doc, seq));
      }),

    findById: (input) =>
      Effect.gen(function* () {
        const seq = yield* lookup(documentNs(tenant, input.collection), input.id);
        return seq === undefined ? undefined : yield* readDocument(seq);
      }),

    findMany: (input) =>
      Effect.gen(function* () {
        const where = input.where ?? [];
        const plan = planQuery(tenant, input.collection, where);
        const offset = input.offset ?? 0;
        const take = input.limit === undefined ? undefined : offset + input.limit;
        const slice = (docs: ReadonlyArray<Document>) =>
          input.limit === undefined ? docs.slice(offset) : docs.slice(offset, offset + input.limit);
        const sorts = normalizeSorts(input.orderBy);
        if (sorts.length > 0) {
          const indexed = chooseIndex(yield* indexesOf(input.collection), sorts, equalityBindings(where));
          if (indexed !== undefined) {
            const found = yield* inIndexOrder(plan, indexed, take, undefined).pipe(Effect.orDie);
            return slice(found.map((entry) => entry.document));
          }
          if (sorts.length === 1) {
            // One field is served by its ordered lens, in order, without a sort.
            const found = yield* inOrder(plan, input.collection, sorts[0]!, take, undefined).pipe(Effect.orDie);
            return slice(found.map((entry) => entry.document));
          }
        }
        const keep = keeps(plan);
        let docs: Document[] = [];
        for (const seq of yield* Stream.runCollect(resolveQuery(plan.query))) {
          const doc = yield* readDocument(seq);
          if (keep(doc)) docs.push(doc);
        }
        // No index serves these fields, so they are sorted here — in the
        // lens's order, so the answer matches what an index would give.
        for (const sort of [...sorts].reverse()) {
          docs = docs.sort((a, b) =>
            compareAt(readPath(a.data, sort.path), readPath(b.data, sort.path), sort.direction, sort.nulls));
        }
        return slice(docs);
      }),

    findPage: (input) =>
      Effect.gen(function* () {
        const sorts = normalizeSorts(input.orderBy);
        const where = input.where ?? [];
        const indexed = sorts.length === 0
          ? undefined
          : chooseIndex(yield* indexesOf(input.collection), sorts, equalityBindings(where));
        if (sorts.length > 1 && indexed === undefined) {
          return yield* new UnsupportedOrdering({
            reason:
              `a page ordered by ${describeFields(sorts)} needs a composite index over those ` +
              "fields in that order, or in exactly the reverse one; create it with createIndex, " +
              "or use findMany",
          });
        }
        const limit = input.limit ?? 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
          return yield* Effect.die(new RangeError(`findPage takes 1 to 1000 documents per page, not ${limit}.`));
        }
        const shape: PageShape = { collection: input.collection, order: sorts, via: indexed?.index.column };
        const from = input.after === undefined ? undefined : yield* decodeDocumentCursor(input.after, shape);
        const plan = planQuery(tenant, input.collection, where);
        // One more than the page, to know whether another document follows.
        const found = sorts.length === 0
          ? yield* inIdentifierOrder(plan, limit + 1, from)
          : indexed !== undefined
            ? yield* inIndexOrder(plan, indexed, limit + 1, from)
            : yield* inOrder(plan, input.collection, sorts[0]!, limit + 1, from);
        const page = found.slice(0, limit);
        return {
          documents: page.map((entry) => entry.document),
          ...(found.length > limit ? { next: encodeDocumentCursor(shape, page.at(-1)!.position) } : {}),
        };
      }),

    update: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        const request = `update "${input.collection}/${input.id}"`;
        const fingerprint = fingerprintOf({
          op: "update", collection: input.collection, id: input.id, data: input.data,
          mode: input.mode, expectedVersion: input.expectedVersion,
        });
        if (input.idempotencyKey !== undefined) {
          const seen = yield* receiptFor(input.idempotencyKey, fingerprint, request);
          if (seen !== undefined) return seen.result as Document;
        }
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
        return yield* commitOnce(input.idempotencyKey, fingerprint, request, next,
          (txn) => documentPut(txn, next, seq));
      }),

    delete: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        const request = `delete "${input.collection}/${input.id}"`;
        const fingerprint = fingerprintOf({
          op: "delete", collection: input.collection, id: input.id,
          expectedVersion: input.expectedVersion,
        });
        if (input.idempotencyKey !== undefined) {
          const seen = yield* receiptFor(input.idempotencyKey, fingerprint, request);
          if (seen !== undefined) return seen.result as boolean;
        }
        const seq = yield* lookup(documentNs(tenant, input.collection), input.id);
        // Nothing happened, so there is nothing to remember: a later retry that
        // finds the document present should delete it rather than replay a
        // "no" from when it was already gone.
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
        return yield* commitOnce(input.idempotencyKey, fingerprint, request, true,
          (txn) => txn.retract(seq));
      }),

    createIndex: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        const definition = yield* normalizeIndex(input.collection, input);
        const seq = yield* lookup(collectionNs(tenant), input.collection);
        if (seq === undefined) return yield* new CollectionNotFound({ name: input.collection });
        // Recorded first, as building: every write from here on carries it,
        // and the rewrite below adds every document written before.
        const recorded = yield* transactOrDie((txn) =>
          Effect.gen(function* () {
            const current = yield* loadCollection(input.collection);
            if (current === undefined) return undefined;
            const existing = current.indexes?.find((index) => index.name === definition.name);
            if (existing !== undefined) return existing;
            const index: StoredIndex = {
              ...definition,
              state: "building",
              column: indexColumnFor(tenant, input.collection, definition.name),
            };
            yield* collectionPut(txn, seq, { ...current, indexes: [...(current.indexes ?? []), index] });
            return index;
          }));
        if (recorded === undefined) return yield* new CollectionNotFound({ name: input.collection });
        if (!sameFields(recorded.fields, definition.fields)) {
          return yield* new IndexExists({
            collection: input.collection,
            name: definition.name,
            reason: `it is defined over ${describeFields(recorded.fields)}`,
          });
        }
        if (recorded.state === "ready") return publicIndex(recorded);
        // A building index found here may be one an earlier call did not
        // finish; rewriting is idempotent, so finishing it is running it again.
        yield* rewriteDocuments(input.collection);
        const ready = yield* transactOrDie((txn) =>
          Effect.gen(function* () {
            const current = yield* loadCollection(input.collection);
            const indexes = current?.indexes ?? [];
            if (current === undefined || !indexes.some((index) => index.column === recorded.column)) return false;
            yield* collectionPut(txn, seq, {
              ...current,
              indexes: indexes.map((index) =>
                index.column === recorded.column ? { ...index, state: "ready" as const } : index),
            });
            return true;
          }));
        // Dropped while it was being built: what it was is all there is to say.
        return ready ? { ...publicIndex(recorded), state: "ready" } : publicIndex(recorded);
      }),

    dropIndex: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        const seq = yield* lookup(collectionNs(tenant), input.collection);
        if (seq === undefined) return yield* new CollectionNotFound({ name: input.collection });
        const dropped = yield* transactOrDie((txn) =>
          Effect.gen(function* () {
            const current = yield* loadCollection(input.collection);
            const indexes = current?.indexes ?? [];
            if (current === undefined || !indexes.some((index) => index.name === input.name)) return false;
            yield* collectionPut(txn, seq, {
              ...current,
              indexes: indexes.filter((index) => index.name !== input.name),
            });
            return true;
          }));
        // Nothing reads the postings once the index is gone — the column was
        // its alone — and each document's next write would drop them anyway.
        // Clearing them now is what returns the space.
        if (dropped) yield* rewriteDocuments(input.collection);
        return dropped;
      }),

    forgetIdempotencyKeys: (input) =>
      Effect.gen(function* () {
        const seqs = yield* Stream.runCollect(
          resolveQuery(equals(idempotencyColumn(tenant), RECEIPT_MARKER)),
        );
        let forgotten = 0;
        for (const seq of seqs) {
          if (input?.before !== undefined) {
            const object = yield* readObject(seq);
            if (object === undefined) continue;
            if (decode<Receipt>(object.bytes).at >= input.before) continue;
          }
          yield* write((txn) => txn.retract(seq));
          forgotten += 1;
        }
        return forgotten;
      }),
  } satisfies DocumentsApi;
};
