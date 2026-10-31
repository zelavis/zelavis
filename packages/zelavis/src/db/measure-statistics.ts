/** Bounded numeric aggregates over the measure lens, independent of documents or engines. */
import { InvalidMeasureQuery } from "./errors.js";
import type { MeasureHistogram, MeasureHistogramInput, Summary } from "./document-model.js";

const invalid = (reason: string): never => { throw new InvalidMeasureQuery({ reason }); };
const finite = (value: number): number => Number.isFinite(value) ? value : invalid("the aggregate exceeds finite numeric precision");

/** Online paired covariance, with missing measures omitted rather than replaced by zero. */
export const covarianceOf = (pairs: Iterable<readonly [number, number]>, sample: boolean): Summary => {
  let count = 0, xMean = 0, yMean = 0, coMoment = 0;
  for (const [x, y] of pairs) {
    count += 1;
    const dx = x - xMean;
    xMean += dx / count;
    yMean += (y - yMean) / count;
    coMoment += dx * (y - yMean);
  }
  const denominator = sample ? count - 1 : count;
  return { documents: count, value: denominator < 1 ? 0 : finite(coMoment / denominator) };
};

export const histogramOf = (values: ReadonlyArray<number>, input: Pick<MeasureHistogramInput, "bins" | "boundaries" | "min" | "max">): MeasureHistogram => {
  let min: number | null = null, max: number | null = null, sum = 0;
  for (const value of values) {
    min = min === null ? value : Math.min(min, value);
    max = max === null ? value : Math.max(max, value);
    sum += value;
  }
  finite(sum);
  let boundaries: number[];
  if (input.boundaries !== undefined) {
    if (input.bins !== undefined || input.min !== undefined || input.max !== undefined) invalid("boundaries cannot be combined with bins, min or max");
    if (!Array.isArray(input.boundaries) || input.boundaries.length < 2 || input.boundaries.length > 257 || input.boundaries.some((value, at) => !Number.isFinite(value) || (at > 0 && value <= input.boundaries![at - 1]))) invalid("boundaries must contain 2 to 257 strictly increasing finite numbers");
    boundaries = [...input.boundaries];
  } else {
    const bins = input.bins ?? 10;
    if (!Number.isSafeInteger(bins) || bins < 1 || bins > 256) invalid("bins must be an integer from 1 to 256");
    if ((input.min !== undefined && !Number.isFinite(input.min)) || (input.max !== undefined && !Number.isFinite(input.max))) invalid("histogram limits must be finite numbers");
    const lower = input.min ?? min ?? 0, upper = input.max ?? max ?? lower;
    if (upper < lower) invalid("histogram max must be at least min");
    if (lower === upper) boundaries = [lower, upper];
    else {
      const width = finite(upper - lower) / bins;
      boundaries = Array.from({ length: bins + 1 }, (_, at) => at === bins ? upper : finite(lower + width * at));
      if (boundaries.some((value, at) => at > 0 && value <= boundaries[at - 1])) invalid("histogram bins are smaller than numeric precision");
    }
  }
  const buckets = boundaries.slice(0, -1).map((lower, at) => ({ lower, upper: boundaries[at + 1], count: 0 }));
  let underflow = 0, overflow = 0;
  for (const value of values) {
    if (value < boundaries[0]) { underflow += 1; continue; }
    if (value > boundaries[boundaries.length - 1]) { overflow += 1; continue; }
    // Upper edges belong to the next bucket; the final upper edge is inclusive.
    let lo = 0, hi = buckets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (value >= buckets[mid].upper) lo = mid + 1;
      else hi = mid;
    }
    buckets[lo].count += 1;
  }
  return { buckets, documents: values.length, underflow, overflow, min, max, sum, avg: values.length === 0 ? null : finite(sum / values.length) };
};
