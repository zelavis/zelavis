import { Effect, Stream } from "effect";
import type { DomainEvent } from "./domain-events.js";
import { TimeSeriesNotFound } from "./errors.js";
import type { JsonObject } from "./json.js";
import type { ProjectionsApi, ProjectionSource } from "./projections.js";
import { and, between, equals, or, type Query } from "./query.js";
import type { ObjectStoreApi } from "./store.js";
import type { TenantId } from "./topology.js";

export type AggregateOperation =
  | "avg" | "sum" | "min" | "max" | "count"
  /** The value at a fraction through the sorted values; see `AggregateInput.p`. */
  | "quantile"
  /** The window's own endpoints, by time rather than by value. */
  | "first" | "last" | "delta" | "rate";

export type Timestamp = number | string | Date;

export interface TimeSeriesPoint {
  /** Epoch milliseconds once stored, whatever the mapper returned. */
  readonly timestamp: number;
  readonly value: number;
  readonly tags?: Record<string, string>;
  readonly fields?: JsonObject;
}

export interface TimeSeriesInputPoint {
  readonly timestamp: Timestamp;
  readonly value: number;
  readonly tags?: Record<string, string>;
  readonly fields?: JsonObject;
}

export type TimeSeriesMapper = (
  event: DomainEvent,
  context: { readonly series: string },
) => TimeSeriesInputPoint | ReadonlyArray<TimeSeriesInputPoint> | null | undefined;

export interface TimeSeriesDefinition {
  readonly name: string;
  readonly description?: string;
  readonly version?: string | number;
  readonly source?: ProjectionSource;
  readonly map: TimeSeriesMapper;
}

export interface TimeSeriesSummary {
  readonly name: string;
  readonly description?: string;
  readonly version?: string | number;
}

/**
 * Which tags a point must carry.
 *
 * Every named tag has to match, and a tag given several values matches any of
 * them — the shape a caller means by "region eu-west or eu-north, and tier
 * paid". Both are set operations on the same postings the points were indexed
 * under, so a filter narrows the work rather than adding to it.
 *
 * A tag given no values matches nothing, which is what "one of nothing" says.
 */
export type TagFilter = Readonly<Record<string, string | ReadonlyArray<string>>>;

export interface RangeInput {
  readonly start?: Timestamp;
  readonly end?: Timestamp;
  readonly limit?: number;
  readonly order?: "asc" | "desc";
  readonly tags?: TagFilter;
}

export interface AggregateInput {
  readonly op: AggregateOperation;
  readonly start?: Timestamp;
  readonly end?: Timestamp;
  readonly tags?: TagFilter;
  /**
   * Which quantile, as a fraction from 0 to 1: 0.5 is the median and 0.99 the
   * ninety-ninth percentile. Required by `quantile` and ignored by the rest.
   */
  readonly p?: number;
}

export interface TimeSeriesBucket {
  readonly timestamp: number;
  readonly value: number;
  readonly count: number;
}

export interface WindowsInput {
  readonly start?: Timestamp;
  readonly end?: Timestamp;
  /** Window duration in milliseconds. */
  readonly interval: number;
  /**
   * Distance between consecutive window starts in milliseconds.
   * Defaults to `interval` (tumbling, non-overlapping windows).
   * When `step < interval`, produces sliding/moving windows.
   */
  readonly step?: number;
  /** Aggregation operation for each window (default: "avg"). */
  readonly op?: AggregateOperation;
  /** Tag filter. */
  readonly tags?: TagFilter;
  /**
   * Handling of empty windows:
   * - "none" (default): omit empty windows from results.
   * - "zero": value 0, count 0.
   * - "previous": carry forward previous non-empty window's value.
   * - "linear": linearly interpolate between nearest non-empty windows.
   */
  readonly fill?: "none" | "zero" | "previous" | "linear";
  /** Quantile fraction (0..1) when op is "quantile". */
  readonly p?: number;
}

