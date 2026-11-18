// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/methods/username-password/server.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the handlers are Effects over transactions (T1-T4) and the result validators are Effect Schemas (T5); password hashing runs outside the transactions, which are split around it (verification is beginVerify, the hash check, then finishVerify in the mutation that issues the session); the Convex setup wiring and `attachUserCallbacks` are createUser/onSignIn options; a sign-in may answer an MFA arm instead of a session (part 10); failed sign-ins record security events (part 11).
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { accountsModule } from "../accounts/accounts.js";
import { recordSecurityEvent } from "../security/events.js";
import type { AuthCall, AuthTx } from "../core/context.js";
import type { AuthCore } from "../core/setup.js";
import { getAuthUserId } from "../core/userId.js";
import {
  SignInComplete,
  SignInError,
  SignInPending,
  type CreateUserFn,
  type OnSignInFn,
} from "../lib/types.js";
import { DEFAULT_MIN_PASSWORD_LENGTH } from "../lib/password.js";
import { hashPassword, needsRehash, verifyPasswordHash } from "../password/hashing.js";
import { _internal_dangerous_setPassword, beginVerify, finishVerify } from "../password/public.js";
import { invariant } from "../runtime/index.js";
import {
  setPasswordUserError,
  validateNewPassword,
  verifyPasswordUserError,
} from "../password/validation.js";
import { getUserIdByUsername, setUsername } from "../username/public.js";
import {
  setUsernameUserError,
  validateUsernameFormat,
} from "../username/validation.js";

export { DEFAULT_MIN_PASSWORD_LENGTH } from "../lib/password.js";

/** The name of this sign-in method. The user callbacks get it as `method.name`. */
export const METHOD_NAME = "usernamePassword";

/** The module that authenticated the session, recorded as the session's `component`. */
const AUTHENTICATED_BY = "password";

/**
 * Options for {@link setupUsernamePassword}: the user callbacks of this
 * method (see {@link CreateUserFn}); the accounts module's by default.
 */
export type UsernamePasswordOptions = {
  createUser?: CreateUserFn<unknown>;
  onSignIn?: OnSignInFn<unknown>;
};

export const signInResult = Schema.Union([
  SignInComplete,
  SignInPending,
  SignInError(
    Schema.Union([
      verifyPasswordUserError,
      Schema.Struct({ error: Schema.Literal("USER_NOT_FOUND") }),
    ]),
  ),
]);

/**
 * The result of `signInWithUsernamePassword`.
 *
 * When complete the minted session tokens, otherwise a user-facing `userError`.
 */
export type SignInResult = typeof signInResult.Type;

export const signUpResult = Schema.Union([
  SignInComplete,
  SignInError(Schema.Union([setPasswordUserError, setUsernameUserError])),
]);

/**
 * The result of `signUpWithUsernamePassword`.
 *
 * When complete the minted session tokens, otherwise a user-facing `userError`.
 */
export type SignUpResult = typeof signUpResult.Type;

export const changePasswordResult = Schema.Union([
  Schema.Struct({ success: Schema.Literal(true) }),
  Schema.Struct({
    success: Schema.Literal(false),
    userError: Schema.Union([
      Schema.Struct({ error: Schema.Literal("NOT_LOGGED_IN") }),
      Schema.Struct({ error: Schema.Literal("INVALID_CREDENTIALS") }),
      Schema.Struct({ error: Schema.Literal("RATE_LIMITED"), retryAfterMs: Schema.Number }),
      setPasswordUserError,
    ]),
  }),
]);

/**
 * The result of `changePassword`.
 *
 * `INVALID_CREDENTIALS` and `RATE_LIMITED` are about the current password.
 * The other errors are about the new password.
 */
export type ChangePasswordResult = typeof changePasswordResult.Type;

/**
 * The simplest password recipe: every account is a `(username, password)` pair,
 * with no email or email verification.
 *
 * ```ts
 * const method = setupUsernamePassword(auth.core);
 * yield* method.signUpWithUsernamePassword(call, { username, password });
 * ```
 *
 * Account resolution (username → user id) is owned by the username
 * module: the method stores the username there at sign-up, and reads the
 * user id back from it at sign-in. The password module itself stores only
 * `{ userId, passwordHashPHC }` and knows nothing about usernames.
 *
 * Every function here is one or two transactions around the slow hashing,
 * which never runs inside one.
 */
