/**
 * Second-factor verification (Zelavis-own; upstream ships the TOTP component
 * without a sign-in check): a TOTP code or a backup code checked for an
 * account, and a pending sign-in redeemed with one.
 *
 * Replay: a TOTP code is accepted only for a time step after the secret's
 * `lastUsedCounter`, which the accepting transaction raises, so the same code
 * (or an older one) is refused afterwards; a backup code is deleted by the
 * transaction that accepts it. Attempts: a pending sign-in takes
 * `MAX_CHALLENGE_ATTEMPTS` wrong codes and then ends, and wrong codes for one
 * account are also limited by a token bucket of that account (I6: never
 * runtime-wide). Each refused code is a security event (part 11).
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { TransactionTooLarge } from "../../db/errors.js";
import { parseJsonObject } from "../../core/json-validation.js";
import { readProofRevision } from "../accounts/proofs.js";
import { readMethodRevision } from "../methods/settings.js";
import { sha256Hex } from "../lib/crypto.js";
import { type AuthTxBase, MINUTE, defineRateLimits } from "../runtime/index.js";
import { recordSecurityEvent } from "../security/events.js";
import { hashBackupCode } from "./backupCodes.js";
import { MAX_CHALLENGE_ATTEMPTS } from "./gate.js";
import { activeSecrets, matchCode, open } from "./helpers.js";
import { type PendingSignIn, totpTables } from "./tables.js";

// Wrong second-factor codes of one account: ten at once, then five a minute.
// A six-digit code space takes about 200 000 tries on average at that rate's
// cap, while a user who mistypes a few codes is never slowed.
const rateLimiter = defineRateLimits("totp", {
  verifyCode: { kind: "token bucket", rate: 5, period: MINUTE, capacity: 10 },
});

export const verifyCodeUserError = Schema.Union([
  // The code is neither a current TOTP code of the account (or it was used
  // already) nor one of its unused backup codes.
  Schema.Struct({ error: Schema.Literal("INCORRECT_CODE") }),
  Schema.Struct({ error: Schema.Literal("RATE_LIMITED"), retryAfterMs: Schema.Number }),
]);
export type VerifyCodeUserError = typeof verifyCodeUserError.Type;

export const verifyPendingUserError = Schema.Union([
  verifyCodeUserError,
  // The challenge is unknown, expired, of the other kind, or ended after
  // too many wrong codes.
  Schema.Struct({ error: Schema.Literal("INVALID_CHALLENGE") }),
]);
export type VerifyPendingUserError = typeof verifyPendingUserError.Type;

/**
 * Check a code for an account: a TOTP code of any of its active secrets, then
 * one of its unused backup codes. Answers what accepted it, or null. Writes
 * the acceptance (the raised counter, the deleted backup code) in `tx`.
 */
export const acceptCode = Effect.fn("auth.totp.acceptCode")(function* (
  tx: AuthTxBase,
  { userId, code, key }: { userId: string; code: string; key: string },
) {
  for (const secret of yield* activeSecrets(tx, userId)) {
    const counter = yield* matchCode(secret, code, tx.now, key);
    if (counter === null) continue;
    // A code of the step already used, or of an earlier one, is a replay.
    if (secret.lastUsedCounter !== undefined && counter <= secret.lastUsedCounter) continue;
    yield* tx.db.patch(totpTables.totpSecrets, secret._id, { lastUsedCounter: counter });
    return "totp" as const;
  }
  const codeHash = yield* hashBackupCode(code);
  const backup = yield* tx.db
    .query(totpTables.backupCodes)
    .withIndex("by_userId_codeHash", (q) => q.eq("userId", userId).eq("codeHash", codeHash))
    .first();
  if (backup !== null) {
    yield* tx.db.delete(totpTables.backupCodes, backup._id);
    return "backup" as const;
  }
  return null;
});

/** Apply the same account-wide budget to sign-in, enrollment, and management codes. */
export const withCodeLimit = Effect.fn("auth.totp.withCodeLimit")(function* <
  A extends { success: true } | { success: false; userError: { error: string } },
>(
  tx: AuthTxBase,
  userId: string,
  check: Effect.Effect<A, TransactionTooLarge>,
) {
  const status = yield* rateLimiter.check(tx, "verifyCode", { key: userId });
  if (!status.ok) {
    return { success: false, userError: { error: "RATE_LIMITED", retryAfterMs: status.retryAfter } } as const;
  }
  const result = yield* check;
  if (!result.success && result.userError.error === "INCORRECT_CODE") {
    yield* rateLimiter.limit(tx, "verifyCode", { key: userId });
    yield* recordSecurityEvent(tx, { kind: "mfa.verification_failed", accountId: userId });
  }
  return result;
});

