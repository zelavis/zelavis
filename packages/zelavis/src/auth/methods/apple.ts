// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/methods/apple/server.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the profile validator is an Effect Schema (T5); a missing id_token or userinfo entry is a thrown Error that becomes a defect (T8). The setup lives in methods/oauth.ts, which binds every provider; only the profile mapping is here.
/**
 * The `apple` sign-in method's profile.
 *
 * @module
 */
import * as Schema from "effect/Schema";
import type { OidcClaims } from "../lib/oauth/redemption.js";
import type { SanitizedAppleUser } from "../apple/user.js";

export type { SanitizedAppleUser };

/** The name of this sign-in method. The runtime's user callbacks get it as `method.name`. */
export const METHOD_NAME = "apple";

/**
 * The account profile that the `apple` method produces. Apple is OIDC, so
 * identity comes from validated id_token claims, with the name (when there
 * is one) coming from the callback instead. This is the exact shape the
 * mapping emits, so the app can validate against it precisely.
 */
export const AppleProfile = Schema.Struct({
  /** Apple's `sub` claim, the stable provider account id. */
  id: Schema.String,
  /**
   * The email Apple attested. It is a per-app relay address
   * (`...@privaterelay.appleid.com`) for anyone who chose to hide theirs.
   *
   * Optional for two reasons: Apple only sends it when the email scope was
   * granted, and a Managed Apple Account may have no address at all, since
   * schools often issue none.
   */
  email: Schema.optional(Schema.String),
  /**
   * True when Apple attested the email as verified (the `email_verified`
   * claim). Apple returns verified addresses for personal Apple Accounts, so
   * a false comes from Sign in with Apple at Work & School or from the claim
   * being absent.
   */
  emailVerified: Schema.Boolean,
  /**
   * The name the person gave at sign-up, if they gave one. Apple sends it
   * exactly once, on the first authorization, and never again, so a return
   * visit produces a profile without it. It is also the one part of the
   * profile the browser relayed rather than Apple attesting to it, which
   * makes it user-controlled display data: escape it like any other text a
   * user typed, and don't key anything off it.
   */
  name: Schema.optional(Schema.String),
});

export type AppleProfile = typeof AppleProfile.Type;

/**
 * Map Apple's validated id_token claims, plus the sanitized name from a
 * first authorization, to {@link AppleProfile}.
 *
 * `user` is undefined on every sign-in after the first, which is why the
 * profile's `name` is optional. An app that wants to keep the name should
 * store it when it arrives and leave the stored one alone when it doesn't.
 */
export function normalizeAppleProfile(
  claims: OidcClaims,
  user: SanitizedAppleUser | undefined,
): AppleProfile {
  const parts = [user?.name.firstName, user?.name.lastName].filter(
    (part) => part !== undefined,
  );
  return {
    id: claims.sub,
    email: claims.email,
    // Apple sends the string "true"/"false" for some accounts and a boolean
    // for others.
    emailVerified:
      claims.email_verified === true || claims.email_verified === "true",
    name: parts.length === 0 ? undefined : parts.join(" "),
  };
}
