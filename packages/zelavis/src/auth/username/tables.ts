// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/username/schema.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the table is declared through defineTables (T5): the module is named username.
import * as Schema from "effect/Schema";
import { defineTable, defineTables } from "../runtime/index.js";

export const usernameTables = defineTables("username", {
  // One row for each user that has a username. The module only sees an
  // opaque account `userId` string.
  usernames: defineTable({
    userId: Schema.String,
    // The username as the user supplied it. Applications show this value.
    username: Schema.String,
    // The username after normalization (see `normalizeUsername`). The
    // module compares usernames with this value, so that two usernames
    // that look the same to a user cannot both exist.
    usernameNormalized: Schema.String,
  })
    // A user has one username at most, and a username belongs to one user
    // at most. The module keeps both properties true: every call reads and
    // writes inside one transaction, whose commit re-checks what it read, so
    // two sign-ups for one username cannot both commit.
    .index("by_userId", ["userId"])
    .index("by_usernameNormalized", ["usernameNormalized"]),
});
