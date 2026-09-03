import { createRemoteJWKSet, jwtVerify } from "jose";
import type { OAuthConnection } from "./connections.js";
import type {
  OAuthIdentity,
  OAuthIdentityClaims,
  OAuthProviderDefinition,
} from "./contract.js";

/**
 * Compares two strings without revealing where they first differ.
 *
 * The nonce check below decides whether an ID token belongs to the flow that
 * started, so a timing difference there is a way to search for a value that
 * passes.
 */
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

function defaultIdentity(claims: OAuthIdentityClaims): OAuthIdentity | undefined {
  const subject = claims.sub ?? claims.id;
  if (typeof subject !== "string" && typeof subject !== "number") return undefined;
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : undefined;
  return {
    identifier: String(subject),
    ...(email ? { email } : {}),
    ...(typeof claims.preferred_username === "string"
      ? { username: claims.preferred_username }
      : typeof claims.login === "string"
        ? { username: claims.login }
        : {}),
    ...(typeof claims.name === "string" ? { displayName: claims.name } : {}),
    verified: claims.email_verified === true,
  };
}

export interface AuthorizationCodeStart {
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
}

export interface AuthorizationCodeExchange {
  code: string;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
}

/**
 * Builds the Authorization Code flow for one configured provider.
 *
 * The definition says how to talk to the provider; the connection says who
 * this installation is to it. Neither is useful alone, which is why a provider
 * plugin ships the first and an operator supplies the second.
 */
export function createAuthorizationCodeFlow(
  definition: OAuthProviderDefinition,
  connection: OAuthConnection,
  options: { fetch?: typeof globalThis.fetch } = {},
) {
  const issuer = definition.issuer?.replace(/\/+$/u, "");
  const jwks =
    issuer && definition.jwksUrl
      ? createRemoteJWKSet(new URL(definition.jwksUrl))
      : undefined;
  const scopes = [
    ...new Set([
      ...(issuer ? ["openid"] : []),
      ...(definition.scopes ?? []),
      ...(connection.scopes ?? []),
    ]),
  ];

  return {
    redirectUri: connection.redirectUri,

    createAuthorizationUrl(input: AuthorizationCodeStart): URL {
      const url = new URL(definition.authorizationEndpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", connection.clientId);
      url.searchParams.set("redirect_uri", input.redirectUri);
      if (scopes.length) url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("state", input.state);
      if (issuer) url.searchParams.set("nonce", input.nonce);
      // PKCE always, not only for public clients: it binds the code to the
      // browser that started the flow, so a stolen code cannot be redeemed.
      url.searchParams.set("code_challenge", input.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url;
    },

    async exchange(input: AuthorizationCodeExchange): Promise<OAuthIdentity> {
      const requestFetch = options.fetch ?? globalThis.fetch;
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        client_id: connection.clientId,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
      });
      if (connection.clientSecret) body.set("client_secret", connection.clientSecret);

      const response = await requestFetch(definition.tokenEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body,
      });
      if (!response.ok) {
        // The provider's body can quote the request, which carries the client
        // secret; only the status is repeated.
        throw new TypeError(
          `Token exchange with ${definition.name} failed with status ${response.status}.`,
        );
      }

      const tokens = (await response.json()) as {
        id_token?: unknown;
        access_token?: unknown;
      };

      if (issuer && jwks) {
        if (typeof tokens.id_token !== "string") {
          throw new TypeError(
            `${definition.name} did not return an ID token, so the identity could not be verified.`,
          );
        }
        const verified = await jwtVerify(tokens.id_token, jwks, {
          issuer,
          audience: connection.clientId,
          algorithms: [...(definition.algorithms ?? ["RS256", "ES256", "EdDSA"])],
        });
        if (!constantTimeEqual(input.nonce, verified.payload.nonce)) {
          throw new TypeError(
            `The ID token from ${definition.name} does not belong to this sign-in attempt.`,
          );
        }
        const identity = (definition.mapIdentity ?? defaultIdentity)(
          verified.payload as OAuthIdentityClaims,
        );
        if (!identity?.identifier) {
          throw new TypeError(`${definition.name} returned no usable subject.`);
        }
        return {
          ...identity,
          metadata: { ...identity.metadata, issuer, provider: definition.name },
        };
      }

      if (!definition.userInfoEndpoint) {
        throw new TypeError(
          `${definition.name} has neither an issuer nor a userInfo endpoint, so there is no verified identity to read.`,
        );
      }
      if (typeof tokens.access_token !== "string") {
        throw new TypeError(`${definition.name} did not return an access token.`);
      }

      const userInfo = await requestFetch(definition.userInfoEndpoint, {
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          accept: "application/json",
        },
      });
      if (!userInfo.ok) {
        throw new TypeError(
          `Reading the ${definition.name} profile failed with status ${userInfo.status}.`,
        );
      }
      const identity = (definition.mapIdentity ?? defaultIdentity)(
        (await userInfo.json()) as OAuthIdentityClaims,
      );
      if (!identity?.identifier) {
        throw new TypeError(`${definition.name} returned no usable account identifier.`);
      }
      return {
        ...identity,
        metadata: { ...identity.metadata, provider: definition.name },
      };
    },
  };
}
