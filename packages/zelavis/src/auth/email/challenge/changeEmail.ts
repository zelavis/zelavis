// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/email/challenge/changeEmail.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: mutations are Effects over an AuthTx (T1-T4), results are TypeScript types, throws that rolled back a Convex mutation are defects (T8), and the link and email come from the sender in the arguments (see common.ts).
// The `changeEmail` challenge: prove that an address belongs to
// `userId`, then make it the primary address of the user. The previous
// primary address is removed from the account. For apps where each user has
// one email address.

import * as Effect from "effect/Effect";
import { type AuthTx } from "../../core/context.js";
import { ADD_EMAIL_TTL_MS } from "../helpers.js";
import { clearEmailReservation } from "../reservations.js";
import { emailTables } from "../tables.js";
import { CHANGE_EMAIL_COPY } from "../templates.js";
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
export const check = Effect.fn("auth.email.changeEmail.check")(function* (
  tx: AuthTx,
  { email }: { email: string },
) {
  return (yield* startFreeAddressPreconditions(tx, email, "check")) satisfies StartFreeAddressUserError | null;
});

/**
 * Start a `changeEmail` challenge for `userId`. Fails with `EMAIL_TAKEN`
 * when a user has already verified the address.
 *
 * DANGER: `complete`, the second step of this challenge
 * (`challenge.changeEmail.complete`), records the address on the `userId`
 * given here. It only checks that its own `userId` matches this one, thus an
 * unverified `userId` here lets an attacker attach their mailbox to another
 * user's account. `complete` needs no prefix: once this `userId` is right,
 * a wrong `userId` there fails with `WRONG_USER`.
 *
 * TODO: ensure that the user ID is the current user.
 */
export const _internal_dangerous_start = Effect.fn("auth.email.changeEmail._internal_dangerous_start")(function* (
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
    purpose: { kind: "changeEmail", userId: args.userId },
    ttlMs: ADD_EMAIL_TTL_MS,
    emailSender: args.emailSender,
    copy: CHANGE_EMAIL_COPY,
  });
  return { success: true, ...created } satisfies StartFreeAddressResult;
});

export type ChangeEmailCompleteResult =
  | {
      success: true;
      userId: string;
      email: string;
      // The address that was primary before this completion replaced it, or
      // `null` when there was none. Callers use it to notify the old address.
      previousEmail: string | null;
    }
  | CompleteCallerAddressFailure;

/**
 * Complete a `changeEmail` challenge: remove the old primary address and
 * record the new one as primary. The `userId` must be the one given at
 * start; another user fails with `WRONG_USER`, and
 * the challenge stays.
 *
 * This can fail with `EMAIL_TAKEN` in the very rare case where the email is
 * assigned to someone else on verification. This can happen in the following scenario:
 * - Alice starts an email change flow for `new@example.com`. At this point,
 *   `new@example.com` is assigned to nobody, so the flow is allowed to start.
 * - Bob also starts an email change flow for `new@example.com`.
 * - Bob completes the flow, and is assigned `new@example.com`.
 * - Alice attempts to complete the flow too, but at this point the email
 *   is no longer available, so the completion fails with `EMAIL_TAKEN`.
 */
export const complete = Effect.fn("auth.email.changeEmail.complete")(function* (
  tx: AuthTx,
  args: ClaimArgs & { userId: string },
) {
  const { userId } = args;
  const claim = yield* claimChallenge(tx, {
    emailCode: args.emailCode,
    browserSecret: args.browserSecret,
    purpose: { kind: "changeEmail", userId },
  });
  if (!claim.success) {
    return claim.failure satisfies ChangeEmailCompleteResult;
  }
  const { row } = claim;
  const normalizedEmail = normalizeEmail(row.email);
  const taken = yield* addressTakenError(tx, normalizedEmail, userId);
  if (taken !== null) {
    return { success: false, userError: taken } satisfies ChangeEmailCompleteResult;
  }
  // For a first email there is nothing to replace; for a change-email flow
  // the old address is removed from the account.
  const oldPrimary = yield* tx.db
    .query(emailTables.verifiedEmails)
    .withIndex("by_userId_isPrimary", (q) =>
      q.eq("userId", userId).eq("isPrimary", true),
    )
    .unique();
  let previousEmail: string | null = null;
  if (oldPrimary !== null) {
    previousEmail = oldPrimary.email;
    yield* tx.db.delete(emailTables.verifiedEmails, oldPrimary._id);
  }
  yield* clearEmailReservation(tx, userId);
  yield* tx.db.insert(emailTables.verifiedEmails, {
    email: row.email,
    normalizedEmail,
    userId,
    isPrimary: true,
  });
  return {
    success: true,
    userId,
    email: row.email,
    previousEmail,
  } satisfies ChangeEmailCompleteResult;
});
