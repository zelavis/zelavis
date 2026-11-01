/** What a document contributes to the lenses: its columns, terms, cells and measures. */
import { Effect } from "effect";
import type { Json, JsonObject } from "./json.js";
import { InvalidDocumentValue } from "./errors.js";
import { geometryValue } from "./geometry-value.js";
import { orderedTuple } from "./keys.js";
import { cellsFor, coveringFor, COARSEST_RESOLUTION, type Geometry } from "./spatial.js";
import { type OrderedScalar } from "./model.js";
import { stem } from "./stemmer.js";

import { measureColumnFor } from "./document-definitions.js";
import { type Analyzer, type MeasureDefinition, type SpatialIndex } from "./document-model.js";
import { orderable } from "./document-planner.js";
import { type StoredIndex, cellFieldFor, collectionColumn, columnFor, pairFieldFor, readPath, textFieldFor, wordPair } from "./document-records.js";

/**
 * Whether a collection's declared columns cover a path: the path itself, or a
 * field it lies below. Undeclared columns cover everything.
 */
export const covers = (columns: ReadonlyArray<string> | undefined, path: string): boolean =>
  columns === undefined || columns.some((column) => path === column || path.startsWith(`${column}.`));

/** Only scalars are indexable; a term for an object or array would not be equatable. */
export const isScalar = (value: Json | undefined): value is string | number | boolean =>
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
export const columnsFor = (
  collection: string,
  data: JsonObject,
  columns: ReadonlyArray<string> | undefined,
): Array<readonly [string, OrderedScalar]> => {
  const out: Array<readonly [string, OrderedScalar]> = [[collectionColumn(), collection]];
  const walk = (value: Json, path: string): void => {
    if (value === null || isScalar(value)) {
      if (path !== "" && covers(columns, path)) out.push([columnFor(collection, path), value]);
      return;
    }
    if (Array.isArray(value)) return;
    for (const [k, v] of Object.entries(value)) walk(v, path === "" ? k : `${path}.${k}`);
  };
  walk(data, "");
  return out;
};

/** Follow exactly the object paths indexed by columnsFor; arrays are not columns. */
export const nonFiniteIndexedPath = (value: Json, path = ""): string | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? undefined : path;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    const invalid = nonFiniteIndexedPath(child, path === "" ? key : `${path}.${key}`);
    if (invalid !== undefined) return invalid;
  }
  return undefined;
};

export const validateDocumentData = (collection: string, data: JsonObject): Effect.Effect<void, InvalidDocumentValue> => {
  const path = nonFiniteIndexedPath(data);
  return path === undefined
    ? Effect.void
    : Effect.fail(new InvalidDocumentValue({ collection, path, reason: "indexed numbers must be finite" }));
};

/**
 * The terms a piece of text yields, in order, before stop words are removed.
 *
 * Split on anything that is not a letter, a number or a mark, which keeps
 * words together across scripts without a per-language rule. Normalized to NFC
 * first, so text that differs only in how an accent is encoded gives one term.
 */
/**
 * Every term a query term stands for under the analyzer's synonyms: itself,
 * and each word of every group it belongs to, analyzed as the text is.
 */
export const synonymsOf = (token: string, analyzer: Analyzer): ReadonlyArray<string> => {
  if (analyzer.synonyms === undefined || analyzer.synonyms.length === 0) return [token];
  const out = new Set<string>([token]);
  for (const group of analyzer.synonyms) {
    const analyzed = group.flatMap((word) => tokenize(word, analyzer));
    if (analyzed.includes(token)) for (const word of analyzed) out.add(word);
  }
  return [...out];
};

export const tokenize = (text: string, analyzer: Analyzer): Array<string> => {
  const normalized = text.normalize("NFC");
  const folded = analyzer.fold === false ? normalized : normalized.toLowerCase();
  const minLength = analyzer.minLength ?? 2;
  const stop = new Set((analyzer.stopWords ?? []).map((word) =>
    analyzer.fold === false ? word.normalize("NFC") : word.normalize("NFC").toLowerCase()));
  const rawTokens = folded
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((token) => token.length >= minLength && !stop.has(token));
  if (analyzer.language) {
    return rawTokens.map((token) => stem(token, analyzer.language));
  }
  return rawTokens;
};