/** Check and consume a current TOTP or backup code under the account's wrong-code limit. */
export const verifyCode = (
  tx: AuthTxBase,
  args: { userId: string; code: string; key: string },
) => withCodeLimit(tx, args.userId, Effect.gen(function* () {
  const accepted = yield* acceptCode(tx, args);
  if (accepted === null) {
    return { success: false, userError: { error: "INCORRECT_CODE" } } as const;
  }
  return { success: true, by: accepted } as const;
}));

/** The pending sign-in, if its challenge, kind, lifetime and credential revision are still valid. */
export const findPendingSignIn = Effect.fn("auth.totp.findPendingSignIn")(function* (
  tx: AuthTxBase,
  { challenge, kind }: { challenge: string; kind: PendingSignIn["kind"] },
) {
  const challengeHash = yield* sha256Hex(challenge);
  const row = yield* tx.db
    .query(totpTables.pendingSignIns)
    .withIndex("by_challengeHash", (q) => q.eq("challengeHash", challengeHash))
    .unique();
  if (row === null || row.kind !== kind || row.expiresAt <= tx.now || row.proofRevision === undefined) return null;
  if (row.methodRevision !== (yield* readMethodRevision(tx, row.method))) return null;
  const proofRevision = yield* readProofRevision(tx, row.userId);
  return proofRevision === null || row.proofRevision !== proofRevision ? null : { ...row, proofRevision };
});

/** Count a wrong code against a pending sign-in; the last allowed one ends it. */
export const countWrongCode = (tx: AuthTxBase, row: PendingSignIn): Effect.Effect<void, TransactionTooLarge> =>
  row.attempts + 1 >= MAX_CHALLENGE_ATTEMPTS
    ? tx.db.delete(totpTables.pendingSignIns, row._id)
    : tx.db.patch(totpTables.pendingSignIns, row._id, { attempts: row.attempts + 1 });

/** What the session of a redeemed pending sign-in is created for. */
export interface RedeemedSignIn {
  readonly userId: string;
  readonly method: string;
  readonly component: string;
  readonly profile: unknown;
  readonly providerRevision?: string | undefined;
}

/**
 * End a pending sign-in whose second factor passed, and answer what its
 * session is created for. A profile that cannot be opened (the master secret
 * changed) is a defect: its own challenge could not have been issued then.
 */
export const redeemPendingSignIn = Effect.fn("auth.totp.redeemPendingSignIn")(function* (
  tx: AuthTxBase,
  row: PendingSignIn,
  key: string,
) {
  yield* tx.db.delete(totpTables.pendingSignIns, row._id);
  const opened = yield* open(row.sealedProfile, key);
  const profile = opened === undefined ? undefined : yield* Effect.try(() => parseJsonObject(opened)).pipe(Effect.orDie);
  if (profile === undefined) return yield* Effect.die(new Error(`The pending sign-in ${row._id} cannot be opened`));
  return { userId: row.userId, method: row.method, component: row.component, profile, providerRevision: row.providerRevision } satisfies RedeemedSignIn;
});

/**
 * Redeem a `verify` pending sign-in with a code. Counts a wrong code against
 * the challenge and the account; answers what the session is created for on
 * success.
 */
export const verifyPendingSignIn = Effect.fn("auth.totp.verifyPendingSignIn")(function* (
  tx: AuthTxBase,
  { challenge, code, key }: { challenge: string; code: string; key: string },
) {
  const row = yield* findPendingSignIn(tx, { challenge, kind: "verify" });
  if (row === null) {
    return { success: false, userError: { error: "INVALID_CHALLENGE" } } as const;
  }
  const verified = yield* verifyCode(tx, { userId: row.userId, code, key });
  if (!verified.success) {
    if (verified.userError.error === "INCORRECT_CODE") yield* countWrongCode(tx, row);
    return verified;
  }
  return { success: true, signIn: yield* redeemPendingSignIn(tx, row, key) } as const;
});
