// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/totp/enrollment.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the mutations and queries are Effects over an AuthTxBase (T1-T4) and the result validators are Effect Schemas (T5); the secret is sealed with the TOTP key before it is stored (I5), and `Date.now()` is `tx.now` (T9).
/**
 * TOTP enrollment: the functions of the component that a signed-in user
 * reaches from a settings page to set the second factor up.
 *
 * A user may have up to {@link MAX_TOTPS_PER_USER} TOTPs in the "active"
 * status, one for each authenticator app, and at most one in the "pending"
 * status. An active TOTP is one that the user confirmed with a valid code
 * generated from the shared secret. A user with any active TOTP owes a code at
 * sign-in, and a code from any of them is accepted (see {@link getStatus} and
 * {@link listTotps}). A pending TOTP is one that is awaiting a call to
 * {@link confirmTotp} to move it to the active status. It can be confirmed
 * for {@link PENDING_ENROLLMENT_TTL_MS} after its creation.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { AuthTxBase } from "../runtime/index.js";
import {
  activeSecrets,
  backupCodesByUserId,
  hasActiveSecret,
  matchCode,
  pendingSecret,
  replaceBackupCodes,
  seal,
} from "./helpers.js";
import { type EnrollmentAuthority, type TotpSecret, totpTables } from "./tables.js";
import {
  DEFAULT_ALGORITHM,
  DEFAULT_DIGITS,
  DEFAULT_PERIOD,
  base32Encode,
  generateSecret,
  otpauthUri,
} from "./totp.js";
import { confirmMultiTotpUserError } from "./validation.js";

export const createTotpResult = Schema.Struct({
  totpId: Schema.String,
  // The base32-encoded secret, for a user who types it into the authenticator
  // app by hand.
  secret: Schema.String,
  // The `otpauth://` URI, for a QR code that the authenticator app scans.
  otpauthUri: Schema.String,
});
export type CreateTotpResult = typeof createTotpResult.Type;

// How long a pending secret can be confirmed after `createTotp` made it.
export const PENDING_ENROLLMENT_TTL_MS = 60 * 60 * 1000; // 1 hour

// How many active secrets a user can have. Every code a user gives is checked
// against each of them, thus the limit bounds that work, and it is well above
// the number of authenticator apps a person keeps.
export const MAX_TOTPS_PER_USER = 10;

/**
 * Start the TOTP enrollment of a user: generate a new secret.
 *
 * The new secret is *pending*: its use should not be enforced at sign-in until
 * the user proves that their authenticator has it, with `confirmTotp`.
 *
 * The active TOTPs that a user has enrolled already keep working: confirming
 * the new one with `confirmTotp` adds it next to them. If a pending
 * enrollment was abandoned, a subsequent call replaces it.
 *
 * `issuerDisplayName` names the application and `accountDisplayName` names the
 * account (for example the user's email address). Both are shown in the
 * authenticator app. `key` is the TOTP key (`totpKey`) the secret is sealed
 * with.
 */
export const createTotp = Effect.fn("auth.totp.createTotp")(function* (
  tx: AuthTxBase,
  { userId, issuerDisplayName, accountDisplayName, key, authority }: {
    userId: string;
    issuerDisplayName: string;
    accountDisplayName: string;
    key: string;
    authority?: EnrollmentAuthority | undefined;
  },
) {
  const secret = generateSecret();
  const params = {
    algorithm: DEFAULT_ALGORITHM,
    digits: DEFAULT_DIGITS,
    period: DEFAULT_PERIOD,
  };

  const pending = yield* pendingSecret(tx, userId);
  if (pending !== null) {
    yield* tx.db.delete(totpTables.totpSecrets, pending._id);
  }
  const encodedSecret = base32Encode(secret);
  const totpId = yield* tx.db.insert(totpTables.totpSecrets, {
    userId,
    sealedSecret: seal(encodedSecret, key),
    ...params,
    status: "pending",
    authority,
  });

  return {
    totpId,
    secret: encodedSecret,
    otpauthUri: otpauthUri({
      secret: encodedSecret,
      ...params,
      issuer: issuerDisplayName,
      accountName: accountDisplayName,
    }),
  } satisfies CreateTotpResult;
});

export const confirmTotpResult = Schema.Union([
  Schema.Struct({
    success: Schema.Literal(true),
    // The id of the new active secret.
    totpId: Schema.String,
    // The new backup codes, in the form the user sees them, when this
    // secret turned the second factor on: the user had no active secret
    // before. A user who adds an authenticator keeps the backup codes they
    // have. This is the only time the component returns them: it stores
    // only their hashes.
    backupCodes: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    success: Schema.Literal(false),
    userError: confirmMultiTotpUserError,
  }),
]);
export type ConfirmTotpResult = typeof confirmTotpResult.Type;

