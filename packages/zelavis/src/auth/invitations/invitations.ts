import * as Effect from "effect/Effect";
import type { EmailOutbox } from "../../app/email/contracts.js";
import type { ZelavisPrincipal, ZelavisPrincipalGrant } from "../../core/index.js";
import { projectAccountAccessProof } from "../access/access.js";
import { type AdministrationContext, accessInputFits, canDelegateAccess, expandedAuthority, resolveActor } from "../access/delegation.js";
import { readRoleCatalogue } from "../roles/catalogue.js";
import { NO_ROLES, ROLE_EXPANSION_LIMIT, expansionSize } from "../roles/expand.js";
import { invitationEmail } from "../email/templates.js";
import { normalizeEmail } from "../email/validation.js";
import { generateRandomToken, sha256Hex } from "../lib/crypto.js";
import { type AuthRequest, type AuthRuntime, type AuthTxBase, AUTH_EMAIL_TOPIC, invariant } from "../runtime/index.js";
import { type CreateInvitationInput, type Invitation, type PublicInvitation, INVITATION_LIMIT, invitationsTables } from "./tables.js";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60_000;
export const INVITATION_PAGE_LIMIT = 100;

export const invitationRefused = <Code extends string>(code: Code) => ({ ok: false, code } as const);
export const invalidInvitation = () => invitationRefused("invalid_invitation");

const publicInvitation = (row: Invitation): PublicInvitation => ({
  id: row._id,
  email: row.email,
  access: row.access,
  status: row.status,
  createdAt: new Date(row._creationTime).toISOString(),
  expiresAt: new Date(row.expiresAt).toISOString(),
  ...(row.acceptedAccountId === undefined ? {} : { acceptedAccountId: row.acceptedAccountId }),
});

export const invitationByTokenHash = (tx: AuthTxBase, tokenHash: string) =>
  tx.db.query(invitationsTables.invitations).withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash)).unique();

export const pendingCounter = (tx: AuthTxBase) => tx.db.query(invitationsTables.counter).unique();

export const writePending = Effect.fn("auth.invitations.writePending")(function* (
  tx: AuthTxBase, counter: { readonly _id: string; readonly pending: number } | null, pending: number,
) {
  if (pending < 0 || pending > INVITATION_LIMIT) return yield* invariant("Invalid invitation pending count.");
  if (counter === null) yield* tx.db.insert(invitationsTables.counter, { pending });
  else if (counter.pending !== pending) yield* tx.db.patch(invitationsTables.counter, counter._id, { pending });
});

export const closeInvitation = Effect.fn("auth.invitations.close")(function* (
  tx: AuthTxBase, row: Invitation, disposition: { readonly status: "revoked" } | { readonly status: "accepted"; readonly acceptedAccountId: string },
) {
  if (row.status !== "pending") return yield* invariant("Only pending invitations may change status.");
  const counter = yield* pendingCounter(tx);
  yield* writePending(tx, counter, (counter?.pending ?? 0) - 1);
  yield* tx.db.patch(invitationsTables.invitations, row._id, disposition);
});

export const invitationCanBeAccepted = (row: Invitation | null, now: number): row is Invitation =>
  row !== null && row.status === "pending" && row.expiresAt > now;

/** Bind the checked input and exact operation to the Gateway envelope's delegation digest. */
export const invitationGatewayDigest = (method: string, path: string, input?: CreateInvitationInput) =>
  sha256Hex(JSON.stringify(["invitation", method, path, input]));

type ActorRequest = {
  readonly principal: ZelavisPrincipal | undefined;
  readonly digest: string;
};

