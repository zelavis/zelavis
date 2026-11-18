import * as Effect from "effect/Effect";
import type { ZelavisPrincipal } from "../../core/index.js";
import { canDelegateAccess, refuse, resolveActor } from "../access/delegation.js";
import { createAdmittedAccount } from "../accounts/accounts.js";
import { accountsTables } from "../accounts/tables.js";
import { invariant, type AuthTxBase } from "../runtime/index.js";
import { recordSecurityEvent } from "../security/events.js";
import { serviceAccountTables } from "./tables.js";
import { issueServiceToken, revokeServiceTokens, SERVICE_TOKEN_MAX_DAYS } from "./tokens.js";

const ownedAccount = Effect.fn("auth.serviceAccounts.ownedPrincipal")(function* (tx: AuthTxBase, accountId: string, serviceName: string) {
  const account = yield* tx.db.get(accountsTables.accounts, accountId);
  if (account !== null && (account.kind !== "service" || account.metadata?.ownerService !== serviceName)) {
    return yield* invariant("A service principal owner row names an account it does not own");
  }
  return account;
});

/** Approval and ownership are checked in the transaction that grants the account. */
export const grantServicePrincipal = Effect.fn("auth.serviceAccounts.grantPrincipal")(function* (tx: AuthTxBase, args: {
  readonly principal: ZelavisPrincipal | undefined;
  readonly serviceName: string;
  readonly title: string;
  readonly permissions: readonly string[];
}) {
  const context = { authority: "platform" as const };
  const actor = yield* resolveActor(tx, args.principal, context, "system.services.manage");
  if (actor === null || !canDelegateAccess(actor, context, { permissions: args.permissions, grants: [] })) return refuse("account_access_forbidden");
  const owner = yield* tx.db.query(serviceAccountTables.owners).withIndex("by_serviceName", q => q.eq("serviceName", args.serviceName)).unique();
  const previous = owner === null ? null : yield* ownedAccount(tx, owner.accountId, args.serviceName);
  const accountId = previous === null ? yield* createAdmittedAccount(tx, {
    kind: "service", displayName: `${args.title} (service)`, roles: ["service"], permissions: args.permissions, grants: [],
    metadata: { principalType: "service", serviceAccount: true, ownerService: args.serviceName },
  }) : previous._id;
  if (previous !== null) yield* tx.db.patch(accountsTables.accounts, accountId, { permissions: [...args.permissions], grants: [], roleAssignments: [] });
  if (owner === null) yield* tx.db.insert(serviceAccountTables.owners, { serviceName: args.serviceName, accountId });
  else if (owner.accountId !== accountId) yield* tx.db.patch(serviceAccountTables.owners, owner._id, { accountId });
  yield* revokeServiceTokens(tx, accountId);
  const issued = yield* issueServiceToken(tx, accountId, SERVICE_TOKEN_MAX_DAYS);
  yield* recordSecurityEvent(tx, { kind: "service_account.principal_granted", accountId, actorId: actor.id, detail: { serviceName: args.serviceName } });
  return { ok: true, accountId, token: issued.token, approvedBy: actor.id, approvedAt: new Date(tx.now).toISOString() } as const;
});

export const retireServicePrincipal = Effect.fn("auth.serviceAccounts.retirePrincipal")(function* (tx: AuthTxBase, serviceName: string, actorId?: string) {
  const owner = yield* tx.db.query(serviceAccountTables.owners).withIndex("by_serviceName", q => q.eq("serviceName", serviceName)).unique();
  if (owner === null) return;
  const account = yield* ownedAccount(tx, owner.accountId, serviceName);
  yield* revokeServiceTokens(tx, owner.accountId);
  if (account !== null) yield* tx.db.delete(accountsTables.accounts, owner.accountId);
  yield* tx.db.delete(serviceAccountTables.owners, owner._id);
  yield* recordSecurityEvent(tx, { kind: "service_account.revoked", accountId: owner.accountId, actorId, detail: { serviceName } });
});
