// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/email/challenge/common.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: mutations are Effects over an AuthTx (T1-T4); the Convex validators are TypeScript types here, as no route takes them; a start emits its email into the transaction's outbox under the challenge's id, so a retried transaction delivers one message; throws that rolled back a Convex mutation are defects (T8); the link comes from the link base in the sender instead of a `url` argument.
/**
 * The server code that the challenge kinds share.
 *
 * Challenges prove that the current user has access to an email address.
 * Each challenge has two steps: creating it (which sends the email),
 * and then completing it (which receives the code in the email).
 *
 * There are two secrets for each challenge:
 *
 * - The `emailCode`, which travels in the emailed link.
 * - The `browserSecret`, which stays in the browser that started the challenge
 *   (either in page’s temporary state, or in local storage).
 *   The browser gets it from the `start` mutation and keeps it the page state
 *   for single-page flows, or local storage for multiple-page
 *   flows.
 *
 * Because both secrets are necessary, a person who reads the mailbox alone cannot
 * complete the challenge (which avoids attacks where a malicious user tricks the user
 * into completing a challenge for an account they control), and neither can a person
 * who uses the browser alone but doesn’t have access to the email address.
 *
 * The start step makes the row and sends the link:
 *
 * ```
 *  Client                    Method                          Module
 *    │                         │                               │
 *    │  submit the address     │                               │
 *    ├────────────────────────▶│                               │
 *    │                         │  challenge start mutation     │
 *    │                         ├──────────────────────────────▶│     check the format, then the rate limits
 *    │                         │                               │     store the hashes of the code and the secret
 *    │                         │                               ├─▶ queue the link in the outbox
 *    │                         │◀──────────────────────────────┤     the secret and the ID of the challenge
 *    │◀────────────────────────┤                               │
 *    ├─▶ keep the secret in page state/local storage           │
 *    │                         │                               │
 * ```
 *
 * The completion step runs when the landing page opens with a link. The page
 * reads the code from the URL and the secret from storage, then completes at
 * once:
 *
 * ```
 *  Landing page                Method                            Module
 *    │                           │                                 │
 *    ├─▶ read the code from the URL and the secret from storage    │
 *    │                           │                                 │
 *    │  complete                 │                                 │
 *    ├──────────────────────────▶│                                 │
 *    │                           │  challenge complete mutation    │
 *    │                           ├────────────────────────────────▶│     find the row by the secret, then verify the code
 *    │                           │                                 │     delete the row, then make the change that the kind defines
 *    │                           │◀────────────────────────────────┤
 *    │◀──────────────────────────┤                                 │
 *    ├─▶ show the result                                           │
 *    │                           │                                 │
 * ```
 *
 * The `purpose` of the row says which kind started the challenge, and which
 * user the flow is for. A `complete` call gives the purpose that it expects,
 * thus a link for one flow can never complete another flow, or a flow for
 * another user.
 *
 * The secret identifies the challenge, and the code proves access to the
 * mailbox. The row goes away only when the claim succeeds, thus no link works
 * twice, and a person who has only the link cannot burn the challenge. A
 * missing or expired row gives `INVALID_CHALLENGE`, and a wrong code gives
 * `INCORRECT_CODE`. A challenge of another user gives `WRONG_USER` and
 * stays. A challenge of another kind or purpose is a defect, because it is an
 * application bug and not a user error.
 *
 * @module
 */

import * as Effect from "effect/Effect";
import type { TransactionTooLarge } from "../../../db/errors.js";
import type { AuthTx } from "../../core/context.js";
import { generateRandomToken, sha256Hex } from "../../lib/crypto.js";
import { AUTH_EMAIL_TOPIC, invariant } from "../../runtime/index.js";
import {
  rateLimiter,
  getClientIp,
  emailByNormalizedEmail,
  type ChallengeRow,
} from "../helpers.js";
import { type ChallengeEmailCopy, type ChallengeEmailSender, challengeEmail } from "../templates.js";
import { emailReservation } from "../reservations.js";
import { emailTables } from "../tables.js";
import {
  normalizeEmail,
  validateEmailFormat,
  type EmailTakenUserError,
  type StartChallengeUserError,
  type StartFreeAddressUserError,
  type CompleteChallengeUserError,
  type CompleteFreeAddressUserError,
  type WrongUserUserError,
} from "../validation.js";

