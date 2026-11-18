/**
 * The accounts module (Zelavis-own): creating the account a sign-up makes,
 * noting a sign-in, and reading an account. The registration policy admits a
 * sign-up before `create` runs (the core's `completeSignUp`); the accounts
 * the Zelavis modules make themselves (the bootstrap owner, administrator
 * creation, import, service accounts) are created with
 * `createAdmittedAccount`, which no gate stops.
 */
import * as Effect from "effect/Effect";
import type { TransactionTooLarge } from "../../db/errors.js";
import type { AuthTx } from "../core/context.js";
import type { AuthTxBase } from "../runtime/index.js";
import type { CreateUserFn, OnSignInFn } from "../lib/types.js";
import { type Account, accountsTables } from "./tables.js";

export const createAccount = Effect.fn("auth.accounts.create")(function* (tx: AuthTx, { method }: { method: { name: string; profile: unknown } }) {
  const { profile } = method;
  const name = typeof profile === "object" && profile !== null && "displayName" in profile
    && typeof profile.displayName === "string" && profile.displayName.length <= 200 ? profile.displayName.trim() : "";
  return yield* createAdmittedAccount(tx, {
    kind: "human",
    ...(name ? { displayName: name } : {}),
    roles: tx.signUpRoles,
    permissions: [],
    grants: [],
  });
});

/** An account made by a Zelavis module rather than a sign-up: the caller has already decided it may exist. */
export const createAdmittedAccount = Effect.fn("auth.accounts.createAdmitted")(function* (tx: AuthTxBase, args: {
  readonly kind: Account["kind"];
  readonly displayName?: string | undefined;
  readonly roles: ReadonlyArray<string>;
  readonly permissions: ReadonlyArray<string>;
  readonly grants: Account["grants"];
  readonly roleAssignments?: Account["roleAssignments"];
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}) {
  return yield* tx.db.insert(accountsTables.accounts, {
    kind: args.kind,
    ...(args.displayName === undefined ? {} : { displayName: args.displayName }),
    roles: [...args.roles],
    permissions: [...args.permissions],
    grants: args.grants.map((grant) => ({ ...grant })),
    ...(args.roleAssignments === undefined ? {} : { roleAssignments: args.roleAssignments.map((assignment) => ({ ...assignment })) }),
    accessRevision: 0,
    ...(args.metadata === undefined ? {} : { metadata: { ...args.metadata } }),
  });
});

export const accountSignedIn = Effect.fn("auth.accounts.signedIn")(function* (tx: AuthTx, args: { userId: string; method: { name: string; profile: unknown } }) {
  const account = yield* tx.db.get(accountsTables.accounts, args.userId);
  if (account !== null) yield* tx.db.patch(accountsTables.accounts, account._id, { lastSignInAt: tx.now });
});

export const getAccount = (tx: AuthTxBase, accountId: string): Effect.Effect<Account | null, TransactionTooLarge> =>
  tx.db.get(accountsTables.accounts, accountId);

export interface AccountsModule {
  readonly tables: typeof accountsTables;
  readonly get: typeof getAccount;
  /** The `createUser` a method binds with by default. */
  readonly createUser: CreateUserFn<unknown>;
  /** The `onSignIn` a method binds with by default. */
  readonly onSignIn: OnSignInFn<unknown>;
}

export const accountsModule: AccountsModule = {
  tables: accountsTables,
  get: getAccount,
  createUser: (tx, args) => createAccount(tx, args),
  onSignIn: (tx, args) => accountSignedIn(tx, args),
};
