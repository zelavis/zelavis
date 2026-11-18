/**
 * The background sweep that erases expired authorization requests and tickets (Zelavis-own).
 *
 * Upstream deletes an authorization request or a ticket only when its secret is later presented (`KNOWN_ISSUES.md`),
 * so abandoned flows accumulate for ever. This sweep closes that: it scans each table in `expiresAt` order and
 * removes, in a transaction of its own, what has expired, at most `SWEEP_BATCH` rows a run (I8). A row that cannot be
 * removed is skipped with a warning naming only its collection and id, and the cursor moves past it.
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type { TenantApi } from "../../db/database.js";
import { oauthFlowTables } from "../lib/oauth/schema.js";
import type { AuthRow, AuthTableRef } from "../runtime/tables.js";
import { type AuthRuntime, type AuthSweep, NO_REQUEST, SWEEP_BATCH, defineSweep } from "../runtime/index.js";

export function createExpiredFlowsSweep(tenant: TenantApi, clock: () => number = Date.now): AuthSweep<AuthRuntime> {
  const cursors = new Map<string, number>();
  // Removes up to `budget` expired rows of one table; answers how many it removed.
  const sweepTable = <T extends AuthRow>(table: AuthTableRef<T>) => (runtime: AuthRuntime, now: number, budget: number) => Effect.gen(function* () {
    const cursor = cursors.get(table.collection) ?? 0;
    const documents = yield* tenant.documents.findMany({
      collection: table.collection,
      where: [
        { path: "expiresAt", op: "gte", value: cursor },
        { path: "expiresAt", op: "lte", value: now },
      ],
      orderBy: [{ path: "expiresAt", direction: "asc" }],
      limit: budget,
    }).pipe(Effect.orDie);
    let removed = 0;
    for (const document of documents) {
      const deleted = yield* runtime.mutation(NO_REQUEST, (tx) => tx.db.delete(table, document.id)).pipe(
        Effect.as(true),
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          (cause) => Effect.as(Effect.logWarning(`Auth sweep oauth.expired skipped ${table.collection} row ${document.id}.`, cause), false),
        ),
      );
      if (deleted) removed += 1;
    }
    const last = documents[documents.length - 1]?.data.expiresAt;
    cursors.set(table.collection, documents.length >= budget && typeof last === "number" ? last : 0);
    return removed;
  });
  const sweeps = [sweepTable(oauthFlowTables.authorizationRequests), sweepTable(oauthFlowTables.tickets)];
  return defineSweep({
    name: "oauth.expired",
    everyMs: 5 * 60_000,
    run: (runtime) => Effect.gen(function* () {
      const now = clock();
      let removed = 0;
      for (const sweep of sweeps) {
        const budget = SWEEP_BATCH - removed;
        if (budget <= 0) break;
        removed += yield* sweep(runtime, now, budget);
      }
      return removed;
    }),
  });
}
