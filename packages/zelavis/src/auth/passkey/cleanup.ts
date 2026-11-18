// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/passkey/cleanup.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: Adapted to the Zelavis Auth runtime and Effect transaction boundaries.
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type { TenantApi } from "../../db/database.js";
import { type AuthRuntime, defineSweep, NO_REQUEST, SWEEP_BATCH } from "../runtime/index.js";
import { passkeyTables } from "./tables.js";

export function createExpiredPasskeyChallengesSweep(tenant: TenantApi, clock: () => number) {
  const table = passkeyTables.challenges;
  let cursor = 0;
  return defineSweep<AuthRuntime>({
    name: "passkey.expiredChallenges",
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
          const challenge = yield* tx.db.get(table, document.id);
          if (challenge === null || challenge.expiresAt > tx.now) return false;
          yield* tx.db.delete(table, challenge._id);
          return true;
        })).pipe(Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          (cause) => Effect.as(Effect.logWarning(`Passkey sweep skipped challenge ${document.id}.`, cause), false),
        ));
        if (deleted) removed += 1;
      }
      const last = documents.at(-1)?.data.expiresAt;
      cursor = documents.length === SWEEP_BATCH && typeof last === "number" ? last : 0;
      return removed;
    }),
  });
}
