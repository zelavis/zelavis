/** How collections, documents and receipts are named and stored, and the overlay a transaction writes through. */
import { parseJson, objectFields, optional, arrayOf, recordOf, literal, isString, isTimestamp, isBoolean, isFiniteNumber, isPositiveInteger, isNonNegativeInteger, isJsonValue, isJsonObject, isUnknown, type JsonValidator } from "../core/json-validation.js";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { Json, JsonObject } from "./json.js";
import {
  COLLECTION_NAME_PATTERN,
  isReservedCollectionName,
  RESERVED_COLLECTION_PREFIX,
} from "./naming.js";
import { COLLECTION_NAMESPACE, documentNamespace, IDEMPOTENCY_NAMESPACE } from "./tenancy.js";
import { InvalidCollectionName } from "./errors.js";
import { type Seq } from "./model.js";

import { type Analyzer, type CheckConstraint, type Collection, type CollectionIndex, type DerivedDeclarationSet, type Document, type DocumentFilter, type EdgeDefinition, type EmbeddingIndex, type IndexField, type MeasureDefinition, type ReferenceConstraint, type SpatialIndex } from "./document-model.js";

/** Marks a stored collection record, distinct from any collection name. */
export const COLLECTION_MARKER = "\u0000collection";

/**
 * What a keyed write did, so a retry can be answered instead of repeated.
 *
 * The fingerprint is of the request rather than of the result: two callers
 * asking for the same thing should share an outcome, and one caller reusing a
 * key for something else should be told so.
 */
export interface Receipt {
  readonly key: string;
  readonly fingerprint: string;
  /** The request in words, so a reuse can say what the key was first spent on. */
  readonly request: string;
  readonly result: unknown;
  readonly at: string;
}

export const idempotencyNs = () => IDEMPOTENCY_NAMESPACE;

/** Marks a receipt, so a partition's can be found without reading every record. */
export const idempotencyColumn = () => IDEMPOTENCY_NAMESPACE;
export const RECEIPT_MARKER = "\u0000receipt";

/**
 * A stable fingerprint of a request.
 *
 * Keys are sorted at every level, because two callers writing the same fields
 * in a different order are making the same request and a retry that reordered
 * them would otherwise look like a different one.
 */
export const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
};

export const fingerprintOf = (request: unknown): string =>
  createHash("sha256").update(canonical(request)).digest("hex");


/**
 * Tenant scoping is structural, not a filter.
 *
 * Several tenants share a physical shard, but each owns a partition: a range
 * of the shard's keyspace that begins with its name, with its own identifiers
 * and its own log. Rather than appending a tenant predicate to every query —
 * which is a thing a caller can forget, and which silently returns another
 * tenant's rows when they do — this handle reads and writes only its own
 * partition, so the names below need only say which collection they mean.
 */
export const collectionNs = () => COLLECTION_NAMESPACE;
export const documentNs = (collection: string) => documentNamespace(collection);
export const collectionColumn = () => COLLECTION_NAMESPACE;
export const columnFor = (collection: string, path: string) => `${collection}.${path}`;

/**
 * The term-lens field one analyzed path posts its words under.
 *
 * A term posting is found by its field alone, so the field has to name the
 * collection the way a column does. Under a bare path every collection's
 * `title` would share one posting list, and a search with no other clause
 * would answer from all of them.
 */
export const textFieldFor = (collection: string, path: string) => `${collection}.${path}`;

/**
 * The term-lens field one analyzed path posts its adjacent word pairs under
 * (`Analyzer.phrases`). `^` separates it: no collection name holds one.
 */
export const pairFieldFor = (collection: string, path: string) => `${collection}^${path}`;

/** How two adjacent words are named in the pair field: words never hold a space. */
export const wordPair = (first: string, second: string) => `${first} ${second}`;

/**
 * The term-lens field one spatial path posts its cells under. A collection name
 * holds no `@`, so this never meets a text field, whatever the paths are.
 */
export const cellFieldFor = (collection: string, path: string) => `${collection}@${path}`;

/**
 * The ordered-lens column one index keeps its postings in.
 *
 * Unique to one creation of the index. A document written before an index was
 * dropped can keep its postings until it is next written, and an index
 * recreated under the same name must never read them as its own. A collection
 * name holds no `:` or `.`, so this never meets a field's column.
 */
export const indexColumnFor = (collection: string, name: string) =>
  `${collection}:${name}#${crypto.randomUUID().slice(0, 8)}`;

/** An index as the collection record stores it: with the column its postings are in. */
export interface StoredIndex extends CollectionIndex {
  readonly column: string;
}

export interface StoredCollection extends Omit<Collection, "indexes"> {
  readonly indexes?: ReadonlyArray<StoredIndex>;
}

export const documentRecord = objectFields<Document>({ id: isString, collection: isString,
  data: isJsonObject, createdAt: isTimestamp, updatedAt: isTimestamp, version: isPositiveInteger,
  expiresAt: optional(isTimestamp), score: optional(isFiniteNumber), distance: optional(isFiniteNumber),
  highlights: optional(recordOf(arrayOf(isString))) });
