/**
 * Embeddings, and what it means for two of them to be close.
 *
 * The vectors themselves live in the document, which is the authoritative
 * state: nothing here keeps a second copy, and no index is consulted to decide
 * an answer. That is deliberate. An approximate index, when there is one, will
 * be a projection that can be thrown away and rebuilt, and the only way to know
 * what it costs in recall is to have an exact answer to compare it against.
 * This is that exact answer.
 */

/** How distance between two embeddings is measured. */
export type DistanceMetric = "cosine" | "dot" | "euclidean";

/**
 * A score, and what a bigger one means.
 *
 * Every metric here is turned into a similarity where higher is closer, so a
 * caller ordering by score never has to ask which way round this particular
 * measure runs. The raw distance travels alongside for the metrics that have
 * one.
 */
export interface Similarity {
  /** Higher is closer, whatever the metric. */
  readonly score: number;
  /** Euclidean distance, or the cosine/dot product as measured. */
  readonly distance: number;
}

export const dimensionOf = (value: unknown): number | undefined =>
  Array.isArray(value) && value.every((n) => typeof n === "number") ? value.length : undefined;

/** Every element finite: a NaN would make every comparison against it false. */
export const isUsableVector = (value: unknown): value is ReadonlyArray<number> =>
  Array.isArray(value) && value.length > 0 && value.every((n) => typeof n === "number" && Number.isFinite(n));

export const normalized = (vector: ReadonlyArray<number>): ReadonlyArray<number> => {
  let sum = 0;
  for (const n of vector) sum += n * n;
  const length = Math.sqrt(sum);
  return length === 0 ? vector : vector.map((n) => n / length);
};

/**
 * How close two vectors are, by one metric.
 *
 * Cosine is the angle, so it ignores magnitude and sits in [-1, 1]; a zero
 * vector has no direction, and scores zero against everything rather than
 * dividing by nothing. Dot rewards magnitude as well as direction. Euclidean
 * is a distance, so its score is its negation — nearer is greater, which is
 * what ordering by score has to mean.
 */
export const similarity = (
  a: ReadonlyArray<number>,
  b: ReadonlyArray<number>,
  metric: DistanceMetric,
): Similarity => {
  let dot = 0;
  let squared = 0;
  let lengthA = 0;
  let lengthB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    const gap = x - y;
    squared += gap * gap;
    lengthA += x * x;
    lengthB += y * y;
  }
  if (metric === "dot") return { score: dot, distance: dot };
  if (metric === "euclidean") {
    const distance = Math.sqrt(squared);
    return { score: -distance, distance };
  }
  const scale = Math.sqrt(lengthA) * Math.sqrt(lengthB);
  const cosine = scale === 0 ? 0 : dot / scale;
  return { score: cosine, distance: cosine };
};
