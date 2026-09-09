import { Schema } from "effect";

declare const SeqBrand: unique symbol;

/**
 * A partition-local object identifier.
 *
 * Dense and monotonic *within its partition*, never globally unique. Density is
 * what keeps posting sets small enough to become bitmaps and keeps range scans
 * sequential; a globally unique id would make both sparse. The global identity
 * of a record is the pair `(PartitionKey, Seq)`.
 */
export type Seq = number & { readonly [SeqBrand]: true };

export const asSeq = (value: number): Seq => value as Seq;

export const SeqFromNumber = Schema.Finite;

/**
 * The declared locality unit.
 *
 * Every object sharing a PartitionKey is guaranteed to live on one node. That
 * guarantee is the whole reason cross-lens intersection is cheap: all lenses
 * address one shared Seq space, so a predicate spanning several data models
 * collapses into a sorted-set intersection instead of a network exchange.
 *
 * An application declares this. The default is the app itself; a SaaS app
 * usually declares its workspace, a social app its user or community.
 */
export type PartitionKey = string;

export const PartitionKeyFromString = Schema.String;

/**
 * A caller-facing name for a record, unique within its namespace.
 *
 * Kept separate from the manifest because it is identity, not a projection: it
 * survives every rewrite of the object, and it is what a follower needs to
 * agree with a leader about which record an event concerns.
 */
export interface ObjectIdentity {
  readonly namespace: string;
  readonly key: string;
}

/** A stored record: an identifier and its encoded bytes. */
export interface DbObject {
  readonly seq: Seq;
  readonly version: number;
  readonly bytes: Uint8Array;
}

/**
 * Everything one object contributed to the lenses.
 *
 * Retraction is the sharp edge of this design: updating or deleting an object
 * must remove every posting its previous version produced, or the lenses return
 * rows that no longer exist. Recomputing that from the old payload would mean a
 * read-and-decode on every write, so each object stores its own retraction set
 * instead.
 */
export interface IndexManifest {
  readonly terms: ReadonlyArray<readonly [field: string, term: string]>;
  readonly columns: ReadonlyArray<readonly [column: string, value: string]>;
  readonly measures: ReadonlyArray<readonly [column: string, value: number]>;
  readonly edges: ReadonlyArray<readonly [edgeType: string, to: Seq]>;
}

export const emptyManifest: IndexManifest = Object.freeze({
  terms: [],
  columns: [],
  measures: [],
  edges: [],
});
