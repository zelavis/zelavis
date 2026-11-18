/**
 * Account administration (Zelavis-own): listing accounts, creating one with
 * its username and password in one request, and the administrator's view of
 * an account, which carries no secret (no password hash, no token hash).
 *
 * Every operation re-reads the administrator inside its transaction
 * (`resolveActor`) and applies Identity's delegation rules there.
 */
import * as Effect from "effect/Effect";
import type { ZelavisPrincipal } from "../../core/index.js";
import { type AdministrationContext, type AdministrationRefusal, canDelegateAccess, refuse, resolveActor } from "../access/delegation.js";
import { createAdmittedAccount } from "../accounts/accounts.js";
import { type Account, accountsTables } from "../accounts/tables.js";
import type { AuthTx } from "../core/context.js";
import { getPrimaryEmail } from "../email/verifiedEmails.js";
import { _internal_dangerous_setPassword } from "../password/public.js";
import { invariant } from "../runtime/index.js";
import { recordSecurityEvent } from "../security/events.js";
import { getUserIdByUsername, getUsername, setUsername } from "../username/public.js";

/** A page makes two identifier lookups per human account within a 256-query transaction. */
export const ACCOUNT_PAGE_LIMIT = 100;

/** The roles an administrator may give a new account here; the first is the default. */
export const creatableRoles = (context: AdministrationContext): ReadonlyArray<string> =>
  context.authority === "platform" ? ["customer", "operator", "reseller"] : ["user"];

export interface AdministrativeAccount {
  readonly id: string;
  readonly kind: Account["kind"];
  readonly username?: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly roles: ReadonlyArray<string>;
  readonly permissions: ReadonlyArray<string>;
  readonly grants: Account["grants"];
  readonly roleAssignments: NonNullable<Account["roleAssignments"]>;
  readonly accessRevision: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly lastSignInAt?: string;
}

/** What an administrator sees of an account. */
export const administrativeAccount = Effect.fn("auth.admin.view")(function* (tx: AuthTx, account: Account) {
  const username = account.kind === "human" ? yield* getUsername(tx, { userId: account._id }) : null;
  const email = account.kind === "human" ? yield* getPrimaryEmail(tx, { userId: account._id }) : null;
  return {
    id: account._id,
    kind: account.kind,
    ...(username === null ? {} : { username }),
    ...(email === null ? {} : { email }),
    ...(account.displayName === undefined ? {} : { displayName: account.displayName }),
    roles: [...account.roles],
    permissions: [...account.permissions],
    grants: account.grants.map((grant) => ({ ...grant })),
    roleAssignments: (account.roleAssignments ?? []).map((assignment) => ({ ...assignment })),
    accessRevision: account.accessRevision,
    ...(account.metadata === undefined ? {} : { metadata: { ...account.metadata } }),
    createdAt: new Date(account._creationTime).toISOString(),
    ...(account.lastSignInAt === undefined ? {} : { lastSignInAt: new Date(account.lastSignInAt).toISOString() }),
  } satisfies AdministrativeAccount;
});

/**
 * A page of accounts in creation order. `after` is the `next` of the page
 * before; `accountId` restricts the list to that one account.
 */
export const listAccounts = Effect.fn("auth.admin.listAccounts")(function* (
  tx: AuthTx,
  args: { readonly principal: ZelavisPrincipal | undefined; readonly context: AdministrationContext; readonly limit: number; readonly after?: number | undefined; readonly accountId?: string | undefined },
) {
  if ((yield* resolveActor(tx, args.principal, args.context)) === null) return refuse("account_access_forbidden");
  if (args.accountId !== undefined) {
    const account = yield* tx.db.get(accountsTables.accounts, args.accountId);
    return { ok: true, accounts: account === null ? [] : [yield* administrativeAccount(tx, account)] } as const;
  }
  const limit = Math.max(1, Math.min(ACCOUNT_PAGE_LIMIT, Math.floor(args.limit)));
  const after = args.after;
  const rows = yield* tx.db.query(accountsTables.accounts)
    .withIndex("by_creation_time", after === undefined ? undefined : (q) => q.gt("_creationTime", after))
    .take(limit + 1);
  const page = rows.slice(0, limit);
  const accounts: AdministrativeAccount[] = [];
  for (const row of page) accounts.push(yield* administrativeAccount(tx, row));
  const last = page[page.length - 1];
  return { ok: true, accounts, ...(rows.length > limit && last !== undefined ? { next: last._creationTime } : {}) } as const;
});

export type CreateAccountRefusal = AdministrationRefusal | { readonly ok: false; readonly code: "username_taken" | "invalid_role" };

/**
 * Create an account with a username and password (hashed by the caller,
 * outside the transaction). The role must be one an administrator gives here
 * and one the actor holds or may give. No registration gate applies: an
 * administrator admits the account.
 */
export const createAccount = Effect.fn("auth.admin.createAccount")(function* (
  tx: AuthTx,
  args: {
    readonly principal: ZelavisPrincipal | undefined;
    readonly context: AdministrationContext;
    readonly username: string;
    readonly passwordHashPHC: string;
    readonly displayName?: string | undefined;
    readonly role?: string | undefined;
  },
) {
  const actor = yield* resolveActor(tx, args.principal, args.context);
  if (actor === null) return refuse("account_access_forbidden");
  const roles = creatableRoles(args.context);
  const role = args.role ?? roles[0]!;
  if (!roles.includes(role)) return { ok: false, code: "invalid_role" } as const;
  if (!canDelegateAccess(actor, args.context, { roles: [role] })) return refuse("account_access_forbidden");
  if ((yield* getUserIdByUsername(tx, { username: args.username })) !== null) return { ok: false, code: "username_taken" } as const;
  const userId = yield* createAdmittedAccount(tx, { kind: "human", displayName: args.displayName, roles: [role], permissions: [], grants: [] });
  const saved = yield* setUsername(tx, { userId, username: args.username });
  if (!saved.success) return yield* invariant(`The validated username was refused: ${saved.userError.error}`);
  yield* _internal_dangerous_setPassword(tx, { userId, passwordHashPHC: args.passwordHashPHC });
  yield* recordSecurityEvent(tx, { kind: "account.created", accountId: userId, actorId: actor.id, detail: { by: "administrator" } });
  const account = yield* tx.db.get(accountsTables.accounts, userId);
  if (account === null) return yield* invariant("The account created in this transaction is missing");
  return { ok: true, account: yield* administrativeAccount(tx, account) } as const;
});
