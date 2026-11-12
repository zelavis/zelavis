import { Clock, Duration, Effect, Option, Schedule, Schema, Stream, SubscriptionRef } from "effect";
import { integration } from "../core/runtime/effect-boundary.js";
import {
  CursorCompacted, CursorFromAnotherLife, type DbError, EventGap, FollowerBehind, InvalidFollowerRequest, LeaseOwnedByAnother, LeaseStillHeld, LensesRebuilding, LogCompacted, NoWriterLease, NotDesignatedStandby, ReplicaDiverged,
  StoreError, TenantBranching, TenantMoving, TenantRelocated, type PlacementInUse,
} from "./errors.js";
import type { DbEvent, EventCursor } from "./events.js";
import { followLeader, levelFollower, type FollowerAcknowledgments, type FollowerPass, makeFollowerAcknowledgments } from "./followers.js";
import type { ChangeFeed, FeedCursor } from "./change-feed.js";
import { asSeq, type IndexManifest, type ObjectIdentity, type PartitionKey, type Seq } from "./model.js";
import { isReservedTenantId } from "./naming.js";
import type { LeaderSource, ObjectStoreApi, PartitionStats, RecordState, ShardStoreApi } from "./store.js";
import { GLOBAL_TENANT, PLACEMENT_CLASSES, type PlacementClass, type ShardId } from "./topology.js";
import type { PlacementCatalog, SubdivisionCatalog } from "./topology-store.js";

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
/** Partitions whose stats a listing page reads at once. */
const STATS_CONCURRENCY = 8;
/** Partitions a page of the leader's partition listing may hold. */
export const PARTITIONS_PAGE_LIMIT = 1000;
/** Partitions a caller may filter the change feed to: a limit on one request, not on the database. */
export const FEED_FILTER_LIMIT = 10_000;
/** How long the change feed waits for a write unless told, and at most. */
const FEED_DEFAULT_TIMEOUT_MILLIS = 25_000;
const FEED_MAX_TIMEOUT_MILLIS = 60_000;
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
  lineage: Schema.optionalKey(Schema.Array(Schema.Struct({ partition: Schema.String, incarnation: Schema.String, upTo: Schema.Finite }))),
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
const FeedWire = Schema.Struct({
  cursor: Schema.String,
  partitions: Schema.Array(Schema.String),
  resync: Schema.Boolean,
  more: Schema.Boolean,
  /** Moves whenever the leader declares a placement class or divides a Tenant; compared with what the follower last read. */
  declarations: Schema.Finite,
});
const PartitionsWire = Schema.Struct({
  partitions: Schema.Array(Schema.Struct({ partition: Schema.String, head: Schema.Finite, tip: Schema.optionalKey(Schema.String) })),
  next: Schema.optional(Schema.String),
});
const DeclarationsWire = Schema.Struct({
  placements: Schema.Struct({ version: Schema.Finite, collections: Schema.Record(Schema.String, Schema.String) }),
  subdivisions: Schema.Struct({ version: Schema.Finite, tenants: Schema.Record(Schema.String, Schema.Array(Schema.String)) }),
});
/** What the leader declares and a follower must too: which collections are placed how, and which Tenants are divided. They carry no data. */
export interface LeaderDeclarations {
  readonly placements: PlacementCatalog;
  readonly subdivisions: SubdivisionCatalog;
}
/** FNV-1a over bytes: enough to tell two different writes apart, not a digest to trust. */
const fingerprint = (bytes: Uint8Array): string => {
  let result = 0x811c9dc5;
  for (const byte of bytes) result = Math.imul(result ^ byte, 0x01000193) >>> 0;
  return `${bytes.byteLength}.${result.toString(16)}`;
};
/** What identifies the event at a log's tip, read from the store itself; none when the log is empty or compacted past it. */
const tipOf = (store: ObjectStoreApi, head: number, compactedTo: number) =>
  head === 0 || head <= compactedTo
    ? Effect.succeed<string | undefined>(undefined)
    : Effect.gen(function* () {
        const cursor = yield* store.events.head;
        if (cursor === undefined) return undefined;
        const event = [...(yield* Stream.runCollect(store.events.read({ from: cursor, limit: 1 })))][0];
        // The record it touched and, for a write, what it wrote: two writers that each commit the next position in the same
        // millisecond differ here, though not in their position, version or time.
        return event === undefined ? undefined
          : `${event._tag}:${event.origin}:${event.generation}:${event.seq}:${event.version}:${event.at}:${event.identity === undefined ? "" : `${event.identity.namespace}/${event.identity.key}`}:${event._tag === "ObjectPut" ? fingerprint(event.bytes) : ""}`;
      });
