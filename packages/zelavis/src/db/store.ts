import { Context, Effect, Stream } from "effect";
import type { CursorMismatch, DbError, EventGap, ReplicaDiverged, TenantNotEmpty } from "./errors.js";
import type { DbObject, IndexManifest, ObjectIdentity, PartitionKey, Seq } from "./model.js";
import type { ShardId } from "./topology.js";
import type { AppliedEvent, DbEvent, EventCursor, ReadEventsOptions } from "./events.js";
import type { OrderedValue } from "./keys.js";
import type { Query, RangeBound } from "./query.js";

declare const OrderedCursorBrand: unique symbol;

/**
 * Where an ordered read stopped, to continue from.
 *
 * Opaque like an event cursor, and bound to the partition, column and direction
 * it came from: a position in one order means nothing in another.
 */
export type OrderedCursor = string & { readonly [OrderedCursorBrand]: true };

export interface OrderedReadInput {
  readonly column: string;
  /** Ascending unless `"desc"`. Equal values tie-break by identifier in the same direction. */
  readonly direction?: "asc" | "desc";
  readonly lower?: RangeBound;
  readonly upper?: RangeBound;
  /** Only objects this query also matches. */
  readonly where?: Query;
  /** Rows per page: 100 unless given. */
  readonly limit?: number;
  /** Continue after the page this cursor ended. */
  readonly after?: OrderedCursor;
}

export interface OrderedRow {
  readonly seq: Seq;
  readonly value: OrderedValue;
  /** Continue after this row: a page can end on any row, not only the last. */
  readonly cursor: OrderedCursor;
}

export interface OrderedPage {
  readonly rows: ReadonlyArray<OrderedRow>;
  /** Present only when more rows follow. */
  readonly next?: OrderedCursor;
}

export interface OrderedExtent {
  readonly min?: OrderedValue;
  readonly max?: OrderedValue;
}

/**
 * A write handle scoped to one transaction.
 *
 * Every lens write for an object lands together or none does. A per-key `put`
 * with no batch primitive cannot express that, which means a crash between two
 * lens writes leaves a partial index — exactly the state an "all-or-nothing"
 * guarantee is supposed to prevent.
 */
/** Where a resolve starts and how much of it to read. */
export interface ResolveOptions {
  /** Only identifiers above this one. */
  readonly after?: Seq;
  /** At most this many. */
  readonly limit?: number;
  /**
   * A query every match is known to satisfy — a collection's own postings —
   * which drives a query with no windowed form of its own (a range or prefix
   * alone) a window at a time, checking each candidate. The caller vouches
   * for it: an identifier outside `within` is never returned by the windowed
   * read, but may be once a read falls back to evaluating the query whole.
   */
  readonly within?: Query;
}

export interface Txn {
  readonly put: (
    seq: Seq,
    bytes: Uint8Array,
    manifest: IndexManifest,
    identity?: ObjectIdentity,
  ) => Effect.Effect<void, DbError>;

  /** Remove an object and every posting its manifest recorded. */
  readonly retract: (seq: Seq) => Effect.Effect<void, DbError>;

  /**
   * The next identifier, allocated inside this transaction: a change that
   * creates records commits them and their identifiers together, or neither,
   * and costs no commit of its own per record.
   */
  readonly allocate: Effect.Effect<Seq, DbError>;
}

/**
 * Reading and replicating the log.
 *
 * Continuation is by opaque cursor rather than offset so that physical
 * positions stay inside the driver and cannot be mistaken for a logical order
 * shared across shards.
 */
export interface EventsApi {
  readonly read: (options?: ReadEventsOptions) => Stream.Stream<DbEvent, DbError>;

  /** The newest cursor in this partition, or undefined when the log is empty. */
  readonly head: Effect.Effect<EventCursor | undefined, DbError>;

  /**
   * Apply an event produced elsewhere.
   *
   * Deterministic and idempotent: applying the same event twice leaves the same
   * state, so a follower may safely re-consume an overlapping range after an
   * interruption. This is the follower half of replication and does not make
   * the follower writable.
   */
  readonly apply: (event: AppliedEvent) => Effect.Effect<void, DbError>;

