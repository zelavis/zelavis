/**
 * The sweep of pending sign-ins whose challenge expired (Zelavis-own, as the passkey challenge sweep): an expired
 * row already refuses its challenge, so removing it changes no answer. Same batch rules as every sweep (I8).
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type { TenantApi } from "../../db/database.js";
import { type AuthRuntime, defineSweep, NO_REQUEST, SWEEP_BATCH } from "../runtime/index.js";
import { totpTables } from "./tables.js";

export function createExpiredPendingSignInsSweep(tenant: TenantApi, clock: () => number) {
  const table = totpTables.pendingSignIns;
  let cursor = 0;
  return defineSweep<AuthRuntime>({
    name: "totp.expiredPendingSignIns",
    everyMs: 5 * 60_000,
    run: (runtime) => Effect.gen(function* () {
      const documents = yield* tenant.documents.findMany({
        collection: table.collection,
        where: [{ path: "expiresAt", op: "gte", value: cursor }, { path: "expiresAt", op: "lte", value: clock() }],
        orderBy: [{ path: "expiresAt", direction: "asc" }],
        limit: SWEEP_BATCH,
      });
      let removed = 0;
      for (const document of documents) {
        const deleted = yield* runtime.mutation(NO_REQUEST, (tx) => Effect.gen(function* () {
          const pending = yield* tx.db.get(table, document.id);
          if (pending === null || pending.expiresAt > tx.now) return false;
          yield* tx.db.delete(table, pending._id);
          return true;
        })).pipe(Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          (cause) => Effect.as(Effect.logWarning(`TOTP sweep skipped pending sign-in ${document.id}.`, cause), false),
        ));
        if (deleted) removed += 1;
      }
      const last = documents.at(-1)?.data.expiresAt;
      cursor = documents.length === SWEEP_BATCH && typeof last === "number" ? last : 0;
      return removed;
    }),
  });
}
