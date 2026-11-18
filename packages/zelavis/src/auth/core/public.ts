// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/component/public.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: mutations and queries are Effects over an AuthTx (T1-T4), the app callbacks are functions run in the same transaction (T3), access tokens are signed by tx.keys (T7), and the audience is "zelavis-auth"; sign-out and refresh-token reuse record security events (part 11).
import * as Effect from "effect/Effect";
import type { TransactionTooLarge } from "../../db/errors.js";
import { recordSecurityEvent } from "../security/events.js";
import type { AuthClaims, CreateUserFn, OnSignInFn, RefreshResult, TokenBundle } from "../lib/types.js";
import { sha256Hex } from "../lib/crypto.js";
import { invariant } from "../runtime/index.js";
import {
  refreshTokenInactivityExpiresAt,
  sessionMaxLifetimeExpiresAt,
} from "./expiry.js";
import { type TtlConfig, validateTtlConfig } from "../lib/ttl.js";
import {
  STANDARD_ISSUED_REFRESH_TOKEN_LIMIT,
  REFRESH_GRACE_MS,
  deleteSession,
  evictLeastRecentlyRefreshedSessions,
  issueRefreshToken,
  lookupRefreshTokenByHash,
  newestIssuedToken,
  redeem,
  sessionsOfUser,
} from "./sessions.js";
import type { AuthTx } from "./context.js";
import { coreTables } from "./tables.js";

type Claims<Profile> = Omit<AuthClaims, "profile"> & { readonly profile: Profile };

// --- Internal helpers ------------------------------------------------------

/**
 * Mint the access token with the runtime's signing key. The key set adds
 * `iss`, `aud`, `iat` and `exp`; this sets the claim the core owns: the
 * subject.
 *
 * The subject is the session id, not the user id: the runtime resolves the
 * user through the session (see `getSession`), so a revoked session stops
 * resolving to a user before its tokens expire.
 */
function mintAccessToken(tx: AuthTx, sessionId: string, ttlSeconds: number) {
  return tx.keys.sign({
    claims: { sub: sessionId },
    expiresInSeconds: ttlSeconds,
  });
}

const issueSession = Effect.fn("auth.core.issueSession")(function* (
  tx: AuthTx,
  userId: string,
  component: string,
  ttl: TtlConfig,
) {
  const now = tx.now;
  yield* evictLeastRecentlyRefreshedSessions(tx, userId);
  const sessionId = yield* tx.db.insert(coreTables.sessions, {
    userId,
    component,
  });
  // Read back for its `_creationTime`, which its max lifetime counts from.
  const session = (yield* tx.db.get(coreTables.sessions, sessionId))!;
  // Issued like any other token: it is redeemed on the session's first
  // refresh.
  const { refreshToken, expiresAt } = yield* issueRefreshToken(
    tx,
    session,
    now,
    ttl,
  );
  const accessToken = yield* mintAccessToken(
    tx,
    sessionId,
    ttl.accessTokenTtlSeconds,
  );
  return {
    accessToken,
    refreshToken,
    refreshTokenExpiresAt: expiresAt,
    userId,
  } satisfies TokenBundle;
});

/**
 * Create the account for a new identity with the method's `createUser`
 * callback, and return its id.
 */
function createAppUser<Profile, E>(
  tx: AuthTx,
  claims: Claims<Profile>,
  createUser: CreateUserFn<Profile, E>,
) {
  return createUser(tx, {
    method: {
      name: claims.method,
      profile: claims.profile,
    },
  });
}

/** Add the user to `createdUserIds`, if it is not there yet. */
const recordCreatedUserId = Effect.fn("auth.core.recordCreatedUserId")(function* (tx: AuthTx, userId: string) {
  const existing = yield* tx.db
    .query(coreTables.createdUserIds)
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  if (existing === null) {
    yield* tx.db.insert(coreTables.createdUserIds, { userId });
  }
});

/**
 * Run the method's sign-in callback, if it attached one. Every sign-in goes
 * through here, a first one included, so per-sign-in work in the runtime has a
 * single home.
 */