  /**
   * Apply an event read from the same partition's log on its writer, at the
   * position it holds there.
   *
   * What a follower uses to keep the leader's history rather than only its
   * state: the event lands at the leader's position, so the follower's cursors
   * and the leader's mean the same thing. An event at a position the follower
   * already holds is checked against what is there and skipped, and refused as
   * `ReplicaDiverged` when it differs; one past the next position is refused as
   * `EventGap`, because applying it would leave a hole nothing fills.
   */
  readonly follow: (event: DbEvent) => Effect.Effect<void, DbError | EventGap | ReplicaDiverged>;

  /** `follow` for a run of events, in one transaction. */
  readonly followAll: (
    events: ReadonlyArray<DbEvent>,
  ) => Effect.Effect<void, DbError | EventGap | ReplicaDiverged>;
}

/**
 * A record as a partition holds it: what exists, or what is left of something
 * that was retracted — its last version and the position that retracted it,
 * kept so a late event older than the retraction changes nothing.
 */
export type RecordState =
  | {
    readonly live: true;
    readonly version: number;
    readonly identity?: ObjectIdentity;
    readonly manifest: IndexManifest;
    readonly body: Uint8Array;
  }
  | { readonly live: false; readonly version: number; readonly retiredAt: number };

/** What `seed` copied. */
export interface SeedResult {
  /** Records copied, retired ones included. */
  readonly records: number;
  /** The position the copied log continues from: the source's compaction point. */
  readonly head: number;
}

/** What a partition holds, kept as it changes rather than counted when asked. */
export interface PartitionStats {
  /** Records that exist. */
  readonly records: number;
  /** Their bodies' bytes. */
  readonly bytes: number;
  /** The newest position in the log, or 0 when nothing was ever written. */
  readonly head: number;
  /** The position everything at or below has been compacted away. */
  readonly compactedTo: number;
  /** The last identifier handed out, or 0. */
  readonly nextSeq: number;
  /** A seed began here and did not finish: the records are part of a copy. */
  readonly seeding: boolean;
}

export interface ObjectStoreApi {
  /**
   * The partition this handle reads and writes: a tenant, a part of a divided
   * tenant, or one of the reserved partitions. Everything it stores lives in
   * that partition's own key range.
   */
  readonly partition: PartitionKey;

  /** What this partition holds, without reading it. */
  readonly stats: Effect.Effect<PartitionStats, DbError>;

  /**
   * Every record, retired ones included, as stored, in identifier order.
   *
   * Each record is one read, so each is whole; the stream as a whole is not
   * one moment, because writes carry on while it is read. A scan begun at log
   * position `p` and finished at `q`, followed by the events after `p` applied
   * by version, is the partition as of `q` — which is what `seed` relies on.
   */
  readonly records: Stream.Stream<{ readonly seq: Seq; readonly record: RecordState }, DbError>;

  /**
   * Fill this partition, which must hold nothing, from another partition of
   * the same name, keeping its identifiers.
   *
   * Copies every record while the source carries on taking writes, then sets
   * this partition's log at the source's compaction point, so the source's
   * events from there can be applied with `followAll` at the positions they
   * hold on the source: the copy then has the source's state, history and
   * cursors. Refused with `TenantNotEmpty` when this partition holds anything.
   */
  readonly seed: (source: ObjectStoreApi) => Effect.Effect<SeedResult, DbError | TenantNotEmpty>;

  /**
   * The writer generation this handle claimed when it opened.
   *
   * A handle whose generation is no longer current is fenced and its writes are
   * refused, including when the stale and current owners share one node.
   */
  readonly generation: number;

  readonly events: EventsApi;

  /**
   * Re-derive every lens from the event log alone.
   *
   * The log is the source of truth; this is the operation that makes that claim
   * checkable rather than aspirational.
   */
  readonly rebuildLenses: Effect.Effect<number, DbError>;

  /**
   * Finish a rebuild or reindex that an interrupted process left under way, and
   * say which it was; nothing when none was. Until it is finished the
   * partition refuses reads and writes with `LensesRebuilding`, so a database
   * runs this for every partition when it opens.
   */
  readonly resumeMaintenance: Effect.Effect<"rebuild" | "reindex" | undefined, DbError>;

  /**
   * Re-derive the postings from the stored manifests.
   *
   * The operation that still works after compaction, because it reads state
   * rather than history. It cannot detect a corrupt manifest; a full replay is
   * what does that.
   */
  readonly reindexLenses: Effect.Effect<number, DbError>;

