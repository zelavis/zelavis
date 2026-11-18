/**
 * Platform service accounts (Zelavis-own, moved from Identity's
 * `/service-accounts*` routes): accounts of kind "service" for automation,
 * each with bearer tokens (`tokens.ts`). Creating one, naming the Tenant it
 * acts in, replacing its tokens and removing it are administration: the actor
 * may give it only access it could give anyone (`canDelegateAccess`), and
 * every change is recorded as a security event in its own transaction.
 */
import * as Effect from "effect/Effect";
import type { ZelavisPrincipal, ZelavisPrincipalGrant } from "../../core/index.js";
import { isValidTenantId } from "../../db/naming.js";
import { type AdministrationContext, canDelegateAccess, managedAccount, refuse, resolveActor } from "../access/delegation.js";
import { createAdmittedAccount } from "../accounts/accounts.js";
import { accountsTables } from "../accounts/tables.js";
import { administrativeAccount } from "../admin/accounts.js";
import type { AuthTx } from "../core/context.js";
import { invariant } from "../runtime/index.js";
import { recordSecurityEvent } from "../security/events.js";
import { issueServiceToken, revokeServiceTokens, SERVICE_TOKEN_DEFAULT_DAYS, SERVICE_TOKEN_MAX_DAYS } from "./tokens.js";

const LIST_LIMIT = 1000;

export type ServiceAccountInputProblem = { readonly ok: false; readonly code: "invalid_service_account"; readonly message: string };

const invalid = (message: string): ServiceAccountInputProblem => ({ ok: false, code: "invalid_service_account", message });

/** Token lifetime in days: 1 to 3650, 90 unless given. */
export const readTokenDays = (value: unknown): number | ServiceAccountInputProblem => {
  const days = value === undefined ? SERVICE_TOKEN_DEFAULT_DAYS : Number(value);
  return Number.isSafeInteger(days) && days >= 1 && days <= SERVICE_TOKEN_MAX_DAYS
    ? days
    : invalid(`Service account token lifetime must be between 1 and ${SERVICE_TOKEN_MAX_DAYS} days.`);
};

/**
 * The Tenant a service account acts in. Validated rather than trusted: a
 * Tenant id becomes part of the storage namespace, so one carrying a `/`
 * would be read back as another Tenant entirely.
 */
export const readTenantId = (value: unknown): string | undefined | ServiceAccountInputProblem => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) return invalid("A Tenant id must be a non-empty string.");
  const tenantId = value.trim();
  return isValidTenantId(tenantId)
    ? tenantId
    : invalid("A Tenant id may use letters, digits, dot, dash and underscore, must start with a letter or digit, and may not begin with the reserved \"zv.\" prefix.");
};

export const readPermissions = (value: unknown): ReadonlyArray<string> | ServiceAccountInputProblem => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some((permission) => typeof permission !== "string" || !permission.trim())) {
    return invalid("Service account permissions must be an array of at most 100 names.");
  }
  return [...new Set(value.map((permission: string) => permission.trim()))];
};

export const readGrants = (value: unknown): ReadonlyArray<ZelavisPrincipalGrant> | ServiceAccountInputProblem => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) return invalid("Service account grants must be an array of at most 100 entries.");
  const grants: ZelavisPrincipalGrant[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return invalid("Each service account grant must be an object.");
    const grant = entry as { permission?: unknown; scope?: unknown };
    if (typeof grant.permission !== "string" || !grant.permission.trim()) return invalid("Each service account grant requires a permission.");
    const scope = grant.scope;
    if (!scope || typeof scope !== "object") return invalid("Service account grants require an explicit scope.");
    const candidate = scope as Record<string, unknown>;
    const permission = grant.permission.trim();
    if (candidate.type === "project" && typeof candidate.projectId === "string" && candidate.projectId.trim()) {
      grants.push({ permission, scope: { type: "project", projectId: candidate.projectId.trim() } });
    } else if (candidate.type === "service" && typeof candidate.serviceName === "string" && candidate.serviceName.trim()) {
      grants.push({ permission, scope: { type: "service", serviceName: candidate.serviceName.trim() } });
    } else if (candidate.type === "system") {
      grants.push({ permission, scope: { type: "system" } });
    } else {
      return invalid("Service account grant scopes must name a system, Project, or service.");
    }
  }
  return grants;
};

const tokenView = (accountId: string, issued: { readonly tokenId: string; readonly expiresAt: number }) => ({
  id: issued.tokenId,
  accountId,
  expiresAt: new Date(issued.expiresAt).toISOString(),
});

type Args = { readonly principal: ZelavisPrincipal | undefined; readonly context: AdministrationContext };

