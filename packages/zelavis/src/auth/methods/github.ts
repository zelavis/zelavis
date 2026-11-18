// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/methods/github/server.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the profile validator is an Effect Schema (T5); a missing id_token or userinfo entry is a thrown Error that becomes a defect (T8). The setup lives in methods/oauth.ts, which binds every provider; only the profile mapping is here.
/**
 * The `github` sign-in method's profile.
 *
 * @module
 */
import * as Schema from "effect/Schema";
import type { GithubUserInfo } from "../github/constants.js";

export type { GithubUserInfo };

/** The name of this sign-in method. The runtime's user callbacks get it as `method.name`. */
export const METHOD_NAME = "github";

/**
 * The account profile that the `github` method produces. GitHub is plain OAuth
 * (no id_token), so identity comes from its userinfo endpoints. This is the
 * exact shape the mapping emits, so the app can validate against it
 * precisely.
 */
export const GithubProfile = Schema.Struct({
  /** GitHub's numeric user id as a string, the stable provider account id. */
  id: Schema.String,
  login: Schema.String,
  name: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  /**
   * True when the email came from a verified `/user/emails` entry. False
   * means it fell back to the `/user` public profile email, whose
   * verification status is unknown, so don't trust it for account linking.
   */
  emailVerified: Schema.Boolean,
  avatarUrl: Schema.optional(Schema.String),
});

export type GithubProfile = typeof GithubProfile.Type;

/** Map GitHub's userinfo responses to {@link GithubProfile}. */
export function normalizeGithubProfile(
  userInfoResponses: GithubUserInfo | undefined,
): GithubProfile {
  const user = userInfoResponses?.user;
  if (user === undefined) {
    throw new Error("GitHub userinfo response is missing the `user` entry");
  }
  // The response is untrusted JSON, and String() would turn a missing id
  // into the literal string "undefined", collapsing every affected user
  // into one account. A missing `login` needs no such check: it fails the
  // profile validator instead of corrupting anything.
  if (typeof user.id !== "number" && typeof user.id !== "string") {
    throw new Error("GitHub userinfo `user` entry is missing an id");
  }
  const emails = userInfoResponses?.emails ?? [];
  const verifiedEmail =
    emails.find((entry) => entry.primary && entry.verified) ??
    emails.find((entry) => entry.verified);
  return {
    id: String(user.id),
    login: user.login,
    name: user.name ?? user.login,
    email: verifiedEmail?.email ?? user.email ?? undefined,
    emailVerified: verifiedEmail !== undefined,
    avatarUrl: user.avatar_url,
  };
}
