/**
 * TOTP multi-factor authentication (Zelavis-own wiring of upstream's
 * unexported TOTP component): enrollment, the second step of a gated
 * sign-in, management of a signed-in account's authenticators and backup
 * codes, and the runtime's MFA policy.
 *
 * Enrolling from a session asks the account to prove itself again: its
 * current password when it has one, otherwise a session started within
 * {@link RECENT_SIGN_IN_MS}. Adding an authenticator to an enrolled account,
 * removing one, and replacing backup codes also ask for a current code.
 * An `enroll` challenge (a sign-in the
 * policy stopped) stands for the first factor instead, and confirming the
 * enrollment completes that sign-in.
 *
 * Enrolling, removing an authenticator, replacing backup codes, a refused
 * code and a policy change are security events, each recorded in the
 * transaction of its action (part 11).
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { invalidatePendingProofs, readProofRevision } from "../accounts/proofs.js";
import type { AuthCall, AuthTx, CoreRuntime } from "../core/context.js";
import type { AuthFailure } from "../core/errors.js";
import type { AuthCore } from "../core/setup.js";
import { endAccountSessions } from "../core/sessions.js";
import { coreTables } from "../core/tables.js";
import { getAuthUserId } from "../core/userId.js";
import { getPrimaryEmail } from "../email/verifiedEmails.js";
import type { SignInComplete } from "../lib/types.js";
import { hashPassword, needsRehash, verifyPasswordHash } from "../password/hashing.js";
import { beginVerify, finishVerify } from "../password/public.js";
import { passwordTables } from "../password/tables.js";
import { verifyPasswordUserError } from "../password/validation.js";
import { getUsername } from "../username/public.js";
import { recordSecurityEvent } from "../security/events.js";
import { type CreateTotpResult, confirmTotp, createTotp, getStatus, listTotps } from "../totp/enrollment.js";
import { activeSecrets, backupCodesByUserId, hasActiveSecret, replaceBackupCodes } from "../totp/helpers.js";
import { type MfaPolicy, type MfaPolicyInput, policyRequires, readPolicy, setPolicy } from "../totp/policy.js";
import { type EnrollmentAuthority, type PendingSignIn, totpTables } from "../totp/tables.js";
import { assertValidIssuer } from "../totp/totp.js";
import { confirmMultiTotpUserError } from "../totp/validation.js";
import {
  countWrongCode,
  findPendingSignIn,
  redeemPendingSignIn,
  verifyCode,
  verifyCodeUserError,
  verifyPendingSignIn,
  verifyPendingUserError,
  withCodeLimit,
} from "../totp/verify.js";

/** How recent a session must be for an account without a password to enroll from it. */
export const RECENT_SIGN_IN_MS = 10 * 60 * 1000;

const notLoggedIn = Schema.Struct({ error: Schema.Literal("NOT_LOGGED_IN") });
const invalidChallenge = Schema.Struct({ error: Schema.Literal("INVALID_CHALLENGE") });
const reauthenticationRequired = { success: false, userError: { error: "REAUTHENTICATION_REQUIRED" } } as const;
const invalidCredentials = { success: false, userError: { error: "INVALID_CREDENTIALS" } } as const;
const missingSession = { success: false, userError: { error: "NOT_LOGGED_IN" } } as const;
const invalidEnrollmentChallenge = { success: false, userError: { error: "INVALID_CHALLENGE" } } as const;

export const startEnrollmentUserError = Schema.Union([
  notLoggedIn,
  invalidChallenge,
  verifyPasswordUserError,
  verifyCodeUserError,
  Schema.Struct({ error: Schema.Literal("MFA_CODE_REQUIRED") }),
  // The account has a password and none was given, or it has none and its
  // session is not recent: sign in again first.
  Schema.Struct({ error: Schema.Literal("REAUTHENTICATION_REQUIRED") }),
]);
export const confirmEnrollmentUserError = Schema.Union([notLoggedIn, invalidChallenge, confirmMultiTotpUserError, verifyCodeUserError]);
export const manageUserError = Schema.Union([
  notLoggedIn,
  verifyCodeUserError,
  Schema.Struct({ error: Schema.Literal("TOTP_NOT_FOUND") }),
  Schema.Struct({ error: Schema.Literal("MFA_NOT_ENABLED") }),
  Schema.Struct({ error: Schema.Literal("MFA_REQUIRED_BY_POLICY") }),
]);
export { verifyPendingUserError };

