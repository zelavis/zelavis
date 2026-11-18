// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/methods/email-password/server.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the handlers are Effects over transactions (T1-T4) and the result validators are Effect Schemas (T5); password hashing runs outside the transactions, which are split around it (as in username-password.ts); the Resend sender is the runtime's email outbox, with links from its link base (the sign-up, change-email and recovery pages are fixed names under it) and notifications staged in the transaction's outbox; with email delivery unavailable a start answers `EMAIL_UNAVAILABLE` and writes nothing; the Convex setup wiring and `attachUserCallbacks` are createUser/onSignIn options; a sign-in may answer an MFA arm instead of a session (part 10); failed sign-ins record security events (part 11).
/**
 * The `emailPassword` method: accounts have an email address
 * and a password, and the email must be validated before the first sign-in.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { EmailOutbox } from "../../app/email/contracts.js";
import { accountsModule } from "../accounts/accounts.js";
import { recordSecurityEvent } from "../security/events.js";
import type { AuthCall, AuthTx } from "../core/context.js";
import type { AuthCore } from "../core/setup.js";
import { getAuthUserId } from "../core/userId.js";
import { addEmail, changeEmail, custom, signUp } from "../email/challenge/index.js";
import { getClientIp, rateLimiter } from "../email/helpers.js";
import type { ChallengePage, ChallengeEmailCopy, ChallengeEmailSender } from "../email/templates.js";
import { noticeEmail } from "../email/templates.js";
import { getEmails, getPrimaryEmail, lookupEmail, lookupPasswordEmail } from "../email/verifiedEmails.js";
import {
  startChallengeUserError,
  startFreeAddressUserError,
  completeChallengeUserError,
  completeFreeAddressUserError,
  wrongUserUserError,
  emailNotFoundUserError,
  validateEmailFormat,
} from "../email/validation.js";
import { DEFAULT_MIN_PASSWORD_LENGTH } from "../lib/password.js";
import { generateRandomToken } from "../lib/crypto.js";
import {
  SignInComplete,
  SignInError,
  SignInPending,
  type CreateUserFn,
  type OnSignInFn,
} from "../lib/types.js";
import { hashPassword, needsRehash, verifyPasswordHash } from "../password/hashing.js";
import { _internal_dangerous_setPassword, beginVerify, finishVerify } from "../password/public.js";
import {
  setPasswordUserError,
  validateNewPassword,
  verifyPasswordUserError,
} from "../password/validation.js";
import { AUTH_EMAIL_TOPIC, invariant } from "../runtime/index.js";

/** The name of this sign-in method. The user callbacks get it as `method.name`. */
export const METHOD_NAME = "emailPassword";

/** The module that authenticated the session through a challenge, recorded as the session's `component`. */
const AUTHENTICATED_BY_EMAIL = "email";
/** The module that authenticated the session through a password, recorded as the session's `component`. */
const AUTHENTICATED_BY_PASSWORD = "password";

/**
 * The purpose of the `custom` challenge that account recovery starts. The
 * name carries a prefix so that an application's own custom purposes cannot
 * collide with it.
 */
export const RECOVERY_PURPOSE = "zelavisAuth/emailPassword/recovery";

/**
 * How long a recovery link stays valid. OWASP ASVS v5 6.5.5 requires at most
 * 10 minutes for password-reset flows.
 */
const RECOVERY_TTL_MS = 10 * 60 * 1000;

const RECOVERY_EMAIL: ChallengeEmailCopy = {
  kind: "password-recovery",
  page: "reset-password" satisfies ChallengePage,
  subject: "Reset your password",
  intro: "Open this link to reset your password:",
};

/**
 * Options for {@link setupEmailPassword}: the runtime's email delivery, and
 * the user callbacks of this method (see {@link CreateUserFn}); the accounts
 * module's by default.
 */
export type EmailPasswordOptions = {
  /** Where links open (`EmailOutbox.linkBase`); with no link base, email delivery is unavailable. */
  emailOutbox?: Pick<EmailOutbox, "linkBase"> | undefined;
  /** The name emails carry; "Zelavis" by default. */
  runtimeName?: string;
  createUser?: CreateUserFn<unknown>;
  onSignIn?: OnSignInFn<unknown>;
};

/** The runtime cannot deliver email now, so no email challenge can start. */
export const emailUnavailableUserError = Schema.Struct({ error: Schema.Literal("EMAIL_UNAVAILABLE") });