export function createInvitations(options: {
  readonly runtime: AuthRuntime;
  readonly context: AdministrationContext;
  readonly emailOutbox: EmailOutbox | undefined;
  readonly validateGrantScopes: ((scopes: ReadonlyArray<NonNullable<ZelavisPrincipalGrant["scope"]>>) => Effect.Effect<boolean>) | undefined;
}) {
  const { runtime, context } = options;
  const actorFor = Effect.fn("auth.invitations.actor")(function* (tx: AuthTxBase, request: ActorRequest) {
    const principal = request.principal;
    if (principal === undefined) return null;
    const gateway = projectAccountAccessProof(principal);
    if (gateway !== undefined) {
      if (context.authority !== "project" || gateway.digest !== request.digest) return null;
      const actor = yield* resolveActor(tx, principal, context);
      return actor && { actor, invitedBy: { kind: "gateway", principalId: actor.id } as const };
    }
    // External authenticators cannot supply an invitation's durable account authority.
    if (typeof principal.metadata?.sessionId !== "string" && typeof principal.metadata?.serviceTokenId !== "string") return null;
    const actor = yield* resolveActor(tx, principal, context);
    return actor && { actor, invitedBy: { kind: "account", accountId: actor.id } as const };
  });

  const linkBase = () => options.emailOutbox?.linkBase().pipe(Effect.catchTag("EmailUnavailable", () => Effect.undefined)) ??
    Effect.undefined;

  const send = (tx: AuthTxBase, base: URL, email: string, token: string) => tx.emit({
    topic: AUTH_EMAIL_TOPIC,
    id: `invitation-${generateRandomToken()}`,
    payload: invitationEmail(base, email, token),
  });

  const list = (call: AuthRequest, request: ActorRequest, limit: number, after?: { createdAt: number; id: string }) =>
    runtime.query(call, Effect.fnUntraced(function* (tx) {
      if ((yield* actorFor(tx, request)) === null) return invitationRefused("account_access_forbidden");
      // An Auth restart can leave multiple rows at the same creation time.
      // Page within that timestamp first, then fill with older invitations.
      const query = tx.db.query(invitationsTables.invitations);
      const tied = after === undefined ? [] : yield* query.withIndex("by_created",
        (q) => q.eq("_creationTime", after.createdAt).lt("_id", after.id)).order("desc").take(limit + 1);
      const older = tied.length > limit ? [] : yield* query
        .withIndex("by_created", after === undefined ? undefined : (q) => q.lt("_creationTime", after.createdAt))
        .order("desc").take(limit + 1 - tied.length);
      const page = [...tied, ...older].slice(0, limit);
      const last = page.at(-1);
      return { ok: true, page: {
        invitations: page.map(publicInvitation),
        ...(tied.length + older.length > limit && last !== undefined ? { next: `${last._creationTime}:${last._id}` } : {}),
      } } as const;
    }));

  const create = Effect.fn("auth.invitations.create")(function* (call: AuthRequest, request: ActorRequest, input: CreateInvitationInput) {
    const validatedScopes = context.authority !== "platform" || options.validateGrantScopes === undefined ||
      (yield* options.validateGrantScopes(input.access.grants.map(({ scope }) => scope)));
    const base = yield* linkBase();
    const token = generateRandomToken();
    const tokenHash = yield* sha256Hex(token);
    return yield* runtime.mutation(call, Effect.fnUntraced(function* (tx) {
      const authority = yield* actorFor(tx, request);
      if (authority === null || !validatedScopes || !accessInputFits(context, input.access)) return invitationRefused("account_access_forbidden");
      // Assigned roles must exist now; what they give is judged by what they expand to.
      const roles = input.access.roleAssignments.length === 0 ? NO_ROLES : yield* readRoleCatalogue(tx);
      if (input.access.roleAssignments.some(({ roleId }) => !roles.has(roleId))) return invitationRefused("role_not_found");
      if (expansionSize(input.access, roles) > ROLE_EXPANSION_LIMIT) return invitationRefused("role_expansion_limit");
      if (authority.invitedBy.kind === "account" &&
          !canDelegateAccess(authority.actor, context, expandedAuthority({ ...input.access, roles: [input.access.role] }, roles))) {
        return invitationRefused("account_access_forbidden");
      }
      if (base === undefined) return invitationRefused("email_unavailable");
      const counter = yield* pendingCounter(tx);
      if ((counter?.pending ?? 0) >= INVITATION_LIMIT) return invitationRefused("invitation_limit");

      const id = yield* tx.db.insert(invitationsTables.invitations, {
        email: input.email, normalizedEmail: normalizeEmail(input.email), access: input.access,
        invitedBy: authority.invitedBy, tokenHash, status: "pending", expiresAt: tx.now + INVITATION_TTL_MS,
      });
      yield* writePending(tx, counter, (counter?.pending ?? 0) + 1);
      yield* send(tx, base, input.email, token);
      const row = yield* tx.db.get(invitationsTables.invitations, id);
      if (row === null) return yield* invariant("The invitation created in this transaction is missing.");
      return { ok: true, invitation: publicInvitation(row) } as const;
    }));
  });

  const resend = Effect.fn("auth.invitations.resend")(function* (call: AuthRequest, request: ActorRequest, id: string) {
    const base = yield* linkBase();
    const token = generateRandomToken();
    const tokenHash = yield* sha256Hex(token);
    return yield* runtime.mutation(call, Effect.fnUntraced(function* (tx) {
      if ((yield* actorFor(tx, request)) === null) return invitationRefused("account_access_forbidden");
      const row = yield* tx.db.get(invitationsTables.invitations, id);
      if (!invitationCanBeAccepted(row, tx.now)) return invalidInvitation();
      if (base === undefined) return invitationRefused("email_unavailable");
      // Rotate the token without extending the original delegation window.
      yield* tx.db.patch(invitationsTables.invitations, id, { tokenHash });
      yield* send(tx, base, row.email, token);
      return { ok: true, invitation: publicInvitation(row) } as const;
    }));
  });

  const revoke = (call: AuthRequest, request: ActorRequest, id: string) =>
    runtime.mutation(call, Effect.fnUntraced(function* (tx) {
      if ((yield* actorFor(tx, request)) === null) return invitationRefused("account_access_forbidden");
      const row = yield* tx.db.get(invitationsTables.invitations, id);
      if (row === null || row.status === "accepted") return invalidInvitation();
      if (row.status === "pending") yield* closeInvitation(tx, row, { status: "revoked" });
      return { ok: true, invitation: publicInvitation({ ...row, status: "revoked" }) } as const;
    }));

  return { list, create, resend, revoke };
}