type UserErrorOf<S extends Schema.Top> = S["Type"];
type Failure<U> = { readonly success: false; readonly userError: U };

/** The method a pending sign-in names is no longer bound here: roll its transaction back and refuse the challenge. */
class PendingMethodGone extends Schema.TaggedError<PendingMethodGone>()("PendingMethodGone", {}) {}

export interface MfaOptions {
  readonly runtime: CoreRuntime;
  /** The TOTP key (`totpKey(masterSecret)`). */
  readonly key: string;
  /** Names the runtime in authenticator apps; a colon is replaced, since the Key Uri Format splits at it. */
  readonly issuer: string;
}

export function setupMfa(core: AuthCore, options: MfaOptions) {
  const { runtime, key } = options;
  const issuer = options.issuer.replaceAll(":", " ").trim() || "Zelavis";
  assertValidIssuer(issuer);

  const accountName = Effect.fn("auth.mfa.accountName")(function* (tx: AuthTx, userId: string) {
    return (yield* getUsername(tx, { userId })) ?? (yield* getPrimaryEmail(tx, { userId })) ?? userId;
  });

  const sessionAuthority = Effect.fn("auth.mfa.sessionAuthority")(function* (tx: AuthTx) {
    if (tx.caller === undefined) return null;
    const session = yield* tx.db.get(coreTables.sessions, tx.caller.sessionId);
    if (session === null) return null;
    const proofRevision = yield* readProofRevision(tx, session.userId);
    if (proofRevision === null) return null;
    return { userId: session.userId, startedAt: session._creationTime, authority: { kind: "session", id: session._id, proofRevision } } as const;
  });

  const findEnrollmentChallenge = Effect.fn("auth.mfa.findEnrollmentChallenge")(function* (tx: AuthTx, challenge: string) {
    const row = yield* findPendingSignIn(tx, { challenge, kind: "enroll" });
    if (row === null || !(yield* core.pendingProviderIsCurrent(tx, row)) || (yield* hasActiveSecret(tx, row.userId))) return null;
    return row;
  });

  const enroll = Effect.fn("auth.mfa.enroll")(function* (tx: AuthTx, userId: string, authority: EnrollmentAuthority) {
    const created = yield* createTotp(tx, { userId, issuerDisplayName: issuer, accountDisplayName: yield* accountName(tx, userId), key, authority });
    return { success: true, ...created } as const;
  });

  const enrollFromSession = Effect.fn("auth.mfa.enrollFromSession")(function* (
    tx: AuthTx,
    userId: string,
    authority: EnrollmentAuthority,
    code: string | undefined,
  ) {
    if (yield* hasActiveSecret(tx, userId)) {
      if (code === undefined) return { success: false, userError: { error: "MFA_CODE_REQUIRED" } } as const;
      const verified = yield* verifyCode(tx, { userId, code, key });
      if (!verified.success) return verified;
    }
    return yield* enroll(tx, userId, authority);
  });

  const confirm = (tx: AuthTx, userId: string, authority: EnrollmentAuthority, totpId: string, code: string) =>
    withCodeLimit(tx, userId, confirmTotp(tx, { userId, code, key, enrollment: { totpId, authority } }));

  const finishFirstEnrollment = Effect.fn("auth.mfa.finishFirstEnrollment")(function* (tx: AuthTx, userId: string, keepSessionId?: string) {
    yield* invalidatePendingProofs(tx, userId);
    yield* endAccountSessions(tx, userId, keepSessionId);
  });

  /** Finish a redeemed pending sign-in; a method no longer bound fails the transaction, so nothing it wrote commits. */
  const finish = (tx: AuthTx, row: PendingSignIn) =>
    Effect.gen(function* () {
      const signIn = yield* redeemPendingSignIn(tx, row, key);
      const tokens = yield* core.finishPendingSignIn(tx, signIn);
      if (tokens === null) return yield* Effect.fail(new PendingMethodGone());
      return { status: "complete", tokens } satisfies SignInComplete;
    });

  const refuseGone = <A>(effect: Effect.Effect<A, PendingMethodGone | AuthFailure>) =>
    effect.pipe(Effect.catchTag("PendingMethodGone", () => Effect.succeed({ success: false, userError: { error: "INVALID_CHALLENGE" } } as const)));

  /**
   * Start an enrollment: from a session (with `password` when the account has
   * one), or with an `enroll` challenge for the first authenticator. A
   * signed-in account with a factor must also give a fresh code from it.
   */
  const startEnrollment = Effect.fn("auth.mfa.startEnrollment")(function* (
    call: AuthCall,
    { password, challenge, code }: { password?: string | undefined; challenge?: string | undefined; code?: string | undefined },
  ): Effect.fn.Return<({ success: true } & CreateTotpResult) | Failure<UserErrorOf<typeof startEnrollmentUserError>>, AuthFailure> {
    if (challenge !== undefined) {
      return yield* runtime.mutation(call, (tx) => Effect.gen(function* () {
        const row = yield* findEnrollmentChallenge(tx, challenge);
        if (row === null) return invalidEnrollmentChallenge;
        return yield* enroll(tx, row.userId, { kind: "challenge", id: row._id, proofRevision: row.proofRevision });
      }));
    }
    const begun = yield* runtime.mutation(call, (tx) => Effect.gen(function* () {
      const session = yield* sessionAuthority(tx);
      if (session === null) return { step: "done", result: missingSession } as const;
      const { userId, authority } = session;
      const hasPassword = (yield* tx.db.query(passwordTables.passwords).withIndex("by_userId", (q) => q.eq("userId", userId)).first()) !== null;
      if (!hasPassword) {
        if (tx.now - session.startedAt > RECENT_SIGN_IN_MS) {
          return { step: "done", result: reauthenticationRequired } as const;
        }
        return { step: "done", result: yield* enrollFromSession(tx, userId, authority, code) } as const;
      }
      if (password === undefined) return { step: "done", result: reauthenticationRequired } as const;
      const verify = yield* beginVerify(tx, { userId, password });
      if (!verify.success) return { step: "done", result: { success: false, userError: verify.userError } } as const;
      return { step: "verify", userId, authority, stored: verify.stored } as const;
    }));
    if (begun.step === "done") return begun.result;

    // Outside any transaction: the slow work.
    if (password === undefined || !(yield* verifyPasswordHash(password, begun.stored))) return invalidCredentials;
    const rehashed = needsRehash(begun.stored) ? yield* hashPassword(password) : undefined;
    return yield* runtime.mutation(call, (tx) => Effect.gen(function* () {
      const session = yield* sessionAuthority(tx);
      if (session === null || session.userId !== begun.userId || session.authority.id !== begun.authority.id) return missingSession;
      if (session.authority.proofRevision !== begun.authority.proofRevision) return reauthenticationRequired;
      const finished = yield* finishVerify(tx, { userId: begun.userId, stored: begun.stored, rehashed });
      if (!finished.success) return invalidCredentials;
      return yield* enrollFromSession(tx, session.userId, session.authority, code);
    }));
  });

  /**
   * Confirm the pending enrollment with a code. From a session it answers the
   * new authenticator (and backup codes for the first one); with an `enroll`
   * challenge it also completes the sign-in the challenge stood for.
   */
  const confirmEnrollment = Effect.fn("auth.mfa.confirmEnrollment")(function* (
    call: AuthCall,
    { totpId, code, challenge }: { totpId: string; code: string; challenge?: string | undefined },
  ) {
    if (challenge === undefined) {
      return yield* runtime.mutation(call, (tx) => Effect.gen(function* () {
        const session = yield* sessionAuthority(tx);
        if (session === null) return missingSession;
        const { userId, authority } = session;
        const confirmed = yield* confirm(tx, userId, authority, totpId, code);
        if (!confirmed.success) return confirmed;
        if (confirmed.backupCodes !== undefined) yield* finishFirstEnrollment(tx, userId, authority.id);
        yield* recordSecurityEvent(tx, { kind: "mfa.enrolled", accountId: userId, detail: { first: confirmed.backupCodes !== undefined } });
        return { ...confirmed, signIn: undefined };
      }));
    }
    return yield* refuseGone(runtime.mutation(call, (tx) => Effect.gen(function* () {
      const row = yield* findEnrollmentChallenge(tx, challenge);
      if (row === null) return invalidEnrollmentChallenge;
      const confirmed = yield* confirm(tx, row.userId, { kind: "challenge", id: row._id, proofRevision: row.proofRevision }, totpId, code);
      if (!confirmed.success) {
        if (confirmed.userError.error === "INCORRECT_CODE") yield* countWrongCode(tx, row);
        return confirmed;
      }
      yield* finishFirstEnrollment(tx, row.userId);
      yield* recordSecurityEvent(tx, { kind: "mfa.enrolled", accountId: row.userId, detail: { first: true } });
      return { ...confirmed, signIn: yield* finish(tx, row) };
    })));
  });

  /** The second step of a gated sign-in: a TOTP or backup code for a `verify` challenge. */
  const verify = Effect.fn("auth.mfa.verify")(function* (call: AuthCall, { challenge, code }: { challenge: string; code: string }) {
    return yield* refuseGone(runtime.mutation(call, (tx) => Effect.gen(function* () {
      const verified = yield* verifyPendingSignIn(tx, { challenge, code, key });
      if (!verified.success) return verified;
      const tokens = yield* core.finishPendingSignIn(tx, verified.signIn);
      if (tokens === null) return yield* Effect.fail(new PendingMethodGone());
      return { status: "complete", tokens } satisfies SignInComplete;
    })));
  });

  /** The signed-in account's authenticators and how many backup codes it has left. */
  const status = Effect.fn("auth.mfa.status")(function* (call: AuthCall) {
    return yield* runtime.query(call, (tx) => Effect.gen(function* () {
      const userId = yield* getAuthUserId(tx);
      if (userId === null) return { success: false, userError: { error: "NOT_LOGGED_IN" } } as const;
      const current = yield* getStatus(tx, { userId });
      return { success: true, enabled: current.enabled, totps: yield* listTotps(tx, { userId }), backupCodesRemaining: current.remainingBackupCodes } as const;
    }));
  });

  /**
   * Remove one authenticator, given a current code (from any authenticator or
   * a backup code). Removing the last one turns the second factor off and
   * deletes the backup codes.
   */
  const removeTotp = Effect.fn("auth.mfa.removeTotp")(function* (call: AuthCall, { totpId, code }: { totpId: string; code: string }) {
    return yield* runtime.mutation(call, (tx) => Effect.gen(function* () {
      const userId = yield* getAuthUserId(tx);
      if (userId === null) return { success: false, userError: { error: "NOT_LOGGED_IN" } } as const;
      const active = yield* activeSecrets(tx, userId);
      const target = active.find((row) => row._id === totpId);
      if (target === undefined) return { success: false, userError: { error: "TOTP_NOT_FOUND" } } as const;
      if (active.length === 1 && (yield* policyRequires(tx, userId))) {
        return { success: false, userError: { error: "MFA_REQUIRED_BY_POLICY" } } as const;
      }
      const verified = yield* verifyCode(tx, { userId, code, key });
      if (!verified.success) return verified;
      yield* tx.db.delete(totpTables.totpSecrets, target._id);
      yield* invalidatePendingProofs(tx, userId);
      if (active.length === 1) {
        for (const row of yield* backupCodesByUserId(tx, userId)) {
          yield* tx.db.delete(totpTables.backupCodes, row._id);
        }
      }
      yield* recordSecurityEvent(tx, { kind: "mfa.removed", accountId: userId, detail: { last: active.length === 1 } });
      return { success: true } as const;
    }));
  });

  /** Replace the backup codes, given a current code; answers the new ones, once. */
  const regenerateBackupCodes = Effect.fn("auth.mfa.regenerateBackupCodes")(function* (call: AuthCall, { code }: { code: string }) {
    return yield* runtime.mutation(call, (tx) => Effect.gen(function* () {
      const userId = yield* getAuthUserId(tx);
      if (userId === null) return { success: false, userError: { error: "NOT_LOGGED_IN" } } as const;
      if ((yield* activeSecrets(tx, userId)).length === 0) return { success: false, userError: { error: "MFA_NOT_ENABLED" } } as const;
      const verified = yield* verifyCode(tx, { userId, code, key });
      if (!verified.success) return verified;
      const backupCodes = yield* replaceBackupCodes(tx, userId);
      yield* recordSecurityEvent(tx, { kind: "mfa.backup_codes_replaced", accountId: userId });
      return { success: true, backupCodes } as const;
    }));
  });

  const policy = {
    get: (call: AuthCall): Effect.Effect<MfaPolicy, AuthFailure> => runtime.query(call, (tx) => readPolicy(tx)),
    set: (call: AuthCall, input: MfaPolicyInput) => runtime.mutation(call, (tx) => Effect.gen(function* () {
      const result = yield* setPolicy(tx, input);
      if (result.success) {
        yield* recordSecurityEvent(tx, { kind: "mfa.policy.changed", actorId: call.caller?.userId, detail: { requiredFor: result.policy.requiredFor } });
      }
      return result;
    })),
  };

  return { issuer, startEnrollment, confirmEnrollment, verify, status, removeTotp, regenerateBackupCodes, policy };
}

export type MfaMethod = ReturnType<typeof setupMfa>;