function notifySignIn<Profile, E>(
  tx: AuthTx,
  claims: Claims<Profile>,
  userId: string,
  onSignIn: OnSignInFn<Profile, E> | undefined,
): Effect.Effect<void, E | TransactionTooLarge> {
  if (onSignIn === undefined) return Effect.void;
  return onSignIn(tx, {
    method: {
      name: claims.method,
      profile: claims.profile,
    },
    userId,
  });
}

// --- Core API ------------------------------------------------------------

/**
 * Performs a new account sign-up.
 *
 * Establishes a session and returns a token bundle upon success.
 *
 * Sign-in methods don't typically call this API directly, but instead use the
 * framework's `completeSignUp` helper. That function takes care of passing the
 * `createUser` and `onSignIn` callbacks.
 *
 * `createUser` mints the account, then `onSignIn` runs like it does for any
 * other sign-in. An `onSignIn` that fails therefore rolls back the user
 * `createUser` just made, since both run in this transaction.
 *
 * The core doesn't track identities, so a repeated sign-up creates another
 * user. The sign-in method must check its own module for the identity
 * first, and record the returned `userId` there in the same mutation.
 *
 * The JWT accessToken in the return value is signed by the runtime's key.
 * The token and session lifetimes are the runtime's configuration, which
 * `createAuthCore` resolves and passes in.
 *
 * `componentPath` is the name of the module that authenticated the user, for
 * example `"password"`. The session records it as its `component`.
 *
 * See {@link _internal_dangerous_signIn} for the return-visit path.
 *
 * DANGER: This trusts `claims`, which reach `createUser` and
 * `onSignIn`. The name says so because other code must not call it: only
 * the sign-in methods of this package do, right after they verify the user.
 */
export const _internal_dangerous_signUp = <Profile, E>(
  tx: AuthTx,
  args: TtlConfig & {
    claims: Claims<Profile>;
    componentPath: string;
    createUser: CreateUserFn<Profile, E>;
    onSignIn?: OnSignInFn<Profile, E> | undefined;
  },
): Effect.Effect<TokenBundle, E | TransactionTooLarge> =>
  Effect.gen(function* () {
    const ttl = validateTtlConfig(args);
    const userId = yield* createAppUser(tx, args.claims, args.createUser);
    yield* recordCreatedUserId(tx, userId);
    yield* notifySignIn(tx, args.claims, userId, args.onSignIn);
    return yield* issueSession(tx, userId, args.componentPath, ttl);
  });

/**
 * Performs a sign-in of an existing user.
 *
 * Establishes a session and returns a token bundle upon success.
 *
 * Sign-in methods don't typically call this API directly, but instead use the
 * framework's `completeSignIn` helper. That function takes care of passing the
 * `onSignIn` callback.
 *
 * The core doesn't check `userId`, so a wrong `userId` signs the caller in as
 * that user. Sign-in methods must pass only a user id they looked up after
 * verifying the identity.
 *
 * DANGER: This mints a session for any `userId`. The name says so because
 * other code must not call it: only the sign-in methods of this package do,
 * right after they verify the user.
 *
 * `componentPath` is the name of the module that authenticated the user, for
 * example `"password"`. The session records it as its `component`.
 *
 * The JWT accessToken in the return value is signed by the runtime's key.
 * The token and session lifetimes are the runtime's configuration, which
 * `createAuthCore` resolves and passes in.
 */
export const _internal_dangerous_signIn = <Profile, E>(
  tx: AuthTx,
  args: TtlConfig & {
    claims: Claims<Profile>;
    componentPath: string;
    userId: string;
    onSignIn?: OnSignInFn<Profile, E> | undefined;
  },
): Effect.Effect<TokenBundle, E | TransactionTooLarge> =>
  Effect.gen(function* () {
    const ttl = validateTtlConfig(args);
    const { claims, userId } = args;
    if (userId === "") {
      return yield* invariant("Cannot sign in: no user id was given.");
    }
    yield* recordCreatedUserId(tx, userId);
    yield* notifySignIn(tx, claims, userId, args.onSignIn);
    return yield* issueSession(tx, userId, args.componentPath, ttl);
  });

