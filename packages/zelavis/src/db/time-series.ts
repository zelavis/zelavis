import {
  arrayOf, parseJson, objectFields, isFiniteNumber, isJsonObject, isString, recordOf, optional,
} from "../core/json-validation.js";
import { Effect, Stream } from "effect";
import type { DomainEvent, DomainEventsApi } from "./domain-events.js";
import { consistently } from "./documents.js";
import type { EventCursor } from "./events.js";
import {
  dieUnlessMoving, type TenantMoving, TimeSeriesMapFailed, TimeSeriesNotFound,
} from "./errors.js";
import type { JsonObject } from "./json.js";
import type { Seq } from "./model.js";
import type { ProjectionSource } from "./projections.js";
import { and, between, equals, or, type Query } from "./query.js";
import type { ObjectStoreApi, Txn } from "./store.js";
import { TIME_SERIES_STATE_NAMESPACE } from "./tenancy.js";
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
  /**
   * Consume events appended since the last ingest into points. Each batch of
   * points commits with the place in the log it reached, so an ingest cut off
   * and run again adds every point exactly once. Refused with `TenantMoving`
   * while the tenant is being moved.
   */
  readonly ingest: (name: string) => Effect.Effect<IngestResult, TimeSeriesNotFound | TimeSeriesMapFailed | TenantMoving>;
  /**
   * Rebuild the series from the whole log, beside the points reads use, and
   * replace them with it once it has caught up. Reads see the old series until
   * then; a rebuild cut off leaves it serving and is cleared by the next one.
   */
  readonly rebuild: (name: string) => Effect.Effect<IngestResult, TimeSeriesNotFound | TimeSeriesMapFailed | TenantMoving>;
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
/**
 * Where a series stands, in the partition whose log it consumes.
 *
 * `generation` is the set of points reads use and `cursor` how far into the log
 * it has got. A rebuild writes a new generation (`building`) beside it, which
 * reads never see, and takes its place in the same transaction as its last
 * points; the generation it replaces is `retired` until its points are gone.
 * Every batch of points commits together with the cursor it brings its
 * generation to, so an ingest or rebuild cut off at any moment leaves each
 * generation exactly as far as its cursor says, and running again neither
 * repeats a point nor skips one.
 */
interface SeriesState {
  readonly generation: number;
  readonly cursor?: string;
  readonly building?: { readonly generation: number; readonly cursor?: string };
  readonly retired: ReadonlyArray<number>;
}

const seriesState = objectFields<SeriesState>({
  generation: isFiniteNumber,
  cursor: optional(isString),
  building: optional(objectFields<{ generation: number; cursor?: string }>({
    generation: isFiniteNumber, cursor: optional(isString),
  })),
  retired: arrayOf(isFiniteNumber),
});

const STATE_NAMESPACE = TIME_SERIES_STATE_NAMESPACE;
const FRESH: SeriesState = { generation: 0, retired: [] };

/** A generation's points are told apart by this key; the last `/` separates the generation. */
const generationKey = (series: string, generation: number) => `${series}/${generation}`;

/** Events read from the log at a time. */
const PAGE = 512;
/** Points committed per transaction, with the cursor of the last event they came from. */
const POINT_BATCH = 1024;
/** Retired points removed per transaction. */
const SWEEP_BATCH = 1024;
/**
 * Times a batch may find its generation moved by another run before this one
 * gives up. Each loss means the other run made the progress, so a handful is
 * generous.
 */
const RACE_LIMIT = 16;

const EMPTY_MANIFEST = { terms: [], columns: [], measures: [], edges: [] } as const;

const enc = new TextEncoder();
const dec = new TextDecoder();

const toEpoch = (value: Timestamp): number => {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new TypeError(`Invalid time series timestamp: ${value}`);
  return parsed;
};

const matchesSource = (source: ProjectionSource | undefined, event: DomainEvent): boolean => {
  if (source === undefined) return true;
  if (source.collections !== undefined && source.collections.length > 0
    && !source.collections.includes(event.collection)) return false;
  if (source.eventTypes !== undefined && source.eventTypes.length > 0
    && !source.eventTypes.includes(event.type)) return false;
  return true;
};

const isTags = recordOf(isString);

/**
 * What a definition makes of one event, as stored points — checked here,
 * because a point the reads cannot parse back would fail every read of the
 * series rather than the ingest that wrote it. Throws on what the mapper gets
 * wrong; the caller turns that into `TimeSeriesMapFailed`.
 */
const pointsOf = (definition: TimeSeriesDefinition, event: DomainEvent): ReadonlyArray<TimeSeriesPoint> => {
  const produced = definition.map(event, { series: definition.name });
  if (produced === null || produced === undefined) return [];
  const points = Array.isArray(produced) ? produced : [produced as TimeSeriesInputPoint];
  return points.map((point) => {
    if (!isFiniteNumber(point.value)) throw new TypeError(`a point's value must be a finite number, not ${String(point.value)}`);
    if (point.tags !== undefined && !isTags(point.tags)) throw new TypeError("a point's tags must all be strings");
    if (point.fields !== undefined && !isJsonObject(point.fields)) throw new TypeError("a point's fields must be a JSON object");
    return {
      timestamp: toEpoch(point.timestamp),
      value: point.value,
      ...(point.tags === undefined ? {} : { tags: point.tags }),
      ...(point.fields === undefined ? {} : { fields: point.fields }),
    };
  });
};

