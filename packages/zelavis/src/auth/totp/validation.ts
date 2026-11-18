// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/totp/validation.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the user-error validators are Effect Schemas (T5).
import * as Schema from "effect/Schema";

/**
 * The user-facing errors for `confirmTotp` when the user has no active
 * authenticator, as in a setup recipe that gives each user a single one. A
 * recipe that lets a user add authenticators reuses
 * {@link confirmMultiTotpUserError} instead. An application can show these
 * errors to the end user. The `error` field is a machine-readable code and
 * the discriminant of the union.
 */
export const confirmSingleTotpUserError = Schema.Union([
  // The code is not the code that the pending secret gives at this moment.
  // Usually the user typed it wrong, or the clock of their device is off.
  Schema.Struct({ error: Schema.Literal("INCORRECT_CODE") }),
  // The user has no pending secret: `createTotp` was not called, the
  // enrollment was confirmed already, or it expired.
  Schema.Struct({ error: Schema.Literal("NO_PENDING_ENROLLMENT") }),
]);
export type ConfirmSingleTotpUserError = typeof confirmSingleTotpUserError.Type;

/**
 * The user-facing errors for `confirmTotp`: the errors of
 * {@link confirmSingleTotpUserError}, and `TOO_MANY_TOTPS` for a user who
 * already has as many authenticators as the component allows.
 */
export const confirmMultiTotpUserError = Schema.Union([
  confirmSingleTotpUserError,
  // The user has `MAX_TOTPS_PER_USER` active secrets. The user deletes one
  // first.
  Schema.Struct({ error: Schema.Literal("TOO_MANY_TOTPS") }),
]);
export type ConfirmMultiTotpUserError = typeof confirmMultiTotpUserError.Type;

/**
 * Normalize a TOTP code as the user typed it. Authenticator apps show the
 * code with a space in the middle (`123 456`), and a user copies that space.
 */
export function normalizeCode(code: string): string {
  return code.replace(/\s/g, "");
}

/**
 * Tell if a normalized code has the form of a TOTP code with this many digits.
 */
export function isWellFormedCode(code: string, digits: number): boolean {
  return new RegExp(`^[0-9]{${digits}}$`).test(code);
}