/**
 * Create the account for the verified identity claims of a sign-in method
 * without minting a session.
 *
 * Sign-in methods use this (via the `signUpWithoutSession` helper the core
 * hands them) when the user must complete a step before the first sign-in — for
 * example, an email validation. The method's `createUser` creates the
 * user, as for `_internal_dangerous_signUp`. No session is minted and `onSignIn` doesn't
 * run, so the user can't make authenticated calls until a later
 * `_internal_dangerous_signIn` succeeds. The caller must record the returned `userId` in
 * its own module.
 *
 * DANGER: This trusts `claims`, which reach `createUser`. The name
 * says so because other code must not call it: only the sign-in methods of this
 * package do, right after they verify the user.
 */
export const _internal_dangerous_signUpWithoutSession = <Profile, E>(
  tx: AuthTx,
  args: {
    claims: Claims<Profile>;
    createUser: CreateUserFn<Profile, E>;
  },
): Effect.Effect<{ userId: string }, E | TransactionTooLarge> =>
  Effect.gen(function* () {
    // TODO: This API is kind of awkward. We might want to reconsider it before the GA v2 release.
    const userId = yield* createAppUser(tx, args.claims, args.createUser);
    yield* recordCreatedUserId(tx, userId);
    return { userId };
  });

/**
 * Record that a user exists.
 *
 * The core records the users that it creates and signs in. Call this function
 * for the other users: the users that the runtime imports or creates without the
 * core, and the users that existed before the runtime upgraded to this version.
 *
 * Any code of the runtime can call this function. That is safe: it only records
 * that an ID is in use.
 */
export const markUserIdCreated = Effect.fn("auth.core.markUserIdCreated")(function* (tx: AuthTx, args: { userId: string }) {
  if (args.userId === "") {
    return yield* invariant("Cannot mark an empty user ID as created.");
  }
  yield* recordCreatedUserId(tx, args.userId);
  return null;
});

/**
 * Look up a live session by its id.
 *
 * Returns an object with the session's `userId` when the session row exists.
 * If there is no row for the session id, it returns `null`.
 *
 * A session is live exactly as long as its row exists: sign-out, refresh-token
 * reuse detection, and expired-token cleanup all delete the row.
 *
 * This is a core function callable by the runtime, not by end-user clients,
 * so it does not expose session existence to the outside world.
 */
export const getSession = Effect.fn("auth.core.getSession")(function* (tx: AuthTx, args: { sessionId: string }) {
  const id = tx.db.normalizeId(coreTables.sessions, args.sessionId);
  if (id === null) return null;
  const session = yield* tx.db.get(coreTables.sessions, id);
  return session === null ? null : { userId: session.userId };
});

/**
 * Exchange a refresh token for a fresh access token and a newly issued
 * refresh token.
 *
 * A token is redeemed the first time it is presented, and stays valid until a
 * token issued after it is redeemed. The presented token is one of (see the
 * schema for the states):
 *
 *  * `issued`: redeem it, then issue a new token as below.
 *  * `redeemed`: issue a new token and leave this one redeemed. A client whose
 *    response was lost still holds a valid token, however long it waits before
 *    trying again.
 *  * `spent` or `dropped`: the session's holders have diverged, which is what
 *    a stolen token looks like. Revoke the session.
 *  * Unknown, or expired (not refreshed within the refresh inactivity timeout,
 *    or past the session's max lifetime):
 *    report no session.
 *
 * The outcomes are the arms of {@link RefreshResult}: `rotated` carries the
 * new refresh token to persist, and `noSession` means the client must reflect
 * being signed out.
 *
 * Racers presenting the same issued token are serialized: the first redeems
 * it, and the rest find it redeemed. Each racer gets its own issued token, and
 * within `REFRESH_GRACE_MS` of the redemption they don't count against
 * `STANDARD_ISSUED_REFRESH_TOKEN_LIMIT`. Whichever one the client keeps is
 * redeemed on its next refresh, and the rest are dropped without ever being
 * presented.
 */
