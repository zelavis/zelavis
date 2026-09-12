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
  UniqueViolation,
  CheckViolation,
  InvalidConstraint,
  ConstraintExists,
  ReferenceViolation,
  UnanalyzedCollection,
  UnindexedGeometry,
  UnknownReference,
} from "./errors.js";
import type { DbError } from "./errors.js";
import { compareOrderedValues, decodeOrderedTuple, orderedTuple, sameOrderedKind } from "./keys.js";
import {
  boxGeometry, cellsFor, contains, coveringFor, diskFor, distanceBetween, inBox, loadH3,
  positionsOf, COARSEST_RESOLUTION,
  type BoundingBox, type Geometry, type Position as GeoPosition,
} from "./spatial.js";
import type { IndexManifest, OrderedScalar, Seq } from "./model.js";
import { and, equals, or, term, type Query, type RangeBound } from "./query.js";
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
  /** What every document's values must satisfy; see `CheckConstraint`. */
  readonly checks?: ReadonlyArray<CheckConstraint>;
  /** Fields naming documents of other collections; see `ReferenceConstraint`. */
  readonly references?: ReadonlyArray<Required<ReferenceConstraint>>;
  /** How text becomes searchable terms; see `Analyzer`. */
  readonly analyzer?: Analyzer;
  /** How geometry becomes searchable cells; see `SpatialIndex`. */
  readonly spatial?: SpatialIndex;
  /** The references other collections — or this one — make to this collection's documents. */
  readonly referencedBy?: ReadonlyArray<{ readonly collection: string; readonly reference: string }>;
}

/**
 * How a collection's geometry becomes cells, as data rather than as code.
 *
 * A cell narrows a query to candidates; the exact check decides. So the
 * resolution is a cost, not a correctness knob: coarser cells mean fewer
 * postings per document and more candidates to check, finer ones the reverse.
 * The version travels with the cells, because changing the resolution changes
 * what was written, and `locate` rewrites the documents when it moves.
 */
export interface SpatialIndex {
  /** The fields holding GeoJSON geometry, by dotted path. */
  readonly fields: ReadonlyArray<string>;
  /** H3 resolution, 0 (coarsest) to 15. Nine is roughly a city block. */
  readonly resolution: number;
  /** Raised by the caller when any of this changes. */
  readonly version: number;
}

/**
 * How a collection's text becomes terms, as data rather than as code.
 *
 * Every step is recorded, because the terms already written are the ones a
 * search reads: changing any of this changes what matches, so the version
 * comes with it and documents are rewritten when it moves. A search analyzes
 * its own text the same way, or a query would ask for terms the writer never
 * produced.
 */
export interface Analyzer {
  /** The fields analyzed, by dotted path. Nothing is analyzed unless named. */
  readonly fields: ReadonlyArray<string>;
  /**
   * Bumped by the caller when any of this changes. A write records it, and
   * `reanalyze` rewrites the documents that still carry an older one.
   */
  readonly version: number;
  /** Lowercase before indexing. Unicode case folding, not a locale's. */
  readonly fold?: boolean;
  /** Words dropped from both the text and the query. Folded like any other term. */
  readonly stopWords?: ReadonlyArray<string>;
  /** Shortest term kept, in code points. Two by default. */
  readonly minLength?: number;
  /**
   * The language this text is in, recorded rather than acted on.
   *
   * Nothing here stems or expands synonyms yet, and pretending otherwise
   * would be worse than saying so: this travels with the terms so a later
   * stemmer knows what it is reading, and so a change of language is a
   * version change like any other.
   */
  readonly language?: string;
}

/**
 * A field whose value is the id of a document in another collection of the
 * same tenant — or of this one.
 *
 * Tenant-local by construction: the id is looked up in the writing tenant's own
 * collection, so no reference can reach another tenant's documents. A document
 * with no value in the field names nothing and is not held to it; one naming a
 * document that does not exist is refused, checked in the transaction that
 * writes it. An id never changes, so there is nothing for an update of the
 * named document to carry along: what a reference decides is what deleting it
 * does, in the same transaction as the delete.
 */
export interface ReferenceConstraint {
  /** Letters, numbers, underscores and hyphens, like a collection name. */
  readonly name: string;
  /** The field holding the id. */
  readonly path: string;
  /** The collection the id names a document of. */
  readonly collection: string;
  /**
   * Deleting a document others name: refused while they do (`"restrict"`, the
   * default), deleting them too (`"cascade"`, and so on down), or clearing the
   * field (`"set-null"`) — which leaves those documents to satisfy their own
   * schema and checks with it null.
   */
  readonly onDelete?: "restrict" | "cascade" | "set-null";
}

/**
 * A rule every document of a collection must satisfy, as data: filters, the
 * same ones `findMany` takes, so a check can be stored, listed, sent and
 * compared rather than being a function nobody can inspect.
 *
 * A filter on a field with no value — null or absent — holds, as a NULL passes
 * a SQL CHECK: whether a field must be there is the schema's to say, and a
 * check says what its value may be when it is.
 */
export interface CheckConstraint {
  /** Letters, numbers, underscores and hyphens, like a collection name. */
  readonly name: string;
  /** Every one must hold. */
  readonly where: ReadonlyArray<DocumentFilter>;
}

export interface Document<TData extends JsonObject = JsonObject> {
  readonly id: string;
  readonly collection: string;
  readonly data: TData;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export type FilterOperator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "geometry";

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
  /**
   * Refuse a second document with the same values in every field, checked in
   * the transaction that writes it. A document with no value at one of the
   * fields is not held to it, as SQL treats NULL: two missing emails are not
   * the same email.
   */
  readonly unique?: boolean;
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
  readonly unique: boolean;
  /** Only a ready index answers reads; a building one is still adding the documents written before it. */
  readonly state: "building" | "ready";
}

