import { Effect, Stream } from "effect";
import { equalBytes, scanRange, type KvEngine, type KvEntry, type KvScanOptions, type KvWrite } from "../kv.js";
import { compareKeys } from "../keys.js";
import { openShardOverKv, type OpenShardOptions } from "../kv-store.js";
import type { ShardStoreApi } from "../store.js";
import type { ShardId } from "../topology.js";
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
  // structure that holds it should be the one that enforces it. A write builds
  // the next array and swaps it in, never changing one in place, so a batch is
  // all or nothing and a snapshot is simply the array it was taken from.
  type Entries = ReadonlyArray<{ readonly key: Uint8Array; readonly value: Uint8Array }>;
  let entries: Entries = [];

  const indexOf = (list: Entries, key: Uint8Array): number => {
    let lo = 0;
    let hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const cmp = compareKeys(list[mid]!.key, key);
      if (cmp === 0) return mid;
      if (cmp < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return ~lo;
  };

  const applied = (writes: ReadonlyArray<KvWrite>): Entries => {
    const next = [...entries];
    for (const write of writes) {
      const at = indexOf(next, write.key);
      if (write.op === "delete") {
        if (at >= 0) next.splice(at, 1);
      } else if (at >= 0) next[at] = { key: write.key, value: write.value };
      else next.splice(~at, 0, { key: write.key, value: write.value });
    }
    return next;
  };

  const readerOver = (list: () => Entries) => ({
    get: (key: Uint8Array) =>
      Effect.sync(() => {
        const at = indexOf(list(), key);
        return at >= 0 ? list()[at]!.value : undefined;
      }),

    scan: (prefix: Uint8Array, options?: KvScanOptions) =>
      Stream.fromIterableEffect(
        Effect.sync(() => {
          const held = list();
          const { lo, hi, empty } = scanRange(prefix, options);
          if (empty) return [] as KvEntry[];
          // Both ends by binary search, so a bounded scan copies what it
          // returns rather than the whole range.
          let start = indexOf(held, lo);
          if (start < 0) start = ~start;
          let end = held.length;
          if (hi !== undefined) {
            const at = indexOf(held, hi);
            end = at < 0 ? ~at : at;
          }
          const count = Math.max(0, Math.min(end - start, options?.limit ?? Infinity));
          return options?.reverse
            ? held.slice(end - count, end).reverse()
            : held.slice(start, start + count);
        }),
      ),
  });

  return {
    ...readerOver(() => entries),

    write: (writes) =>
      Effect.sync(() => {
        entries = applied(writes);
      }),

    conditionalWrite: (writes, conditions) => Effect.sync(() => {
      for (const condition of conditions) {
        const at = indexOf(entries, condition.key);
        if (!equalBytes(at < 0 ? undefined : entries[at]!.value, condition.value)) return false;
      }
      entries = applied(writes);
      return true;
    }),
    coordination: "engine",

    snapshot: Effect.sync(() => {
      const frozen = entries;
      return readerOver(() => frozen);
    }),

    close: Effect.sync(() => {
      entries = [];
    }),
  };
};

/** A whole shard with nothing on disk, for tests and ephemeral workloads. */
export const makeMemoryStore = (
  shard: ShardId,
  options?: OpenShardOptions,
): Effect.Effect<ShardStoreApi, StoreError> =>
  Effect.gen(function* () {
    const engine = memoryKvEngine();
    return yield* openShardOverKv(shard, engine, options);
  });
