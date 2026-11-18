// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/email/challenge/custom.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: mutations are Effects over an AuthTx (T1-T4), results are TypeScript types, throws that rolled back a Convex mutation are defects (T8), and the link and email come from the sender in the arguments (see common.ts).
// The `custom` challenge: prove that the person who started the flow
// controls an address, for a purpose that the application defines. Examples:
// account recovery, a magic link, or a new verification before a dangerous
// action. Completion writes nothing to the module.
//
// The `purpose` string is opaque to the module. The caller gives the same
// string at start and at completion; a different string fails. Give each purpose a name that another library or flow does not
// use, for example `"myApp/reauthenticate"`.

import * as Effect from "effect/Effect";
import { type AuthTx } from "../../core/context.js";
import { invariant } from "../../runtime/index.js";
import {
  CUSTOM_TTL_DEFAULT_MS,
  CUSTOM_TTL_MAX_MS,
  CUSTOM_TTL_MIN_MS,
  emailByNormalizedEmail,
} from "../helpers.js";
import type { ChallengeEmailCopy } from "../templates.js";
import {
  normalizeEmail,
  type CompleteChallengeUserError,
  type StartChallengeUserError,
  type WrongUserUserError,
} from "../validation.js";
import {
  type StartArgs,
  type ClaimArgs,
  type StartChallengeResult,
  type ChallengeOfKind,
  startPreconditions,
  createChallengeAndSendEmail,
  claimChallenge,
  findClaimableChallenge,
} from "./common.js";

/**
 * Tell whether `start` would fail with a `userError` for this address,
 * without consuming the rate limits.
 *
 * An application that must write before it calls `start` (for example,
 * create the user) calls `check` first and stops on an error, so the write
 * is not committed when the flow cannot start. When `check` passes, a
 * `start` in the same mutation does not return a `userError`: both run in
 * one transaction, so the limits cannot change in between.
 */
export const check = Effect.fn("auth.email.custom.check")(function* (
  tx: AuthTx,
  { email }: { email: string },
) {
  return (yield* startPreconditions(tx, email, "check")) satisfies StartChallengeUserError | null;
});

/**
 * Start a `custom` challenge.
 *
 * `copy` is the first lines of the email (its subject and intro); the module
 * appends the link and the expiry. `ttlMs` bounds how long the link works;
 * it must stay between `CUSTOM_TTL_MIN_MS` and `CUSTOM_TTL_MAX_MS`. A value
 * outside these bounds is a programming error and a defect.
 */
export const start = Effect.fn("auth.email.custom.start")(function* (
  tx: AuthTx,
  args: StartArgs & {
    // The application's name for the flow. Opaque to the module.
    purpose: string;
    // The user that must complete the flow and own the address, or `null`
    // when no user is signed in (for example, account recovery).
    //
    // With a user ID, `complete` succeeds only if `currentUserId` is this
    // user and the address is still a verified address of this user when
    // `complete` runs. The user verified it before the flow started (for
    // example, with `addEmail`).
    //
    // With `null`, `complete` accepts any `currentUserId` and does not check
    // the owner of the address: it gives the owner in `emailOwnerId`, or
    // `null` when no user has verified the address. `null` does NOT require
    // that the address has no owner.
    expectedUserId: string | null;
    /** Bind the address to this account for an anonymous flow. */
    emailOwnerId?: string;
    copy: ChallengeEmailCopy;
    ttlMs?: number | undefined;
  },
) {
  const ttlMs = args.ttlMs ?? CUSTOM_TTL_DEFAULT_MS;
  if (
    !Number.isFinite(ttlMs) ||
    ttlMs < CUSTOM_TTL_MIN_MS ||
    ttlMs > CUSTOM_TTL_MAX_MS
  ) {
    return yield* invariant(
      `ttlMs must be between ${CUSTOM_TTL_MIN_MS} and ${CUSTOM_TTL_MAX_MS}, ` +
        `got ${ttlMs}`,
    );
  }
  const error = yield* startPreconditions(tx, args.email, "consume");
  if (error !== null) {
    return { success: false, userError: error } satisfies StartChallengeResult;
  }
  const created = yield* createChallengeAndSendEmail(tx, {
    email: args.email,
    purpose: {
      kind: "custom",
      purpose: args.purpose,
      ...(args.expectedUserId === null ? {} : { userId: args.expectedUserId }),
      ...(args.emailOwnerId === undefined ? {} : { emailOwnerId: args.emailOwnerId }),
    },
    ttlMs,
    emailSender: args.emailSender,
    copy: args.copy,
  });
  return { success: true, ...created } satisfies StartChallengeResult;
});