export type ChallengePurpose = ChallengeRow["purpose"];

//------------------------------------------------------------------------------
// Shared argument and result types
//------------------------------------------------------------------------------

/** The arguments that every `start` mutation accepts. */
export type StartArgs = {
  email: string;
  // What the email needs of the runtime's delivery: the link base and the
  // runtime's name. The code goes in the link's fragment.
  emailSender: ChallengeEmailSender;
};

/** The arguments that every `complete` mutation accepts. */
export type ClaimArgs = {
  // The code from the emailed link.
  emailCode: string;
  // The secret that the starting browser kept.
  browserSecret: string;
};

type StartChallengeSuccess = {
  success: true;
  // The secret the client must keep (in its local storage) and present
  // again at completion. It never travels in the email.
  browserSecret: string;
  // The new challenge. A caller that wants to keep data about the flow can
  // use this ID as a foreign reference.
  challengeId: string;
};

export type StartChallengeResult =
  | StartChallengeSuccess
  | { success: false; userError: StartChallengeUserError };

/**
 * The `start` result of the kinds that record the address for a user
 * (`addEmail`, `changeEmail`, `signUp`). It adds `EMAIL_TAKEN` to the errors.
 */
export type StartFreeAddressResult =
  | StartChallengeSuccess
  | { success: false; userError: StartFreeAddressUserError };

/**
 * The failed `complete` result of the kinds that record the address for a
 * user. It adds `EMAIL_TAKEN` to the errors.
 */
export type CompleteFreeAddressFailure = {
  success: false;
  userError: CompleteFreeAddressUserError;
};

/**
 * The failed `complete` result of the kinds that record the address for the
 * caller (`addEmail`, `changeEmail`). It adds `WRONG_USER` to the errors of
 * `CompleteFreeAddressFailure`.
 */
export type CompleteCallerAddressFailure = {
  success: false;
  userError: CompleteFreeAddressUserError | WrongUserUserError;
};

/** A challenge row whose purpose has the kind `Kind`. */
export type ChallengeOfKind<Kind extends ChallengePurpose["kind"]> =
  ChallengeRow & {
    purpose: Extract<ChallengePurpose, { kind: Kind }>;
  };

/**
 * The result of `findClaimableChallenge` and `claimChallenge`. The kinds
 * return `failure` as-is when the claim fails; it already has the shape of a
 * failed `complete` result. A `signUp` claim has no caller user, thus it
 * never fails with `WRONG_USER`.
 */
export type ClaimChallengeResult<
  Kind extends ChallengePurpose["kind"] = ChallengePurpose["kind"],
> =
  | { success: true; row: ChallengeOfKind<Kind> }
  | { success: false; failure: ClaimFailure<Kind> };

type ClaimFailure<Kind extends ChallengePurpose["kind"]> = {
  success: false;
  userError:
    | CompleteChallengeUserError
    | (Kind extends "signUp" ? never : WrongUserUserError);
};

function claimFailure<
  Code extends ClaimFailure<ChallengePurpose["kind"]>["userError"]["error"],
>(
  error: Code,
): {
  success: false;
  failure: { success: false; userError: { error: Code } };
} {
  return { success: false, failure: { success: false, userError: { error } } };
}

//------------------------------------------------------------------------------
// Start
//------------------------------------------------------------------------------

/**
 * The preconditions that every `start` shares: the format of the address,
 * then the two rate limits (one for the destination address, one for the
 * client IP). Returns the error to give the user, or `null` when the start
 * can go on. In `"consume"` mode, the limits take a token only when the start
 * passes all of the checks.
 */
export const startPreconditions = Effect.fn("auth.email.startPreconditions")(function* (
  tx: AuthTx,
  email: string,
  mode: "check" | "consume",
  userId?: string,
) {
  const formatError = validateEmailFormat(email);
  if (formatError !== null) {
    return formatError satisfies StartChallengeUserError;
  }

  const keys = getStartLimitKeys(tx, email);
  const limitError = yield* checkStartLimits(tx, keys);
  if (limitError !== null) {
    return limitError;
  }

  if (mode === "consume") {
    yield* consumeStartLimits(tx, keys);
  }

  return null;
});

