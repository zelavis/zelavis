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
  readonly partition: PartitionKey;
  readonly generation: number;
  readonly seq: Seq;
  readonly version: number;
  readonly bytes: Uint8Array;
  readonly manifest: IndexManifest;
  readonly identity?: ObjectIdentity;
}

export interface ObjectRetracted {
  readonly _tag: "ObjectRetracted";
  readonly cursor: EventCursor;
  readonly partition: PartitionKey;
  readonly generation: number;
  readonly seq: Seq;
  readonly version: number;
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
  columns: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  measures: Schema.Array(Schema.Tuple([Schema.String, Schema.Number])),
  edges: Schema.Array(Schema.Tuple([Schema.String, Schema.Number])),
});

/** The adapter-neutral replication contract. */
export const DbEventWire = Schema.Union([
  Schema.TaggedStruct("ObjectPut", {
    cursor: Schema.String,
    partition: Schema.String,
    generation: Schema.Number,
    seq: Schema.Number,
    version: Schema.Number,
    bytes: Schema.Uint8Array,
    manifest: ManifestWire,
    identity: Schema.optional(
      Schema.Struct({ namespace: Schema.String, key: Schema.String }),
    ),
  }),
  Schema.TaggedStruct("ObjectRetracted", {
    cursor: Schema.String,
    partition: Schema.String,
    generation: Schema.Number,
    seq: Schema.Number,
    version: Schema.Number,
  }),
]);

export interface ReadEventsOptions {
  readonly after?: EventCursor;
  readonly limit?: number;
}