export type CustomCompleteResult =
  | {
      success: true;
      email: string;
      // The user that `email` is a verified address of when `complete` runs,
      // or `null` when it is no user's verified address. When `start` got a
      // user ID, it is this user.
      emailOwnerId: string | null;
    }
  | {
      success: false;
      userError: CompleteChallengeUserError | WrongUserUserError;
    };

/** The claim arguments of `peek` and `complete`. */
type CompleteArgs = ClaimArgs & {
  purpose: string;
  currentUserId: string | null;
};

/** The purpose that `peek` and `complete` expect. */
function expectedPurpose(args: CompleteArgs) {
  return args.currentUserId === null
    ? ({ kind: "custom", purpose: args.purpose } as const)
    : ({ kind: "custom", userId: args.currentUserId, purpose: args.purpose } as const);
}

/** The result of `peek` and `complete` for a claimable challenge. */
const claimableResult = Effect.fn("auth.email.custom.claimableResult")(function* (
  tx: AuthTx,
  row: ChallengeOfKind<"custom">,
) {
  const owner = yield* emailByNormalizedEmail(tx, normalizeEmail(row.email));
  const emailOwnerId = owner === null ? null : owner.userId;
  const expectedUserId = row.purpose.emailOwnerId ?? row.purpose.userId;
  if (expectedUserId !== undefined && emailOwnerId !== expectedUserId) {
    yield* Effect.logWarning(
      `Rejected the email challenge ${row._id} for the purpose "custom": ` +
        `the expected user does not own the address now.`,
    );
    return { success: false, userError: { error: "INVALID_CHALLENGE" } } satisfies CustomCompleteResult;
  }
  return { success: true, email: row.email, emailOwnerId } satisfies CustomCompleteResult;
});

/**
 * Report what `complete` would return for this link, without claiming it. A
 * landing page calls it to tell the user that a link is dead before it asks
 * for input. Run it as a query: it writes nothing. It takes the same
 * arguments as `complete`.
 *
 * A `peek` that passes does not guarantee that a later `complete` passes:
 * the link can expire or be claimed between the two calls.
 */
export const peek = Effect.fn("auth.email.custom.peek")(function* (
  tx: AuthTx,
  args: CompleteArgs,
) {
  const claim = yield* findClaimableChallenge(tx, {
    emailCode: args.emailCode,
    browserSecret: args.browserSecret,
    purpose: expectedPurpose(args),
  });
  if (!claim.success) {
    return claim.failure satisfies CustomCompleteResult;
  }
  return yield* claimableResult(tx, claim.row);
});

/**
 * Complete a `custom` challenge. The `purpose` must be the one given at
 * start.
 *
 * `currentUserId` is the user that is signed in now, or `null` when no user
 * is. When `start` got a user ID, `currentUserId` must be this user. Another
 * value fails with `WRONG_USER` and keeps the challenge, thus this user can
 * still complete it. When `start` got `null`, any value is
 * accepted. It is required, thus a caller cannot skip the check by
 * accident.
 *
 * When `start` got a user ID and this user does not own the address now,
 * `complete` fails with `INVALID_CHALLENGE`: after the start, the address
 * moved to another user or was removed. The claim still deletes the row,
 * thus the link does not work again.
 */
export const complete = Effect.fn("auth.email.custom.complete")(function* (
  tx: AuthTx,
  args: CompleteArgs,
) {
  const claim = yield* claimChallenge(tx, {
    emailCode: args.emailCode,
    browserSecret: args.browserSecret,
    purpose: expectedPurpose(args),
  });
  if (!claim.success) {
    return claim.failure satisfies CustomCompleteResult;
  }
  return yield* claimableResult(tx, claim.row);
});
