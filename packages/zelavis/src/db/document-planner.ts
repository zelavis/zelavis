/** How a read becomes a store query and a residual filter, in what order it is answered, and what it highlights. */
import { Effect } from "effect";
import type { Json, JsonObject } from "./json.js";
import { UnindexedField } from "./errors.js";
import { compareOrderedValues, orderedTuple, sameOrderedKind } from "./keys.js";
import { boxGeometry, distanceToGeometry, inBox, intersectsGeometry, positionsOf } from "./spatial.js";
import { type OrderedScalar } from "./model.js";
import { and, equals, or, term, type Query, type RangeBound } from "./query.js";
import type { OrderedCursor } from "./store.js";
import { stem } from "./stemmer.js";
import {
  matchesSearchClause,
  type SearchClause,
  type ParsedSearchQuery,
  damerauLevenshtein,
} from "./search-parser.js";

import { covers, geometryAt, isScalar, tokenize } from "./document-indexing.js";
import { type Analyzer, type Document, type DocumentFilter, type DocumentSort, type HighlightOptions, type NullPlacement, type SpatialFilter } from "./document-model.js";
import { type StoredCollection, type StoredIndex, collectionColumn, columnFor, readPath } from "./document-records.js";

/** The read operations that go through a field's own postings, and so need it indexed. */
export const POSTED_OPS: ReadonlySet<string> = new Set(["eq", "in", "gt", "gte", "lt", "lte"]);
export const DYNAMIC_SORTS: ReadonlySet<string> = new Set(["$distance", "distance", "$score", "score"]);

/**
 * Refuse an equality, a range or an order on a field the collection does not
 * index. Filters evaluated per document (`ne`, phrases and the like) need no
 * postings and pass. A single-field order is read through that field's
 * postings unless a composite index serves it; several fields are sorted in
 * memory or need an index, which `UnsupportedOrdering` already says.
 */
export const requireColumns = (
  collection: StoredCollection | undefined,
  name: string,
  where: ReadonlyArray<DocumentFilter>,
  order?: { readonly sorts: ReadonlyArray<{ readonly path: string }>; readonly indexed: boolean },
): Effect.Effect<void, UnindexedField> => {
  const columns = collection?.columns;
  if (columns === undefined) return Effect.void;
  for (const filter of where) {
    if (POSTED_OPS.has(filter.op ?? "eq") && !covers(columns, filter.path)) {
      return Effect.fail(new UnindexedField({ collection: name, path: filter.path }));
    }
  }
  const only = order?.sorts.length === 1 ? order.sorts[0]! : undefined;
  if (only !== undefined && order?.indexed === false && !DYNAMIC_SORTS.has(only.path) && !covers(columns, only.path)) {
    return Effect.fail(new UnindexedField({ collection: name, path: only.path }));
  }
  return Effect.void;
};

/** A value at a path as the ordered lens sees it, or undefined when it has no place in the order. */
export const orderable = (value: Json | undefined): OrderedScalar | undefined =>
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
export const compareAt = (
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
export type Sort = Required<DocumentSort>;

export const normalizeSorts = (sorts: ReadonlyArray<DocumentSort> | undefined): Array<Sort> =>
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
      const valA = sort.path === "$distance" || sort.path === "distance"
        ? (a.distance ?? readPath(a.data, sort.path))
        : sort.path === "$score" || sort.path === "score"
          ? (a.score ?? readPath(a.data, sort.path))
          : readPath(a.data, sort.path);
      const valB = sort.path === "$distance" || sort.path === "distance"
        ? (b.distance ?? readPath(b.data, sort.path))
        : sort.path === "$score" || sort.path === "score"
          ? (b.score ?? readPath(b.data, sort.path))
          : readPath(b.data, sort.path);
      const order = compareAt(valA, valB, sort.direction, sort.nulls);
      if (order !== 0) return order;
    }
    return 0;
  };
};

/** Whether a document's geometry really meets a filter, on its own coordinates. */
export const matchesGeometry = (filter: SpatialFilter, data: JsonObject): boolean => {
  const geometry = geometryAt(data, filter.field);
  if (geometry === undefined) return false;
  if ("near" in filter) {
    return distanceToGeometry(filter.near, geometry) <= filter.radius;
  }
  if ("within" in filter) {
    return boxGeometry(filter.within).some((box) => intersectsGeometry(box, geometry)) ||
      positionsOf(geometry).some((position) => inBox(filter.within, position));
  }
  return intersectsGeometry(filter.intersects, geometry);
};

/**
 * The fields an equality filter fixes to one scalar, which an index can seek
 * to rather than filter by. Null is left to the filter: an index files null
 * with absent, and an equality with null matches only null.
 */
