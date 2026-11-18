// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/google/schema.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: tables are declared through defineTables (T5); the module is named google and keeps only its accounts: authorization requests and tickets are the shared `oauth_` tables.
import { defineTables } from "../runtime/index.js";
import { accountsTable } from "../lib/oauth/schema.js";

export const googleTables = defineTables("google", {
  accounts: accountsTable,
});