export type LeaderFeed = typeof FeedWire.Type;
export type LeaderPartitions = typeof PartitionsWire.Type;

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
 * same tagged error a local one is: a follower re-seeds on `CursorCompacted` and on `CursorFromAnotherLife`,
 * holds on `LogCompacted`.
 */
const CARRIED = {
  CursorCompacted, CursorFromAnotherLife, LogCompacted, EventGap, ReplicaDiverged, TenantMoving, TenantRelocated, LensesRebuilding, TenantBranching,
  LeaseStillHeld, FollowerBehind, LeaseOwnedByAnother, NoWriterLease, NotDesignatedStandby,
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
  readonly feed: (input: { readonly cursor?: string; readonly partitions?: ReadonlyArray<string>; readonly timeoutMillis?: number; readonly declarations?: number }) => Promise<unknown>;
  readonly partitions: (input: { readonly after?: string; readonly limit?: number }) => Promise<unknown>;
  readonly declarations: () => Promise<unknown>;
}

/**
 * A request to the leader. Interruptible: a follower whose leader has gone away (a partition drops packets and the
 * connection just hangs) must still be stoppable, for a standby has to end its following before it is promoted. An
 * abandoned request's late answer is ignored, never applied.
 */
const call = <S extends Schema.Top>(op: string, schema: S, request: () => Promise<unknown>, interruptible = true) =>
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
    releaseLog: (id) => Effect.asVoid(integration(() => transport.release(partition, id), { interruptible: true }).pipe(Effect.catch(failureOfTransport("leader.release")))),
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
    Effect.asVoid(integration(() => transport.acknowledge(partition, { follower, position }), { interruptible: true }).pipe(
      Effect.catch(failureOfTransport("leader.acknowledge")),
    )),
});

export interface RemoteChangesOptions {
  /** Only these partitions. Without it a resync names nothing (the caller lists the partitions itself, or sweeps). */
  readonly partitions?: ReadonlyArray<string>;
  /** How long each request waits for a write before answering nothing new. */
  readonly timeout?: Duration.Input;
  /** How long to wait before asking again after a failed request, doubling to a minute. One second unless given. */
  readonly retry?: Duration.Input;
}

/**
 * The partitions a leader on another host has written, as they are written: each answer names what was touched since
 * the last, so the cost is the changes and not the partitions. A leader that restarted, or a cursor the leader's ring
 * no longer reaches, is a resync: with `partitions` given every one of them is named once (they are the caller's to
 * check), otherwise nothing is, and the caller lists the partitions (`remoteDatabaseLeader`) or sweeps. Failed
 * requests are retried with a capped backoff; the stream ends only when interrupted.
 */
export const remoteChanges = (transport: LeaderTransport, options: RemoteChangesOptions = {}): Stream.Stream<PartitionKey> => {
  let cursor: string | undefined;
  const timeoutMillis = Math.min(FEED_MAX_TIMEOUT_MILLIS, Duration.toMillis(options.timeout ?? FEED_DEFAULT_TIMEOUT_MILLIS));
  const ask = Effect.suspend(() => call("leader.feed", FeedWire, () => transport.feed({
    ...(cursor === undefined ? {} : { cursor }),
    ...(options.partitions === undefined ? {} : { partitions: options.partitions }),
    timeoutMillis: cursor === undefined ? 0 : timeoutMillis,
  }), true)).pipe(
    Effect.map((answer) => {
      cursor = answer.cursor;
      return answer.resync ? [...(options.partitions ?? [])] : [...answer.partitions];
    }),
    Effect.retry(Schedule.min([Schedule.exponential(options.retry ?? "1 second"), Schedule.spaced("1 minute")])),
    Effect.orDie,
  );
  return Stream.flattenIterable(Stream.repeat(Stream.fromEffect(ask), Schedule.forever));
};

