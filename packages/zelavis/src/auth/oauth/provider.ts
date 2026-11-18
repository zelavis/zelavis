// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/oauth/provider.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the functions are Effects over a transaction (T1-T4) on the shared `oauth_` tables; the accounts are those of one connection.
import * as Effect from "effect/Effect";
import type { AccountStore } from "../lib/oauth/dbHelpers.js";
import { oauthTables } from "./tables.js";

/** The accounts of one verified issuer, in the shared `oauth_accounts` table. */
export const oauthAccounts = (issuer: string): AccountStore => ({
  findUserId: (tx, providerAccountId) =>
    tx.db
      .query(oauthTables.accounts)
      .withIndex("by_issuer_providerAccountId", (q) => q.eq("issuer", issuer).eq("providerAccountId", providerAccountId))
      .unique()
      .pipe(Effect.map((account) => account?.userId ?? null)),
  insert: (tx, { providerAccountId, userId }) => Effect.asVoid(tx.db.insert(oauthTables.accounts, { issuer, providerAccountId, userId })),
});