type StartLimitKeys = { emailKey: string; ipKey: string };
type RateLimitedUserError = Extract<
  StartChallengeUserError,
  { error: "RATE_LIMITED" }
>;

function getStartLimitKeys(tx: AuthTx, email: string): StartLimitKeys {
  return { emailKey: normalizeEmail(email), ipKey: getClientIp(tx) };
}

/**
 * Read the two limits of a `start` without taking a token. The callers read
 * all of the limits before any one takes a token. Otherwise a start that the
 * IP limit denies would still take a token from the address, and a blocked
 * client could lock any address out at no cost.
 */
const checkStartLimits = Effect.fn("auth.email.checkStartLimits")(function* (
  tx: AuthTx,
  { emailKey, ipKey }: StartLimitKeys,
) {
  const perEmail = yield* rateLimiter.check(tx, "startChallengePerEmail", {
    key: emailKey,
  });
  if (!perEmail.ok) {
    return { error: "RATE_LIMITED", retryAfterMs: perEmail.retryAfter } satisfies RateLimitedUserError;
  }
  const perIp = yield* rateLimiter.check(tx, "startChallengePerIp", {
    key: ipKey,
  });
  if (!perIp.ok) {
    return { error: "RATE_LIMITED", retryAfterMs: perIp.retryAfter } satisfies RateLimitedUserError;
  }
  return null;
});

/**
 * Take one token from a limit that the checks above found to have one, in the
 * same transaction. (Convex's `throws: true`: a refusal here cannot happen, so
 * it is a defect that rolls the transaction back.)
 */
const takeToken = Effect.fn("auth.email.takeToken")(function* (
  tx: AuthTx,
  name: "startChallengePerEmail" | "startChallengePerIp" | "lookupEmailPerIp",
  key: string,
) {
  const limit = yield* rateLimiter.limit(tx, name, { key });
  if (!limit.ok) {
    return yield* invariant(`The ${name} limit refused a token that its check had found: retry after ${limit.retryAfter} ms`);
  }
});

/** Take one token from each of the two limits of a `start`. */
const consumeStartLimits = Effect.fn("auth.email.consumeStartLimits")(function* (
  tx: AuthTx,
  { emailKey, ipKey }: StartLimitKeys,
) {
  yield* takeToken(tx, "startChallengePerEmail", emailKey);
  yield* takeToken(tx, "startChallengePerIp", ipKey);
});

/**
 * Return `EMAIL_TAKEN` when a user has already verified the address, or
 * `null` when the address is free. The kinds that record an address call
 * this at start and again at completion.
 *
 * At start, `startFreeAddressPreconditions` calls this only after it reads
 * the `lookupEmailPerIp` limit, and takes a token from that limit for each
 * answer. Otherwise the start would be an unlimited enumeration oracle.
 *
 * TODO: let the caller disable this check at start. It tells the caller if
 * an address has an account, which an app that must prevent user
 * enumeration does not want to reveal before the link is opened.
 */
export const addressTakenError = Effect.fn("auth.email.addressTakenError")(function* (
  tx: AuthTx,
  normalizedEmail: string,
  userId?: string,
) {
  const existing = yield* emailByNormalizedEmail(tx, normalizedEmail);
  if (existing !== null) return { error: "EMAIL_TAKEN" } satisfies EmailTakenUserError;
  const reserved = yield* emailReservation(tx, normalizedEmail);
  return reserved === null || reserved.userId === userId ? null : { error: "EMAIL_TAKEN" } satisfies EmailTakenUserError;
});

/**
 * The `start` preconditions of the kinds that record the address for a user
 * (`addEmail`, `changeEmail`, `signUp`): the shared preconditions, then the
 * address must not be verified by any user.
 *
 * The result tells the caller whether the address has an account, thus it
 * also uses the `lookupEmailPerIp` limit of `lookupEmail`. Each attempt takes
 * one token from it:
 *
 * - `EMAIL_TAKEN` takes the token in both modes, because no `start` comes
 *   after it.
 * - A free address takes the token in `"consume"` mode only. When `check`
 *   passes, the `start` that comes after it takes the token.
 *
 * Each call reads the limit, even for a free address. Thus, when the limit
 * has no token, all of the addresses get `RATE_LIMITED`, and the answer does
 * not tell which addresses have an account.
 *
 * An `EMAIL_TAKEN` start takes no token from the two limits of the start,
 * because it sends no email.
 */
