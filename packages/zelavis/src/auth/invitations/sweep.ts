import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type AuthRuntime, AuthInvariantViolation, NO_REQUEST, SWEEP_BATCH, defineSweep, invariant } from "../runtime/index.js";
import { pendingCounter, writePending } from "./invitations.js";
import { INVITATION_LIMIT, invitationsTables } from "./tables.js";

const invitations = invitationsTables.invitations;
const pendingRows = {
  ...invitations,
  schema: Schema.Struct({ _id: Schema.String, _creationTime: Schema.Finite, expiresAt: Schema.optional(Schema.Unknown) }),
};

export const expiredInvitationsSweep = defineSweep<AuthRuntime>({
  name: "invitations.expired",
  everyMs: 10 * 60_000,
  run: (runtime) => runtime.mutation(NO_REQUEST, Effect.fnUntraced(function* (tx) {
    // Recount against the same snapshot as the status changes. At most 500 pending rows
    // exist, so three indexed reads suffice and at most 200 writes occur per run.
    let after = "";
    let pending = 0;
    let expired = 0;
    const counter = yield* pendingCounter(tx);
    for (let page = 0; page <= Math.floor(INVITATION_LIMIT / SWEEP_BATCH); page += 1) {
      const batch = yield* tx.db.query(pendingRows)
        .withIndex("by_status", (q) => q.eq("status", "pending").gt("_id", after))
        .take(SWEEP_BATCH);
      pending += batch.length;
      if (pending > INVITATION_LIMIT) return yield* invariant("The invitation pending limit was exceeded in storage.");
      for (const row of batch) {
        if (expired >= SWEEP_BATCH) break;
        if (typeof row.expiresAt !== "number" || !Number.isSafeInteger(row.expiresAt) || row.expiresAt < 0) {
          yield* Effect.logWarning(`Skipped ${invitations.collection} row ${row._id} with an invalid expiry.`);
          continue;
        }
        if (row.expiresAt > tx.now) continue;
        const changed = yield* tx.db.patch(invitations, row._id, { status: "revoked" }).pipe(
          Effect.as(true),
          Effect.catchDefect((defect) => defect instanceof AuthInvariantViolation
            ? Effect.as(Effect.logWarning(`Skipped undecodable ${invitations.collection} row ${row._id}.`), false)
            : Effect.die(defect)),
        );
        if (changed) expired += 1;
      }
      const last = batch.at(-1);
      if (batch.length < SWEEP_BATCH || last === undefined) break;
      after = last._id;
    }
    // Nothing to initialize for an unused runtime.
    if (counter !== null || pending > 0) yield* writePending(tx, counter, pending - expired);
    return expired;
  })),
});
