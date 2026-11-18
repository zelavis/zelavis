// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/email/challenge/addEmail.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: mutations are Effects over an AuthTx (T1-T4), results are TypeScript types, throws that rolled back a Convex mutation are defects (T8), and the link and email come from the sender in the arguments (see common.ts).
// The `addEmail` challenge: prove that an address belongs to `userId`, then
// record it as an email address of the user. The first address of a user
// becomes primary; a later address is secondary.

import * as Effect from "effect/Effect";
import { type AuthTx } from "../../core/context.js";
import {
  ADD_EMAIL_TTL_MS,
  userHasEmail,
} from "../helpers.js";
import { emailReservation, emailReservationTables } from "../reservations.js";
import { emailTables } from "../tables.js";
import { VALIDATE_EMAIL_COPY } from "../templates.js";
import { normalizeEmail, type StartFreeAddressUserError } from "../validation.js";
import {
  type StartArgs,
  type ClaimArgs,
  type StartFreeAddressResult,
  type CompleteCallerAddressFailure,
  startFreeAddressPreconditions,
  addressTakenError,
  createChallengeAndSendEmail,
  claimChallenge,
} from "./common.js";

/**
 * Tell whether `start` would fail with a `userError` for this address,
 * typically without consuming the rate limits. See `custom.check`.
 *
 * One exception: `EMAIL_TAKEN` takes a token from the `lookupEmailPerIp`
 * limit, because it tells the caller that the address has an account. See
 * `startFreeAddressPreconditions`.
 */
export const check = Effect.fn("auth.email.addEmail.check")(function* (
  tx: AuthTx,
  { email }: { email: string },
) {
  return (yield* startFreeAddressPreconditions(tx, email, "check")) satisfies StartFreeAddressUserError | null;
});

/**
 * Start an `addEmail` challenge for `userId`. Fails with `EMAIL_TAKEN` when
 * a user has already verified the address.
 *
 * DANGER: `complete`, the second step of this challenge
 * (`challenge.addEmail.complete`), records the address on the `userId`
 * given here. It only checks that its own `userId` matches this one, thus an
 * unverified `userId` here lets an attacker attach their mailbox to another
 * user's account. `complete` needs no prefix: once this `userId` is right,
 * a wrong `userId` there fails with `WRONG_USER`.
 *
 * TODO: ensure that the user ID is the current user.
 */
export const _internal_dangerous_start = Effect.fn("auth.email.addEmail._internal_dangerous_start")(function* (
  tx: AuthTx,
  args: StartArgs & { userId: string },
) {
  const error = yield* startFreeAddressPreconditions(
    tx,
    args.email,
    "consume",
    args.userId,
  );
  if (error !== null) {
    return { success: false, userError: error } satisfies StartFreeAddressResult;
  }
  const created = yield* createChallengeAndSendEmail(tx, {
    email: args.email,
    purpose: { kind: "addEmail", userId: args.userId },
    ttlMs: ADD_EMAIL_TTL_MS,
    emailSender: args.emailSender,
    copy: VALIDATE_EMAIL_COPY,
  });
  return { success: true, ...created } satisfies StartFreeAddressResult;
});

export type AddEmailCompleteResult =
  | { success: true; userId: string; email: string }
  | CompleteCallerAddressFailure;

/**
 * Complete an `addEmail` challenge: record the address for the user. The
 * `userId` must be the one given at start; another user fails with
 * `WRONG_USER`, and the challenge stays. Fails with `EMAIL_TAKEN` when
 * another user verified the address after the start.
 */
export const complete = Effect.fn("auth.email.addEmail.complete")(function* (
  tx: AuthTx,
  args: ClaimArgs & { userId: string },
) {
  const { userId } = args;
  const claim = yield* claimChallenge(tx, {
    emailCode: args.emailCode,
    browserSecret: args.browserSecret,
    purpose: { kind: "addEmail", userId },
  });
  if (!claim.success) {
    return claim.failure satisfies AddEmailCompleteResult;
  }
  const { row } = claim;
  const normalizedEmail = normalizeEmail(row.email);
  const taken = yield* addressTakenError(tx, normalizedEmail, userId);
  if (taken !== null) {
    return { success: false, userError: taken } satisfies AddEmailCompleteResult;
  }
  const reservation = yield* emailReservation(tx, normalizedEmail);
  if (reservation !== null) yield* tx.db.delete(emailReservationTables.passwordReservations, reservation._id);
  // The first address of a user always becomes primary.
  const isPrimary = !(yield* userHasEmail(tx, userId));
  yield* tx.db.insert(emailTables.verifiedEmails, {
    email: row.email,
    normalizedEmail,
    userId,
    isPrimary,
  });
  return { success: true, userId, email: row.email } satisfies AddEmailCompleteResult;
});
