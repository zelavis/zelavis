import * as Schema from "effect/Schema";
import { defineTable, defineTables } from "../runtime/index.js";

// One row once the first owner exists. A claim reads the table and inserts in
// one transaction; two concurrent claims both read it empty, and the commit's
// read-set check refuses the second, whose retry then finds the row.
export const bootstrapTables = defineTables("bootstrap", {
  claims: defineTable({
    accountId: Schema.String,
  }),
});
