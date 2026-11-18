import * as Schema from "effect/Schema";
import { defineTable, defineTables } from "../runtime/index.js";

// One row: whether this runtime admits sign-ups, and the revision every change
// raises. No row reads as the runtime's initial setting.
export const registrationTables = defineTables("registration", {
  policy: defineTable({
    enabled: Schema.Boolean,
    revision: Schema.Number,
  }),
});
