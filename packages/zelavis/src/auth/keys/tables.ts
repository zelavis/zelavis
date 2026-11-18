import * as Schema from "effect/Schema";
import { defineTable, defineTables } from "../runtime/index.js";

/** The public half of an ES256 key as it is published in the JWKS. */
export const PublicJwkSchema = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: Schema.String,
  y: Schema.String,
  kid: Schema.String,
  alg: Schema.Literal("ES256"),
  use: Schema.Literal("sig"),
});
export type PublicJwk = typeof PublicJwkSchema.Type;

/** A private key sealed with the runtime's master secret (`encryptSecret`); never stored in the clear. */
export const SealedSchema = Schema.Struct({
  ciphertext: Schema.String,
  iv: Schema.String,
  tag: Schema.String,
  algorithm: Schema.Literal("AES-256-GCM"),
});

export const keysTables = defineTables("keys", {
  // One row per signing key. The active key has no `retiredAt`; a retired key
  // is published, and so verifies tokens, until the longest access token it
  // signed has expired.
  signingKeys: defineTable({
    kid: Schema.String,
    publicJwk: PublicJwkSchema,
    sealedPrivateJwk: SealedSchema,
    createdAt: Schema.Number,
    retiredAt: Schema.optional(Schema.Number),
  }).index("by_kid", ["kid"]),
  // At most one row: the id this runtime's tokens name in their issuer.
  keySet: defineTable({
    keySetId: Schema.String,
  }),
});
