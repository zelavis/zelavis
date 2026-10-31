import { Duration, Effect, Option, Schedule, Schema, Stream, SubscriptionRef } from "effect";
import { integration } from "../core/runtime/effect-boundary.js";
import {
  CursorCompacted, type DbError, EventGap, InvalidFollowerRequest, LensesRebuilding, LogCompacted, ReplicaDiverged,
  StoreError, TenantBranching, TenantMoving, TenantRelocated,
} from "./errors.js";
import type { DbEvent, EventCursor } from "./events.js";
import { followLeader, type FollowerAcknowledgments, type FollowerPass, makeFollowerAcknowledgments } from "./followers.js";
import { asSeq, type IndexManifest, type ObjectIdentity, type PartitionKey, type Seq } from "./model.js";
import { isReservedTenantId } from "./naming.js";
import type { LeaderSource, ObjectStoreApi, PartitionStats, RecordState, ShardStoreApi } from "./store.js";
import { GLOBAL_TENANT } from "./topology.js";

/**
 * Following a partition from another host: the leader transport.
 *
 * A follower is a copy of a partition kept level from its leader's log (`followers.ts`). Everything a
 * follower pass reads from its leader is a `LeaderSource` — the records a page at a time, the log, and a
 * hold on the log while it copies — and the leader serves exactly that over its versioned API
 * (`/database/followers/*`, `client.followers(projectId)`, `zelavis followers`), so a follower on
 * another host runs the same `levelFollower` and `followLeader` against `remoteLeader(transport)` as one
 * in this process runs against the leader's store.
 *
 * Every call the leader answers is routed where the partition is placed when it arrives, so a hold a
 * remote follower takes is on the leader's own placement, and a move carries it to the target with the
 * partition (`movement.ts`). The follower reports what it holds back to the leader
 * (`remoteAcknowledgments`), only after its own commit, and the leader's `writeAcknowledged` waits on
 * those reports as on any in-process follower's. The leader's change feed (`changes`) answers which
 * partitions moved past the heads a caller knows, waiting for a write when none has; a follower wakes on
 * it instead of polling, and a cross-Tenant index reading a follower's copies wakes when the copy changes.
 *
 * Nothing here carries authority: the leader's routes need `database.replicate`, which the Platform grants
 * with `project.runtime.manage`. Positions, identifiers and cursors are the leader's own, so a cursor taken
 * on one side continues on the other, and everything the follower applies is checked as it is applied
 * (`EventGap`, `ReplicaDiverged`), whatever carried it.
 */

/** Records a page of the leader's records may hold. */
export const LEADER_RECORDS_LIMIT = 512;
/** Log entries a page of the leader's log may hold. */
export const LEADER_LOG_LIMIT = 512;
/** Partitions one answer of the change feed names; `more` says to ask again at once. */
export const CHANGES_LIMIT = 1000;
/** Partitions a caller may say it knows the heads of. */
export const CHANGES_KNOWN_LIMIT = 100_000;
/** How long the change feed waits for a write unless told, and at most. */
const CHANGES_DEFAULT_TIMEOUT_MILLIS = 25_000;
const CHANGES_MAX_TIMEOUT_MILLIS = 60_000;
/** Partitions whose stats the change feed reads at once. */
const STATS_CONCURRENCY = 8;
/** A follower name is what an acknowledgment is filed under. */
const FOLLOWER_NAME_LIMIT = 128;

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const fromBase64 = (value: string) => new Uint8Array(Buffer.from(value, "base64"));

// ---------------------------------------------------------------------------------------------------
// The wire: JSON, bytes as base64, every field checked on the way in.

const Manifest = Schema.Struct({
  terms: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  columns: Schema.Array(Schema.Tuple([Schema.String, Schema.Union([Schema.Null, Schema.Boolean, Schema.Finite, Schema.String])])),
  measures: Schema.Array(Schema.Tuple([Schema.String, Schema.Finite])),
  edges: Schema.Array(Schema.Tuple([Schema.String, Schema.Finite])),
});
const Identity = Schema.Struct({ namespace: Schema.String, key: Schema.String });