/**
 * A leader as a whole database: what a follower of every partition needs. The listing and the feed are the only two
 * ways to learn which partitions there are, and neither reads a partition that did not change.
 */
export interface DatabaseLeader {
  /** What was touched since `cursor`; with none, the current position and a resync. */
  readonly feed: (input: { readonly cursor?: string; readonly timeoutMillis?: number; readonly declarations?: number }) => Effect.Effect<LeaderFeed, DbError | InvalidFollowerRequest>;
  /** The partitions, with their log heads, a page at a time in a stable order. */
  readonly partitions: (input: { readonly after?: string; readonly limit: number }) => Effect.Effect<LeaderPartitions, DbError | InvalidFollowerRequest>;
  readonly source: (partition: PartitionKey) => Effect.Effect<LeaderSource, DbError | InvalidFollowerRequest>;
  /** The placement classes and divisions the leader has declared: read once per resync, never in steady state. */
  readonly declarations: Effect.Effect<LeaderDeclarations, DbError | InvalidFollowerRequest>;
  /** Report what the follower holds of a partition, when the leader keeps acknowledgments. */
  readonly acknowledge?: (partition: PartitionKey, follower: string, position: number) => Effect.Effect<void, DbError | InvalidFollowerRequest>;
}

/** A leader in this process: the same listing, feed and sources, without a transport. */
export const localDatabaseLeader = (followers: FollowersApi): DatabaseLeader => ({
  feed: (input) => followers.feed(input),
  partitions: (input) => followers.partitions(input),
  source: (partition) => followers.source(partition),
  declarations: followers.declarations,
  acknowledge: (partition, follower, position) => Effect.flatMap(followers.acknowledgments(partition), (record) => record.acknowledge(follower, position)),
});

