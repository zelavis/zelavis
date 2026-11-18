// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/server/setup.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: setupConvexAuth becomes createAuthCore over the module runtime; Convex function builders and handles become Effects over a transaction and plain callbacks (T1-T4); the users-table typing is not carried; completeSignIn runs the second-factor gate first and the core finishes a gated sign-in (finishPendingSignIn); every sign-up is first admitted by the registration policy, and sign-ups, sign-ins and revocations record security events (part 11).
import * as Effect from "effect/Effect";
import type { TransactionTooLarge } from "../../db/errors.js";
import type {
  BoundAuthHelpers,
  OnSignInFn,
  RefreshResult,
  SignInOutcome,
  TokenBundle,
  UserCallbacks,
} from "../lib/types.js";
import type { SecondFactorGate } from "../totp/gate.js";
import type { RegistrationClosed, RegistrationRefused } from "../registration/errors.js";
import { MethodDisabled, readMethodRevision } from "../methods/settings.js";
import { type TtlConfig, resolveTtlConfig } from "../lib/ttl.js";
import type { AuthCall, AuthTx, CoreRuntime } from "./context.js";
import type { AuthFailure } from "./errors.js";
import {
  _internal_dangerous_signIn,
  _internal_dangerous_signUp,
  _internal_dangerous_signUpWithoutSession,
  getSession,
  listSessions,
  refresh,
  revokeSessions,
  signOut,
} from "./public.js";
import { getAuthUserId } from "./userId.js";
import { recordSecurityEvent } from "../security/events.js";

const isTransactionTooLarge = (error: unknown): error is TransactionTooLarge =>
  typeof error === "object" && error !== null && (error as { _tag?: unknown })._tag === "TransactionTooLarge";

/** Zelavis: the registration policy as the core asks it (`registration/policy.ts`). */
export interface RegistrationGate {
  readonly check: (tx: AuthTx) => Effect.Effect<void, RegistrationClosed | TransactionTooLarge>;
  readonly admit: (tx: AuthTx) => Effect.Effect<void, RegistrationRefused | TransactionTooLarge>;
}

/**
 * A method bound to the core: the helpers its mutations use, and the
 * runner that gives a mutation its transaction and those helpers.
 *
 * @internal Not public until the API for custom methods is stable.
 */
export type BoundMethod<Profile, E = never> = {
  readonly name: string;
  readonly helpers: BoundAuthHelpers<Profile, E>;
  /**
   * Run `body` as one transaction: its writes, and everything a helper
   * writes, commit together or not at all. `body` may run again after a
   * conflict, so it must not do slow or external work.
   */
  mutation<A, E2>(
    call: AuthCall,
    body: (tx: AuthTx, helpers: BoundAuthHelpers<Profile, E>) => Effect.Effect<A, E2>,
  ): Effect.Effect<A, E2 | AuthFailure>;
  /** A read-only counterpart: nothing it does is written. */
  query<A, E2>(
    call: AuthCall,
    body: (tx: AuthTx, helpers: BoundAuthHelpers<Profile, E>) => Effect.Effect<A, E2>,
  ): Effect.Effect<A, E2>;
};

/**
 * The core auth API returned by {@link createAuthCore}: the session
 * operations the routes expose. The sign-in methods also use it to bind to the
 * core.
 */
