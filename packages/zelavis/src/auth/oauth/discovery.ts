/**
 * Reads an OpenID Connect issuer's own metadata (Zelavis-own; adapted from the prior engine's discovery).
 *
 * Every OpenID Connect issuer publishes its endpoints at
 * `/.well-known/openid-configuration`. Reading that turns adding Microsoft,
 * Okta, Auth0, Keycloak, or a company's own SSO into pasting one URL: no
 * plugin, no constants in this package, and no release when an issuer moves
 * an endpoint. What still needs code is a provider that is not OIDC at all
 * (GitHub), which is why it has a module of its own.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type OAuthFetch, fetchRefusingRedirects } from "../lib/oauth/callback.js";
import { type OAuthProviderFailure, providerFailure } from "../lib/oauth/crypto.js";
import { parseUrl } from "../lib/oauth/redemption.js";
import type { DiscoveredIssuer } from "./tables.js";

const WELL_KNOWN = "/.well-known/openid-configuration";

/** How long discovered metadata is trusted before it is read again. */
export const DISCOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const Document = Schema.Record(Schema.String, Schema.Unknown);
const decodeDocument = Schema.decodeUnknownExit(Schema.fromJsonString(Document));

const isLoopback = (hostname: string) => hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

/**
 * Everything below is fetched, and one of them supplies the keys that decide
 * whether an ID token is genuine. Over plaintext any of them can be
 * substituted by whoever is on the path.
 */
const assertHttps = (url: URL, label: string) =>
  url.protocol !== "https:" && !isLoopback(url.hostname) ? Effect.fail(providerFailure(`${label} must use https.`)) : Effect.void;

const readString = (document: Record<string, unknown>, key: string) => {
  const value = document[key];
  return typeof value !== "string" || !value.trim()
    ? Effect.fail(providerFailure(`The OpenID configuration is missing "${key}", so this issuer cannot be used.`))
    : Effect.succeed(value);
};

/** Builds the endpoints of an issuer from its own metadata. */
export const discoverIssuer = Effect.fn("auth.oauth.discoverIssuer")(function* (fetchImpl: OAuthFetch, issuer: string, now: number): Effect.fn.Return<DiscoveredIssuer, OAuthProviderFailure> {
  const issuerUrl = parseUrl(issuer);
  if (issuerUrl === null) return yield* providerFailure("The issuer must be an absolute URL.");
  yield* assertHttps(issuerUrl, "The issuer");

  const base = issuerUrl.href.replace(/\/+$/u, "");
  const configurationUrl = `${base}${WELL_KNOWN}`;
  const response = yield* fetchRefusingRedirects(fetchImpl, configurationUrl, { headers: { accept: "application/json" } }).pipe(
    // A transport failure says nothing about which URL was tried or why an operator is seeing it.
    Effect.mapError((failure) =>
      failure.unavailable
        ? providerFailure(`Could not reach ${configurationUrl}. Check the issuer URL is correct and reachable from this server.`, true)
        : failure,
    ),
  );
  if (!response.ok) {
    return yield* providerFailure(`Reading the OpenID configuration for ${base} failed with status ${response.status}.`, response.status >= 500);
  }
  const decoded = decodeDocument(response.bodyText);
  if (decoded._tag !== "Success") {
    return yield* providerFailure(`${configurationUrl} did not return an OpenID configuration document.`);
  }
  const document = decoded.value;

  // The document names its own issuer, and it must be the one that was asked
  // for. Without this a redirect could hand back another provider's metadata
  // and tokens would then be verified against the wrong keys.
  const declaredIssuer = (yield* readString(document, "issuer")).replace(/\/+$/u, "");
  if (declaredIssuer !== base) {
    return yield* providerFailure(`The OpenID configuration at ${base} declares a different issuer, so it cannot be trusted for it.`);
  }

  const authorizationEndpoint = yield* readString(document, "authorization_endpoint");
  const tokenEndpoint = yield* readString(document, "token_endpoint");
  const jwksUrl = yield* readString(document, "jwks_uri");
  for (const [label, value] of [
    ["The authorization endpoint", authorizationEndpoint],
    ["The token endpoint", tokenEndpoint],
    ["The key set URL", jwksUrl],
  ] as const) {
    const url = parseUrl(value);
    if (url === null) return yield* providerFailure(`${label} must be an absolute URL.`);
    yield* assertHttps(url, label);
  }

  const algorithms = Array.isArray(document.id_token_signing_alg_values_supported)
    ? document.id_token_signing_alg_values_supported.filter((value): value is string => typeof value === "string")
    : undefined;

  return {
    issuer: base,
    authorizationEndpoint,
    tokenEndpoint,
    jwksUrl,
    // Narrowed to what this issuer says it signs with, so a token signed with
    // anything else is refused rather than merely unexpected.
    ...(algorithms?.length ? { algorithms } : {}),
    discoveredAt: now,
  };
});
