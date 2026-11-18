// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/email/verifiedEmails.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the queries and mutations are Effects over an AuthTx (T1-T4).
import * as Effect from "effect/Effect";
import type { AuthTx } from "../core/context.js";
import {
  emailsByUserId,
  emailByNormalizedEmail,
  getClientIp,
  rateLimiter,
} from "./helpers.js";
import { clearEmailReservation, emailReservation } from "./reservations.js";
import { emailTables } from "./tables.js";
import {
  normalizeEmail,
  type LookupEmailResult,
} from "./validation.js";

/**
 * Get the verified email addresses of a user.
 *
 * The function returns an empty array when the user has no verified email.
 */
export const getEmails = Effect.fn("auth.email.getEmails")(function* (
  tx: AuthTx,
  { userId }: { userId: string },
) {
  const rows = yield* emailsByUserId(tx, userId);
  return rows.map((row) => ({ email: row.email, isPrimary: row.isPrimary }));
});

/**
 * Get the primary email address of a user.
 *
 * The function returns `null` when the user has no verified email.
 */
export const getPrimaryEmail = Effect.fn("auth.email.getPrimaryEmail")(function* (
  tx: AuthTx,
  { userId }: { userId: string },
) {
  const row = yield* tx.db
    .query(emailTables.verifiedEmails)
    .withIndex("by_userId_isPrimary", (q) =>
      q.eq("userId", userId).eq("isPrimary", true),
    )
    .unique();
  return row === null ? null : row.email;
});

/**
 * Find the user that a verified email address identifies.
 *
 * Call this function when the address comes from a person who is not signed
 * in, for example at sign-in or at the start of a password recovery. Each
 * call takes a token from a per-IP limit before the lookup, so that a client
 * cannot probe many addresses to find which ones have an account. The
 * function returns `RATE_LIMITED` when the client IP has no token. The
 * `start` of the kinds that record an address (`addEmail`, `changeEmail`,
 * `signUp`) uses the same limit, because its `EMAIL_TAKEN` error gives the
 * same information.
 *
 * The lookup ignores the case and the Unicode normalization form of the
 * `email` argument. The `storedEmail` field of the result is the address as
 * the user verified it, which can be different from the argument in case or
 * in Unicode form. It is the address that matched, not the primary address
 * of the user.
 *
 * The function returns an `EMAIL_NOT_FOUND` error when no user has verified
 * this address.
 */
const lookup = Effect.fn("auth.email.lookupEmail")(function* (
  tx: AuthTx,
  { email }: { email: string },
  includePasswordReservation: boolean,
) {
  const limit = yield* rateLimiter.limit(tx, "lookupEmailPerIp", {
    key: getClientIp(tx),
  });
  if (!limit.ok) {
    return {
      success: false,
      userError: { error: "RATE_LIMITED", retryAfterMs: limit.retryAfter },
    } satisfies LookupEmailResult;
  }
  const normalizedEmail = normalizeEmail(email);
  const row = yield* emailByNormalizedEmail(tx, normalizedEmail);
  if (row === null) {
    if (includePasswordReservation) {
      const reservation = yield* emailReservation(tx, normalizedEmail);
      if (reservation !== null) return { success: true, userId: reservation.userId, storedEmail: email } satisfies LookupEmailResult;
    }
    return { success: false, userError: { error: "EMAIL_NOT_FOUND" } } satisfies LookupEmailResult;
  }
  return { success: true, userId: row.userId, storedEmail: row.email } satisfies LookupEmailResult;
});

export const lookupEmail = (tx: AuthTx, args: { email: string }) => lookup(tx, args, false);
export const lookupPasswordEmail = (tx: AuthTx, args: { email: string }) => lookup(tx, args, true);

/**
 * Delete all data the component holds for a user: verified emails and
 * pending challenges.
 *
 * Call this when the app deletes the user. The function is idempotent.
 */
export const deleteUser = Effect.fn("auth.email.deleteUser")(function* (
  tx: AuthTx,
  { userId }: { userId: string },
) {
  yield* clearEmailReservation(tx, userId);
  const rows = yield* emailsByUserId(tx, userId);
  for (const row of rows) {
    yield* tx.db.delete(emailTables.verifiedEmails, row._id);
  }
  const challenges = yield* tx.db
    .query(emailTables.challenges)
    .withIndex("by_purpose_userId", (q) => q.eq("purpose.userId", userId))
    .collect();
  for (const row of challenges) {
    yield* tx.db.delete(emailTables.challenges, row._id);
  }
  return null;
});
