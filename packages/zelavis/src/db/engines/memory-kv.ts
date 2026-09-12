import { Effect, Stream } from "effect";
import { scanRange, type KvEngine, type KvEntry, type KvWrite } from "../kv.js";
import { compareKeys } from "../keys.js";
import { openStoreOverKv } from "../kv-store.js";
import type { PartitionKey } from "../model.js";
import type { ObjectStoreApi } from "../store.js";
import type { StoreError } from "../errors.js";

/**
 * A reference engine, sorted in memory.
 *
 * Exists to pin the semantics every other engine has to match: ordering,
 * prefix ranges, and batch atomicity. A driver that disagrees with this one
 * disagrees with the store.
 */
export const memoryKvEngine = (): KvEngine => {
  // A sorted array rather than a Map: the ordering is the contract, so the
  // structure that holds it should be the one that enforces it.
  let entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];

  const indexOf = (key: Uint8Array): number => {
    let lo = 0;
    let hi = entries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const cmp = compareKeys(entries[mid]!.key, key);
      if (cmp === 0) return mid;
      if (cmp < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return ~lo;
  };

  const apply = (write: KvWrite): void => {
    const at = indexOf(write.key);
    if (write.op === "delete") {
      if (at >= 0) entries.splice(at, 1);
      return;
    }
    if (at >= 0) entries[at] = { key: write.key, value: write.value };
    else entries.splice(~at, 0, { key: write.key, value: write.value });
  };

  return {
    get: (key) =>
      Effect.sync(() => {
        const at = indexOf(key);
        return at >= 0 ? entries[at]!.value : undefined;
      }),

    scan: (prefix, options) =>
      Stream.fromIterableEffect(
        Effect.sync(() => {
          const { lo, hi, empty } = scanRange(prefix, options);
          if (empty) return [] as KvEntry[];
          // Both ends by binary search, so a bounded scan copies what it
          // returns rather than the whole range.
          let start = indexOf(lo);
          if (start < 0) start = ~start;
          let end = entries.length;
          if (hi !== undefined) {
            const at = indexOf(hi);
            end = at < 0 ? ~at : at;
          }
          const count = Math.max(0, Math.min(end - start, options?.limit ?? Infinity));
          return options?.reverse
            ? entries.slice(end - count, end).reverse()
            : entries.slice(start, start + count);
        }),
      ),

    write: (writes) =>
      Effect.sync(() => {
        // Applied to a copy, so a failure part-way cannot leave half a batch.
        const snapshot = [...entries];
        try {
          for (const write of writes) apply(write);
        } catch (cause) {
          entries = snapshot;
          throw cause;
        }
      }),

    close: Effect.sync(() => {
      entries = [];
    }),
  };
};

/** The whole store with nothing on disk, for tests and ephemeral workloads. */
export const makeMemoryStore = (
  partition: PartitionKey,
): Effect.Effect<ObjectStoreApi, StoreError> =>
  Effect.gen(function* () {
    const engine = memoryKvEngine();
    return yield* openStoreOverKv(partition, engine);
  });
