import { Schema } from "effect";
import type { IndexManifest, ObjectIdentity, PartitionKey, Seq } from "./model.js";

declare const CursorBrand: unique symbol;

/**
 * An opaque continuation token.
 *
 * Deliberately not a number. A physical SQLite autoincrement position is only
 * meaningful inside one shard's file, so exposing it invites callers to treat
 * it as a logical global order and to compare positions across shards. The
 * encoding belongs to the driver; callers may only pass a cursor back in.
 */
export type EventCursor = string & { readonly [CursorBrand]: true };

export interface ObjectPut {
  readonly _tag: "ObjectPut";
  readonly cursor: EventCursor;
  /** When the write was accepted, in epoch milliseconds. */
  readonly at: number;
  readonly partition: PartitionKey;
  readonly generation: number;
  /**
   * The node that accepted the write.
   *
   * Carried by the event rather than supplied by whoever reads it, so a
   * follower or a moved partition still says who wrote what.
   */
  readonly origin: string;
  readonly seq: Seq;
  readonly version: number;
  readonly bytes: Uint8Array;
  readonly manifest: IndexManifest;
  readonly identity?: ObjectIdentity;
}

export interface ObjectRetracted {
  readonly _tag: "ObjectRetracted";
  readonly cursor: EventCursor;
  readonly at: number;
  readonly partition: PartitionKey;
  readonly generation: number;
  readonly origin: string;
  readonly seq: Seq;
  readonly version: number;
  /** Identity at deletion time, so a continuation can attribute the change without replaying old puts. */
  readonly identity?: ObjectIdentity;
}

/**
 * The unit of durability and of replication.
 *
 * The log is the source of truth for writes; the lenses are a projection of it.
 * Every event carries enough to be applied by a follower that has never seen
 * the payload, which is what makes the log a replication stream rather than
 * merely an audit trail.
 */
export type DbEvent = ObjectPut | ObjectRetracted;

const ManifestWire = Schema.Struct({
  terms: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  columns: Schema.Array(
    Schema.Tuple([
      Schema.String,
      Schema.Union([Schema.Null, Schema.Boolean, Schema.Finite, Schema.String]),
    ]),
  ),
  measures: Schema.Array(Schema.Tuple([Schema.String, Schema.Finite])),
  edges: Schema.Array(Schema.Tuple([Schema.String, Schema.Finite])),
});

/** The adapter-neutral replication contract. */
export const DbEventWire = Schema.Union([
  Schema.TaggedStruct("ObjectPut", {
    cursor: Schema.String,
    partition: Schema.String,
    generation: Schema.Finite,
    origin: Schema.String,
    at: Schema.Finite,
    seq: Schema.Finite,
    version: Schema.Finite,
    bytes: Schema.Uint8Array,
    manifest: ManifestWire,
    identity: Schema.optional(
      Schema.Struct({ namespace: Schema.String, key: Schema.String }),
    ),
  }),
  Schema.TaggedStruct("ObjectRetracted", {
    cursor: Schema.String,
    partition: Schema.String,
    generation: Schema.Finite,
    origin: Schema.String,
    at: Schema.Finite,
    seq: Schema.Finite,
    version: Schema.Finite,
    identity: Schema.optional(
      Schema.Struct({ namespace: Schema.String, key: Schema.String }),
    ),
  }),
]);

/**
 * An event as it is applied somewhere new, without the cursor it was read at.
 *
 * A cursor is a position in the log that issued it, and an event applied by a
 * restore, a copy or a replica lands wherever the receiving log is up to. A
 * follower that keeps the leader's positions uses `events.follow` instead.
 * Without an `origin`, the receiving store records itself as the writer.
 */
export type AppliedEvent =
  | (Omit<ObjectPut, "cursor" | "origin"> & { readonly origin?: string })
  | (Omit<ObjectRetracted, "cursor" | "origin"> & { readonly origin?: string });

export interface ReadEventsOptions {
  /** Read what follows the event this cursor names. */
  readonly after?: EventCursor;
  /**
   * Read from the event this cursor names, that event included; not with
   * `after`. For a copy comparing the last event it holds with the log it
   * copies, which is how a copy that diverged at its very tip is noticed.
   */
  readonly from?: EventCursor;
  readonly limit?: number;
}
