// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/lib/types.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: validators are Effect Schemas (T5), Convex function references are Effects over an AuthTx, and the client-wiring types (ConvexAuthApi, the function-reference aliases) are not carried; sign-ins gain the MFA arms (`mfa_required`, `mfa_enrollment_required`) and `completeSignIn` answers a `SignInOutcome`; sign-ups may fail with `RegistrationRefused` and methods get `assertSignUpOpen` (part 11).
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { TransactionTooLarge } from "../../db/errors.js";
import type { AuthTx } from "../core/context.js";
import type { RegistrationClosed, RegistrationRefused } from "../registration/errors.js";
import type { MethodDisabled } from "../methods/settings.js";

/**
 * Shared contracts that cross a module boundary within Zelavis Auth. That includes
 * schemas (and their inferred types) for what the core's session functions
 * accept and return, and the wire shapes the session routes exchange with the
 * browser. Each is declared once here and reused wherever the core, the
 * runtime, the route handlers or the client needs it, so the shapes can never
 * drift between declaration sites.
 */

/**
 * The session a successful sign-in (or refresh) mints: a short-lived access
 * token plus the rotating refresh token with its expiry, and the account id
 * the access token is minted for. The access token's expiry is its JWT `exp`
 * claim.
 */
export const TokenBundle = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  refreshTokenExpiresAt: Schema.Number,
  userId: Schema.String,
});

export type TokenBundle = typeof TokenBundle.Type;

/**
 * A complete sign-in result.
 *
 * Sign-in methods compose this into their result union rather than declaring the
 * complete arm themselves. Fixing where the minted bundle sits is what lets the
 * session routes find the refresh token without knowing which method produced
 * the response.
 */
export const SignInComplete = Schema.Struct({
  status: Schema.Literal("complete"),
  tokens: TokenBundle,
});

export type SignInComplete = typeof SignInComplete.Type;

/**
 * A sign-in whose first factor passed and that owes a second (Zelavis): the
 * client presents a TOTP or backup code with `challenge` to
 * `POST /auth/mfa/verify`. No session exists yet, so no tokens or cookies.
 */
export const MfaRequired = Schema.Struct({
  status: Schema.Literal("mfa_required"),
  challenge: Schema.String,
});

export type MfaRequired = typeof MfaRequired.Type;

/**
 * A sign-in whose first factor passed for an account that the MFA policy
 * requires to have a second factor and that has none (Zelavis): `challenge`
 * lets the client enroll a TOTP (`POST /auth/mfa/totp`, then
 * `/auth/mfa/totp/confirm`), which completes the sign-in.
 */
export const MfaEnrollmentRequired = Schema.Struct({
  status: Schema.Literal("mfa_enrollment_required"),
  challenge: Schema.String,
});

export type MfaEnrollmentRequired = typeof MfaEnrollmentRequired.Type;

/** The two arms a sign-in takes when the second-factor gate stops it before the session. */
export const SignInPending = Schema.Union([MfaRequired, MfaEnrollmentRequired]);

export type SignInPending = typeof SignInPending.Type;

/** What `completeSignIn` answers: a session, or the second factor it waits for. */
export type SignInOutcome = SignInComplete | SignInPending;

/**
 * A sign-in that resulted in an error, carrying the method's own
 * `userError` codes.
 *
 * The `status` is shared so every arm of every method is discriminated the
 * same way; the payload is not, because what can go wrong is method-specific.
 *
 * ```ts
 * const signInResult = Schema.Union([
 *   SignInComplete,
 *   SignInError(Schema.Struct({ error: Schema.Literal("USER_NOT_FOUND") })),
 * ]);
 * ```
 */
export function SignInError<UserError extends Schema.Constraint>(userError: UserError) {
  return Schema.Struct({ status: Schema.Literal("error"), userError });
}

/** The inferred shape of a {@link SignInError} arm. */
export type SignInError<UserError> = {
  status: "error";
  userError: UserError;
};

/**
 * The full shared sign-in envelope.
 *
 * Represents sign-ins that ran to completion and those that hit an error.
 *
 * `userError` is `unknown` here because each method declares its own codes.
 */
export type SignInEnvelope = SignInComplete | SignInPending | SignInError<unknown>;

/** The `status` discriminant of every {@link SignInEnvelope}. */
export type SignInStatus = SignInEnvelope["status"];

/**
 * The token bundle that a cookie-mode route hands back to the client. It is a
 * slimmed down version of a {@link TokenBundle} with the refresh token (and its
 * expiry) removed: in cookie mode the refresh token lives only in an httpOnly
 * cookie and never reaches client JS.
 */
export type SlimTokenBundle = {
  accessToken: string;
  userId: string;
};

/**
 * Strip down a {@link TokenBundle} down to a {@link SlimTokenBundle},
 * dropping the refresh token so it is never sent to the browser.
 */
