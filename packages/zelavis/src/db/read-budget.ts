import { ReadBudgetExceeded } from "./errors.js";
import type { KvReadBudget } from "./kv.js";

/** What one read on another Node may spend. Every field is a hard limit: a read that would pass one is refused whole. */
export interface ReadLimits {
  /** Bytes of stored keys and values copied out of the store. */
  readonly bytes: number;
  /** Entries read from the store: every get and every scanned row counts one. */
  readonly entries: number;
  /** Identifiers expanded out of posting sets, whatever their compressed size. */
  readonly postings: number;
}

export const DEFAULT_READ_LIMITS: ReadLimits = { bytes: 32 * 1024 * 1024, entries: 262_144, postings: 4_194_304 };

/** A read's account: what it has spent against its limits, checked before each spend. */
export interface ReadBudget extends KvReadBudget {
  readonly limits: ReadLimits;
  /** Spends `count` expanded identifiers; throws `ReadBudgetExceeded` (spending nothing) when that would pass the limit. */
  readonly postings: (count: number) => void;
  readonly used: () => ReadLimits;
}

/** A budget with its own counters: one per read, never shared by two reads. */
export const makeReadBudget = (limits: Partial<ReadLimits> = {}): ReadBudget => {
  const max: ReadLimits = { ...DEFAULT_READ_LIMITS, ...limits };
  for (const [name, value] of Object.entries(max)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`The read limit ${name} must be a non-negative safe integer.`);
  }
  let bytes = 0, entries = 0, postings = 0;
  return {
    limits: max,
    remainingEntries: () => max.entries - entries,
    remainingBytes: () => max.bytes - bytes,
    spend: (count, size) => {
      if (count > max.entries - entries) throw new ReadBudgetExceeded({ limit: "entries", max: max.entries });
      if (size > max.bytes - bytes) throw new ReadBudgetExceeded({ limit: "bytes", max: max.bytes });
      entries += count;
      bytes += size;
    },
    postings: (count) => {
      if (count > max.postings - postings) throw new ReadBudgetExceeded({ limit: "postings", max: max.postings });
      postings += count;
    },
    used: () => ({ bytes, entries, postings }),
  };
};
