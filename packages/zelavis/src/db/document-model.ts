/** The public shapes of the documents API: collections, documents, queries and the API itself. */
import { Effect } from "effect";
import type { Json, JsonObject } from "./json.js";
import {
  CollectionExists,
  SchemaViolation,
  CollectionNotFound,
  DocumentConflict,
  DocumentNotFound,
  IdempotencyKeyReused,
  InvalidCollectionName,
  InvalidDocumentValue,
  InvalidMessage,
  MessageExists,
  TenantMoving,
  UnindexedField,
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
  UnembeddedCollection,
  UnknownEdge,
  UnknownMeasure,
  VectorShapeMismatch,
  InvalidVectorQuery,
  UnknownReference,
} from "./errors.js";
import { type BoundingBox, type Geometry, type Position as GeoPosition } from "./spatial.js";
import { type DistanceMetric, type VectorQuantization, type VectorProjectionIndex } from "./vectors.js";
import { type OrderedScalar } from "./model.js";


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
  /** Which field holds an embedding, and how it is compared; see `EmbeddingIndex`. */
  readonly embedding?: EmbeddingIndex;
  /** Typed links to many other documents; see `EdgeDefinition`. */
  readonly edges?: ReadonlyArray<EdgeDefinition>;
  /**
   * The fields equality, ranges and single-field order can use, each covering
   * itself and everything below it. Absent, every scalar is indexed. Declaring
   * them is what keeps a wide document from writing an index entry per field:
   * a document writes postings only for these, and a query on another field is
   * refused (`UnindexedField`) rather than run as a scan.
   */
  readonly columns?: ReadonlyArray<string>;
  /** Numeric fields kept in the measure lens; see `MeasureDefinition`. */
  readonly measures?: ReadonlyArray<MeasureDefinition>;
  /** The references other collections — or this one — make to this collection's documents. */
  readonly referencedBy?: ReadonlyArray<{ readonly collection: string; readonly reference: string }>;
}

export interface CollectionModalities {
  readonly collection: string;
  readonly document: { readonly status: "ready" };
  readonly keyValue: { readonly status: "ready"; readonly key: "document.id" };
  readonly events: { readonly status: "ready" };
  /** Every scalar unless the collection declares its columns; see `Collection.columns`. */
  readonly columns: { readonly status: "ready"; readonly fields: "all-json-scalars" | ReadonlyArray<string> };
  readonly search: { readonly status: "ready" | "requires-declaration"; readonly fields: ReadonlyArray<string> };
  readonly measures: { readonly status: "ready" | "requires-declaration"; readonly fields: ReadonlyArray<string> };
  readonly graph: { readonly status: "ready" | "requires-declaration"; readonly edges: ReadonlyArray<string> };
  readonly spatial: { readonly status: "ready" | "requires-declaration"; readonly fields: ReadonlyArray<string> };
  readonly vector: { readonly status: "ready" | "requires-declaration"; readonly field?: string };
}

/** An honest capability map: semantic lenses are never reported ready until their interpretation is declared. */
export const collectionModalities = (collection: Collection): CollectionModalities => ({
  collection: collection.name,
  document: { status: "ready" },
  keyValue: { status: "ready", key: "document.id" },
  events: { status: "ready" },
  columns: { status: "ready", fields: collection.columns ?? "all-json-scalars" },
  search: {
    status: collection.analyzer === undefined ? "requires-declaration" : "ready",
    fields: collection.analyzer?.fields ?? [],
  },
  measures: {
    status: collection.measures === undefined || collection.measures.length === 0
      ? "requires-declaration" : "ready",
    fields: collection.measures?.map((measure) => measure.path) ?? [],
  },
  graph: {
    status: collection.edges === undefined || collection.edges.length === 0
      ? "requires-declaration" : "ready",
    edges: collection.edges?.map((edge) => edge.name) ?? [],
  },
  spatial: {
    status: collection.spatial === undefined ? "requires-declaration" : "ready",
    fields: collection.spatial?.fields ?? [],
  },
  vector: {
    status: collection.embedding === undefined ? "requires-declaration" : "ready",
    ...(collection.embedding === undefined ? {} : { field: collection.embedding.field }),
  },
});

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
/**
 * What a collection promises about a field holding an embedding.
 *
 * The vectors stay in the documents, which are the authoritative state: this
 * declares how to read them, and keeps no second copy. No lens is consulted to
 * answer a similarity read either — an approximate index, when there is one,
 * will be a projection that can be dropped and rebuilt, and the only honest way
 * to know what it costs in recall is to have an exact answer to measure against.
 *
 * The model and its version are recorded rather than acted on. Vectors from two
 * different models are not comparable, and a search mixing them returns nonsense
 * in the shape of an answer; writing the identity down is what lets a reader —
 * or a later rebuild — notice that it happened.
 */
