import { Effect, Stream } from "effect";
import type { DomainEvent } from "./domain-events.js";
import { TimeSeriesNotFound } from "./errors.js";
import type { JsonObject } from "./json.js";
import type { ProjectionsApi, ProjectionSource } from "./projections.js";
import { and, equals, or, type Query } from "./query.js";
import type { ObjectStoreApi } from "./store.js";
import type { TenantId } from "./topology.js";

export type AggregateOperation = "avg" | "sum" | "min" | "max" | "count";

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

/**
 * How finely points are bucketed for range queries.
 *
 * The column lens answers equality, not ranges, so a point carries the bucket
 * it falls in and a range query asks for the buckets it spans. Coarser buckets
 * mean fewer clauses per query and more points to discard at the edges.
 */
export type BucketSize = "hour" | "day";

export interface TimeSeriesDefinition {
  readonly name: string;
  readonly description?: string;
  readonly version?: string | number;
  readonly source?: ProjectionSource;
  readonly bucket?: BucketSize;
  readonly map: TimeSeriesMapper;
}

export interface TimeSeriesSummary {
  readonly name: string;
  readonly description?: string;
  readonly version?: string | number;
  readonly bucket: BucketSize;
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
}

export interface TimeSeriesHandle {
  readonly range: (input?: RangeInput) => Effect.Effect<ReadonlyArray<TimeSeriesPoint>>;
  readonly aggregate: (input: AggregateInput) => Effect.Effect<number>;
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

const SERIES_COLUMN = "zv.timeseries";
const BUCKET_COLUMN = "zv.timeseries.bucket";

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

const HOUR = 3_600_000;
const DAY = 86_400_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

const toEpoch = (value: Timestamp): number => {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new TypeError(`Invalid time series timestamp: ${value}`);
  return parsed;
};

const widthOf = (bucket: BucketSize) => (bucket === "hour" ? HOUR : DAY);

const bucketOf = (timestamp: number, bucket: BucketSize): number =>
  Math.floor(timestamp / widthOf(bucket));

/**
 * How many finer buckets make up the next coarser one.
 *
 * A point is indexed at every level, so a range is covered by whole coarse
 * blocks in the middle and finer ones at the edges — the same shape as any
 * interval cover. Eight keeps the edges cheap: at most seven blocks per level
 * on each side, whatever the range.
 */
const LEVEL_FACTOR = 8;

/**
 * Levels of bucket, from the series' own width upward.
 *
 * Five of them reaches 8^4 base buckets — about eleven years of days, or five
 * months of hours — in a single clause, and a longer range asks for several of
 * the top level rather than falling back to the whole series.
 *
 * The cost is one posting per level on every point written. Postings are keys
 * with no value and fold into blobs when a store is sealed, so this trades a
 * little write amplification for the difference between a bounded query and a
 * scan.
 */
const BUCKET_LEVELS = 5;

/**
 * The point at which a range gives up naming buckets and reads the series.
 *
 * With levels this is a backstop rather than a working limit: a cover needs at
 * most a couple of dozen clauses for any range a caller would write. It stays
 * because a query built from thousands of clauses would cost more to evaluate
 * than the scan it was meant to avoid, and nothing stops a caller asking for a
 * range of a million years.
 */
const MAX_BUCKET_CLAUSES = 400;

const widthAt = (level: number) => LEVEL_FACTOR ** level;

/** The block at `level` holding a base bucket. Floors, so it holds for negatives. */
const blockOf = (bucket: number, level: number) => Math.floor(bucket / widthAt(level));

/**
 * The fewest whole blocks covering `[first, last]`.
 *
 * Greedy from the low end: take the largest block that starts exactly here and
 * ends no later than the range does, then continue from where it ended. That is
 * the standard interval cover, and it is exact — every base bucket in the range
 * falls in one block, and no block reaches outside it.
 */
export const coverBuckets = (
  first: number,
  last: number,
): ReadonlyArray<readonly [number, number]> => {
  const blocks: Array<readonly [number, number]> = [];
  let at = first;
  while (at <= last) {
    let level = 0;
    while (level + 1 < BUCKET_LEVELS) {
      const width = widthAt(level + 1);
      const start = Math.floor(at / width) * width;
      if (start !== at || at + width - 1 > last) break;
      level += 1;
    }
    blocks.push([level, blockOf(at, level)]);
    at += widthAt(level);
  }
  return blocks;
};

const seriesKey = (tenant: TenantId, series: string) => `${tenant}/${series}`;

/** `<series>@<level>:<block>` — the level is in the value, so one column holds all of them. */
const bucketValue = (series: string, level: number, block: number) =>
  `${series}@${level}:${block}`;

export const timeSeriesFor = (
  store: ObjectStoreApi,
  projections: ProjectionsApi,
  tenant: TenantId,
): TimeSeriesApi => {
  const definitions = new Map<string, TimeSeriesDefinition>();

  const bucketFor = (name: string): BucketSize => definitions.get(name)?.bucket ?? "day";

  const writePoint = (series: string, point: TimeSeriesPoint) =>
    Effect.gen(function* () {
      const seq = yield* store.nextSeq;
      const bucket = bucketOf(point.timestamp, bucketFor(series));
      yield* store.transact((txn) =>
        // No identity: points are appended, never addressed by name. That also
        // keeps them out of the domain event log, so ingesting a series cannot
        // feed itself.
        txn.put(seq, enc.encode(JSON.stringify(point)), {
          terms: [],
          columns: [
            [SERIES_COLUMN, seriesKey(tenant, series)],
            // One posting per level, so a range can ask for whole coarse blocks
            // instead of naming every base bucket it spans.
            ...Array.from({ length: BUCKET_LEVELS }, (_, level) =>
              [
                BUCKET_COLUMN,
                bucketValue(seriesKey(tenant, series), level, blockOf(bucket, level)),
              ] as const),
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

  const planWindow = (series: string, start?: number, end?: number): Query => {
    const all = equals(SERIES_COLUMN, seriesKey(tenant, series));
    if (start === undefined || end === undefined) return all;
    const size = bucketFor(series);
    const first = bucketOf(start, size);
    const last = bucketOf(end, size);
    if (last < first) return all;
    const blocks = coverBuckets(first, last);
    if (blocks.length > MAX_BUCKET_CLAUSES) return all;
    const key = seriesKey(tenant, series);
    const clauses = blocks.map(([level, block]) =>
      equals(BUCKET_COLUMN, bucketValue(key, level, block)));
    return clauses.length === 1 ? clauses[0]! : or(...clauses);
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
      const points = yield* pointsMatching(planRange(series, from, to, tags));
      // Buckets are coarse, so the exact bounds are applied to what they return.
      return points.filter(
        (p) => (from === undefined || p.timestamp >= from) && (to === undefined || p.timestamp <= to),
      );
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
          bucket: definition.bucket ?? ("day" as BucketSize),
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
          const points = yield* collect(name, input.start, input.end, input.tags);
          if (input.op === "count") return points.length;
          if (points.length === 0) return 0;
          const values = points.map((p) => p.value);
          switch (input.op) {
            case "sum":
              return values.reduce((a, b) => a + b, 0);
            case "avg":
              return values.reduce((a, b) => a + b, 0) / values.length;
            case "min":
              return Math.min(...values);
            case "max":
              return Math.max(...values);
          }
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