const StatsWire = Schema.Struct({
  records: Schema.Finite,
  bytes: Schema.Finite,
  head: Schema.Finite,
  compactedTo: Schema.Finite,
  nextSeq: Schema.Finite,
  seeding: Schema.Boolean,
  incarnation: Schema.optionalKey(Schema.String),
  lineage: Schema.optionalKey(Schema.Array(Schema.Struct({ partition: Schema.String, upTo: Schema.Finite }))),
  leaving: Schema.optionalKey(Schema.Array(Schema.String)),
  asOf: Schema.optionalKey(Schema.Finite),
});

const RecordWire = Schema.Union([
  Schema.Struct({
    seq: Schema.Finite,
    live: Schema.Literal(true),
    version: Schema.Finite,
    identity: Schema.optionalKey(Identity),
    manifest: Manifest,
    body: Schema.String,
  }),
  Schema.Struct({ seq: Schema.Finite, live: Schema.Literal(false), version: Schema.Finite, retiredAt: Schema.Finite }),
]);
const RecordsWire = Schema.Struct({ records: Schema.Array(RecordWire) });

const EventWire = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("ObjectPut"),
    cursor: Schema.String,
    at: Schema.Finite,
    partition: Schema.String,
    generation: Schema.Finite,
    origin: Schema.String,
    seq: Schema.Finite,
    version: Schema.Finite,
    bytes: Schema.String,
    manifest: Manifest,
    identity: Schema.optionalKey(Identity),
  }),
  Schema.Struct({
    _tag: Schema.Literal("ObjectRetracted"),
    cursor: Schema.String,
    at: Schema.Finite,
    partition: Schema.String,
    generation: Schema.Finite,
    origin: Schema.String,
    seq: Schema.Finite,
    version: Schema.Finite,
    identity: Schema.optionalKey(Identity),
  }),
]);
const EventsWire = Schema.Struct({ events: Schema.Array(EventWire) });
const HoldWire = Schema.Struct({ position: Schema.Finite });
const ChangesWire = Schema.Struct({
  heads: Schema.Record(Schema.String, Schema.Finite),
  more: Schema.Boolean,
});

export type RecordPageWire = typeof RecordsWire.Type;
export type EventPageWire = typeof EventsWire.Type;

export const recordToWire = (seq: Seq, record: RecordState): typeof RecordWire.Type =>
  record.live
    ? {
        seq, live: true, version: record.version,
        ...(record.identity === undefined ? {} : { identity: record.identity }),
        manifest: record.manifest as typeof Manifest.Type, body: toBase64(record.body),
      }
    : { seq, live: false, version: record.version, retiredAt: record.retiredAt };

export const eventToWire = (event: DbEvent): typeof EventWire.Type =>
  event._tag === "ObjectPut"
    ? { ...event, manifest: event.manifest as typeof Manifest.Type, bytes: toBase64(event.bytes) }
    : { ...event };

const recordOfWire = (wire: typeof RecordWire.Type): { readonly seq: Seq; readonly record: RecordState } =>
  wire.live
    ? {
        seq: asSeq(wire.seq),
        record: {
          live: true, version: wire.version,
          ...(wire.identity === undefined ? {} : { identity: wire.identity as ObjectIdentity }),
          manifest: wire.manifest as IndexManifest, body: fromBase64(wire.body),
        },
      }
    : { seq: asSeq(wire.seq), record: { live: false, version: wire.version, retiredAt: wire.retiredAt } };

const eventOfWire = (wire: typeof EventWire.Type): DbEvent =>
  wire._tag === "ObjectPut"
    ? {
        ...wire, cursor: wire.cursor as EventCursor, seq: asSeq(wire.seq),
        manifest: wire.manifest as IndexManifest, bytes: fromBase64(wire.bytes),
        ...(wire.identity === undefined ? {} : { identity: wire.identity as ObjectIdentity }),
      }
    : {
        ...wire, cursor: wire.cursor as EventCursor, seq: asSeq(wire.seq),
        ...(wire.identity === undefined ? {} : { identity: wire.identity as ObjectIdentity }),
      };

