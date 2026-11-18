// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/email/cleanup.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the batch-worker loop is a sweep (T6, I8): a bounded run over `by_expiresAt`, at most SWEEP_BATCH rows, a row that cannot be removed is skipped with a warning naming only its collection and id, and the cursor moves past it.
// The background sweep that erases expired challenges. Nothing else deletes
// a challenge that nobody completes, and a completion does not delete the
// other challenges for the same address, so the table would only grow.
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type { TenantApi } from "../../db/database.js";
import {
  type AuthRuntime,
  type AuthSweep,
  NO_REQUEST,
  SWEEP_BATCH,
  defineSweep,
} from "../runtime/index.js";
import { emailTables } from "./tables.js";

/**
 * The sweep that erases expired challenges.
 *
 * Each kind of challenge has its own TTL, and a custom challenge can set its
 * own, thus the rows are scanned in `expiresAt` order, not in creation order.
 * The bound is inclusive on both ends: two rows can share an expiry, and at
 * exactly `expiresAt` a challenge is expired, like in the claim check.
 *
 * The rows are read outside any transaction and each is removed in a
 * transaction of its own (which re-reads it), so one bad row never keeps the
 * others. The cursor is the `expiresAt` of the last row of a full page.
 */
export function createExpiredChallengesSweep(tenant: TenantApi, clock: () => number = Date.now): AuthSweep<AuthRuntime> {
  const collection = emailTables.challenges.collection;
  let cursor = 0;
  return defineSweep({
    name: "email.expiredChallenges",
    everyMs: 10 * 60_000,
    run: (runtime) => Effect.gen(function* () {
      const now = clock();
      const documents = yield* tenant.documents.findMany({
        collection,
        where: [
          { path: "expiresAt", op: "gte", value: cursor },
          { path: "expiresAt", op: "lte", value: now },
        ],
        orderBy: [{ path: "expiresAt", direction: "asc" }],
        limit: SWEEP_BATCH,
      }).pipe(Effect.orDie);
      let removed = 0;
      for (const document of documents) {
        const deleted = yield* runtime.mutation(NO_REQUEST, (tx) => tx.db.delete(emailTables.challenges, document.id)).pipe(
          Effect.as(true),
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) => Effect.as(Effect.logWarning(`Auth sweep email.expiredChallenges skipped ${collection} row ${document.id}.`, cause), false),
          ),
        );
        if (deleted) removed += 1;
      }
      const last = documents[documents.length - 1]?.data.expiresAt;
      cursor = documents.length >= SWEEP_BATCH && typeof last === "number" ? last : 0;
      return removed;
    }),
  });
}
