import { Effect, Stream } from "effect";
import type { StoreError } from "./errors.js";
import { compareKeys, prefixEnd } from "./keys.js";

export interface KvEntry {
  readonly key: Uint8Array;
  readonly value: Uint8Array;
}

export type KvWrite =
  | { readonly op: "put"; readonly key: Uint8Array; readonly value: Uint8Array }
  | { readonly op: "delete"; readonly key: Uint8Array };

/** Byte equality, including an explicit absent-key expectation. */
export interface KvCondition {
  readonly key: Uint8Array;
  readonly value: Uint8Array | undefined;
}

export const equalBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean =>
  a === undefined || b === undefined
    ? a === b
    : a.length === b.length && a.every((byte, index) => byte === b[index]);

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
 * write is one atomic batch. Conditional commits keep their checks inside
 * that batch's destination transaction.
 */
export interface KvEngine {
  readonly get: (key: Uint8Array) => Effect.Effect<Uint8Array | undefined, StoreError>;

  /**
   * Entries under a prefix, ascending unless `reverse`. Membership is the prefix
   * range, never a byte test; `from` and `to` narrow it (see `scanRange`).
   */
  readonly scan: (
    prefix: Uint8Array,
    options?: KvScanOptions,
  ) => Stream.Stream<KvEntry, StoreError>;

  /** Raw trusted batch: every write lands or none does; no ownership check. */
  readonly write: (writes: ReadonlyArray<KvWrite>) => Effect.Effect<void, StoreError>;

  /**
   * Check every expected value and apply the batch in one destination operation.
   * False leaves all keys unchanged. No read-then-unconditional-write fallback.
   * Scope describes coordination, not fsync durability or backup rollback safety.
   */
  readonly conditionalWrite?: (
    writes: ReadonlyArray<KvWrite>,
    conditions: ReadonlyArray<KvCondition>,
  ) => Effect.Effect<boolean, StoreError>;
  readonly coordination?: "engine" | "host" | "remote";

  readonly close: Effect.Effect<void>;
}

/**
 * Narrows a prefix scan, and sets its direction.
 *
 * An ordered lens is read by range, not only by prefix — every value above one
 * bound and below another — and read from either end, because a descending
 * page must not cost an ascending scan of everything before it.
 */
export interface KvScanOptions {
  /** The lowest key returned: inclusive. */
  readonly from?: Uint8Array;
  /** The first key not returned: every key returned sorts below it. */
  readonly to?: Uint8Array;
  /** Highest key first. The same entries as ascending, in the other order. */
  readonly reverse?: boolean;
  /**
   * At most this many entries, the first in scan order. A reader that will stop
   * early says so here, so the engine stops at the source — a SQL `LIMIT`, an
   * iterator it closes — rather than filling a buffer the reader throws away:
   * a stream pulls an iterable thousands of entries at a time.
   */
  readonly limit?: number;
}

/**
 * The half-open key range `[lo, hi)` a scan covers, `hi` undefined meaning the
 * end of the keyspace.
 *
 * A prefix scan is `[prefix, prefixEnd(prefix))`. `from` and `to` only ever
 * narrow that range, never widen it, so a bound that strays outside the prefix
 * cannot carry a scan into another lens.
 */
export const scanRange = (
  prefix: Uint8Array,
  options?: KvScanOptions,
): { readonly lo: Uint8Array; readonly hi: Uint8Array | undefined; readonly empty: boolean } => {
  const lo =
    options?.from !== undefined && compareKeys(options.from, prefix) > 0 ? options.from : prefix;
  let hi = prefixEnd(prefix);
  if (options?.to !== undefined && (hi === undefined || compareKeys(options.to, hi) < 0)) {
    hi = options.to;
  }
  return { lo, hi, empty: hi !== undefined && compareKeys(lo, hi) >= 0 };
};