export const refresh = Effect.fn("auth.core.refresh")(function* (tx: AuthTx, args: TtlConfig & { refreshToken: string }) {
  // Validate the TTL config well before use below: an invalid one should
  // throw unconditionally.
  const ttl = validateTtlConfig(args);
  const now = tx.now;

  const token = yield* lookupRefreshTokenByHash(tx, yield* sha256Hex(args.refreshToken));
  // A token this core has no record of ever issuing, or one retired past the
  // detection horizon. Revoking anything here would let anyone sign anyone
  // else out by presenting a made-up string, so an unknown token reports no
  // session and changes nothing.
  if (token === null) return { kind: "noSession" } as const satisfies RefreshResult;
  // A session's tokens are erased in the background after its row (see
  // `deleteSession`), so a token can outlive its session for a moment. The
  // session ended already, thus there is nothing to refresh or revoke.
  const session = yield* tx.db.get(coreTables.sessions, token.sessionId);
  if (session === null) return { kind: "noSession" } as const satisfies RefreshResult;

  switch (token.state) {
    case "spent":
    case "dropped":
      yield* Effect.logWarning(
        (token.state === "dropped"
          ? "Dropped refresh token used: a sibling was already redeemed, " +
            "so the session has forked. "
          : "Spent refresh token used: a later token was already redeemed. ") +
          "Deleting the associated session. This could be due to a bug or " +
          "a leaked refresh token.",
      );
      yield* deleteSession(tx, token.sessionId);
      // Zelavis: the revocation is a security event, recorded in the same transaction.
      yield* recordSecurityEvent(tx, { kind: "session.reuse_detected", accountId: session.userId, detail: { state: token.state } });
      return { kind: "noSession" } as const satisfies RefreshResult;
    case "issued":
    case "redeemed":
      break;
  }

  // A redeemed token's session last refreshed when it issued its newest
  // token, so date inactivity from that one.
  const lastIssued =
    token.state === "redeemed"
      ? ((yield* newestIssuedToken(tx, session._id)) ?? token)
      : token;
  if (
    refreshTokenInactivityExpiresAt(
      lastIssued,
      ttl.refreshInactivityTimeoutSeconds,
    ) <= now ||
    sessionMaxLifetimeExpiresAt(session, ttl.sessionMaxLifetimeSeconds) <= now
  ) {
    yield* deleteSession(tx, session._id);
    return { kind: "noSession" } as const satisfies RefreshResult;
  }
  if (token.state === "issued") {
    yield* redeem(tx, token, now);
  } else {
    // Every issued token descends from the redeemed one, and the oldest was
    // issued when it was redeemed. Issued rows have no `retiredAt`, so the
    // index orders them by `_creationTime`, oldest first, and reading up to
    // the limit is enough to both date the redemption and check the count.
    const issued = yield* tx.db
      .query(coreTables.refreshTokens)
      .withIndex("by_session_state", (q) =>
        q.eq("sessionId", token.sessionId).eq("state", "issued"),
      )
      .take(STANDARD_ISSUED_REFRESH_TOKEN_LIMIT);
    if (
      issued.length >= STANDARD_ISSUED_REFRESH_TOKEN_LIMIT &&
      now - issued[0]!._creationTime > REFRESH_GRACE_MS
    ) {
      yield* Effect.logWarning(
        `Refresh token used with at least ${issued.length} issued tokens never ` +
          "redeemed: deleting the associated session. This could be due to " +
          "a bug or a leaked refresh token.",
      );
      yield* deleteSession(tx, token.sessionId);
      return { kind: "noSession" } as const satisfies RefreshResult;
    }
  }

  const { refreshToken, expiresAt } = yield* issueRefreshToken(
    tx,
    session,
    now,
    ttl,
  );
  const accessToken = yield* mintAccessToken(
    tx,
    session._id,
    ttl.accessTokenTtlSeconds,
  );
  return {
    kind: "rotated",
    tokens: {
      accessToken,
      refreshToken,
      refreshTokenExpiresAt: expiresAt,
      userId: session.userId,
    },
  } as const satisfies RefreshResult;
});