export interface MovingInput {
  readonly start?: Timestamp;
  readonly end?: Timestamp;
  /** Rolling window size: duration in milliseconds or point count. */
  readonly window: { readonly time: number } | { readonly count: number };
  /** Aggregation operation (default: "avg"). */
  readonly op?: AggregateOperation;
  readonly tags?: TagFilter;
  readonly p?: number;
}

export interface HistogramBucket {
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
}

export interface HistogramResult {
  readonly buckets: ReadonlyArray<HistogramBucket>;
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly sum: number;
  readonly avg: number;
}

export interface HistogramInput {
  readonly start?: Timestamp;
  readonly end?: Timestamp;
  readonly tags?: TagFilter;
  /** Number of equal-width bins (default: 10). */
  readonly bins?: number;
  /** Explicit bin thresholds (e.g. [0, 10, 50, 100]). */
  readonly boundaries?: ReadonlyArray<number>;
  /** Fixed bin width (e.g. 5). */
  readonly step?: number;
  readonly min?: number;
  readonly max?: number;
}

export interface InterpolateInput {
  readonly start?: Timestamp;
  readonly end?: Timestamp;
  /** Fixed grid step in milliseconds. */
  readonly step: number;
  /** Interpolation method: "linear" (default), "previous", or "next". */
  readonly method?: "linear" | "previous" | "next";
  readonly tags?: TagFilter;
}

export interface TimeSeriesHandle {
  readonly range: (input?: RangeInput) => Effect.Effect<ReadonlyArray<TimeSeriesPoint>>;
  readonly aggregate: (input: AggregateInput) => Effect.Effect<number>;
  readonly windows: (input: WindowsInput) => Effect.Effect<ReadonlyArray<TimeSeriesBucket>>;
  readonly moving: (input: MovingInput) => Effect.Effect<ReadonlyArray<TimeSeriesPoint>>;
  readonly histogram: (input: HistogramInput) => Effect.Effect<HistogramResult>;
  readonly interpolate: (input: InterpolateInput) => Effect.Effect<ReadonlyArray<TimeSeriesPoint>>;
}

export interface IngestResult {
  readonly name: string;
  readonly applied: number;
  readonly points: number;
}

export interface TimeSeriesApi {
  readonly define: (definition: TimeSeriesDefinition) => Effect.Effect<void>;
  readonly list: Effect.Effect<ReadonlyArray<TimeSeriesSummary>>;
  readonly get: (name: string) => TimeSeriesHandle;
  /** Consume events appended since the last ingest into points. */
  readonly ingest: (name: string) => Effect.Effect<IngestResult, TimeSeriesNotFound>;
  /** Discard every point and rebuild the series from the whole log. */
  readonly rebuild: (name: string) => Effect.Effect<IngestResult, TimeSeriesNotFound>;
}

/**
 * The value a fraction of the way through the sorted values.
 *
 * Between two order statistics the answer is the straight line between them,
 * so the median of an even number of points is the midpoint of the middle two
 * rather than an arbitrary one of the pair.
 */
const quantileOf = (values: ReadonlyArray<number>, p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = p * (sorted.length - 1);
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return low === high
    ? sorted[low]!
    : sorted[low]! + (at - low) * (sorted[high]! - sorted[low]!);
};

/**
 * What the window's endpoints say, which means sorting by time first.
 *
 * `collect` answers in posting order -- the order the points were written --
 * and a point written late for an early instant would otherwise be taken for
 * the end of the window. The value folds do not care; these do, because they
 * are about when rather than how much.
 *
 * A rate is per second between the first and last instant. One point, or
 * several sharing an instant, spans no time and rates zero rather than
 * dividing by it.
 */
const overTime = (
  op: "first" | "last" | "delta" | "rate",
  points: ReadonlyArray<TimeSeriesPoint>,
): number => {
  const ordered = [...points].sort((a, b) => a.timestamp - b.timestamp);
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  if (op === "first") return first.value;
  if (op === "last") return last.value;
  if (op === "delta") return last.value - first.value;
  const seconds = (last.timestamp - first.timestamp) / 1000;
  return seconds === 0 ? 0 : (last.value - first.value) / seconds;
};

