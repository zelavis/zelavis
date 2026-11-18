// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/totp/schema.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: tables are declared through defineTables (T5); the secret is stored sealed with the runtime's master secret instead of as raw bytes (I5); pendingSignIns and policy are Zelavis tables for the sign-in gate.
import * as Schema from "effect/Schema";
import type { RowOf } from "../core/tables.js";
import { SealedSchema } from "../keys/tables.js";
import { defineTable, defineTables } from "../runtime/index.js";

export const totpAlgorithm = Schema.Literals(["SHA-1", "SHA-256", "SHA-512"]);

const EnrollmentAuthority = Schema.Struct({
  kind: Schema.Literals(["session", "challenge"]),
  id: Schema.String,
  proofRevision: Schema.Number,
});
export type EnrollmentAuthority = typeof EnrollmentAuthority.Type;

export const totpTables = defineTables("totp", {
  // The TOTP secrets. A user has up to `MAX_TOTPS_PER_USER` `active` secrets
  // (one per authenticator app; a sign-in code from any of them is accepted)
  // and at most one `pending` secret (a new enrollment that the user has not
  // confirmed yet). The component keeps both properties true. Convex does not
  // enforce unique indexes.
  totpSecrets: defineTable({
    userId: Schema.String,
    // The shared secret, base32-encoded and sealed with the runtime's master
    // secret (Zelavis: upstream keeps the raw bytes and notes a key ring as
    // future hardening). The server opens it to compute a code to compare
    // against what the client provided; no function returns the secret of an
    // active TOTP.
    sealedSecret: SealedSchema,
    // The parameters the codes are computed with. Stored per row so that a
    // change of the defaults never breaks an enrolled authenticator.
    algorithm: totpAlgorithm,
    digits: Schema.Number,
    // The time step, in seconds.
    period: Schema.Number,
    status: Schema.Literals(["pending", "active"]),
    // The live proof that started this pending enrollment. Cleared on activation.
    authority: Schema.optional(EnrollmentAuthority),
    // The time-step counter of the last code that was accepted. A code for
    // this counter or an earlier one is rejected, so that a code observed by
    // an attacker cannot be replayed within the validity window.
    lastUsedCounter: Schema.optional(Schema.Number),
  }).index("by_userId_status", ["userId", "status"]),

  // One row for each unused backup code of a user. A code is deleted when it
  // is used. Only the SHA-256 hash of the (normalized) code is stored.
  backupCodes: defineTable({
    userId: Schema.String,
    codeHash: Schema.String,
  }).index("by_userId_codeHash", ["userId", "codeHash"]),

  // Zelavis: a sign-in whose first factor passed and that waits for the
  // second (`verify`), or for the account to enroll one first (`enroll`).
  // The challenge handed to the client is stored only as its SHA-256 hash;
  // the method's profile is sealed, since it may carry an email address.
  pendingSignIns: defineTable({
    userId: Schema.String,
    // The sign-in method that passed the first factor, and the module that
    // authenticated it: the session is created for them.
    method: Schema.String,
    component: Schema.String,
    sealedProfile: SealedSchema,
    challengeHash: Schema.String,
    proofRevision: Schema.optional(Schema.Number),
    methodRevision: Schema.optional(Schema.Number),
    providerRevision: Schema.optional(Schema.String),
    kind: Schema.Literals(["verify", "enroll"]),
    attempts: Schema.Number,
    expiresAt: Schema.Number,
  }).index("by_challengeHash", ["challengeHash"]).index("by_expiresAt", ["expiresAt"]),

  // Zelavis: at most one row, which accounts must have a second factor.
  // No row reads as `none`.
  policy: defineTable({
    requiredFor: Schema.Literals(["none", "privileged", "all"]),
    revision: Schema.Number,
  }),
});

export type TotpSecret = RowOf<typeof totpTables.totpSecrets>;
export type BackupCode = RowOf<typeof totpTables.backupCodes>;
export type PendingSignIn = RowOf<typeof totpTables.pendingSignIns>;