/**
 * Revoke a session (sign out). Idempotent.
 *
 * Any token the session remembers will do, whatever its state: a client
 * usually holds an issued token it hasn't redeemed yet, and one signing out
 * just after a sibling tab refreshed may hold a spent one. Either is a real
 * sign-out request.
 */
export const signOut = Effect.fn("auth.core.signOut")(function* (tx: AuthTx, args: { refreshToken: string }) {
  const token = yield* lookupRefreshTokenByHash(tx, yield* sha256Hex(args.refreshToken));
  if (token !== null) {
    const session = yield* tx.db.get(coreTables.sessions, token.sessionId);
    yield* deleteSession(tx, token.sessionId);
    // Zelavis: a sign-out that ended a live session is a security event.
    if (session !== null) yield* recordSecurityEvent(tx, { kind: "session.ended", accountId: session.userId });
  }
  return null;
});

/**
 * List every session of a user, with when it last refreshed.
 *
 * `lastRefreshedAt` is when the session's newest issued refresh token was
 * issued: the session's sign-in or its latest refresh. A connected client
 * refreshes about once per access-token TTL, so callers may read this as a
 * rough activity signal, but it tracks the client holding the session, not
 * user interaction.
 *
 * Sessions are listed newest first.
 *
 * Expired sessions are included, since a session's row outlives its tokens
 * until something deletes it; callers that want only the active sessions
 * compare the expiry to the current time themselves.
 *
 * This is a core function callable by the runtime, not by end-user clients.
 */
export const listSessions = Effect.fn("auth.core.listSessions")(function* (tx: AuthTx, args: { userId: string }) {
  const sessions = yield* sessionsOfUser(tx, args.userId, "desc");
  const result = [];
  for (const session of sessions) {
    const newestIssued = yield* newestIssuedToken(tx, session._id);
    if (newestIssued === null) {
      yield* Effect.logWarning(
        `Session ${session._id} has no issued refresh token, which should ` +
          "be impossible. Leaving it out of the session list.",
      );
      continue;
    }
    result.push({
      sessionId: session._id,
      creationTime: session._creationTime,
      lastRefreshedAt: newestIssued._creationTime,
    });
  }
  return result;
});

/**
 * Revoke sessions, erasing each along with its refresh tokens, so their
 * holders can no longer refresh.
 *
 * Returns the ids of the sessions that existed and were revoked. An id that is
 * no session (malformed, already revoked, or repeated in `sessionIds`) is
 * skipped.
 *
 * This is a core function callable by the runtime, not by end-user clients.
 *
 * NOTE: This does no authorization: it revokes any session it is given,
 * whichever user it belongs to. Callers decide which sessions may be revoked;
 * e.g. revoking a user's other sessions should only follow a check that the
 * signed-in user truly owns the current session, via confirming an
 * authentication method. Otherwise, the request might be originating from a
 * stolen session, which shouldn't be able to revoke other sessions.
 */
// TODO: when we have step-up auth revoking sessions should check its state,
// rather than count on callers to safely invoke it.
export const revokeSessions = Effect.fn("auth.core.revokeSessions")(function* (tx: AuthTx, args: { sessionIds: ReadonlyArray<string> }) {
  const revoked: string[] = [];
  for (const rawId of args.sessionIds) {
    const sessionId = tx.db.normalizeId(coreTables.sessions, rawId);
    if (
      sessionId === null ||
      (yield* tx.db.get(coreTables.sessions, sessionId)) === null
    ) {
      continue;
    }
    yield* deleteSession(tx, sessionId);
    revoked.push(sessionId);
  }
  return revoked;
});
