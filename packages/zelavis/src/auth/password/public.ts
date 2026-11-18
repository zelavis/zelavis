// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/password/public.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: mutations are Effects over an AuthTx (T1-T4), the rate limiter is the runtime's token bucket, hashing is PBKDF2 in PHC form run outside the transaction, and verifyPassword is split in beginVerify and finishVerify so a retry never rehashes and a session is issued only for the hash that was verified.
import * as Effect from "effect/Effect";
import type { TransactionTooLarge } from "../../db/errors.js";
import { invalidatePendingProofs } from "../accounts/proofs.js";
import { getAccount } from "../accounts/accounts.js";
import type { AuthTx } from "../core/context.js";
import type { RowOf } from "../core/tables.js";
import { MINUTE, defineRateLimits, invariant } from "../runtime/index.js";
import { passwordTables } from "./tables.js";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  type VerifyPasswordUserError,
  validatePasswordInputFormat,
} from "./validation.js";

// Throttle for password verification attempts.
//
// This implementation follows Pilcrow’s recommendations (https://auth.pilcrowonpaper.com/passwords).
//
// In particular:
// - The maximum rate is 1 attempt per minute, which caps attackers at ~500k attempts per year.
// - We use a token bucket with a capacity of 5, so that legitimate users
//   shouldn’t be affected by the rate limit in most cases.
// - The rate limit is for each particular user ID. The per-client-address
//   limit of the sign-in route (part 13) comes on top of it, so one client cannot
//   try every account (I6).
//
// Note that the rate limit can be abused by malicious users to prevent a legitimate user
// from logging in. Applications should allow users to log in through other means,
// for instance through the “reset password” flow, in order to avoid this issue.
const rateLimiter = defineRateLimits("password", {
  verifyPassword: {
    kind: "token bucket",
    rate: 1,
    period: MINUTE,
    capacity: 5,
  },
});

type PasswordRow = RowOf<typeof passwordTables.passwords>;

/**
 * Set (or replace) a user's password to a hash made outside the transaction
 * (`hashPassword`, after `validateNewPassword`).
 *
 * This can be used both when creating a new user (will create a row),
 * or to update the password for an existing user (will update the existing row).
 *
 * DANGER: This replaces the password of any `userId`, with no proof. The
 * name says so because app code must not call it: only the password methods
 * of this package do, for a user they just created or verified.
 */
export const _internal_dangerous_setPassword = Effect.fn("auth.password._internal_dangerous_setPassword")(function* (
  tx: AuthTx,
  { userId, passwordHashPHC, imported }: { userId: string; passwordHashPHC: string; imported?: true },
) {
  const existing = yield* passwordByUserId(tx, userId);
  if (existing !== null) {
    yield* tx.db.patch(passwordTables.passwords, existing._id, { passwordHashPHC, imported });
  } else {
    yield* tx.db.insert(passwordTables.passwords, { userId, passwordHashPHC, imported });
  }
  yield* invalidatePendingProofs(tx, userId);
});

export type BeginVerifyResult =
  | { success: true; stored: string }
  | { success: false; userError: VerifyPasswordUserError };

/**
 * First step of verifying a user's password: this enforces the rate limit
 * (see `rateLimiter` above), checks the input format and reads the stored
 * hash. The caller then checks the hash outside any transaction
 * (`verifyPasswordHash`) and, in the transaction that acts on the result,
 * calls {@link finishVerify}.
 *
 * The token is consumed here and commits with this mutation, as upstream
 * consumes it before hashing.
 */
export const beginVerify = Effect.fn("auth.password.beginVerify")(function* (
  tx: AuthTx,
  { userId, password }: { userId: string; password: string },
) {
  const status = yield* rateLimiter.limit(tx, "verifyPassword", {
    key: userId,
  });
  if (!status.ok) {
    return {
      success: false,
      userError: { error: "RATE_LIMITED", retryAfterMs: status.retryAfter },
    } satisfies BeginVerifyResult;
  }

  const row = yield* passwordByUserId(tx, userId);
  if (row === null) {
    if ((yield* getAccount(tx, userId)) === null) return yield* invariant(`No password stored for userId ${userId}.`);
    return { success: false, userError: { error: "INVALID_CREDENTIALS" } } satisfies BeginVerifyResult;
  }

  // Imported credentials retain their source's password format until the owner
  // replaces the password. Rehashing the same password preserves this flag.
  if (row.imported) {
    if ([...password].length > MAX_PASSWORD_LENGTH) {
      return { success: false, userError: { error: "PASSWORD_TOO_LONG", maximumLength: MAX_PASSWORD_LENGTH } } satisfies BeginVerifyResult;
    }
  } else {
    const userError = validatePasswordInputFormat(password, MIN_PASSWORD_LENGTH);
    if (userError !== null) return { success: false, userError } satisfies BeginVerifyResult;
  }
  return { success: true, stored: row.passwordHashPHC } satisfies BeginVerifyResult;
});

/**
 * Last step of verifying a user's password, run in the transaction that
 * issues the session (or applies the change): the password is accepted only
 * while the stored hash is still the one that was checked. A password changed
 * in between (a recovery, a change of password) fails with
 * `INVALID_CREDENTIALS` instead of issuing a session for the old one.
 *
 * `rehashed` is a PHC hash of the same password, made outside the transaction
 * when `needsRehash(stored)`: it replaces `stored` in the same commit.
 */
export const finishVerify = Effect.fn("auth.password.finishVerify")(function* (
  tx: AuthTx,
  { userId, stored, rehashed }: { userId: string; stored: string; rehashed?: string | undefined },
) {
  const row = yield* passwordByUserId(tx, userId);
  if (row === null || row.passwordHashPHC !== stored) {
    return { success: false, userError: { error: "INVALID_CREDENTIALS" } } as const;
  }
  if (rehashed !== undefined) {
    yield* tx.db.patch(passwordTables.passwords, row._id, { passwordHashPHC: rehashed });
  }
  return { success: true } as const;
});

function passwordByUserId(tx: AuthTx, userId: string): Effect.Effect<PasswordRow | null, TransactionTooLarge> {
  return tx.db
    .query(passwordTables.passwords)
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
}
