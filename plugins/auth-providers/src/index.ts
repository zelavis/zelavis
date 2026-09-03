import {
  defineOAuthProviders,
  type OAuthIdentity,
  type OAuthIdentityClaims,
  type OAuthProviderDefinition,
} from "@zelavis/auth";

/**
 * Identity provider definitions for `@zelavis/auth`.
 *
 * Endpoints and claim shapes only. Nothing here is installation-specific,
 * which is what makes it shippable: the client id and secret an installation
 * was issued are configured by the operator against the provider name.
 */

export const googleProvider: OAuthProviderDefinition = {
  name: "google",
  title: "Google",
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  issuer: "https://accounts.google.com",
  jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
  scopes: ["email", "profile"],
};

export const githubProvider: OAuthProviderDefinition = {
  name: "github",
  title: "GitHub",
  authorizationEndpoint: "https://github.com/login/oauth/authorize",
  tokenEndpoint: "https://github.com/login/oauth/access_token",
  // GitHub issues no ID token, so the identity comes from the API instead and
  // is trusted because the call is made with a freshly exchanged token.
  userInfoEndpoint: "https://api.github.com/user",
  scopes: ["read:user", "user:email"],
  mapIdentity(claims: OAuthIdentityClaims): OAuthIdentity | undefined {
    if (typeof claims.id !== "number" && typeof claims.id !== "string") {
      return undefined;
    }
    return {
      // The numeric id, not the login: a GitHub username can be changed and
      // reused by someone else, which would hand them an existing account.
      identifier: String(claims.id),
      ...(typeof claims.email === "string"
        ? { email: claims.email.toLowerCase() }
        : {}),
      ...(typeof claims.login === "string" ? { username: claims.login } : {}),
      ...(typeof claims.name === "string" ? { displayName: claims.name } : {}),
      // GitHub's /user does not say whether the address is verified, so it is
      // not claimed to be.
      verified: false,
    };
  },
};

export interface GenericOidcOptions {
  name?: string;
  title?: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUrl: string;
  scopes?: readonly string[];
  algorithms?: readonly string[];
}

/** Builds a definition for any standards-compliant OIDC issuer. */
export function oidcProvider(
  options: GenericOidcOptions,
): OAuthProviderDefinition {
  return {
    name: options.name ?? "oidc",
    title: options.title ?? "Single sign-on",
    authorizationEndpoint: options.authorizationEndpoint,
    tokenEndpoint: options.tokenEndpoint,
    issuer: options.issuer,
    jwksUrl: options.jwksUrl,
    scopes: options.scopes ?? ["email", "profile"],
    ...(options.algorithms ? { algorithms: options.algorithms } : {}),
  };
}

export default defineOAuthProviders("@zelavis/auth-providers", [
  googleProvider,
  githubProvider,
]);
