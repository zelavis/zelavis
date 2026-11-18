import * as Effect from "effect/Effect";
import { accountGrantKey } from "../access/access.js";
import { type AdministrationContext, canDelegateAccess, expandedAuthority, managePermission, manageScope } from "../access/delegation.js";
import { ROLE_ASSIGNMENT_LIMIT, ROLE_ASSIGNMENT_PROJECT_LIMIT } from "../access/access.js";
import { readRoleCatalogue } from "../roles/catalogue.js";
import { NO_ROLES, ROLE_EXPANSION_LIMIT, expansionSize } from "../roles/expand.js";
import { principalHasPermission } from "../../core/runtime/request-dispatcher.js";
import { accountsModule, createAdmittedAccount } from "../accounts/accounts.js";
import { accountSessionPrincipal } from "../accounts/principal.js";
import { type Account, accountsTables } from "../accounts/tables.js";
import type { AuthCall, AuthTx } from "../core/context.js";
import { endAccountSessions } from "../core/sessions.js";
import type { AuthCore } from "../core/setup.js";
import { getAuthUserId } from "../core/userId.js";
import { emailByNormalizedEmail, getClientIp } from "../email/helpers.js";
import { clearEmailReservation, emailReservation } from "../email/reservations.js";
import { emailTables } from "../email/tables.js";
import { getPrimaryEmail } from "../email/verifiedEmails.js";
import { sha256Hex } from "../lib/crypto.js";
import { DEFAULT_MIN_PASSWORD_LENGTH } from "../lib/password.js";
import { hashPassword } from "../password/hashing.js";
import { _internal_dangerous_setPassword } from "../password/public.js";
import { validateNewPassword } from "../password/validation.js";
import { HOUR, defineRateLimits, invariant } from "../runtime/index.js";
import { recordSecurityEvent } from "../security/events.js";
import { getUserIdByUsername, setUsername } from "../username/public.js";
import { validateUsernameFormat } from "../username/validation.js";
import { closeInvitation, invalidInvitation, invitationByTokenHash, invitationCanBeAccepted, invitationRefused } from "./invitations.js";
import type { AcceptInvitationInput, Invitation } from "./tables.js";

const limits = defineRateLimits("invitations", {
  acceptPerIp: { kind: "token bucket", rate: 60, period: HOUR },
});

/**
 * The account's role assignments with the invitation's added: a role it
 * already holds gains the invitation's Projects. Undefined when the result
 * would exceed the assignment bounds.
 */
const mergeAssignments = (account: Account, invitation: Invitation) => {
  const merged = new Map((account.roleAssignments ?? []).map(({ roleId, projectIds }) => [roleId, new Set(projectIds ?? [])]));
  for (const { roleId, projectIds } of invitation.access.roleAssignments) {
    const projects = merged.get(roleId) ?? new Set<string>();
    for (const projectId of projectIds ?? []) projects.add(projectId);
    merged.set(roleId, projects);
  }
  if (merged.size > ROLE_ASSIGNMENT_LIMIT || [...merged.values()].some((projects) => projects.size > ROLE_ASSIGNMENT_PROJECT_LIMIT)) return undefined;
  return [...merged.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([roleId, projects]) => projects.size === 0 ? { roleId } : { roleId, projectIds: [...projects].sort() });
};

const mergeAccess = Effect.fn("auth.invitations.mergeAccess")(function* (
  tx: AuthTx, account: Account, invitation: Invitation,
) {
  const { access } = invitation;
  const roleAssignments = mergeAssignments(account, invitation);
  if (roleAssignments === undefined) return false;
  // A base role can be promoted. An existing elevated or protected role survives.
  const role = account.roles[0];
  const roles = account.roles.length === 1 && (role === "customer" || role === "user") ? [access.role] : account.roles;
  const heldPermissions = new Set(account.permissions);
  const heldGrants = new Set(account.grants.map(accountGrantKey));
  const permissions = [...account.permissions, ...access.permissions.filter((permission) => !heldPermissions.has(permission))];
  const grants = [...account.grants, ...access.grants.filter((grant) => !heldGrants.has(accountGrantKey(grant)))];
  if (expansionSize({ permissions, grants, roleAssignments }, yield* readRoleCatalogue(tx)) > ROLE_EXPANSION_LIMIT) return false;
  if (roles[0] === role && permissions.length === account.permissions.length && grants.length === account.grants.length &&
      JSON.stringify(roleAssignments) === JSON.stringify(account.roleAssignments ?? [])) return true;
  const revision = account.accessRevision + 1;
  if (!Number.isSafeInteger(revision) || revision < 1) return yield* invariant("Invalid access revision for invitation acceptance.");
  yield* tx.db.patch(accountsTables.accounts, account._id, { roles, permissions, grants, roleAssignments, accessRevision: revision });
  // Sessions that never proved possession of the invitation must not inherit the new access.
  yield* endAccountSessions(tx, account._id);
  yield* recordSecurityEvent(tx, { kind: "account.access.changed", accountId: account._id, detail: { accessRevision: revision, by: "invitation" } });
  return true;
});

