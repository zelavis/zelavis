/** The documents API's reads for one tenant: queries planned, answered in order, and summarized. */
import { Effect, Stream } from "effect";
import { covarianceOf, histogramOf } from "./measure-statistics.js";
import type { Json } from "./json.js";
import {
  CollectionNotFound,
  UnindexedField,
  CursorMismatch,
  UnsupportedOrdering,
  UnanalyzedCollection,
  UnindexedGeometry,
  UnembeddedCollection,
  UnknownEdge,
  UnknownMeasure,
  InvalidVectorQuery,
  UnknownReference,
  InvalidMeasureQuery,
} from "./errors.js";
import {
  boxGeometry,
  cellsFor,
  coveringFor,
  diskFor,
  distanceToGeometry,
  loadH3,
  type Geometry,
  type Position as GeoPosition,
} from "./spatial.js";
import { isUsableVector, normalized, similarity, loadUsearch, createProjectionIndex } from "./vectors.js";
import { asSeq, type OrderedScalar, type Seq } from "./model.js";
import { and, between, edge as edgeQuery, equals, type Query } from "./query.js";
import type { ObjectStoreApi, OrderedCursor } from "./store.js";
import { answeredByPostings, parseSearchQuery, toPlanQuery, type ParsedSearchQuery, damerauLevenshtein } from "./search-parser.js";

import { METRICS, describeFields, edgeTypeFor, measureColumnFor } from "./document-definitions.js";
import { COARSE_SENTINEL, geometryAt, synonymsOf, tokenize } from "./document-indexing.js";
import { type Analyzer, type Collection, type Document, type DocumentCursor, type DocumentFilter, type EmbeddingIndex, type FindDocumentsInput, type GroupedSummary, type LinkFilter, type MeasureDefinition, type MeasureOperation, type RelatedDocuments, type RelatedFilter, type SearchStatistics, type SimilarFilter, type SpatialFilter, type SpatialIndex, type TraverseStep, collectionModalities } from "./document-model.js";
import {
  type IndexedOrder,
  type PageShape,
  type Placed,
  type Plan,
  type Position,
  type Sort,
  chooseIndex,
  compareDocuments,
  countPhraseMatches,
  equalityBindings,
  generateHighlights,
  matches,
  normalizeSorts,
  planQuery,
  requireColumns,
  withCells,
  withSearch,
} from "./document-planner.js";
import { COLLECTION_MARKER, type StoredCollection, cellFieldFor, collectionColumn, collectionRecord, columnFor, decode, documentNs, pairFieldFor, publicCollection, readPath, textFieldFor } from "./document-records.js";
import type { DocumentCore } from "./document-core.js";
import type { DocumentsApi } from "./document-model.js";
import { readHybridSearch, readSearchStatistics } from "./search-options.js";

/** What BM25 needs from one document: its analyzed length and the query terms it holds. */
const textEvidence = (document: Document, parsed: ParsedSearchQuery, analyzer: Analyzer) => {
  const { terms, scoredPhrases } = parsed;
  const expansions = new Map(terms.map((qTerm) => [qTerm.token, synonymsOf(qTerm.token, analyzer)] as const));
  let docLength = 0;
  const termCounts = new Map<string, number>();
  let phraseOccurrences = 0;
  let adjacentPairs = 0;
  for (const field of analyzer.fields) {
    const val = readPath(document.data, field);
    if (typeof val !== "string") continue;
    const tokens = tokenize(val, analyzer);
    docLength += tokens.length;
    for (const token of tokens) {
      for (const qTerm of terms) {
        if (qTerm.field !== undefined && qTerm.field !== field) continue;
        if (qTerm.kind === "exact" && expansions.get(qTerm.token)!.includes(token)) {
          termCounts.set(qTerm.token, (termCounts.get(qTerm.token) ?? 0) + 1);
        } else if (qTerm.kind === "prefix" && token.startsWith(qTerm.token)) {
          termCounts.set(qTerm.token, (termCounts.get(qTerm.token) ?? 0) + 0.95);
        } else if (qTerm.kind === "fuzzy") {
          const dist = damerauLevenshtein(token, qTerm.token, qTerm.fuzzyDistance ?? 2);
          if (dist <= (qTerm.fuzzyDistance ?? 2)) {
            const weight = dist === 0 ? 1 : Math.max(0.4, 1 - dist * 0.2);
            termCounts.set(qTerm.token, (termCounts.get(qTerm.token) ?? 0) + weight);
          }
        }
      }
    }
    for (const phrase of (scoredPhrases ?? [])) {
      if (phrase.field !== undefined && phrase.field !== field) continue;
      phraseOccurrences += countPhraseMatches(tokens, phrase.tokens);
    }
    if (terms.length > 1) {
      const termTokens = terms.map((t) => t.token);
      for (let i = 0; i < tokens.length - 1; i++) {
        const t1 = tokens[i]!;
        const t2 = tokens[i + 1]!;
        if (termTokens.includes(t1) && termTokens.includes(t2) && t1 !== t2) adjacentPairs += 1;
      }
    }
  }
  return { docLength, termCounts, phraseOccurrences, adjacentPairs };
};

/** The corpus statistics of a set of matches; see `SearchStatistics`. */
const statisticsOf = (
  evidence: ReadonlyArray<{ readonly docLength: number; readonly termCounts: ReadonlyMap<string, number> }>,
  terms: ParsedSearchQuery["terms"],
): SearchStatistics => {
  const frequencies: Record<string, number> = {};
  for (const qTerm of terms) {
    frequencies[qTerm.token] = evidence.filter((c) => (c.termCounts.get(qTerm.token) ?? 0) > 0).length;
  }
  return { documents: evidence.length, length: evidence.reduce((total, c) => total + c.docLength, 0), frequencies };
};

/** The first `depth` of a ranking, by id, with each document's place in it from one. */
const ranks = (documents: ReadonlyArray<Document>, depth: number): ReadonlyMap<string, { rank: number; document: Document }> =>
  new Map(documents.slice(0, depth).map((document, at) => [document.id, { rank: at + 1, document }]));