export const startFreeAddressPreconditions = Effect.fn("auth.email.startFreeAddressPreconditions")(function* (
  tx: AuthTx,
  email: string,
  mode: "check" | "consume",
  userId?: string,
) {
  const formatError = validateEmailFormat(email);
  if (formatError !== null) {
    return formatError satisfies StartFreeAddressUserError;
  }

  const keys = getStartLimitKeys(tx, email);
  const limitError = yield* checkStartLimits(tx, keys);
  if (limitError !== null) {
    return limitError;
  }
  const lookup = yield* rateLimiter.check(tx, "lookupEmailPerIp", {
    key: keys.ipKey,
  });
  if (!lookup.ok) {
    return { error: "RATE_LIMITED", retryAfterMs: lookup.retryAfter } satisfies RateLimitedUserError;
  }

  const takenError = yield* addressTakenError(tx, keys.emailKey, userId);
  if (takenError !== null || mode === "consume") {
    yield* takeToken(tx, "lookupEmailPerIp", keys.ipKey);
  }
  if (takenError !== null) {
    return takenError;
  }

  if (mode === "consume") {
    yield* consumeStartLimits(tx, keys);
  }
  return null;
});

/**
 * Store the hashed code + secret and queue the email. Returns the secret that
 * the starting browser keeps, and the ID of the new row.
 *
 * The email is staged in the transaction's outbox under `auth-<challengeId>`:
 * it exists exactly when the row does, and is delivered once however often
 * the relay offers it.
 */
export const createChallengeAndSendEmail = Effect.fn("auth.email.createChallengeAndSendEmail")(function* (
  tx: AuthTx,
  args: {
    email: string;
    purpose: ChallengePurpose;
    ttlMs: number;
    emailSender: ChallengeEmailSender;
    copy: ChallengeEmailCopy;
  },
) {
  const emailCode = generateRandomToken();
  const browserSecret = generateRandomToken();
  const challengeId = yield* tx.db.insert(emailTables.challenges, {
    email: args.email,
    purpose: args.purpose,
    emailCodeHash: yield* sha256Hex(emailCode),
    browserSecretHash: yield* sha256Hex(browserSecret),
    expiresAt: tx.now + args.ttlMs,
  });
  yield* tx.emit({
    topic: AUTH_EMAIL_TOPIC,
    id: `auth-${challengeId}`,
    payload: challengeEmail(args.emailSender, { to: args.email, copy: args.copy, emailCode, ttlMs: args.ttlMs }),
  });
  return { browserSecret, challengeId };
});

//------------------------------------------------------------------------------
// Complete
//------------------------------------------------------------------------------

/**
 * The purpose that a `complete` call expects. For `signUp`, it has no
 * `userId`: the caller has no session, thus `complete` takes the user from
 * the row.
 */
export type ExpectedPurpose =
  | Exclude<ChallengePurpose, { kind: "signUp" }>
  | { kind: "signUp" };

function sameKind<Expected extends ExpectedPurpose>(
  row: ChallengeRow,
  expected: Expected,
): row is ChallengeOfKind<Expected["kind"]> {
  const actual = row.purpose;
  // Two `custom` challenges match only when the caller's purpose string is
  // the same one that started the flow.
  if (actual.kind === "custom" && expected.kind === "custom") {
    return actual.purpose === expected.purpose;
  }
  return actual.kind === expected.kind;
}

function sameUser(row: ChallengeRow, expected: ExpectedPurpose): boolean {
  const actual = row.purpose;
  // A `signUp` call has no session: `complete` takes the user from the row.
  if (expected.kind === "signUp" || actual.kind === "signUp") {
    return true;
  }
  // A `custom` challenge that expects no user matches any caller: it does
  // not give access to an account.
  if (actual.kind === "custom" && actual.userId === undefined) {
    return true;
  }
  return actual.userId === expected.userId;
}

