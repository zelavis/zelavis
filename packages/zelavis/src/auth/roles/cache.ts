/**
 * The role catalogue as authentication reads it (Zelavis-own): an in-process
 * copy of the at most 50 roles, loaded once and kept until a role change in
 * this runtime clears it. A runtime's Auth has one writer, so its own role
 * changes are the only ones there are; each clears the copy after it
 * commits, so a member's next request is expanded from the new roles.
 *
 * A load that was running when the copy was cleared may have read the roles
 * as they were before that change; its result answers the request that
 * asked for it but is not kept, so no copy outlives the change that
 * replaced it. An account with no role assignments never loads the copy.
 */
import * as Effect from "effect/Effect";
import { NO_REQUEST, type AuthRuntime } from "../runtime/index.js";
import { catalogueMap, logUnreadable, readCatalogue } from "./catalogue.js";
import type { RoleCatalogue } from "./expand.js";

export interface RoleCatalogueCache {
  /** The roles by id, loaded when there is no current copy. */
  readonly current: Effect.Effect<RoleCatalogue>;
  /** Forget the copy; the next `current` loads it again. */
  readonly invalidate: () => void;
}

export function createRoleCatalogueCache(runtime: AuthRuntime): RoleCatalogueCache {
  let cached: RoleCatalogue | undefined;
  let generation = 0;
  const load = runtime.query(NO_REQUEST, (tx) => readCatalogue(tx)).pipe(
    Effect.tap(logUnreadable),
    Effect.map(catalogueMap),
    // A read-only transaction over at most 51 rows: reaching a transaction limit is a defect.
    Effect.orDie,
  );
  return {
    current: Effect.suspend(() => {
      if (cached !== undefined) return Effect.succeed(cached);
      const loadedAt = generation;
      return Effect.tap(load, (roles) => Effect.sync(() => {
        if (generation === loadedAt) cached = roles;
      }));
    }),
    invalidate: () => {
      generation += 1;
      cached = undefined;
    },
  };
}
