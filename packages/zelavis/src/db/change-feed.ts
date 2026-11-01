/**
 * The leader's change feed: which partitions were written since a caller last looked, without ever reading the ones
 * that were not.
 *
 * A caller holds a cursor `{ epoch, seq }`. Each write to a partition takes the next `seq`; the feed answers the
 * partitions touched after the caller's `seq`, oldest first, at most one answer's worth at a time. Its cost is the
 * number of changes, never the number of partitions, and its memory is a fixed ring of the most recent touches, so a
 * database of any number of Tenants costs the same to follow as one of a few.
 *
 * A cursor the ring no longer reaches back to, or one from another life of the leader (`epoch` is new every time the
 * database opens), cannot be answered by changes alone: the answer says `resync`, and the follower lists the
 * partitions (paged) and compares each one's head with its own. That is the rare path, and it is exactly as long as
 * the data is.
 */

/** Touches the ring keeps. A follower that falls further behind than this lists the partitions instead. */
export const FEED_RING = 65_536;
/** Partitions one answer names at most. */
export const FEED_PAGE = 1000;

export interface FeedCursor {
  readonly epoch: string;
  readonly seq: number;
}

export interface FeedAnswer {
  /** Where to ask next: the position of the last partition named, or the feed's current position when none is owed. */
  readonly cursor: FeedCursor;
  /** The partitions written since the caller's cursor, oldest touch first, each once. */
  readonly partitions: ReadonlyArray<string>;
  /** The cursor reaches back further than the feed does (or is from another life): list the partitions instead. */
  readonly resync: boolean;
  /** More partitions were touched than this answer names; ask again at once. */
  readonly more: boolean;
}

export interface ChangeFeed {
  readonly epoch: string;
  /** The current position. */
  readonly seq: () => number;
  /** Note that `partition` was written. */
  readonly touch: (partition: string) => void;
  /** The partitions touched since `cursor` (the feed's current position when there is none, which asks for a resync). */
  readonly since: (cursor: FeedCursor | undefined, options?: { readonly limit?: number; readonly only?: ReadonlySet<string> }) => FeedAnswer;
}

export const makeChangeFeed = (options?: { readonly ring?: number; readonly epoch?: string }): ChangeFeed => {
  const ring = options?.ring ?? FEED_RING;
  const epoch = options?.epoch ?? crypto.randomUUID();
  /** Touches in order of `seq`; `start` is the first one still kept. */
  let touches: Array<readonly [number, string]> = [];
  let start = 0;
  let seq = 0;
  /** The latest `seq` of each partition still in the ring: how a stale touch is told from the one that counts. */
  const latest = new Map<string, number>();
  /** The `seq` of the newest touch dropped from the ring: a cursor below it cannot be answered. */
  let floor = 0;

  const touch = (partition: string) => {
    seq += 1;
    touches.push([seq, partition]);
    latest.set(partition, seq);
    while (touches.length - start > ring) {
      const [oldSeq, oldPartition] = touches[start]!;
      start += 1;
      floor = oldSeq;
      if (latest.get(oldPartition) === oldSeq) latest.delete(oldPartition);
    }
    // Drop the consumed head of the array once it is as long as the ring, so memory stays at about twice the ring.
    if (start >= ring) { touches = touches.slice(start); start = 0; }
  };

  /** The index of the first touch with a `seq` above `after` (touches are in order, so a binary search). */
  const firstAfter = (after: number) => {
    let low = start, high = touches.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (touches[middle]![0] <= after) low = middle + 1; else high = middle;
    }
    return low;
  };

  return {
    epoch,
    seq: () => seq,
    touch,
    since: (cursor, query) => {
      if (cursor === undefined || cursor.epoch !== epoch || cursor.seq < floor || cursor.seq > seq) {
        return { cursor: { epoch, seq }, partitions: [], resync: true, more: false };
      }
      const limit = Math.max(1, Math.min(query?.limit ?? FEED_PAGE, FEED_PAGE));
      const out: string[] = [];
      let last = cursor.seq;
      let index = firstAfter(cursor.seq);
      for (; index < touches.length && out.length < limit; index++) {
        const [at, partition] = touches[index]!;
        last = at;
        // Only the partition's latest touch counts, and only if the caller asked about it.
        if (latest.get(partition) !== at) continue;
        if (query?.only !== undefined && !query.only.has(partition)) continue;
        out.push(partition);
      }
      const more = index < touches.length;
      return { cursor: { epoch, seq: more ? last : seq }, partitions: out, resync: false, more };
    },
  };
};