const notLoggedIn = Schema.Struct({ error: Schema.Literal("NOT_LOGGED_IN") });

export const signUpResult = Schema.Union([
  Schema.Struct({
    success: Schema.Literal(true),
    browserSecret: Schema.String,
  }),
  Schema.Struct({
    success: Schema.Literal(false),
    userError: Schema.Union([startFreeAddressUserError, setPasswordUserError, emailUnavailableUserError]),
  }),
]);

/**
 * The result of `signUpWithEmailPassword`. On success, the secret the browser must keep for
 * `completeSignUpWithEmailPassword`; the session arrives only after the email is validated.
 */
export type SignUpResult = typeof signUpResult.Type;

export const completeSignUpResult = Schema.Union([
  SignInComplete,
  SignInPending,
  SignInError(completeFreeAddressUserError),
]);

/** The result of `completeSignUpWithEmailPassword`: the minted session tokens, or an error. */
export type CompleteSignUpResult = typeof completeSignUpResult.Type;

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

/** The result of `signInWithEmailPassword`: the minted session tokens, or an error. */
export type SignInResult = typeof signInResult.Type;

export const changePasswordResult = Schema.Union([
  Schema.Struct({ success: Schema.Literal(true) }),
  Schema.Struct({
    success: Schema.Literal(false),
    userError: Schema.Union([
      notLoggedIn,
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

export const startChangeEmailResult = Schema.Union([
  Schema.Struct({ success: Schema.Literal(true), browserSecret: Schema.String }),
  Schema.Struct({
    success: Schema.Literal(false),
    userError: Schema.Union([
      notLoggedIn,
      verifyPasswordUserError,
      startFreeAddressUserError,
      emailUnavailableUserError,
    ]),
  }),
]);

/** The result of `startChangeEmail`. */
export type StartChangeEmailResult = typeof startChangeEmailResult.Type;

export const completeChangeEmailResult = Schema.Union([
  Schema.Struct({ success: Schema.Literal(true) }),
  Schema.Struct({
    success: Schema.Literal(false),
    userError: Schema.Union([
      notLoggedIn,
      completeFreeAddressUserError,
      wrongUserUserError,
    ]),
  }),
]);

/** The result of `completeChangeEmail`. */
export type CompleteChangeEmailResult = typeof completeChangeEmailResult.Type;

export const startPasswordRecoveryResult = Schema.Union([
  Schema.Struct({
    success: Schema.Literal(true),
    browserSecret: Schema.String,
    // The address that received the link, as the user verified it. It can
    // differ from the typed address in case or in Unicode form.
    sentTo: Schema.String,
  }),
  Schema.Struct({
    success: Schema.Literal(false),
    userError: Schema.Union([startChallengeUserError, emailNotFoundUserError, emailUnavailableUserError]),
  }),
]);

/** The result of `startPasswordRecovery`. */
export type StartPasswordRecoveryResult = typeof startPasswordRecoveryResult.Type;

export const checkPasswordRecoveryResult = Schema.Union([
  Schema.Struct({ success: Schema.Literal(true) }),
  Schema.Struct({
    success: Schema.Literal(false),
    userError: completeChallengeUserError,
  }),
]);

/** The result of `checkPasswordRecovery`. */
export type CheckPasswordRecoveryResult = typeof checkPasswordRecoveryResult.Type;

export const completePasswordRecoveryResult = Schema.Union([
  SignInComplete,
  SignInPending,
  SignInError(Schema.Union([
    completeChallengeUserError,
    setPasswordUserError,
    Schema.Struct({ error: Schema.Literal("RATE_LIMITED"), retryAfterMs: Schema.Number }),
  ])),
]);

/** The result of `completePasswordRecovery`: the minted session tokens, or an error. */
export type CompletePasswordRecoveryResult = typeof completePasswordRecoveryResult.Type;

export type EmailPasswordProfile = Record<string, never>;

const PASSWORD_CHANGED = {
  kind: "password-recovery",
  subject: "Your password was changed",
  text:
    "The password of your account was changed.\n\n" +
    "If you did this, you can ignore this email. If you did not do " +
    "this, change your password immediately or contact support.",
} as const;

/**
 * A password sign-in method where accounts have a validated email address and a password.
 *
 * - Sign-up creates the user immediately but without a session; the user
 *   signs in only after they open the challenge link.
 * - Sign-in accepts any verified email of the account.
 * - Change-password and change-email require the session *and* the current
 *   password (OWASP ASVS v5 6.2.3), and send a security notification to the
 *   affected address (ASVS 6.3.7).
 * - Recovery proves ownership of a verified email through a 10-minute link,
 *   then sets the new password and signs the user in.
 *
 * Account resolution (email → user id) is owned by the email module; the
 * password module stores only `{ userId, passwordHash }`.
 *
 * ```ts
 * const method = setupEmailPassword(auth.core, { emailOutbox });
 * yield* method.signUpWithEmailPassword(call, { email, password });
 * ```
 */
export function setupEmailPassword(core: AuthCore, options: EmailPasswordOptions) {
  const bound = core.bindMethod<unknown>({
    name: METHOD_NAME,
    createUser: options.createUser ?? accountsModule.createUser,
    ...("onSignIn" in options
      ? options.onSignIn === undefined ? {} : { onSignIn: options.onSignIn }
      : { onSignIn: accountsModule.onSignIn }),
  });
  const runtimeName = options.runtimeName ?? "Zelavis";

  /**
   * What mail needs of the runtime now, or undefined when email delivery is
   * unavailable (disabled, or its settings cannot be read). Read once per
   * call, before the transaction: it is configuration, not data.
   */
  const senderNow = Effect.fn("auth.methods.emailPassword.sender")(function* () {
    if (options.emailOutbox === undefined) return undefined;
    const linkBase = yield* options.emailOutbox.linkBase().pipe(Effect.catch(() => Effect.succeed(undefined)));
    return linkBase === undefined ? undefined : ({ linkBase, runtimeName } satisfies ChallengeEmailSender);
  });

  /** Whether the runtime can deliver email now: the routes and the methods catalogue ask it. */
  const emailAvailable = () => Effect.map(senderNow(), (sender) => sender !== undefined);

  const unavailable = { success: false, userError: { error: "EMAIL_UNAVAILABLE" } } as const;

  /**
   * Send a security notification (ASVS 6.3.7) in the transaction's outbox.
   * Notifications need no validation state, only a send; none is sent when
   * email delivery is unavailable.
   */
  const notify = (
    tx: AuthTx,
    sender: ChallengeEmailSender | undefined,
    to: string,
    message: { kind: "email-verification" | "password-recovery"; subject: string; text: string },
  ) =>
    sender === undefined
      ? Effect.void
      : tx.emit({ topic: AUTH_EMAIL_TOPIC, id: `auth-notice-${generateRandomToken()}`, payload: noticeEmail(sender, { to, ...message }) });

  /**
   * Create the user and password for a new account, without a session. The
   * user signs in for the first time through
   * `completeSignUpWithEmailPassword`, after opening the challenge link.
   *
   * Repeated sign-ups with one unvalidated address create separate
   * users; the first completed validation wins, and the others can never
   * sign in.
   */
  const signUpWithEmailPassword = Effect.fn("auth.methods.emailPassword.signUp")(function* (
    call: AuthCall,
    { email, password, displayName }: { email: string; password: string; displayName?: string | undefined },
  ) {
    // Validate both inputs before creating anything, so invalid input
    // never creates a user.
    const formatError = validateEmailFormat(email);
    if (formatError !== null) {
      return { success: false, userError: formatError } satisfies SignUpResult;
    }
    const passwordError = validateNewPassword(password, DEFAULT_MIN_PASSWORD_LENGTH);
    if (passwordError !== null) {
      return { success: false, userError: passwordError } satisfies SignUpResult;
    }
    const emailSender = yield* senderNow();
    if (emailSender === undefined) return unavailable satisfies SignUpResult;
    yield* bound.query(call, (tx, helpers) => helpers.assertSignUpOpen(tx));
    // Hashed before the transaction: a retry after a conflict never hashes again.
    const passwordHashPHC = yield* hashPassword(password);

    return yield* bound.mutation(call, (tx, helpers) =>
      Effect.gen(function* () {
        yield* helpers.assertSignUpOpen(tx);
        // `check` runs every precondition of the `start` below (the rate
        // limits, address not taken), typically without consuming the limits:
        // these are expected outcomes, not defects.
        // (`EMAIL_TAKEN` takes a lookup token, so that sign-up is not a
        // free way to find which addresses have an account.)
        const emailError = yield* signUp.check(tx, { email });
        if (emailError !== null) {
          return { success: false, userError: emailError } satisfies SignUpResult;
        }

        const { userId } = yield* helpers.signUpWithoutSession(tx, { profile: { displayName } });
        yield* _internal_dangerous_setPassword(tx, { userId, passwordHashPHC });

        const start = yield* signUp._internal_dangerous_start(tx, {
          email,
          // The user is new, so this first address becomes primary.
          userId,
          emailSender,
        });
        if (!start.success) {
          // Unexpected: `check` passed above, in this same transaction.
          // Dying so the new user rolls back rather than being left with
          // no way to validate.
          return yield* invariant("Unexpected error when starting the email validation: " + start.userError.error);
        }

        return { success: true, browserSecret: start.browserSecret } satisfies SignUpResult;
      }),
    );
  });

  /**
   * Complete a sign-up: validate the email with the code from the link
   * and the secret from the starting browser, then sign the user in.
   * Validation and sign-in happen in one transaction.
   */
  const completeSignUpWithEmailPassword = Effect.fn("auth.methods.emailPassword.completeSignUp")(function* (
    call: AuthCall,
    { emailCode, browserSecret }: { emailCode: string; browserSecret: string },
  ) {
    return yield* bound.mutation(call, (tx, helpers) =>
      Effect.gen(function* () {
        const complete = yield* signUp.complete(tx, { emailCode, browserSecret });
        if (!complete.success) {
          return { status: "error", userError: complete.userError } satisfies CompleteSignUpResult;
        }
        const outcome = yield* helpers.completeSignIn(tx, {
          userId: complete.userId,
          profile: {},
          authenticatedBy: AUTHENTICATED_BY_EMAIL,
        });
        return outcome satisfies CompleteSignUpResult;
      }),
    );
  });

  /**
   * Verify an existing account's password and, on success, mint a
   * session. Any verified email of the account works. Returns
   * `USER_NOT_FOUND` when no account has verified the email and
   * `INVALID_CREDENTIALS` when the password is wrong. (Address existence
   * is already observable via sign-up's `EMAIL_TAKEN`, so distinguishing
   * them here leaks nothing new.) The lookup of the address has a
   * per-IP limit, and returns `RATE_LIMITED` when the client has done
   * too many lookups.
   */
  // Zelavis: a failed sign-in is a security event naming the tried address only by hash.
  const failed = (tx: AuthTx, email: string, userId: string | undefined) =>
    recordSecurityEvent(tx, { kind: "authentication.failed", accountId: userId, subject: { method: "emailPassword", identifier: email } });

  const signInWithEmailPassword = Effect.fn("auth.methods.emailPassword.signIn")(function* (
    call: AuthCall,
    { email, password }: { email: string; password: string },
  ) {
    const invalid = { status: "error", userError: { error: "INVALID_CREDENTIALS" } } satisfies SignInResult;

    // First transaction: the lookup (its per-client token is consumed here),
    // the rate limit of the account and the stored hash.
    const begun = yield* bound.mutation(call, (tx) =>
      Effect.gen(function* () {
        const lookup = yield* lookupPasswordEmail(tx, { email });
        if (!lookup.success) {
          if (lookup.userError.error === "RATE_LIMITED") {
            return { ok: false, result: { status: "error", userError: lookup.userError } satisfies SignInResult } as const;
          }
          yield* failed(tx, email, undefined);
          return { ok: false, result: { status: "error", userError: { error: "USER_NOT_FOUND" } } satisfies SignInResult } as const;
        }
        const { userId } = lookup;
        const verify = yield* beginVerify(tx, { userId, password });
        if (!verify.success) {
          if (verify.userError.error === "INVALID_CREDENTIALS") yield* failed(tx, email, userId);
          return { ok: false, result: { status: "error", userError: verify.userError } satisfies SignInResult } as const;
        }
        return { ok: true, userId, stored: verify.stored } as const;
      }),
    );
    if (!begun.ok) return begun.result;

    // Outside any transaction: the slow work.
    if (!(yield* verifyPasswordHash(password, begun.stored))) {
      // Zelavis: the failure is recorded in a transaction of its own; the check that found it had none.
      yield* bound.mutation(call, (tx) => failed(tx, email, begun.userId));
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
          authenticatedBy: AUTHENTICATED_BY_PASSWORD,
        });
        return outcome satisfies SignInResult;
      }),
    );
  });

  /**
   * Change the signed-in user's password. Requires the session *and* the
   * current password (OWASP ASVS v5 6.2.3), and notifies the primary
   * email address (ASVS 6.3.7). Signs out the user's other sessions
   * if `signOutOtherSessions` is `true` (ASVS v5 7.4.3).
   */
  const changePassword = Effect.fn("auth.methods.emailPassword.changePassword")(function* (
    call: AuthCall,
    {
      currentPassword,
      newPassword,
      signOutOtherSessions = false,
    }: { currentPassword: string; newPassword: string; signOutOtherSessions?: boolean },
  ) {
    const loggedOut = { success: false, userError: { error: "NOT_LOGGED_IN" } } satisfies ChangePasswordResult;
    const invalid = { success: false, userError: { error: "INVALID_CREDENTIALS" } } satisfies ChangePasswordResult;
    const sender = yield* senderNow();

    const begun = yield* bound.mutation(call, (tx) =>
      Effect.gen(function* () {
        const userId = yield* getAuthUserId(tx);
        if (userId === null) {
          return { ok: false, result: loggedOut } as const;
        }

        // Validate the new password before the current password, so that
        // an invalid new password does not consume the rate limit.
        const newPasswordError = validateNewPassword(newPassword, DEFAULT_MIN_PASSWORD_LENGTH);
        if (newPasswordError !== null) {
          return { ok: false, result: { success: false, userError: newPasswordError } satisfies ChangePasswordResult } as const;
        }

        // TODO: This doesn’t compose with other sign-in methods. If the user doesn’t
        // have a password yet, they currently can’t set one. We should fix this
        // when we have a first-party “auth-flow” concept so that users can
        // re-authenticate another way.
        const verify = yield* beginVerify(tx, { userId, password: currentPassword });
        if (!verify.success) {
          if (verify.userError.error === "RATE_LIMITED") {
            return { ok: false, result: { success: false, userError: verify.userError } satisfies ChangePasswordResult } as const;
          }
          // `beginVerify` also returns format errors. Return
          // INVALID_CREDENTIALS for all of them, so that the user does not
          // think that the new password has a problem.
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
        if ((yield* getAuthUserId(tx)) !== begun.userId) return loggedOut;
        const finished = yield* finishVerify(tx, { userId: begun.userId, stored: begun.stored });
        if (!finished.success) return invalid;
        yield* _internal_dangerous_setPassword(tx, { userId: begun.userId, passwordHashPHC });

        // The current password was just verified, so the caller owns this
        // session: sign out the user's other sessions if requested.
        if (signOutOtherSessions) {
          yield* helpers.revokeOtherSessions(tx);
        }

        const to = yield* getPrimaryEmail(tx, { userId: begun.userId });
        if (to !== null) {
          yield* notify(tx, sender, to, PASSWORD_CHANGED);
        }
        return { success: true } satisfies ChangePasswordResult;
      }),
    );
  });

  /**
   * Start changing the signed-in user's primary email address. The new
   * address replaces the old one: after the change, the account no
   * longer has the old address. Requires the session *and* the current
   * password (OWASP ASVS v5 6.2.3). Sends a challenge link to the new
   * address; the change happens in `completeChangeEmail`.
   */
  const startChangeEmail = Effect.fn("auth.methods.emailPassword.startChangeEmail")(function* (
    call: AuthCall,
    { newEmail, currentPassword }: { newEmail: string; currentPassword: string },
  ) {
    const loggedOut = { success: false, userError: { error: "NOT_LOGGED_IN" } } satisfies StartChangeEmailResult;
    const emailSender = yield* senderNow();
    if (emailSender === undefined) return unavailable satisfies StartChangeEmailResult;

    const begun = yield* bound.mutation(call, (tx) =>
      Effect.gen(function* () {
        const userId = yield* getAuthUserId(tx);
        if (userId === null) {
          return { ok: false, result: loggedOut } as const;
        }

        // Check the format of the new address before the password: a
        // malformed address must not consume the password-verification
        // rate limit. The other checks (the rate limits and
        // `EMAIL_TAKEN`) run in `start`, after the password, so that a
        // session without the password cannot probe addresses.
        const formatError = validateEmailFormat(newEmail);
        if (formatError !== null) {
          return { ok: false, result: { success: false, userError: formatError } satisfies StartChangeEmailResult } as const;
        }

        const verify = yield* beginVerify(tx, { userId, password: currentPassword });
        if (!verify.success) {
          return { ok: false, result: { success: false, userError: verify.userError } satisfies StartChangeEmailResult } as const;
        }
        return { ok: true, userId, stored: verify.stored } as const;
      }),
    );
    if (!begun.ok) return begun.result;

    const invalid = { success: false, userError: { error: "INVALID_CREDENTIALS" } } satisfies StartChangeEmailResult;
    if (!(yield* verifyPasswordHash(currentPassword, begun.stored))) return invalid;

    return yield* bound.mutation(call, (tx) =>
      Effect.gen(function* () {
        if ((yield* getAuthUserId(tx)) !== begun.userId) return loggedOut;
        const finished = yield* finishVerify(tx, { userId: begun.userId, stored: begun.stored });
        if (!finished.success) return invalid;
        const start = yield* changeEmail._internal_dangerous_start(tx, {
          email: newEmail,
          userId: begun.userId,
          emailSender,
        });
        if (!start.success) {
          return { success: false, userError: start.userError } satisfies StartChangeEmailResult;
        }
        return { success: true, browserSecret: start.browserSecret } satisfies StartChangeEmailResult;
      }),
    );
  });

  /**
   * Complete an email change. The old primary address is removed and
   * replaced with the new address. This also notifies old address
   * (OWASP ASVS 6.3.7).
   *
   * No session is minted — the user already has one.
   */
  const completeChangeEmail = Effect.fn("auth.methods.emailPassword.completeChangeEmail")(function* (
    call: AuthCall,
    { emailCode, browserSecret }: { emailCode: string; browserSecret: string },
  ) {
    const sender = yield* senderNow();
    return yield* bound.mutation(call, (tx) =>
      Effect.gen(function* () {
        // The link is bound to the user who started the change, so the
        // same user must be signed in to complete it. Another user gets
        // `WRONG_USER`, and the link still works for the right user.
        const userId = yield* getAuthUserId(tx);
        if (userId === null) {
          return { success: false, userError: { error: "NOT_LOGGED_IN" } } satisfies CompleteChangeEmailResult;
        }
        const complete = yield* changeEmail.complete(tx, { emailCode, browserSecret, userId });
        if (!complete.success) {
          return { success: false, userError: complete.userError } satisfies CompleteChangeEmailResult;
        }
        if (complete.previousEmail !== null) {
          yield* notify(tx, sender, complete.previousEmail, {
            kind: "email-verification",
            subject: "Your email address was changed",
            text:
              "The email address of your account was changed to " +
              `${complete.email}.\n\n` +
              "If you did this, you can ignore this email. If you did " +
              "not do this, reset your password immediately or contact " +
              "support.",
          });
        }
        return { success: true } satisfies CompleteChangeEmailResult;
      }),
    );
  });

  /**
   * Start a password recovery: send a reset link (valid 10 minutes) to a
   * verified email address. Any verified address of the account works,
   * not only the primary one.
   *
   * `EMAIL_NOT_FOUND` is surfaced to the caller. This reveals whether an
   * address has an account, which sign-up's `EMAIL_TAKEN` reveals
   * anyway; the method accepts that trade-off for a clearer flow (I7). The
   * lookup has a per-IP limit, so a client cannot probe many addresses.
   */
  const startPasswordRecovery = Effect.fn("auth.methods.emailPassword.startPasswordRecovery")(function* (
    call: AuthCall,
    { email }: { email: string },
  ) {
    const emailSender = yield* senderNow();
    if (emailSender === undefined) return unavailable satisfies StartPasswordRecoveryResult;
    return yield* bound.mutation(call, (tx) =>
      Effect.gen(function* () {
        // The address must belong to an account. The check runs again at
        // completion: the module does not verify the address for a
        // custom challenge.
        // TODO: Should we allow users to start a recovery flow through
        // a secondary email? Or support options to customize this?
        const lookup = yield* lookupEmail(tx, { email });
        if (!lookup.success) {
          return { success: false, userError: lookup.userError } satisfies StartPasswordRecoveryResult;
        }

        const start = yield* custom.start(tx, {
          // Send the link to the stored address, not to the typed one.
          // The lookup ignores the case, but a mail server can treat
          // `Alice@` and `alice@` as two mailboxes. Only the case that
          // the owner verified must receive a recovery link.
          email: lookup.storedEmail,
          purpose: RECOVERY_PURPOSE,
          // Nobody is signed in. The verified address must still belong to the account that requested recovery.
          expectedUserId: null,
          emailOwnerId: lookup.userId,
          emailSender,
          ttlMs: RECOVERY_TTL_MS,
          copy: RECOVERY_EMAIL,
        });
        if (!start.success) {
          return { success: false, userError: start.userError } satisfies StartPasswordRecoveryResult;
        }
        return {
          success: true,
          browserSecret: start.browserSecret,
          sentTo: lookup.storedEmail,
        } satisfies StartPasswordRecoveryResult;
      }),
    );
  });

  const checkRecovery = Effect.fn("auth.methods.emailPassword.checkRecovery")(function* (
    tx: AuthTx,
    claim: { emailCode: string; browserSecret: string },
  ) {
    const peek = yield* custom.peek(tx, { ...claim, purpose: RECOVERY_PURPOSE, currentUserId: null });
    if (!peek.success) {
      if (peek.userError.error === "WRONG_USER") return yield* invariant("Unexpected WRONG_USER in a recovery");
      return { success: false, userError: peek.userError } as const;
    }
    if (peek.emailOwnerId === null) return { success: false, userError: { error: "INVALID_CHALLENGE" } } as const;
    return { success: true, userId: peek.emailOwnerId } as const;
  });

  /** Check a recovery link before the user types a new password, without consuming it. */
  const checkPasswordRecovery = Effect.fn("auth.methods.emailPassword.checkPasswordRecovery")(function* (
    call: AuthCall,
    { emailCode, browserSecret }: { emailCode: string; browserSecret: string },
  ) {
    const checked = yield* bound.query(call, (tx) => checkRecovery(tx, { emailCode, browserSecret }));
    return (checked.success ? { success: true } : checked) satisfies CheckPasswordRecoveryResult;
  });

  /**
   * Complete a password recovery: the link code + browser secret prove
   * ownership of the email, so set the new password, sign out every
   * existing session of the user, and sign the user in, in one
   * transaction. Notifies the primary email (ASVS 6.3.7).
   */
  const completePasswordRecovery = Effect.fn("auth.methods.emailPassword.completePasswordRecovery")(function* (
    call: AuthCall,
    { emailCode, browserSecret, newPassword }: { emailCode: string; browserSecret: string; newPassword: string },
  ) {
    // Validate the password before claiming the one-shot link, so a
    // rejected password does not burn the link.
    const passwordError = validateNewPassword(newPassword, DEFAULT_MIN_PASSWORD_LENGTH);
    if (passwordError !== null) {
      return { status: "error", userError: passwordError } satisfies CompletePasswordRecoveryResult;
    }
    // Charge the client and check the link before starting the expensive hash.
    const checked = yield* bound.mutation(call, (tx) => Effect.gen(function* () {
      const limit = yield* rateLimiter.limit(tx, "completeRecoveryPerIp", { key: getClientIp(tx) });
      if (!limit.ok) {
        return { success: false, userError: { error: "RATE_LIMITED", retryAfterMs: limit.retryAfter } } as const;
      }
      return yield* checkRecovery(tx, { emailCode, browserSecret });
    }));
    if (!checked.success) return { status: "error", userError: checked.userError } satisfies CompletePasswordRecoveryResult;

    const sender = yield* senderNow();
    const passwordHashPHC = yield* hashPassword(newPassword);

    return yield* bound.mutation(call, (tx, helpers) =>
      Effect.gen(function* () {
        const complete = yield* custom.complete(tx, {
          emailCode,
          browserSecret,
          purpose: RECOVERY_PURPOSE,
          currentUserId: null,
        });
        if (!complete.success) {
          if (complete.userError.error === "WRONG_USER") {
            // Unexpected: the `expectedUserId` of the flow is `null`.
            return yield* invariant("Unexpected WRONG_USER in a recovery");
          }
          return { status: "error", userError: complete.userError } satisfies CompletePasswordRecoveryResult;
        }

        // The verified address must still belong to the account checked before hashing.
        const userId = checked.userId;
        if (complete.emailOwnerId !== userId) {
          return { status: "error", userError: { error: "INVALID_CHALLENGE" } } satisfies CompletePasswordRecoveryResult;
        }

        yield* _internal_dangerous_setPassword(tx, { userId, passwordHashPHC });

        // A recovery often follows an account takeover, so sign out every
        // session that predates it, which may belong to whoever knew the
        // old password. That includes this browser's session if it is the
        // user's: it predates the proof of ownership. Revoke before
        // minting the new session, so it survives.
        yield* helpers.revokeAllSessions(tx, userId);

        const outcome = yield* helpers.completeSignIn(tx, {
          userId,
          profile: {},
          authenticatedBy: AUTHENTICATED_BY_EMAIL,
        });

        // The notification goes to the primary address, which can be
        // different from the address that received the link.
        yield* notify(tx, sender, (yield* getPrimaryEmail(tx, { userId })) ?? complete.email, PASSWORD_CHANGED);
        return outcome satisfies CompletePasswordRecoveryResult;
      }),
    );
  });

  /**
   * Start adding an address to the signed-in account (Zelavis-own; upstream
   * exposes the `addEmail` challenge to apps). The account needs no email
   * for this, so a username + password owner can add one. The first address
   * of an account becomes primary.
   */
  const startAddEmail = Effect.fn("auth.methods.emailPassword.startAddEmail")(function* (
    call: AuthCall,
    { email }: { email: string },
  ) {
    const emailSender = yield* senderNow();
    if (emailSender === undefined) return unavailable satisfies StartAddEmailResult;
    return yield* bound.mutation(call, (tx) =>
      Effect.gen(function* () {
        const userId = yield* getAuthUserId(tx);
        if (userId === null) {
          return { success: false, userError: { error: "NOT_LOGGED_IN" } } satisfies StartAddEmailResult;
        }
        const start = yield* addEmail._internal_dangerous_start(tx, { email, userId, emailSender });
        if (!start.success) {
          return { success: false, userError: start.userError } satisfies StartAddEmailResult;
        }
        return { success: true, browserSecret: start.browserSecret } satisfies StartAddEmailResult;
      }),
    );
  });

  /** Complete adding an address: the signed-in account must be the one that started it. */
  const completeAddEmail = Effect.fn("auth.methods.emailPassword.completeAddEmail")(function* (
    call: AuthCall,
    { emailCode, browserSecret }: { emailCode: string; browserSecret: string },
  ) {
    return yield* bound.mutation(call, (tx) =>
      Effect.gen(function* () {
        const userId = yield* getAuthUserId(tx);
        if (userId === null) {
          return { success: false, userError: { error: "NOT_LOGGED_IN" } } satisfies CompleteChangeEmailResult;
        }
        const complete = yield* addEmail.complete(tx, { emailCode, browserSecret, userId });
        if (!complete.success) {
          return { success: false, userError: complete.userError } satisfies CompleteChangeEmailResult;
        }
        return { success: true } satisfies CompleteChangeEmailResult;
      }),
    );
  });

  /** The signed-in account's verified addresses; null when not signed in. */
  const listEmails = Effect.fn("auth.methods.emailPassword.listEmails")(function* (call: AuthCall) {
    return yield* bound.query(call, (tx) =>
      Effect.gen(function* () {
        const userId = yield* getAuthUserId(tx);
        return userId === null ? null : yield* getEmails(tx, { userId });
      }),
    );
  });

  return {
    emailAvailable,
    signUpWithEmailPassword,
    completeSignUpWithEmailPassword,
    signInWithEmailPassword,
    changePassword,
    startChangeEmail,
    completeChangeEmail,
    startPasswordRecovery,
    checkPasswordRecovery,
    completePasswordRecovery,
    startAddEmail,
    completeAddEmail,
    listEmails,
  };
}

export const startAddEmailResult = Schema.Union([
  Schema.Struct({ success: Schema.Literal(true), browserSecret: Schema.String }),
  Schema.Struct({
    success: Schema.Literal(false),
    userError: Schema.Union([notLoggedIn, startFreeAddressUserError, emailUnavailableUserError]),
  }),
]);

/** The result of `startAddEmail`. */
export type StartAddEmailResult = typeof startAddEmailResult.Type;

export type EmailPasswordMethod = ReturnType<typeof setupEmailPassword>;
