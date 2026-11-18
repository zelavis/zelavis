// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/github/provider.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the functions are Effects over a transaction (T1-T4) on the module's accounts table.
import { accountStoreOf, buildProviderFunctions } from "../lib/oauth/providerFunctions.js";
import { githubTables } from "./tables.js";

export const githubAccounts = accountStoreOf(githubTables.accounts);

export const {
  claimAuthorizationRequest,
  createTicket,
  claimTicket,
  getUserIdByAccount,
  _internal_dangerous_createAccount,
} = buildProviderFunctions({ accounts: githubAccounts });