export interface EmbeddingIndex {
  /** The field holding the vector, by dotted path. */
  readonly field: string;
  /** How many elements every vector in that field has. */
  readonly dimension: number;
  /** How distance between two of them is measured. */
  readonly metric: DistanceMetric;
  /** Quantization format for storage and approximate indexing ("f32" | "f16" | "i8" | "b1"). */
  readonly quantization?: VectorQuantization;
  /**
   * Vectors are stored as given and compared as given. With `normalize`, each is
   * scaled to unit length as it is written, which makes cosine and dot the same
   * measure and saves the division on every later comparison.
   */
  readonly normalize?: boolean;
  /** Which model produced these vectors, and which version of it. */
  readonly model?: string;
  readonly modelVersion?: string | number;
  /** Raised when any of this changes, so documents can be rewritten under it. */
  readonly version: number;
}

/**
 * A typed link from one document to many others.
 *
 * A reference holds one id, so following one is a lookup. An edge holds a list,
 * so following one is a posting scan -- and because the postings are the target
 * documents' own identifiers, what comes back intersects with everything else
 * the target collection indexes. That is the whole reason this is a lens and
 * not a field: `where` on the target narrows the neighbours before they are
 * read, rather than after.
 *
 * The field may hold a single id as well as an array of them; one link is just
 * a short list.
 */
export interface EdgeDefinition {
  /** Letters, numbers, underscores and hyphens, like a collection name. */
  readonly name: string;
  /** The field holding the target id, or an array of them. */
  readonly path: string;
  /** The collection those ids name documents of. */
  readonly collection: string;
}

/**
 * A numeric field kept where aggregation can read it without the documents.
 *
 * The measure lens holds one number per document per measure, so summing a
 * million rows reads a million doubles rather than a million payloads. The
 * ordered lens already holds the same value; what this adds is a dense vector
 * indexed by identifier, which is the shape an aggregate wants.
 *
 * Only finite numbers are kept. A field that is absent, null, a string, or a
 * non-finite number has no measure posting, and a document without one is not
 * counted -- which is why `avg` divides by the documents that carried a value
 * rather than by the documents that matched.
 */
export interface MeasureDefinition {
  /** Letters, numbers, underscores and hyphens, like a collection name. */
  readonly name: string;
  /** The field holding the number. */
  readonly path: string;
}

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

export interface HighlightOptions {
  /** The opening tag for matches, defaults to "<mark>". */
  readonly preTag?: string;
  /** The closing tag for matches, defaults to "</mark>". */
  readonly postTag?: string;
  /** Maximum character length for a snippet, defaults to 100. */
  readonly snippetLength?: number;
  /** Maximum number of snippets to return per field, defaults to 3. */
  readonly maxSnippets?: number;
}

export interface Document<TData extends JsonObject = JsonObject> {
  readonly id: string;
  readonly collection: string;
  readonly data: TData;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
  /** Optional logical expiry used by models such as KV; deletion is evented when expiry is observed. */
  readonly expiresAt?: string;
  /** Present when a search query is scored, closest/most relevant first. */
  readonly score?: number;
  /** Present when a spatial near query is evaluated, distance in metres from query point. */
  readonly distance?: number;
  /** Highlighted snippets for searched fields, keyed by field path. */
  readonly highlights?: Record<string, ReadonlyArray<string>>;
}

export type FilterOperator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "geometry" | "phrase" | "search";

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

/**
 * Documents whose embedding is closest to a vector, closest first.
 *
 * Exact: every document the rest of the query admits is compared, and the `k`
 * closest come back. So the other clauses are what make it cheap — `where`,
 * `search` and `geometry` narrow the candidates before anything is compared,
 * and a similarity read under a narrow filter costs what that filter returns
 * rather than what the collection holds.
 *
 * Ties break by identifier, so the same query over the same documents answers
 * in the same order every time.
 */
export interface SimilarFilter {
  /** The field to compare, which the collection's `EmbeddingIndex` must name. */
  readonly field: string;
  /** The vector to compare against, of the dimension the index declares. */
  readonly vector: ReadonlyArray<number>;
  /** How many documents to return. If omitted on findPage, page limit determines the count. */
  readonly k?: number;
  /** Distance metric override for this read. */
  readonly metric?: DistanceMetric;
  /** Whether to use approximate index (defaults to true if approximate index is available, false for exact scan). */
  readonly approximate?: boolean;
}