/**
 * Finish the TOTP enrollment of a user: check a code against the pending
 * secret, and activate it next to the active secrets the user has already.
 *
 * The first active secret of a user comes with a new set of backup codes. A
 * user who adds a second authenticator keeps their backup codes. The code that
 * confirmed the secret cannot be used again to sign in.
 *
 * `NO_PENDING_ENROLLMENT` is for a user with no pending secret: the app has
 * not called `createTotp`, the enrollment was confirmed already (in another
 * tab, say), it was created too long ago, or the enrollment ID and authority
 * do not identify that secret. `TOO_MANY_TOTPS` is for a user
 * who has {@link MAX_TOTPS_PER_USER} active secrets already; the pending
 * secret stays, and can be confirmed once the user deletes one.
 */
export const confirmTotp = Effect.fn("auth.totp.confirmTotp")(function* (
  tx: AuthTxBase,
  { userId, code, key, enrollment }: {
    userId: string;
    code: string;
    key: string;
    enrollment?: { totpId: string; authority: EnrollmentAuthority };
  },
) {
  const pending = yield* confirmablePendingSecret(tx, userId);
  const matches = pending !== null &&
    pending.authority?.kind === enrollment?.authority.kind &&
    pending.authority?.id === enrollment?.authority.id &&
    pending.authority?.proofRevision === enrollment?.authority.proofRevision &&
    (enrollment === undefined || pending._id === enrollment.totpId);
  if (!matches) {
    return { success: false, userError: { error: "NO_PENDING_ENROLLMENT" } } satisfies ConfirmTotpResult;
  }
  const active = yield* activeSecrets(tx, userId);
  if (active.length >= MAX_TOTPS_PER_USER) {
    return { success: false, userError: { error: "TOO_MANY_TOTPS" } } satisfies ConfirmTotpResult;
  }
  if (!(yield* activate(tx, pending, code, key))) {
    return { success: false, userError: { error: "INCORRECT_CODE" } } satisfies ConfirmTotpResult;
  }
  if (active.length > 0) {
    return { success: true, totpId: pending._id } satisfies ConfirmTotpResult;
  }
  const backupCodes = yield* replaceBackupCodes(tx, userId);
  return { success: true, totpId: pending._id, backupCodes } satisfies ConfirmTotpResult;
});

/**
 * The pending secret of a user while it can still be confirmed, `null` when
 * there is none or it is too old.
 */
const confirmablePendingSecret = Effect.fn("auth.totp.confirmablePendingSecret")(function* (
  tx: AuthTxBase,
  userId: string,
) {
  const pending = yield* pendingSecret(tx, userId);
  if (
    pending === null ||
    tx.now - pending._creationTime >= PENDING_ENROLLMENT_TTL_MS
  ) {
    return null;
  }
  return pending;
});

/**
 * Check a code against a pending secret and, when it matches, make the
 * secret active, with the step of the code marked used. Return whether the
 * code matched.
 */
const activate = Effect.fn("auth.totp.activate")(function* (
  tx: AuthTxBase,
  pending: TotpSecret,
  code: string,
  key: string,
) {
  const matchedCounter = yield* matchCode(pending, code, tx.now, key);
  if (matchedCounter === null) {
    return false;
  }
  yield* tx.db.patch(totpTables.totpSecrets, pending._id, {
    status: "active",
    authority: undefined,
    lastUsedCounter: matchedCounter,
  });
  return true;
});

export const totpStatus = Schema.Struct({
  // `true` when the user has at least one active secret that they confirmed.
  enabled: Schema.Boolean,
  remainingBackupCodes: Schema.Number,
});
export type TotpStatus = typeof totpStatus.Type;

/**
 * Get the TOTP status of a user.
 *
 * A pending enrollment is not reported: the app cannot resume one (the
 * secret is returned once, by `createTotp`), only start over.
 */
export const getStatus = Effect.fn("auth.totp.getStatus")(function* (
  tx: AuthTxBase,
  { userId }: { userId: string },
) {
  const enabled = yield* hasActiveSecret(tx, userId);
  const backupCodes = yield* backupCodesByUserId(tx, userId);
  return {
    enabled,
    remainingBackupCodes: backupCodes.length,
  } satisfies TotpStatus;
});

export const totpSummary = Schema.Struct({
  // The id of the active secret.
  totpId: Schema.String,
  // When the enrollment of the secret started, in milliseconds since the
  // epoch. It was confirmed within `PENDING_ENROLLMENT_TTL_MS` of this.
  createdAt: Schema.Number,
});
export type TotpSummary = typeof totpSummary.Type;

/**
 * List the active secrets of a user, oldest first, for a settings page that
 * lets the user delete one of their authenticators. The secrets themselves
 * are never returned. A pending enrollment is not listed, as for
 * {@link getStatus}.
 */
export const listTotps = Effect.fn("auth.totp.listTotps")(function* (
  tx: AuthTxBase,
  { userId }: { userId: string },
) {
  const active = yield* activeSecrets(tx, userId);
  return active.map((row): TotpSummary => ({
    totpId: row._id,
    createdAt: row._creationTime,
  }));
});
