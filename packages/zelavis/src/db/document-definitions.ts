/** A collection's declarations — indexes, checks, analyzer, geometry, embedding, edges, measures, references, columns — checked and normalized. */
import { Effect } from "effect";
import type { Json, JsonObject } from "./json.js";
import { COLLECTION_NAME_PATTERN } from "./naming.js";
import { InvalidIndex, InvalidConstraint } from "./errors.js";
import { isUsableVector } from "./vectors.js";

import { covers } from "./document-indexing.js";
import { type Analyzer, type CheckConstraint, type DocumentFilter, type EdgeDefinition, type EmbeddingIndex, type IndexDefinition, type IndexField, type MeasureDefinition, type ReferenceConstraint, type SpatialIndex } from "./document-model.js";
import { matches, orderable } from "./document-planner.js";
import { readPath } from "./document-records.js";

/**
 * A collection's declared columns, checked and in one order. Every reference
 * must read a covered field: a join is an equality over the referencing
 * field's own postings, and an uncovered field has none.
 */
export const normalizeColumns = (
  collection: string,
  columns: unknown,
  references: ReadonlyArray<Required<ReferenceConstraint>>,
): Effect.Effect<ReadonlyArray<string>, InvalidConstraint> => {
  const invalid = (reason: string) => Effect.fail(new InvalidConstraint({ collection, name: "columns", reason }));
  if (!Array.isArray(columns)) return invalid("columns must be a list of field paths");
  for (const column of columns as ReadonlyArray<unknown>) {
    if (typeof column !== "string" || column === "" || column.split(".").some((segment) => segment === "")) {
      return invalid(`${JSON.stringify(column) ?? "undefined"} is not a field path`);
    }
  }
  const declared = [...new Set(columns as ReadonlyArray<string>)].sort();
  for (const reference of references) {
    if (!covers(declared, reference.path)) {
      return invalid(`reference "${reference.name}" reads ${reference.path}, which the columns leave out`);
    }
  }
  return Effect.succeed(declared);
};

export const describeFields = (fields: ReadonlyArray<Required<IndexField>>): string =>
  fields.map((field) => `${field.path} ${field.direction} nulls ${field.nulls}`).join(", ");

export const sameFields = (
  a: ReadonlyArray<Required<IndexField>>,
  b: ReadonlyArray<Required<IndexField>>,
): boolean =>
  a.length === b.length &&
  a.every((field, i) =>
    field.path === b[i]!.path && field.direction === b[i]!.direction && field.nulls === b[i]!.nulls);

/** Enough for any order a page is likely to ask for, and a bound on a key's length. */
export const MAX_INDEX_FIELDS = 8;

/**
 * An index definition with its defaults filled in, or why it cannot be built.
 *
 * Checked field by field at runtime as well as by type, because a definition
 * also arrives as JSON over HTTP.
 */
export const normalizeIndex = (
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

/** A value a field has, as opposed to null, absent, or an object or array. */
export const hasValue = (value: Json | undefined): boolean => {
  const scalar = orderable(value);
  return scalar !== undefined && scalar !== null;
};

export const describeFilter = (filter: DocumentFilter): string =>
  `${filter.path} ${filter.op ?? "eq"} ${JSON.stringify(filter.value)}`;

/** Whether one filter of a check holds: a field with no value always does. */
export const satisfiesCheck = (data: JsonObject, filter: DocumentFilter): boolean => {
  const actual = readPath(data, filter.path);
  return actual === undefined || actual === null || matches(data, filter);
};

export const FILTER_OPERATORS: ReadonlySet<string> = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "in"]);

