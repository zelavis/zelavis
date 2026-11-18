import * as Schema from "effect/Schema";
import { defineTable, defineTables } from "../runtime/index.js";

// Custom roles (Zelavis-own). `catalogue` is one row, the revision every role
// change raises (no row reads as revision 0); `roles` holds one row per role.
// A role's content is stored as a plain value and decoded by `catalogue.ts`,
// so a row that does not decode is skipped (it grants nothing) instead of
// failing every read of the table, authentication included.
export const rolesTables = defineTables("roles", {
  catalogue: defineTable({
    revision: Schema.Number,
  }),
  roles: defineTable({
    roleId: Schema.String,
    definition: Schema.Unknown,
  }).index("by_roleId", ["roleId"]),
});
