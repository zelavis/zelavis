import * as Schema from "effect/Schema";
import { defineTable, defineTables } from "../runtime/index.js";

export const importTables = defineTables("import", {
  state: defineTable({
    status: Schema.Literals(["resetting", "running", "done"]),
    phase: Schema.Literals(["connections", "accounts", "credentials", "sessions", "qualify"]),
    after: Schema.optional(Schema.String),
    imported: Schema.Natural,
    skipped: Schema.Natural,
    unprovenLinks: Schema.Natural,
    bootstrapComplete: Schema.Boolean,
    /** The source's fingerprint when this import began; a different one later means the prior engine wrote again. */
    sourceFingerprint: Schema.String,
    owner: Schema.optional(Schema.Struct({
      accountId: Schema.String,
      createdAt: Schema.Number,
      bootstrapSession: Schema.Boolean,
    })),
  }),
  principals: defineTable({
    accountId: Schema.String,
    oauth: Schema.optional(Schema.Boolean),
    needsRelink: Schema.optional(Schema.Boolean),
    sessionEpoch: Schema.optional(Schema.Natural),
  }).index("by_accountId", ["accountId"]),
});