/** One shard's routed data, with no App declarations or follower acknowledgments. */
export const shardLeader = (input: {
  readonly shard: ShardId;
  readonly followers: FollowersApi;
  readonly shardOf: (partition: PartitionKey) => ShardId;
  readonly placementsOf: () => string;
  readonly store: () => ShardStoreApi | undefined;
  readonly routed: (partition: PartitionKey) => ObjectStoreApi;
}): DatabaseLeader => {
  const belongs = (partition: PartitionKey) =>
    partition !== GLOBAL_TENANT && !isReservedTenantId(partition) && input.shardOf(partition) === input.shard;
  const cursorPrefix = () => `${input.placementsOf()}\u0002`;
  const resync = (cursor: string): LeaderFeed => ({ cursor, partitions: [], resync: true, more: false, declarations: 0 });

  return {
    feed: (request) => Effect.gen(function* () {
      const timeout = request.timeoutMillis ?? FEED_DEFAULT_TIMEOUT_MILLIS;
      if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > FEED_MAX_TIMEOUT_MILLIS) {
        return yield* new InvalidFollowerRequest({ partition: "*", reason: `timeoutMillis is 0 to ${FEED_MAX_TIMEOUT_MILLIS}` });
      }
      const prefix = cursorPrefix();
      if (!request.cursor?.startsWith(prefix)) {
        const start = yield* input.followers.feed({ timeoutMillis: 0 });
        return resync(prefix + start.cursor);
      }
      let cursor = request.cursor.slice(prefix.length);
      const deadline = (yield* Clock.currentTimeMillis) + timeout;
      for (;;) {
        const left = Math.max(0, deadline - (yield* Clock.currentTimeMillis));
        const answer = yield* input.followers.feed({ cursor, timeoutMillis: left });
        const current = cursorPrefix();
        if (current !== prefix) return resync(current + answer.cursor);
        const partitions = answer.partitions.filter(belongs);
        if (partitions.length > 0 || answer.resync || answer.more || answer.partitions.length === 0 ||
            (yield* Clock.currentTimeMillis) >= deadline) {
          return { ...answer, cursor: prefix + answer.cursor, partitions, declarations: 0 };
        }
        // Only changes elsewhere were owed. Continue from their position without extending the deadline.
        cursor = answer.cursor;
      }
    }),
    partitions: ({ after, limit }) => Effect.gen(function* () {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > PARTITIONS_PAGE_LIMIT) {
        return yield* new InvalidFollowerRequest({ partition: "*", reason: `a page holds 1 to ${PARTITIONS_PAGE_LIMIT} partitions` });
      }
      const store = input.store();
      if (store === undefined) return yield* new StoreError({ op: "shard-leader.partitions", cause: `shard ${input.shard} is not open` });
      const raw = yield* store.partitionsPage(after, limit);
      const partitions = yield* Effect.forEach(raw.filter(belongs), (partition) => Effect.gen(function* () {
        const routed = input.routed(partition);
        const stats = yield* routed.stats;
        const tip = yield* tipOf(routed, stats.head, stats.compactedTo);
        return { partition, head: stats.head, ...(tip === undefined ? {} : { tip }) };
      }), { concurrency: STATS_CONCURRENCY });
      const next = raw.length === limit ? raw.at(-1) : undefined;
      return { partitions, ...(next === undefined ? {} : { next }) };
    }),
    source: (partition) => Effect.suspend(() => {
      if (belongs(partition)) return input.followers.source(partition);
      const error = new StoreError({ op: "shard-leader.absent", cause: `${partition} is not on ${input.shard}` });
      const absent = Effect.fail(error);
      return Effect.succeed<LeaderSource>({
        partition,
        stats: Effect.succeed({ records: 0, bytes: 0, head: 0, compactedTo: 0, nextSeq: 0, seeding: false }),
        scanRecords: () => absent,
        holdLog: () => absent,
        releaseLog: () => absent,
        snapshotAt: absent,
        scanSnapshot: () => absent,
        events: { read: () => Stream.fail(error) },
      });
    }),
    declarations: Effect.succeed({
      placements: { version: 0, collections: {} }, subdivisions: { version: 0, tenants: {} },
    }),
  };
};

/** A leader on another host, through the leader transport. */
export const remoteDatabaseLeader = (transport: LeaderTransport): DatabaseLeader => ({
  feed: (input) => call("leader.feed", FeedWire, () => transport.feed(input)),
  partitions: (input) => call("leader.partitions", PartitionsWire, () => transport.partitions(input)),
  source: (partition) => Effect.succeed(remoteLeader(transport, partition)),
  declarations: call("leader.declarations", DeclarationsWire, () => transport.declarations()).pipe(
    Effect.flatMap((wire) => {
      const collections: Record<string, PlacementClass> = {};
      for (const [collection, placement] of Object.entries(wire.placements.collections)) {
        if (!PLACEMENT_CLASSES.includes(placement as PlacementClass)) {
          return Effect.fail(new StoreError({ op: "leader.declarations", cause: `the leader declares ${collection} as "${placement}", which is not a placement class` }));
        }
        collections[collection] = placement as PlacementClass;
      }
      return Effect.succeed({
        placements: { version: wire.placements.version, collections },
        subdivisions: wire.subdivisions,
      } satisfies LeaderDeclarations);
    })),
  acknowledge: (partition, follower, position) => remoteAcknowledgments(transport, partition).acknowledge(follower, position),
});

// ---------------------------------------------------------------------------------------------------
// The leader's side.