/** Every analyzed field's terms, deduplicated: a posting says the term is there, not how often. */
export const termsFor = (
  collection: string,
  analyzer: Analyzer | undefined,
  data: JsonObject,
): Array<readonly [string, string]> => {
  if (analyzer === undefined) return [];
  const out = new Map<string, readonly [string, string]>();
  for (const path of analyzer.fields) {
    const value = readPath(data, path);
    if (typeof value !== "string") continue;
    const field = textFieldFor(collection, path);
    const tokens = tokenize(value, analyzer);
    for (const token of tokens) out.set(`${path}\u0000${token}`, [field, token]);
    if (analyzer.phrases === true) {
      const pairs = pairFieldFor(collection, path);
      for (let at = 1; at < tokens.length; at++) {
        const pair = wordPair(tokens[at - 1]!, tokens[at]!);
        out.set(`${path}\u0001${pair}`, [pairs, pair]);
      }
    }
  }
  return [...out.values()];
};

/** Marks a document whose geometry was too large to cover at the declared resolution. */
export const COARSE_SENTINEL = "*coarse";

/** The geometry at a path, if it is one this understands. */
export const geometryAt = (data: JsonObject, path: string): Geometry | undefined => {
  return geometryValue(readPath(data, path));
};

/**
 * The cell postings a document contributes: one per covering cell and its
 * ancestors, per spatial field.
 *
 * They ride on the term lens, which is already sealable and already intersects
 * with every other lens — a cell is a term whose field is a path and whose
 * value is a cell id.
 */
export const cellTermsFor = (
  collection: string,
  spatial: SpatialIndex | undefined,
  h3: Parameters<typeof cellsFor>[0] | undefined,
  data: JsonObject,
): Array<readonly [string, string]> => {
  if (spatial === undefined || h3 === undefined) return [];
  const out: Array<readonly [string, string]> = [];
  for (const path of spatial.fields) {
    const geometry = geometryAt(data, path);
    if (geometry === undefined) continue;
    const field = cellFieldFor(collection, path);
    const covering = coveringFor(h3, geometry, spatial.resolution);
    const cells = new Set<string>(covering.cells);
    for (const cell of covering.cells) {
      for (let level = covering.resolution - 1; level >= COARSEST_RESOLUTION; level--) {
        cells.add(h3.cellToParent(cell, level));
      }
    }
    for (const cell of cells) out.push([field, cell]);
    // A shape too large to cover at the declared resolution is indexed coarsely,
    // which a finer query would never meet. The sentinel keeps it a candidate:
    // there are few such documents, and the exact check still decides.
    if (covering.resolution < spatial.resolution) out.push([field, COARSE_SENTINEL]);
  }
  return out;
};

/**
 * The measure postings a document contributes.
 *
 * Non-finite numbers are skipped rather than written: the ordered lens cannot
 * hold one either, so a measure that kept them would disagree with the presence
 * set an aggregate intersects against.
 */
export const measuresFor = (
  collection: string,
  defined: ReadonlyArray<MeasureDefinition>,
  data: JsonObject,
): Array<readonly [string, number]> => {
  const out: Array<readonly [string, number]> = [];
  for (const measure of defined) {
    const value = readPath(data, measure.path);
    if (typeof value === "number" && Number.isFinite(value)) {
      out.push([measureColumnFor(collection, measure.name), value]);
    }
  }
  return out;
};

/** A document's position in one index. */
export const indexTuple = (index: StoredIndex, data: JsonObject): string =>
  orderedTuple(index.fields.map((field) => ({
    value: orderable(readPath(data, field.path)),
    direction: field.direction,
    nulls: field.nulls,
  })));
