// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/email/helpers.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: queries are Effects over an AuthTx (T1-T4); the rate limiter is the runtime's token bucket (the same three buckets); the client address is the transaction's trusted request address, and a runtime without one (no listener) uses one shared key instead of throwing; the Resend sender is the runtime's email outbox, with the link built from its link base (the code travels in the fragment) and the copy in templates.ts.
import * as Effect from "effect/Effect";
import type { TransactionTooLarge } from "../../db/errors.js";
import type { AuthTx } from "../core/context.js";
import type { RowOf } from "../core/tables.js";
import { type AuthTxBase, HOUR, defineRateLimits } from "../runtime/index.js";
import { emailTables } from "./tables.js";

export type VerifiedEmailRow = RowOf<typeof emailTables.verifiedEmails>;
export type ChallengeRow = RowOf<typeof emailTables.challenges>;

//------------------------------------------------------------------------------

// Configuration
//------------------------------------------------------------------------------

/**
 * How long an `addEmail`, `changeEmail` or `signUp` link stays valid.
 */
export const ADD_EMAIL_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * How long a `custom` link stays valid when the caller gives no `ttlMs`, and
 * the bounds for the value that a caller can give.
 *
 * The `custom` kind serves many flows, thus the default is a compromise: short
 * enough for a link that can give access to an account, long enough for a
 * person who opens the mail on a second device. A flow with a stricter
 * requirement gives its own `ttlMs`. A password reset, for example, stays at
 * or below 10 minutes (OWASP ASVS v5 6.5.5).
 *
 * The maximum keeps the table from holding links for days.
 */
export const CUSTOM_TTL_DEFAULT_MS = 15 * 60 * 1000; // 15 minutes
export const CUSTOM_TTL_MIN_MS = 60 * 1000; // 1 minute
export const CUSTOM_TTL_MAX_MS = 24 * 60 * 60 * 1000; // 24 hours

// Throttle for starting challenges. Each flow sends an email, so the
// limits protect the destination mailbox from flooding and the sender's
// reputation from abuse:
// - per destination address, so an attacker cannot flood one mailbox;
// - per client IP, so one machine cannot spray many addresses.
//
// A separate limit throttles each call that tells the caller whether an
// address has an account, so that one machine cannot probe many addresses to
// find which ones have an account. `lookupEmail` and the `start` of the kinds
// that record an address (`addEmail`, `changeEmail`, `signUp`) share it. Each
// sign-in uses a lookup, thus this limit is higher than the limits for the
// challenges.
//
// Recovery completion also has its own client bucket to bound password hashing.
// Each limit keys on an address or a client (I6).
export const rateLimiter = defineRateLimits("email", {
  startChallengePerEmail: { kind: "token bucket", rate: 5, period: HOUR },
  startChallengePerIp: { kind: "token bucket", rate: 20, period: HOUR },
  lookupEmailPerIp: { kind: "token bucket", rate: 60, period: HOUR },
  completeRecoveryPerIp: { kind: "token bucket", rate: 20, period: HOUR },
});

//------------------------------------------------------------------------------
// Shared helpers
//------------------------------------------------------------------------------

/**
 * The client address that the rate limits key on. A runtime with no listener
 * (embedded, no request address) has no other clients to tell apart, so all
 * its calls share the key `"unknown"`; upstream throws here instead.
 */
export function getClientIp(tx: AuthTx): string {
  return tx.request.ip ?? "unknown";
}

export function emailsByUserId(
  tx: AuthTx,
  userId: string,
): Effect.Effect<ReadonlyArray<VerifiedEmailRow>, TransactionTooLarge> {
  return tx.db
    .query(emailTables.verifiedEmails)
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
}

/**
 * Tell whether the user has at least one verified address. Reads one row at
 * most, unlike `emailsByUserId`.
 */
export const userHasEmail = Effect.fn("auth.email.userHasEmail")(function* (
  tx: AuthTx,
  userId: string,
) {
  const first = yield* tx.db
    .query(emailTables.verifiedEmails)
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .first();
  return first !== null;
});

export function emailByNormalizedEmail(
  tx: AuthTxBase,
  normalizedEmail: string,
): Effect.Effect<VerifiedEmailRow | null, TransactionTooLarge> {
  return tx.db
    .query(emailTables.verifiedEmails)
    .withIndex("by_normalizedEmail", (q) =>
      q.eq("normalizedEmail", normalizedEmail),
    )
    .unique();
}

/** "10 minutes", "1 hour", "2 hours". */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
