import * as Schema from "effect/Schema";
import { defineTable, defineTables } from "../runtime/index.js";
import type { RowOf } from "../core/tables.js";

const AccessScopeSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("system") }),
  Schema.Struct({ type: Schema.Literal("project"), projectId: Schema.optional(Schema.String), projectIdParam: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("service"), serviceName: Schema.optional(Schema.String), serviceNameParam: Schema.optional(Schema.String) }),
]);

export const GrantSchema = Schema.Struct({
  permission: Schema.String,
  scope: Schema.optional(AccessScopeSchema),
});

// The accounts module is Zelavis's "users table": the rows that sessions
// belong to, carrying the roles, permissions and grants of the one principal
// model (`AGENTS.md § Core Access-Control Rule`). Sign-in identifiers (email,
// username, passkeys, OAuth connections) belong to their own modules, which
// keep upstream's uniqueness rules.
export const accountsTables = defineTables("accounts", {
  accounts: defineTable({
    kind: Schema.Literals(["human", "service"]),
    displayName: Schema.optional(Schema.String),
    roles: Schema.Array(Schema.String),
    permissions: Schema.Array(Schema.String),
    grants: Schema.Array(GrantSchema),
    // Custom roles (`../roles`) the account holds, each for the Projects named; expanded at authentication. Absent is none.
    roleAssignments: Schema.optional(Schema.Array(Schema.Struct({
      roleId: Schema.String,
      projectIds: Schema.optional(Schema.Array(Schema.String)),
    }))),
    // Rises with every change to roles, permissions, grants or role assignments.
    accessRevision: Schema.Number,
    // Invalidates in-flight authentication proofs after credential changes.
    proofRevision: Schema.optional(Schema.Number),
    metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    lastSignInAt: Schema.optional(Schema.Number),
  }).index("by_kind", ["kind"]),
});

export type Account = RowOf<typeof accountsTables.accounts>;
