// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/password/schema.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the table is declared through defineTables (T5): the module is named password.
import * as Schema from "effect/Schema";
import { defineTable, defineTables } from "../runtime/index.js";

export const passwordTables = defineTables("password", {
  passwords: defineTable({
    userId: Schema.String,
    passwordHashPHC: Schema.String, // format: https://github.com/C2SP/C2SP/blob/main/phc-strings.md
    imported: Schema.optional(Schema.Boolean),
  }).index("by_userId", ["userId"]),
});
