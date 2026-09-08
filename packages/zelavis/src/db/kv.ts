import { Effect, Stream } from "effect";
import type { StoreError } from "./errors.js";

export interface KvEntry {
  readonly key: Uint8Array;
  readonly value: Uint8Array;
}

export type KvWrite =
  | { readonly op: "put"; readonly key: Uint8Array; readonly value: Uint8Array }
  | { readonly op: "delete"; readonly key: Uint8Array };

/**
 * An ordered key-value engine.
 *
 * Ordering is the requirement, not a convenience. Postings are sorted runs of
 * identifiers, and intersection walks them in order; an engine that returned
 * keys in arbitrary order would force every scan to be materialized and sorted,
 * which is the allocation the bitmap work exists to avoid.
 *
 * That is why the general-purpose key-value abstractions do not fit here.
 * `unstorage` and `keyv` model an unordered map with pluggable backends — get,
 * set, delete, and at most an unsorted key listing. Neither guarantees range
 * order, both are string-keyed rather than binary, and neither offers an atomic
 * batch. The interface that does match is the LevelDB one (`abstract-level`),
 * which is ordered, binary and batched, and has a RocksDB binding; this stays a
 * local interface so an engine can be written against it directly, with
 * `abstract-level` as one implementation rather than the contract itself.
 *
 * Effect and Stream rather than plain values, so an asynchronous engine is a
 * driver and not a redesign. That is safe here in a way it was not for SQL: a
 * write is one atomic batch, so there is no open transaction another caller
 * could interleave into.
 */
export interface KvEngine {
  readonly get: (key: Uint8Array) => Effect.Effect<Uint8Array | undefined, StoreError>;

  /** Entries under a prefix, ascending. Membership is the prefix range, never a byte test. */
  readonly scan: (prefix: Uint8Array) => Stream.Stream<KvEntry, StoreError>;

  /** Every write lands or none does. This is the whole transaction mechanism. */
  readonly write: (writes: ReadonlyArray<KvWrite>) => Effect.Effect<void, StoreError>;

  readonly close: Effect.Effect<void>;
}
