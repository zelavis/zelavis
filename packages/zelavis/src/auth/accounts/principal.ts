import type { ZelavisPrincipal } from "../../core/index.js";
import { NO_ROLES, type RoleCatalogue, expandAccountAccess } from "../roles/expand.js";
import type { Account } from "./tables.js";

/**
 * The principal an account's session stands for: the one model every runtime
 * enforces (`zelavis/core`). In the Platform an account's permissions are
 * runtime-wide; in a Project (`projectId` given) they become grants scoped to
 * that Project and the principal holds no runtime-wide permission. Ported from
 * Identity's `accountSessionPrincipal`; the account's role assignments are
 * expanded first, against `roles` (`../roles/expand.ts`).
 */
export function accountSessionPrincipal(
  account: Pick<Account, "_id" | "kind" | "roles" | "permissions" | "grants" | "metadata" | "roleAssignments">,
  sessionId: string,
  transport: "bearer" | "cookie",
  projectId?: string,
  roles: RoleCatalogue = NO_ROLES,
): ZelavisPrincipal {
  const expanded = expandAccountAccess(account, roles);
  const accountPermissions = expanded.permissions;
  return {
    id: account._id,
    type: account.kind === "service" ? "service" : "user",
    roles: [...account.roles],
    permissions: projectId ? undefined : [...accountPermissions],
    grants: [
      ...expanded.grants,
      ...(projectId
        ? accountPermissions.map((permission) => ({
            permission,
            scope: { type: "project" as const, projectId },
          }))
        : []),
    ],
    metadata: {
      ...(account.metadata ?? {}),
      sessionId,
      authenticationTransport: transport,
      ...(projectId ? { projectId } : {}),
    },
  };
}
