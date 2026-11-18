/**
 * Account access (Zelavis-own, moved from Identity's `domain/account-access.ts`):
 * the input and result of an access edit, its bounds, and the Project
 * delegation proof the Gateway binds to a forwarded principal.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { encode as encodeHex } from "effect/encoding/Hex";
import type { ZelavisAccessScope, ZelavisPrincipal, ZelavisPrincipalGrant } from "../../core/index.js";
import { integration } from "../../core/runtime/effect-boundary.js";

export const ACCOUNT_ACCESS_LIMIT = 100;
export const ACCOUNT_ACCESS_BODY_BYTES = 32 * 1024;

export const PermissionSchema = Schema.String.check(
  Schema.isBetweenLength(1, 128),
  Schema.isPattern(/^[a-z][a-z0-9.\-:/]*$/u),
);
export const ProjectIdSchema = Schema.String.check(
  Schema.isBetweenLength(1, 128),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
);
const ServiceNameSchema = Schema.String.check(
  Schema.isBetweenLength(1, 128),
  Schema.isPattern(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u),
);
const RoleSchema = Schema.Literals(["customer", "operator", "reseller", "user"]);
const ScopeSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("system") }),
  Schema.Struct({ type: Schema.Literal("project"), projectId: ProjectIdSchema }),
  Schema.Struct({ type: Schema.Literal("service"), serviceName: ServiceNameSchema }),
]);
export const GrantSchema = Schema.Struct({
  permission: PermissionSchema,
  scope: ScopeSchema,
});

/** Custom roles (`../roles`): ids, and how many an account may hold. */
export const ROLE_ASSIGNMENT_LIMIT = 10;
export const ROLE_ASSIGNMENT_PROJECT_LIMIT = 20;
/** Built-in role labels and the protected roles: never a custom role's id. */
export const RESERVED_ROLE_IDS: ReadonlySet<string> = new Set(["customer", "operator", "reseller", "user", "owner", "service", "system"]);
export const RoleIdSchema = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,47}$/u));
export const RoleAssignmentSchema = Schema.Struct({
  roleId: RoleIdSchema,
  projectIds: Schema.optional(Schema.Array(ProjectIdSchema).check(Schema.isMaxLength(ROLE_ASSIGNMENT_PROJECT_LIMIT))),
});
export type RoleAssignment = typeof RoleAssignmentSchema.Type;
const RoleAssignmentsSchema = Schema.Array(RoleAssignmentSchema).check(
  Schema.isMaxLength(ROLE_ASSIGNMENT_LIMIT),
  Schema.makeFilter((assignments: ReadonlyArray<RoleAssignment>) =>
    new Set(assignments.map(({ roleId }) => roleId)).size === assignments.length || "A role may be assigned once."),
);

const delegatedAccessFields = {
  role: RoleSchema,
  permissions: Schema.Array(PermissionSchema).check(Schema.isMaxLength(ACCOUNT_ACCESS_LIMIT)),
  grants: Schema.Array(GrantSchema).check(Schema.isMaxLength(ACCOUNT_ACCESS_LIMIT)),
  roleAssignments: RoleAssignmentsSchema,
};
const accessLimit = Schema.makeFilter(({ permissions, grants }: { permissions: readonly unknown[]; grants: readonly unknown[] }) =>
  permissions.length + grants.length <= ACCOUNT_ACCESS_LIMIT ||
    `Access may contain at most ${ACCOUNT_ACCESS_LIMIT} permissions and grants combined.`,
);
export const DelegatedAccessSchema = Schema.Struct(delegatedAccessFields).check(accessLimit);
export const SetAccountAccessInputSchema = Schema.Struct({ expectedRevision: Schema.Natural, ...delegatedAccessFields }).check(accessLimit);
const AccountAccessResultSchema = Schema.Struct({
  accountId: Schema.String,
  accessRevision: Schema.Natural,
  role: RoleSchema,
  permissions: SetAccountAccessInputSchema.fields.permissions,
  grants: SetAccountAccessInputSchema.fields.grants,
  roleAssignments: SetAccountAccessInputSchema.fields.roleAssignments,
});

export type HumanAccountRole = typeof RoleSchema.Type;
export type ConcreteAccountGrant = typeof GrantSchema.Type;
export type DelegatedAccess = typeof DelegatedAccessSchema.Type;
export type SetAccountAccessInput = typeof SetAccountAccessInputSchema.Type;
export type AccountAccessResult = typeof AccountAccessResultSchema.Type;

const strict = { onExcessProperty: "error" } as const;
export const decodeSetAccountAccessInput = Schema.decodeUnknownSync(SetAccountAccessInputSchema, strict);
export const accountAccessInputJsonSchema = Schema.toJsonSchemaDocument(SetAccountAccessInputSchema, strict).schema;
export const accountAccessResultJsonSchema = Schema.toJsonSchemaDocument(AccountAccessResultSchema, strict).schema;
const isAccountAccessPermission = Schema.is(PermissionSchema);

