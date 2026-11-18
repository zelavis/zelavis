import * as Schema from "effect/Schema";
import { defineTable, defineTables } from "../runtime/index.js";

// A service account's bearer tokens, stored only as SHA-256 hashes (I5). The
// account itself is an `accounts_accounts` row of kind "service"; the Tenant it
// acts in is its `metadata.tenantId`, as in Identity.
export const serviceAccountTables = defineTables("serviceAccounts", {
  owners: defineTable({ serviceName: Schema.String, accountId: Schema.String }).index("by_serviceName", ["serviceName"]),
  tokens: defineTable({
    accountId: Schema.String,
    tokenHash: Schema.String,
    createdAt: Schema.Number,
    expiresAt: Schema.Number,
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_accountId", ["accountId"]),
});
