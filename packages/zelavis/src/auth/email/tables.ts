// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/email/schema.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the tables are declared through defineTables (T5): the module is named email.
import * as Schema from "effect/Schema";
import { defineTable, defineTables } from "../runtime/index.js";

export const emailTables = defineTables("email", {
  // One row for each verified email address.
  //
  // Invariants the component keeps true:
  // - An email address belongs to at most one user.
  // - A user with at least one email has exactly one primary email.
  verifiedEmails: defineTable({
    // The address with the case that the user gave. The app shows this value
    // to the end user.
    email: Schema.String,
    // The same address after normalization (see `normalizeEmail`). Lookups and
    // uniqueness checks use this field, not `email`.
    normalizedEmail: Schema.String,
    userId: Schema.String,
    // `true` for the user's primary address.
    // The primary address can be used by the app when it needs to email
    // a particular user (e.g. for security notifications).
    isPrimary: Schema.Boolean,
  })
    .index("by_normalizedEmail", ["normalizedEmail"])
    .index("by_userId", ["userId"])
    .index("by_userId_isPrimary", ["userId", "isPrimary"]),

  // One row for each challenge that has started and is not complete.
  challenges: defineTable({
    // The address under challenge, with the case that the user gave.
    email: Schema.String,
    // The kind of the challenge, i.e. the type of flow that caused it.
    // Different flows have different effects on completion.
    purpose: Schema.Union([
      // On completion, adds the verified email to `verifiedEmails` as the primary email address.
      // If there is already another primary email address, remove it.
      // Useful for apps that assume there is only a single email address per user.
      Schema.Struct({ kind: Schema.Literal("changeEmail"), userId: Schema.String }),
      // On completion, adds the verified email to `verifiedEmails`.
      // If there is already another primary email address, the new email address will be added as secondary.
      // Useful for apps that support multiple email addresses per user.
      Schema.Struct({ kind: Schema.Literal("addEmail"), userId: Schema.String }),
      // On completion, adds the verified email to `verifiedEmails` as the primary email address
      // of a user that a sign-up has just created (and fails if they already have an email address).
      // The user has no session yet, thus the completion takes the user from this row, not from the caller.
      Schema.Struct({ kind: Schema.Literal("signUp"), userId: Schema.String }),
      // Custom flow: doesn’t do anything in the component itself on completion,
      // the caller will implement the right behavior instead.
      Schema.Struct({
        kind: Schema.Literal("custom"),
        // The user that must own the address at completion. Absent when
        // `start` got `null`: then `complete` does not check the user.
        userId: Schema.optional(Schema.String),
        // Anonymous flows such as recovery can bind the mailbox to its owner without requiring a session.
        emailOwnerId: Schema.optional(Schema.String),
        // Opaque “purpose” string that is set by the code that creates the challnge
        // and must be identical on completion to avoid auth flow confusion.
        purpose: Schema.String,
      }),
    ]),
    // SHA-256 of the code that travels in the emailed link.
    // Storing the hash, so that even if database rows leak they can’t be used to complete the challenge.
    emailCodeHash: Schema.String,
    // SHA-256 of the secret that stays in the starting browser’s storage.
    // Completion finds the row by this hash, then requires the code too.
    // Storing the hash, so that even if database rows leak they can’t be used to complete the challenge.
    browserSecretHash: Schema.String,
    expiresAt: Schema.Number,
  })
    .index("by_browserSecretHash", ["browserSecretHash"])
    .index("by_purpose_userId", ["purpose.userId"])
    // For the cleanup sweep (see cleanup.ts).
    .index("by_expiresAt", ["expiresAt"]),
});
