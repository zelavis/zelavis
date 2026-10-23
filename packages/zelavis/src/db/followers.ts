import { type Duration, Effect, Stream } from "effect";
import { type DbError, ReplicaDiverged } from "./errors.js";
import type { PartitionKey } from "./model.js";
import type { ObjectStoreApi, ShardStoreApi } from "./store.js";

/**
 * Keeping a follower partition level with its leader.
 *
 * A follower is a copy of a partition under the same name on another shard:
 * the leader's records, identifiers and log positions, verbatim, so a cursor
 * taken on one continues on the other. It is made by `seed` — the leader's
 * records, read while it keeps taking writes — and kept level by `followAll`
 * from its own head, which is a cursor the leader understands. A follower is
 * never written any other way, and holds no writer authority of its own.
 *
 * Carrying on from the follower's head is the cheap path and the usual one.
 * Copying again from the start is the answer only where carrying on cannot be
 * exact: nothing copied yet, a seed that never finished, a leader that has
 * compacted past the follower's head and so can no longer say what came
 * after it, or a follower holding a different event at a position it shares
 * with the leader. Each of those is reported, never repaired in place.
 */

/** Why a pass copied the follower from the start instead of carrying it on. */
export type FollowerSeed =
  /** Asked for: a fresh copy, whatever the follower held. */
  | "fresh"
  /** The follower held nothing. */
  | "empty"
  /** A seed was cut off before its last batch, so what is there is part of a copy. */
  | "unfinished"
  /** The leader compacted past the follower's head. */
  | "compacted"
  /** The follower holds a different event at a position it shares with the leader. */
  | "diverged";

export interface FollowerPass {
  /** Records the pass copied by seeding, 0 when it carried the follower on. */
  readonly seeded: number;
  /** Log entries applied from the leader's log. */
  readonly applied: number;
  /** The pass stopped at its batch limit with the leader further on. */
  readonly more: boolean;
  /** Why the follower was copied from the start, when it was. */
  readonly seed?: FollowerSeed;
}

export interface FollowerOptions {
  /** Copy the follower from the start whatever it holds. */
  readonly fresh?: boolean;
  /**
   * Batches of the leader's log a pass applies before it stops and reports
   * `more`. A leader written faster than it can be followed would otherwise
   * keep one pass going for ever; the caller decides what to do then.
   */
  readonly maxBatches?: number;
}

/** Log entries read from the leader and applied per batch. */
const FOLLOW_BATCH = 512;

/** Batches per pass unless the caller says otherwise. */
const MAX_BATCHES = 64;

/**
 * Apply what the leader has logged past the follower's head, a batch at a
 * time, until it has nothing more or the pass reaches its batch limit.
 *
 * The first batch starts at the follower's own last position whenever the
 * leader still holds it, so `followAll` compares the two: a follower holding a
 * different event at its very tip is caught there, not only once the leader
 * has written past it. Fails with `CursorCompacted` when the leader no longer
 * holds the follower's next position, and with `ReplicaDiverged` or
 * `EventGap` when the follower's log does not continue the leader's: each
 * means carrying on cannot be exact.
 */
export const catchUpFollower = (
  leader: ObjectStoreApi,
  follower: ObjectStoreApi,
  options?: { readonly maxBatches?: number },
) =>
  Effect.gen(function* () {
    const limit = options?.maxBatches ?? MAX_BATCHES;
    const tip = (yield* follower.stats).head;
    // The leader's event at the tip is gone once it compacts past it; then
    // there is nothing to compare, and carrying on from the tip is still exact.
    let compareTip = tip > 0 && tip > (yield* leader.stats).compactedTo;
    let applied = 0;
    for (let batches = 0; batches < limit; batches++) {
      const head = yield* follower.events.head;
      const batch = [...(yield* Stream.runCollect(leader.events.read({
        ...(head === undefined ? {} : compareTip ? { from: head } : { after: head }),
        limit: FOLLOW_BATCH,
      })))];
      if (compareTip && batch.length === 0) {
        // The leader holds nothing at a position the follower does: the
        // follower is ahead of it, which no copy of it can be.
        return yield* new ReplicaDiverged({ partition: follower.partition, position: tip });
      }
      const compared = compareTip ? 1 : 0;
      compareTip = false;
      if (batch.length === 0) return { applied, more: false };
      // The tip alone is still applied: that is where it is compared.
      yield* follower.events.followAll(batch);
      applied += batch.length - compared;
      if (batch.length < FOLLOW_BATCH) return { applied, more: false };
    }
    return { applied, more: true };
  });

/**
 * One pass bringing the follower `partition` on `shard` level with `leader`:
 * carried on from its head where that can be exact, copied from the start
 * where it cannot (see `FollowerSeed`).
 */
export const levelFollower = (
  leader: ObjectStoreApi,
  follower: { readonly shard: ShardStoreApi; readonly partition: PartitionKey },
  options?: FollowerOptions,
): Effect.Effect<FollowerPass, DbError> =>
  Effect.gen(function* () {
    const store = follower.shard.partition(follower.partition);
    const limit = options?.maxBatches === undefined ? {} : { maxBatches: options.maxBatches };

    const copy = (seed: FollowerSeed) =>
      Effect.gen(function* () {
        yield* follower.shard.drop(follower.partition);
        // Just dropped, so an occupied partition here is a broken invariant.
        const seeded = yield* store.seed(leader).pipe(Effect.catchTag("TenantNotEmpty", Effect.die));
        const tail = yield* catchUpFollower(leader, store, limit).pipe(
          // A seed reads from the leader's compaction point, and the positions
          // after it continue the copy; failing here means the leader changed
          // underneath the copy in a way the next pass has to start over from.
          Effect.catchTags({ EventGap: Effect.die, ReplicaDiverged: Effect.die }),
        );
        return { seeded: seeded.records, ...tail, seed };
      });

    if (options?.fresh === true) return yield* copy("fresh");
    const held = yield* store.stats;
    if (held.seeding) return yield* copy("unfinished");
    if (held.records === 0 && held.head === 0) return yield* copy("empty");
    return yield* catchUpFollower(leader, store, limit).pipe(
      Effect.map((tail): FollowerPass => ({ seeded: 0, ...tail })),
      Effect.catchTags({
        CursorCompacted: () => copy("compacted"),
        ReplicaDiverged: () => copy("diverged"),
        EventGap: () => copy("diverged"),
      }),
    );
  });

/**
 * Keep a follower level for as long as this runs: a pass, then — once a pass
 * finds nothing more — a pause of `interval` before the next. Ends only by
 * interruption or a failure no pass can recover from.
 */
export const followLeader = (
  leader: ObjectStoreApi,
  follower: { readonly shard: ShardStoreApi; readonly partition: PartitionKey },
  options: { readonly interval: Duration.Input; readonly maxBatches?: number },
): Effect.Effect<never, DbError> =>
  Effect.forever(Effect.gen(function* () {
    const pass = yield* levelFollower(leader, follower,
      options.maxBatches === undefined ? undefined : { maxBatches: options.maxBatches });
    if (!pass.more) yield* Effect.sleep(options.interval);
  }));