/**
 * The documents one document links to, along an edge it declares.
 *
 * The named document's links become postings of the target documents'
 * identifiers, so this narrows to neighbours and then every other clause
 * narrows further -- a neighbour that fails a `where` is never read. Following
 * an edge of a document that does not exist is empty, not an error: it is a
 * question about links, and a document with none has none.
 */
export interface LinkFilter {
  /** The collection that declares the edge (defaults to queried collection). */
  readonly collection?: string;
  /** The document whose links are followed (or target document for inbound). */
  readonly id: string;
  /** Which declared edge to follow. */
  readonly edge: string;
  /**
   * Direction of edge traversal:
   * - "outbound" (default): documents linked from this document (source -> targets).
   * - "inbound": documents linking to this document (sources -> target).
   */
  readonly direction?: "outbound" | "inbound";
}

export interface TraverseInput {
  /** The collection containing the starting document. */
  readonly collection: string;
  /** The collection declaring the edge; defaults to collection or discovered target. */
  readonly edgeCollection?: string;
  /** The starting document identifier. */
  readonly id: string;
  /** Which declared edge to follow. */
  readonly edge: string;
  /** Traversal direction: "outbound" (default), "inbound", or "both". */
  readonly direction?: "outbound" | "inbound" | "both";
  /** Maximum traversal depth from starting document (default: 1, max: 20). */
  readonly maxDepth?: number;
  /** Maximum number of distinct documents to visit (default: 100, max: 1000). */
  readonly maxVisits?: number;
  /** Optional filter applied to traversed documents. */
  readonly where?: ReadonlyArray<DocumentFilter>;
}

export interface TraverseStep {
  readonly document: Document;
  readonly depth: number;
}

export interface TraverseResult {
  readonly documents: ReadonlyArray<Document>;
  readonly steps: ReadonlyArray<TraverseStep>;
  readonly visited: number;
  readonly maxDepthReached: number;
}

export type MeasureOperation =
  | "count" | "sum" | "avg" | "min" | "max" | "variance" | "stddev" | "countDistinct";

export interface SummarizeInput {
  readonly collection: string;
  /** Which declared measure to read; see `MeasureDefinition`. */
  readonly measure: string;
  readonly op: MeasureOperation;
  readonly where?: ReadonlyArray<DocumentFilter>;
  readonly related?: ReadonlyArray<RelatedFilter>;
  readonly search?: string;
  readonly geometry?: SpatialFilter;
  readonly linked?: LinkFilter;
}

export interface Summary {
  readonly value: number;
  /**
   * How many documents carried a value for the measure.
   *
   * Not how many matched: a document whose field is absent, null, or not a
   * finite number has no measure to read, and is not counted. This is the
   * denominator `avg` used, handed back so it does not have to be guessed at.
   */
  readonly documents: number;
}

export interface GroupedSummary extends Summary {
  /** The value at the grouped field, as the ordered lens holds it. */
  readonly key: OrderedScalar;
}