export const listServiceAccounts = Effect.fn("auth.serviceAccounts.list")(function* (tx: AuthTx, args: Args) {
  if ((yield* resolveActor(tx, args.principal, args.context)) === null) return refuse("account_access_forbidden");
  const rows = yield* tx.db.query(accountsTables.accounts).withIndex("by_kind", (q) => q.eq("kind", "service")).take(LIST_LIMIT);
  const serviceAccounts = [];
  for (const row of rows) serviceAccounts.push(yield* administrativeAccount(tx, row));
  return { ok: true, serviceAccounts } as const;
});

export const createServiceAccount = Effect.fn("auth.serviceAccounts.create")(function* (tx: AuthTx, args: Args & {
  readonly name: string;
  readonly days: number;
  readonly tenantId?: string | undefined;
  readonly permissions: ReadonlyArray<string>;
  readonly grants: ReadonlyArray<ZelavisPrincipalGrant>;
}) {
  const actor = yield* resolveActor(tx, args.principal, args.context);
  if (actor === null) return refuse("account_access_forbidden");
  if (!canDelegateAccess(actor, args.context, { permissions: args.permissions, grants: args.grants })) return refuse("account_access_forbidden");
  const accountId = yield* createAdmittedAccount(tx, {
    kind: "service",
    displayName: args.name,
    roles: ["service"],
    permissions: args.permissions,
    grants: args.grants,
    // Without a Tenant an account is its own, which is a generated id no
    // operator would recognise and no second client can ever join. Naming it
    // is what lets an App's web client and its worker be one customer.
    metadata: { principalType: "service", serviceAccount: true, ...(args.tenantId === undefined ? {} : { tenantId: args.tenantId }) },
  });
  const issued = yield* issueServiceToken(tx, accountId, args.days);
  yield* recordSecurityEvent(tx, { kind: "service_account.created", accountId, actorId: actor.id });
  const account = yield* tx.db.get(accountsTables.accounts, accountId);
  if (account === null) return yield* invariant("The service account created in this transaction is missing");
  return { ok: true, serviceAccount: yield* administrativeAccount(tx, account), token: issued.token, session: tokenView(accountId, issued) } as const;
});

/**
 * Name the Tenant the account acts in from now on. Records already written
 * under the old Tenant stay where they are: moving data is a separate,
 * deliberate act.
 */
export const setServiceAccountTenant = Effect.fn("auth.serviceAccounts.setTenant")(function* (tx: AuthTx, args: Args & { readonly accountId: string; readonly tenantId: string }) {
  const actor = yield* resolveActor(tx, args.principal, args.context);
  if (actor === null) return refuse("account_access_forbidden");
  const target = yield* managedAccount(tx, actor, args.context, args.accountId, "service");
  if (!target.ok) return target;
  yield* tx.db.patch(accountsTables.accounts, args.accountId, { metadata: { ...(target.account.metadata ?? {}), tenantId: args.tenantId } });
  yield* recordSecurityEvent(tx, { kind: "service_account.tenant_changed", accountId: args.accountId, actorId: actor.id });
  const account = yield* tx.db.get(accountsTables.accounts, args.accountId);
  if (account === null) return yield* invariant("The service account changed in this transaction is missing");
  return { ok: true, serviceAccount: yield* administrativeAccount(tx, account) } as const;
});

/** Revoke every token of the account and issue a new one. */
export const rotateServiceAccountToken = Effect.fn("auth.serviceAccounts.rotate")(function* (tx: AuthTx, args: Args & { readonly accountId: string; readonly days: number }) {
  const actor = yield* resolveActor(tx, args.principal, args.context);
  if (actor === null) return refuse("account_access_forbidden");
  const target = yield* managedAccount(tx, actor, args.context, args.accountId, "service");
  if (!target.ok) return target;
  yield* revokeServiceTokens(tx, args.accountId);
  const issued = yield* issueServiceToken(tx, args.accountId, args.days);
  yield* recordSecurityEvent(tx, { kind: "service_account.token_rotated", accountId: args.accountId, actorId: actor.id });
  return { ok: true, token: issued.token, session: tokenView(args.accountId, issued) } as const;
});

/** Revoke every token and remove the account. */
export const revokeServiceAccount = Effect.fn("auth.serviceAccounts.revoke")(function* (tx: AuthTx, args: Args & { readonly accountId: string }) {
  const actor = yield* resolveActor(tx, args.principal, args.context);
  if (actor === null) return refuse("account_access_forbidden");
  const target = yield* managedAccount(tx, actor, args.context, args.accountId, "service");
  if (!target.ok) return target;
  yield* revokeServiceTokens(tx, args.accountId);
  yield* tx.db.delete(accountsTables.accounts, args.accountId);
  yield* recordSecurityEvent(tx, { kind: "service_account.revoked", accountId: args.accountId, actorId: actor.id });
  return { ok: true } as const;
});