export interface FindDocumentsInput {
  readonly collection: string;
  readonly where?: ReadonlyArray<DocumentFilter>;
  /** Also: whose references name documents matching these; see `RelatedFilter`. */
  readonly related?: ReadonlyArray<RelatedFilter>;
  /** Also: whose analyzed text carries these words; see `Analyzer`. */
  readonly search?: string;
  /** Also: whose geometry meets this; see `SpatialFilter`. */
  readonly geometry?: SpatialFilter;
  readonly orderBy?: ReadonlyArray<DocumentSort>;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Documents whose geometry is near a point, in a box, or meeting a shape.
 *
 * Cells narrow the candidates and the exact check decides, so what comes back
 * is what the geometry says: a document sharing a cell with the centre but
 * lying outside the radius does not appear. The field must be one the
 * collection's `SpatialIndex` names, or there are no cells to read.
 */
export type SpatialFilter =
  | {
    readonly field: string;
    /** Within this many metres of the centre, great-circle. */
    readonly near: GeoPosition;
    readonly radius: number;
  }
  | { readonly field: string; readonly within: BoundingBox }
  | { readonly field: string; readonly intersects: Geometry };

/**
 * Documents whose reference names a document matching something else: a join
 * through the identifiers the two collections already share.
 *
 * The named collection answers its own query first, and the ids it returns
 * become an equality union over the referencing field's postings — the same
 * postings an `eq` on that field reads. So a join is a set operation over one
 * dense identifier space rather than a scan of either side, and it costs the
 * target's query plus one posting list per document that query matched. It
 * stays inside one tenant, because a reference does.
 *
 * With neither `where` nor `id`, it asks for documents naming any document of
 * the target collection, which costs reading that collection's ids.
 */
export interface RelatedFilter {
  /** The reference's name on the collection being read. */
  readonly reference: string;
  /** Filters the named document must match. */
  readonly where?: ReadonlyArray<DocumentFilter>;
  /** One named document, by id; with `where`, it must match that too. */
  readonly id?: string;
}

/** One change in a batch; see `DocumentsApi.write`. */
export type DocumentWrite =
  | {
    readonly _tag: "Insert";
    readonly collection: string;
    readonly id?: string;
    readonly data: JsonObject;
  }
  | {
    readonly _tag: "Update";
    readonly collection: string;
    readonly id: string;
    readonly data: JsonObject;
    readonly mode?: "merge" | "replace";
    readonly expectedVersion?: number;
    readonly precondition?: ReadonlyArray<DocumentFilter>;
  }
  | {
    readonly _tag: "Delete";
    readonly collection: string;
    readonly id: string;
    readonly expectedVersion?: number;
    readonly precondition?: ReadonlyArray<DocumentFilter>;
  };

/** What one change in a batch did, in the order the batch asked. */
export type DocumentWritten =
  | { readonly _tag: "Inserted"; readonly document: Document }
  | { readonly _tag: "Updated"; readonly document: Document }
  | {
    readonly _tag: "Deleted";
    readonly collection: string;
    readonly id: string;
    /** False when there was nothing there to delete. */
    readonly deleted: boolean;
  };

/** A document and what its references name. */
export interface RelatedDocuments {
  readonly document: Document;
  /**
   * The document each reference names, by reference name. Undefined where the
   * field names nothing, or names a document that no longer exists.
   */
  readonly related: Readonly<Record<string, Document | undefined>>;
}

declare const DocumentCursorBrand: unique symbol;

/** Where a page of documents stopped. Opaque, and bound to its tenant, collection and order. */
export type DocumentCursor = string & { readonly [DocumentCursorBrand]: true };

export interface FindPageInput {
  readonly collection: string;
  readonly where?: ReadonlyArray<DocumentFilter>;
  /** Also: whose references name documents matching these; see `RelatedFilter`. */
  readonly related?: ReadonlyArray<RelatedFilter>;
  /** Also: whose analyzed text carries these words; see `Analyzer`. */
  readonly search?: string;
  /** Also: whose geometry meets this; see `SpatialFilter`. */
  readonly geometry?: SpatialFilter;
  /** One field, or several that a composite index serves: see `CollectionIndex`. */
  readonly orderBy?: ReadonlyArray<DocumentSort>;
  /** Documents per page: 50 unless given, and at most 1000. */
  readonly limit?: number;
  readonly after?: DocumentCursor;
  /**
   * Also hand back the cursor after each document, not only after the last,
   * so a reader that stops partway through a page resumes exactly there.
   */
  readonly cursors?: boolean;
}

export interface DocumentPage {
  readonly documents: ReadonlyArray<Document>;
  /** Present only when another matching document follows. */
  readonly next?: DocumentCursor;
  /** With `cursors`, the cursor after each document, in order. */
  readonly cursors?: ReadonlyArray<DocumentCursor>;
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
  unique: index.unique === true,
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

/**
 * Document order exactly as `findMany` and `findPage` give it: by each sort
 * field in turn, in the ordered lens's order, with its direction and null
 * placement. Documents equal on every field compare equal, and which comes
 * first is then the caller's to say — anything merging several ordered reads
 * compares with this, so the merge never disagrees with a read it merges.
 */
export const compareDocuments = (
  orderBy: ReadonlyArray<DocumentSort>,
): ((a: Document, b: Document) => number) => {
  const sorts = normalizeSorts(orderBy);
  return (a, b) => {
    for (const sort of sorts) {
      const order = compareAt(readPath(a.data, sort.path), readPath(b.data, sort.path), sort.direction, sort.nulls);
      if (order !== 0) return order;
    }
    return 0;
  };
};

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
): Effect.Effect<
  { readonly name: string; readonly fields: Array<Required<IndexField>>; readonly unique: boolean },
  InvalidIndex
> => {
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
  if (definition.unique !== undefined && typeof definition.unique !== "boolean") {
    return invalid("unique must be true or false");
  }
  return Effect.succeed({ name: definition.name, fields, unique: definition.unique === true });
};

/**
 * The terms a piece of text yields, in order, before stop words are removed.
 *
 * Split on anything that is not a letter, a number or a mark, which keeps
 * words together across scripts without a per-language rule. Normalized to NFC
 * first, so text that differs only in how an accent is encoded gives one term.
 */
const tokenize = (text: string, analyzer: Analyzer): Array<string> => {
  const normalized = text.normalize("NFC");
  const folded = analyzer.fold === false ? normalized : normalized.toLowerCase();
  const minLength = analyzer.minLength ?? 2;
  const stop = new Set((analyzer.stopWords ?? []).map((word) =>
    analyzer.fold === false ? word.normalize("NFC") : word.normalize("NFC").toLowerCase()));
  return folded
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((token) => token.length >= minLength && !stop.has(token));
};

/** Every analyzed field's terms, deduplicated: a posting says the term is there, not how often. */
const termsFor = (analyzer: Analyzer | undefined, data: JsonObject): Array<readonly [string, string]> => {
  if (analyzer === undefined) return [];
  const out = new Map<string, readonly [string, string]>();
  for (const path of analyzer.fields) {
    const value = readPath(data, path);
    if (typeof value !== "string") continue;
    for (const token of tokenize(value, analyzer)) out.set(`${path}\u0000${token}`, [path, token]);
  }
  return [...out.values()];
};

/** Marks a document whose geometry was too large to cover at the declared resolution. */
const COARSE_SENTINEL = "*coarse";

/** The geometry at a path, if it is one this understands. */
const geometryAt = (data: JsonObject, path: string): Geometry | undefined => {
  const value = readPath(data, path);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const shape = value as { type?: unknown; coordinates?: unknown };
  if (typeof shape.type !== "string" || !Array.isArray(shape.coordinates)) return undefined;
  return shape.type === "Point" || shape.type === "Polygon" || shape.type === "MultiPolygon"
    ? (value as unknown as Geometry)
    : undefined;
};

/**
 * The cell postings a document contributes: one per covering cell and its
 * ancestors, per spatial field.
 *
 * They ride on the term lens, which is already sealable and already intersects
 * with every other lens — a cell is a term whose field is a path and whose
 * value is a cell id.
 */
const cellTermsFor = (
  spatial: SpatialIndex | undefined,
  h3: Parameters<typeof cellsFor>[0] | undefined,
  data: JsonObject,
): Array<readonly [string, string]> => {
  if (spatial === undefined || h3 === undefined) return [];
  const out: Array<readonly [string, string]> = [];
  for (const path of spatial.fields) {
    const geometry = geometryAt(data, path);
    if (geometry === undefined) continue;
    const covering = coveringFor(h3, geometry, spatial.resolution);
    const cells = new Set<string>(covering.cells);
    for (const cell of covering.cells) {
      for (let level = covering.resolution - 1; level >= COARSEST_RESOLUTION; level--) {
        cells.add(h3.cellToParent(cell, level));
      }
    }
    for (const cell of cells) out.push([`${path}@cell`, cell]);
    // A shape too large to cover at the declared resolution is indexed coarsely,
    // which a finer query would never meet. The sentinel keeps it a candidate:
    // there are few such documents, and the exact check still decides.
    if (covering.resolution < spatial.resolution) out.push([`${path}@cell`, COARSE_SENTINEL]);
  }
  return out;
};

/** Whether a document's geometry really meets a filter, on its own coordinates. */
const matchesGeometry = (filter: SpatialFilter, data: JsonObject): boolean => {
  const geometry = geometryAt(data, filter.field);
  if (geometry === undefined) return false;
  if ("near" in filter) {
    return positionsOf(geometry).some((position) =>
      distanceBetween(position, filter.near) <= filter.radius);
  }
  if ("within" in filter) {
    return positionsOf(geometry).some((position) => inBox(filter.within, position));
  }
  // Either shape holding a point of the other: enough for points and for
  // overlapping areas, and honest about the case it misses — two shapes
  // crossing edge to edge with no vertex inside either.
  return positionsOf(filter.intersects).some((position) => contains(geometry, position)) ||
    positionsOf(geometry).some((position) => contains(filter.intersects, position));
};

/** A value a field has, as opposed to null, absent, or an object or array. */
const hasValue = (value: Json | undefined): boolean => {
  const scalar = orderable(value);
  return scalar !== undefined && scalar !== null;
};

const describeFilter = (filter: DocumentFilter): string =>
  `${filter.path} ${filter.op ?? "eq"} ${JSON.stringify(filter.value)}`;

/** Whether one filter of a check holds: a field with no value always does. */
const satisfiesCheck = (data: JsonObject, filter: DocumentFilter): boolean => {
  const actual = readPath(data, filter.path);
  return actual === undefined || actual === null || matches(data, filter);
};

const FILTER_OPERATORS: ReadonlySet<string> = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "in"]);

/** A check definition in the shape it is stored, or why it cannot be enforced. */
const normalizeCheck = (
  collection: string,
  check: CheckConstraint,
): Effect.Effect<CheckConstraint, InvalidConstraint> => {
  const invalid = (reason: string) =>
    Effect.fail(new InvalidConstraint({ collection, name: String(check.name), reason }));
  if (typeof check.name !== "string" || !COLLECTION_NAME_PATTERN.test(check.name)) {
    return invalid(
      "a check name must start with a letter or underscore and contain only letters, numbers, underscores, or hyphens",
    );
  }
  if (!Array.isArray(check.where) || check.where.length === 0) return invalid("a check needs at least one filter");
  const where: Array<DocumentFilter> = [];
  for (const filter of check.where) {
    const path: unknown = filter?.path;
    if (typeof path !== "string" || path === "" || path.split(".").some((segment) => segment === "")) {
      return invalid(`${JSON.stringify(path) ?? "undefined"} is not a field path`);
    }
    const op = filter.op ?? "eq";
    if (!FILTER_OPERATORS.has(op)) return invalid(`"${String(op)}" is not a filter operator`);
    if (filter.value === undefined) return invalid(`the filter on "${path}" has no value`);
    if (op === "in" && !Array.isArray(filter.value)) return invalid(`"in" on "${path}" takes a list of values`);
    where.push({ path, op, value: filter.value });
  }
  return Effect.succeed({ name: check.name, where });
};

/** An analyzer in the shape it is stored, or why it cannot be used. */
const normalizeAnalyzer = (
  collection: string,
  analyzer: Analyzer,
): Effect.Effect<Analyzer, InvalidConstraint> => {
  const invalid = (reason: string) =>
    Effect.fail(new InvalidConstraint({ collection, name: "analyzer", reason }));
  if (!Array.isArray(analyzer.fields) || analyzer.fields.length === 0) {
    return invalid("an analyzer needs at least one field to analyze");
  }
  for (const path of analyzer.fields) {
    if (typeof path !== "string" || path === "" || path.split(".").some((segment) => segment === "")) {
      return invalid(`${JSON.stringify(path) ?? "undefined"} is not a field path`);
    }
  }
  if (!Number.isInteger(analyzer.version) || analyzer.version < 1) {
    return invalid("an analyzer's version is a whole number from one, raised when its rules change");
  }
  if (analyzer.minLength !== undefined && (!Number.isInteger(analyzer.minLength) || analyzer.minLength < 1)) {
    return invalid("minLength is a whole number of code points, from one");
  }
  if (analyzer.stopWords !== undefined &&
    (!Array.isArray(analyzer.stopWords) || analyzer.stopWords.some((word) => typeof word !== "string"))) {
    return invalid("stopWords is a list of words");
  }
  return Effect.succeed({
    fields: [...analyzer.fields],
    version: analyzer.version,
    ...(analyzer.fold === undefined ? {} : { fold: analyzer.fold }),
    ...(analyzer.stopWords === undefined ? {} : { stopWords: [...analyzer.stopWords] }),
    ...(analyzer.minLength === undefined ? {} : { minLength: analyzer.minLength }),
    ...(analyzer.language === undefined ? {} : { language: analyzer.language }),
  });
};