export function createInvitationAcceptance(core: AuthCore, context: AdministrationContext) {
  const bound = core.bindMethod<unknown>({
    name: "invitation",
    secondFactor: true,
    createUser: () => invariant("Invitation acceptance creates its accounts itself."),
    onSignIn: accountsModule.onSignIn,
  });

  const accept = Effect.fn("auth.invitations.accept")(function* (call: AuthCall, input: AcceptInvitationInput) {
    const tokenHash = yield* sha256Hex(input.token);
    const attempt = (credentials?: { readonly username: string; readonly passwordHashPHC: string }) =>
      bound.mutation(call, Effect.fnUntraced(function* (tx, helpers) {
        if (credentials === undefined) {
          const limit = yield* limits.limit(tx, "acceptPerIp", { key: getClientIp(tx) });
          if (!limit.ok) return { ok: false, code: "invitation_rate_limited", retryAfterMs: limit.retryAfter } as const;
        }
        const row = yield* invitationByTokenHash(tx, tokenHash);
        if (!invitationCanBeAccepted(row, tx.now)) return invalidInvitation();
        if (row.invitedBy.kind === "account") {
          const inviter = yield* tx.db.get(accountsTables.accounts, row.invitedBy.accountId);
          const projectId = context.authority === "project" ? context.projectId : undefined;
          const roles = (inviter?.roleAssignments?.length ?? 0) > 0 || row.access.roleAssignments.length > 0 ? yield* readRoleCatalogue(tx) : NO_ROLES;
          const actor = inviter && accountSessionPrincipal(inviter, "", "bearer", projectId, roles);
          if (actor === null || !principalHasPermission(actor, managePermission(context), manageScope(context)) ||
              !canDelegateAccess(actor, context, expandedAuthority({ ...row.access, roles: [row.access.role] }, roles))) {
            yield* closeInvitation(tx, row, { status: "revoked" });
            return invalidInvitation();
          }
        }
        const verified = yield* emailByNormalizedEmail(tx, row.normalizedEmail);
        const reservation = verified === null ? yield* emailReservation(tx, row.normalizedEmail) : null;
        const existingId = verified?.userId ?? reservation?.userId;
        let userId: string;
        if (existingId !== undefined) {
          if ((yield* getAuthUserId(tx)) !== existingId) return invitationRefused("invitation_requires_sign_in");
          const account = yield* tx.db.get(accountsTables.accounts, existingId);
          if (account?.kind !== "human") return invalidInvitation();
          userId = existingId;
          if (!(yield* mergeAccess(tx, account, row))) return invitationRefused("invitation_access_limit");
        } else {
          if (credentials === undefined) return invitationRefused("invitation_credentials_required");
          if ((yield* getUserIdByUsername(tx, { username: credentials.username })) !== null) return invitationRefused("username_taken");
          userId = yield* createAdmittedAccount(tx, {
            kind: "human", roles: [row.access.role], permissions: row.access.permissions, grants: row.access.grants,
            ...(row.access.roleAssignments.length === 0 ? {} : { roleAssignments: row.access.roleAssignments }),
          });
          const saved = yield* setUsername(tx, { userId, username: credentials.username });
          if (!saved.success) return yield* invariant("The validated invitation username was refused.");
          yield* _internal_dangerous_setPassword(tx, { userId, passwordHashPHC: credentials.passwordHashPHC });
          yield* recordSecurityEvent(tx, { kind: "account.created", accountId: userId, detail: { by: "invitation" } });
        }
        if (verified === null) {
          const isPrimary = existingId === undefined || (yield* getPrimaryEmail(tx, { userId })) === null;
          yield* tx.db.insert(emailTables.verifiedEmails, { email: row.email, normalizedEmail: row.normalizedEmail, userId, isPrimary });
          if (reservation !== null) yield* clearEmailReservation(tx, userId);
        }
        yield* closeInvitation(tx, row, { status: "accepted", acceptedAccountId: userId });
        const outcome = yield* helpers.completeSignIn(tx, { userId, profile: {}, authenticatedBy: "invitation" });
        return { ok: true, outcome } as const;
      }));

    // Check the token and per-client budget before doing password work. The second
    // attempt repeats the authority, token and email-ownership checks in the commit.
    const first = yield* attempt();
    if (first.ok || first.code !== "invitation_credentials_required" || input.username === undefined || input.password === undefined) return first;
    const username = input.username.trim();
    const userError = validateUsernameFormat(username) ?? validateNewPassword(input.password, DEFAULT_MIN_PASSWORD_LENGTH);
    if (userError !== null) return { ok: false, code: "invalid_credentials_input", userError } as const;
    const passwordHashPHC = yield* hashPassword(input.password);
    return yield* attempt({ username, passwordHashPHC });
  });

  return accept;
}
