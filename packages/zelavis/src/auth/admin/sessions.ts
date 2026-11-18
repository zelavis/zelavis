/**
 * An administrator's view of another account's sessions (Zelavis-own):
 * listing them, ending one, ending all. Each checks, in its transaction, that
 * the actor may manage the account (`managedAccount`), so an operator cannot
 * end the owner's sessions, and records `session.revoked` with the actor.
 */
import * as Effect from "effect/Effect";
import type { ZelavisPrincipal } from "../../core/index.js";
import { type AdministrationContext, managedAccount, refuse, resolveActor } from "../access/delegation.js";
import type { AuthTx } from "../core/context.js";
import { listSessions, revokeSessions } from "../core/public.js";
import { sessionsOfUser } from "../core/sessions.js";
import { recordSecurityEvent } from "../security/events.js";
import { revokeServiceTokens, serviceTokensOfAccount } from "../serviceAccounts/tokens.js";

const managed = Effect.fn("auth.admin.sessions.managed")(function* (
  tx: AuthTx,
  principal: ZelavisPrincipal | undefined,
  context: AdministrationContext,
  accountId: string,
) {
  const actor = yield* resolveActor(tx, principal, context);
  if (actor === null) return refuse("account_access_forbidden");
  const target = yield* managedAccount(tx, actor, context, accountId);
  return target.ok ? { ok: true, actor, account: target.account } as const : target;
});

export const listAccountSessions = Effect.fn("auth.admin.sessions.list")(function* (
  tx: AuthTx,
  args: { readonly principal: ZelavisPrincipal | undefined; readonly context: AdministrationContext; readonly accountId: string },
) {
  const target = yield* managed(tx, args.principal, args.context, args.accountId);
  if (!target.ok) return target;
  if (target.account.kind === "service") {
    const tokens = yield* serviceTokensOfAccount(tx, args.accountId);
    return { ok: true, sessions: tokens.map((token) => ({
      sessionId: token._id, creationTime: token.createdAt, lastRefreshedAt: token.createdAt,
    })) } as const;
  }
  return { ok: true, sessions: yield* listSessions(tx, { userId: args.accountId }) } as const;
});

const revokeHumanSessions = Effect.fn("auth.admin.sessions.revokeHuman")(function* (
  tx: AuthTx,
  accountId: string,
  sessionId?: string,
) {
  const sessions = yield* sessionsOfUser(tx, accountId, "asc");
  const ids = sessions.filter((session) => sessionId === undefined || session._id === sessionId).map((session) => session._id);
  return yield* revokeSessions(tx, { sessionIds: ids });
});

/** End `sessionId` of the account, or every session when it is undefined. Answers the ids ended. */
export const revokeAccountSessions = Effect.fn("auth.admin.sessions.revoke")(function* (
  tx: AuthTx,
  args: { readonly principal: ZelavisPrincipal | undefined; readonly context: AdministrationContext; readonly accountId: string; readonly sessionId?: string | undefined },
) {
  const target = yield* managed(tx, args.principal, args.context, args.accountId);
  if (!target.ok) return target;
  const revoked = target.account.kind === "service"
    ? yield* revokeServiceTokens(tx, args.accountId, args.sessionId)
    : yield* revokeHumanSessions(tx, args.accountId, args.sessionId);
  if (args.sessionId !== undefined && revoked.length === 0) return { ok: false, code: "session_not_found" } as const;
  if (revoked.length > 0) {
    yield* recordSecurityEvent(tx, { kind: "session.revoked", accountId: args.accountId, actorId: target.actor.id, detail: { sessions: revoked.length } });
  }
  return { ok: true, revoked } as const;
});