const StoredPermissionSchema = Schema.Union([PermissionSchema, Schema.Literal("*")]);
const ProjectAccountAuthoritySchema = Schema.Struct({
  id: Schema.String,
  accessRevision: Schema.Natural,
  permissions: Schema.optional(Schema.Array(StoredPermissionSchema).check(Schema.isMaxLength(ACCOUNT_ACCESS_LIMIT))),
  grants: Schema.optional(Schema.Array(Schema.Struct({
    permission: StoredPermissionSchema,
    scope: ScopeSchema,
  })).check(Schema.isMaxLength(ACCOUNT_ACCESS_LIMIT))),
  roleAssignments: Schema.optional(Schema.Array(RoleAssignmentSchema).check(Schema.isMaxLength(ROLE_ASSIGNMENT_LIMIT))),
});
export const decodeProjectAccountAuthority = Schema.decodeUnknownSync(Schema.Array(ProjectAccountAuthoritySchema)
  .check(Schema.isMaxLength(1)));

const projectAccessProofs = new WeakMap<ZelavisPrincipal, { readonly digest?: string }>();
export const bindProjectAccountAccessProof = (principal: ZelavisPrincipal, digest?: string): void => {
  projectAccessProofs.set(principal, { digest });
};
export const projectAccountAccessProof = (principal: ZelavisPrincipal) =>
  projectAccessProofs.get(principal);

/**
 * The permission names an App access edit hands out or takes away: the
 * account's current authority, the new grants, and the permissions of every
 * role either assigns (`roles`: the App's catalogue, role id to its
 * permissions; a role it lacks contributes nothing).
 */
export function projectAccountAccessPermissions(
  projectId: string,
  current: { readonly permissions?: readonly string[]; readonly grants?: readonly ZelavisPrincipalGrant[]; readonly roleAssignments?: readonly RoleAssignment[] },
  input: SetAccountAccessInput,
  roles: ReadonlyMap<string, { readonly permissions: readonly string[] }> = new Map(),
): readonly string[] | undefined {
  const permissions = [...(current.permissions ?? []), ...input.grants.map(({ permission }) => permission)];
  for (const { roleId } of [...(current.roleAssignments ?? []), ...input.roleAssignments]) {
    permissions.push(...(roles.get(roleId)?.permissions ?? []));
  }
  for (const { permission, scope } of current.grants ?? []) {
    if (scope?.type !== "project" || scope.projectId !== projectId || scope.projectIdParam !== undefined) return undefined;
    permissions.push(permission);
  }
  // Existing account creation bounds permissions and grants separately.
  return permissions.length <= ACCOUNT_ACCESS_LIMIT * (3 + 2 * ROLE_ASSIGNMENT_LIMIT) && permissions.every((permission) => permission === "*" || isAccountAccessPermission(permission))
    ? [...new Set(permissions)].sort()
    : undefined;
}

/** The Gateway signs the exact permission set without placing the current and requested names in request headers. */
export function projectAccountAccessDigest(accountId: string, input: SetAccountAccessInput, permissions: readonly string[]) {
  const bytes = new TextEncoder().encode(JSON.stringify([accountId, normalizeAccountAccess(input), permissions]));
  return integration(() => crypto.subtle.digest("SHA-256", bytes)).pipe(
    Effect.map((digest) => encodeHex(new Uint8Array(digest))),
  );
}

export function isConcreteScope(scope: ZelavisAccessScope): boolean {
  switch (scope.type) {
    case "system": return true;
    case "project": return !!scope.projectId && scope.projectIdParam === undefined;
    case "service": return !!scope.serviceName && scope.serviceNameParam === undefined;
  }
}

export function accountGrantKey({ permission, scope }: ZelavisPrincipalGrant): string {
  return JSON.stringify([
    permission,
    scope?.type,
    scope?.type === "project" ? scope.projectId : scope?.type === "service" ? scope.serviceName : undefined,
  ]);
}

export function normalizeAccountAccess(input: SetAccountAccessInput): SetAccountAccessInput {
  return { expectedRevision: input.expectedRevision, ...normalizeDelegatedAccess(input) };
}

export function normalizeDelegatedAccess(input: DelegatedAccess): DelegatedAccess {
  const grants = new Map(input.grants.map((grant) => [
    accountGrantKey(grant),
    { permission: grant.permission, scope: { ...grant.scope } },
  ]));
  return {
    role: input.role,
    permissions: [...new Set(input.permissions)].sort(),
    grants: [...grants.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([, grant]) => grant),
    roleAssignments: normalizeRoleAssignments(input.roleAssignments),
  };
}

/** Assignments in role order, each one's Projects sorted once; no Projects reads as none. */
export function normalizeRoleAssignments(assignments: ReadonlyArray<RoleAssignment>): ReadonlyArray<RoleAssignment> {
  return [...assignments]
    .sort((left, right) => left.roleId < right.roleId ? -1 : left.roleId > right.roleId ? 1 : 0)
    .map(({ roleId, projectIds }) => {
      const projects = [...new Set(projectIds ?? [])].sort();
      return projects.length === 0 ? { roleId } : { roleId, projectIds: projects };
    });
}
