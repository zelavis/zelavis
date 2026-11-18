// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/username/public.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: mutations and queries are Effects over an AuthTx (T1-T4).
import * as Effect from "effect/Effect";
import type { TransactionTooLarge } from "../../db/errors.js";
import type { AuthTx } from "../core/context.js";
import type { AuthTxBase } from "../runtime/index.js";
import type { RowOf } from "../core/tables.js";
import { usernameTables } from "./tables.js";
import {
  normalizeUsername,
  type SetUsernameUserError,
  validateUsernameFormat,
} from "./validation.js";

export type SetUsernameResult =
  | {
      success: true;
      // The username that this user had before this call, or `null` when the
      // user had no username.
      previousUsername: string | null;
    }
  | { success: false; userError: SetUsernameUserError };

/**
 * Set the username of a user.
 *
 * This function can be used:
 * - to give a username to a new user
 * - to change the username of an existing user (a user has one username at most,
 *   thus a new username replaces the previous one)
 *
 * The function first makes sure that no other user has this username. If a
 * different user has it, the function returns a `USERNAME_TAKEN` user
 * error and changes nothing. When the same user already has this username
 * (possibly with a different case), the function keeps the new spelling
 * and is otherwise a no-op.
 */
export const setUsername = Effect.fn("auth.username.setUsername")(function* (
  tx: AuthTx,
  { userId, username }: { userId: string; username: string },
) {
  const userError = validateUsernameFormat(username);
  if (userError !== null) {
    return { success: false, userError } satisfies SetUsernameResult;
  }

  const usernameNormalized = normalizeUsername(username);
  const conflict = yield* rowByNormalizedUsername(tx, usernameNormalized);
  if (conflict !== null && conflict.userId !== userId) {
    return { success: false, userError: { error: "USERNAME_TAKEN" } } satisfies SetUsernameResult;
  }

  const existing = yield* rowByUserId(tx, userId);
  if (existing !== null) {
    yield* tx.db.patch(usernameTables.usernames, existing._id, {
      username,
      usernameNormalized,
    });
    return { success: true, previousUsername: existing.username } satisfies SetUsernameResult;
  }
  yield* tx.db.insert(usernameTables.usernames, {
    userId,
    username,
    usernameNormalized,
  });
  return { success: true, previousUsername: null } satisfies SetUsernameResult;
});

/**
 * Find the user that a username identifies.
 *
 * The lookup ignores the case and the Unicode normalization form of the
 * `username` argument. The function returns `null` when no user has this
 * username.
 */
export const getUserIdByUsername = Effect.fn("auth.username.getUserIdByUsername")(function* (
  tx: AuthTx,
  { username }: { username: string },
) {
  // Imported Identity usernames predate the new-enrollment length rule.
  if (username.length > 1024) return null;
  const row = yield* rowByNormalizedUsername(tx, normalizeUsername(username));
  return row === null ? null : row.userId;
});

/**
 * Get the username of a user, as the user supplied it.
 *
 * The function returns `null` when the user has no username.
 */
export const getUsername = Effect.fn("auth.username.getUsername")(function* (
  tx: AuthTxBase,
  { userId }: { userId: string },
) {
  const row = yield* rowByUserId(tx, userId);
  return row === null ? null : row.username;
});

/**
 * Delete the username of a user.
 *
 * The function is idempotent: `deleted` is `false` when the user had no
 * username. A user with no username can no longer be found with
 * `getUserIdByUsername`, and the username becomes available again.
 */
export const deleteUsername = Effect.fn("auth.username.deleteUsername")(function* (
  tx: AuthTx,
  { userId }: { userId: string },
) {
  const row = yield* rowByUserId(tx, userId);
  if (row === null) {
    return { deleted: false };
  }
  yield* tx.db.delete(usernameTables.usernames, row._id);
  return { deleted: true };
});

function rowByUserId(tx: AuthTxBase, userId: string) {
  return tx.db
    .query(usernameTables.usernames)
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
}

function rowByNormalizedUsername(
  tx: AuthTx,
  usernameNormalized: string,
): Effect.Effect<Row | null, TransactionTooLarge> {
  return tx.db
    .query(usernameTables.usernames)
    .withIndex("by_usernameNormalized", (q) =>
      q.eq("usernameNormalized", usernameNormalized),
    )
    .unique();
}

type Row = RowOf<typeof usernameTables.usernames>;
