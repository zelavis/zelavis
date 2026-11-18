// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/lib/oauth/providerFunctions.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the registered Convex functions become Effects over a transaction (T1-T4) on the shared flow tables; only the accounts are the provider's own table, reached through an AccountStore.
/**
 * The functions behind a built-in provider's `provider.ts`.
 *
 * Every built-in provider has the same functions. The database work lives in
 * `dbHelpers.ts`. This module adds the provider's own accounts table to it.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import type { AuthTxBase } from "../../runtime/index.js";
import type { AuthRow, AuthTableRef } from "../../runtime/tables.js";
import * as dbHelpers from "./dbHelpers.js";
import type { AccountStore } from "./dbHelpers.js";

/** What this code requires from an account row. */
export type AccountRow = AuthRow & { readonly providerAccountId: string; readonly userId: string };

/** The accounts of one provider kept in a table of their own. */
export function accountStoreOf(table: AuthTableRef<AccountRow>): AccountStore {
  return {
    findUserId: (tx, providerAccountId) =>
      tx.db
        .query(table)
        .withIndex("providerAccountId", (q) => q.eq("providerAccountId", providerAccountId))
        .unique()
        .pipe(Effect.map((account) => account?.userId ?? null)),
    insert: (tx, { providerAccountId, userId }) => Effect.asVoid(tx.db.insert(table, { providerAccountId, userId })),
  };
}

/**
 * Build the functions of a built-in provider. The provider's `provider.ts`
 * destructures the result and exports each one.
 */
export function buildProviderFunctions(options: { readonly accounts: AccountStore }) {
  const claimAuthorizationRequest = dbHelpers.claimAuthorizationRequest;
  const createTicket = dbHelpers.insertTicket;
  const claimTicket = dbHelpers.claimTicket;
  /** The user id connected to a given provider account id, or `null` if there is none. */
  const getUserIdByAccount = (tx: AuthTxBase, args: { providerAccountId: string }) => options.accounts.findUserId(tx, args.providerAccountId);
  // DANGER: an unverified `userId` or `providerAccountId` lets an attacker
  // connect their provider account to another user's account.
  // TODO: ensure that the user ID is the current user.
  const _internal_dangerous_createAccount = (tx: AuthTxBase, args: { providerAccountId: string; userId: string }) =>
    dbHelpers.insertAccount(tx, options.accounts, args);
  return {
    claimAuthorizationRequest,
    createTicket,
    claimTicket,
    getUserIdByAccount,
    _internal_dangerous_createAccount,
  };
}
