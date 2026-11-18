/**
 * Delegation (Zelavis-own, moved from Identity's `services/account-service.ts`):
 * who may administer an account, and the access edit itself.
 *
 * An administrator can hand out only what they hold: a role they have (or
 * `customer`/`user`, which anyone managing users may give), a runtime-wide
 * permission they hold, a grant whose permission they hold in that scope. The
 * same rule decides who may manage an account at all: everything the target
 * already holds must be something the actor could have given it, so an
 * operator cannot touch the owner. The rules are Identity's, unchanged; what
 * changed is where they run: inside the transaction that writes, against the
 * actor's account as that transaction reads it, so an administrator whose
 * authority was revoked a moment ago is refused even by an edit queued
 * before the revocation. Identity's admission semaphores and session epochs
 * are not carried: the transaction is the serialization.
 */
import * as Effect from "effect/Effect";
import type { ZelavisAccessScope, ZelavisPrincipal } from "../../core/index.js";
import { principalHasPermission } from "../../core/runtime/request-dispatcher.js";
import type { TransactionTooLarge } from "../../db/errors.js";
import { accountSessionPrincipal } from "../accounts/principal.js";
import { type Account, accountsTables } from "../accounts/tables.js";
import { endAccountSessions } from "../core/sessions.js";
import { coreTables } from "../core/tables.js";
import type { AuthTxBase } from "../runtime/index.js";
import { readRoleCatalogue } from "../roles/catalogue.js";
import { NO_ROLES, ROLE_EXPANSION_LIMIT, type RoleCatalogue, expandAccountAccess, expansionSize } from "../roles/expand.js";
import { recordSecurityEvent } from "../security/events.js";
import { serviceAccountTables } from "../serviceAccounts/tables.js";
import { type AccountAccessResult, type DelegatedAccess, type SetAccountAccessInput, accountGrantKey, isConcreteScope } from "./access.js";

/** Whose accounts a runtime administers: the Platform's, or one Project's. */
export interface AdministrationContext {
  readonly authority: "platform" | "project";
  /** The Project an App runtime belongs to. */
  readonly projectId?: string | undefined;
}

export type AdministrationRefusalCode =
  | "account_access_forbidden"
  | "account_not_found"
  | "account_access_conflict"
  | "role_not_found"
  | "role_expansion_limit";

export interface AdministrationRefusal {
  readonly ok: false;
  readonly code: AdministrationRefusalCode;
}

export const refuse = (code: AdministrationRefusalCode): AdministrationRefusal => ({ ok: false, code });

export type AccountAuthority = {
  readonly roles?: ReadonlyArray<string> | undefined;
  readonly permissions?: ReadonlyArray<string> | undefined;
  readonly grants?: ReadonlyArray<{ readonly permission: string; readonly scope?: ZelavisAccessScope | undefined }> | undefined;
};

/** Roles no access edit gives or takes. */
const PROTECTED_ROLES = new Set(["owner", "service", "system"]);

export const managePermission = (context: AdministrationContext): string =>
  context.authority === "platform" ? "system.users.manage" : "project.users.manage";

export const manageScope = (context: AdministrationContext): ZelavisAccessScope | undefined =>
  context.authority === "platform" ? { type: "system" }
    : context.projectId === undefined ? undefined : { type: "project", projectId: context.projectId };

export function canDelegateRole(actor: ZelavisPrincipal, role: string): boolean {
  return role === "customer" || role === "user" ||
    actor.permissions?.includes("*") === true || actor.roles?.includes(role) === true;
}

/** Whether `actor` could have given `access`; scope rules are request dispatch's. */
export function canDelegateAccess(
  actor: ZelavisPrincipal,
  context: AdministrationContext,
  access: AccountAuthority,
  provedProjectPermissions?: ReadonlyArray<string>,
): boolean {
  const projectScope = context.authority === "project" && context.projectId
    ? { type: "project" as const, projectId: context.projectId }
    : undefined;
  if (context.authority === "project" && !projectScope && (access.grants?.length ?? 0) > 0) return false;
  for (const role of access.roles ?? []) {
    if (!canDelegateRole(actor, role)) return false;
  }
  for (const permission of access.permissions ?? []) {
    if (context.authority === "platform") {
      if (!actor.permissions?.includes(permission) && !actor.permissions?.includes("*")) return false;
    } else if (!(provedProjectPermissions?.includes(permission) ?? principalHasPermission(actor, permission, projectScope))) {
      return false;
    }
  }
  for (const { permission, scope } of access.grants ?? []) {
    if ((scope && !isConcreteScope(scope)) ||
        (projectScope && (scope?.type !== "project" || scope.projectId !== projectScope.projectId)) ||
        !(provedProjectPermissions?.includes(permission) ?? principalHasPermission(actor, permission, scope))) {
      return false;
    }
  }
  return true;
}

