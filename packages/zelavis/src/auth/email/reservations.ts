/** An imported password may use an email that Identity never verified.
 * Reserve that identifier for password sign-in until the account proves the
 * address or replaces it. Recovery and account linking use verified emails. */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type AuthTxBase, defineTable, defineTables } from "../runtime/index.js";

export const emailReservationTables = defineTables("email", {
  passwordReservations: defineTable({
    normalizedEmail: Schema.String,
    userId: Schema.String,
  }).index("by_normalizedEmail", ["normalizedEmail"]).index("by_userId", ["userId"]),
});

const reservations = emailReservationTables.passwordReservations;

export const emailReservation = (tx: AuthTxBase, normalizedEmail: string) =>
  tx.db.query(reservations).withIndex("by_normalizedEmail", (q) => q.eq("normalizedEmail", normalizedEmail)).unique();

export const clearEmailReservation = Effect.fn("auth.email.clearPasswordReservation")(function* (tx: AuthTxBase, userId: string) {
  const existing = yield* tx.db.query(reservations).withIndex("by_userId", (q) => q.eq("userId", userId)).unique();
  if (existing !== null) yield* tx.db.delete(reservations, existing._id);
});