export function setupUsernamePassword(core: AuthCore, options: UsernamePasswordOptions = {}) {
  const bound = core.bindMethod<unknown>({
    name: METHOD_NAME,
    createUser: options.createUser ?? accountsModule.createUser,
    ...("onSignIn" in options
      ? options.onSignIn === undefined ? {} : { onSignIn: options.onSignIn }
      : { onSignIn: accountsModule.onSignIn }),
  });

  // Zelavis: a failed sign-in is a security event naming the tried username only by hash.
  const failed = (tx: AuthTx, username: string, userId: string | undefined) =>
    recordSecurityEvent(tx, { kind: "authentication.failed", accountId: userId, subject: { method: METHOD_NAME, identifier: username } });

  /**
   * Create a new account: reject a taken username or an invalid password,
   * otherwise create the user + session and store the username and the
   * password.
   */
  const signUpWithUsernamePassword = Effect.fn("auth.methods.usernamePassword.signUp")(function* (
    call: AuthCall,
    { username, password, displayName }: { username: string; password: string; displayName?: string | undefined },
  ) {
    // Validate the username and the password *before* creating
    // anything, so invalid input never mints a session.
    // (`setUsername` does the same check again, but by then the account would
    // already exist.)
    const usernameError = validateUsernameFormat(username);
    if (usernameError !== null) {
      return { status: "error", userError: usernameError } satisfies SignUpResult;
    }
    const userError = validateNewPassword(password, DEFAULT_MIN_PASSWORD_LENGTH);
    if (userError !== null) {
      return { status: "error", userError } satisfies SignUpResult;
    }
    yield* bound.query(call, (tx, helpers) => helpers.assertSignUpOpen(tx));
    // Hashed before the transaction: a retry after a conflict never hashes again.
    const passwordHashPHC = yield* hashPassword(password);

    return yield* bound.mutation(call, (tx, helpers) =>
      Effect.gen(function* () {
        yield* helpers.assertSignUpOpen(tx);
        const existing = yield* getUserIdByUsername(tx, { username });
        if (existing !== null) {
          return { status: "error", userError: { error: "USERNAME_TAKEN" } } satisfies SignUpResult;
        }

        const tokens = yield* helpers.completeSignUp(tx, {
          profile: { displayName },
          authenticatedBy: AUTHENTICATED_BY,
        });

        const setUsernameResult = yield* setUsername(tx, { userId: tokens.userId, username });
        if (!setUsernameResult.success) {
          // Unexpected: we validated the username above, and the check for a
          // conflict above and this call are in the same transaction.
          // Dying so that the transaction doesn’t commit.
          return yield* invariant(
            "Unexpected error when setting the username: " + setUsernameResult.userError.error,
          );
        }

        yield* _internal_dangerous_setPassword(tx, { userId: tokens.userId, passwordHashPHC });

        return { status: "complete", tokens } satisfies SignUpResult;
      }),
    );
  });

  /**
   * Verify an existing account's password and, on success, mint a session.
   * Returns `USER_NOT_FOUND` when the username has no account and
   * `INVALID_CREDENTIALS` when the password is wrong, so callers can tell
   * the two apart. (Account existence is already observable via sign-up's
   * `USERNAME_TAKEN`, so distinguishing them here leaks nothing new; the
   * route limits both per client address, I7.)
   */
  const signInWithUsernamePassword = Effect.fn("auth.methods.usernamePassword.signIn")(function* (
    call: AuthCall,
    { username, password }: { username: string; password: string },
  ) {
    const invalid = { status: "error", userError: { error: "INVALID_CREDENTIALS" } } satisfies SignInResult;

    // First transaction: the user, the rate limit (consumed here, as upstream
    // consumes it before hashing) and the stored hash.
    const begun = yield* bound.mutation(call, (tx) =>
      Effect.gen(function* () {
        const userId = yield* getUserIdByUsername(tx, { username });
        if (userId === null) {
          yield* failed(tx, username, undefined);
          return { ok: false, result: { status: "error", userError: { error: "USER_NOT_FOUND" } } satisfies SignInResult } as const;
        }
        const verify = yield* beginVerify(tx, { userId, password });
        if (!verify.success) {
          if (verify.userError.error === "INVALID_CREDENTIALS") yield* failed(tx, username, userId);
          return { ok: false, result: { status: "error", userError: verify.userError } satisfies SignInResult } as const;
        }
        return { ok: true, userId, stored: verify.stored } as const;
      }),
    );
    if (!begun.ok) return begun.result;

    // Outside any transaction: the slow work.
    if (!(yield* verifyPasswordHash(password, begun.stored))) {
      // Zelavis: the failure is recorded in a transaction of its own; the check that found it had none.
      yield* bound.mutation(call, (tx) => failed(tx, username, begun.userId));
      return invalid;
    }
    const rehashed = needsRehash(begun.stored) ? yield* hashPassword(password) : undefined;

    // Second transaction: the session is issued only for the hash that was
    // verified, and an old hash is replaced in the same commit.
    return yield* bound.mutation(call, (tx, helpers) =>
      Effect.gen(function* () {
        const finished = yield* finishVerify(tx, { userId: begun.userId, stored: begun.stored, rehashed });
        if (!finished.success) return invalid;
        const outcome = yield* helpers.completeSignIn(tx, {
          userId: begun.userId,
          profile: {},
          authenticatedBy: AUTHENTICATED_BY,
        });
        return outcome satisfies SignInResult;
      }),
    );
  });

  /**
   * Change the password of the signed-in user. The user must re-authenticate
   * by giving their current password. Signs out the user's other sessions
   * if `signOutOtherSessions` is `true`.
   */
  const changePassword = Effect.fn("auth.methods.usernamePassword.changePassword")(function* (
    call: AuthCall,
    {
      currentPassword,
      newPassword,
      signOutOtherSessions = false,
    }: { currentPassword: string; newPassword: string; signOutOtherSessions?: boolean },
  ) {
    const notLoggedIn = { success: false, userError: { error: "NOT_LOGGED_IN" } } satisfies ChangePasswordResult;
    const invalid = { success: false, userError: { error: "INVALID_CREDENTIALS" } } satisfies ChangePasswordResult;

    const begun = yield* bound.mutation(call, (tx) =>
      Effect.gen(function* () {
        const userId = yield* getAuthUserId(tx);
        if (userId === null) {
          return { ok: false, result: notLoggedIn } as const;
        }

        // Validate the new password before verifying the current one, so
        // that invalid new password are ignored by the rate limit.
        const newPasswordError = validateNewPassword(newPassword, DEFAULT_MIN_PASSWORD_LENGTH);
        if (newPasswordError !== null) {
          return { ok: false, result: { success: false, userError: newPasswordError } satisfies ChangePasswordResult } as const;
        }

        // TODO(nicolas) This does not compose with other sign-in
        // methods yet: we require users to reauthenticate with their
        // current password, so this doesn’t allow users who don’t have
        // a password at this point to add a password to their account.
        const verify = yield* beginVerify(tx, { userId, password: currentPassword });
        if (!verify.success) {
          if (verify.userError.error === "RATE_LIMITED") {
            return { ok: false, result: { success: false, userError: verify.userError } satisfies ChangePasswordResult } as const;
          }
          // `beginVerify` also reports format errors. Here we use
          // INVALID_CREDENTIALS for all current password formatting errors,
          // so that the user doesn’t think that there is an issue
          // in their new password.
          verify.userError.error satisfies
            | "PASSWORD_TOO_SHORT"
            | "PASSWORD_TOO_LONG"
            | "PASSWORD_HAS_SURROUNDING_WHITESPACE"
            | "INVALID_CREDENTIALS";
          return { ok: false, result: invalid } as const;
        }
        return { ok: true, userId, stored: verify.stored } as const;
      }),
    );
    if (!begun.ok) return begun.result;

    if (!(yield* verifyPasswordHash(currentPassword, begun.stored))) return invalid;
    const passwordHashPHC = yield* hashPassword(newPassword);

    return yield* bound.mutation(call, (tx, helpers) =>
      Effect.gen(function* () {
        // The session that proved the current password must still be live.
        if ((yield* getAuthUserId(tx)) !== begun.userId) return notLoggedIn;
        const finished = yield* finishVerify(tx, { userId: begun.userId, stored: begun.stored });
        if (!finished.success) return invalid;
        yield* _internal_dangerous_setPassword(tx, { userId: begun.userId, passwordHashPHC });

        // The current password was just verified, so the caller owns this
        // session: sign out the user's other sessions if requested.
        if (signOutOtherSessions) {
          yield* helpers.revokeOtherSessions(tx);
        }
        return { success: true } satisfies ChangePasswordResult;
      }),
    );
  });

  return { signUpWithUsernamePassword, signInWithUsernamePassword, changePassword };
}

export type UsernamePasswordMethod = ReturnType<typeof setupUsernamePassword>;
