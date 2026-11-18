// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/lib/oauth/schema.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: tables are declared through defineTable/defineTables (T5). Every provider shares one `oauth_authorizationRequests` and one `oauth_tickets` table (each row names its `providerName`, as the generic component's do) instead of one pair per provider component; `nonce` is added to the request; both tables have a `by_expiresAt` index for the sweep; `accountsTable` is the table every built-in provider module spreads into its own.
/**
 * The required table fields for OAuth providers. A provider with extra
 * fields spreads these into its own tables.
 *
 * @module
 */
import * as Schema from "effect/Schema";
import { defineTable, defineTables } from "../../runtime/index.js";

/**
 * An authorization request is created when sign-in starts, and the
 * provider's callback claims it.
 */
export const authorizationRequestFields = {
  /** Hash of the server-minted state. The raw value is never stored. */
  stateHash: Schema.String,
  /** Post-login destination, validated against allowed redirects at sign-in. */
  redirectTo: Schema.String,
  /** The OAuth `redirect_uri`. */
  callbackUrl: Schema.String,
  /**
   * The raw PKCE code verifier, sent to the provider at code exchange. Every
   * provider gets a challenge, because a provider without PKCE support
   * ignores the parameters.
   */
  codeVerifier: Schema.String,
  /** The callback rejects requests older than this. */
  expiresAt: Schema.Number,
};

/**
 * A ticket is proof that the provider authenticated the user. The callback
 * creates it after the code exchange. A caller redeems it once by presenting
 * the raw ticket code and the original state. No account, user, or session is
 * created until then.
 */
export const ticketFields = {
  /**
   * Carried over from the authorization request. Redemption re-checks the
   * caller-presented state against it, binding completion to the browser
   * or server that initiated the flow.
   */
  stateHash: Schema.String,
  /**
   * sha256 of the server-minted ticket code. The raw value appears only
   * in the callback redirect URL and is never stored.
   */
  ticketCodeHash: Schema.String,
  /** Redemption rejects tickets past this. Set at mint. */
  expiresAt: Schema.Number,
  /**
   * The identity the provider attested, as JSON, AES-GCM encrypted with a key
   * derived from the raw ticket code. The raw code is never stored, so
   * database access alone cannot read the payload, and provider-chosen JSON
   * keys never become field names.
   */
  encryptedPayload: Schema.String,
};

export const authorizationRequestsTable = defineTable({
  ...authorizationRequestFields,
  /** The provider the request was issued for, e.g. "google" or the name of an OpenID Connect connection. */
  providerName: Schema.String,
  /** The connection revision that started the flow. */
  connectionRevision: Schema.String,
  /** The OpenID Connect nonce the id_token must echo; absent for a provider that returns none. */
  nonce: Schema.optional(Schema.String),
})
  .index("stateHash", ["stateHash"])
  // For the sweep (see sweep.ts).
  .index("by_expiresAt", ["expiresAt"]);

export const ticketsTable = defineTable({
  ...ticketFields,
  /** The provider that authenticated the user. */
  providerName: Schema.String,
  /** Carried from the authorization request and checked at redemption. */
  connectionRevision: Schema.String,
})
  .index("ticketCodeHash", ["ticketCodeHash"])
  // For the sweep (see sweep.ts).
  .index("by_expiresAt", ["expiresAt"]);

/** The tables of the flow every provider shares. */
export const oauthFlowTables = defineTables("oauth", {
  authorizationRequests: authorizationRequestsTable,
  tickets: ticketsTable,
});

/**
 * An account connects a provider account id to an account id.
 */
export const accountFields = {
  /**
   * The `id` from the provider's profile mapping, unique within that
   * provider.
   */
  providerAccountId: Schema.String,
  /** The user id returned by the runtime's `createUser` callback. */
  userId: Schema.String,
};

export const accountsTable = defineTable(accountFields).index("providerAccountId", ["providerAccountId"]);