  /**
   * Fold the live postings into immutable blobs.
   *
   * A posting stored as a bare key costs one b-tree entry to read, so a wide
   * predicate costs as many as it matches however good the set algebra above
   * it is. A blob covers 65536 identifiers, which turns that into one read per
   * 65536. Writes keep their cheap shape: blobs are never edited, so what is
   * written after a seal lands in the live tier beside them and what is removed
   * from one leaves a tombstone.
   */
  readonly sealPostings: Effect.Effect<
    {
      readonly segments: number;
      readonly postings: number;
      /** Live postings the seal read: every one on a sweep, only changed groups after it. */
      readonly examined: number;
    },
    DbError
  >;

  /**
   * Drop history, keeping the most recent `keep` events.
   *
   * Storage grows with writes rather than with live objects, so this is what
   * decides when a tenant outgrows memory. Cursors older than the point
   * returned here stop being continuable.
   */
  readonly compact: (options?: {
    readonly keep?: number;
  }) => Effect.Effect<{ readonly removed: number; readonly compactedTo: number }, DbError>;

  /** The position everything at or below has been compacted away. */
  readonly compactedTo: Effect.Effect<number, DbError>;

  /**
   * Write the live records down as of the current position, replacing any
   * earlier snapshot.
   *
   * Compaction drops history, which takes away `rebuildLenses` — the operation
   * that re-derives every lens from the log rather than trusting the stored
   * manifests. A snapshot gives it back: state as of a position, and the log
   * from there on. Written in one batch, so an interrupted snapshot leaves the
   * store as it was.
   */
  readonly snapshot: Effect.Effect<
    { readonly records: number; readonly position: number },
    DbError
  >;

  /** The position the stored snapshot covers, or 0 when there is none. */
  readonly snapshotAt: Effect.Effect<number, DbError>;

  /**
   * Every record that still exists, with what it contributed.
   *
   * The snapshot in the plainest form. A backup uses it where the log no longer
   * reaches back far enough to rebuild the tenant from history.
   */
  readonly liveRecords: Effect.Effect<
    ReadonlyArray<{
      readonly seq: Seq;
      readonly version: number;
      readonly bytes: Uint8Array;
      readonly manifest: IndexManifest;
      readonly identity: ObjectIdentity;
    }>,
    DbError
  >;

  /** Allocate the next dense identifier in this partition. */
  readonly nextSeq: Effect.Effect<Seq, DbError>;

  /**
   * Mark every identifier up to `upTo` taken, so the allocator hands out only
   * identifiers above it: what a restore that keeps a backup's identifiers
   * does before writing them.
   */
  readonly reserve: (upTo: Seq) => Effect.Effect<void, DbError>;

