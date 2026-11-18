// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/server/userId.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the caller is the transaction's caller (T7) and the lookup is an Effect; the Convex component wiring and generic id typing are not carried.
import * as Effect from "effect/Effect";
import type { AuthTx } from "./context.js";
import { getSession } from "./public.js";

/**
 * The ID of the user the caller is signed in as, or `null` when the caller is
 * not signed in.
 *
 * Call it with a transaction's `tx`.
 *
 * ```ts
 * const userId = yield* getAuthUserId(tx);
 * if (userId === null) return null;
 * return yield* tx.db.get(accounts, userId);
 * ```
 *
 * The access token the client shares identifies a session, not a user: this
 * looks the session up, and returns `null` once it is gone (signed out,
 * revoked, or expired) even while the token itself is still valid.
 */
export const getAuthUserId = Effect.fn("auth.core.getAuthUserId")(function* (tx: AuthTx) {
  const identity = tx.caller;
  if (identity === undefined) {
    return null;
  }
  // The access token's subject is the session id, so the user is whoever the
  // session belongs to, for as long as the session exists.
  const session = yield* getSession(tx, { sessionId: identity.sessionId });
  return session === null ? null : session.userId;
});
