import type {
  OAuthIdentity,
  OAuthIdentityClaims,
  OAuthProviderDefinition,
} from "./contract.js";

/**
 * Identity providers this package knows about out of the box.
 *
 * Endpoints and claim shapes only. Nothing here is installation-specific,
 * which is what makes it shippable: the client id and secret an installation
 * was issued are configured by the operator against the provider name.
 *
 * They live here rather than in a package of their own. A separate bundle of
 * definitions was neither the plugin an operator installs nor a provider on
 * its own, and it made a build-order dependency out of two files of constants.
 * A provider someone else ships is still an ordinary plugin declaring
 * `@zelavis/auth:oauth`; nothing about these is privileged.
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

/** Provider definitions this package registers without anything else installed. */
export const builtInOAuthProviders: readonly OAuthProviderDefinition[] =
  Object.freeze([googleProvider, githubProvider]);
