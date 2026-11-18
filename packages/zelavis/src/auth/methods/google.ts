// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/methods/google/server.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the profile validator is an Effect Schema (T5); a missing id_token or userinfo entry is a thrown Error that becomes a defect (T8). The setup lives in methods/oauth.ts, which binds every provider; only the profile mapping is here.
/**
 * The `google` sign-in method's profile.
 *
 * @module
 */
import * as Schema from "effect/Schema";
import type { OidcClaims } from "../lib/oauth/redemption.js";

/** The name of this sign-in method. The runtime's user callbacks get it as `method.name`. */
export const METHOD_NAME = "google";

/**
 * The account profile that the `google` method produces. Google is OIDC, so
 * identity comes from validated id_token claims. This is the exact shape the
 * mapping emits, so the app can validate against it precisely.
 */
export const GoogleProfile = Schema.Struct({
  /** Google's `sub` claim, the stable provider account id. */
  id: Schema.String,
  email: Schema.optional(Schema.String),
  /**
   * True when Google attested the email as verified (the `email_verified`
   * claim). False means unverified or the claim was absent, so don't trust
   * the email for account linking.
   */
  emailVerified: Schema.Boolean,
  /**
   * The Google Workspace domain of the account (the `hd` claim), absent for a
   * personal Google account. Google says to check this claim, not the domain
   * of the email, to know that an account belongs to a Workspace domain: a
   * personal account can be made on an address of any domain.
   */
  hostedDomain: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  picture: Schema.optional(Schema.String),
});

export type GoogleProfile = typeof GoogleProfile.Type;

/**
 * Map validated Google id_token claims to {@link GoogleProfile}. Google
 * returns an id_token, so `claims` is always present here. A missing one is
 * a bug.
 */
export function normalizeGoogleProfile(
  claims: OidcClaims | undefined,
): GoogleProfile {
  if (claims === undefined) {
    throw new Error("Google returned no id_token to build a profile from");
  }
  return {
    id: claims.sub,
    email: claims.email,
    emailVerified: claims.email_verified === true,
    hostedDomain: typeof claims.hd === "string" ? claims.hd : undefined,
    name: claims.name,
    picture: claims.picture,
  };
}