export type AuthCore = {
  /** The resolved token and session lifetimes. */
  readonly ttl: TtlConfig;
  /**
   * Signs out of the current session.
   *
   * After this the refresh token is no longer valid.
   */
  signOut(call: AuthCall, args: { refreshToken: string }): Effect.Effect<null, AuthFailure>;
  /**
   * Refreshes a session using the given token, rotating the refresh token.
   *
   * Resolves to one of the {@link RefreshResult} outcomes. `rotated` carries a
   * new token bundle to persist; the presented token keeps working until the
   * new refresh token is first used, so a lost response can be retried. A
   * `noSession` result should be treated as signed-out.
   */
  refreshSession(call: AuthCall, args: { refreshToken: string }): Effect.Effect<RefreshResult, AuthFailure>;
  /**
   * Reports whether the caller's access token identifies a live session.
   *
   * The authenticator verifies the token's signature before the caller is
   * known, so the result is a trustworthy authentication verdict. The query
   * reads the session, so it returns `false` once the session is gone (signed
   * out elsewhere, revoked, or expired) even while the token itself is still
   * valid.
   */
  isAuthenticated(call: AuthCall): Effect.Effect<boolean, TransactionTooLarge>;
  /** A live session by id: its user, or null. */
  getSession(call: AuthCall, args: { sessionId: string }): Effect.Effect<{ userId: string } | null, TransactionTooLarge>;
  /** Every session of a user, newest first, with when it last refreshed. */
  listSessions(call: AuthCall, args: { userId: string }): Effect.Effect<ReadonlyArray<{ sessionId: string; creationTime: number; lastRefreshedAt: number }>, TransactionTooLarge>;
  /** Revokes sessions by id; answers the ids that existed. Does no authorization. */
  revokeSessions(call: AuthCall, args: { sessionIds: ReadonlyArray<string> }): Effect.Effect<ReadonlyArray<string>, AuthFailure>;
  /** Revokes every session of the caller's account but the caller's own; see {@link BoundAuthHelpers.revokeOtherSessions}. */
  revokeOtherSessions(call: AuthCall): Effect.Effect<number, AuthFailure>;
  /**
   * Register a sign-in method with the core and get the helpers and runner its
   * implementation uses.
   *
   * `name` is the name of the sign-in method. The callbacks get it as
   * `method.name`. Two sign-in methods with one name would be
   * indistinguishable, so a duplicate name on this core throws.
   *
   * `createUser` is the method's user-creating callback and `onSignIn` is its
   * optional per-sign-in hook (see {@link UserCallbacks}).
   *
   * @internal Not public until the API for custom methods is stable.
   */
  bindMethod<Profile, E = never>(options: BoundMethodOptions & UserCallbacks<Profile, E>): BoundMethod<Profile, E>;
  /** Whether the method is still bound and its provider configuration still authorizes this proof. */
  pendingProviderIsCurrent(tx: AuthTx, proof: { method: string; providerRevision?: string | undefined }): Effect.Effect<boolean, AuthFailure>;
  /**
   * Zelavis: create the session of a sign-in the second-factor gate stopped,
   * once its second factor was presented, as `completeSignIn` would have:
   * the method's `onSignIn` runs and the session records the module. Null when
   * no method of that name is bound to this core any more. Does no check of
   * its own: the caller has verified the second factor in `tx`.
   */
  finishPendingSignIn(
    tx: AuthTx,
    args: { userId: string; method: string; component: string; profile: unknown; providerRevision?: string | undefined },
  ): Effect.Effect<TokenBundle | null, AuthFailure>;
};

interface BoundMethodOptions {
  readonly name: string;
  readonly secondFactor?: boolean;
  readonly pendingProviderIsCurrent?: (tx: AuthTx, revision: string) => Effect.Effect<boolean, AuthFailure>;
}

/**
 * Revoke the given sessions (as `listSessions` lists them) and count the
 * active ones revoked. Expired sessions are deleted too, but not counted. A
 * session expires one inactivity timeout after it last refreshed, or one
 * max lifetime after it was created, whichever comes first.
 */
const revokeListedSessions = Effect.fn("auth.core.revokeListedSessions")(function* (
  tx: AuthTx,
  ttl: TtlConfig,
  sessions: ReadonlyArray<{ sessionId: string; creationTime: number; lastRefreshedAt: number }>,
) {
  if (sessions.length === 0) {
    return 0;
  }
  const revoked = new Set(
    yield* revokeSessions(tx, { sessionIds: sessions.map(({ sessionId }) => sessionId) }),
  );
  const maxLifetimeMs = ttl.sessionMaxLifetimeSeconds * 1000;
  const inactivityTimeoutMs = ttl.refreshInactivityTimeoutSeconds * 1000;
  const now = tx.now;
  return sessions.filter(
    ({ sessionId, creationTime, lastRefreshedAt }) =>
      revoked.has(sessionId) &&
      lastRefreshedAt + inactivityTimeoutMs > now &&
      creationTime + maxLifetimeMs > now,
  ).length;
});

const revokeOtherSessionsIn = Effect.fn("auth.core.revokeOtherSessions")(function* (tx: AuthTx, ttl: TtlConfig) {
  const identity = tx.caller;
  if (identity === undefined) {
    return 0;
  }
  const currentSessionId = identity.sessionId;
  const session = yield* getSession(tx, { sessionId: currentSessionId });
  // A revoked current session can't sign out other sessions.
  if (session === null) {
    return 0;
  }
  const sessions = yield* listSessions(tx, { userId: session.userId });
  return yield* revokeListedSessions(
    tx,
    ttl,
    sessions.filter(({ sessionId }) => sessionId !== currentSessionId),
  );
});