const computeAggregate = (
  op: AggregateOperation,
  points: ReadonlyArray<TimeSeriesPoint>,
  p?: number,
): number => {
  if (op === "count") return points.length;
  if (points.length === 0) return 0;
  const values = points.map((pt) => pt.value);
  switch (op) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "avg":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    case "quantile":
      return quantileOf(values, p!);
    default:
      return overTime(op, points);
  }
};

const validateQuantile = (op: AggregateOperation, p?: number) => {
  if (
    op === "quantile" &&
    (p === undefined || !Number.isFinite(p) || p < 0 || p > 1)
  ) {
    return Effect.die(new RangeError(`A quantile takes p from 0 to 1, not ${p}.`));
  }
  return Effect.void;
};

const SERIES_COLUMN = "zv.timeseries";

/**
 * The column a point's own instant is indexed under, per series.
 *
 * The ordered lens sorts numbers by value, so a window is one range over this
 * column rather than a set of buckets covering it. Per series, so a range never
 * has to say which series it meant twice.
 */
const instantColumn = (series: string) => `${series}@at`;

/**
 * The column a tag is indexed under.
 *
 * Per series and per tag name, so two series using the same tag name for
 * different things do not share a posting list, and so a filter never has to
 * say which series it meant twice.
 */
const tagColumn = (series: string, tag: string) => `${series}#${tag}`;
/** Time series are projections; the prefix keeps them out of the projection listing. */
export const TIME_SERIES_PROJECTION_PREFIX = "zv.timeseries/";

const enc = new TextEncoder();
const dec = new TextDecoder();

const toEpoch = (value: Timestamp): number => {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new TypeError(`Invalid time series timestamp: ${value}`);
  return parsed;
};

const seriesKey = (tenant: TenantId, series: string) => `${tenant}/${series}`;