/** Which run a batch belongs to: the generation reads use, or the one a rebuild is building. */
type Target = "active" | "building";

export const timeSeriesFor = (
  store: ObjectStoreApi,
  events: DomainEventsApi,
  tenant: TenantId,
): TimeSeriesApi => {
  const definitions = new Map<string, TimeSeriesDefinition>();

  const stateRecord = (series: string) =>
    Effect.gen(function* () {
      const seq = yield* store.lookup(STATE_NAMESPACE, series);
      if (seq === undefined) return { seq: undefined, state: FRESH };
      const object = yield* store.read(seq);
      return {
        seq,
        state: object === undefined ? FRESH : parseJson(dec.decode(object.bytes), seriesState),
      };
    });

  const writeState = (txn: Txn, seq: Seq | undefined, series: string, state: SeriesState) =>
    Effect.gen(function* () {
      yield* txn.put(seq ?? (yield* txn.allocate), enc.encode(JSON.stringify(state)), EMPTY_MANIFEST,
        { namespace: STATE_NAMESPACE, key: series });
    });

  const positionOf = (state: SeriesState, target: Target) =>
    target === "active" ? { generation: state.generation, cursor: state.cursor } : state.building;

  /** A point as stored: indexed under its generation, its instant and its tags. */
  const putPoint = (txn: Txn, key: string, point: TimeSeriesPoint) =>
    Effect.gen(function* () {
      // No identity: points are appended, never addressed by name. That also
      // keeps them out of the domain event log, so ingesting a series cannot
      // feed itself.
      yield* txn.put(yield* txn.allocate, enc.encode(JSON.stringify(point)), {
        terms: [],
        columns: [
          [SERIES_COLUMN, key],
          // The instant itself, which the ordered lens sorts by value: one
          // posting, and a window is a range over it.
          [instantColumn(key), point.timestamp] as const,
          ...Object.entries(point.tags ?? {}).map(([tag, value]) => [tagColumn(key, tag), value] as const),
        ],
        measures: [[key, point.value]],
        edges: [],
      });
    });

  /**
   * Commit a batch of points with the cursor they bring their generation to —
   * provided the generation still stands where they were read from. Read
   * inside the transaction, under the partition's writer, so two runs cannot
   * both commit the same stretch of the log: the second finds the cursor moved
   * and answers false. `finish` makes the generation being built the one reads
   * use, in the same transaction as its last points.
   */
  const commitBatch = (
    series: string,
    target: Target,
    from: { readonly generation: number; readonly cursor?: string },
    points: ReadonlyArray<TimeSeriesPoint>,
    cursor: string | undefined,
    finish: boolean,
  ) =>
    store.transact((txn) =>
      Effect.gen(function* () {
        const { seq, state } = yield* stateRecord(series);
        const at = positionOf(state, target);
        if (at === undefined || at.generation !== from.generation || at.cursor !== from.cursor) return false;
        const key = generationKey(series, from.generation);
        for (const point of points) yield* putPoint(txn, key, point);
        const next: SeriesState = target === "active"
          ? { ...state, ...(cursor === undefined ? {} : { cursor }) }
          : finish
            ? {
                generation: from.generation,
                ...(cursor === undefined ? {} : { cursor }),
                retired: [...state.retired, state.generation],
              }
            : { ...state, building: { generation: from.generation, ...(cursor === undefined ? {} : { cursor }) } };
        yield* writeState(txn, seq, series, next);
        return true;
      }));

  /**
   * Consume the log into a generation, from where its cursor stands to the end.
   *
   * A page of events becomes batches of whole events, each committed with the
   * cursor of the last event it holds; the page's own cursor, which is past the
   * events that did not match as well, goes with the last batch. A page that
   * reached the end with nothing in it moves nothing, because what it passed
   * may be no more than this run's own last commit.
   */
  const drain = (series: string, definition: TimeSeriesDefinition, target: Target) =>
    Effect.gen(function* () {
      let applied = 0;
      let points = 0;
      let races = 0;
      for (;;) {
        const at = positionOf((yield* stateRecord(series)).state, target);
        if (at === undefined) return { applied, points };
        // The cursor came from this partition's own log and is handed back unchanged.
        const page = yield* events.read({
          ...(at.cursor === undefined ? {} : { after: at.cursor as EventCursor }), limit: PAGE,
        });
        let from = at;
        let batch: TimeSeriesPoint[] = [];
        let batched = 0;
        let lost = false;
        for (const event of page.events) {
          if (!matchesSource(definition.source, event)) continue;
          // The mapper is the caller's code: what it gets wrong is reported as
          // a failure naming the event, before anything of this batch is written.
          batch.push(...(yield* Effect.try({
            try: () => pointsOf(definition, event),
            catch: (cause) => new TimeSeriesMapFailed({
              series, eventId: event.eventId, reason: cause instanceof Error ? cause.message : String(cause),
            }),
          })));
          batched += 1;
          if (batch.length < POINT_BATCH) continue;
          if (!(yield* commitBatch(series, target, from, batch, event.cursor, false))) {
            lost = true;
            break;
          }
          applied += batched;
          points += batch.length;
          from = { generation: from.generation, cursor: event.cursor };
          batch = [];
          batched = 0;
        }
        if (!lost) {
          const advance = page.cursor !== undefined && page.cursor !== from.cursor
            && (page.events.length > 0 || page.more);
          const finish = target === "building" && !page.more;
          if (batch.length > 0 || advance || finish) {
            const cursor = advance ? page.cursor : from.cursor;
            if (yield* commitBatch(series, target, from, batch, cursor, finish)) {
              applied += batched;
              points += batch.length;
            } else {
              lost = true;
            }
          }
        }
        if (lost) {
          // Another run moved this generation on; carry on from where it is.
          races += 1;
          if (races > RACE_LIMIT) {
            return yield* Effect.die(new Error(
              `Time series "${series}" of "${tenant}" kept being moved on by another run (${RACE_LIMIT} times).`,
            ));
          }
          continue;
        }
        if (!page.more) return { applied, points };
      }
    });

  /** Remove the points of every retired generation, then the generation from the list. */
  const sweep = (series: string) =>
    Effect.gen(function* () {
      for (const generation of (yield* stateRecord(series)).state.retired) {
        yield* Stream.runForEach(
          Stream.grouped(store.resolve(equals(SERIES_COLUMN, generationKey(series, generation))), SWEEP_BATCH),
          (seqs) => store.transact((txn) => Effect.forEach(seqs, (seq) => txn.retract(seq), { discard: true })),
        );
        yield* store.transact((txn) =>
          Effect.gen(function* () {
            const { seq, state } = yield* stateRecord(series);
            yield* writeState(txn, seq, series, { ...state, retired: state.retired.filter((g) => g !== generation) });
          }));
      }
    });

  /**
   * Start building a new generation. One left by a rebuild that was cut off is
   * retired rather than continued: nothing records which definition it was
   * built with.
   */
  const begin = (series: string) =>
    store.transact((txn) =>
      Effect.gen(function* () {
        const { seq, state } = yield* stateRecord(series);
        const generation = Math.max(state.generation, state.building?.generation ?? 0, ...state.retired) + 1;
        yield* writeState(txn, seq, series, {
          ...state,
          building: { generation },
          retired: state.building === undefined ? state.retired : [...state.retired, state.building.generation],
        });
      }));

  const pointsMatching = (query: Query) =>
    Effect.gen(function* () {
      const seqs = yield* Stream.runCollect(store.resolve(query));
      const out: TimeSeriesPoint[] = [];
      for (const seq of seqs) {
        const object = yield* store.read(seq);
        if (object !== undefined) out.push(parseJson(dec.decode(object.bytes), objectFields<TimeSeriesPoint>({ timestamp: isFiniteNumber, value: isFiniteNumber, tags: optional(recordOf(isString)), fields: optional(isJsonObject) })));
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
  const planWindow = (key: string, start?: number, end?: number): Query => {
    const all = equals(SERIES_COLUMN, key);
    const column = instantColumn(key);
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
    key: string,
    start?: number,
    end?: number,
    tags?: TagFilter,
  ): Query => {
    const window = planWindow(key, start, end);
    const entries = Object.entries(tags ?? {});
    if (entries.length === 0) return window;

    const clauses: Query[] = [window];
    for (const [tag, value] of entries) {
      const column = tagColumn(key, tag);
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
      // Reads see the generation in use, never one a rebuild is still building.
      const { state } = yield* Effect.orDie(stateRecord(series));
      // The window is exact, so what the lens returns is the answer.
      return yield* pointsMatching(planRange(generationKey(series, state.generation), from, to, tags));
    });

  const require_ = (name: string) =>
    definitions.has(name)
      ? Effect.succeed(definitions.get(name)!)
      : Effect.fail(new TimeSeriesNotFound({ name }));


  return {
    define: (definition) =>
      Effect.sync(() => {
        definitions.set(definition.name, definition);
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

    // Each read of a series is one snapshot: its points and their state.
    get: (name) => consistently<TimeSeriesHandle>(store, {
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
        const definition = yield* require_(name);
        return yield* dieUnlessMoving(Effect.gen(function* () {
          yield* sweep(name);
          return { name, ...(yield* drain(name, definition, "active")) };
        }));
      }),

    rebuild: (name) =>
      Effect.gen(function* () {
        const definition = yield* require_(name);
        return yield* dieUnlessMoving(Effect.gen(function* () {
          yield* sweep(name);
          yield* begin(name);
          // Clears what an earlier rebuild left half-built before building again.
          yield* sweep(name);
          const result = yield* drain(name, definition, "building");
          // The generation it replaced.
          yield* sweep(name);
          return { name, ...result };
        }));
      }),
  } satisfies TimeSeriesApi;
};
