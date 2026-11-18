// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/email/challenge/signUp.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: mutations are Effects over an AuthTx (T1-T4), results are TypeScript types, throws that rolled back a Convex mutation are defects (T8), and the link and email come from the sender in the arguments (see common.ts).
// The `signUp` challenge: prove that an address belongs to a new user, then
// record it as the primary email address of the user. The user has no
// session yet, thus `complete` does not take a `userId`: the user is the one
// given at start.

import * as Effect from "effect/Effect";
import { type AuthTx } from "../../core/context.js";
import { invariant } from "../../runtime/index.js";
import {
  ADD_EMAIL_TTL_MS,
  userHasEmail,
} from "../helpers.js";
import { emailTables } from "../tables.js";
import { VALIDATE_EMAIL_COPY } from "../templates.js";
import { normalizeEmail, type StartFreeAddressUserError } from "../validation.js";
import {
  type StartArgs,
  type ClaimArgs,
  type StartFreeAddressResult,
  type CompleteFreeAddressFailure,
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
export const check = Effect.fn("auth.email.signUp.check")(function* (
  tx: AuthTx,
  { email }: { email: string },
) {
  return (yield* startFreeAddressPreconditions(tx, email, "check")) satisfies StartFreeAddressUserError | null;
});

/**
 * Start a `signUp` challenge for `userId`, a user that the sign-up has just
 * created. Fails with `EMAIL_TAKEN` when a user has already verified the
 * address.
 *
 * It is a defect when the user already has an email address: it is an
 * application bug. Give only a user that the same mutation has just created.
 *
 * DANGER: `complete`, the second step of this challenge
 * (`challenge.signUp.complete`), records the address on the `userId` given
 * here with no further check, thus an unverified `userId` here lets an
 * attacker attach their mailbox to another user's account. `complete` needs
 * no prefix: it takes no `userId`, thus this function is the only place
 * where the user is chosen.
 *
 * TODO: ensure that the user ID is a user that the current mutation has just
 * created.
 */
export const _internal_dangerous_start = Effect.fn("auth.email.signUp._internal_dangerous_start")(function* (
  tx: AuthTx,
  args: StartArgs & { userId: string },
) {
  if (yield* userHasEmail(tx, args.userId)) {
    return yield* invariant(
      "Cannot start a signUp challenge: the user already has an email " +
        "address. Use addEmail or changeEmail for an existing user.",
    );
  }
  const error = yield* startFreeAddressPreconditions(
    tx,
    args.email,
    "consume",
  );
  if (error !== null) {
    return { success: false, userError: error } satisfies StartFreeAddressResult;
  }
  const created = yield* createChallengeAndSendEmail(tx, {
    email: args.email,
    purpose: { kind: "signUp", userId: args.userId },
    ttlMs: ADD_EMAIL_TTL_MS,
    emailSender: args.emailSender,
    copy: VALIDATE_EMAIL_COPY,
  });
  return { success: true, ...created } satisfies StartFreeAddressResult;
});

export type SignUpCompleteResult =
  | { success: true; userId: string; email: string }
  | CompleteFreeAddressFailure;

/**
 * Complete a `signUp` challenge: record the address for the user that the
 * challenge was started for, and return that user.
 *
 * Fails with `EMAIL_TAKEN` when another user verified the address after the start.
 *
 * Fails with `INVALID_CHALLENGE` when the user already has an email address.
 * This happens when the app started more than one `signUp` challenge for the
 * user, and another one completed first: the sign-up is done, thus this link
 * is no longer valid. (This doesn’t happen when using the official email setup
 * functions, but it can happen if the user manually implements an auth flow
 * on top this challenge flow.)
 */
export const complete = Effect.fn("auth.email.signUp.complete")(function* (
  tx: AuthTx,
  args: ClaimArgs,
) {
  const claim = yield* claimChallenge(tx, {
    emailCode: args.emailCode,
    browserSecret: args.browserSecret,
    purpose: { kind: "signUp" },
  });
  if (!claim.success) {
    return claim.failure satisfies SignUpCompleteResult;
  }
  const { row } = claim;
  const { userId } = row.purpose;
  // Before `EMAIL_TAKEN`: when the other challenge was for the same address,
  // this user is the one who took it.
  if (yield* userHasEmail(tx, userId)) {
    yield* Effect.logWarning(
      `Rejected the email challenge ${row._id} for the purpose "signUp": ` +
        `the user already has an email address, most likely from another ` +
        `signUp challenge for the user that completed first.`,
    );
    return {
      success: false,
      userError: { error: "INVALID_CHALLENGE" },
    } satisfies SignUpCompleteResult;
  }
  const normalizedEmail = normalizeEmail(row.email);
  const taken = yield* addressTakenError(tx, normalizedEmail);
  if (taken !== null) {
    return { success: false, userError: taken } satisfies SignUpCompleteResult;
  }
  yield* tx.db.insert(emailTables.verifiedEmails, {
    email: row.email,
    normalizedEmail,
    userId,
    isPrimary: true,
  });
  return { success: true, userId, email: row.email } satisfies SignUpCompleteResult;
});
