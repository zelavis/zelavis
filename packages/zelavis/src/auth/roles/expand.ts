/**
 * Role expansion (Zelavis-own): an account's authority is its own
 * permissions and grants plus what its role assignments give. A role gives
 * its permissions and grants; for each Project an assignment names, each of
 * the role's Project permissions as a grant scoped to that Project. An
 * assignment that names no Projects gets no Project grants from the role
 * (never "every Project"), and one whose role no longer exists gives nothing.
 *
 * Expansion runs when a principal is built, so editing or deleting a role
 * changes every member's authority without touching their accounts. It is
 * pure and bounded: at most 10 assignments of roles of at most 100 entries,
 * each for at most 20 Projects.
 */
import type { ZelavisPrincipalGrant } from "../../core/index.js";
import { accountGrantKey } from "../access/access.js";

export interface RoleContent {
  readonly permissions: ReadonlyArray<string>;
  readonly grants: ReadonlyArray<ZelavisPrincipalGrant>;
  readonly projectPermissions: ReadonlyArray<string>;
}

/** A runtime's roles by id, as expansion reads them. */
export type RoleCatalogue = ReadonlyMap<string, RoleContent>;

export const NO_ROLES: RoleCatalogue = new Map();

/** The most permissions and grants one account's direct access and assignments may expand to. */
export const ROLE_EXPANSION_LIMIT = 2000;

interface AssignedAccess {
  readonly permissions: ReadonlyArray<string>;
  readonly grants: ReadonlyArray<ZelavisPrincipalGrant>;
  readonly roleAssignments?: ReadonlyArray<{ readonly roleId: string; readonly projectIds?: ReadonlyArray<string> | undefined }> | undefined;
}

export interface ExpandedAccess {
  readonly permissions: ReadonlyArray<string>;
  readonly grants: ReadonlyArray<ZelavisPrincipalGrant>;
}

export function expandAccountAccess(account: AssignedAccess, roles: RoleCatalogue): ExpandedAccess {
  const assignments = account.roleAssignments ?? [];
  if (assignments.length === 0) {
    return { permissions: [...account.permissions], grants: account.grants.map((grant) => ({ ...grant })) };
  }
  const permissions = new Set(account.permissions);
  const grants = new Map(account.grants.map((grant) => [accountGrantKey(grant), { ...grant }]));
  const addGrant = (grant: ZelavisPrincipalGrant) => {
    const key = accountGrantKey(grant);
    if (!grants.has(key)) grants.set(key, grant);
  };
  for (const { roleId, projectIds } of assignments) {
    const role = roles.get(roleId);
    if (role === undefined) continue;
    for (const permission of role.permissions) permissions.add(permission);
    for (const grant of role.grants) addGrant({ permission: grant.permission, ...(grant.scope === undefined ? {} : { scope: { ...grant.scope } }) });
    for (const projectId of projectIds ?? []) {
      for (const permission of role.projectPermissions) addGrant({ permission, scope: { type: "project", projectId } });
    }
  }
  return { permissions: [...permissions], grants: [...grants.values()] };
}

/** How many permissions and grants `access` expands to at most, before deduplication. */
export function expansionSize(access: AssignedAccess, roles: RoleCatalogue): number {
  let size = access.permissions.length + access.grants.length;
  for (const { roleId, projectIds } of access.roleAssignments ?? []) {
    const role = roles.get(roleId);
    if (role !== undefined) size += role.permissions.length + role.grants.length + (projectIds?.length ?? 0) * role.projectPermissions.length;
  }
  return size;
}