/**
 * Whether an edit's input fits the runtime: a Project gives only `user` with
 * grants on itself, and its role assignments name no Projects (the App's own
 * is implicit); the Platform never gives `user`.
 */
export function accessInputFits(context: AdministrationContext, input: DelegatedAccess): boolean {
  if (context.authority === "project") {
    return input.role === "user" && input.permissions.length === 0 && context.projectId !== undefined &&
      input.grants.every(({ scope }) => scope.type === "project" && scope.projectId === context.projectId) &&
      input.roleAssignments.every(({ projectIds }) => projectIds === undefined);
  }
  return input.role !== "user";
}

/** An account's authority with its role assignments expanded, its role labels kept, for a delegation check. */
export const expandedAuthority = (
  account: { readonly roles?: ReadonlyArray<string> | undefined } & Parameters<typeof expandAccountAccess>[0],
  roles: RoleCatalogue,
): AccountAuthority => ({ roles: account.roles, ...expandAccountAccess(account, roles) });

/** The roles a transaction must read to judge `account`: none unless it holds an assignment. */
const rolesFor = (tx: AuthTxBase, ...accounts: ReadonlyArray<{ readonly roleAssignments?: ReadonlyArray<unknown> | undefined }>) =>
  accounts.some((account) => (account.roleAssignments?.length ?? 0) > 0) ? readRoleCatalogue(tx) : Effect.succeed(NO_ROLES);

/**
 * The actor as this transaction reads it, or null when it may not
 * administer accounts here. A principal of this runtime's own session (or
 * service token) is rebuilt from its account row, after checking that the
 * session or token is still live, so a revoked or demoted administrator is
 * refused at once. A principal that came from elsewhere (the Platform's
 * signed authority forwarded to an App) is taken as the Gateway vouched for
 * it.
 */
export const resolveActor = Effect.fn("auth.access.resolveActor")(function* (
  tx: AuthTxBase,
  principal: ZelavisPrincipal | undefined,
  context: AdministrationContext,
  permission = managePermission(context),
): Effect.fn.Return<ZelavisPrincipal | null, TransactionTooLarge> {
  if (principal === undefined || principal.type === "anonymous") return null;
  const metadata = principal.metadata ?? {};
  const projectId = context.authority === "project" ? context.projectId : undefined;
  let actor = principal;
  if (typeof metadata.sessionId === "string") {
    const session = yield* tx.db.get(coreTables.sessions, metadata.sessionId);
    if (session === null || session.userId !== principal.id) return null;
    const account = yield* tx.db.get(accountsTables.accounts, principal.id);
    if (account === null) return null;
    actor = accountSessionPrincipal(account, metadata.sessionId, metadata.authenticationTransport === "cookie" ? "cookie" : "bearer", projectId, yield* rolesFor(tx, account));
  } else if (typeof metadata.serviceTokenId === "string") {
    const token = yield* tx.db.get(serviceAccountTables.tokens, metadata.serviceTokenId);
    if (token === null || token.accountId !== principal.id || token.expiresAt <= tx.now) return null;
    const account = yield* tx.db.get(accountsTables.accounts, principal.id);
    if (account === null) return null;
    actor = accountSessionPrincipal(account, metadata.serviceTokenId, "bearer", projectId);
  }
  return principalHasPermission(actor, permission, manageScope(context)) ? actor : null;
});

export const resolveSettingsActor = (tx: AuthTxBase, principal: ZelavisPrincipal | undefined, context: AdministrationContext) =>
  resolveActor(tx, principal, context, context.authority === "platform" ? "system.settings.manage" : "project.settings.manage");

/**
 * The account `accountId` when `actor` may manage it: it exists, is of
 * `kind` when one is asked for, and everything it holds is something the
 * actor could have given it.
 */
export const managedAccount = Effect.fn("auth.access.managedAccount")(function* (
  tx: AuthTxBase,
  actor: ZelavisPrincipal,
  context: AdministrationContext,
  accountId: string,
  kind?: Account["kind"],
): Effect.fn.Return<{ readonly ok: true; readonly account: Account } | AdministrationRefusal, TransactionTooLarge> {
  const account = yield* tx.db.get(accountsTables.accounts, accountId);
  if (account === null || (kind !== undefined && account.kind !== kind)) return refuse("account_not_found");
  // A service account's own `service` role is how it was made, not something delegated.
  const roles = account.kind === "service" ? account.roles.filter((role) => role !== "service") : account.roles;
  if (!canDelegateAccess(actor, context, { ...expandedAuthority(account, yield* rolesFor(tx, account)), roles })) return refuse("account_access_forbidden");
  return { ok: true, account } as const;
});