/**
 * The failures a follower acts on, carried by name (`code`) and fields (`detail`), so a remote one is the
 * same tagged error a local one is: a follower re-seeds on `CursorCompacted`, holds on `LogCompacted`.
 */
const CARRIED = {
  CursorCompacted, LogCompacted, EventGap, ReplicaDiverged, TenantMoving, TenantRelocated, LensesRebuilding, TenantBranching,
} as const;
type CarriedTag = keyof typeof CARRIED;
const isCarried = (tag: string): tag is CarriedTag => Object.hasOwn(CARRIED, tag);

/** A failure as the leader's routes answer it: the message, and for a carried one its name and fields. */
export const followerFailureBody = (error: unknown): { readonly error: string; readonly code?: string; readonly detail?: Record<string, unknown> } => {
  const tag = typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string" ? error._tag : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (tag === undefined || !isCarried(tag)) return { error: message };
  const detail: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error as object)) {
    if (key === "_tag" || key === "message" || key === "stack") continue;
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) detail[key] = value;
  }
  return { error: message, code: tag, detail };
};

/** The tagged error a transport failure carries, or a `StoreError` naming the call. */
const failureOfTransport = (op: string) => (cause: unknown): Effect.Effect<never, DbError> => {
  const thrown = typeof cause === "object" && cause !== null && "cause" in cause ? (cause as { cause: unknown }).cause : cause;
  const body = typeof thrown === "object" && thrown !== null && "body" in thrown ? (thrown as { body: unknown }).body : undefined;
  if (typeof body === "object" && body !== null && "code" in body && typeof body.code === "string" && isCarried(body.code)) {
    const detail = "detail" in body && typeof body.detail === "object" && body.detail !== null ? body.detail : {};
    const tag = body.code;
    return Schema.decodeUnknownEffect(CARRIED[tag] as unknown as Schema.Decoder<DbError>)({ ...detail, _tag: tag }).pipe(
      Effect.mapError(() => new StoreError({ op, cause: `the leader answered ${tag} without its fields` })),
      Effect.flatMap((error) => Effect.fail(error)),
    );
  }
  return Effect.fail(new StoreError({ op, cause: thrown instanceof Error ? thrown.message : String(thrown) }));
};

// ---------------------------------------------------------------------------------------------------
// The transport: what the leader's routes answer, as the SDK's `client.followers(projectId)` presents it.

/**
 * The leader's follower routes as plain calls answering JSON. `client.followers(projectId)` is one, and so is
 * `database.followers` on the runtime API in the leader's own process; anything else that reaches the same
 * routes can be. Answers are checked here, never trusted.
 */
export interface LeaderTransport {
  readonly stats: (partition: string) => Promise<unknown>;
  readonly records: (partition: string, input: { readonly after?: number; readonly limit: number }) => Promise<unknown>;
  readonly log: (partition: string, input: { readonly after?: string; readonly from?: string; readonly limit: number }) => Promise<unknown>;
  readonly hold: (partition: string, input: { readonly id: string; readonly position: number; readonly ttlMillis: number }) => Promise<unknown>;
  readonly release: (partition: string, id: string) => Promise<unknown>;
  readonly acknowledge: (partition: string, input: { readonly follower: string; readonly position: number }) => Promise<unknown>;
  readonly changes: (input: { readonly heads?: Readonly<Record<string, number>>; readonly partitions?: ReadonlyArray<string>; readonly timeoutMillis?: number }) => Promise<unknown>;
}

const call = <S extends Schema.Top>(op: string, schema: S, request: () => Promise<unknown>, interruptible = false) =>
  integration(request, { interruptible }).pipe(
    Effect.catch(failureOfTransport(op)),
    Effect.flatMap((answer) => Schema.decodeUnknownEffect(schema as unknown as Schema.Decoder<S["Type"]>)(answer).pipe(
      Effect.mapError((issue) => new StoreError({ op, cause: `the leader's answer is not what ${op} returns: ${String(issue)}` })),
    )),
  );

/**
 * A leader on another host as a `LeaderSource`: what `levelFollower`, `followLeader` and a seed read from.
 * Snapshot reads (`snapshotAt`, `scanSnapshot`) belong to a branch as of a past position, which is the
 * leader's own operation; a follower never needs them, and they fail here.
 */
