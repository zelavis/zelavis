// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/totp/helpers.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the helpers are Effects over an AuthTxBase (T1, T2); matchCode opens the sealed secret with the TOTP key first, and an unreadable secret matches no code.
/**
 * Helpers over the tables of the component, for its public functions.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import type { TransactionTooLarge } from "../../db/errors.js";
import { decryptSecret, encryptSecret } from "../../edge/acme-crypto.js";
import type { AuthTxBase } from "../runtime/index.js";
import { generateBackupCodes, hashBackupCode } from "./backupCodes.js";
import { type BackupCode, type TotpSecret, totpTables } from "./tables.js";
import { base32Decode, hotp, timingSafeEqual, totpCounter } from "./totp.js";
import { isWellFormedCode, normalizeCode } from "./validation.js";

// The number of time steps of clock drift the verification tolerates, on each
// side of the current step (RFC 6238, section 5.2). One step each way accepts
// the previous and the next code with the current one, thus a code stays valid
// for at least 30 seconds after the authenticator showed it.
const WINDOW_STEPS = 1;

/** The key TOTP secrets and pending profiles are sealed with: bound to its purpose, so no other sealed record opens as one. */
export const totpKey = (masterSecret: string) => `${masterSecret}\u0000zelavis.auth.totp`;

/** Seal a value with the TOTP key. */
export const seal = (value: string, key: string) => ({ ...encryptSecret(value, key) });

/** Open a value sealed with {@link seal}; undefined when it cannot be opened (the master secret changed). */
export const open = (sealed: TotpSecret["sealedSecret"], key: string): Effect.Effect<string | undefined> =>
  Effect.try({ try: () => decryptSecret({ ...sealed }, key), catch: () => "unreadable" as const }).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );

/**
 * Find the time step within the window whose code is `code`, or `null` when
 * no step matches.
 *
 * The steps are checked from the oldest to the newest, and the code of each
 * step is compared in constant time.
 */
export const matchCode = Effect.fn("auth.totp.matchCode")(function* (
  secret: TotpSecret,
  code: string,
  nowMs: number,
  key: string,
) {
  const normalized = normalizeCode(code);
  if (!isWellFormedCode(normalized, secret.digits)) {
    return null;
  }
  const opened = yield* open(secret.sealedSecret, key);
  if (opened === undefined) {
    yield* Effect.logWarning(`The TOTP secret ${secret._id} cannot be opened; no code matches it.`);
    return null;
  }
  const secretBytes = base32Decode(opened);
  const currentCounter = totpCounter(nowMs, secret.period);
  for (let step = -WINDOW_STEPS; step <= WINDOW_STEPS; step++) {
    const counter = currentCounter + step;
    const expected = yield* hotp(secretBytes, counter, secret);
    if (timingSafeEqual(expected, normalized)) {
      return counter;
    }
  }
  return null;
});

/**
 * Delete the backup codes of a user and store a new set. Return the new codes
 * in the form the user sees them.
 */
export const replaceBackupCodes = Effect.fn("auth.totp.replaceBackupCodes")(function* (
  tx: AuthTxBase,
  userId: string,
) {
  for (const row of yield* backupCodesByUserId(tx, userId)) {
    yield* tx.db.delete(totpTables.backupCodes, row._id);
  }
  const codes = generateBackupCodes();
  for (const code of codes) {
    yield* tx.db.insert(totpTables.backupCodes, {
      userId,
      codeHash: yield* hashBackupCode(code),
    });
  }
  return codes;
});

/**
 * The active secrets of a user, oldest first: the ones that sign-in codes are
 * checked against. The component keeps their number within
 * `MAX_TOTPS_PER_USER`.
 */
export function activeSecrets(
  tx: AuthTxBase,
  userId: string,
): Effect.Effect<ReadonlyArray<TotpSecret>, TransactionTooLarge> {
  return tx.db
    .query(totpTables.totpSecrets)
    .withIndex("by_userId_status", (q) =>
      q.eq("userId", userId).eq("status", "active"),
    )
    .collect();
}

/** Tell if a user has at least one active secret. */
export function hasActiveSecret(
  tx: AuthTxBase,
  userId: string,
): Effect.Effect<boolean, TransactionTooLarge> {
  return tx.db
    .query(totpTables.totpSecrets)
    .withIndex("by_userId_status", (q) =>
      q.eq("userId", userId).eq("status", "active"),
    )
    .first()
    .pipe(Effect.map((first) => first !== null));
}

/** The pending secret of a user: an enrollment awaiting confirmation. */
export function pendingSecret(
  tx: AuthTxBase,
  userId: string,
): Effect.Effect<TotpSecret | null, TransactionTooLarge> {
  return tx.db
    .query(totpTables.totpSecrets)
    .withIndex("by_userId_status", (q) =>
      q.eq("userId", userId).eq("status", "pending"),
    )
    .unique();
}

export function backupCodesByUserId(
  tx: AuthTxBase,
  userId: string,
): Effect.Effect<ReadonlyArray<BackupCode>, TransactionTooLarge> {
  return tx.db
    .query(totpTables.backupCodes)
    .withIndex("by_userId_codeHash", (q) => q.eq("userId", userId))
    .collect();
}