export function makeSlimBundle(bundle: TokenBundle): SlimTokenBundle {
  return {
    accessToken: bundle.accessToken,
    userId: bundle.userId,
  };
}

/**
 * The JSON body of every cookie-mode session response: the refresh handler, the
 * sign-out handler, and the cross-site refusal all reply with this shape, and
 * the client parses it without looking at the status. `tokens` is null whenever
 * there is no live session to report (a dead or missing refresh cookie, a
 * completed sign-out, a refused origin).
 */
export type AuthSessionResponse = {
  tokens: SlimTokenBundle | null;
};

/**
 * A sign-in result as clients see it, with the token bundle narrowed to what
 * every session model delivers.
 *
 * In cookie mode the routes strip the refresh token before the response reaches
 * the browser, so the slim bundle is all the two models have in common.
 * Declaring that here makes the stripping a widening of the value rather than a
 * broken contract: a {@link TokenBundle} is assignable to a
 * {@link SlimTokenBundle}, so one type stays true for both.
 *
 * Distributes over a result union, leaving failure arms untouched.
 */
export type ClientView<T> = T extends { tokens: TokenBundle }
  ? Omit<T, "tokens"> & { tokens: SlimTokenBundle }
  : T;

/** Schema for {@link RefreshResult}, which documents the outcomes. */
export const RefreshResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("rotated"), tokens: TokenBundle }),
  Schema.Struct({ kind: Schema.Literal("noSession") }),
]);

/**
 * The result of refreshing a session, returned by the core's `refreshSession`
 * and by the refresh route. Check `kind`:
 *
 *  * `{ kind: "rotated", tokens }`: `tokens` is the new {@link TokenBundle},
 *    with a fresh access token and the refresh token that replaces the one
 *    presented. Persist both. The presented refresh token stays valid until
 *    its successor is first used, so a client that never receives this result
 *    can retry with the token it already has.
 *  * `{ kind: "noSession" }`: the refresh token is unknown, expired, or
 *    superseded (a token issued after it has already been used). Only a
 *    superseded token revokes anything: it is what a leaked token looks like,
 *    so presenting it ends its session for every holder. An unknown or expired
 *    token has no live session left to revoke. Clear the stored session and
 *    treat the user as signed out.
 */
export type RefreshResult = typeof RefreshResult.Type;

/**
 * Shared identity-claims contract between the *sign-in methods* that
 * authenticate users and the *core*.
 *
 * After a sign-in method authenticates a user it produces this plain payload;
 * the method forwards it to the core's `_internal_dangerous_signUp` or `_internal_dangerous_signIn`.
 * Sign-in methods never call the core directly, they only know how to produce
 * these claims.
 */
export const AuthClaims = Schema.Struct({
  /**
   * The name that the sign-in method registers with the core, e.g.
   * "usernamePassword" for the `usernamePassword` method.
   */
  method: Schema.String,
  /** Arbitrary profile data the method learned about the user. */
  profile: Schema.Unknown,
});

export type AuthClaims = typeof AuthClaims.Type;

/**
 * The type of a runtime-defined user-creating function: create the account
 * record for a new identity, and return its id. It runs once per account, and
 * {@link OnSignInFn} runs right after it, so this one is only responsible for
 * what is true at creation time.
 *
 * This is the core entrypoint for the runtime to integrate its account model
 * with Auth. One is attached per sign-in method, although a function may be
 * shared across methods.
 *
 * It runs inside the transaction that creates the session, so a failure rolls
 * the account back with everything else. The core treats the returned id as an
 * opaque string.
 */
export type CreateUserFn<Profile, E = never> = (
  tx: AuthTx,
  args: { method: { name: string; profile: Profile } },
) => Effect.Effect<string, E | TransactionTooLarge>;

/**
 * The type of a runtime-defined sign-in function: an optional hook that runs on
 * *every* sign-in.
 *
 * That includes the first one, where it runs immediately after
 * {@link CreateUserFn} has minted the user. So per-sign-in work (a last-seen
 * timestamp, an audit row, syncing the account record from the latest `profile`,
 * which the core does not store) belongs here and nowhere else.
 *
 * The sign-in method passes the user id, so `userId` is always present and
 * there is nothing to return. Failing rejects the sign in, which on a first
 * sign-in rolls back the user the create function just made.
 */
export type OnSignInFn<Profile, E = never> = (
  tx: AuthTx,
  args: { method: { name: string; profile: Profile }; userId: string },
) => Effect.Effect<void, E | TransactionTooLarge>;

/**
 * The runtime's user callbacks for one sign-in method: {@link CreateUserFn} is
 * required (something has to create the user record), {@link OnSignInFn} is
 * optional.
 */