export const remoteLeader = (transport: LeaderTransport, partition: PartitionKey): LeaderSource => {
  const unsupported = (op: string) => Effect.fail(new StoreError({ op, cause: "snapshot reads are a branch's, not part of the leader transport" }));
  return {
    partition,
    stats: Effect.map(call("leader.stats", StatsWire, () => transport.stats(partition)), (stats): PartitionStats => stats),
    scanRecords: ({ after, limit }) =>
      Effect.map(
        call("leader.records", RecordsWire, () => transport.records(partition, { ...(after === undefined ? {} : { after }), limit: Math.min(limit, LEADER_RECORDS_LIMIT) })),
        (page) => page.records.map(recordOfWire),
      ),
    holdLog: (input) => call("leader.hold", HoldWire, () => transport.hold(partition, input)),
    releaseLog: (id) => Effect.asVoid(integration(() => transport.release(partition, id)).pipe(Effect.catch(failureOfTransport("leader.release")))),
    snapshotAt: unsupported("leader.snapshotAt"),
    scanSnapshot: () => unsupported("leader.scanSnapshot"),
    events: {
      // A page per call, until the leader has nothing more or the caller's limit is reached.
      read: (options) => {
        const wanted = options?.limit ?? Number.POSITIVE_INFINITY;
        type State = { readonly after?: string; readonly from?: string; readonly left: number };
        const first: State = {
          ...(options?.after === undefined ? {} : { after: options.after }),
          ...(options?.from === undefined ? {} : { from: options.from }),
          left: wanted,
        };
        return Stream.paginate(first, (state: State) => {
          const limit = Math.min(state.left, LEADER_LOG_LIMIT);
          return Effect.map(
            call("leader.log", EventsWire, () => transport.log(partition, {
              ...(state.after === undefined ? {} : { after: state.after }),
              ...(state.from === undefined ? {} : { from: state.from }),
              limit,
            })),
            (page) => {
              const events = page.events.map(eventOfWire);
              const left = state.left - events.length;
              const done = events.length < limit || left <= 0;
              return [events, done ? Option.none() : Option.some({ after: events[events.length - 1]!.cursor, left })] as const;
            },
          );
        });
      },
    },
  };
};

/** Where a follower on another host reports what it holds: the leader's own acknowledgment record. */
export const remoteAcknowledgments = (transport: LeaderTransport, partition: PartitionKey) => ({
  acknowledge: (follower: string, position: number): Effect.Effect<void, DbError> =>
    Effect.asVoid(integration(() => transport.acknowledge(partition, { follower, position })).pipe(
      Effect.catch(failureOfTransport("leader.acknowledge")),
    )),
});

export interface RemoteChangesOptions {
  /** Only these partitions; every Tenant partition the leader holds when omitted. */
  readonly partitions?: ReadonlyArray<string>;
  /** How long each request waits for a write before answering nothing new. */
  readonly timeout?: Duration.Input;
  /** How long to wait before asking again after a failed request, doubling to a minute. One second unless given. */
  readonly retry?: Duration.Input;
}

/**
 * The partitions a leader on another host has written past what this side has seen, as they move: the first
 * answer names every partition holding anything, each later one what moved since. The heads are the
 * leader's durable log heads, so a request lost to the network, or a stream started again, misses nothing —
 * the next answer reports every partition that moved meanwhile. Failed requests are retried with a capped
 * backoff; the stream ends only when interrupted.
 */