/** A spatial index in the shape it is stored, or why it cannot be used. */
const normalizeSpatial = (
  collection: string,
  spatial: SpatialIndex,
): Effect.Effect<SpatialIndex, InvalidConstraint> => {
  const invalid = (reason: string) =>
    Effect.fail(new InvalidConstraint({ collection, name: "spatial", reason }));
  if (!Array.isArray(spatial.fields) || spatial.fields.length === 0) {
    return invalid("a spatial index needs at least one field to index");
  }
  for (const path of spatial.fields) {
    if (typeof path !== "string" || path === "" || path.split(".").some((segment) => segment === "")) {
      return invalid(`${JSON.stringify(path) ?? "undefined"} is not a field path`);
    }
  }
  if (!Number.isInteger(spatial.resolution) || spatial.resolution < 0 || spatial.resolution > 15) {
    return invalid("resolution is a whole number from 0 to 15");
  }
  if (!Number.isInteger(spatial.version) || spatial.version < 1) {
    return invalid("a spatial index's version is a whole number from one, raised when its rules change");
  }
  return Effect.succeed({
    fields: [...spatial.fields],
    resolution: spatial.resolution,
    version: spatial.version,
  });
};

const ON_DELETE: ReadonlySet<string> = new Set(["restrict", "cascade", "set-null"]);

/** A reference definition with its default filled in, or why it cannot be enforced. */
const normalizeReference = (
  collection: string,
  reference: ReferenceConstraint,
): Effect.Effect<Required<ReferenceConstraint>, InvalidConstraint> => {
  const invalid = (reason: string) =>
    Effect.fail(new InvalidConstraint({ collection, name: String(reference.name), reason }));
  if (typeof reference.name !== "string" || !COLLECTION_NAME_PATTERN.test(reference.name)) {
    return invalid(
      "a reference name must start with a letter or underscore and contain only letters, numbers, underscores, or hyphens",
    );
  }
  const path: unknown = reference.path;
  if (typeof path !== "string" || path === "" || path.split(".").some((segment) => segment === "")) {
    return invalid(`${JSON.stringify(path) ?? "undefined"} is not a field path`);
  }
  if (typeof reference.collection !== "string" || !COLLECTION_NAME_PATTERN.test(reference.collection)) {
    return invalid(`${JSON.stringify(reference.collection) ?? "undefined"} is not a collection name`);
  }
  const onDelete = reference.onDelete ?? "restrict";
  if (!ON_DELETE.has(onDelete)) return invalid(`onDelete must be "restrict", "cascade" or "set-null"`);
  return Effect.succeed({ name: reference.name, path, collection: reference.collection, onDelete });
};

/** The data with one dotted path set, copying only what lies along it. */
const setPath = (data: JsonObject, path: string, value: Json): JsonObject => {
  const [head, ...rest] = path.split(".");
  if (rest.length === 0) return { ...data, [head!]: value };
  const inner = data[head!];
  const next = inner !== null && typeof inner === "object" && !Array.isArray(inner) ? inner : {};
  return { ...data, [head!]: setPath(next, rest.join("."), value) };
};

/**
 * What a transaction has written so far.
 *
 * A read inside a transaction sees what is committed, not what the transaction
 * itself has written, so anything that writes more than once — a cascade, a
 * batch — carries this and consults it first. Without it, a second write built
 * on a second read would undo the first, and two writes in one transaction
 * could each pass a check the other had already answered.
 */
interface Pending {
  /** By identifier: the document as this transaction leaves it, or null once retracted. */
  readonly bySeq: Map<number, Document | null>;
  /** By `collection/id`, for the checks that address a document by name. */
  readonly byName: Map<string, { readonly seq: Seq; readonly document: Document | null }>;
  /** Unique values this transaction has taken, by column and tuple, to the document holding them. */
  readonly claimed: Map<string, string>;
}

const nothingPending = (): Pending => ({ bySeq: new Map(), byName: new Map(), claimed: new Map() });

const nameOf = (collection: string, id: string) => `${collection}/${id}`;

const claimOf = (column: string, tuple: string) => `${column}\u0000${tuple}`;

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
  // A spatial filter carries its own shape, and decides on the coordinates.
  if (op === "geometry") return matchesGeometry(filter.value as unknown as SpatialFilter, data);
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

/**
 * A plan narrowed by a search.
 *
 * The words go in beside the field clauses rather than replacing them: a
 * search is one more set to intersect, so filters still narrow it and it still
 * narrows them. Without field clauses the words carry the collection on their
 * own, because a term column is per collection already.
 */
const withSearch = (plan: Plan, words: Query | undefined): Plan =>
  words === undefined ? plan : {
    query: plan.fields === undefined ? words : and(plan.query, words),
    fields: plan.fields === undefined ? words : and(plan.fields, words),
    residual: plan.residual,
  };

/**
 * A plan narrowed by the cells a spatial filter names.
 *
 * The cells go in as ordinary term clauses — united, because a document in any
 * of them is a candidate — and the exact check rides in the residual, so what
 * comes back is what the geometry admits rather than what the covering
 * approximated.
 */
