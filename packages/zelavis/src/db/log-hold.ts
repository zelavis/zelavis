import { Effect } from "effect";
import type { DbError } from "./errors.js";
import type { ObjectStoreApi } from "./store.js";

/** Tries to hold a log while compaction keeps moving past the point read. */
const HOLD_ATTEMPTS = 4;

/**
 * Hold `source`'s log at its compaction point under `id`, so upkeep cannot cut the events a reader
 * is to follow once it has copied the records. Compaction passing the point first is retried a few
 * times; a reader that cannot be held anyway still detects a cut log (`CursorCompacted`,
 * `LogCompacted`) and starts over, so a hold only keeps a long read from starving.
 */
export const holdLogAtCompaction = (source: ObjectStoreApi, id: string, ttlMillis: number): Effect.Effect<boolean, DbError> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < HOLD_ATTEMPTS; attempt++) {
      const at = (yield* source.stats).compactedTo;
      const held = yield* source.holdLog({ id, position: at, ttlMillis }).pipe(
        Effect.as(true),
        Effect.catchTag("LogCompacted", () => Effect.succeed(false)),
      );
      if (held) return true;
    }
    return false;
  });

/** Run `use` with `source`'s log held under `id`, released however `use` ends. */
export const holdingLog = <A, E, R>(
  source: ObjectStoreApi,
  id: string,
  ttlMillis: number,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DbError, R> =>
  Effect.acquireUseRelease(
    holdLogAtCompaction(source, id, ttlMillis),
    () => use,
    () => Effect.orDie(source.releaseLog(id)),
  );