/**
 * Build the core API from the module runtime. Give the result to the setup
 * function of each method:
 *
 * ```ts
 * const core = createAuthCore({ runtime, ttl: {} });
 * const bound = core.bindMethod({ name: "usernamePassword", createUser, onSignIn });
 * ```
 *
 * The core never triggers a sign-in itself: it has no idea how any given
 * method authenticates a user. *Triggering sign-in is the responsibility of
 * each method.* A method:
 * 1. verifies the user its own way (checking a password, say),
 * 2. looks the identity's account up in its own module,
 * 3. calls `completeSignUp` for a new identity, or `completeSignIn` for a
 *    known one, to get a session.
 *
 * The core hands both helpers to the method's mutations.
 *
 * Token and session lifetimes are configurable here. The access-token TTL
 * defaults to 5m, and `sessionMaxLifetimeSeconds` to 30d.
 * `refreshInactivityTimeoutSeconds` defaults to the max lifetime and cannot
 * exceed it. The access-token TTL must be shorter than the inactivity timeout,
 * and (since the client refreshes shortly before expiry) comfortably longer
 * than a few seconds.
 *
 * Changes to access token TTLs impact newly minted tokens, not ones that have
 * already been issued. Session/refresh related TTLs apply to all issued tokens.
 */
export function createAuthCore(options: {
  runtime: CoreRuntime;
  ttl?: Partial<TtlConfig>;
  /** Zelavis: asked by every `completeSignIn` of a method bound with `secondFactor` (the default). None: no method is gated. */
  secondFactor?: SecondFactorGate;
  /** Zelavis: admits every sign-up of every method (`completeSignUp`, `signUpWithoutSession`). None: every sign-up is admitted. */
  registration?: RegistrationGate;
}): AuthCore {
  const { runtime } = options;
  // Resolved once, when the runtime is created, so an invalid configuration
  // fails the start rather than the first sign-in.
  const ttl = resolveTtlConfig(options.ttl ?? {});

  // Names of methods bound to this core, for duplicate detection. Scoped to
  // this `createAuthCore` call, since names only need to be unique within one
  // core.
  const boundMethodNames = new Set<string>();
  const admit = (tx: AuthTx): Effect.Effect<void, RegistrationRefused | TransactionTooLarge> =>
    options.registration === undefined ? Effect.void : options.registration.admit(tx);
  const requireMethod = Effect.fn("auth.core.requireMethod")(function* (tx: AuthTx, name: string) {
    const revision = yield* readMethodRevision(tx, name);
    if (revision === null) return yield* new MethodDisabled();
    return revision;
  });
  // Zelavis: the `onSignIn` of each bound method, by name, for the sign-ins
  // the second-factor gate stopped. A failing hook is a defect there: the
  // client already passed both factors and nothing it can change helps.
  const pendingMethods = new Map<string, {
    onSignIn: OnSignInFn<unknown, unknown> | undefined;
    providerIsCurrent: BoundMethodOptions["pendingProviderIsCurrent"];
  }>();
  const pendingProviderIsCurrent = Effect.fn("auth.core.pendingProviderIsCurrent")(function* (
    tx: AuthTx,
    proof: { method: string; providerRevision?: string | undefined },
  ) {
    const bound = pendingMethods.get(proof.method);
    if (bound === undefined) return false;
    if (bound.providerIsCurrent === undefined) return true;
    return proof.providerRevision !== undefined && (yield* bound.providerIsCurrent(tx, proof.providerRevision));
  });

  const bindMethod = <Profile, E = never>({
    name,
    secondFactor = true,
    createUser,
    onSignIn,
    pendingProviderIsCurrent,
  }: BoundMethodOptions & UserCallbacks<Profile, E>): BoundMethod<Profile, E> => {
    if (boundMethodNames.has(name)) {
      throw new Error(
        `A sign-in method named "${name}" is already bound to this auth core. ` +
          `The callbacks get the name of the sign-in method as ` +
          `\`method.name\`, so each sign-in method must have a unique name.`,
      );
    }
    boundMethodNames.add(name);
    pendingMethods.set(name, { onSignIn: onSignIn as OnSignInFn<unknown, unknown> | undefined, providerIsCurrent: pendingProviderIsCurrent });
    const gate = secondFactor ? options.secondFactor : undefined;

    // The helpers run in the transaction they are handed.
    const helpers: BoundAuthHelpers<Profile, E> = {
      completeSignUp: (tx, args) =>
        Effect.gen(function* () {
          yield* requireMethod(tx, name);
          yield* admit(tx);
          const tokens = yield* _internal_dangerous_signUp(tx, {
            claims: {
              method: name,
              profile: args.profile,
            },
            componentPath: args.authenticatedBy,
            createUser,
            onSignIn,
            ...ttl,
          });
          yield* recordSecurityEvent(tx, { kind: "account.created", accountId: tokens.userId, detail: { method: name } });
          yield* recordSecurityEvent(tx, { kind: "authentication.succeeded", accountId: tokens.userId, detail: { method: name } });
          return tokens;
        }),
      completeSignIn: (tx, args) =>
        Effect.gen(function* () {
          const methodRevision = yield* requireMethod(tx, name);
          if (gate !== undefined) {
            const pending = yield* gate.check(tx, {
              userId: args.userId,
              method: name,
              component: args.authenticatedBy,
              profile: args.profile,
              methodRevision,
              providerRevision: args.providerRevision,
            });
            if (pending !== null) return pending;
          }
          const tokens = yield* _internal_dangerous_signIn(tx, {
            claims: {
              method: name,
              profile: args.profile,
            },
            componentPath: args.authenticatedBy,
            userId: args.userId,
            onSignIn,
            ...ttl,
          });
          yield* recordSecurityEvent(tx, { kind: "authentication.succeeded", accountId: args.userId, detail: { method: name } });
          return { status: "complete", tokens } satisfies SignInOutcome;
        }),
      signUpWithoutSession: (tx, args) =>
        Effect.gen(function* () {
          yield* requireMethod(tx, name);
          yield* admit(tx);
          const created = yield* _internal_dangerous_signUpWithoutSession(tx, {
            claims: {
              method: name,
              profile: args.profile,
            },
            createUser,
          });
          yield* recordSecurityEvent(tx, { kind: "account.created", accountId: created.userId, detail: { method: name } });
          return created;
        }),
      assertSignUpOpen: (tx) => Effect.andThen(requireMethod(tx, name), options.registration?.check(tx) ?? Effect.void),
      revokeOtherSessions: (tx) => revokeOtherSessionsIn(tx, ttl),
      revokeAllSessions: (tx, userId) =>
        Effect.gen(function* () {
          const sessions = yield* listSessions(tx, { userId });
          return yield* revokeListedSessions(tx, ttl, sessions);
        }),
    };

    return {
      name,
      helpers,
      mutation: (call, body) => runtime.mutation(call, (tx) => body(tx, helpers)),
      query: (call, body) => runtime.query(call, (tx) => body(tx, helpers)),
    };
  };

  return {
    ttl,
    refreshSession: (call, args) =>
      runtime.mutation(call, (tx) => refresh(tx, { refreshToken: args.refreshToken, ...ttl })),
    signOut: (call, args) =>
      runtime.mutation(call, (tx) => signOut(tx, { refreshToken: args.refreshToken })),
    // Reads the session, so it reflects a revocation at once.
    isAuthenticated: (call) =>
      runtime.query(call, (tx) => Effect.map(getAuthUserId(tx), (userId) => userId !== null)),
    getSession: (call, args) => runtime.query(call, (tx) => getSession(tx, args)),
    listSessions: (call, args) => runtime.query(call, (tx) => listSessions(tx, args)),
    revokeSessions: (call, args) => runtime.mutation(call, (tx) => Effect.gen(function* () {
      const revoked = yield* revokeSessions(tx, args);
      if (revoked.length > 0) {
        yield* recordSecurityEvent(tx, { kind: "session.revoked", accountId: call.caller?.userId, detail: { sessions: revoked.length } });
      }
      return revoked;
    })),
    revokeOtherSessions: (call) => runtime.mutation(call, (tx) => Effect.gen(function* () {
      const revoked = yield* revokeOtherSessionsIn(tx, ttl);
      if (revoked > 0) {
        yield* recordSecurityEvent(tx, { kind: "session.revoked", accountId: call.caller?.userId, detail: { sessions: revoked } });
      }
      return revoked;
    })),
    bindMethod,
    pendingProviderIsCurrent,
    finishPendingSignIn: Effect.fn("auth.core.finishPendingSignIn")(function* (tx, args) {
      const bound = pendingMethods.get(args.method);
      if (bound === undefined || (yield* readMethodRevision(tx, args.method)) === null) return null;
      if (!(yield* pendingProviderIsCurrent(tx, args))) return null;
      return yield* _internal_dangerous_signIn(tx, {
        claims: { method: args.method, profile: args.profile },
        componentPath: args.component,
        userId: args.userId,
        onSignIn: bound.onSignIn,
        ...ttl,
      }).pipe(
        Effect.tap(() => recordSecurityEvent(tx, { kind: "authentication.succeeded", accountId: args.userId, detail: { method: args.method, secondFactor: true } })),
        Effect.catchIf(
          (error): error is Exclude<typeof error, TransactionTooLarge> => !isTransactionTooLarge(error),
          (error) => Effect.die(error),
        ),
      );
    }),
  };
}