export interface LeaderFeedInput {
  /** Where the caller last looked (`cursor` of the previous answer); none asks for the current position and a resync. */
  readonly cursor?: string;
  /** Only these partitions. */
  readonly partitions?: ReadonlyArray<string>;
  /** How long to wait for a write when nothing is owed, 0 to 60000 milliseconds; 25000 unless given. */
  readonly timeoutMillis?: number;
  /** The version of the leader's declarations the caller holds (the `declarations` of an earlier answer): a different one is owed at once. */
  readonly declarations?: number;
}
export interface LeaderPartitionsInput {
  readonly after?: string;
  readonly limit?: number;
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
  /**
   * The partitions written since a cursor, waiting up to `timeoutMillis` for a write when none is owed. Its cost is the
   * changes, never the partitions; a cursor it cannot answer (another life of the leader, or further back than its
   * ring) is a `resync`, and the partitions are listed instead.
   */
  readonly feed: (input?: LeaderFeedInput) => Effect.Effect<LeaderFeed, DbError | InvalidFollowerRequest>;
  /** The Tenant partitions with their log heads, `limit` (1 to 1000) at a time in a stable order; `next` continues. */
  readonly partitions: (input?: LeaderPartitionsInput) => Effect.Effect<LeaderPartitions, DbError | InvalidFollowerRequest>;
  /** The placement classes and divisions this database has declared, for a follower to declare too. */
  readonly declarations: Effect.Effect<LeaderDeclarations>;
  /**
   * Keep every partition of this database level with `leader`'s until interrupted: one listing at the start, then only
   * what the leader's feed names, a bounded number at a time, each one leveled (`levelFollower`) and acknowledged. The
   * cost of following is the cost of the changes, whatever the number of Tenants. A leader that cannot be reached is
   * retried with a capped backoff; a partition that cannot be leveled is retried on the next turn.
   */
  readonly followAll: (leader: DatabaseLeader, options: {
    /** What acknowledgments are filed under at the leader. */
    readonly name?: string;
    /** Partitions leveled at once; 8 unless given. */
    readonly concurrency?: number;
    /** How long each feed request waits for a write; 25 seconds unless given. */
    readonly timeoutMillis?: number;
  }) => Effect.Effect<never, DbError | InvalidFollowerRequest>;
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
    : isReservedTenantId(partition) && partition !== GLOBAL_TENANT
      ? Effect.fail(new InvalidFollowerRequest({ partition, reason: "it is reserved" }))
      : Effect.succeed(partition);

export const validFollowerName = (name: unknown): name is string =>
  typeof name === "string" && name.length > 0 && name.length <= FOLLOWER_NAME_LIMIT;

export interface FollowerSide {
  readonly routed: (partition: PartitionKey) => ObjectStoreApi;
  readonly partitionsPage: (after: string | undefined, limit: number) =>
    Effect.Effect<{ readonly partitions: ReadonlyArray<PartitionKey>; readonly next?: string }, DbError>;
  readonly shardFor: (partition: PartitionKey) => ShardStoreApi;
  readonly changed: (partition: PartitionKey) => Effect.Effect<void>;
  readonly remove: (partition: PartitionKey) => Effect.Effect<void, DbError | PlacementInUse>;
  readonly writes: SubscriptionRef.SubscriptionRef<number>;
  readonly declare: (wanted: LeaderDeclarations) => Effect.Effect<void>;
}

export interface FollowTurn {
  /** The time at which this turn began asking the leader for its position. */
  readonly asked: number;
  readonly level: boolean;
  readonly resynced: boolean;
}

export const followPartitions = (
  leader: DatabaseLeader,
  side: FollowerSide,
  options: Parameters<FollowersApi["followAll"]>[1] & { readonly turns?: (turn: FollowTurn) => Effect.Effect<void> },
): Effect.Effect<never, DbError | InvalidFollowerRequest> =>
  Effect.gen(function* () {
    const name = options.name ?? "follower";
    const concurrency = Math.max(1, options.concurrency ?? 8);
    const timeoutMillis = options.timeoutMillis ?? FEED_DEFAULT_TIMEOUT_MILLIS;
    /** Partitions still owed work; past the cap a resync covers them all. */
    const retry = new Set<PartitionKey>();
    const RETRY_CAP = 10_000;
    const RETRY_TURN_MILLIS = 1000;
    let retryOverflow = false;
    const retryPartition = (partition: PartitionKey) => {
      if (retry.size >= RETRY_CAP && !retry.has(partition)) retryOverflow = true;
      else retry.add(partition);
    };

    const level = (partition: PartitionKey) =>
      Effect.gen(function* () {
        const source = yield* leader.source(partition);
        if ((yield* source.stats).incarnation === undefined) {
          // The leader holds nothing by this name: it was dropped there. A copy kept here would bring a removed Tenant back at failover.
          // The App-scoped partition is the database's own data and is never removed, whatever the leader holds of it.
          if (partition !== GLOBAL_TENANT && (yield* side.routed(partition).stats).incarnation !== undefined) {
            yield* side.remove(partition);
            yield* SubscriptionRef.update(side.writes, (count) => count + 1);
            yield* side.changed(partition);
          }
          retry.delete(partition);
          return;
        }
        const pass = yield* levelFollower(source, { shard: side.shardFor(partition), partition });
        if (pass.seeded > 0 || pass.applied > 0) {
          yield* SubscriptionRef.update(side.writes, (count) => count + 1);
          yield* side.changed(partition);
        }
        if (leader.acknowledge !== undefined) {
          yield* leader.acknowledge(partition, name, (yield* side.routed(partition).stats).head);
        }
        if (pass.more) retryPartition(partition);
        else retry.delete(partition);
      }).pipe(Effect.catchCause((cause) => {
        retryPartition(partition);
        return Effect.logWarning(`Following ${partition} could not level it; trying again on the next turn`, cause);
      }));

    const levelAll = (partitions: Iterable<PartitionKey>) =>
      Effect.forEach(partitions, level, { concurrency, discard: true });

    /** The listing: every partition the leader holds, a page at a time, compared with this side's own head. */
    const resync = Effect.gen(function* () {
      let after: string | undefined;
      for (;;) {
        const page = yield* leader.partitions({ ...(after === undefined ? {} : { after }), limit: PARTITIONS_PAGE_LIMIT });
        // Equal lengths are not equal logs: two writers can each have committed one different event at the same position.
        const behind = yield* Effect.filter(page.partitions, ({ partition, head, tip }) =>
          Effect.gen(function* () {
            const routed = side.routed(partition);
            const stats = yield* routed.stats;
            if (stats.head !== head) return true;
            if (tip === undefined) return false;
            const held = yield* tipOf(routed, stats.head, stats.compactedTo);
            return held !== undefined && held !== tip;
          }), { concurrency });
        yield* levelAll(behind.map((entry) => entry.partition));
        // What is level already is held all the same, and the leader may not know it: acknowledgments live with the
        // leader while it is open, so a leader that restarted has none. Telling it costs a call per partition, on the
        // listing only, which is as long as the data and never in steady state.
        if (leader.acknowledge !== undefined) {
          const acknowledge = leader.acknowledge;
          const level = page.partitions.filter((entry) => !behind.includes(entry));
          yield* Effect.forEach(level, (entry) => acknowledge(entry.partition, name, entry.head).pipe(
            Effect.catchCause((cause) => Effect.logWarning(`Acknowledging ${entry.partition} to the leader failed; it is told when the partition next changes`, cause))),
          { concurrency, discard: true });
        }
        if (page.next === undefined) return;
        after = page.next;
      }
    });

    /** Every partition this side holds, a page at a time, asked of the leader: one it no longer holds is removed here (`level`). */
    const prune = Effect.gen(function* () {
      let after: string | undefined;
      for (;;) {
        const page = yield* side.partitionsPage(after, PARTITIONS_PAGE_LIMIT);
        const gone = yield* Effect.filter(page.partitions.filter((partition) => partition !== GLOBAL_TENANT), (partition) =>
          Effect.flatMap(leader.source(partition), (source) => Effect.map(source.stats, (stats) => stats.incarnation === undefined)),
          { concurrency });
        yield* levelAll(gone);
        if (page.next === undefined) return;
        after = page.next;
      }
    });

    /**
     * A leader that cannot be reached is asked again, doubling to five seconds; the follow ends only when interrupted.
     * Short on purpose: a copy that waited out a long backoff after a brief outage of its leader (a restart) would be
     * behind for that long, and a standby's value is how little it is behind when the writer is lost.
     */
    const reachable = <A>(ask: Effect.Effect<A, DbError | InvalidFollowerRequest>) =>
      ask.pipe(Effect.retry(Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("5 seconds")])));

