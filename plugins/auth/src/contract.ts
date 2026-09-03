/**
 * The contract an OAuth provider plugin satisfies.
 *
 * `@zelavis/auth` owns the capability `@zelavis/auth:oauth`. A plugin
 * declaring it supplies a *definition* — the endpoints and claim mapping for
 * one identity provider — and never its credentials: those belong to the
 * operator, differ per installation, and cannot ship in a package.
 *
 * That split is why the definition is data rather than a configured provider.
 * A package that had to be constructed with a client secret could only ever be
 * composed in code, and services are installed now, not composed.
 */

/** Capability an OAuth provider plugin declares to be discovered by this one. */
export const OAUTH_PROVIDER_CAPABILITY = "@zelavis/auth:oauth";

export interface OAuthIdentityClaims {
  readonly [claim: string]: unknown;
}

export interface OAuthIdentity {
  /** Stable identifier for this account at the provider. */
  identifier: string;
  email?: string;
  username?: string;
  displayName?: string;
  verified?: boolean;
  metadata?: Record<string, unknown>;
}

export interface OAuthProviderDefinition {
  /** Provider name, used in the sign-in URL and stored on the credential. */
  readonly name: string;
  /** Human-readable name for a dashboard listing. */
  readonly title?: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  /** Scopes always requested, on top of anything the operator adds. */
  readonly scopes?: readonly string[];
  /**
   * OpenID Connect issuer. Present means the token response carries an ID
   * token, which is verified against `jwksUrl` before anything in it is
   * believed.
   */
  readonly issuer?: string;
  readonly jwksUrl?: string;
  readonly algorithms?: readonly string[];
  /**
   * Endpoint returning the signed-in user, for providers with no ID token.
   * Called with the access token.
   */
  readonly userInfoEndpoint?: string;
  /** Turns provider claims into an identity Zelavis can store. */
  readonly mapIdentity?: (claims: OAuthIdentityClaims) => OAuthIdentity | undefined;
}

/** The shape an OAuth provider plugin exports as its service. */
export interface OAuthProviderService {
  readonly name: string;
  readonly kind: "plugin";
  readonly capabilities: readonly string[];
  readonly service: { readonly oauthProviders: readonly OAuthProviderDefinition[] };
}

export function defineOAuthProviders(
  name: string,
  providers: readonly OAuthProviderDefinition[],
): OAuthProviderService {
  if (!providers.length) {
    throw new TypeError(`${name} must define at least one OAuth provider.`);
  }
  for (const provider of providers) {
    if (!provider.name?.trim()) {
      throw new TypeError(`${name} defines an OAuth provider with no name.`);
    }
    if (provider.issuer && !provider.jwksUrl) {
      // An issuer with no key set means an ID token nobody can verify, and an
      // unverified ID token is attacker-supplied JSON.
      throw new TypeError(
        `${name} declares an issuer for "${provider.name}" but no jwksUrl, so its ID tokens could not be verified.`,
      );
    }
  }

  return Object.freeze({
    name,
    kind: "plugin" as const,
    capabilities: Object.freeze([OAUTH_PROVIDER_CAPABILITY]),
    service: Object.freeze({ oauthProviders: Object.freeze([...providers]) }),
  });
}