const sameAccess = (account: Account, input: SetAccountAccessInput) =>
  account.roles.length === 1 && account.roles[0] === input.role &&
  JSON.stringify([...new Set(account.permissions)].sort()) === JSON.stringify(input.permissions) &&
  JSON.stringify([...new Set(account.grants.map(accountGrantKey))].sort()) === JSON.stringify(input.grants.map(accountGrantKey)) &&
  JSON.stringify(account.roleAssignments ?? []) === JSON.stringify(input.roleAssignments);

/**
 * Replace a human account's role, permissions, grants and role assignments.
 * `input` is normalized (`normalizeAccountAccess`). The edit applies only at
 * `expectedRevision`; an edit that changes nothing answers the current access
 * at its revision. A change raises the revision, ends the account's sessions
 * (as Identity's session epoch did) and records `account.access.changed`, all
 * in this transaction.
 *
 * Role assignments are judged by what they expand to, against the roles this
 * transaction reads: the actor must be able to give the account's current
 * authority and the new one, roles included. An assignment of a role that no
 * longer exists is dropped when the edit keeps it; a new assignment must name
 * an existing role (`role_not_found`), and the whole access may expand to at
 * most `ROLE_EXPANSION_LIMIT` entries (`role_expansion_limit`).
 */
export const setAccountAccess = Effect.fn("auth.access.setAccountAccess")(function* (
  tx: AuthTxBase,
  args: {
    readonly actor: ZelavisPrincipal;
    readonly context: AdministrationContext;
    readonly accountId: string;
    readonly input: SetAccountAccessInput;
    readonly provedProjectPermissions?: ReadonlyArray<string> | undefined;
  },
): Effect.fn.Return<{ readonly ok: true; readonly result: AccountAccessResult } | AdministrationRefusal, TransactionTooLarge> {
  const { actor, context, input } = args;
  const current = yield* tx.db.get(accountsTables.accounts, args.accountId);
  if (current === null) return refuse("account_not_found");
  if (current._id === actor.id || current.kind === "service" ||
      current.roles.some((role) => PROTECTED_ROLES.has(role)) || current.metadata?.principalType === "system") {
    return refuse("account_access_forbidden");
  }
  const revision = current.accessRevision;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision !== input.expectedRevision) return refuse("account_access_conflict");
  const catalogue = yield* rolesFor(tx, current, input);
  const held = new Set((current.roleAssignments ?? []).map(({ roleId }) => roleId));
  if (input.roleAssignments.some(({ roleId }) => !catalogue.has(roleId) && !held.has(roleId))) return refuse("role_not_found");
  const assigned = { ...input, roleAssignments: input.roleAssignments.filter(({ roleId }) => catalogue.has(roleId)) };
  if (expansionSize(assigned, catalogue) > ROLE_EXPANSION_LIMIT) return refuse("role_expansion_limit");
  if (!canDelegateAccess(actor, context, expandedAuthority(current, catalogue), args.provedProjectPermissions) ||
      !canDelegateAccess(actor, context, expandedAuthority({ ...assigned, roles: [input.role] }, catalogue), args.provedProjectPermissions)) {
    return refuse("account_access_forbidden");
  }
  const result = (accessRevision: number): AccountAccessResult => ({
    accountId: current._id,
    accessRevision,
    role: input.role,
    permissions: [...input.permissions],
    grants: input.grants.map((grant) => ({ permission: grant.permission, scope: { ...grant.scope } })),
    roleAssignments: assigned.roleAssignments.map(copyAssignment),
  });
  if (sameAccess(current, assigned)) return { ok: true, result: result(revision) } as const;
  if (revision === Number.MAX_SAFE_INTEGER) return refuse("account_access_conflict");
  yield* tx.db.patch(accountsTables.accounts, current._id, {
    roles: [input.role],
    permissions: [...input.permissions],
    grants: input.grants.map((grant) => ({ permission: grant.permission, scope: { ...grant.scope } })),
    roleAssignments: assigned.roleAssignments.map(copyAssignment),
    accessRevision: revision + 1,
  });
  yield* endAccountSessions(tx, current._id);
  yield* recordSecurityEvent(tx, { kind: "account.access.changed", accountId: current._id, actorId: actor.id, detail: { accessRevision: revision + 1 } });
  return { ok: true, result: result(revision + 1) } as const;
});

const copyAssignment = ({ roleId, projectIds }: SetAccountAccessInput["roleAssignments"][number]) =>
  projectIds === undefined ? { roleId } : { roleId, projectIds: [...projectIds] };