/**
 * Find the challenge that the code from the link and the secret from the
 * starting browser can claim, without claiming it. Returns the row when all
 * of the checks pass, or the failure that the `complete` mutation returns to
 * the client.
 *
 * The secret identifies the challenge, and the code proves access to the
 * mailbox. A caller without the secret cannot reach the row, so a person who
 * reads the mailbox alone can neither complete the challenge nor burn it.
 *
 * `INVALID_CHALLENGE` means that there is no live challenge for the secret.
 * The challenge may have expired, may already have been used, or may never
 * have existed. The client cannot tell these apart, and the user action is
 * the same, start again. The server writes the difference to the log, to
 * help you find a bug or a misuse. `INCORRECT_CODE` means the row exists but the code
 * is not the one that the challenge sent. For a link, the link is not the
 * newest one this browser started. For a future short code, it is a typo.
 *
 * `WRONG_USER` means that the challenge is for another user than the
 * caller. This occurs in normal use: a user starts a flow, signs out, and
 * another user signs in in the same browser. The row stays, thus the right
 * user can still complete the challenge.
 *
 * A challenge of another kind, or a `custom` challenge with another purpose
 * string, is a defect. It is an application bug: the landing page called the
 * wrong function. A `signUp` call gives no `userId`, thus only the kind must
 * match. A `custom` challenge without a `userId` matches any `userId`.
 */
export const findClaimableChallenge = Effect.fn("auth.email.findClaimableChallenge")(function* <Expected extends ExpectedPurpose>(
  tx: AuthTx,
  args: { emailCode: string; browserSecret: string; purpose: Expected },
): Effect.fn.Return<ClaimChallengeResult<Expected["kind"]>, TransactionTooLarge> {
  const browserSecretHash = yield* sha256Hex(args.browserSecret);
  const row = yield* tx.db
    .query(emailTables.challenges)
    .withIndex("by_browserSecretHash", (q) =>
      q.eq("browserSecretHash", browserSecretHash),
    )
    .unique();
  if (row === null) {
    yield* Effect.logWarning(
      `Rejected the email challenge: there is no challenge for the browser ` +
        `secret. The challenge was already completed, or it never existed.`,
    );
    return claimFailure("INVALID_CHALLENGE");
  }
  // At exactly `expiresAt` the link is expired, like in the cleanup sweep.
  if (row.expiresAt <= tx.now) {
    yield* Effect.logWarning(
      `Rejected the email challenge ${row._id} for the purpose ` +
        `"${row.purpose.kind}": it expired at ` +
        `${new Date(row.expiresAt).toISOString()}.`,
    );
    return claimFailure("INVALID_CHALLENGE");
  }
  if (row.emailCodeHash !== (yield* sha256Hex(args.emailCode))) {
    yield* Effect.logWarning(
      `Rejected the email challenge ${row._id} for the purpose ` +
        `"${row.purpose.kind}": the code is not the code that this ` +
        `challenge sent.`,
    );
    return claimFailure("INCORRECT_CODE");
  }
  if (!sameKind(row, args.purpose)) {
    return yield* invariant(
      `Challenge purpose mismatch: the row is for "${row.purpose.kind}", but the complete call expects "${args.purpose.kind}"`,
    );
  }
  if (!sameUser(row, args.purpose)) {
    yield* Effect.logWarning(
      `Rejected the email challenge ${row._id} for the purpose ` +
        `"${row.purpose.kind}": it is for another user than the caller.`,
    );
    // `sameUser` accepts any `signUp` claim, thus `Expected` is not `signUp`.
    return claimFailure("WRONG_USER") as ClaimChallengeResult<Expected["kind"]>;
  }
  return { success: true, row } as ClaimChallengeResult<Expected["kind"]>;
});

/**
 * Claim a challenge: run the checks of {@link findClaimableChallenge}, then
 * delete the row. The row is deleted only when the claim succeeds, so a
 * claimed link can never be replayed.
 */
export const claimChallenge = Effect.fn("auth.email.claimChallenge")(function* <Expected extends ExpectedPurpose>(
  tx: AuthTx,
  args: { emailCode: string; browserSecret: string; purpose: Expected },
) {
  const claim = yield* findClaimableChallenge(tx, args);
  if (claim.success) {
    yield* tx.db.delete(emailTables.challenges, claim.row._id);
  }
  return claim;
});
