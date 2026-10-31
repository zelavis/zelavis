/**
 * The lens declarations a schema implies, and only those it implies safely.
 *
 * A schema says what a field holds; a lens declaration says how it is read.
 * Some of the second follow from the first without a guess: prose is searched
 * as words, a number is aggregated, a reference is a link. Others do not: a
 * pair of numbers is not a place until a coordinate model says which pair, and
 * a list of numbers is not comparable to another until both name the model,
 * its version, the dimension and the metric. Those are derived only from field
 * types that state all of it (`GeometryField`, `VectorField`), never from a
 * `JsonField` that happens to hold the right shape.
 *
 * Pure: the same fields give the same declarations, so an activation that is
 * resumed derives exactly what the interrupted one did.
 */
import { COLLECTION_NAME_PATTERN } from "../naming.js";
import type {
  Analyzer,
  EdgeDefinition,
  EmbeddingIndex,
  MeasureDefinition,
  SpatialIndex,
} from "../document-model.js";
import type { CollectionFieldEntry } from "./field-types.js";

/** A field the derivation looked at and left alone, and why. */
export interface SkippedDeclaration {
  readonly path: string;
  readonly reason: string;
}

export interface DerivedDeclarations {
  /** The schema version they were derived from. */
  readonly schemaVersion: number;
  readonly analyzer?: Analyzer;
  readonly measures: ReadonlyArray<MeasureDefinition>;
  readonly edges: ReadonlyArray<EdgeDefinition>;
  readonly spatial?: SpatialIndex;
  readonly embedding?: EmbeddingIndex;
  readonly skipped: ReadonlyArray<SkippedDeclaration>;
}

/** Prose: what a person reads as words. A slug, a URL or an option is not. */
const PROSE: ReadonlySet<string> = new Set(["TextField", "LongTextField", "RichTextField"]);

export const deriveDeclarations = (
  schemaVersion: number,
  fields: ReadonlyArray<CollectionFieldEntry>,
): DerivedDeclarations => {
  const text: Array<string> = [];
  const measures: Array<MeasureDefinition> = [];
  const edges: Array<EdgeDefinition> = [];
  const geometry: Array<{ readonly path: string; readonly resolution: number }> = [];
  const vectors: Array<EmbeddingIndex> = [];
  const skipped: Array<SkippedDeclaration> = [];
  const named = (path: string, kind: string): boolean => {
    if (COLLECTION_NAME_PATTERN.test(path)) return true;
    skipped.push({ path, reason: `"${path}" cannot name ${kind}: names start with a letter or underscore` });
    return false;
  };

  for (const { name, field } of fields) {
    if (PROSE.has(field._tag)) text.push(name);
    else if (field._tag === "NumberField" || field._tag === "IntegerField") {
      if (named(name, "a measure")) measures.push({ name, path: name });
    } else if (field._tag === "ReferenceField") {
      // A single reference holds `{ collection, id }`, so its id is one path the
      // edge lens reads. A list holds many objects, and no path reaches into
      // each of them: deriving an edge there would post nothing and look ready.
      if (field.multiple === true) {
        skipped.push({ path: name, reason: "a list of references has no single id path for the edge lens" });
      } else if (named(name, "an edge")) {
        edges.push({ name, path: `${name}.id`, collection: field.collection });
      }
    } else if (field._tag === "GeometryField") {
      if (!Number.isInteger(field.resolution) || field.resolution < 0 || field.resolution > 15) {
        skipped.push({ path: name, reason: "resolution is a whole number from 0 to 15" });
      } else geometry.push({ path: name, resolution: field.resolution });
    } else if (field._tag === "VectorField") {
      if (!Number.isInteger(field.dimension) || field.dimension < 1) {
        skipped.push({ path: name, reason: "a dimension is a whole number of elements, from one" });
      } else if (field.model.trim() === "" || field.modelVersion.trim() === "") {
        skipped.push({ path: name, reason: "a vector names the model and model version that produced it" });
      } else {
        vectors.push({
          field: name,
          dimension: field.dimension,
          metric: field.metric,
          model: field.model,
          modelVersion: field.modelVersion,
          ...(field.quantization === undefined ? {} : { quantization: field.quantization }),
          version: schemaVersion,
        });
      }
    } else if (field._tag === "RepeaterField") {
      skipped.push({ path: name, reason: "fields inside a list have no single path a lens reads" });
    }
  }

  // The spatial lens indexes every geometry field at one resolution, so fields
  // that disagree have no declaration that honours both.
  const resolutions = new Set(geometry.map((entry) => entry.resolution));
  let spatial: SpatialIndex | undefined;
  if (resolutions.size === 1) {
    spatial = { fields: geometry.map((entry) => entry.path), resolution: geometry[0]!.resolution, version: schemaVersion };
  } else if (resolutions.size > 1) {
    for (const entry of geometry) {
      skipped.push({ path: entry.path, reason: "geometry fields declare different resolutions; a collection indexes one" });
    }
  }

  // A collection has one embedding.
  let embedding: EmbeddingIndex | undefined;
  if (vectors.length === 1) embedding = vectors[0];
  else {
    for (const vector of vectors) {
      skipped.push({ path: vector.field, reason: "a collection declares one embedding, and the schema has several vector fields" });
    }
  }

  return {
    schemaVersion,
    ...(text.length === 0 ? {} : { analyzer: { fields: text, version: schemaVersion } }),
    measures,
    edges,
    ...(spatial === undefined ? {} : { spatial }),
    ...(embedding === undefined ? {} : { embedding }),
    skipped,
  };
};