    /** The version of the leader's declarations this side last applied; the feed names a different one the moment it moves. */
    let declared: number | undefined;
    const declare = leader.declarations.pipe(
      Effect.tap((wanted) => side.declare(wanted)),
      Effect.tap((wanted) => Effect.sync(() => { declared = wanted.placements.version + wanted.subdivisions.version; })),
      reachable,
    );

    const turns = options.turns;
    const clock = turns === undefined ? Effect.succeed(0) : Clock.currentTimeMillis;
    let cursor: string | undefined;
    for (;;) {
      if (cursor === undefined || retryOverflow) {
        // The position first, then the listing: whatever is written during the listing is named by the feed after it.
        const asked = yield* clock;
        const start = yield* reachable(leader.feed({ timeoutMillis: 0 }));
        // The listing covers everything, so what failed before is covered; what fails during it is kept.
        retry.clear();
        retryOverflow = false;
        // The declarations first: a divided Tenant's parts and a replicated collection mean nothing here until they are declared.
        yield* declare;
        yield* prune.pipe(reachable);
        yield* resync.pipe(reachable);
        cursor = start.cursor;
        if (turns !== undefined) yield* turns({ asked, level: retry.size === 0 && !retryOverflow, resynced: true });
        continue;
      }
      // A partition still owed work is tried again on this turn, so bound the wait for another write.
      const wait = retry.size > 0 ? Math.min(timeoutMillis, RETRY_TURN_MILLIS) : timeoutMillis;
      const asked = yield* clock;
      const answer = yield* reachable(leader.feed({ cursor, timeoutMillis: wait, ...(declared === undefined ? {} : { declarations: declared }) }));
      if (answer.resync) { cursor = undefined; continue; }
      // A division or a placement declared since: applied now, not at the next resync, so a copy promoted at any moment routes as the leader did.
      if (answer.declarations !== declared) yield* declare;
      yield* levelAll(new Set([...answer.partitions, ...retry]));
      cursor = answer.cursor;
      if (turns !== undefined) yield* turns({ asked, level: retry.size === 0 && !retryOverflow && !answer.more, resynced: false });
    }
  });

