// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/component/schema.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: tables are declared through defineTables (T5): ids are strings, the module is named core.
import * as Schema from "effect/Schema";
import { type AuthTableRef, defineTable, defineTables } from "../runtime/index.js";

/** The row type of a table, as `Doc<"sessions">` is upstream. */
export type RowOf<T> = T extends AuthTableRef<infer Row> ? Row : never;

export const coreTables = defineTables("core", {
  // The IDs of the accounts that the core created or signed in, or that the
  // runtime marked as created (`markUserIdCreated`).
  createdUserIds: defineTable({
    userId: Schema.String,
  }).index("by_userId", ["userId"]),

  // One row per active session. Its refresh tokens live in `refreshTokens`.
  // A session expires once it goes `refreshInactivityTimeoutSeconds` without a
  // refresh, or at the latest `sessionMaxLifetimeSeconds` after its
  // `_creationTime`, under the values configured when it is checked.
  // The row is only written when the session is created or deleted, so a
  // request reading it (to check session liveness) does not contend with token
  // refreshes.
  sessions: defineTable({
    userId: Schema.String,
    // The name of the module that authenticated the user when the session was
    // created, for example `"password"`.
    component: Schema.String,
  }).index("by_user", ["userId"]),

  // Every refresh token a session has handed out and still remembers, by its
  // SHA-256 hash. The raw refresh token is never stored.
  //
  // A token's `state` is one of:
  //
  //  - `issued`: handed to a client, but not yet redeemed. Sign-in issues the
  //    session's first token, and each refresh issues another.
  //  - `redeemed`: presented once, so its holder evidently received it.
  //    Presenting it again issues another token and leaves it redeemed, which
  //    is what lets a client whose refresh response was lost (a device
  //    sleeping mid-request) retry with the token it still holds.
  //  - `spent`: a redeemed token, replaced when a later issued token was
  //    redeemed. Its holder has moved on.
  //  - `dropped`: an issued token discarded when a sibling was redeemed.
  //    Whoever holds it forked from the holder of the redeemed one.
  //
  // Presenting an issued token redeems it, spends the session's previous
  // redeemed token, and drops the other issued ones, so a session has at most
  // one redeemed token (none before its first refresh), and every issued token
  // descends from it. Presenting a spent or dropped token means the session's
  // holders have diverged, which revokes the session. Spent and dropped rows
  // are kept for `SPENT_TOKEN_HORIZON_MS` after `retiredAt`, then pruned.
  //
  // Each refresh inserts a row, so a session's freshness (when it last
  // refreshed) can be derived from the `_creationTime` of its newest row via
  // the `by_session_state` index; the session row itself stores no timestamp.
  //
  // A token stores no expiry: it expires `refreshInactivityTimeoutSeconds`
  // after its `_creationTime`, under the timeout configured when it is checked
  // (and with its session, at the session's max lifetime). A changed timeout
  // thus applies to every outstanding token, not just the ones issued after the
  // change.
  refreshTokens: defineTable({
    hash: Schema.String,
    sessionId: Schema.String,
    state: Schema.Literals(["issued", "redeemed", "spent", "dropped"]),
    // When the token became spent or dropped.
    retiredAt: Schema.optional(Schema.Number),
  })
    .index("by_hash", ["hash"])
    .index("by_session_state", ["sessionId", "state", "retiredAt"]),
});

export type Session = RowOf<typeof coreTables.sessions>;
export type RefreshToken = RowOf<typeof coreTables.refreshTokens>;
