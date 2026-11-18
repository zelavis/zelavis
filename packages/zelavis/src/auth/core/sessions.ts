// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/component/sessions.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: async handlers are Effects (T1), a session's tokens are removed by a sweep instead of a scheduled mutation (T6), and the invariant break dies (T8).
// Sessions and the lifecycle of their refresh tokens: issuing, redeeming,
// retiring, and erasing them. The public functions in public.ts build on these.

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type { TenantApi } from "../../db/database.js";
import { generateRefreshToken } from "./crypto.js";
import { sha256Hex } from "../lib/crypto.js";
import { sessionMaxLifetimeExpiresAt } from "./expiry.js";
import type { TtlConfig } from "../lib/ttl.js";
import { type AuthRuntime, type AuthSweep, type AuthTxBase, NO_REQUEST, SWEEP_BATCH, defineSweep, invariant } from "../runtime/index.js";
import type { AuthTx } from "./context.js";
import { type RefreshToken, type Session, coreTables } from "./tables.js";

// How many issued, never-presented refresh tokens a session may have. Each
// refresh presenting the redeemed token adds one, and the first issued token
// presented clears them all, so the count only climbs when responses are lost
// or refreshes race. A refresh with this many already issued revokes the
// session, unless the redeemed token was redeemed within `REFRESH_GRACE_MS`.
export const STANDARD_ISSUED_REFRESH_TOKEN_LIMIT = 3;
// How long after a token is redeemed it may be presented again without
// counting against `STANDARD_ISSUED_REFRESH_TOKEN_LIMIT`. Concurrent SSR
// requests carrying the same cookie each refresh on their own, and the first to
// land redeems the token the rest present.
export const REFRESH_GRACE_MS = 5 * 1000; // 5 seconds
// How long a spent or dropped refresh token hash is remembered. This is the
// reuse-detection horizon: past it the row is gone and a replayed token reads
// as unknown, which revokes nothing but also grants nothing.
export const SPENT_TOKEN_HORIZON_MS = 60 * 60 * 1000; // 1 hour
// An absolute cap on how many sessions a user may have. A sign-in that would
// exceed it first revokes the sessions that refreshed longest ago. This bounds
// everything that reads all of a user's sessions (`listSessions`, and revoking
// a user's other sessions), which a user whose sessions pile up (e.g. a script
// signing in over and over and not refreshing a prior session) could otherwise
// push past the transaction's limits.
export const MAX_SESSIONS_PER_USER = 100;

/** The account's session rows, bounded by the session cap. */
export const sessionsOfUser = (tx: AuthTxBase, userId: string, order: "asc" | "desc") =>
  tx.db.query(coreTables.sessions).withIndex("by_user", (q) => q.eq("userId", userId)).order(order).collect();

/** End every session of the account, optionally retaining the session that enrolled MFA. */
export const endAccountSessions = Effect.fn("auth.core.endAccountSessions")(function* (
  tx: AuthTxBase,
  userId: string,
  keepSessionId?: string,
) {
  for (const session of yield* sessionsOfUser(tx, userId, "asc")) {
    if (session._id !== keepSessionId) yield* tx.db.delete(coreTables.sessions, session._id);
  }
});

/** Look up a refresh token, in any state, by its hash. */
export function lookupRefreshTokenByHash(tx: AuthTx, hash: string) {
  return tx.db
    .query(coreTables.refreshTokens)
    .withIndex("by_hash", (q) => q.eq("hash", hash))
    .unique();
}

/** A session's refresh tokens in one state. */
export function sessionTokensInState(tx: AuthTx, sessionId: string, state: RefreshToken["state"]) {
  return tx.db
    .query(coreTables.refreshTokens)
    .withIndex("by_session_state", (q) => q.eq("sessionId", sessionId).eq("state", state))
    .collect();
}

/**
 * The session's newest issued refresh token: the one from its sign-in or its
 * latest refresh. It is the session's last token to go idle, thus the session
 * goes idle with it (unless its max lifetime ends it first).
 *
 * `null` only for a session with no issued token, which the token lifecycle
 * never leaves (sign-in and each refresh issue one).
 */
export const newestIssuedToken = (tx: AuthTx, sessionId: string) =>
  // Issued rows have no `retiredAt`, so the index orders them by
  // `_creationTime`: the last one is the newest.
  tx.db
    .query(coreTables.refreshTokens)
    .withIndex("by_session_state", (q) => q.eq("sessionId", sessionId).eq("state", "issued"))
    .order("desc")
    .first();

