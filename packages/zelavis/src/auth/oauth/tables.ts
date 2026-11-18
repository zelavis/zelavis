// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/oauth/schema.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: tables are declared through defineTables (T5). One `oauth_accounts` table serves all OpenID Connect issuers; requests, tickets and connections live in their own tables.
import * as Schema from "effect/Schema";
import { SealedSchema } from "../keys/tables.js";
import { accountFields } from "../lib/oauth/schema.js";
import { defineTable, defineTables } from "../runtime/index.js";

/** What discovery read from an issuer's own metadata; cached so a restart needs no network. */
export const DiscoveredIssuerSchema = Schema.Struct({
  issuer: Schema.String,
  authorizationEndpoint: Schema.String,
  tokenEndpoint: Schema.String,
  jwksUrl: Schema.String,
  algorithms: Schema.optional(Schema.Array(Schema.String)),
  /** When the metadata was read, in milliseconds; it is read again when older than a day. */
  discoveredAt: Schema.Number,
});
export type DiscoveredIssuer = typeof DiscoveredIssuerSchema.Type;

export const oauthTables = defineTables("oauth", {
  // An OpenID Connect subject identifies a user within the verified issuer.
  accounts: defineTable({
    issuer: Schema.String,
    ...accountFields,
  }).index("by_issuer_providerAccountId", ["issuer", "providerAccountId"]),
});

export const oauthConnectionsTables = defineTables("oauthConnections", {
  // An operator's credentials for one identity provider. The client id and secret are issued per installation by
  // the provider, so they cannot ship in a package. The secret is stored sealed and never returned.
  connections: defineTable({
    // `google`, `apple`, `github`, or the name an OpenID Connect issuer was connected under.
    provider: Schema.String,
    revision: Schema.String,
    // Removing a stored override retains a new revision for the environment fallback.
    useEnvironment: Schema.optional(Schema.Boolean),
    // The OIDC issuer a generic provider was discovered from.
    issuer: Schema.optional(Schema.String),
    discovered: Schema.optional(DiscoveredIssuerSchema),
    clientId: Schema.String,
    // For Apple, the contents of the `.p8` private key.
    sealedClientSecret: Schema.optional(SealedSchema),
    // Apple's team id and key id.
    teamId: Schema.optional(Schema.String),
    keyId: Schema.optional(Schema.String),
    redirectUri: Schema.String,
    scopes: Schema.optional(Schema.Array(Schema.String)),
    enabled: Schema.Boolean,
    updatedAt: Schema.String,
  }).index("by_provider", ["provider"]),
});