const withCells = (
  plan: Plan,
  field: string,
  cells: ReadonlyArray<string>,
  exact: DocumentFilter,
): Plan => {
  if (cells.length === 0) return { ...plan, residual: [...plan.residual, exact] };
  const clauses = cells.map((cell) => term(`${field}@cell`, cell));
  const covering = clauses.length === 1 ? clauses[0]! : or(...clauses);
  return {
    query: plan.fields === undefined ? covering : and(plan.query, covering),
    fields: plan.fields === undefined ? covering : and(plan.fields, covering),
    residual: [...plan.residual, exact],
  };
};

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
    readonly checks?: ReadonlyArray<CheckConstraint>;
    /** References to collections that already exist, or to this one. */
    readonly references?: ReadonlyArray<ReferenceConstraint>;
    /** How this collection's text becomes searchable terms; see `Analyzer`. */
    readonly analyzer?: Analyzer;
    /** How this collection's geometry becomes searchable cells; see `SpatialIndex`. */
    readonly spatial?: SpatialIndex;
  }) => Effect.Effect<
    Collection,
    InvalidCollectionName | CollectionExists | InvalidIndex | InvalidConstraint | TenantMoving
  >;
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
    | CollectionNotFound | DocumentConflict | SchemaViolation | TenantMoving | IdempotencyKeyReused
    | CheckViolation | UniqueViolation | ReferenceViolation
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
  readonly findMany: (
    input: FindDocumentsInput,
  ) => Effect.Effect<
    ReadonlyArray<Document>,
    UnknownReference | UnanalyzedCollection | UnindexedGeometry
  >;
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
  ) => Effect.Effect<
    DocumentPage,
    | CursorMismatch | UnsupportedOrdering | UnknownReference | UnanalyzedCollection
    | UnindexedGeometry
  >;

  /**
   * The documents these documents' references name, resolved in one pass.
   *
   * Each named document is read once however many documents name it, so
   * resolving a page costs the documents it actually points at. Takes
   * documents rather than a query so that it composes with `findMany`,
   * `findPage` and a scatter alike.
   */
  readonly withRelated: (input: {
    readonly collection: string;
    readonly documents: ReadonlyArray<Document>;
    /** Which references to resolve; every one the collection declares when omitted. */
    readonly references?: ReadonlyArray<string>;
  }) => Effect.Effect<ReadonlyArray<RelatedDocuments>, UnknownReference>;
  readonly update: (input: {
    readonly collection: string;
    /** Do this at most once; see `insert`. */
    readonly idempotencyKey?: string;
    readonly id: string;
    readonly data: JsonObject;
    readonly mode?: "merge" | "replace";
    readonly expectedVersion?: number;
    /** Filters the document as it stands must match, or the update is a conflict: a compare-and-set. */
    readonly precondition?: ReadonlyArray<DocumentFilter>;
  }) => Effect.Effect<
    Document,
    | DocumentNotFound | DocumentConflict | SchemaViolation | TenantMoving | IdempotencyKeyReused
    | CheckViolation | UniqueViolation | ReferenceViolation
  >;
  readonly delete: (input: {
    readonly collection: string;
    /** Do this at most once; see `insert`. */
    readonly idempotencyKey?: string;
    readonly id: string;
    readonly expectedVersion?: number;
    /** Filters the document as it stands must match, or the delete is a conflict. */
    readonly precondition?: ReadonlyArray<DocumentFilter>;
  }) => Effect.Effect<
    boolean,
    | DocumentConflict | TenantMoving | IdempotencyKeyReused
    // What the references to it decide: a restrict refuses the delete, and a
    // set-null rewrites documents that must still satisfy their constraints.
    | ReferenceViolation | SchemaViolation | CheckViolation | UniqueViolation
  >;

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
  ) => Effect.Effect<
    CollectionIndex,
    CollectionNotFound | IndexExists | InvalidIndex | UniqueViolation | TenantMoving
  >;

  /**
   * Remove an index and clear its postings, which costs a write per document
   * as building it did. False when the collection has no index by that name.
   */
  readonly dropIndex: (input: {
    readonly collection: string;
    readonly name: string;
  }) => Effect.Effect<boolean, CollectionNotFound | TenantMoving>;

  /**
   * Add a check to a collection, and return it once every document satisfies it.
   *
   * It holds for writes from the moment it is recorded, and the documents
   * already there are then read against it. One that fails it takes the check
   * away again, and is named in the error.
   */
  readonly addCheck: (
    input: CheckConstraint & { readonly collection: string },
  ) => Effect.Effect<
    CheckConstraint,
    CollectionNotFound | ConstraintExists | InvalidConstraint | CheckViolation | TenantMoving
  >;

  /**
   * Declare how a collection's text becomes terms, and rewrite its documents
   * under it.
   *
   * The terms already written are what a search reads, so changing an analyzer
   * changes what matches: every document is written back under the new one
   * before it is in force, which costs a write and a log entry each. Passing
   * the analyzer a collection already has is not a mistake — it rewrites, which
   * is what re-running an interrupted one does.
   */
  readonly analyze: (input: {
    readonly collection: string;
    readonly analyzer: Analyzer;
  }) => Effect.Effect<
    { readonly analyzer: Analyzer; readonly documents: number },
    CollectionNotFound | InvalidConstraint | TenantMoving
  >;

  /**
   * Declare how a collection's geometry becomes cells, and rewrite its
   * documents under it.
   *
   * The cells already written are what narrows a query, so a change of
   * resolution changes what a read considers: every document is written back
   * before the new index is in force, at a write and a log entry each.
   */
  readonly locate: (input: {
    readonly collection: string;
    readonly spatial: SpatialIndex;
  }) => Effect.Effect<
    { readonly spatial: SpatialIndex; readonly documents: number },
    CollectionNotFound | InvalidConstraint | TenantMoving
  >;

  /**
   * Add a reference to a collection, and return it once every document's
   * value names a document that exists. Recorded first and then checked
   * against the documents already there, as a check is.
   */
  readonly addReference: (
    input: ReferenceConstraint & { readonly from: string },
  ) => Effect.Effect<
    Required<ReferenceConstraint>,
    CollectionNotFound | ConstraintExists | InvalidConstraint | ReferenceViolation | TenantMoving
  >;

  /** Remove a reference. False when the collection has none by that name. */
  readonly dropReference: (input: {
    readonly collection: string;
    readonly name: string;
  }) => Effect.Effect<boolean, CollectionNotFound | TenantMoving>;

  /** Remove a check. False when the collection has none by that name. */
  readonly dropCheck: (input: {
    readonly collection: string;
    readonly name: string;
  }) => Effect.Effect<boolean, CollectionNotFound | TenantMoving>;

  /**
   * Apply several changes as one: all of them land, or none does.
   *
   * One transaction, so every check each change makes — an id, a version, a
   * precondition, a unique value, a check, a reference — is made against what
   * the batch has written so far as well as what was committed. A post may
   * name an author the same batch inserts; two changes may not take one unique
   * value; a document deleted here is gone for the changes after it. Any
   * violation refuses the whole batch, leaving nothing behind.
   *
   * The scope is one tenant, and a tenant lives on one shard, so this is as far
   * as atomicity goes: there is no write that spans shards, and `db.scatter`
   * reads rather than writes. A change set spanning tenants is several batches,
   * each atomic on its own, and the caller decides what a partial outcome means.
   */
  readonly write: (input: {
    readonly operations: ReadonlyArray<DocumentWrite>;
    /** Do this at most once; see `insert`. */
    readonly idempotencyKey?: string;
  }) => Effect.Effect<
    ReadonlyArray<DocumentWritten>,
    | CollectionNotFound | DocumentConflict | DocumentNotFound | SchemaViolation | TenantMoving
    | IdempotencyKeyReused | CheckViolation | UniqueViolation | ReferenceViolation
  >;

  /**
   * Write every document back as it stands, so its postings are the ones the
   * lenses derive today.
   *
   * What repairs documents written before a change in how values are indexed:
   * before the typed scalar lens, a number or a boolean was indexed as text,
   * so a typed equality, a range or an order misses or misplaces them. A
   * reindex cannot fix that — it re-derives the postings from the stored
   * manifests, and the manifests are what is wrong. Each document costs a
   * write and a log entry.
   */
  readonly rewrite: (input?: {
    /** One collection; every one of the tenant's when omitted. */
    readonly collection?: string;
  }) => Effect.Effect<
    { readonly collections: number; readonly documents: number },
    CollectionNotFound | TenantMoving
  >;

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

  /** The store's own failures: a caller cannot act on them, so they become defects. */
  const STORE_FAILURES: ReadonlySet<string> = new Set([
    "StoreError", "WriterFenced", "ForeignCursor", "CursorCompacted", "LogCompacted", "PartitionUnavailable",
  ]);

  /**
   * Run a change in one transaction, keeping the failures a caller can act on.
   *
   * A transaction holds the store's one writer, so what the change reads —
   * whether an id is taken, which version is current, whether a value is held
   * — stays true until its writes land, and a failure discards all of them.
   * Only the store's own failures become defects; a conflict or a violation
   * reaches the caller as itself.
   */
  const transactChecked = <A, E>(
    change: (txn: Txn) => Effect.Effect<A, E | DbError>,
  ): Effect.Effect<A, Exclude<E, DbError>> =>
    store.transact(change).pipe(
      Effect.catch((error) =>
        STORE_FAILURES.has((error as { readonly _tag: string })._tag)
          ? Effect.die(error)
          : Effect.fail(error as Exclude<E, DbError>)),
    );

  /**
   * Check and apply a change and, if the caller gave a key, record what it did
   * — in one transaction.
   *
   * Recording the receipt afterwards would leave a window in which the write
   * had happened and the key had not been noted, which is exactly the window a
   * retry falls into. The receipt is looked for before anything is allocated,
   * so a replay costs a lookup, and again inside the transaction, where a first
   * attempt running alongside cannot slip past it. A result `remember` declines
   * is not recorded: nothing happened worth replaying.
   */
  const commitOnce = <A, E>(
    key: string | undefined,
    fingerprint: string,
    request: string,
    change: (txn: Txn) => Effect.Effect<A, E | DbError>,
    remember: (result: A) => boolean = () => true,
  ): Effect.Effect<A, Exclude<E, DbError> | IdempotencyKeyReused> =>
    Effect.gen(function* () {
      if (key === undefined) return yield* transactChecked(change);
      const seen = yield* receiptFor(key, fingerprint, request);
      if (seen !== undefined) return seen.result as A;
      const receiptSeq = yield* nextSeq;
      return yield* transactChecked<A, E | IdempotencyKeyReused>((txn) =>
        Effect.gen(function* () {
          const raced = yield* receiptFor(key, fingerprint, request);
          if (raced !== undefined) return raced.result as A;
          const result = yield* change(txn);
          if (remember(result)) {
            yield* rememberKey(txn, {
              key, fingerprint, request, result, at: new Date().toISOString(),
            }, receiptSeq);
          }
          return result;
        }));
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

  /**
   * H3, loaded once and kept.
   *
   * Resolved before a transaction rather than inside one: the manifest is built
   * under the store's writer, and taking an import there would put async work
   * in the one place that must stay short. A collection with no spatial fields
   * never loads it at all.
   */
  let h3: Parameters<typeof cellsFor>[0] | undefined;
  const spatialHandle = (spatial: SpatialIndex | undefined) =>
    Effect.gen(function* () {
      if (spatial === undefined) return undefined;
      if (h3 === undefined) h3 = yield* Effect.orDie(loadH3);
      return h3;
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

  /**
   * Record on each target collection the references naming it, in the caller's
   * transaction. A target that does not exist cannot be named.
   *
   * One write per target, with all of its references at once: a read inside a
   * transaction sees what is committed, so a second write built on a second
   * read would drop what the first one added.
   */
  const linkTargets = (txn: Txn, from: string, references: ReadonlyArray<Required<ReferenceConstraint>>) =>
    Effect.gen(function* () {
      for (const name of new Set(references.map((reference) => reference.collection))) {
        const naming = references.filter((reference) => reference.collection === name);
        const targetSeq = yield* lookup(collectionNs(tenant), name);
        const target = targetSeq === undefined ? undefined : yield* loadCollection(name);
        if (targetSeq === undefined || target === undefined) {
          return yield* new InvalidConstraint({
            collection: from, name: naming[0]!.name, reason: `there is no collection "${name}" to reference`,
          });
        }
        yield* collectionPut(txn, targetSeq, {
          ...target,
          referencedBy: [
            ...(target.referencedBy ?? []),
            ...naming.map((reference) => ({ collection: from, reference: reference.name })),
          ],
        });
      }
    });

  /** Remove a reference and its back-reference together, in the caller's transaction. */
  const unlinkReference = (txn: Txn, from: string, name: string) =>
    Effect.gen(function* () {
      const fromSeq = yield* lookup(collectionNs(tenant), from);
      const source = fromSeq === undefined ? undefined : yield* loadCollection(from);
      const reference = source?.references?.find((candidate) => candidate.name === name);
      if (fromSeq === undefined || source === undefined || reference === undefined) return false;
      const unlinked = (record: StoredCollection): StoredCollection => ({
        ...record,
        referencedBy: (record.referencedBy ?? []).filter((back) => !(back.collection === from && back.reference === name)),
      });
      const remaining = { ...source, references: (source.references ?? []).filter((candidate) => candidate.name !== name) };
      if (reference.collection === from) {
        yield* collectionPut(txn, fromSeq, unlinked(remaining));
        return true;
      }
      yield* collectionPut(txn, fromSeq, remaining);
      const targetSeq = yield* lookup(collectionNs(tenant), reference.collection);
      const target = targetSeq === undefined ? undefined : yield* loadCollection(reference.collection);
      if (targetSeq !== undefined && target !== undefined) yield* collectionPut(txn, targetSeq, unlinked(target));
      return true;
    });

  /** Every posting a document contributes: a column per scalar, and a tuple per index. */
  const manifestFor = (
    doc: Document,
    indexes: ReadonlyArray<StoredIndex>,
    analyzer?: Analyzer,
    spatial?: SpatialIndex,
    h3?: Parameters<typeof cellsFor>[0],
  ): IndexManifest => ({
    terms: [...termsFor(analyzer, doc.data), ...cellTermsFor(spatial, h3, doc.data)],
    columns: [
      ...columnsFor(tenant, doc.collection, doc.data),
      ...indexes.map((index) => [index.column, indexTuple(index, doc.data)] as const),
    ],
    measures: [],
    edges: [],
  });

  /** The document at an identifier, as this transaction leaves it. */
  const currentAt = (pending: Pending, seq: Seq): Effect.Effect<Document | undefined, DbError> =>
    pending.bySeq.has(Number(seq))
      ? Effect.succeed(pending.bySeq.get(Number(seq)) ?? undefined)
      : readDocument(seq);

  /** What a name addresses, as this transaction leaves it. */
  const currentNamed = (
    pending: Pending,
    collection: string,
    id: string,
  ): Effect.Effect<{ readonly seq: Seq; readonly document: Document | null } | undefined, DbError> =>
    Effect.gen(function* () {
      const written = pending.byName.get(nameOf(collection, id));
      if (written !== undefined) return written;
      const seq = yield* lookup(documentNs(tenant, collection), id);
      if (seq === undefined) return undefined;
      return { seq, document: (yield* readDocument(seq)) ?? null };
    });

  /** Record a document this transaction has written, and the unique values it takes. */
  const remember = (pending: Pending, collection: StoredCollection | undefined, doc: Document, seq: Seq) => {
    pending.bySeq.set(Number(seq), doc);
    pending.byName.set(nameOf(doc.collection, doc.id), { seq, document: doc });
    const held = nameOf(doc.collection, doc.id);
    for (const [key, holder] of pending.claimed) if (holder === held) pending.claimed.delete(key);
    for (const index of collection?.indexes ?? []) {
      if (index.unique !== true) continue;
      if (index.fields.some((field) => !hasValue(readPath(doc.data, field.path)))) continue;
      pending.claimed.set(claimOf(index.column, indexTuple(index, doc.data)), held);
    }
  };

  /** Record a document this transaction has retracted, and release what it held. */
  const forget = (pending: Pending, doc: Document, seq: Seq) => {
    pending.bySeq.set(Number(seq), null);
    pending.byName.set(nameOf(doc.collection, doc.id), { seq, document: null });
    const held = nameOf(doc.collection, doc.id);
    for (const [key, holder] of pending.claimed) if (holder === held) pending.claimed.delete(key);
  };

  /**
   * Refuse a document its collection's constraints do not allow: a check it
   * fails, or values a unique index already has another document holding.
   * Called inside the transaction that writes the document, under the store's
   * one writer, so nothing it compares against can change before the write.
   */
  const enforceConstraints = (
    collection: StoredCollection | undefined,
    doc: Document,
    seq: Seq,
    pending: Pending,
  ) =>
    Effect.gen(function* () {
      for (const check of collection?.checks ?? []) {
        const failed = check.where.find((filter) => !satisfiesCheck(doc.data, filter));
        if (failed !== undefined) {
          return yield* new CheckViolation({
            collection: doc.collection, id: doc.id, check: check.name, reason: `${describeFilter(failed)} does not hold`,
          });
        }
      }
      for (const reference of collection?.references ?? []) {
        const value = readPath(doc.data, reference.path);
        if (value === undefined || value === null) continue;
        const refused = (reason: string) =>
          new ReferenceViolation({ collection: doc.collection, id: doc.id, reference: reference.name, reason });
        if (typeof value !== "string") {
          return yield* refused(`${reference.path} holds ${JSON.stringify(value)}, which is not a document id`);
        }
        // A document may name itself; it does not exist until this write lands.
        if (reference.collection === doc.collection && value === doc.id) continue;
        // Named in this transaction counts: an author and a post naming it can
        // be written together, and one deleted here no longer counts.
        const named = yield* currentNamed(pending, reference.collection, value);
        if (named === undefined || named.document === null) {
          return yield* refused(`there is no document "${value}" in "${reference.collection}"`);
        }
      }
      for (const index of collection?.indexes ?? []) {
        // A building index is checked once, whole, when it becomes ready.
        if (index.unique !== true || index.state !== "ready") continue;
        if (index.fields.some((field) => !hasValue(readPath(doc.data, field.path)))) continue;
        const tuple = indexTuple(index, doc.data);
        // Taken earlier in this transaction, which the postings do not show yet.
        const claimant = pending.claimed.get(claimOf(index.column, tuple));
        if (claimant !== undefined && claimant !== nameOf(doc.collection, doc.id)) {
          return yield* new UniqueViolation({
            collection: doc.collection, index: index.name, id: doc.id,
            holder: claimant.slice(claimant.indexOf("/") + 1),
          });
        }
        const holders = yield* Stream.runCollect(resolveQuery(equals(index.column, tuple)));
        for (const other of holders) {
          if (Number(other) === Number(seq)) continue;
          // A holder this transaction has deleted, or moved off the value, holds it no longer.
          const holder = yield* currentAt(pending, other);
          if (holder === undefined || indexTuple(index, holder.data) !== tuple) continue;
          return yield* new UniqueViolation({
            collection: doc.collection, index: index.name, id: doc.id, holder: holder.id,
          });
        }
      }
    });

  /**
   * Write a document with every posting it contributes, its indexes' included,
   * once its collection's constraints allow it.
   *
   * The collection is read here, inside the transaction, and not by the
   * caller. A transaction holds the store's one writer, so an index or a check
   * added alongside this write was either recorded before it — and applies —
   * or after it, and what adds it reads this document. Read before the
   * transaction, the write could land between the two and escape both.
   *
   * A caller that has already read the record in this transaction passes it
   * rather than paying for it twice.
   */
  const documentPut = (
    txn: Txn,
    doc: Document,
    seq: Seq,
    pending: Pending,
    loaded?: StoredCollection,
  ) =>
    Effect.gen(function* () {
      const collection = loaded ?? (yield* loadCollection(doc.collection));
      yield* enforceConstraints(collection, doc, seq, pending);
      const cells = yield* spatialHandle(collection?.spatial);
      yield* txn.put(seq, encode(doc), manifestFor(
        doc, collection?.indexes ?? [], collection?.analyzer, collection?.spatial, cells,
      ), {
        namespace: documentNs(tenant, doc.collection), key: doc.id,
      });
      remember(pending, collection, doc, seq);
    });

  const documentRetract = (txn: Txn, doc: Document, seq: Seq, pending: Pending) =>
    Effect.gen(function* () {
      yield* txn.retract(seq);
      forget(pending, doc, seq);
    });

  /**
   * What deleting a document does to the documents naming it, each reference
   * deciding for its own: refuse the delete, delete them too, or clear the
   * field. All of it in the delete's own transaction, so either every
   * consequence lands with the delete or none does.
   *
   * Reads inside a transaction see what is committed, not what the
   * transaction has written so far, so the documents this one has already
   * cleared or deleted are carried alongside: a document cleared under two
   * references keeps both, and one reached twice down a cascade — a diamond,
   * or a cycle back to where it began — is deleted once.
   */
  const releaseReferences = (txn: Txn, deleted: Document, deletedSeq: Seq, pending: Pending) =>
    Effect.gen(function* () {
      forget(pending, deleted, deletedSeq);
      const release = (doc: Document): Effect.Effect<
        void,
        ReferenceViolation | SchemaViolation | CheckViolation | UniqueViolation | DbError
      > =>
        Effect.gen(function* () {
          const named = yield* loadCollection(doc.collection);
          // Gathered per document that names this one, rather than per
          // reference: a document naming it through two fields is written once,
          // with both resolved. Written once per field, it would be checked in
          // between with the other field still naming a document this delete
          // has already taken away.
          const holders = new Map<number, {
            readonly seq: Seq;
            readonly holder: Document;
            readonly from: StoredCollection;
            readonly naming: Array<Required<ReferenceConstraint>>;
          }>();
          for (const back of named?.referencedBy ?? []) {
            const from = back.collection === doc.collection ? named : yield* loadCollection(back.collection);
            const reference = from?.references?.find((candidate) => candidate.name === back.reference);
            if (from === undefined || reference === undefined) continue;
            const found = yield* Stream.runCollect(
              resolveQuery(equals(columnFor(tenant, back.collection, reference.path), doc.id)),
            );
            for (const held of found) {
              const holder = yield* currentAt(pending, held);
              // Gone already in this transaction, or no longer naming it.
              if (holder === undefined || readPath(holder.data, reference.path) !== doc.id) continue;
              if (reference.onDelete === "restrict") {
                return yield* new ReferenceViolation({
                  collection: doc.collection, id: doc.id, reference: `${back.collection}.${reference.name}`,
                  reason: `"${holder.id}" in "${back.collection}" names it`,
                });
              }
              const gathered = holders.get(Number(held)) ?? { seq: held, holder, from, naming: [] };
              gathered.naming.push(reference);
              holders.set(Number(held), gathered);
            }
          }
          for (const [at, gathered] of holders) {
            // As it stands now, not as it stood when it was gathered: this
            // pass may have deleted it since — down a cascade from elsewhere —
            // or cleared the very field that named this document.
            const holder = yield* currentAt(pending, gathered.seq);
            if (holder === undefined) continue;
            const naming = gathered.naming.filter(
              (reference) => readPath(holder.data, reference.path) === doc.id);
            if (naming.length === 0) continue;
            // Deleting the document outranks clearing a field of it.
            if (naming.some((reference) => reference.onDelete === "cascade")) {
              forget(pending, holder, gathered.seq);
              yield* release(holder);
              yield* txn.retract(gathered.seq);
              continue;
            }
            let data = holder.data;
            for (const reference of naming) data = setPath(data, reference.path, null);
            yield* enforceSchema(gathered.from.name, data);
            // One change to the document however many of its fields this
            // delete clears: a version already moved here stays where it is.
            const cleared: Document = {
              ...holder, data, updatedAt: new Date().toISOString(),
              version: pending.bySeq.has(at) ? holder.version : holder.version + 1,
            };
            yield* documentPut(txn, cleared, gathered.seq, pending, gathered.from);
          }
        });
      yield* release(deleted);
    });

  /** Changes one batch may carry, bounding what one transaction holds. */
  const MAX_BATCH = 1000;

  /** Insert one document inside a transaction, under everything it must satisfy. */
  const applyInsert = (
    txn: Txn,
    pending: Pending,
    input: { readonly collection: string; readonly id: string; readonly data: JsonObject },
    seq: Seq,
  ) =>
    Effect.gen(function* () {
      const collection = yield* requireCollection(input.collection);
      yield* enforceSchema(input.collection, input.data);
      const taken = yield* currentNamed(pending, input.collection, input.id);
      if (taken !== undefined && taken.document !== null) {
        return yield* new DocumentConflict({
          collection: input.collection, id: input.id, reason: "a document with this id already exists",
        });
      }
      const now = new Date().toISOString();
      const doc: Document = {
        id: input.id, collection: input.collection, data: input.data,
        createdAt: now, updatedAt: now, version: 1,
      };
      yield* documentPut(txn, doc, seq, pending, collection);
      return doc;
    });

  const applyUpdate = (
    txn: Txn,
    pending: Pending,
    input: {
      readonly collection: string;
      readonly id: string;
      readonly data: JsonObject;
      readonly mode?: "merge" | "replace";
      readonly expectedVersion?: number;
      readonly precondition?: ReadonlyArray<DocumentFilter>;
    },
  ) =>
    Effect.gen(function* () {
      const at = yield* currentNamed(pending, input.collection, input.id);
      if (at === undefined || at.document === null) {
        return yield* new DocumentNotFound({ collection: input.collection, id: input.id });
      }
      const current = at.document;
      yield* expect(input.collection, current, input.expectedVersion, input.precondition);
      const data = (input.mode ?? "merge") === "replace" ? input.data : { ...current.data, ...input.data };
      yield* enforceSchema(input.collection, data);
      const next: Document = {
        ...current, data, updatedAt: new Date().toISOString(), version: current.version + 1,
      };
      yield* documentPut(txn, next, at.seq, pending);
      return next;
    });

  const applyDelete = (
    txn: Txn,
    pending: Pending,
    input: {
      readonly collection: string;
      readonly id: string;
      readonly expectedVersion?: number;
      readonly precondition?: ReadonlyArray<DocumentFilter>;
    },
  ) =>
    Effect.gen(function* () {
      const at = yield* currentNamed(pending, input.collection, input.id);
      // Not there, or already gone earlier in this transaction.
      if (at === undefined || at.document === null) return false;
      yield* expect(input.collection, at.document, input.expectedVersion, input.precondition);
      yield* releaseReferences(txn, at.document, at.seq, pending);
      yield* documentRetract(txn, at.document, at.seq, pending);
      return true;
    });

  /**
   * The conditions a caller put on a change, checked against the document as
   * it stands inside the transaction: a version, and filters its data must
   * match. Each is a compare-and-set, and holds only because nothing can write
   * the document between the check and the change.
   */
  const expect = (
    collection: string,
    current: Document,
    expectedVersion: number | undefined,
    precondition: ReadonlyArray<DocumentFilter> | undefined,
  ): Effect.Effect<void, DocumentConflict> => {
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      return Effect.fail(new DocumentConflict({
        collection, id: current.id, reason: `expected version ${expectedVersion}, found ${current.version}`,
      }));
    }
    const unmet = precondition?.find((filter) => !matches(current.data, filter));
    return unmet === undefined
      ? Effect.void
      : Effect.fail(new DocumentConflict({
        collection, id: current.id, reason: `the document does not match ${describeFilter(unmet)}`,
      }));
  };

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

  /**
   * Two documents holding the same values in every field of a unique index,
   * if any do. Equal tuples sit next to each other in the index, so this is
   * one ordered read of it; a tuple missing a value is not held to the index
   * and is passed over.
   */
  const duplicateIn = (index: StoredIndex) =>
    Effect.gen(function* () {
      const directions = index.fields.map((field) => field.direction);
      let previous: { readonly value: unknown; readonly seq: Seq } | undefined;
      let after: OrderedCursor | undefined;
      for (;;) {
        const page = yield* orderedPage({
          column: index.column, limit: 1000, ...(after === undefined ? {} : { after }),
        }).pipe(Effect.orDie);
        for (const row of page.rows) {
          if (previous !== undefined && row.value === previous.value &&
            decodeOrderedTuple(String(row.value), directions).every((value) => value !== undefined)) {
            return [previous.seq, row.seq] as const;
          }
          previous = { value: row.value, seq: row.seq };
        }
        if (page.next === undefined) return undefined;
        after = page.next;
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
      let rewritten = 0;
      for (let at = 0; at < seqs.length; at += REWRITE_CHUNK) {
        rewritten += yield* transactOrDie((txn) =>
          Effect.gen(function* () {
            const record = yield* loadCollection(collection);
            const indexes = record?.indexes ?? [];
            const analyzer = record?.analyzer;
            const spatial = record?.spatial;
            const cells = yield* spatialHandle(spatial);
            let written = 0;
            for (const seq of seqs.slice(at, at + REWRITE_CHUNK)) {
              const object = yield* readObject(seq);
              if (object === undefined) continue;
              const doc = decode<Document>(object.bytes);
              if (doc.collection !== collection) continue;
              yield* txn.put(seq, object.bytes, manifestFor(doc, indexes, analyzer, spatial, cells), {
                namespace: documentNs(tenant, collection), key: doc.id,
              });
              written += 1;
            }
            return written;
          }));
      }
      return rewritten;
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

  /**
   * What a `related` clause becomes: filters on the referencing field, or
   * undefined when nothing it could name exists — in which case the read is
   * empty and the collection is never touched.
   */
  const relatedFilters = (
    collection: StoredCollection | undefined,
    name: string,
    related: ReadonlyArray<RelatedFilter> | undefined,
  ): Effect.Effect<
    ReadonlyArray<DocumentFilter> | undefined,
    UnknownReference | UnanalyzedCollection | UnindexedGeometry
  > =>
    Effect.gen(function* () {
      if (related === undefined || related.length === 0) return [];
      const filters: Array<DocumentFilter> = [];
      for (const clause of related) {
        const reference = (collection?.references ?? []).find((candidate) => candidate.name === clause.reference);
        if (reference === undefined) {
          return yield* new UnknownReference({ collection: name, name: clause.reference });
        }
        let ids: Array<string>;
        if (clause.id !== undefined) {
          // One named document: read it, and hold it to the clause's filters.
          const seq = yield* lookup(documentNs(tenant, reference.collection), clause.id);
          const target = seq === undefined ? undefined : yield* readDocument(seq);
          const matching = target !== undefined &&
            (clause.where ?? []).every((filter) => matches(target.data, filter));
          ids = matching ? [clause.id] : [];
        } else {
          const targets = yield* findDocuments({
            collection: reference.collection,
            ...(clause.where === undefined ? {} : { where: clause.where }),
          });
          ids = targets.map((target) => target.id);
        }
        if (ids.length === 0) return undefined;
        filters.push({ path: reference.path, op: "in", value: ids });
      }
      return filters;
    });

  /**
   * What a search becomes: the words of the query, analyzed the way the
   * documents were, over the postings the writer produced.
   *
   * Every word must appear (they are intersected), and a word counts wherever
   * any analyzed field carries it (those are united). So this is an ordinary
   * set operation over the term lens, and it intersects with filters, ranges
   * and joins like any other clause. Undefined when the query has no words
   * left after analysis — every word was a stop word, or too short — which
   * means it asks for nothing rather than for everything.
   */
  const searchQuery = (
    analyzer: Analyzer | undefined,
    collection: string,
    text: string,
  ): Effect.Effect<Query | undefined, UnanalyzedCollection> =>
    Effect.gen(function* () {
      if (analyzer === undefined) {
        return yield* new UnanalyzedCollection({ collection });
      }
      const words = tokenize(text, analyzer);
      if (words.length === 0) return undefined;
      const clauses = words.map((word) => {
        const fields = analyzer.fields.map((path) => term(path, word));
        return fields.length === 1 ? fields[0]! : or(...fields);
      });
      return clauses.length === 1 ? clauses[0]! : and(...clauses);
    });

  /**
   * The cells a spatial filter should look in.
   *
   * A radius asks for the rings of cells around its centre, at a resolution
   * coarse enough that the ring stays small — the covering is approximate
   * either way, so spending postings on precision here buys nothing the exact
   * check does not already provide. A box or a shape is covered directly.
   */
  const spatialCells = (
    h3: Parameters<typeof cellsFor>[0],
    spatial: SpatialIndex,
    filter: SpatialFilter,
  ): ReadonlyArray<string> => {
    const cells = new Set<string>([COARSE_SENTINEL]);
    if ("near" in filter) {
      for (const cell of diskFor(h3, filter.near, filter.radius, spatial.resolution)) cells.add(cell);
      return [...cells];
    }
    // A box crossing the antimeridian is two boxes; one ring would be read the
    // long way round the world, which is both the wrong area and a covering
    // that never finishes.
    const shapes: ReadonlyArray<Geometry> = "within" in filter
      ? boxGeometry(filter.within)
      : [filter.intersects];
    for (const shape of shapes) {
      for (const cell of coveringFor(h3, shape, spatial.resolution).cells) cells.add(cell);
    }
    return [...cells];
  };

  /**
   * A plan narrowed by a spatial filter: candidates from cells, decided by the
   * geometry itself.
   *
   * The exact check travels as a residual filter, which `keeps` applies to
   * every document the postings produce — so a coarse covering costs work and
   * never correctness.
   */
  const withGeometry = (
    collection: StoredCollection | undefined,
    name: string,
    plan: Plan,
    filter: SpatialFilter,
  ): Effect.Effect<Plan, UnindexedGeometry> =>
    Effect.gen(function* () {
      const spatial = collection?.spatial;
      if (spatial === undefined || !spatial.fields.includes(filter.field)) {
        return yield* new UnindexedGeometry({ collection: name, field: filter.field });
      }
      const h3 = yield* Effect.orDie(loadH3);
      const exact: DocumentFilter = {
        path: filter.field,
        op: "geometry",
        value: filter as unknown as Json,
      };
      return withCells(plan, filter.field, spatialCells(h3, spatial, filter), exact);
    });

  const findDocuments = (
    input: FindDocumentsInput,
  ): Effect.Effect<
    ReadonlyArray<Document>,
    UnknownReference | UnanalyzedCollection | UnindexedGeometry
  > =>
    Effect.gen(function* () {
      const collection = yield* loadCollection(input.collection);
      const related = yield* relatedFilters(collection, input.collection, input.related);
      if (related === undefined) return [];
      const where = [...(input.where ?? []), ...related];
      const words = input.search === undefined
        ? undefined
        : yield* searchQuery(collection?.analyzer, input.collection, input.search);
      if (input.search !== undefined && words === undefined) return [];
      let plan = withSearch(planQuery(tenant, input.collection, where), words);
      if (input.geometry !== undefined) {
        plan = yield* withGeometry(collection, input.collection, plan, input.geometry);
      }
      const offset = input.offset ?? 0;
      const take = input.limit === undefined ? undefined : offset + input.limit;
      const slice = (docs: ReadonlyArray<Document>) =>
        input.limit === undefined ? docs.slice(offset) : docs.slice(offset, offset + input.limit);
      const sorts = normalizeSorts(input.orderBy);
      if (sorts.length > 0) {
        const indexed = chooseIndex(collection?.indexes ?? [], sorts, equalityBindings(where));
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
      const docs: Document[] = [];
      for (const seq of yield* Stream.runCollect(resolveQuery(plan.query))) {
        const doc = yield* readDocument(seq);
        if (keep(doc)) docs.push(doc);
      }
      // No index serves these fields, so they are sorted here — in the
      // lens's order, so the answer matches what an index would give.
      return slice(sorts.length === 0 ? docs : docs.sort(compareDocuments(sorts)));
    });

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
        const checks: Array<CheckConstraint> = [];
        for (const definition of input.checks ?? []) {
          const check = yield* normalizeCheck(input.name, definition);
          if (checks.some((other) => other.name === check.name)) {
            return yield* new InvalidConstraint({ collection: input.name, name: check.name, reason: "the name is given twice" });
          }
          checks.push(check);
        }
        const references: Array<Required<ReferenceConstraint>> = [];
        for (const definition of input.references ?? []) {
          const reference = yield* normalizeReference(input.name, definition);
          if (references.some((other) => other.name === reference.name)) {
            return yield* new InvalidConstraint({ collection: input.name, name: reference.name, reason: "the name is given twice" });
          }
          references.push(reference);
        }
        const analyzer = input.analyzer === undefined
          ? undefined
          : yield* normalizeAnalyzer(input.name, input.analyzer);
        const spatial = input.spatial === undefined
          ? undefined
          : yield* normalizeSpatial(input.name, input.spatial);
        const collection: StoredCollection = {
          name: input.name,
          createdAt: new Date().toISOString(),
          surface: input.surface ?? "database",
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
          ...(indexes.length === 0 ? {} : { indexes }),
          ...(checks.length === 0 ? {} : { checks }),
          ...(references.length === 0 ? {} : { references }),
          ...(analyzer === undefined ? {} : { analyzer }),
          ...(spatial === undefined ? {} : { spatial }),
        };
        const seq = yield* nextSeq;
        // The collection and the back-references its targets carry, together:
        // a delete in a target finds what names it from its own record.
        yield* transactChecked((txn) =>
          Effect.gen(function* () {
            const own = references
              .filter((reference) => reference.collection === input.name)
              .map((reference) => ({ collection: input.name, reference: reference.name }));
            yield* collectionPut(txn, seq, own.length === 0 ? collection : { ...collection, referencedBy: own });
            yield* linkTargets(txn, input.name, references.filter((reference) => reference.collection !== input.name));
          }));
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
        const request = `insert into "${input.collection}"`;
        const fingerprint = fingerprintOf({
          op: "insert", collection: input.collection, id: input.id, data: input.data,
        });
        if (input.idempotencyKey !== undefined) {
          const seen = yield* receiptFor(input.idempotencyKey, fingerprint, request);
          if (seen !== undefined) return seen.result as Document;
        }
        // A generated id would differ on every retry, so a keyed insert without
        // one would store a second document and hand back the first.
        const id = input.id ?? crypto.randomUUID();
        // Allocated before the transaction, which cannot take the writer twice;
        // a refused insert leaves a gap, which nothing depends on not having.
        const seq = yield* nextSeq;
        return yield* commitOnce(input.idempotencyKey, fingerprint, request, (txn) =>
          Effect.gen(function* () {
            yield* assertNotMoving;
            return yield* applyInsert(txn, nothingPending(), {
              collection: input.collection, id, data: input.data,
            }, seq);
          }));
      }),

    findById: (input) =>
      Effect.gen(function* () {
        const seq = yield* lookup(documentNs(tenant, input.collection), input.id);
        return seq === undefined ? undefined : yield* readDocument(seq);
      }),

    findMany: (input) => findDocuments(input),

    findPage: (input) =>
      Effect.gen(function* () {
        const sorts = normalizeSorts(input.orderBy);
        const collection = yield* loadCollection(input.collection);
        const related = yield* relatedFilters(collection, input.collection, input.related);
        const where = related === undefined ? [] : [...(input.where ?? []), ...related];
        const words = input.search === undefined
          ? undefined
          : yield* searchQuery(collection?.analyzer, input.collection, input.search);
        const geometry = input.geometry;
        const indexed = sorts.length === 0
          ? undefined
          : chooseIndex(collection?.indexes ?? [], sorts, equalityBindings(where));
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
        // Nothing the related clause could name, or no word left to search
        // for: the page is empty, and the collection is never read.
        if (related === undefined || (input.search !== undefined && words === undefined)) {
          return { documents: [] };
        }
        let plan = withSearch(planQuery(tenant, input.collection, where), words);
        if (geometry !== undefined) {
          plan = yield* withGeometry(collection, input.collection, plan, geometry);
        }
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
          ...(input.cursors === true
            ? { cursors: page.map((entry) => encodeDocumentCursor(shape, entry.position)) }
            : {}),
        };
      }),

    withRelated: (input) =>
      Effect.gen(function* () {
        const collection = yield* loadCollection(input.collection);
        const declared = collection?.references ?? [];
        const references = input.references === undefined
          ? declared
          : yield* Effect.forEach(input.references, (name) => {
            const found = declared.find((reference) => reference.name === name);
            return found === undefined
              ? new UnknownReference({ collection: input.collection, name })
              : Effect.succeed(found);
          });
        // One read per named document, however many documents name it.
        const seen = new Map<string, Document | undefined>();
        const out: Array<RelatedDocuments> = [];
        for (const document of input.documents) {
          const related: Record<string, Document | undefined> = {};
          for (const reference of references) {
            const value = readPath(document.data, reference.path);
            if (typeof value !== "string") continue;
            const at = `${reference.collection}/${value}`;
            if (!seen.has(at)) {
              const seq = yield* lookup(documentNs(tenant, reference.collection), value);
              seen.set(at, seq === undefined ? undefined : yield* readDocument(seq));
            }
            related[reference.name] = seen.get(at);
          }
          out.push({ document, related });
        }
        return out;
      }),

    update: (input) =>
      Effect.gen(function* () {
        const request = `update "${input.collection}/${input.id}"`;
        const fingerprint = fingerprintOf({
          op: "update", collection: input.collection, id: input.id, data: input.data,
          mode: input.mode, expectedVersion: input.expectedVersion, precondition: input.precondition,
        });
        // The version, the conditions and the data merged into are all read in
        // the transaction that writes, so two updates cannot both build on the
        // same version and have one silently undo the other.
        return yield* commitOnce(input.idempotencyKey, fingerprint, request, (txn) =>
          Effect.gen(function* () {
            yield* assertNotMoving;
            return yield* applyUpdate(txn, nothingPending(), input);
          }));
      }),

    delete: (input) =>
      Effect.gen(function* () {
        const request = `delete "${input.collection}/${input.id}"`;
        const fingerprint = fingerprintOf({
          op: "delete", collection: input.collection, id: input.id,
          expectedVersion: input.expectedVersion, precondition: input.precondition,
        });
        return yield* commitOnce(input.idempotencyKey, fingerprint, request, (txn) =>
          Effect.gen(function* () {
            yield* assertNotMoving;
            return yield* applyDelete(txn, nothingPending(), input);
          }),
          // Nothing happened, so there is nothing to remember: a later retry
          // that finds the document present should delete it rather than
          // replay a "no" from when it was already gone.
          (deleted) => deleted);
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
        if (!sameFields(recorded.fields, definition.fields) || (recorded.unique === true) !== definition.unique) {
          return yield* new IndexExists({
            collection: input.collection,
            name: definition.name,
            reason: `it is defined over ${describeFields(recorded.fields)}${recorded.unique === true ? ", unique" : ""}`,
          });
        }
        if (recorded.state === "ready") return publicIndex(recorded);
        // A building index found here may be one an earlier call did not
        // finish; rewriting is idempotent, so finishing it is running it again.
        yield* rewriteDocuments(input.collection);
        // Ready, or — for a unique index the documents already break — gone,
        // decided in one transaction: no write can slip a duplicate in between
        // the check and the index starting to refuse them.
        const outcome = yield* transactOrDie((txn) =>
          Effect.gen(function* () {
            const current = yield* loadCollection(input.collection);
            const indexes = current?.indexes ?? [];
            if (current === undefined || !indexes.some((index) => index.column === recorded.column)) {
              return { _tag: "dropped" } as const;
            }
            const clash = recorded.unique === true ? yield* duplicateIn(recorded) : undefined;
            if (clash !== undefined) {
              yield* collectionPut(txn, seq, {
                ...current,
                indexes: indexes.filter((index) => index.column !== recorded.column),
              });
              return { _tag: "duplicate", clash } as const;
            }
            yield* collectionPut(txn, seq, {
              ...current,
              indexes: indexes.map((index) =>
                index.column === recorded.column ? { ...index, state: "ready" as const } : index),
            });
            return { _tag: "ready" } as const;
          }));
        if (outcome._tag === "duplicate") {
          yield* rewriteDocuments(input.collection);
          const [first, second] = yield* Effect.forEach(outcome.clash, (held) => readDocument(held));
          return yield* new UniqueViolation({
            collection: input.collection, index: definition.name,
            id: second?.id ?? "?", holder: first?.id ?? "?",
          });
        }
        // Dropped while it was being built: what it was is all there is to say.
        return outcome._tag === "ready" ? { ...publicIndex(recorded), state: "ready" } : publicIndex(recorded);
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

    addCheck: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        const check = yield* normalizeCheck(input.collection, input);
        const seq = yield* lookup(collectionNs(tenant), input.collection);
        if (seq === undefined) return yield* new CollectionNotFound({ name: input.collection });
        // Recorded first, so every write from here on is held to it; then the
        // documents already there are read against it. A write refused in
        // between was refused by a check its caller had asked for.
        const recorded = yield* transactOrDie((txn) =>
          Effect.gen(function* () {
            const current = yield* loadCollection(input.collection);
            if (current === undefined) return "missing" as const;
            if ((current.checks ?? []).some((other) => other.name === check.name)) return "exists" as const;
            yield* collectionPut(txn, seq, { ...current, checks: [...(current.checks ?? []), check] });
            return "added" as const;
          }));
        if (recorded === "missing") return yield* new CollectionNotFound({ name: input.collection });
        if (recorded === "exists") return yield* new ConstraintExists({ collection: input.collection, name: check.name });
        for (const held of yield* Stream.runCollect(resolveQuery(equals(collectionColumn(tenant), input.collection)))) {
          const doc = yield* readDocument(held);
          const failed = doc === undefined ? undefined : check.where.find((filter) => !satisfiesCheck(doc.data, filter));
          if (doc === undefined || failed === undefined) continue;
          yield* transactOrDie((txn) =>
            Effect.gen(function* () {
              const current = yield* loadCollection(input.collection);
              if (current === undefined) return;
              yield* collectionPut(txn, seq, {
                ...current, checks: (current.checks ?? []).filter((other) => other.name !== check.name),
              });
            }));
          return yield* new CheckViolation({
            collection: input.collection, id: doc.id, check: check.name,
            reason: `${describeFilter(failed)} does not hold, so the check was not added`,
          });
        }
        return check;
      }),

    analyze: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        const analyzer = yield* normalizeAnalyzer(input.collection, input.analyzer);
        const seq = yield* lookup(collectionNs(tenant), input.collection);
        if (seq === undefined) return yield* new CollectionNotFound({ name: input.collection });
        // Recorded first, so every write from here on analyzes this way; the
        // documents already there are then written back under it.
        const recorded = yield* transactOrDie((txn) =>
          Effect.gen(function* () {
            const current = yield* loadCollection(input.collection);
            if (current === undefined) return false;
            yield* collectionPut(txn, seq, { ...current, analyzer });
            return true;
          }));
        if (!recorded) return yield* new CollectionNotFound({ name: input.collection });
        return { analyzer, documents: yield* rewriteDocuments(input.collection) };
      }),

    locate: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        const spatial = yield* normalizeSpatial(input.collection, input.spatial);
        const seq = yield* lookup(collectionNs(tenant), input.collection);
        if (seq === undefined) return yield* new CollectionNotFound({ name: input.collection });
        const recorded = yield* transactOrDie((txn) =>
          Effect.gen(function* () {
            const current = yield* loadCollection(input.collection);
            if (current === undefined) return false;
            yield* collectionPut(txn, seq, { ...current, spatial });
            return true;
          }));
        if (!recorded) return yield* new CollectionNotFound({ name: input.collection });
        return { spatial, documents: yield* rewriteDocuments(input.collection) };
      }),

    addReference: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        const reference = yield* normalizeReference(input.from, input);
        const seq = yield* lookup(collectionNs(tenant), input.from);
        if (seq === undefined) return yield* new CollectionNotFound({ name: input.from });
        const recorded = yield* transactChecked((txn) =>
          Effect.gen(function* () {
            const current = yield* loadCollection(input.from);
            if (current === undefined) return "missing" as const;
            if ((current.references ?? []).some((other) => other.name === reference.name)) return "exists" as const;
            const withReference = { ...current, references: [...(current.references ?? []), reference] };
            if (reference.collection === input.from) {
              yield* collectionPut(txn, seq, {
                ...withReference,
                referencedBy: [...(current.referencedBy ?? []), { collection: input.from, reference: reference.name }],
              });
            } else {
              yield* collectionPut(txn, seq, withReference);
              yield* linkTargets(txn, input.from, [reference]);
            }
            return "added" as const;
          }));
        if (recorded === "missing") return yield* new CollectionNotFound({ name: input.from });
        if (recorded === "exists") return yield* new ConstraintExists({ collection: input.from, name: reference.name });
        for (const held of yield* Stream.runCollect(resolveQuery(equals(collectionColumn(tenant), input.from)))) {
          const doc = yield* readDocument(held);
          const value = doc === undefined ? undefined : readPath(doc.data, reference.path);
          if (doc === undefined || value === undefined || value === null) continue;
          const names = typeof value === "string" && (
            (reference.collection === input.from && value === doc.id) ||
            (yield* lookup(documentNs(tenant, reference.collection), value)) !== undefined);
          if (names) continue;
          yield* transactOrDie((txn) => unlinkReference(txn, input.from, reference.name));
          return yield* new ReferenceViolation({
            collection: input.from, id: doc.id, reference: reference.name,
            reason: `${reference.path} holds ${JSON.stringify(value)}, which names no document in "${reference.collection}", so the reference was not added`,
          });
        }
        return reference;
      }),

    dropReference: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        if ((yield* lookup(collectionNs(tenant), input.collection)) === undefined) {
          return yield* new CollectionNotFound({ name: input.collection });
        }
        return yield* transactOrDie((txn) => unlinkReference(txn, input.collection, input.name));
      }),

    dropCheck: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        const seq = yield* lookup(collectionNs(tenant), input.collection);
        if (seq === undefined) return yield* new CollectionNotFound({ name: input.collection });
        return yield* transactOrDie((txn) =>
          Effect.gen(function* () {
            const current = yield* loadCollection(input.collection);
            const checks = current?.checks ?? [];
            if (current === undefined || !checks.some((check) => check.name === input.name)) return false;
            yield* collectionPut(txn, seq, { ...current, checks: checks.filter((check) => check.name !== input.name) });
            return true;
          }));
      }),

    write: (input) =>
      Effect.gen(function* () {
        const operations = input.operations;
        if (!Array.isArray(operations) || operations.length === 0 || operations.length > MAX_BATCH) {
          return yield* Effect.die(
            new RangeError(`A batch takes 1 to ${MAX_BATCH} changes, not ${operations?.length}.`),
          );
        }
        const request = `write ${operations.length} documents`;
        const fingerprint = fingerprintOf({ op: "write", operations });
        if (input.idempotencyKey !== undefined) {
          const seen = yield* receiptFor(input.idempotencyKey, fingerprint, request);
          if (seen !== undefined) return seen.result as ReadonlyArray<DocumentWritten>;
        }
        // Ids and identifiers are settled before the transaction, which cannot
        // take the writer a second time to allocate one.
        const ids = operations.map((operation) =>
          operation._tag === "Insert" ? operation.id ?? crypto.randomUUID() : operation.id);
        const seqs: Array<Seq | undefined> = [];
        for (const operation of operations) {
          seqs.push(operation._tag === "Insert" ? yield* nextSeq : undefined);
        }
        return yield* commitOnce(input.idempotencyKey, fingerprint, request, (txn) =>
          Effect.gen(function* () {
            yield* assertNotMoving;
            // One overlay for the batch: each change sees what the ones before
            // it wrote, which is what makes them one change rather than several.
            const pending = nothingPending();
            const written: Array<DocumentWritten> = [];
            for (const [at, operation] of operations.entries()) {
              if (operation._tag === "Insert") {
                const document = yield* applyInsert(txn, pending, {
                  collection: operation.collection, id: ids[at]!, data: operation.data,
                }, seqs[at]!);
                written.push({ _tag: "Inserted", document });
                continue;
              }
              if (operation._tag === "Update") {
                written.push({ _tag: "Updated", document: yield* applyUpdate(txn, pending, operation) });
                continue;
              }
              written.push({
                _tag: "Deleted", collection: operation.collection, id: operation.id,
                deleted: yield* applyDelete(txn, pending, operation),
              });
            }
            return written as ReadonlyArray<DocumentWritten>;
          }));
      }),

    rewrite: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        const names: Array<string> = [];
        if (input?.collection === undefined) {
          for (const seq of yield* Stream.runCollect(
            resolveQuery(equals(collectionColumn(tenant), COLLECTION_MARKER)),
          )) {
            const object = yield* readObject(seq);
            if (object !== undefined) names.push(decode<StoredCollection>(object.bytes).name);
          }
        } else {
          yield* requireCollection(input.collection);
          names.push(input.collection);
        }
        let documents = 0;
        for (const name of names) documents += yield* rewriteDocuments(name);
        return { collections: names.length, documents };
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