/**
 * Make room for one more session of the user: while the user has
 * `MAX_SESSIONS_PER_USER` sessions or more, erase the one that refreshed
 * longest ago.
 *
 * A session's last refresh is when its newest issued token was issued (see
 * `listSessions`), so an expired or abandoned session goes before one that a
 * client still keeps fresh, however old that one is.
 */
export const evictLeastRecentlyRefreshedSessions = Effect.fn("auth.core.evictLeastRecentlyRefreshedSessions")(function* (tx: AuthTx, userId: string) {
  // Reads every session of the user, which the cap keeps to
  // `MAX_SESSIONS_PER_USER`.
  const sessions = yield* sessionsOfUser(tx, userId, "asc");
  const excess = sessions.length - MAX_SESSIONS_PER_USER + 1;
  if (excess <= 0) {
    return;
  }
  const byLastRefresh = [];
  for (const session of sessions) {
    const newestIssued = yield* newestIssuedToken(tx, session._id);
    byLastRefresh.push({
      sessionId: session._id,
      // A session with no issued token can't refresh, so it goes first.
      lastRefreshedAt: newestIssued?._creationTime ?? -Infinity,
    });
  }
  // `sessions` is in creation order and the sort is stable, so of the
  // sessions that last refreshed at the same time, the oldest goes first.
  byLastRefresh.sort((a, b) => a.lastRefreshedAt - b.lastRefreshedAt);
  for (const { sessionId } of byLastRefresh.slice(0, excess)) {
    yield* deleteSession(tx, sessionId);
  }
  yield* Effect.logWarning(
    `Evicted ${excess} session${excess > 1 ? "s" : ""} past the ` +
      `${MAX_SESSIONS_PER_USER} session limit for a single user`,
  );
});

/**
 * Erase a session. Its refresh tokens are erased by the `core.orphanTokens`
 * sweep (see `orphanTokensSweep`).
 *
 * The session ends when its row is gone: `refresh` refuses a token whose
 * session is gone, thus no token can be added to it again. Its token rows only
 * linger until the sweep gets to them. That keeps this function at a few reads
 * and writes however many rows the session holds, so a mutation can erase many
 * sessions at once (e.g. revoking a user's other sessions on a password reset)
 * without exceeding the transaction's limits.
 *
 * Idempotent, because callers can race: two replays of the same stolen token,
 * or a sign-out arriving alongside one, can both resolve the same session.
 */
export const deleteSession = Effect.fn("auth.core.deleteSession")(function* (tx: AuthTx, sessionId: string) {
  // `delete` dies on an id that is already gone, and the session may have
  // been deleted by whoever we raced.
  if ((yield* tx.db.get(coreTables.sessions, sessionId)) === null) {
    return;
  }
  yield* tx.db.delete(coreTables.sessions, sessionId);
});

/**
 * Erase this session's spent and dropped tokens that are past the detection
 * horizon.
 *
 * Spent and dropped tokens are kept to detect illegitimate use of a refresh
 * token. Only a bounded set is kept for that purpose though, thus this code to
 * prune rows retired longer than `SPENT_TOKEN_HORIZON_MS` ago.
 *
 * Cleanup is triggered by redeeming an issued token, so a steadily refreshing
 * session keeps its own set trimmed with no background job to run or mount.
 */
export const pruneRetiredTokens = Effect.fn("auth.core.pruneRetiredTokens")(function* (tx: AuthTx, sessionId: string, now: number) {
  // A session that stops refreshing keeps its remaining rows until it is
  // deleted, since nothing rotates it any more; the `core.orphanTokens` sweep
  // erases them once the session is gone.
  for (const state of ["spent", "dropped"] as const) {
    const expired = yield* tx.db
      .query(coreTables.refreshTokens)
      .withIndex("by_session_state", (q) =>
        q
          .eq("sessionId", sessionId)
          .eq("state", state)
          .lte("retiredAt", now - SPENT_TOKEN_HORIZON_MS),
      )
      .collect();
    for (const row of expired) {
      yield* tx.db.delete(coreTables.refreshTokens, row._id);
    }
  }
});

/**
 * Issue a new refresh token for a session.
 *
 * Returns the raw token, and stores its hash for later lookup. The returned
 * `expiresAt` is the sooner of the token's inactivity expiry and the session's
 * max lifetime, and holds under the current config; a later change to either
 * moves it. The inactivity expiry is computed from `now` rather than the row's
 * `_creationTime`, so it can differ from what `refresh` enforces by a fraction
 * of a millisecond.
 */