export const timeSeriesFor = (
  store: ObjectStoreApi,
  projections: ProjectionsApi,
  tenant: TenantId,
): TimeSeriesApi => {
  const definitions = new Map<string, TimeSeriesDefinition>();

  const writePoint = (series: string, point: TimeSeriesPoint) =>
    Effect.gen(function* () {
      const seq = yield* store.nextSeq;
      yield* store.transact((txn) =>
        // No identity: points are appended, never addressed by name. That also
        // keeps them out of the domain event log, so ingesting a series cannot
        // feed itself.
        txn.put(seq, enc.encode(JSON.stringify(point)), {
          terms: [],
          columns: [
            [SERIES_COLUMN, seriesKey(tenant, series)],
            // The instant itself, which the ordered lens sorts by value: one
            // posting, and a window is a range over it.
            [instantColumn(seriesKey(tenant, series)), point.timestamp] as const,
            ...Object.entries(point.tags ?? {}).map(
              ([tag, value]) => [tagColumn(seriesKey(tenant, series), tag), value] as const,
            ),
          ],
          measures: [[seriesKey(tenant, series), point.value]],
          edges: [],
        }),
      );
    }).pipe(Effect.orDie);

  const pointsMatching = (query: Query) =>
    Effect.gen(function* () {
      const seqs = yield* Stream.runCollect(store.resolve(query));
      const out: TimeSeriesPoint[] = [];
      for (const seq of seqs) {
        const object = yield* store.read(seq);
        if (object !== undefined) out.push(JSON.parse(dec.decode(object.bytes)) as TimeSeriesPoint);
      }
      return out;
    }).pipe(Effect.orDie);

  /**
   * The points of a series within a window, as one range over their instants.
   *
   * Exact, so nothing is read that the caller did not ask for and nothing has
   * to be trimmed afterwards. An open end is the series itself, which the
   * series column answers; a window with both ends never touches it, because
   * the instant column is per series already.
   */
  const planWindow = (series: string, start?: number, end?: number): Query => {
    const all = equals(SERIES_COLUMN, seriesKey(tenant, series));
    const column = instantColumn(seriesKey(tenant, series));
    if (start !== undefined && end !== undefined) {
      return end < start ? all : between(column, start, end);
    }
    if (start !== undefined) return and(all, { _tag: "Range", column, lower: { value: start, inclusive: true } });
    if (end !== undefined) return and(all, { _tag: "Range", column, upper: { value: end, inclusive: true } });
    return all;
  };

  /**
   * One clause per named tag, intersected with the window.
   *
   * A tag is an ordinary column lens, so this is the same set intersection a
   * multi-model predicate is — which is why a filtered query over a range too
   * wide to enumerate still costs the tag rather than the series: the window
   * falls back to naming the whole series, and the intersection narrows it
   * again.
   */
  const planRange = (
    series: string,
    start?: number,
    end?: number,
    tags?: TagFilter,
  ): Query => {
    const window = planWindow(series, start, end);
    const entries = Object.entries(tags ?? {});
    if (entries.length === 0) return window;

    const clauses: Query[] = [window];
    for (const [tag, value] of entries) {
      const column = tagColumn(seriesKey(tenant, series), tag);
      const values = Array.isArray(value) ? value : [value as string];
      clauses.push(values.length === 1
        ? equals(column, values[0]!)
        : or(...values.map((v) => equals(column, v))));
    }
    return and(...clauses);
  };

  const collect = (
    series: string,
    start?: Timestamp,
    end?: Timestamp,
    tags?: TagFilter,
  ) =>
    Effect.gen(function* () {
      const from = start === undefined ? undefined : toEpoch(start);
      const to = end === undefined ? undefined : toEpoch(end);
      // The window is exact, so what the lens returns is the answer.
      return yield* pointsMatching(planRange(series, from, to, tags));
    });

  const purge = (series: string) =>
    Effect.gen(function* () {
      const seqs = yield* Stream.runCollect(
        store.resolve(equals(SERIES_COLUMN, seriesKey(tenant, series))),
      );
      for (const seq of seqs) yield* store.transact((txn) => txn.retract(seq));
    }).pipe(Effect.orDie);

  const require_ = (name: string) =>
    definitions.has(name)
      ? Effect.succeed(definitions.get(name)!)
      : Effect.fail(new TimeSeriesNotFound({ name }));

  let emitted = 0;

  const projectionNameOf = (name: string) => `${TIME_SERIES_PROJECTION_PREFIX}${name}`;

  return {
    define: (definition) =>
      Effect.gen(function* () {
        definitions.set(definition.name, definition);
        // A series is a projection over the same log with the same checkpoint
        // machinery; giving it a second one would be two things to keep in step.
        yield* projections.register({
          name: projectionNameOf(definition.name),
          ...(definition.description === undefined ? {} : { description: definition.description }),
          ...(definition.source === undefined ? {} : { source: definition.source }),
          apply: (event) =>
            Effect.gen(function* () {
              const produced = definition.map(event, { series: definition.name });
              if (produced === null || produced === undefined) return;
              const points = Array.isArray(produced) ? produced : [produced as TimeSeriesInputPoint];
              for (const point of points) {
                yield* writePoint(definition.name, {
                  timestamp: toEpoch(point.timestamp),
                  value: point.value,
                  ...(point.tags === undefined ? {} : { tags: point.tags }),
                  ...(point.fields === undefined ? {} : { fields: point.fields }),
                });
                emitted++;
              }
            }),
          reset: () => purge(definition.name),
        });
      }),

    list: Effect.sync(() =>
      [...definitions.values()]
        .map((definition) => ({
          name: definition.name,
          ...(definition.description === undefined ? {} : { description: definition.description }),
          ...(definition.version === undefined ? {} : { version: definition.version }),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ),

    get: (name) => ({
      range: (input) =>
        Effect.gen(function* () {
          const points = yield* collect(name, input?.start, input?.end, input?.tags);
          const ordered = points.sort((a, b) =>
            input?.order === "desc" ? b.timestamp - a.timestamp : a.timestamp - b.timestamp,
          );
          return input?.limit === undefined ? ordered : ordered.slice(0, input.limit);
        }),

      aggregate: (input) =>
        Effect.gen(function* () {
          yield* validateQuantile(input.op, input.p);
          const points = yield* collect(name, input.start, input.end, input.tags);
          return computeAggregate(input.op, points, input.p);
        }),

      windows: (input) =>
        Effect.gen(function* () {
          if (!Number.isFinite(input.interval) || input.interval <= 0) {
            return yield* Effect.die(new RangeError(`interval must be greater than 0, got ${input.interval}.`));
          }
          const step = input.step ?? input.interval;
          if (!Number.isFinite(step) || step <= 0) {
            return yield* Effect.die(new RangeError(`step must be greater than 0, got ${step}.`));
          }
          const op = input.op ?? "avg";
          yield* validateQuantile(op, input.p);

          const points = yield* collect(name, input.start, input.end, input.tags);
          const sorted = [...points].sort((a, b) => a.timestamp - b.timestamp);

          const from = input.start !== undefined
            ? toEpoch(input.start)
            : (sorted.length > 0 ? sorted[0]!.timestamp : undefined);
          const to = input.end !== undefined
            ? toEpoch(input.end)
            : (sorted.length > 0 ? sorted[sorted.length - 1]!.timestamp : undefined);

          if (from === undefined || to === undefined || to < from) {
            return [];
          }

          const fill = input.fill ?? "none";
          type RawBucket = { timestamp: number; value?: number; count: number };
          const buckets: RawBucket[] = [];

          for (let t = from; t <= to; t += step) {
            const windowEnd = t + input.interval;
            const windowPoints = sorted.filter((pt) => pt.timestamp >= t && pt.timestamp < windowEnd);
            if (windowPoints.length > 0) {
              const val = computeAggregate(op, windowPoints, input.p);
              buckets.push({ timestamp: t, value: val, count: windowPoints.length });
            } else {
              buckets.push({ timestamp: t, count: 0 });
            }
          }

          if (fill === "none") {
            return buckets.filter((b) => b.count > 0) as ReadonlyArray<TimeSeriesBucket>;
          }

          if (fill === "zero") {
            return buckets.map((b) => ({
              timestamp: b.timestamp,
              value: b.count > 0 ? b.value! : 0,
              count: b.count,
            }));
          }

          if (fill === "previous") {
            let lastVal = 0;
            let seen = false;
            return buckets.map((b) => {
              if (b.count > 0) {
                lastVal = b.value!;
                seen = true;
                return { timestamp: b.timestamp, value: b.value!, count: b.count };
              }
              return { timestamp: b.timestamp, value: seen ? lastVal : 0, count: 0 };
            });
          }

          if (fill === "linear") {
            const result: TimeSeriesBucket[] = [];
            for (let i = 0; i < buckets.length; i++) {
              const current = buckets[i]!;
              if (current.count > 0) {
                result.push({ timestamp: current.timestamp, value: current.value!, count: current.count });
                continue;
              }
              let prevIdx = -1;
              for (let pIdx = i - 1; pIdx >= 0; pIdx--) {
                if (buckets[pIdx]!.count > 0) {
                  prevIdx = pIdx;
                  break;
                }
              }
              let nextIdx = -1;
              for (let nIdx = i + 1; nIdx < buckets.length; nIdx++) {
                if (buckets[nIdx]!.count > 0) {
                  nextIdx = nIdx;
                  break;
                }
              }

              if (prevIdx !== -1 && nextIdx !== -1) {
                const prev = buckets[prevIdx]!;
                const next = buckets[nextIdx]!;
                const ratio = (current.timestamp - prev.timestamp) / (next.timestamp - prev.timestamp);
                const interpolated = prev.value! + ratio * (next.value! - prev.value!);
                result.push({ timestamp: current.timestamp, value: interpolated, count: 0 });
              } else if (prevIdx !== -1) {
                result.push({ timestamp: current.timestamp, value: buckets[prevIdx]!.value!, count: 0 });
              } else if (nextIdx !== -1) {
                result.push({ timestamp: current.timestamp, value: buckets[nextIdx]!.value!, count: 0 });
              } else {
                result.push({ timestamp: current.timestamp, value: 0, count: 0 });
              }
            }
            return result;
          }

          return buckets.filter((b) => b.count > 0) as ReadonlyArray<TimeSeriesBucket>;
        }),

      moving: (input) =>
        Effect.gen(function* () {
          if (!input.window || typeof input.window !== "object") {
            return yield* Effect.die(new RangeError("window must specify either count or time."));
          }
          const isCount = "count" in input.window;
          const isTime = "time" in input.window;
          if (!isCount && !isTime) {
            return yield* Effect.die(new RangeError("window must specify either count or time."));
          }
          if (isCount && (!Number.isSafeInteger(input.window.count) || input.window.count <= 0)) {
            return yield* Effect.die(new RangeError(`window count must be an integer > 0, got ${input.window.count}.`));
          }
          if (isTime && (!Number.isFinite(input.window.time) || input.window.time <= 0)) {
            return yield* Effect.die(new RangeError(`window time must be > 0, got ${input.window.time}.`));
          }
          const op = input.op ?? "avg";
          yield* validateQuantile(op, input.p);

          const points = yield* collect(name, input.start, input.end, input.tags);
          const sorted = [...points].sort((a, b) => a.timestamp - b.timestamp);

          const out: TimeSeriesPoint[] = [];
          for (let i = 0; i < sorted.length; i++) {
            const current = sorted[i]!;
            let windowPoints: TimeSeriesPoint[];
            if (isCount) {
              const count = input.window.count;
              windowPoints = sorted.slice(Math.max(0, i - count + 1), i + 1);
            } else {
              const timeWindow = input.window.time;
              const windowStart = current.timestamp - timeWindow;
              windowPoints = sorted.slice(0, i + 1).filter((pt) => pt.timestamp >= windowStart);
            }
            const val = computeAggregate(op, windowPoints, input.p);
            out.push({
              timestamp: current.timestamp,
              value: val,
              ...(current.tags === undefined ? {} : { tags: current.tags }),
              ...(current.fields === undefined ? {} : { fields: current.fields }),
            });
          }
          return out;
        }),

      histogram: (input) =>
        Effect.gen(function* () {
          const points = yield* collect(name, input.start, input.end, input.tags);
          if (points.length === 0) {
            return {
              buckets: [],
              count: 0,
              min: 0,
              max: 0,
              sum: 0,
              avg: 0,
            };
          }
          const values = points.map((p) => p.value);
          const minVal = Math.min(...values);
          const maxVal = Math.max(...values);
          const sum = values.reduce((a, b) => a + b, 0);
          const avg = sum / values.length;
          const count = values.length;

          let buckets: HistogramBucket[] = [];

          if (input.boundaries !== undefined) {
            const sorted = [...input.boundaries].sort((a, b) => a - b);
            if (sorted.length < 2) {
              return yield* Effect.die(new RangeError("histogram boundaries must have at least 2 numbers."));
            }
            for (let i = 0; i < sorted.length - 1; i++) {
              const lower = sorted[i]!;
              const upper = sorted[i + 1]!;
              const isLast = i === sorted.length - 2;
              const bCount = values.filter((v) => isLast ? (v >= lower && v <= upper) : (v >= lower && v < upper)).length;
              buckets.push({ lower, upper, count: bCount });
            }
          } else if (input.step !== undefined) {
            if (!Number.isFinite(input.step) || input.step <= 0) {
              return yield* Effect.die(new RangeError(`histogram step must be > 0, got ${input.step}.`));
            }
            const lowerBound = input.min ?? minVal;
            const upperBound = input.max ?? maxVal;
            if (lowerBound === upperBound) {
              buckets.push({ lower: lowerBound, upper: upperBound, count });
            } else {
              for (let b = lowerBound; b < upperBound; b += input.step) {
                const lower = b;
                const upper = Math.min(b + input.step, upperBound);
                const isLast = upper >= upperBound;
                const bCount = values.filter((v) => isLast ? (v >= lower && v <= upper) : (v >= lower && v < upper)).length;
                buckets.push({ lower, upper, count: bCount });
              }
            }
          } else {
            const numBins = input.bins ?? 10;
            if (!Number.isSafeInteger(numBins) || numBins <= 0) {
              return yield* Effect.die(new RangeError(`histogram bins must be an integer > 0, got ${numBins}.`));
            }
            const lowerBound = input.min ?? minVal;
            const upperBound = input.max ?? maxVal;
            if (lowerBound === upperBound) {
              buckets.push({ lower: lowerBound, upper: upperBound, count });
            } else {
              const binWidth = (upperBound - lowerBound) / numBins;
              for (let i = 0; i < numBins; i++) {
                const lower = lowerBound + i * binWidth;
                const upper = i === numBins - 1 ? upperBound : lowerBound + (i + 1) * binWidth;
                const isLast = i === numBins - 1;
                const bCount = values.filter((v) => isLast ? (v >= lower && v <= upper) : (v >= lower && v < upper)).length;
                buckets.push({ lower, upper, count: bCount });
              }
            }
          }

          return {
            buckets,
            count,
            min: minVal,
            max: maxVal,
            sum,
            avg,
          };
        }),

      interpolate: (input) =>
        Effect.gen(function* () {
          if (!Number.isFinite(input.step) || input.step <= 0) {
            return yield* Effect.die(new RangeError(`interpolate step must be > 0, got ${input.step}.`));
          }
          const method = input.method ?? "linear";
          const points = yield* collect(name, input.start, input.end, input.tags);
          if (points.length === 0) return [];

          const sorted = [...points].sort((a, b) => a.timestamp - b.timestamp);
          const from = input.start !== undefined ? toEpoch(input.start) : sorted[0]!.timestamp;
          const to = input.end !== undefined ? toEpoch(input.end) : sorted[sorted.length - 1]!.timestamp;

          if (to < from) return [];

          const out: TimeSeriesPoint[] = [];

          for (let t = from; t <= to; t += input.step) {
            const exact = sorted.find((pt) => pt.timestamp === t);
            if (exact !== undefined) {
              out.push({ timestamp: t, value: exact.value });
              continue;
            }

            if (t < sorted[0]!.timestamp) {
              const val = sorted[0]!.value;
              out.push({ timestamp: t, value: val });
              continue;
            }

            if (t > sorted[sorted.length - 1]!.timestamp) {
              const val = sorted[sorted.length - 1]!.value;
              out.push({ timestamp: t, value: val });
              continue;
            }

            let prev = sorted[0]!;
            let next = sorted[sorted.length - 1]!;
            for (let i = 0; i < sorted.length - 1; i++) {
              if (sorted[i]!.timestamp <= t && sorted[i + 1]!.timestamp >= t) {
                prev = sorted[i]!;
                next = sorted[i + 1]!;
                break;
              }
            }

            if (method === "previous") {
              out.push({ timestamp: t, value: prev.value });
            } else if (method === "next") {
              out.push({ timestamp: t, value: next.value });
            } else {
              const dt = next.timestamp - prev.timestamp;
              const val = dt === 0
                ? prev.value
                : prev.value + ((t - prev.timestamp) / dt) * (next.value - prev.value);
              out.push({ timestamp: t, value: val });
            }
          }

          return out;
        }),
    }),

    ingest: (name) =>
      Effect.gen(function* () {
        yield* require_(name);
        emitted = 0;
        const result = yield* projections.run(projectionNameOf(name)).pipe(Effect.orDie);
        return { name, applied: result.applied, points: emitted };
      }),

    rebuild: (name) =>
      Effect.gen(function* () {
        yield* require_(name);
        emitted = 0;
        const result = yield* projections.rebuild(projectionNameOf(name)).pipe(Effect.orDie);
        return { name, applied: result.applied, points: emitted };
      }),
  } satisfies TimeSeriesApi;
};