export const remoteChanges = (transport: LeaderTransport, options: RemoteChangesOptions = {}): Stream.Stream<PartitionKey> => {
  const heads = new Map<string, number>();
  const timeoutMillis = Math.min(CHANGES_MAX_TIMEOUT_MILLIS, Duration.toMillis(options.timeout ?? CHANGES_DEFAULT_TIMEOUT_MILLIS));
  const ask = Effect.suspend(() => call("leader.changes", ChangesWire, () => transport.changes({
    heads: Object.fromEntries(heads),
    ...(options.partitions === undefined ? {} : { partitions: options.partitions }),
    timeoutMillis,
  }), true)).pipe(
    Effect.map((answer) => {
      const moved: PartitionKey[] = [];
      for (const [partition, head] of Object.entries(answer.heads)) {
        if (head > (heads.get(partition) ?? 0)) moved.push(partition);
        heads.set(partition, Math.max(head, heads.get(partition) ?? 0));
      }
      return moved;
    }),
    Effect.retry(Schedule.min([Schedule.exponential(options.retry ?? "1 second"), Schedule.spaced("1 minute")])),
    Effect.orDie,
  );
  return Stream.flattenIterable(Stream.repeat(Stream.fromEffect(ask), Schedule.forever));
};

// ---------------------------------------------------------------------------------------------------
// The leader's side.

/** What the change feed answers: each partition that moved past what the caller knows, with its head. */
export interface LeaderChanges {
  readonly heads: Readonly<Record<string, number>>;
  /** More partitions moved than one answer names; ask again with these heads at once. */
  readonly more: boolean;
}

export interface LeaderChangesInput {
  /** The heads the caller knows; a partition it does not name counts as at 0. */
  readonly heads?: Readonly<Record<string, number>>;
  /** Only these partitions; every Tenant partition when omitted. */
  readonly partitions?: ReadonlyArray<string>;
  /** How long to wait for a write when nothing has moved, 0 to 60000 milliseconds; 25000 unless given. */
  readonly timeoutMillis?: number;
}

/** The leader side of following, and following into this database. */
export interface FollowersApi {
  /**
   * `partition` as a follower reads it: routed, so every call goes to where the partition is placed when it
   * arrives. Refused for a reserved partition.
   */
  readonly source: (partition: PartitionKey) => Effect.Effect<LeaderSource, InvalidFollowerRequest>;
  /** The record of how far each follower holds `partition`, for `writeAcknowledged`. Kept per partition while the database is open. */
  readonly acknowledgments: (partition: PartitionKey) => Effect.Effect<FollowerAcknowledgments, InvalidFollowerRequest>;
  /** Partitions written past `heads`, waiting up to `timeoutMillis` for a write when none has been. */
  readonly changes: (input?: LeaderChangesInput) => Effect.Effect<LeaderChanges, DbError | InvalidFollowerRequest>;
  /**
   * Keep `partition` here a follower of `leader` until interrupted (`followLeader`), into the shard routing
   * places it on, telling this database's cross-Tenant indexes after every pass that changed it. Writing the
   * partition any other way while it is followed diverges it, and the next pass copies it again from the leader.
   */
  readonly follow: (leader: LeaderSource, options: {
    readonly partition: PartitionKey;
    readonly interval: Duration.Input;
    readonly maxBatches?: number;
    readonly wakeups?: Stream.Stream<unknown, never>;
    readonly acknowledgments?: { readonly name: string; readonly to: { readonly acknowledge: (follower: string, position: number) => Effect.Effect<void, DbError> } };
  }) => Effect.Effect<never, DbError | InvalidFollowerRequest>;
}

export const validFollowerPartition = (partition: string): Effect.Effect<PartitionKey, InvalidFollowerRequest> =>
  typeof partition !== "string" || partition.length === 0 || partition.length > 512
    ? Effect.fail(new InvalidFollowerRequest({ partition: String(partition), reason: "a partition is 1 to 512 characters" }))
    : isReservedTenantId(partition) || partition === GLOBAL_TENANT
      ? Effect.fail(new InvalidFollowerRequest({ partition, reason: "it is reserved" }))
      : Effect.succeed(partition);

export const validFollowerName = (name: unknown): name is string =>
  typeof name === "string" && name.length > 0 && name.length <= FOLLOWER_NAME_LIMIT;