  readonly transact: <A, E, R>(
    f: (txn: Txn) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | DbError, R>;

  /**
   * Fence the partition on the shard a move is taking it from: from here every
   * change to it — a transaction, an allocated identifier, applied or followed
   * events, a seed — fails with `TenantMoving`. Reads, upkeep and removal go
   * on. The check is made under the partition's writer, so a change either
   * committed before the fence or is refused; none lands after it.
   */
  readonly fence: (move: { readonly from: string; readonly to: string }) => Effect.Effect<void, DbError>;

  /**
   * Fails with `TenantMoving` when the partition is fenced. Free once the
   * handle knows, which it keeps; for refusing early, before work a commit
   * would refuse anyway.
   */
  readonly writable: Effect.Effect<void, DbError>;

  readonly read: (seq: Seq) => Effect.Effect<DbObject | undefined, DbError>;

  /**
   * What one record contributed to the lenses.
   *
   * `liveRecords` already carries this for every record at once, which is the
   * wrong shape for anything copying a single record: replicating one document
   * would have to read the whole partition to find its manifest. Empty for a
   * record that contributed nothing, and for one that does not exist — `read`
   * is what distinguishes those.
   */
  readonly manifestOf: (seq: Seq) => Effect.Effect<IndexManifest, DbError>;

  /**
   * Resolve a caller's own identifier to the dense one.
   *
   * A `Seq` is an internal, partition-local allocation; applications address
   * records by names of their own. Binding the two here keeps that mapping
   * unique and transactional, rather than leaving each layer above to invent
   * its own index and its own uniqueness rule.
   */
  readonly lookup: (
    namespace: string,
    key: string,
  ) => Effect.Effect<Seq | undefined, DbError>;

  /**
   * The caller's own name for a dense identifier, if it has one.
   *
   * The reverse of `lookup`. A `Seq` means nothing outside its partition, so
   * anything handing an identifier to a caller who is looking at more than one
   * partition has to turn it back into a name first.
   */
  readonly identityOf: (seq: Seq) => Effect.Effect<ObjectIdentity | undefined, DbError>;

  /** Ordered caller identities, used by logical models such as lexicographic KV. */
  readonly scanIdentities: (input: {
    readonly namespace: string;
    readonly prefix?: string;
    readonly lower?: string;
    readonly upper?: string;
    readonly after?: string;
    readonly direction?: "asc" | "desc";
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<{ readonly key: string; readonly seq: Seq }>, DbError>;

  /**
   * Resolve a query to identifiers in ascending order.
   *
   * A Stream rather than an array: a prefix match can cover a large fraction of
   * a partition. Given options — even empty ones — the answer is read a window
   * of identifiers at a time and only as far as it is consumed, so a page after
   * a cursor, or the first few matches, costs about what it returns rather than
   * the whole match; without options, the whole match is resolved at once.
   */
  readonly resolve: (query: Query, options?: ResolveOptions) => Stream.Stream<Seq, DbError>;

  /**
   * A page of objects in the order of their value in one column.
   *
   * Read from the ordered lens in either direction, so a page costs the keys it
   * passes over rather than a sort of everything that matches. `where` filters
   * during the scan: the order holds, but a selective filter over a wide column
   * passes over many keys to fill a page, and that is the cost to expect.
   */
  readonly ordered: (
    input: OrderedReadInput,
  ) => Effect.Effect<OrderedPage, DbError | CursorMismatch>;

  /**
   * The lowest and highest value in a column, among what `where` matches.
   *
   * Null is not a value here: it sorts last, but a column of prices whose
   * highest is null has no highest price. Unfiltered, each end is one key; a
   * filter makes each end cost the keys it passes over before the first match.
   */
  readonly extent: (column: string, where?: Query) => Effect.Effect<OrderedExtent, DbError>;

  /**
   * A numeric column's values, by identifier.
   *
   * Aggregation reads the measure after the identifier set is known, never
   * during resolution, so the payload store is not touched until the answer is
   * already small. Only records that hold a value are present: a record
   * without one is not a zero.
   */
  readonly measure: (column: string) => Effect.Effect<ReadonlyMap<number, number>, DbError>;

  /** Distinct terms indexed under a field, optionally matching a prefix. */
  readonly terms: (field: string, prefix?: string) => Effect.Effect<ReadonlyArray<string>, DbError>;
}

/**
 * One physical shard: one engine, one writer, many partitions.
 *
 * The shard is what a node opens and fences; a partition is what a query and a
 * transaction address. Each partition owns a contiguous key range on the shard,
 * so it can be listed, copied or removed as a range, and nothing written for
 * one partition can be read through another's handle.
 */
export interface ShardStoreApi {
  readonly shard: ShardId;

  /** The writer generation this shard handle claimed when it opened. */
  readonly generation: number;

  /**
   * The handle for one partition on this shard: opened once and kept, because
   * the handle is what admits one writer at a time to that partition.
   */
  readonly partition: (partition: PartitionKey) => ObjectStoreApi;

  /** Every partition holding any key on this shard, in key order. */
  readonly partitions: Effect.Effect<ReadonlyArray<PartitionKey>, DbError>;

  /**
   * Remove a partition — records, log, lenses and meta — in bounded batches.
   * Answers how many records it held.
   *
   * With `keepFence`, the partition's fence stays and the rest goes: a tenant
   * moved off a shard leaves its fence there, so a write still on its way to
   * the old shard is refused rather than landing where nothing reads it.
   */
  readonly drop: (
    partition: PartitionKey,
    options?: { readonly keepFence?: boolean },
  ) => Effect.Effect<number, DbError>;
}

/**
 * The partition handle. One per partition; owns that partition's lenses.
 *
 * Deliberately distinct from `DbObject`. Conflating a record with the store
 * that holds records produces a type carrying both a single `seq` and the
 * lenses for an entire collection, which reads as a record but is constructed
 * once per database.
 */
export class ObjectStore extends Context.Service<ObjectStore, ObjectStoreApi>()(
  "zelavis/db/ObjectStore",
) {}