export type UserCallbacks<Profile, E = never> = {
  createUser: CreateUserFn<Profile, E>;
  onSignIn?: OnSignInFn<Profile, E>;
};

/**
 * The helpers that a bound method's mutations receive.
 *
 * This API is used for building sign-in methods. Each takes the transaction
 * the method's mutation runs in, so its writes commit with the method's own.
 */
export type BoundAuthHelpers<Profile, E = never> = {
  /**
   * Create the account for a *new* identity and exchange it for a session.
   *
   * Call this when the sign-in method has verified a new identity. The core:
   * 0. (Zelavis) admits the sign-up under the runtime's registration policy,
   *    failing with `RegistrationRefused` so the transaction writes nothing,
   * 1. calls the method's `createUser` to create the account,
   * 2. calls the method's `onSignIn`, like any other sign-in,
   * 3. returns the tokens a client needs to make authenticated calls.
   *
   * The core doesn't track identities, so the sign-in method must look the
   * identity up in its own module first, and call
   * {@link BoundAuthHelpers.completeSignIn} for a known one. After a sign-up,
   * the sign-in method must record the returned `userId` in its module in
   * the same mutation.
   */
  completeSignUp(
    tx: AuthTx,
    args: {
      profile: Profile;
      /**
       * The module that authenticated the user, for example `"password"`. The
       * session records its name.
       */
      authenticatedBy: string;
    },
  ): Effect.Effect<TokenBundle, E | RegistrationRefused | TransactionTooLarge | MethodDisabled>;
  /**
   * Exchange a verified *existing* identity for a session.
   *
   * Call this once the sign-in method has authenticated a known identity its
   * own way (checking a password, say) and looked up its user id. The core
   * runs the `onSignIn` callback if one is attached, and returns the tokens a
   * client needs to make authenticated calls.
   *
   * The core doesn't check `userId`, so a wrong one signs the caller in as
   * that user.
   *
   * Zelavis: unless the method was bound with `secondFactor: false`, the
   * second-factor gate runs first. An account with an active TOTP, or one the
   * MFA policy requires to have one, gets a {@link SignInPending} answer and
   * no session; the session is created when the second factor is presented.
   */
  completeSignIn(
    tx: AuthTx,
    args: {
      userId: string;
      profile: Profile;
      /**
       * The module that authenticated the user, for example `"password"`. The
       * session records its name.
       */
      authenticatedBy: string;
      providerRevision?: string | undefined;
    },
  ): Effect.Effect<SignInOutcome, E | TransactionTooLarge | MethodDisabled>;
  /**
   * Create the account for a verified identity without a session.
   *
   * Call this when the user must complete a step (for example, an email
   * validation) before the first sign-in. The method's `createUser` creates the
   * user, as for `completeSignUp`, and `onSignIn` doesn't run. The sign-in
   * method records the returned `userId` in its own module and signs the
   * user in later with `completeSignIn`.
   */
  signUpWithoutSession(tx: AuthTx, args: { profile: Profile }): Effect.Effect<{ userId: string }, E | RegistrationRefused | TransactionTooLarge | MethodDisabled>;
  /**
   * Zelavis: fail with `RegistrationClosed` when this runtime admits no
   * sign-ups now, consuming nothing. A method whose sign-up starts before the
   * account exists (a passkey ceremony) calls it at the start, so a closed
   * runtime writes nothing; the account's creation still runs the full
   * admission of `completeSignUp`.
   */
  assertSignUpOpen(tx: AuthTx): Effect.Effect<void, RegistrationClosed | TransactionTooLarge | MethodDisabled>;
  /**
   * Revokes every session of the signed-in user other than the current one
   * (the caller's session). Returns the number of active (non-expired)
   * sessions revoked; returns 0 when not authenticated. Expired sessions are
   * deleted as well, but not counted.
   *
   * NOTE: Callers should only invoke this function after verifying that the
   * logged in user truly owns the session, via confirming an authentication
   * method. Otherwise, the request might be originating from a stolen session,
   * which shouldn't be able to revoke other sessions.
   *
   * @internal until we solidify the full session lifecycle
   */
  revokeOtherSessions(tx: AuthTx): Effect.Effect<number, TransactionTooLarge>;
  /**
   * Revokes every session of the given user, including the caller's own if
   * it belongs to that user. Returns the number of active (non-expired)
   * sessions revoked. Expired sessions are deleted as well, but not counted.
   *
   * For flows that prove ownership of an account without a trusted current
   * session, such as password recovery. Revoke before minting the new
   * session, which this would otherwise revoke too.
   *
   * NOTE: This does no authorization. Callers should only invoke it after
   * proving that the requester owns `userId` (e.g. through an email
   * challenge).
   *
   * @internal until we solidify the full session lifecycle
   */
  revokeAllSessions(tx: AuthTx, userId: string): Effect.Effect<number, TransactionTooLarge>;
};
