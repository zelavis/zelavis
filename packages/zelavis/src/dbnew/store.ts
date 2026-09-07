import { Context, Effect, Stream } from "effect";
import type { DbError } from "./errors.js";
import type { DbObject, IndexManifest, ObjectIdentity, PartitionKey, Seq } from "./model.js";
import type { AppliedEvent, DbEvent, EventCursor, ReadEventsOptions } from "./events.js";
import type { Query } from "./query.js";

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
   * Resolve a query to identifiers in ascending order.
   *
   * A Stream rather than an array: a prefix match can cover a large fraction of
   * a partition, and a signature that can only return a fully materialized
   * array has no way to express a cursor or a limit.
   */
  readonly resolve: (query: Query) => Stream.Stream<Seq, DbError>;

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
  "zelavis/dbnew/ObjectStore",
) {}
