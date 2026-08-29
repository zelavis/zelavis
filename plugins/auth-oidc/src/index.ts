import {
  createJwksAuthenticator,
  type ZelavisPrincipal,
} from "zelavis/core";
import type {
  AuthMethodPlugin,
  CredentialProvider,
} from "zelavis/app/auth";
import { createRemoteJWKSet, jwtVerify } from "jose";

export interface OidcAuthorizationCodeOptions {
  clientId: string;
  clientSecret?: string;
  authorizationEndpoint: string | URL;
  tokenEndpoint: string | URL;
  redirectUri: string;
  scopes?: readonly string[];
  fetch?: typeof globalThis.fetch;
}

export interface OidcBearerPluginOptions {
  providerName?: string;
  issuer: string;
  audience: string | readonly string[];
  jwksUrl: string | URL;
  algorithms?: readonly string[];
  mapPrincipal?: (claims: Readonly<Record<string, unknown>>) =>
    | ZelavisPrincipal
    | undefined
    | Promise<ZelavisPrincipal | undefined>;
  authorizationCode?: OidcAuthorizationCodeOptions;
}

function constantTimeEqual(left: string, right: unknown): boolean {
  if (typeof right !== "string") return false;
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function createAuthorizationCodeProvider(
  options: OidcBearerPluginOptions,
): CredentialProvider | undefined {
  const flow = options.authorizationCode;
  if (!flow) return undefined;
  if (!flow.clientId?.trim() || !flow.redirectUri?.trim()) {
    throw new TypeError("OIDC Authorization Code requires clientId and redirectUri.");
  }
  const issuer = options.issuer.replace(/\/$/u, "");
  const jwks = createRemoteJWKSet(new URL(options.jwksUrl));
  const providerName = options.providerName ?? "oidc";
  return {
    name: providerName,
    authorizationCode: {
      redirectUri: flow.redirectUri,
      createAuthorizationUrl(input) {
        const url = new URL(flow.authorizationEndpoint);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", flow.clientId);
        url.searchParams.set("redirect_uri", input.redirectUri);
        url.searchParams.set(
          "scope",
          [...new Set(["openid", ...(flow.scopes ?? ["profile", "email"])])].join(" "),
        );
        url.searchParams.set("state", input.state);
        url.searchParams.set("nonce", input.nonce);
        url.searchParams.set("code_challenge", input.codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        return url;
      },
      async exchange(input) {
        const requestFetch = flow.fetch ?? globalThis.fetch;
        const body = new URLSearchParams({
          grant_type: "authorization_code",
          code: input.code,
          client_id: flow.clientId,
          redirect_uri: input.redirectUri,
          code_verifier: input.codeVerifier,
        });
        if (flow.clientSecret) body.set("client_secret", flow.clientSecret);
        const response = await requestFetch(flow.tokenEndpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        });
        if (!response.ok) {
          throw new TypeError("OIDC token exchange failed.");
        }
        const tokens = await response.json() as { id_token?: unknown };
        if (typeof tokens.id_token !== "string") {
          throw new TypeError("OIDC token response did not include an ID token.");
        }
        const verified = await jwtVerify(tokens.id_token, jwks, {
          issuer,
          audience: flow.clientId,
          algorithms: [...(options.algorithms ?? ["RS256", "ES256", "EdDSA"])],
        });
        if (!constantTimeEqual(input.nonce, verified.payload.nonce)) {
          throw new TypeError("OIDC ID token nonce did not match the authorization flow.");
        }
        if (!verified.payload.sub) {
          throw new TypeError("OIDC ID token did not include a subject.");
        }
        return {
          identifier: verified.payload.sub,
          email: typeof verified.payload.email === "string"
            ? verified.payload.email
            : undefined,
          username: typeof verified.payload.preferred_username === "string"
            ? verified.payload.preferred_username
            : undefined,
          displayName: typeof verified.payload.name === "string"
            ? verified.payload.name
            : undefined,
          verified: verified.payload.email_verified === true,
          metadata: {
            issuer,
            subject: verified.payload.sub,
            authentication: "oidc-authorization-code",
          },
        };
      },
    },
  };
}

export function oidcBearerService(options: OidcBearerPluginOptions) {
  const issuer = options.issuer.replace(/\/$/u, "");
  const authorizationCodeProvider = createAuthorizationCodeProvider(options);
  const method: AuthMethodPlugin = {
    name: options.providerName ?? "oidc",
    register(api) {
      if (authorizationCodeProvider) {
        api.authentication.registerProvider(authorizationCodeProvider);
      }
    },
  };
  return Object.freeze({
    name: "@zelavis/auth-oidc",
    kind: "provider",
    capabilities: Object.freeze(["provider:auth"]),
    authenticators: [createJwksAuthenticator({
      name: options.providerName ?? "oidc",
      issuer,
      audience: options.audience,
      algorithms: options.algorithms ?? ["RS256", "ES256", "EdDSA"],
      jwksUrl: options.jwksUrl,
      async mapPrincipal(payload) {
        if (options.mapPrincipal) return options.mapPrincipal(payload);
        if (typeof payload.sub !== "string" || !payload.sub) return undefined;
        return {
          id: payload.sub,
          type: "user",
          metadata: { issuer: payload.iss, authentication: "oidc" },
        };
      },
    })],
    service: method,
  });
}

export const oidcService = oidcBearerService;
