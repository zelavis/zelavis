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
import { Effect } from "effect";
import { StoreError } from "./errors.js";

/** How distance between two embeddings is measured. */
export type DistanceMetric = "cosine" | "dot" | "euclidean";

/** Quantization format for vector storage and approximate indexing. */
export type VectorQuantization = "f32" | "f16" | "i8" | "b1";

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
    return { score: distance === 0 ? 0 : -distance, distance };
  }
  const scale = Math.sqrt(lengthA) * Math.sqrt(lengthB);
  const cosine = scale === 0 ? 0 : dot / scale;
  return { score: cosine, distance: cosine };
};

/**
 * Calculates the recall@k of approximate nearest neighbours against the exact ground truth.
 * Returns a float in [0, 1].
 */
export const measureRecall = (
  groundTruth: ReadonlyArray<string | number>,
  approximate: ReadonlyArray<string | number>,
): number => {
  if (groundTruth.length === 0) return 1;
  const set = new Set(groundTruth);
  let matched = 0;
  for (const item of approximate) {
    if (set.has(item)) matched += 1;
  }
  return matched / groundTruth.length;
};

/**
 * Scalar quantization of a vector into 8-bit signed integers (int8).
 * Maps values to [-127, 127] with scale factor.
 */
export const quantizeToInt8 = (
  vector: ReadonlyArray<number>,
): { readonly data: Int8Array; readonly scale: number } => {
  let maxAbs = 0;
  for (const n of vector) {
    const abs = Math.abs(n);
    if (abs > maxAbs) maxAbs = abs;
  }
  const scale = maxAbs === 0 ? 1 : maxAbs / 127;
  const data = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    data[i] = Math.max(-128, Math.min(127, Math.round(vector[i]! / scale)));
  }
  return { data, scale };
};

export const dequantizeFromInt8 = (
  data: Int8Array,
  scale: number,
): ReadonlyArray<number> => {
  const out: number[] = new Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i]! * scale;
  }
  return out;
};

export interface UsearchIndexOptions {
  readonly dimensions: number;
  readonly metric?: "cos" | "ip" | "l2sq";
  readonly quantization?: "f32" | "f16" | "i8" | "b1";
  readonly connectivity?: number;
  readonly expansion_add?: number;
  readonly expansion_search?: number;
}

export interface UsearchMatches {
  readonly keys: BigUint64Array;
  readonly distances: Float32Array;
}

export interface UsearchIndex {
  add(key: bigint | number, vector: Float32Array | Array<number>): void;
  search(vector: Float32Array | Array<number>, k: number): UsearchMatches;
  remove(key: bigint | number): void;
  contains(key: bigint | number): boolean;
  count(): number;
  size(): number;
  capacity(): number;
  save(path: string): void;
  load(path: string): void;
  view(path: string): void;
}

export interface UsearchModule {
  Index: new (options: UsearchIndexOptions) => UsearchIndex;
  MetricKind: Record<string, string>;
  ScalarKind: Record<string, string>;
}

export const loadUsearch = Effect.tryPromise({
  try: async () => {
    const mod = (await import("usearch")) as unknown as UsearchModule & { default?: UsearchModule };
    return (mod.default ?? mod) as UsearchModule;
  },
  catch: (cause) =>
    new StoreError({
      op: "vectors.loadUsearch",
      cause: new Error(
        "Approximate vector search needs the optional `usearch` package installed. " +
          `Install it alongside zelavis to use ANN indexing. Cause: ${String(cause)}`,
      ),
    }),
});

export const metricToUsearch = (metric: DistanceMetric): "cos" | "ip" | "l2sq" => {
  switch (metric) {
    case "cosine":
      return "cos";
    case "dot":
      return "ip";
    case "euclidean":
      return "l2sq";
  }
};

export interface VectorProjectionIndex {
  readonly dimensions: number;
  readonly metric: DistanceMetric;
  readonly quantization: VectorQuantization;
  add(seq: number, vector: ReadonlyArray<number>): void;
  remove(seq: number): void;
  search(query: ReadonlyArray<number>, k: number): ReadonlyArray<{ seq: number; distance: number }>;
  size(): number;
}

export const createProjectionIndex = (
  usearch: UsearchModule,
  options: {
    dimensions: number;
    metric: DistanceMetric;
    quantization?: VectorQuantization;
  },
): VectorProjectionIndex => {
  const metric = metricToUsearch(options.metric);
  const quantization = options.quantization ?? "f32";
  const index = new usearch.Index({
    dimensions: options.dimensions,
    metric,
    quantization,
  });
  return {
    dimensions: options.dimensions,
    metric: options.metric,
    quantization,
    add: (seq: number, vector: ReadonlyArray<number>) => {
      if (index.contains(seq)) index.remove(seq);
      index.add(seq, new Float32Array(vector));
    },
    remove: (seq: number) => {
      if (index.contains(seq)) index.remove(seq);
    },
    search: (query: ReadonlyArray<number>, k: number) => {
      const matches = index.search(new Float32Array(query), k);
      const out: Array<{ seq: number; distance: number }> = [];
      for (let i = 0; i < matches.keys.length; i++) {
        out.push({
          seq: Number(matches.keys[i]!),
          distance: matches.distances[i]!,
        });
      }
      return out;
    },
    size: () => index.size(),
  };
};