export const followersOver = (input: {
  readonly routed: (partition: PartitionKey) => ObjectStoreApi;
  /** The Tenant partitions a page at a time, in a stable order: `next` continues, none ends. */
  readonly partitionsPage: (after: string | undefined, limit: number) => Effect.Effect<{ readonly partitions: ReadonlyArray<PartitionKey>; readonly next?: string }, DbError>;
  /** Which partitions were written, for the feed. */
  readonly feed: ChangeFeed;
  readonly shardFor: (partition: PartitionKey) => ShardStoreApi;
  /** Tells whatever reads a partition (the cross-Tenant indexes) that it changed. */
  readonly changed: (partition: PartitionKey) => Effect.Effect<void>;
  /** Removes a partition this side holds and the leader no longer does: fenced, drained, then dropped. */
  readonly remove: (partition: PartitionKey) => Effect.Effect<void, DbError | PlacementInUse>;
  /** Moves on every write in this process; the change feed waits on it. */
  readonly writes: SubscriptionRef.SubscriptionRef<number>;
  readonly declarations: {
    readonly current: () => LeaderDeclarations;
    /** Declares here what the leader declared and this side lacks; dies on a declaration that contradicts it, which a copy never has. */
    readonly declare: (wanted: LeaderDeclarations) => Effect.Effect<void>;
  };
}): Effect.Effect<FollowersApi> =>
  Effect.gen(function* () {
    const records = new Map<PartitionKey, FollowerAcknowledgments>();

    const decodeCursor = (cursor: string | undefined) => {
      if (cursor === undefined) return undefined;
      const at = cursor.lastIndexOf(":");
      const seq = Number(cursor.slice(at + 1));
      return at > 0 && Number.isSafeInteger(seq) && seq >= 0 ? { epoch: cursor.slice(0, at), seq } : undefined;
    };
    const encodeCursor = (cursor: FeedCursor) => `${cursor.epoch}:${cursor.seq}`;
    /** One number that moves with either catalog, for a follower to notice a declaration without reading both. */
    const declarationsVersion = () => {
      const current = input.declarations.current();
      return current.placements.version + current.subdivisions.version;
    };

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

      feed: (request = {}) =>
        Effect.gen(function* () {
          const timeout = request.timeoutMillis ?? FEED_DEFAULT_TIMEOUT_MILLIS;
          if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > FEED_MAX_TIMEOUT_MILLIS) {
            return yield* new InvalidFollowerRequest({ partition: "*", reason: `timeoutMillis is 0 to ${FEED_MAX_TIMEOUT_MILLIS}` });
          }
          if (request.partitions !== undefined && request.partitions.length > FEED_FILTER_LIMIT) {
            return yield* new InvalidFollowerRequest({ partition: "*", reason: `at most ${FEED_FILTER_LIMIT} partitions in one request` });
          }
          if (request.cursor !== undefined && decodeCursor(request.cursor) === undefined) {
            return yield* new InvalidFollowerRequest({ partition: "*", reason: "cursor is the one a previous answer returned" });
          }
          if (request.declarations !== undefined && (!Number.isSafeInteger(request.declarations) || request.declarations < 0)) {
            return yield* new InvalidFollowerRequest({ partition: "*", reason: "declarations is the version a previous answer returned" });
          }
          const cursor = decodeCursor(request.cursor);
          const only = request.partitions === undefined ? undefined : new Set(request.partitions);
          const deadline = Date.now() + timeout;
          for (;;) {
            // Read the write count before the feed, so a write landing between the two wakes the wait below.
            const seen = yield* SubscriptionRef.get(input.writes);
            const answer = input.feed.since(cursor, { ...(only === undefined ? {} : { only }) });
            const left = deadline - Date.now();
            const owed = answer.resync || answer.partitions.length > 0 || answer.more ||
              (request.declarations !== undefined && request.declarations !== declarationsVersion());
            // A cursor of none is asked for its position and answered at once; waiting is for a cursor that is level.
            if (owed || left <= 0) {
              return { cursor: encodeCursor(answer.cursor), partitions: answer.partitions, resync: answer.resync, more: answer.more, declarations: declarationsVersion() } satisfies LeaderFeed;
            }
            const woke = yield* SubscriptionRef.changes(input.writes).pipe(
              Stream.filter((count) => count !== seen),
              Stream.runHead,
              Effect.timeoutOption(Duration.millis(left)),
            );
            if (Option.isNone(woke)) {
              const final = input.feed.since(cursor, { ...(only === undefined ? {} : { only }) });
              return { cursor: encodeCursor(final.cursor), partitions: final.partitions, resync: final.resync, more: final.more, declarations: declarationsVersion() } satisfies LeaderFeed;
            }
          }
        }),

      partitions: (request = {}) =>
        Effect.gen(function* () {
          const limit = request.limit ?? PARTITIONS_PAGE_LIMIT;
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > PARTITIONS_PAGE_LIMIT) {
            return yield* new InvalidFollowerRequest({ partition: "*", reason: `a page holds 1 to ${PARTITIONS_PAGE_LIMIT} partitions` });
          }
          const page = yield* input.partitionsPage(request.after, limit);
          const heads = yield* Effect.forEach(page.partitions, (partition) =>
            Effect.gen(function* () {
              const routed = input.routed(partition);
              const stats = yield* routed.stats;
              const tip = yield* tipOf(routed, stats.head, stats.compactedTo);
              return { partition, head: stats.head, ...(tip === undefined ? {} : { tip }) };
            }), { concurrency: STATS_CONCURRENCY });
          return { partitions: heads, ...(page.next === undefined ? {} : { next: page.next }) } satisfies LeaderPartitions;
        }),

      declarations: Effect.sync(input.declarations.current),

      followAll: (leader, options) => followPartitions(leader, {
        routed: input.routed, partitionsPage: input.partitionsPage, shardFor: input.shardFor,
        changed: input.changed, remove: input.remove, writes: input.writes, declare: input.declarations.declare,
      }, options),

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
