import * as Schema from "effect/Schema";
import { defineTable, defineTables } from "../runtime/index.js";

/** What an event may say beyond its kind: short facts, never a secret, a raw identifier or an address. */
export const SecurityDetailSchema = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean]));

// Security events: what happened to whom, recorded in the transaction of the
// action itself, so an event exists exactly when its action committed.
export const securityTables = defineTables("security", {
  events: defineTable({
    at: Schema.Number,
    kind: Schema.String,
    // SHA-256 of `<method>\0<identifier>`: which subject was tried, without naming it.
    subjectHash: Schema.optional(Schema.String),
    accountId: Schema.optional(Schema.String),
    actorId: Schema.optional(Schema.String),
    detail: SecurityDetailSchema,
  }).index("by_at", ["at"]),
});