export const equalityBindings = (where: ReadonlyArray<DocumentFilter>): Map<string, OrderedScalar> => {
  const out = new Map<string, OrderedScalar>();
  for (const filter of where) {
    if ((filter.op ?? "eq") !== "eq" || out.has(filter.path)) continue;
    const value = orderable(filter.value as Json);
    if (value !== undefined && value !== null) out.set(filter.path, value);
  }
  return out;
};

export interface IndexedOrder {
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
export const chooseIndex = (
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
export const comparison = (actual: Json | undefined, expected: Json): number | undefined => {
  const a = orderable(actual);
  const e = orderable(expected);
  return a === undefined || e === undefined || !sameOrderedKind(a, e)
    ? undefined
    : compareOrderedValues(a, e);
};

export const countPhraseMatches = (
  tokens: ReadonlyArray<string>,
  phrase: ReadonlyArray<string>,
): number => {
  if (tokens.length < phrase.length || phrase.length === 0) return 0;
  let count = 0;
  for (let i = 0; i <= tokens.length - phrase.length; i++) {
    let match = true;
    for (let j = 0; j < phrase.length; j++) {
      if (tokens[i + j] !== phrase[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      count += 1;
      i += phrase.length - 1;
    }
  }
  return count;
};

export const matchesPhrases = (
  data: JsonObject,
  phrases: ReadonlyArray<ReadonlyArray<string>>,
  analyzer: Analyzer,
): boolean => {
  for (const phrase of phrases) {
    if (phrase.length === 0) continue;
    let found = false;
    for (const field of analyzer.fields) {
      const val = readPath(data, field);
      if (typeof val !== "string") continue;
      const tokens = tokenize(val, analyzer);
      if (countPhraseMatches(tokens, phrase) > 0) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
};

export const matches = (data: JsonObject, filter: DocumentFilter): boolean => {
  const actual = readPath(data, filter.path);
  const op = filter.op ?? "eq";
  // A spatial filter carries its own shape, and decides on the coordinates.
  if (op === "geometry") return matchesGeometry(filter.value as unknown as SpatialFilter, data);
  if (op === "search") {
    const { root, analyzer } = filter.value as unknown as {
      root: SearchClause;
      analyzer: Analyzer;
    };
    return matchesSearchClause(data, root, analyzer, tokenize, readPath);
  }
  if (op === "phrase") {
    const { phrases, analyzer } = filter.value as unknown as {
      phrases: ReadonlyArray<ReadonlyArray<string>>;
      analyzer: Analyzer;
    };
    return matchesPhrases(data, phrases, analyzer);
  }
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
export interface Plan {
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
export const withSearch = (plan: Plan, words: Query | undefined): Plan =>
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
 * approximated. `field` is the stored cell field (`cellFieldFor`), which
 * already confines the cells to one tenant's collection.
 */
export const withCells = (
  plan: Plan,
  field: string,
  cells: ReadonlyArray<string>,
  exact: DocumentFilter,
): Plan => {
  if (cells.length === 0) return { ...plan, residual: [...plan.residual, exact] };
  const clauses = cells.map((cell) => term(field, cell));
  const covering = clauses.length === 1 ? clauses[0]! : or(...clauses);
  return {
    query: plan.fields === undefined ? covering : and(plan.query, covering),
    fields: plan.fields === undefined ? covering : and(plan.fields, covering),
    residual: [...plan.residual, exact],
  };
};

export const planQuery = (
  collection: string,
  where: ReadonlyArray<DocumentFilter>,
): Plan => {
  const clauses: Query[] = [];
  const residual: DocumentFilter[] = [];
  for (const filter of where) {
    const op = filter.op ?? "eq";
    const column = columnFor(collection, filter.path);
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
    query: fields ?? equals(collectionColumn(), collection),
    fields,
    residual,
  };
};

/** Where a read of documents in order stands: after one document, in one of its runs. */
export type Position =
  | { readonly phase: "values"; readonly cursor: OrderedCursor }
  | { readonly phase: "rest"; readonly seq: number }
  | { readonly phase: "seq"; readonly seq: number }
  | { readonly phase: "distance"; readonly distance: number; readonly seq: number }
  | { readonly phase: "score"; readonly score: number; readonly seq: number };

export interface Placed {
  readonly document: Document;
  /** The position just after this document. */
  readonly position: Position;
}

export interface PageShape {
  readonly collection: string;
  /** The order read, empty for identifier order. */
  readonly order: ReadonlyArray<Sort>;
  /** The column of the index the read goes through, if it goes through one. */
  readonly via: string | undefined;
}


export const generateHighlights = (
  data: JsonObject,
  analyzer: Analyzer,
  parsed: ParsedSearchQuery,
  options: HighlightOptions,
): Record<string, ReadonlyArray<string>> => {
  const preTag = options.preTag ?? "<mark>";
  const postTag = options.postTag ?? "</mark>";
  const snippetLength = options.snippetLength ?? 100;
  const maxSnippets = options.maxSnippets ?? 3;

  const result: Record<string, string[]> = {};

  for (const field of analyzer.fields) {
    const rawVal = readPath(data, field);
    if (typeof rawVal !== "string" || rawVal.trim().length === 0) continue;

    const wordPattern = /[\p{L}\p{N}\p{M}]+/gu;
    const matches: Array<{ start: number; end: number }> = [];
    let m: RegExpExecArray | null;

    while ((m = wordPattern.exec(rawVal)) !== null) {
      const word = m[0];
      const start = m.index;
      const end = start + word.length;
      const normalized = word.normalize("NFC");
      const folded = analyzer.fold === false ? normalized : normalized.toLowerCase();
      const stemmed = analyzer.language ? stem(folded, analyzer.language) : folded;

      let matched = false;
      for (const qTerm of parsed.terms) {
        if (qTerm.field !== undefined && qTerm.field !== field) continue;
        if (qTerm.kind === "exact" && (folded === qTerm.token || stemmed === qTerm.token)) {
          matched = true;
          break;
        } else if (qTerm.kind === "prefix" && (folded.startsWith(qTerm.token) || stemmed.startsWith(qTerm.token))) {
          matched = true;
          break;
        } else if (qTerm.kind === "fuzzy") {
          const maxDist = qTerm.fuzzyDistance ?? 2;
          const dist = Math.min(
            damerauLevenshtein(folded, qTerm.token, maxDist),
            damerauLevenshtein(stemmed, qTerm.token, maxDist),
          );
          if (dist <= maxDist) {
            matched = true;
            break;
          }
        }
      }

      if (matched) {
        matches.push({ start, end });
      }
    }

    if (matches.length === 0) continue;

    const merged: Array<{ start: number; end: number }> = [];
    for (const match of matches) {
      const last = merged.at(-1);
      if (last && match.start <= last.end) {
        last.end = Math.max(last.end, match.end);
      } else {
        merged.push({ ...match });
      }
    }

    if (rawVal.length <= snippetLength) {
      let highlighted = "";
      let lastIndex = 0;
      for (const span of merged) {
        highlighted += rawVal.slice(lastIndex, span.start);
        highlighted += preTag + rawVal.slice(span.start, span.end) + postTag;
        lastIndex = span.end;
      }
      highlighted += rawVal.slice(lastIndex);
      result[field] = [highlighted];
      continue;
    }

    const snippets: string[] = [];
    const clusters: Array<Array<{ start: number; end: number }>> = [];
    let currentCluster: Array<{ start: number; end: number }> = [];

    for (const span of merged) {
      if (currentCluster.length === 0) {
        currentCluster.push(span);
      } else {
        const clusterStart = currentCluster[0]!.start;
        if (span.end - clusterStart <= snippetLength) {
          currentCluster.push(span);
        } else {
          clusters.push(currentCluster);
          currentCluster = [span];
          if (clusters.length >= maxSnippets) break;
        }
      }
    }
    if (currentCluster.length > 0 && clusters.length < maxSnippets) {
      clusters.push(currentCluster);
    }

    for (const cluster of clusters) {
      const first = cluster[0]!;
      const last = cluster.at(-1)!;
      const matchSpanLen = last.end - first.start;
      const padding = Math.max(0, Math.floor((snippetLength - matchSpanLen) / 2));

      let snippetStart = Math.max(0, first.start - padding);
      let snippetEnd = Math.min(rawVal.length, last.end + padding);

      if (snippetStart > 0) {
        const spaceIdx = rawVal.lastIndexOf(" ", snippetStart);
        if (spaceIdx !== -1 && spaceIdx >= snippetStart - 15) {
          snippetStart = spaceIdx + 1;
        }
      }
      if (snippetEnd < rawVal.length) {
        const spaceIdx = rawVal.indexOf(" ", snippetEnd);
        if (spaceIdx !== -1 && spaceIdx <= snippetEnd + 15) {
          snippetEnd = spaceIdx;
        }
      }

      let snippet = "";
      let lastIdx = snippetStart;
      for (const span of cluster) {
        if (span.start >= snippetStart && span.end <= snippetEnd) {
          snippet += rawVal.slice(lastIdx, span.start);
          snippet += preTag + rawVal.slice(span.start, span.end) + postTag;
          lastIdx = span.end;
        }
      }
      snippet += rawVal.slice(lastIdx, snippetEnd);

      if (snippetStart > 0) snippet = `...${snippet}`;
      if (snippetEnd < rawVal.length) snippet = `${snippet}...`;

      snippets.push(snippet);
    }

    result[field] = snippets;
  }

  return result;
};
