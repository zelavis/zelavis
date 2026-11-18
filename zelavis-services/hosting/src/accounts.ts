import { Effect, Schema } from "effect";
import type { ZelavisPrincipal } from "zelavis/core";
import { GrantSchema, RoleAssignmentSchema } from "zelavis/auth";
import { hostingError, platformFailure, platformJson, revisionConflict, type Platform } from "./runtime.js";

export const human = (principal: ZelavisPrincipal | undefined) => principal?.type === "user"
  ? Effect.succeed(principal.id)
  : Effect.fail(hostingError(403, "human_account_required", "A human account is required."));

const readAccounts = Schema.decodeUnknownSync(Schema.Struct({
  accounts: Schema.Array(Schema.Struct({
    id: Schema.String, kind: Schema.String, email: Schema.optional(Schema.String),
    roles: Schema.Array(Schema.String), accessRevision: Schema.Natural,
    permissions: Schema.Array(Schema.String), grants: Schema.Array(GrantSchema),
    roleAssignments: Schema.Array(RoleAssignmentSchema),
  })).check(Schema.isMaxLength(1)),
}));

export const accountAccess = (platform: Platform) => {
  const read = Effect.fn(function* (principalId: string) {
    const result = yield* platform("GET", `/auth/accounts?accountId=${encodeURIComponent(principalId)}`);
    const { accounts } = yield* platformJson(result, readAccounts);
    const account = accounts[0];
    if (!account || account.id !== principalId || account.kind !== "human") {
      return yield* hostingError(404, "hosting_account_not_found", "The hosting account is unavailable.");
    }
    return account;
  });

  const assign = Effect.fn(function* (principalId: string, roleId: string | undefined, projectIds: readonly string[], managedRoles: readonly string[]) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const account = yield* read(principalId);
      const kept = account.roleAssignments.filter(role => !managedRoles.includes(role.roleId));
      const current = account.roleAssignments.filter(role => managedRoles.includes(role.roleId));
      const wanted = roleId && projectIds.length ? { roleId, projectIds: [...projectIds].sort() } : undefined;
      if (!current.length && !wanted || current.length === 1 && wanted &&
          current[0]?.roleId === wanted.roleId && JSON.stringify(current[0].projectIds) === JSON.stringify(wanted.projectIds)) return;
      const response = yield* platform("PUT", `/auth/accounts/${encodeURIComponent(principalId)}/access`, {
        expectedRevision: account.accessRevision, role: account.roles[0],
        permissions: account.permissions, grants: account.grants,
        roleAssignments: wanted ? [...kept, wanted] : kept,
      });
      if (response.ok) return;
      if (response.status !== 409) return yield* platformFailure(response.status);
    }
    return yield* revisionConflict();
  });

  const billingEmail = Effect.fn(function* (principalId: string) {
    const account = yield* read(principalId);
    if (account.roles.length !== 1 || account.roles[0] !== "customer") {
      return yield* hostingError(403, "hosting_customer_required", "Use a customer account to subscribe to hosting.");
    }
    if (!account.email) return yield* hostingError(400, "hosting_email_required", "Add a verified email to your account before subscribing.");
    // A no-op revision-checked edit proves Auth will allow the service to manage this account.
    const response = yield* platform("PUT", `/auth/accounts/${encodeURIComponent(principalId)}/access`, {
      expectedRevision: account.accessRevision, role: "customer",
      permissions: account.permissions, grants: account.grants, roleAssignments: account.roleAssignments,
    });
    if (!response.ok) return yield* platformFailure(response.status);
    return account.email;
  });

  return { assign, billingEmail };
};
