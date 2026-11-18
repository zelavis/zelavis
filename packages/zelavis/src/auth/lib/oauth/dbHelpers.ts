// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/lib/oauth/dbHelpers.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: helpers are Effects over a transaction (T1-T3) on the shared flow tables; the callback URL is given (the connection's `redirectUri`) rather than read from `CONVEX_SITE_URL`; accounts go through an `AccountStore` because the generic module keeps one table for many providers; an invariant breach is a defect (T8).
/**
 * The database work behind every OAuth provider.
 *
 * An OAuth flow needs two short-lived documents: an authorization request,
 * written when sign-in starts and claimed by the provider callback, and a
 * ticket, minted by the callback and redeemed by the app. Each OAuth provider
 * also keeps a durable account per identity, connecting a provider account id
 * to a user id. The reads and writes live here.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import type { TransactionTooLarge } from "../../../db/errors.js";
import { type AuthTxBase, invariant } from "../../runtime/index.js";
import { oauthFlowTables } from "./schema.js";

/** How long an authorization request stays claimable by the callback. */
export const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000; // 10m

/** How long a minted ticket stays redeemable. Redemption is normally the
 * page load right after the callback redirect, so this only needs slack
 * for slow devices and networks. */
export const TICKET_TTL_MS = 2 * 60 * 1000;

/** The accounts of one provider: how a provider's module reads and writes its own table. */
export interface AccountStore {
  /** The user id connected to a provider account id, or `null` if there is none. */
  findUserId(tx: AuthTxBase, providerAccountId: string): Effect.Effect<string | null, TransactionTooLarge>;
  /** Connects a provider account id to a user. */
  insert(tx: AuthTxBase, account: { providerAccountId: string; userId: string }): Effect.Effect<void, TransactionTooLarge>;
}

/**
 * Record an in-flight authorization request. Called by `startSignIn` before
 * it redirects the user to the provider; the provider callback later claims
 * the request by state hash.
 */
export const insertAuthorizationRequest = Effect.fn("auth.lib.oauth.insertAuthorizationRequest")(function* (
  tx: AuthTxBase,
  fields: { providerName: string; connectionRevision: string; stateHash: string; redirectTo: string; callbackUrl: string; codeVerifier: string; nonce?: string },
) {
  yield* tx.db.insert(oauthFlowTables.authorizationRequests, {
    ...fields,
    expiresAt: tx.now + AUTHORIZATION_REQUEST_TTL_MS,
  });
});

/**
 * The second half of the OAuth flow: after the user authenticates, the
 * provider redirects back to the callback route, which calls this to claim
 * the matching request by state hash.
 *
 * Finding, deleting, and checking the deadline happen in one transaction, so
 * a replayed or raced callback finds nothing. An expired request gives back
 * only where the user came from, because that is all the callback can still
 * use: it would rather send them back to the app than strand them.
 */
export const claimAuthorizationRequest = Effect.fn("auth.lib.oauth.claimAuthorizationRequest")(function* (tx: AuthTxBase, stateHash: string) {
  const request = yield* tx.db
    .query(oauthFlowTables.authorizationRequests)
    .withIndex("stateHash", (q) => q.eq("stateHash", stateHash))
    .unique();
  if (request === null) {
    return null;
  }
  yield* tx.db.delete(oauthFlowTables.authorizationRequests, request._id);
  if (request.expiresAt < tx.now) {
    return { expired: true, redirectTo: request.redirectTo } as const;
  }
  return { expired: false, doc: request } as const;
});

/**
 * Store a one-time redeemable ticket after a successful code exchange. The
 * caller (the callback) holds the raw ticket code; only its hash is stored,
 * and the identity payload arrives already encrypted with a key derived from
 * that code.
 */
export const insertTicket = Effect.fn("auth.lib.oauth.insertTicket")(function* (
  tx: AuthTxBase,
  fields: { providerName: string; connectionRevision: string; stateHash: string; ticketCodeHash: string; encryptedPayload: string },
) {
  yield* tx.db.insert(oauthFlowTables.tickets, { ...fields, expiresAt: tx.now + TICKET_TTL_MS });
});

/**
 * Claim a ticket by ticket code hash: find, check, delete, and return it in
 * one transaction, so a replayed or raced redemption finds nothing.
 *
 * The caller must also present the hash of the state minted at sign-in, which
 * binds redemption to the client that initiated the flow, and the provider
 * name, so a ticket of one provider cannot be redeemed into another's
 * account namespace.
 */
export const claimTicket = Effect.fn("auth.lib.oauth.claimTicket")(function* (
  tx: AuthTxBase,
  args: { ticketCodeHash: string; stateHash: string; providerName: string; connectionRevision: string },
) {
  const ticket = yield* tx.db
    .query(oauthFlowTables.tickets)
    .withIndex("ticketCodeHash", (q) => q.eq("ticketCodeHash", args.ticketCodeHash))
    .unique();
  if (ticket === null) {
    return null;
  }
  if (ticket.expiresAt < tx.now) {
    yield* tx.db.delete(oauthFlowTables.tickets, ticket._id);
    return null;
  }
  if (ticket.stateHash !== args.stateHash || ticket.providerName !== args.providerName || ticket.connectionRevision !== args.connectionRevision) {
    return null;
  }
  yield* tx.db.delete(oauthFlowTables.tickets, ticket._id);
  return { encryptedPayload: ticket.encryptedPayload };
});

/**
 * Create an account connecting `providerAccountId` to `userId`. A defect if
 * that provider account id already has an account, since it must never map
 * to two users.
 */
export const insertAccount = Effect.fn("auth.lib.oauth.insertAccount")(function* (
  tx: AuthTxBase,
  store: AccountStore,
  account: { providerAccountId: string; userId: string },
) {
  const existing = yield* store.findUserId(tx, account.providerAccountId);
  if (existing !== null) {
    return yield* invariant(
      `Invariant violation: an account for provider account id ${JSON.stringify(account.providerAccountId)} already exists`,
    );
  }
  yield* store.insert(tx, account);
});