/** A check definition in the shape it is stored, or why it cannot be enforced. */
export const normalizeCheck = (
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
export const normalizeAnalyzer = (
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
export const normalizeSpatial = (
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

/**
 * What the edge lens calls this edge. Scoped by collection, so two collections
 * may both declare `tags` and mean different things by it.
 */
export const edgeTypeFor = (collection: string, name: string): string => `${collection}/${name}`;

/** An edge definition in the shape it is stored, or why it cannot be used. */
export const normalizeEdge = (
  collection: string,
  edge: EdgeDefinition,
): Effect.Effect<EdgeDefinition, InvalidConstraint> => {
  const invalid = (reason: string) =>
    Effect.fail(new InvalidConstraint({ collection, name: String(edge.name), reason }));
  if (typeof edge.name !== "string" || !COLLECTION_NAME_PATTERN.test(edge.name)) {
    return invalid(
      "an edge name must start with a letter or underscore and contain only letters, numbers, underscores, or hyphens",
    );
  }
  const path: unknown = edge.path;
  if (typeof path !== "string" || path === "" || path.split(".").some((segment) => segment === "")) {
    return invalid(`${JSON.stringify(path) ?? "undefined"} is not a field path`);
  }
  if (typeof edge.collection !== "string" || !COLLECTION_NAME_PATTERN.test(edge.collection)) {
    return invalid(`${JSON.stringify(edge.collection) ?? "undefined"} is not a collection name`);
  }
  return Effect.succeed({ name: edge.name, path, collection: edge.collection });
};

/**
 * The measure lens column one measure keeps its values in.
 *
 * `~` separates it: a field's column uses `.` and an index's uses `:`, and a
 * collection name holds none of the three, so these three namespaces never meet.
 */
export const measureColumnFor = (collection: string, name: string) => `${collection}~${name}`;

/** A measure definition in the shape it is stored, or why it cannot be used. */
export const normalizeMeasure = (
  collection: string,
  measure: MeasureDefinition,
): Effect.Effect<MeasureDefinition, InvalidConstraint> => {
  const invalid = (reason: string) =>
    Effect.fail(new InvalidConstraint({ collection, name: String(measure.name), reason }));
  if (typeof measure.name !== "string" || !COLLECTION_NAME_PATTERN.test(measure.name)) {
    return invalid(
      "a measure name must start with a letter or underscore and contain only letters, numbers, underscores, or hyphens",
    );
  }
  const path: unknown = measure.path;
  if (typeof path !== "string" || path === "" || path.split(".").some((segment) => segment === "")) {
    return invalid(`${JSON.stringify(path) ?? "undefined"} is not a field path`);
  }
  return Effect.succeed({ name: measure.name, path });
};

export const METRICS: ReadonlySet<string> = new Set(["cosine", "dot", "euclidean"]);
export const QUANTIZATIONS: ReadonlySet<string> = new Set(["f32", "f16", "i8", "b1"]);

/**
 * Why this value cannot be the vector the embedding declares, or undefined when
 * it can. A field that holds nothing is not a fault: a document without a vector
 * simply never answers a similarity read.
 */
export const describeVector = (embedding: EmbeddingIndex, value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return `${embedding.field} holds ${typeof value}, which is not a vector`;
  if (value.length !== embedding.dimension) {
    return `${embedding.field} holds ${value.length} numbers, not the ${embedding.dimension} declared`;
  }
  if (!isUsableVector(value)) return `${embedding.field} holds a value that is not a finite number`;
  return undefined;
};

/** An embedding index in the shape it is stored, or why it cannot be used. */
export const normalizeEmbedding = (
  collection: string,
  embedding: EmbeddingIndex,
): Effect.Effect<EmbeddingIndex, InvalidConstraint> => {
  const invalid = (reason: string) =>
    Effect.fail(new InvalidConstraint({ collection, name: "embedding", reason }));
  const path: unknown = embedding.field;
  if (typeof path !== "string" || path === "" || path.split(".").some((segment) => segment === "")) {
    return invalid(`${JSON.stringify(path) ?? "undefined"} is not a field path`);
  }
  if (!Number.isInteger(embedding.dimension) || embedding.dimension < 1) {
    return invalid("a dimension is a whole number of elements, from one");
  }
  if (!METRICS.has(embedding.metric)) {
    return invalid(`metric is one of ${[...METRICS].join(", ")}`);
  }
  if (embedding.quantization !== undefined && !QUANTIZATIONS.has(embedding.quantization)) {
    return invalid(`quantization is one of ${[...QUANTIZATIONS].join(", ")}`);
  }
  if (!Number.isInteger(embedding.version) || embedding.version < 1) {
    return invalid("an embedding's version is a whole number from one, raised when its rules change");
  }
  return Effect.succeed({
    field: path,
    dimension: embedding.dimension,
    metric: embedding.metric,
    ...(embedding.quantization === undefined ? {} : { quantization: embedding.quantization }),
    ...(embedding.normalize === undefined ? {} : { normalize: embedding.normalize }),
    ...(embedding.model === undefined ? {} : { model: embedding.model }),
    ...(embedding.modelVersion === undefined ? {} : { modelVersion: embedding.modelVersion }),
    version: embedding.version,
  });
};

export const ON_DELETE: ReadonlySet<string> = new Set(["restrict", "cascade", "set-null"]);

/** A reference definition with its default filled in, or why it cannot be enforced. */
export const normalizeReference = (
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