export const filterRecord = objectFields<DocumentFilter>({ path: isString,
  op: optional(literal("eq", "ne", "gt", "gte", "lt", "lte", "in", "geometry", "phrase", "search")),
  value: (value): value is DocumentFilter["value"] => isJsonValue(value) });
export const storedIndexRecord = objectFields<StoredIndex>({ name: isString, column: isString,
  unique: isBoolean, state: literal("building", "ready"), fields: arrayOf(objectFields<Required<IndexField>>({
    path: isString, direction: literal("asc", "desc"), nulls: literal("first", "last") })) });
export const analyzerRecord = objectFields<Analyzer>({ fields: arrayOf(isString), version: isNonNegativeInteger,
  fold: optional(isBoolean), stopWords: optional(arrayOf(isString)), minLength: optional(isNonNegativeInteger), language: optional(isString),
  phrases: optional(isBoolean), synonyms: optional(arrayOf(arrayOf(isString))) });
export const spatialRecord = objectFields<SpatialIndex>({ fields: arrayOf(isString), resolution: isNonNegativeInteger, version: isNonNegativeInteger });
export const embeddingRecord = objectFields<EmbeddingIndex>({ field: isString, dimension: isPositiveInteger,
  metric: literal("cosine", "dot", "euclidean"), quantization: optional(literal("f32", "f16", "i8", "b1")),
  normalize: optional(isBoolean), model: optional(isString), modelVersion: optional((value): value is string | number => isString(value) || isFiniteNumber(value)), version: isNonNegativeInteger });
const edgeRecord = objectFields<EdgeDefinition>({ name: isString, path: isString, collection: isString });
const measureRecord = objectFields<MeasureDefinition>({ name: isString, path: isString });
export const collectionRecord = objectFields<StoredCollection>({ name: isString, createdAt: isTimestamp,
  surface: literal("content-studio", "database"), metadata: optional(recordOf(isUnknown)),
  indexes: optional(arrayOf(storedIndexRecord)),
  checks: optional(arrayOf(objectFields<CheckConstraint>({ name: isString, where: arrayOf(filterRecord) }))),
  references: optional(arrayOf(objectFields<Required<ReferenceConstraint>>({ name: isString, path: isString,
    collection: isString, onDelete: literal("restrict", "cascade", "set-null") }))),
  analyzer: optional(analyzerRecord),
  spatial: optional(spatialRecord),
  embedding: optional(embeddingRecord),
  edges: optional(arrayOf(edgeRecord)),
  measures: optional(arrayOf(measureRecord)),
  columns: optional(arrayOf(isString)),
  derived: optional(objectFields<DerivedDeclarationSet>({ schemaVersion: isPositiveInteger,
    analyzer: optional(analyzerRecord), measures: arrayOf(measureRecord), edges: arrayOf(edgeRecord),
    spatial: optional(spatialRecord), embedding: optional(embeddingRecord) })),
  referencedBy: optional(arrayOf(objectFields<{ collection: string; reference: string }>({ collection: isString, reference: isString }))),
});
export const receiptRecord = objectFields<Receipt>({ key: isString, fingerprint: isString, request: isString, result: isUnknown, at: isTimestamp });

export const publicIndex = (index: StoredIndex): CollectionIndex => ({
  name: index.name,
  fields: index.fields,
  unique: index.unique === true,
  state: index.state,
});

export const publicCollection = (stored: StoredCollection): Collection =>
  stored.indexes === undefined ? stored : { ...stored, indexes: stored.indexes.map(publicIndex) };

export const validateName = (name: string): Effect.Effect<void, InvalidCollectionName> => {
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

export const enc = new TextEncoder();
export const dec = new TextDecoder();
export const encode = (value: unknown) => enc.encode(JSON.stringify(value));
export const decode = <A>(bytes: Uint8Array, check: JsonValidator<A>): A => parseJson(dec.decode(bytes), check, "database record");

export const readPath = (data: JsonObject, path: string): Json | undefined => {
  let cursor: Json | undefined = data;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as JsonObject)[segment];
  }
  return cursor;
};

/** The data with one dotted path set, copying only what lies along it. */
export const setPath = (data: JsonObject, path: string, value: Json): JsonObject => {
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
export interface Pending {
  /** By identifier: the document as this transaction leaves it, or null once retracted. */
  readonly bySeq: Map<number, Document | null>;
  /** By `collection/id`, for the checks that address a document by name. */
  readonly byName: Map<string, { readonly seq: Seq; readonly document: Document | null }>;
  /** Unique values this transaction has taken, by column and tuple, to the document holding them. */
  readonly claimed: Map<string, string>;
}

export const nothingPending = (): Pending => ({ bySeq: new Map(), byName: new Map(), claimed: new Map() });

export const nameOf = (collection: string, id: string) => `${collection}/${id}`;

export const claimOf = (column: string, tuple: string) => `${column}\u0000${tuple}`;
