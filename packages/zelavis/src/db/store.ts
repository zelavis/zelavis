import { Context, Effect, Stream } from "effect";
import type { CursorMismatch, DbError } from "./errors.js";
import type { DbObject, IndexManifest, ObjectIdentity, PartitionKey, Seq } from "./model.js";
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
export interface Txn {
  readonly put: (
    seq: Seq,
    bytes: Uint8Array,
    manifest: IndexManifest,
    identity?: ObjectIdentity,
  ) => Effect.Effect<void, DbError>;

  /** Remove an object and every posting its manifest recorded. */
  readonly retract: (seq: Seq) => Effect.Effect<void, DbError>;
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
}

export interface ObjectStoreApi {
  readonly partition: PartitionKey;

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
    { readonly segments: number; readonly postings: number },
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

  readonly transact: <A, E, R>(
    f: (txn: Txn) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | DbError, R>;

  readonly read: (seq: Seq) => Effect.Effect<DbObject | undefined, DbError>;

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

  /**
   * Resolve a query to identifiers in ascending order.
   *
   * A Stream rather than an array: a prefix match can cover a large fraction of
   * a partition, and a signature that can only return a fully materialized
   * array has no way to express a cursor or a limit.
   */
  readonly resolve: (query: Query) => Stream.Stream<Seq, DbError>;

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
   * Materialize a numeric column as a dense vector indexed by Seq.
   *
   * Aggregation reads the measure after the identifier set is known, never
   * during resolution, so the payload store is not touched until the answer is
   * already small.
   */
  readonly measure: (column: string) => Effect.Effect<Float64Array, DbError>;
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