export interface FindDocumentsInput {
  readonly collection: string;
  readonly where?: ReadonlyArray<DocumentFilter>;
  /** Also: whose references name documents matching these; see `RelatedFilter`. */
  readonly related?: ReadonlyArray<RelatedFilter>;
  /** Also: whose analyzed text carries these words; see `Analyzer`. */
  readonly search?: string;
  /** When true or an edit distance number (1 or 2), terms match fuzzily. */
  readonly fuzzy?: boolean | number;
  /** When true, terms match as prefixes (e.g. for search-as-you-type). */
  readonly prefix?: boolean;
  /** Highlight matching terms in analyzed fields of returned documents. */
  readonly highlight?: boolean | HighlightOptions;
  /** Also: whose geometry meets this; see `SpatialFilter`. */
  readonly geometry?: SpatialFilter;
  /** Also: only the documents another document links to; see `LinkFilter`. */
  readonly linked?: LinkFilter;
  /**
   * Order by closeness to a vector instead of by a field; see `SimilarFilter`.
   */
  readonly similar?: SimilarFilter;
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
    /** Insert when absent, replace when present, atomically inside the batch. */
    readonly _tag: "Upsert";
    readonly collection: string;
    readonly id: string;
    readonly data: JsonObject;
    readonly expectedVersion?: number;
    /** `null` clears an earlier expiry; absent preserves it on update. */
    readonly expiresAt?: string | null;
    /** Relative expiry resolved only when the idempotent write is first applied. */
    readonly ttlMs?: number;
  }
  | {
    readonly _tag: "Insert";
    readonly collection: string;
    readonly id?: string;
    readonly data: JsonObject;
    readonly expiresAt?: string;
    readonly ttlMs?: number;
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

/**
 * A message for the tenant's outbox, recorded with the batch it rides in: the
 * message exists exactly when the batch's changes do.
 */
export interface OutboxEmit {
  /** What the message is about, for consumers to choose by. At most 256 characters. */
  readonly topic: string;
  readonly payload: JsonObject;
  /**
   * The message's id, which consumers deduplicate by. Generated when absent;
   * one the outbox already holds is refused (`MessageExists`).
   */
  readonly id?: string;
}

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
  /** When true or an edit distance number (1 or 2), terms match fuzzily. */
  readonly fuzzy?: boolean | number;
  /** When true, terms match as prefixes (e.g. for search-as-you-type). */
  readonly prefix?: boolean;
  /** Highlight matching terms in analyzed fields of returned documents. */
  readonly highlight?: boolean | HighlightOptions;
  /** Also: whose geometry meets this; see `SpatialFilter`. */
  readonly geometry?: SpatialFilter;
  /** Also: only the documents another document links to; see `LinkFilter`. */
  readonly linked?: LinkFilter;
  /**
   * Order by closeness to a vector instead of by a field; see `SimilarFilter`.
   * Paging order is score descending (score DESC, seq ASC) with a cursor that survives concurrent writes.
   */
  readonly similar?: SimilarFilter;
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

export interface DocumentsApi {
  /**
   * How many documents a collection holds.
   *
   * Counted from the collection's identifiers in the index, never by reading documents, so it costs
   * what listing those identifiers costs: linear in the collection, and cheap beside any read of its documents.
   * A collection's own definition is not one of them.
   */
  readonly count: (input: { readonly collection: string }) => Effect.Effect<number, CollectionNotFound>;
  /** Which logical lenses can interpret this collection right now. */
  readonly modalities: (input: { readonly collection: string }) => Effect.Effect<
    CollectionModalities,
    CollectionNotFound
  >;
  /**
   * Remove a collection, its documents, and everything derived from them.
   *
   * Creating a collection without being able to remove one makes a database
   * that only accumulates: a mistyped name is permanent, and a tenant that
   * ever held data can never stop being listed.
   *
   * Refused while another collection references this one. That reference is a
   * promise the other collection's documents still rely on, and dropping the
   * target would leave them pointing at nothing — the caller drops the
   * reference first, deliberately, or drops the other collection too.
   *
   * Documents go through the ordinary delete path rather than having their key
   * ranges cleared, so every lens, posting, index and back-reference is
   * maintained by the code that already knows how. That makes the cost linear
   * in the collection's size, which is the price of not having a second,
   * quieter way to remove a document.
   */
  readonly dropCollection: (input: {
    readonly name: string;
  }) => Effect.Effect<
    boolean,
    // Everything emptying it can hit: what finding the documents can fail
    // with, and what deleting one can.
    | CollectionNotFound | TenantMoving
    | UnknownReference | UnanalyzedCollection | UnindexedGeometry | UnembeddedCollection
    | InvalidVectorQuery | UnknownEdge
    | DocumentConflict | IdempotencyKeyReused
    | ReferenceViolation | SchemaViolation | CheckViolation | UniqueViolation
    | VectorShapeMismatch
  >;

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
    /** Which of this collection's fields holds an embedding; see `EmbeddingIndex`. */
    readonly embedding?: EmbeddingIndex;
    /** This collection's typed links to other documents; see `EdgeDefinition`. */
    readonly edges?: ReadonlyArray<EdgeDefinition>;
    /** This collection's numeric fields to aggregate; see `MeasureDefinition`. */
    readonly measures?: ReadonlyArray<MeasureDefinition>;
    /** The fields it indexes for equality, ranges and order; see `Collection.columns`. */
    readonly columns?: ReadonlyArray<string>;
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
    | CheckViolation | UniqueViolation | ReferenceViolation | VectorShapeMismatch | InvalidDocumentValue
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
    UnknownReference | UnanalyzedCollection | UnindexedGeometry | UnembeddedCollection
    | InvalidVectorQuery | UnknownEdge | UnindexedField
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
    | UnindexedGeometry | UnknownEdge | UnembeddedCollection | InvalidVectorQuery | UnindexedField
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
  /**
   * Bounded breadth-first graph traversal from a starting document along declared edges.
   */
  readonly traverse: (
    input: TraverseInput,
  ) => Effect.Effect<
    TraverseResult,
    | UnknownEdge | UnknownReference | UnanalyzedCollection
    | UnindexedGeometry | UnembeddedCollection | InvalidVectorQuery | UnindexedField
  >;
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
    | CheckViolation | UniqueViolation | ReferenceViolation | VectorShapeMismatch | InvalidDocumentValue
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
    | ReferenceViolation | SchemaViolation | CheckViolation | UniqueViolation | VectorShapeMismatch
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
   * Choose which fields a collection indexes for equality, ranges and order
   * (see `Collection.columns`), and rewrite its documents under the choice;
   * `null` indexes every scalar again. A field taken out is refused by queries
   * at once. Like `analyze`, the documents already there are written back under
   * the new choice, a write and a log entry each, so a field added answers for
   * every document once this has finished; running it again finishes an
   * interrupted one. Refused when a reference reads a field it leaves out.
   */
  readonly setColumns: (input: {
    readonly collection: string;
    readonly columns: ReadonlyArray<string> | null;
  }) => Effect.Effect<
    { readonly columns: ReadonlyArray<string> | null; readonly documents: number },
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
   * Declare which field holds an embedding, and hold the collection to it.
   *
   * Recorded first, so every write from here on must match the shape; then the
   * documents already there are read against it, and one that does not match
   * takes the declaration back off again — a collection should not promise a
   * shape its own documents do not keep. Nothing is rewritten: a vector is
   * posted to no lens, so there are no postings to re-derive.
   */
  readonly embed: (input: {
    readonly collection: string;
    readonly embedding: EmbeddingIndex;
  }) => Effect.Effect<
    { readonly embedding: EmbeddingIndex; readonly documents: number },
    CollectionNotFound | InvalidConstraint | TenantMoving | VectorShapeMismatch
  >;

  /**
   * Drops and rebuilds the vector projection index for a collection from its documents.
   */
  readonly rebuildVectorIndex: (input: {
    readonly collection: string;
  }) => Effect.Effect<
    { readonly indexed: number },
    CollectionNotFound | UnembeddedCollection
  >;

  /**
   * Drops the in-memory vector projection index for a collection.
   */
  readonly dropVectorIndex: (input: {
    readonly collection: string;
  }) => Effect.Effect<boolean, CollectionNotFound>;

  /**
   * Returns the current vector projection index for a collection if built, or undefined.
   */
  readonly getVectorIndex: (input: {
    readonly collection: string;
  }) => Effect.Effect<VectorProjectionIndex | undefined, CollectionNotFound>;

  /**
   * One number over a declared measure, across the documents a query admits.
   *
   * The filters resolve first and the measure is read only then, as one dense
   * vector indexed by identifier -- so this costs the identifiers the query
   * returns plus the measure, rather than a payload each. A filter no lens can
   * answer is the exception: it is decided on the document, at a read each.
   */
  readonly summarize: (
    input: SummarizeInput,
  ) => Effect.Effect<
    Summary,
    UnknownMeasure | UnknownReference | UnanalyzedCollection | UnindexedGeometry | UnknownEdge
    | UnindexedField
  >;

  /**
   * The same, one answer per value at a field.
   *
   * Group keys come from the ordered lens beside the identifiers, so grouping
   * reads no documents either. Groups come in the lens's order, and a group
   * whose documents all lack the measure is not one.
   */
  readonly summarizeBy: (
    input: SummarizeInput & {
      /** The field whose values separate the groups. */
      readonly groupBy: string;
      /** Groups to return: 100 unless given, and at most 1000. */
      readonly groups?: number;
    },
  ) => Effect.Effect<
    ReadonlyArray<GroupedSummary>,
    | UnknownMeasure | UnknownReference | UnanalyzedCollection | UnindexedGeometry | UnknownEdge
    | CursorMismatch | UnindexedField
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
    /**
     * Messages for the tenant's outbox, committed in the same transaction as
     * the changes: either all of it lands or none of it does. A batch may be
     * messages alone.
     */
    readonly emit?: ReadonlyArray<OutboxEmit>;
    /** Do this at most once; see `insert`. */
    readonly idempotencyKey?: string;
  }) => Effect.Effect<
    ReadonlyArray<DocumentWritten>,
    | CollectionNotFound | DocumentConflict | DocumentNotFound | SchemaViolation | TenantMoving
    | IdempotencyKeyReused | CheckViolation | UniqueViolation | ReferenceViolation
    | VectorShapeMismatch | InvalidDocumentValue | MessageExists | InvalidMessage
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