/** A pure calculation that refuses with `InvalidMeasureQuery`; anything else it throws is a defect. */
const calculateMeasure = <A>(run: () => A): Effect.Effect<A, InvalidMeasureQuery> => Effect.suspend(() => {
  try {
    return Effect.succeed(run());
  } catch (cause) {
    return cause instanceof InvalidMeasureQuery ? Effect.fail(cause) : Effect.die(cause);
  }
});

export const documentReads = (core: DocumentCore) => {
  const {
    store, tenant, lookup, readObject, resolveQuery, termsOf, projectionIndexes, loadCollection,
    requireCollection, readDocument,
  } = core;
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
      const column = columnFor(collection, sort.path);
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
   * Matching documents in identifier order, the order `resolve` already has.
   *
   * Read from the cursor and only until the page is full: the store resolves
   * a window of identifiers at a time, so a page deep into a large collection
   * costs about the page rather than everything before and after it.
   */
  const inIdentifierOrder = (plan: Plan, collection: string, take: number, from: Position | undefined) =>
    Effect.gen(function* () {
      const keep = keeps(plan);
      const after = from?.phase === "seq" ? from.seq : undefined;
      const out: Array<Placed> = [];
      if (take <= 0) return out;
      yield* Stream.runForEachWhile(
        resolveQuery(plan.query, {
          within: equals(collectionColumn(), collection),
          ...(after === undefined ? {} : { after: asSeq(after) }),
        }),
        (seq) =>
          Effect.gen(function* () {
            const doc = yield* readDocument(seq);
            if (keep(doc)) out.push({ document: doc, position: { phase: "seq", seq: Number(seq) } });
            return out.length < take;
          }),
      );
      return out;
    });

  /** Matching documents in distance order from a query point. */
  const inDistanceOrder = (
    plan: Plan,
    collection: string,
    filter: Extract<SpatialFilter, { near: GeoPosition }>,
    take: number,
    from: Position | undefined,
  ) =>
    Effect.gen(function* () {
      const keep = keeps(plan);
      const candidates: Array<{ document: Document; seq: number; distance: number }> = [];
      for (const seq of yield* Stream.runCollect(resolveQuery(plan.query))) {
        const doc = yield* readDocument(seq);
        if (doc && keep(doc)) {
          const docGeo = geometryAt(doc.data, filter.field);
          const dist = docGeo !== undefined
            ? Math.round(distanceToGeometry(filter.near, docGeo) * 100) / 100
            : Number.POSITIVE_INFINITY;
          candidates.push({
            document: { ...doc, distance: dist },
            seq: Number(seq),
            distance: dist,
          });
        }
      }
      candidates.sort((a, b) => a.distance - b.distance || a.seq - b.seq);

      const after = from?.phase === "distance"
        ? { distance: from.distance, seq: from.seq }
        : undefined;

      const out: Array<Placed> = [];
      for (const entry of candidates) {
        if (after !== undefined) {
          if (entry.distance < after.distance) continue;
          if (entry.distance === after.distance && entry.seq <= after.seq) continue;
        }
        out.push({
          document: entry.document,
          position: { phase: "distance", distance: entry.distance, seq: entry.seq },
        });
        if (out.length >= take) break;
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
      const { phase, seq, cursor: inner, distance, score } = p as Record<string, unknown>;
      if (shape.order.length === 0) {
        if (phase === "seq" && typeof seq === "number") return { phase, seq };
        if (phase === "distance" && typeof distance === "number" && typeof seq === "number") {
          return { phase, distance, seq };
        }
        if (phase === "score" && typeof score === "number" && typeof seq === "number") {
          return { phase, score, seq };
        }
      } else if (phase === "rest" && typeof seq === "number" && shape.via === undefined) {
        return { phase, seq };
      } else if (phase === "values" && typeof inner === "string") {
        return { phase, cursor: inner as OrderedCursor };
      }
      return yield* malformed;
    });

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
    UnknownReference | UnanalyzedCollection | UnindexedGeometry | UnindexedField
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
          const seq = yield* lookup(documentNs(reference.collection), clause.id);
          const target = seq === undefined ? undefined : yield* readDocument(seq);
          const matching = target !== undefined &&
            (clause.where ?? []).every((filter) => matches(target.data, filter));
          ids = matching ? [clause.id] : [];
        } else {
          // This sub-query is built right here and carries no `similar`
          // clause, so the two failures a similarity read can produce cannot
          // arise; a related clause should not advertise them.
          const targets = yield* findDocuments({
            collection: reference.collection,
            ...(clause.where === undefined ? {} : { where: clause.where }),
          }).pipe(Effect.catchTags({
            UnembeddedCollection: Effect.die,
            InvalidVectorQuery: Effect.die,
            UnknownEdge: Effect.die,
          }));
          ids = targets.map((target) => target.id);
        }
        if (ids.length === 0) return undefined;
        filters.push({ path: reference.path, op: "in", value: ids });
      }
      return filters;
    });


  /**
   * What a search becomes: the query compiled into postings constraints and residual filters.
   */
  const searchQuery = (
    analyzer: Analyzer | undefined,
    collection: string,
    text: string,
    options?: { fuzzy?: boolean | number; prefix?: boolean },
  ): Effect.Effect<
    { readonly query: Query | undefined; readonly parsed: ParsedSearchQuery; readonly exact: boolean } | undefined,
    UnanalyzedCollection
  > =>
    Effect.gen(function* () {
      if (analyzer === undefined) {
        return yield* new UnanalyzedCollection({ collection });
      }
      const parsed = parseSearchQuery(text, analyzer, tokenize, options);
      if (parsed === undefined) return undefined;

      const query = yield* Effect.orDie(toPlanQuery(parsed.root, analyzer, {
        fieldFor: (path) => textFieldFor(collection, path),
        pairFieldFor: (path) => pairFieldFor(collection, path),
        expand: (token) => synonymsOf(token, analyzer),
        termsOf,
      }));
      return { query, parsed, exact: answeredByPostings(parsed.root, analyzer) };
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
  /** The embedding this read compares against, or why it cannot be used. */
  const embeddingFor = (
    collection: StoredCollection | undefined,
    name: string,
    filter: SimilarFilter,
  ): Effect.Effect<EmbeddingIndex, UnembeddedCollection | InvalidVectorQuery> =>
    Effect.gen(function* () {
      const embedding = collection?.embedding;
      if (embedding === undefined || embedding.field !== filter.field) {
        return yield* new UnembeddedCollection({ collection: name });
      }
      if (filter.metric !== undefined && !METRICS.has(filter.metric)) {
        return yield* new InvalidVectorQuery({
          collection: name,
          field: filter.field,
          reason: `metric override is one of ${[...METRICS].join(", ")}, not ${String(filter.metric)}`,
        });
      }
      const wrong = !Array.isArray(filter.vector)
        ? "the query is not a vector"
        : filter.vector.length !== embedding.dimension
          ? `the query holds ${filter.vector.length} numbers, not the ${embedding.dimension} declared`
          : !isUsableVector(filter.vector)
            ? "the query holds a value that is not a finite number"
            : undefined;
      if (wrong !== undefined) {
        return yield* new InvalidVectorQuery({ collection: name, field: filter.field, reason: wrong });
      }
      return embedding;
    });

  /**
   * A plan narrowed to what one document links to (outbound) or what links to
   * it (inbound), or undefined when there is nothing to link from -- an absent
   * document has no links, which is an empty answer rather than a failure.
   */
  const withLink = (
    plan: Plan,
    filter: LinkFilter,
    currentCollection: string,
  ): Effect.Effect<Plan | undefined, UnknownEdge> =>
    Effect.gen(function* () {
      const direction = filter.direction ?? "outbound";
      let declaringCollection = filter.collection ?? currentCollection;
      let colRecord = yield* loadCollection(declaringCollection);
      let declared = (colRecord?.edges ?? []).find((candidate) => candidate.name === filter.edge);

      if (declared === undefined && direction === "inbound" && filter.collection !== undefined) {
        const queryCol = yield* loadCollection(currentCollection);
        const queryDeclared = (queryCol?.edges ?? []).find(
          (candidate) => candidate.name === filter.edge && candidate.collection === filter.collection,
        );
        if (queryDeclared !== undefined) {
          declaringCollection = currentCollection;
          declared = queryDeclared;
        }
      }

      if (declared === undefined) {
        return yield* new UnknownEdge({ collection: declaringCollection, name: filter.edge });
      }

      const targetNsCollection = direction === "inbound" ? declared.collection : declaringCollection;
      const seq = yield* lookup(documentNs(targetNsCollection), filter.id);
      if (seq === undefined) return undefined;
      const clause = edgeQuery(edgeTypeFor(declaringCollection, filter.edge), Number(seq), direction);
      return {
        query: and(plan.query, clause),
        fields: plan.fields === undefined ? clause : and(plan.fields, clause),
        residual: plan.residual,
      };
    });

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
      return withCells(plan, cellFieldFor(name, filter.field), spatialCells(h3, spatial, filter), exact);
    });

  const rebuildIndex = (collectionName: string, embedding: EmbeddingIndex) =>
    Effect.gen(function* () {
      const usearch = yield* Effect.orDie(loadUsearch);
      const index = createProjectionIndex(usearch, {
        dimensions: embedding.dimension,
        metric: embedding.metric,
        quantization: embedding.quantization,
      });
      const unit = embedding.normalize === true;
      let indexed = 0;
      for (const seq of yield* Stream.runCollect(resolveQuery(equals(collectionColumn(), collectionName)))) {
        const doc = yield* readDocument(seq);
        if (doc === undefined) continue;
        const held = readPath(doc.data, embedding.field);
        if (isUsableVector(held) && held.length === embedding.dimension) {
          index.add(Number(seq), unit ? normalized(held) : held);
          indexed += 1;
        }
      }
      projectionIndexes.set(collectionName, index);
      return { indexed };
    });

  /** Matching documents in similarity order from a query vector. */
  const inSimilarityOrder = (
    plan: Plan,
    collectionName: string,
    filter: SimilarFilter,
    take: number,
    from: Position | undefined,
  ) =>
    Effect.gen(function* () {
      const collection = yield* loadCollection(collectionName);
      const embedding = yield* embeddingFor(collection, collectionName, filter);
      const metric = filter.metric ?? embedding.metric;
      const unit = embedding.normalize === true;
      const query = unit ? normalized(filter.vector) : filter.vector;
      const keep = keeps(plan);

      let projIndex = projectionIndexes.get(collectionName);
      if (projIndex === undefined && filter.approximate === true) {
        yield* rebuildIndex(collectionName, embedding);
        projIndex = projectionIndexes.get(collectionName);
      }

      const candidates: Array<{ document: Document; seq: number; score: number }> = [];

      if (
        filter.approximate !== false &&
        projIndex !== undefined &&
        projIndex.metric === metric &&
        plan.fields === undefined &&
        plan.residual.length === 0
      ) {
        const limitK = Math.min(projIndex.size(), Math.max(filter.k ?? take, take * 4, 200));
        const matches = projIndex.search(query, limitK);
        for (const match of matches) {
          const doc = yield* readDocument(match.seq as Seq);
          if (doc && keep(doc)) {
            const held = readPath(doc.data, embedding.field);
            if (isUsableVector(held) && held.length === embedding.dimension) {
              const exactScore = similarity(query, unit ? normalized(held) : held, metric).score;
              candidates.push({
                document: { ...doc, score: exactScore },
                seq: match.seq,
                score: exactScore,
              });
            }
          }
        }
      } else {
        for (const seq of yield* Stream.runCollect(resolveQuery(plan.query))) {
          const doc = yield* readDocument(seq);
          if (doc && keep(doc)) {
            const held = readPath(doc.data, embedding.field);
            if (isUsableVector(held) && held.length === embedding.dimension) {
              const score = similarity(query, unit ? normalized(held) : held, metric).score;
              candidates.push({
                document: { ...doc, score },
                seq: Number(seq),
                score,
              });
            }
          }
        }
      }

      candidates.sort((a, b) => b.score - a.score || a.seq - b.seq);

      const after = from?.phase === "score"
        ? { score: from.score, seq: from.seq }
        : undefined;

      const out: Array<Placed> = [];
      for (const entry of candidates) {
        if (after !== undefined) {
          if (entry.score > after.score) continue;
          if (entry.score === after.score && entry.seq <= after.seq) continue;
        }
        out.push({
          document: entry.document,
          position: { phase: "score", score: entry.score, seq: entry.seq },
        });
        if (out.length >= take) break;
      }
      return out;
    });

  const measureOf = (column: string) => Effect.orDie(store.measure(column));

  /**
   * What an operation makes of the values it was given.
   *
   * Spread is population, not sample: these are the values the window holds,
   * not a sample drawn from a larger set, so dividing by n is what the numbers
   * mean. Min and max fold rather than spreading into `Math.min`, which throws
   * on an argument list the size of a collection.
   */
  const foldMeasure = (op: MeasureOperation, values: ReadonlyArray<number>): number => {
    if (op === "count") return values.length;
    if (values.length === 0) return 0;
    if (op === "countDistinct") return new Set(values).size;
    if (op === "min" || op === "max") {
      let held = values[0]!;
      for (const value of values) {
        if (op === "min" ? value < held : value > held) held = value;
      }
      return held;
    }
    let total = 0;
    for (const value of values) total += value;
    if (op === "sum") return total;
    const mean = total / values.length;
    if (op === "avg") return mean;
    let squares = 0;
    for (const value of values) squares += (value - mean) * (value - mean);
    const variance = squares / values.length;
    return op === "variance" ? variance : Math.sqrt(variance);
  };

  /** Every finite number in a column: what having a value for a measure means. */
  const hasNumber = (column: string) => between(column, -Number.MAX_VALUE, Number.MAX_VALUE);

  const declaredMeasure = (
    collection: StoredCollection | undefined,
    name: string,
    measure: string,
  ): Effect.Effect<MeasureDefinition, UnknownMeasure> => {
    const found = (collection?.measures ?? []).find((candidate) => candidate.name === measure);
    return found === undefined
      ? Effect.fail(new UnknownMeasure({ collection: name, name: measure }))
      : Effect.succeed(found);
  };

  /**
   * What the filtering clauses of a read come to, or undefined when nothing can
   * match and the collection is never touched.
   *
   * Shared, because a read that filters and a read that aggregates have to
   * narrow the same way: an aggregate that understood `linked` differently from
   * `findMany` would answer a different question in the same words. The merged
   * `where` comes back too, because choosing an index needs the equality
   * bindings and not only the plan.
   */
  const planFor = (
    collection: StoredCollection | undefined,
    input: {
      readonly collection: string;
      readonly where?: ReadonlyArray<DocumentFilter>;
      readonly related?: ReadonlyArray<RelatedFilter>;
      readonly search?: string;
      readonly fuzzy?: boolean | number;
      readonly prefix?: boolean;
      readonly geometry?: SpatialFilter;
      readonly linked?: LinkFilter;
    },
  ): Effect.Effect<
    {
      readonly plan: Plan;
      readonly where: ReadonlyArray<DocumentFilter>;
      readonly words?: { readonly query: Query | undefined; readonly parsed: ParsedSearchQuery };
    } | undefined,
    UnknownReference | UnanalyzedCollection | UnindexedGeometry | UnknownEdge | UnindexedField
  > =>
    Effect.gen(function* () {
      const related = yield* relatedFilters(collection, input.collection, input.related);
      if (related === undefined) return undefined;
      const where = [...(input.where ?? []), ...related];
      yield* requireColumns(collection, input.collection, where);
      const words = input.search === undefined
        ? undefined
        : yield* searchQuery(collection?.analyzer, input.collection, input.search, {
            fuzzy: input.fuzzy,
            prefix: input.prefix,
          });
      if (input.search !== undefined && words === undefined) return undefined;
      let plan = withSearch(planQuery(input.collection, where), words?.query);
      // Checked on each document only when the postings cannot decide it.
      if (words !== undefined && collection?.analyzer !== undefined && !words.exact) {
        plan = {
          ...plan,
          residual: [
            ...plan.residual,
            {
              path: "*search",
              op: "search",
              value: { root: words.parsed.root, analyzer: collection.analyzer } as unknown as Json,
            },
          ],
        };
      }
      if (input.geometry !== undefined) {
        plan = yield* withGeometry(collection, input.collection, plan, input.geometry);
      }
      if (input.linked !== undefined) {
        const narrowed = yield* withLink(plan, input.linked, input.collection);
        if (narrowed === undefined) return undefined;
        plan = narrowed;
      }
      return { plan, where, ...(words !== undefined ? { words } : {}) };
    });

  /** A plan narrowed to the documents that have a value for this measure. */
  const overMeasure = (plan: Plan, column: string): Plan => ({
    query: and(plan.query, hasNumber(column)),
    fields: plan.fields === undefined ? hasNumber(column) : and(plan.fields, hasNumber(column)),
    residual: plan.residual,
  });

  /**
   * The identifiers a plan admits, with the residual filters applied.
   *
   * The residual costs a document read each, which is the one case an aggregate
   * touches payloads: a filter the lenses cannot answer has to be decided on the
   * document itself.
   */
  const identifiersFor = (plan: Plan) =>
    Effect.gen(function* () {
      const keep = keeps(plan);
      const out: Array<number> = [];
      for (const seq of yield* Stream.runCollect(resolveQuery(plan.query))) {
        if (plan.residual.length > 0) {
          const doc = yield* readDocument(seq);
          if (!keep(doc)) continue;
        }
        out.push(Number(seq));
      }
      return out;
    });

  /**
   * Words and a vector together: each ranking drawn on its own from what
   * `where` admits, then fused by reciprocal rank (see `HybridSearch`). Ranks,
   * not scores, are fused, because a BM25 score and a similarity are on scales
   * nothing relates.
   */
  const hybridSearch = (input: FindDocumentsInput, similar: SimilarFilter) =>
    Effect.gen(function* () {
      if (normalizeSorts(input.orderBy).length > 0) {
        return yield* Effect.die(new RangeError("a hybrid read is ranked by fusion, so it cannot also be ordered by a field."));
      }
      const { text: textWeight = 1, vector: vectorWeight = 1, k = 60, depth = 100 } = readHybridSearch(input.hybrid ?? {});
      const { hybrid: _hybrid, similar: _similar, limit, offset = 0, ...rest } = input;
      const text = ranks(yield* findDocuments({ ...rest, limit: depth }), depth);
      const { search: _search, fuzzy: _fuzzy, prefix: _prefix, highlight: _highlight, statistics: _statistics, ...structured } = rest;
      const vector = ranks(yield* findDocuments({ ...structured, similar: { ...similar, k: depth } }), depth);
      const fused = [...new Set([...text.keys(), ...vector.keys()])].map((id) => {
        const t = text.get(id), v = vector.get(id);
        const score = (t === undefined ? 0 : textWeight / (k + t.rank)) + (v === undefined ? 0 : vectorWeight / (k + v.rank));
        return { id, score, t: t?.rank ?? Infinity, v: v?.rank ?? Infinity, document: (t ?? v)!.document };
      });
      // Equal fused scores go to the better text rank, then the better vector
      // rank, then the id: an order that is the same on every host.
      fused.sort((a, b) => b.score - a.score || a.t - b.t || a.v - b.v || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const window = limit === undefined ? fused.slice(offset) : fused.slice(offset, offset + limit);
      return window.map((entry) => ({ ...entry.document, score: entry.score }));
    });

  const findDocuments = (
    input: FindDocumentsInput,
  ): Effect.Effect<
    ReadonlyArray<Document>,
    UnknownReference | UnanalyzedCollection | UnindexedGeometry | UnembeddedCollection
    | InvalidVectorQuery | UnknownEdge | UnindexedField
  > =>
    Effect.gen(function* () {
      if (input.similar !== undefined && input.search !== undefined) return yield* hybridSearch(input, input.similar);
      const collection = yield* loadCollection(input.collection);
      const planned = yield* planFor(collection, input);
      if (planned === undefined) return [];
      const where = planned.where;
      let plan = planned.plan;
      const offset = input.offset ?? 0;
      const take = input.limit === undefined ? undefined : offset + input.limit;
      const slice = (docs: ReadonlyArray<Document>) =>
        input.limit === undefined ? docs.slice(offset) : docs.slice(offset, offset + input.limit);
      const sorts = normalizeSorts(input.orderBy);
      if (input.similar !== undefined) {
        const wanted = input.similar;
        if (sorts.length > 0) {
          return yield* Effect.die(new RangeError(
            "a similarity read comes back closest first, so it cannot also be ordered by a field.",
          ));
        }
        const k = wanted.k ?? input.limit ?? 10;
        if (!Number.isInteger(k) || k < 1) {
          return yield* Effect.die(new RangeError(
            `a similarity read returns a whole number of documents from one, not ${k}.`,
          ));
        }
        const embedding = yield* embeddingFor(collection, input.collection, wanted);
        const metric = wanted.metric ?? embedding.metric;
        // Unit length is a property of the comparison, not of the stored data:
        // the document keeps the vector it was given either way.
        const unit = embedding.normalize === true;
        const query = unit ? normalized(wanted.vector) : wanted.vector;
        const keep = keeps(plan);

        let projIndex = projectionIndexes.get(input.collection);
        if (projIndex === undefined && wanted.approximate === true) {
          yield* rebuildIndex(input.collection, embedding);
          projIndex = projectionIndexes.get(input.collection);
        }

        const scored: Array<{ document: Document; seq: number; score: number }> = [];

        if (
          wanted.approximate !== false &&
          projIndex !== undefined &&
          projIndex.metric === metric &&
          plan.fields === undefined &&
          plan.residual.length === 0
        ) {
          const limitK = Math.min(projIndex.size(), Math.max(k, 100));
          const matches = projIndex.search(query, limitK);
          for (const match of matches) {
            const doc = yield* readDocument(match.seq as Seq);
            if (doc && keep(doc)) {
              const held = readPath(doc.data, embedding.field);
              if (isUsableVector(held) && held.length === embedding.dimension) {
                const score = similarity(query, unit ? normalized(held) : held, metric).score;
                scored.push({
                  document: { ...doc, score },
                  seq: match.seq,
                  score,
                });
              }
            }
          }
        } else {
          for (const seq of yield* Stream.runCollect(resolveQuery(plan.query))) {
            const doc = yield* readDocument(seq);
            if (!keep(doc)) continue;
            const held = readPath(doc.data, embedding.field);
            // A document without a usable vector is not an answer, and not an
            // error either: `embed` is what refuses one that has the wrong shape.
            if (!isUsableVector(held) || held.length !== embedding.dimension) continue;
            const score = similarity(query, unit ? normalized(held) : held, metric).score;
            scored.push({
              document: { ...doc, score },
              seq: Number(seq),
              score,
            });
          }
        }
        scored.sort((a, b) => b.score - a.score || a.seq - b.seq);
        return slice(scored.slice(0, k).map((entry) => entry.document));
      }
      const attachDistance = (doc: Document): Document => {
        if (input.geometry === undefined || !("near" in input.geometry) || doc.distance !== undefined) {
          return doc;
        }
        const docGeo = geometryAt(doc.data, input.geometry.field);
        if (docGeo === undefined) return doc;
        return {
          ...doc,
          distance: Math.round(distanceToGeometry(input.geometry.near, docGeo) * 100) / 100,
        };
      };
      if (sorts.length > 0) {
        const isDynamicSort = sorts.some(
          (s) => s.path === "$distance" || s.path === "distance" || s.path === "$score" || s.path === "score",
        );
        if (!isDynamicSort) {
          const indexed = chooseIndex(collection?.indexes ?? [], sorts, equalityBindings(where));
          if (indexed !== undefined) {
            const found = yield* inIndexOrder(plan, indexed, take, undefined).pipe(Effect.orDie);
            return slice(found.map((entry) => attachDistance(entry.document)));
          }
          if (sorts.length === 1) {
            yield* requireColumns(collection, input.collection, [], { sorts, indexed: false });
            // One field is served by its ordered lens, in order, without a sort.
            const found = yield* inOrder(plan, input.collection, sorts[0]!, take, undefined).pipe(Effect.orDie);
            return slice(found.map((entry) => attachDistance(entry.document)));
          }
        }
      }
      const keep = keeps(plan);
      const candidates: Array<{ document: Document; seq: number }> = [];
      // Nothing to rank and nothing to sort: identifier order is the answer,
      // so reading stops once the requested slice is in hand.
      const enough = planned.words === undefined && sorts.length === 0 ? take : undefined;
      if (enough === undefined) {
        for (const seq of yield* Stream.runCollect(resolveQuery(plan.query))) {
          const doc = yield* readDocument(seq);
          if (doc && keep(doc)) candidates.push({ document: attachDistance(doc), seq: Number(seq) });
        }
      } else if (enough > 0) {
        // Every match is one of the collection's documents, whose own postings
        // can drive a filter that has no windowed form of its own.
        yield* Stream.runForEachWhile(resolveQuery(plan.query, { within: equals(collectionColumn(), input.collection) }), (seq) =>
          Effect.gen(function* () {
            const doc = yield* readDocument(seq);
            if (doc && keep(doc)) candidates.push({ document: attachDistance(doc), seq: Number(seq) });
            return candidates.length < enough;
          }));
      }

      if (planned.words !== undefined && collection?.analyzer !== undefined && planned.words.parsed.terms.length > 0) {
        const analyzer = collection.analyzer;
        const { terms } = planned.words.parsed;

        const scoredCandidates = candidates.map((item) => ({
          ...textEvidence(item.document, planned.words!.parsed, analyzer), document: item.document, seq: item.seq,
        }));
        // The corpus a score is relative to: the matches here, unless the
        // caller supplies a wider one so that scores from several partitions
        // compare (`statistics`, summed from each one's `searchStatistics`).
        const corpus = input.statistics === undefined
          ? statisticsOf(scoredCandidates, terms) : readSearchStatistics(input.statistics);
        const N = corpus.documents;
        const avgdl = N > 0 ? corpus.length / N : 1;
        const k1 = 1.2;
        const b = 0.75;

        const idf = new Map<string, number>();
        for (const qTerm of terms) {
          const docCount = Object.hasOwn(corpus.frequencies, qTerm.token) ? corpus.frequencies[qTerm.token]! : 0;
          idf.set(qTerm.token, Math.log(1 + (N - docCount + 0.5) / (docCount + 0.5)));
        }

        const scoredDocs: Array<{ document: Document; seq: number }> = [];
        for (const c of scoredCandidates) {
          let bm25 = 0;
          for (const qTerm of terms) {
            const tf = c.termCounts.get(qTerm.token) ?? 0;
            if (tf > 0) {
              const termIdf = idf.get(qTerm.token) ?? 0;
              const denom = tf + k1 * (1 - b + (b * (avgdl > 0 ? c.docLength / avgdl : 1)));
              const tfScore = denom > 0 ? (tf * (k1 + 1)) / denom : 0;
              bm25 += termIdf * tfScore;
            }
          }
          const phraseBoost = c.phraseOccurrences * 2.0;
          const proximityBoost = c.adjacentPairs * 0.5;
          const totalScore = Math.round((bm25 + phraseBoost + proximityBoost) * 10000) / 10000;
          scoredDocs.push({
            document: {
              ...c.document,
              score: totalScore,
            },
            seq: c.seq,
          });
        }

        const highlightOpts = typeof input.highlight === "object" ? input.highlight : {};
        const attachHighlights = (doc: Document): Document => {
          if (!input.highlight || planned.words === undefined || collection?.analyzer === undefined) {
            return doc;
          }
          const hl = generateHighlights(doc.data, collection.analyzer, planned.words.parsed, highlightOpts);
          return Object.keys(hl).length > 0 ? { ...doc, highlights: hl } : doc;
        };

        if (sorts.length === 0) {
          scoredDocs.sort((a, b) => (b.document.score ?? 0) - (a.document.score ?? 0) || a.seq - b.seq);
          return slice(scoredDocs.map((item) => attachHighlights(item.document)));
        }
        const docs = scoredDocs.map((item) => attachHighlights(item.document));
        return slice(docs.sort(compareDocuments(sorts)));
      }

      if (sorts.length === 0 && input.geometry && "near" in input.geometry) {
        candidates.sort(
          (a, b) => (a.document.distance ?? Number.POSITIVE_INFINITY) - (b.document.distance ?? Number.POSITIVE_INFINITY) ||
            a.seq - b.seq,
        );
        return slice(candidates.map((c) => c.document));
      }

      const docs = candidates.map((c) => c.document);
      // No index serves these fields, so they are sorted here — in the
      // lens's order, so the answer matches what an index would give.
      return slice(sorts.length === 0 ? docs : docs.sort(compareDocuments(sorts)));
    });

  const operations = {
    count: (input) =>
      Effect.gen(function* () {
        yield* requireCollection(input.collection);
        return yield* Effect.orDie(store.namespaceSize(documentNs(input.collection)));
      }),
    modalities: (input) => Effect.map(requireCollection(input.collection), collectionModalities),
    listCollections: Effect.gen(function* () {
      const seqs = yield* Stream.runCollect(
        resolveQuery(equals(collectionColumn(), COLLECTION_MARKER)),
      );
      const out: Collection[] = [];
      for (const seq of seqs) {
        const object = yield* readObject(seq);
        if (object !== undefined) out.push(publicCollection(decode(object.bytes, collectionRecord)));
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    }),

    collectionExists: (name) => Effect.map(loadCollection(name), (c) => c !== undefined),

    findById: (input) =>
      Effect.gen(function* () {
        const seq = yield* lookup(documentNs(input.collection), input.id);
        return seq === undefined ? undefined : yield* readDocument(seq);
      }),

    findMany: (input) => findDocuments(input),

    searchStatistics: (input) =>
      Effect.gen(function* () {
        const collection = yield* loadCollection(input.collection);
        const analyzer = collection?.analyzer;
        if (analyzer === undefined) return yield* new UnanalyzedCollection({ collection: input.collection });
        const { limit: _limit, offset: _offset, orderBy: _orderBy, similar: _similar, hybrid: _hybrid,
          statistics: _statistics, highlight: _highlight, ...matching } = input;
        const parsed = parseSearchQuery(input.search, analyzer, tokenize, { fuzzy: input.fuzzy, prefix: input.prefix });
        if (parsed === undefined) return { documents: 0, length: 0, frequencies: {} } satisfies SearchStatistics;
        const documents = yield* findDocuments(matching);
        return statisticsOf(documents.map((document) => textEvidence(document, parsed, analyzer)), parsed.terms);
      }),

    findPage: (input) =>
      Effect.gen(function* () {
        const sorts = normalizeSorts(input.orderBy);
        const collection = yield* loadCollection(input.collection);
        const related = yield* relatedFilters(collection, input.collection, input.related);
        const where = related === undefined ? [] : [...(input.where ?? []), ...related];
        const words = input.search === undefined
          ? undefined
          : yield* searchQuery(collection?.analyzer, input.collection, input.search, {
              fuzzy: input.fuzzy,
              prefix: input.prefix,
            });
        const geometry = input.geometry;
        const indexed = sorts.length === 0
          ? undefined
          : chooseIndex(collection?.indexes ?? [], sorts, equalityBindings(where));
        yield* requireColumns(collection, input.collection, where, { sorts, indexed: indexed !== undefined });
        if (input.similar !== undefined && sorts.length > 0) {
          return yield* Effect.die(new RangeError(
            "a similarity read comes back closest first, so it cannot also be ordered by a field.",
          ));
        }
        if (sorts.length > 1 && indexed === undefined) {
          return yield* new UnsupportedOrdering({
            reason:
              `a page ordered by ${describeFields(sorts)} needs a composite index over those ` +
              "fields in that order, or in exactly the reverse one; create it with createIndex, " +
              "or use findMany",
          });
        }
        const limit = input.limit ?? input.similar?.k ?? 50;
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
        let plan = withSearch(planQuery(input.collection, where), words?.query);
        if (words !== undefined && collection?.analyzer !== undefined) {
          plan = {
            ...plan,
            residual: [
              ...plan.residual,
              {
                path: "*search",
                op: "search",
                value: { root: words.parsed.root, analyzer: collection.analyzer } as unknown as Json,
              },
            ],
          };
        }
        if (geometry !== undefined) {
          plan = yield* withGeometry(collection, input.collection, plan, geometry);
        }
        if (input.linked !== undefined) {
          const narrowed = yield* withLink(plan, input.linked, input.collection);
          if (narrowed === undefined) return { documents: [] };
          plan = narrowed;
        }
        const attachDistance = (doc: Document): Document => {
          if (geometry === undefined || !("near" in geometry) || doc.distance !== undefined) {
            return doc;
          }
          const docGeo = geometryAt(doc.data, geometry.field);
          if (docGeo === undefined) return doc;
          return {
            ...doc,
            distance: Math.round(distanceToGeometry(geometry.near, docGeo) * 100) / 100,
          };
        };
        // One more than the page, to know whether another document follows.
        const found = input.similar !== undefined
          ? yield* inSimilarityOrder(plan, input.collection, input.similar, limit + 1, from)
          : sorts.length === 0
            ? (geometry !== undefined && "near" in geometry
                ? yield* inDistanceOrder(plan, input.collection, geometry, limit + 1, from)
                : yield* inIdentifierOrder(plan, input.collection, limit + 1, from))
            : indexed !== undefined
              ? yield* inIndexOrder(plan, indexed, limit + 1, from)
              : yield* inOrder(plan, input.collection, sorts[0]!, limit + 1, from);
        const highlightOpts = typeof input.highlight === "object" ? input.highlight : {};
        const attachHighlights = (doc: Document): Document => {
          if (!input.highlight || words === undefined || collection?.analyzer === undefined) {
            return doc;
          }
          const hl = generateHighlights(doc.data, collection.analyzer, words.parsed, highlightOpts);
          return Object.keys(hl).length > 0 ? { ...doc, highlights: hl } : doc;
        };
        const page = found.slice(0, limit);
        return {
          documents: page.map((entry) => attachHighlights(attachDistance(entry.document))),
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
              const seq = yield* lookup(documentNs(reference.collection), value);
              seen.set(at, seq === undefined ? undefined : yield* readDocument(seq));
            }
            related[reference.name] = seen.get(at);
          }
          out.push({ document, related });
        }
        return out;
      }),

    traverse: (input) =>
      Effect.gen(function* () {
        let declaringCollection = input.edgeCollection ?? input.collection;
        let colRecord = yield* loadCollection(declaringCollection);
        let declared = (colRecord?.edges ?? []).find((candidate) => candidate.name === input.edge);

        if (declared === undefined && input.edgeCollection === undefined) {
          const startCol = yield* loadCollection(input.collection);
          const startDeclared = (startCol?.edges ?? []).find((candidate) => candidate.name === input.edge);
          if (startDeclared !== undefined) {
            declaringCollection = input.collection;
            declared = startDeclared;
          }
        }

        if (declared === undefined) {
          return yield* new UnknownEdge({ collection: declaringCollection, name: input.edge });
        }

        const targetCollection = declared.collection;
        const maxDepth = Math.max(1, Math.min(input.maxDepth ?? 1, 20));
        const maxVisits = Math.max(1, Math.min(input.maxVisits ?? 100, 1000));
        const direction = input.direction ?? "outbound";

        const startSeq = yield* lookup(documentNs(input.collection), input.id);
        if (startSeq === undefined) {
          return { documents: [], steps: [], visited: 0, maxDepthReached: 0 };
        }

        const visited = new Set<string>([`${input.collection}/${input.id}`]);
        const queue: Array<{ collection: string; id: string; depth: number }> = [
          { collection: input.collection, id: input.id, depth: 0 },
        ];
        const steps: Array<TraverseStep> = [];
        let maxDepthReached = 0;

        while (queue.length > 0 && steps.length < maxVisits) {
          const current = queue.shift()!;
          if (current.depth >= maxDepth) continue;
          const nextDepth = current.depth + 1;
          const currentStepDocs: Document[] = [];

          if (direction === "outbound" || direction === "both") {
            if (current.collection === declaringCollection) {
              const outDocs = yield* findDocuments({
                collection: targetCollection,
                linked: {
                  collection: declaringCollection,
                  id: current.id,
                  edge: input.edge,
                  direction: "outbound",
                },
                where: input.where,
              });
              currentStepDocs.push(...outDocs);
            }
          }

          if (direction === "inbound" || direction === "both") {
            if (current.collection === targetCollection) {
              const inDocs = yield* findDocuments({
                collection: declaringCollection,
                linked: {
                  collection: declaringCollection,
                  id: current.id,
                  edge: input.edge,
                  direction: "inbound",
                },
                where: input.where,
              });
              currentStepDocs.push(...inDocs);
            }
          }

          for (const doc of currentStepDocs) {
            const key = `${doc.collection}/${doc.id}`;
            if (!visited.has(key)) {
              visited.add(key);
              steps.push({ document: doc, depth: nextDepth });
              maxDepthReached = Math.max(maxDepthReached, nextDepth);
              if (steps.length >= maxVisits) break;
              if (nextDepth < maxDepth) {
                queue.push({ collection: doc.collection, id: doc.id, depth: nextDepth });
              }
            }
          }
        }

        return {
          documents: steps.map((s) => s.document),
          steps,
          visited: steps.length,
          maxDepthReached,
        };
      }),

    summarize: (input) =>
      Effect.gen(function* () {
        const collection = yield* loadCollection(input.collection);
        const measure = yield* declaredMeasure(collection, input.collection, input.measure);
        const planned = yield* planFor(collection, input);
        if (planned === undefined) return { value: foldMeasure(input.op, []), documents: 0 };
        const plan = overMeasure(planned.plan, columnFor(input.collection, measure.path));
        // Resolved first, and only then is the measure read: the point of the
        // lens is that the payloads are never touched, so reading it before the
        // answer is narrow would spend exactly what it exists to save.
        const identifiers = yield* identifiersFor(plan);
        if (identifiers.length === 0) return { value: foldMeasure(input.op, []), documents: 0 };
        const measured = yield* measureOf(measureColumnFor(input.collection, measure.name));
        // A document with no value is left out, never read as zero.
        const values: Array<number> = [];
        for (const seq of identifiers) {
          const value = measured.get(Number(seq));
          if (value !== undefined) values.push(value);
        }
        return { value: foldMeasure(input.op, values), documents: values.length };
      }),

    covariance: (input) =>
      Effect.gen(function* () {
        if (input.sample !== undefined && typeof input.sample !== "boolean") return yield* new InvalidMeasureQuery({ reason: "sample must be a boolean" });
        const collection = yield* loadCollection(input.collection);
        const x = yield* declaredMeasure(collection, input.collection, input.measure);
        const y = yield* declaredMeasure(collection, input.collection, input.with);
        const planned = yield* planFor(collection, input);
        const identifiers = planned === undefined ? [] : yield* identifiersFor(overMeasure(planned.plan, columnFor(input.collection, x.path)));
        const xValues = yield* measureOf(measureColumnFor(input.collection, x.name));
        const yValues = yield* measureOf(measureColumnFor(input.collection, y.name));
        const pairs = function* () {
          for (const seq of identifiers) {
            const a = xValues.get(Number(seq)), b = yValues.get(Number(seq));
            if (a !== undefined && b !== undefined) yield [a, b] as const;
          }
        };
        return yield* calculateMeasure(() => covarianceOf(pairs(), input.sample === true));
      }),

    histogram: (input) =>
      Effect.gen(function* () {
        const collection = yield* loadCollection(input.collection);
        const measure = yield* declaredMeasure(collection, input.collection, input.measure);
        const planned = yield* planFor(collection, input);
        const identifiers = planned === undefined ? [] : yield* identifiersFor(overMeasure(planned.plan, columnFor(input.collection, measure.path)));
        const measured = yield* measureOf(measureColumnFor(input.collection, measure.name));
        const values: number[] = [];
        for (const seq of identifiers) {
          const value = measured.get(Number(seq));
          if (value !== undefined) values.push(value);
        }
        return yield* calculateMeasure(() => histogramOf(values, input));
      }),

    summarizeBy: (input) =>
      Effect.gen(function* () {
        const collection = yield* loadCollection(input.collection);
        const measure = yield* declaredMeasure(collection, input.collection, input.measure);
        const planned = yield* planFor(collection, input);
        if (planned === undefined) return [];
        const groups = input.groups ?? 100;
        if (!Number.isInteger(groups) || groups < 1 || groups > 1000) {
          return yield* Effect.die(new RangeError(`summarizeBy takes 1 to 1000 groups, not ${groups}.`));
        }
        const plan = overMeasure(planned.plan, columnFor(input.collection, measure.path));
        const keep = keeps(plan);
        // The group key comes from the ordered lens beside the identifier, so
        // grouping reads no documents either -- the rows carry both.
        const held = new Map<string, { key: OrderedScalar; seqs: Array<number> }>();
        let after: OrderedCursor | undefined;
        do {
          const page = yield* orderedPage({
            column: columnFor(input.collection, input.groupBy),
            where: plan.query,
            limit: 1000,
            ...(after === undefined ? {} : { after }),
          });
          for (const row of page.rows) {
            // Document columns hold only ordered scalars; bytes cannot reach here.
            if (row.value instanceof Uint8Array) continue;
            if (plan.residual.length > 0) {
              const doc = yield* readDocument(row.seq);
              if (!keep(doc)) continue;
            }
            const at = `${typeof row.value}:${String(row.value)}`;
            const group = held.get(at) ?? { key: row.value, seqs: [] };
            group.seqs.push(Number(row.seq));
            held.set(at, group);
          }
          after = page.next;
        } while (after !== undefined);
        const measured = yield* measureOf(measureColumnFor(input.collection, measure.name));
        const out: Array<GroupedSummary> = [];
        for (const { key, seqs } of held.values()) {
          const values: Array<number> = [];
          for (const seq of seqs) {
            const value = measured.get(Number(seq));
            if (value !== undefined) values.push(value);
          }
          if (values.length === 0) continue;
          out.push({ key, value: foldMeasure(input.op, values), documents: values.length });
          if (out.length >= groups) break;
        }
        return out;
      }),

    getVectorIndex: (input) =>
      Effect.gen(function* () {
        const collection = yield* loadCollection(input.collection);
        if (collection === undefined) return yield* new CollectionNotFound({ name: input.collection });
        return projectionIndexes.get(input.collection);
      }),

  } satisfies Pick<DocumentsApi, "count" | "modalities" | "listCollections" | "collectionExists" | "findById" | "findMany" | "searchStatistics" | "findPage" | "withRelated" | "traverse" | "summarize" | "summarizeBy" | "covariance" | "histogram" | "getVectorIndex">;
  return {
    operations, orderedPage, rebuildIndex, findDocuments,
  };
};

export type DocumentReads = ReturnType<typeof documentReads>;