export const issueRefreshToken = Effect.fn("auth.core.issueRefreshToken")(function* (
  tx: AuthTx,
  session: Pick<Session, "_id" | "_creationTime">,
  now: number,
  ttl: TtlConfig,
) {
  const refreshToken = generateRefreshToken();
  yield* tx.db.insert(coreTables.refreshTokens, {
    hash: yield* sha256Hex(refreshToken),
    sessionId: session._id,
    state: "issued",
  });
  return {
    refreshToken,
    expiresAt: Math.min(
      now + ttl.refreshInactivityTimeoutSeconds * 1000,
      sessionMaxLifetimeExpiresAt(session, ttl.sessionMaxLifetimeSeconds),
    ),
  };
});

/**
 * Redeem an issued token, the first time it is presented.
 *
 * Its holder has evidently received it, so the session's previously redeemed
 * token is marked as spent and the other issued tokens, which nobody should
 * ever present, are marked as dropped.
 */
export const redeem = Effect.fn("auth.core.redeem")(function* (tx: AuthTx, token: RefreshToken, now: number) {
  const redeemed = yield* sessionTokensInState(tx, token.sessionId, "redeemed");
  if (redeemed.length > 1) {
    return yield* invariant("Invariant violation: a session has more than one redeemed refresh token");
  }
  // There will be 0 or 1 tokens in the `redeemed`` state.
  for (const row of redeemed) {
    yield* tx.db.patch(coreTables.refreshTokens, row._id, {
      state: "spent",
      retiredAt: now,
    });
  }
  for (const row of yield* sessionTokensInState(tx, token.sessionId, "issued")) {
    if (row._id === token._id) continue;
    yield* tx.db.patch(coreTables.refreshTokens, row._id, {
      state: "dropped",
      retiredAt: now,
    });
  }
  yield* tx.db.patch(coreTables.refreshTokens, token._id, { state: "redeemed" });

  // Remove any spent and dropped tokens past the `SPENT_TOKEN_HORIZON_MS`.
  yield* pruneRetiredTokens(tx, token.sessionId, now);
});

// How many rows one page of the orphan sweep reads, and how many pages a run
// reads at most; a run removes at most `SWEEP_BATCH` rows.
const ORPHAN_PAGE = 200;
const ORPHAN_PAGES = 25;

/**
 * The sweep that stands in for upstream's scheduled `deleteSessionTokens`:
 * erases refresh tokens whose session is gone.
 *
 * It walks `refreshTokens` in creation order from a cursor it keeps (in
 * memory: a new process starts again from the beginning, which only repeats
 * reads), and always moves the cursor on. A row it cannot open is skipped with
 * a warning naming only its collection and id. A session that is gone never
 * comes back, so reading outside a transaction is safe; the removal re-checks
 * inside one.
 */
export function createOrphanTokensSweep(tenant: TenantApi): AuthSweep<AuthRuntime> {
  const collection = coreTables.refreshTokens.collection;
  let cursor = 0;
  const skipped = (id: string) => (cause: Cause.Cause<unknown>) =>
    Effect.as(Effect.logWarning(`Auth sweep core.orphanTokens skipped ${collection} row ${id}.`, cause), false);
  return defineSweep({
    name: "core.orphanTokens",
    everyMs: 10 * 60_000,
    run: (runtime) => Effect.gen(function* () {
      let removed = 0;
      for (let page = 0; page < ORPHAN_PAGES && removed < SWEEP_BATCH; page += 1) {
        const documents = yield* tenant.documents.findMany({
          collection,
          where: [{ path: "_creationTime", op: "gt", value: cursor }],
          orderBy: [{ path: "_creationTime", direction: "asc" }],
          limit: ORPHAN_PAGE,
        }).pipe(Effect.orDie);
        if (documents.length === 0) {
          cursor = 0;
          break;
        }
        for (const document of documents) {
          const created = document.data._creationTime;
          if (typeof created === "number") cursor = Math.max(cursor, created);
          const sessionId = document.data.sessionId;
          if (typeof sessionId !== "string") {
            yield* Effect.logWarning(`Auth sweep core.orphanTokens skipped ${collection} row ${document.id}.`);
            continue;
          }
          if (removed >= SWEEP_BATCH) break;
          const orphan = yield* runtime.mutation(NO_REQUEST, (tx) => Effect.gen(function* () {
            if ((yield* tx.db.get(coreTables.sessions, sessionId)) !== null) return false;
            yield* tx.db.delete(coreTables.refreshTokens, document.id);
            return true;
          })).pipe(Effect.catchCauseIf((cause) => !Cause.hasInterrupts(cause), skipped(document.id)));
          if (orphan) removed += 1;
        }
        if (documents.length < ORPHAN_PAGE) {
          cursor = 0;
          break;
        }
      }
      return removed;
    }),
  });
}