export const followersOver = (input: {
  readonly routed: (partition: PartitionKey) => ObjectStoreApi;
  readonly partitions: Effect.Effect<ReadonlyArray<PartitionKey>, DbError>;
  readonly shardFor: (partition: PartitionKey) => ShardStoreApi;
  /** Tells whatever reads a partition (the cross-Tenant indexes) that it changed. */
  readonly changed: (partition: PartitionKey) => Effect.Effect<void>;
  /** Moves on every write in this process; the change feed waits on it. */
  readonly writes: SubscriptionRef.SubscriptionRef<number>;
}): Effect.Effect<FollowersApi> =>
  Effect.gen(function* () {
    const records = new Map<PartitionKey, FollowerAcknowledgments>();

    const headsOf = (partitions: ReadonlyArray<PartitionKey>) =>
      Effect.forEach(partitions, (partition) => Effect.map(input.routed(partition).stats, (stats) => [partition, stats.head] as const),
        { concurrency: STATS_CONCURRENCY });

    const moved = (request: LeaderChangesInput) =>
      Effect.gen(function* () {
        const known = request.heads ?? {};
        const candidates = request.partitions === undefined
          ? yield* input.partitions
          : yield* Effect.forEach(request.partitions, validFollowerPartition);
        const answer: Record<string, number> = {};
        let count = 0;
        let more = false;
        for (const [partition, head] of yield* headsOf(candidates)) {
          if (head <= (known[partition] ?? 0)) continue;
          if (count === CHANGES_LIMIT) { more = true; break; }
          answer[partition] = head;
          count += 1;
        }
        return { heads: answer, more };
      });

    return {
      source: (partition) => Effect.map(validFollowerPartition(partition), (valid) => input.routed(valid)),

      acknowledgments: (partition) =>
        Effect.flatMap(validFollowerPartition(partition), (valid) => {
          const held = records.get(valid);
          return held !== undefined
            ? Effect.succeed(held)
            : Effect.map(makeFollowerAcknowledgments, (made) => {
                // Two first calls at once may both make one; the first kept wins and both answer it.
                const kept = records.get(valid) ?? made;
                records.set(valid, kept);
                return kept;
              });
        }),

      changes: (request = {}) =>
        Effect.gen(function* () {
          const timeout = request.timeoutMillis ?? CHANGES_DEFAULT_TIMEOUT_MILLIS;
          if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > CHANGES_MAX_TIMEOUT_MILLIS) {
            return yield* new InvalidFollowerRequest({ partition: "*", reason: `timeoutMillis is 0 to ${CHANGES_MAX_TIMEOUT_MILLIS}` });
          }
          if (request.heads !== undefined && Object.keys(request.heads).length > CHANGES_KNOWN_LIMIT) {
            return yield* new InvalidFollowerRequest({ partition: "*", reason: `at most ${CHANGES_KNOWN_LIMIT} known heads` });
          }
          if (request.partitions !== undefined && request.partitions.length > CHANGES_KNOWN_LIMIT) {
            return yield* new InvalidFollowerRequest({ partition: "*", reason: `at most ${CHANGES_KNOWN_LIMIT} partitions` });
          }
          const deadline = Date.now() + timeout;
          for (;;) {
            // Read the write count before the heads, so a write landing between the two wakes the wait below.
            const seen = yield* SubscriptionRef.get(input.writes);
            const answer = yield* moved(request);
            const left = deadline - Date.now();
            if (Object.keys(answer.heads).length > 0 || left <= 0) return answer;
            const woke = yield* SubscriptionRef.changes(input.writes).pipe(
              Stream.filter((count) => count !== seen),
              Stream.runHead,
              Effect.timeoutOption(Duration.millis(left)),
            );
            if (Option.isNone(woke)) return yield* moved(request);
          }
        }),

      follow: (leader, options) =>
        Effect.flatMap(validFollowerPartition(options.partition), (partition) =>
          followLeader(leader, { shard: input.shardFor(partition), partition }, {
            interval: options.interval,
            ...(options.maxBatches === undefined ? {} : { maxBatches: options.maxBatches }),
            ...(options.wakeups === undefined ? {} : { wakeups: options.wakeups }),
            ...(options.acknowledgments === undefined ? {} : { acknowledgments: options.acknowledgments }),
            applied: (_pass: FollowerPass) => Effect.andThen(
              SubscriptionRef.update(input.writes, (count) => count + 1),
              input.changed(partition),
            ),
          })),
    };
  });
