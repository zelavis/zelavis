import type { OAuthProviderDefinition } from "./oauth-contract.js";

/**
 * Builds a provider definition from an issuer's own metadata.
 *
 * Every OpenID Connect issuer publishes its endpoints at
 * `/.well-known/openid-configuration`. Reading that turns adding Google,
 * Microsoft, Okta, Auth0, Keycloak, or a company's own SSO into pasting one
 * URL — no plugin, no constants in this package, and no release when an
 * issuer moves an endpoint.
 *
 * It also removes a curation problem that has no end: which providers are
 * popular enough to ship is a question nobody has to answer if the issuer
 * answers it. What still needs a plugin is a provider that is not OIDC at
 * all — GitHub and Discord have their own profile endpoints and claim shapes,
 * and that is real code rather than a list of URLs.
 */

export interface OidcDiscoveryOptions {
  fetch?: typeof globalThis.fetch;
  /** Name the discovered provider is stored under. Defaults to the host. */
  name?: string;
  title?: string;
  scopes?: readonly string[];
}

const WELL_KNOWN = "/.well-known/openid-configuration";

function readString(document: Record<string, unknown>, key: string): string {
  const value = document[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(
      `The OpenID configuration is missing "${key}", so this issuer cannot be used.`,
    );
  }
  return value;
}

function assertHttps(url: URL, label: string): void {
  // Everything below is fetched, and one of them supplies the keys that decide
  // whether an ID token is genuine. Over plaintext any of them can be
  // substituted by whoever is on the path.
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new TypeError(`${label} must use https.`);
  }
}

export async function discoverOidcProvider(
  issuer: string,
  options: OidcDiscoveryOptions = {},
): Promise<OAuthProviderDefinition> {
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    throw new TypeError("The issuer must be an absolute URL.");
  }
  assertHttps(issuerUrl, "The issuer");

  const base = issuerUrl.href.replace(/\/+$/u, "");
  const requestFetch = options.fetch ?? globalThis.fetch;
  const configurationUrl = `${base}${WELL_KNOWN}`;
  let response: Response;
  try {
    response = await requestFetch(configurationUrl, {
      headers: { accept: "application/json" },
    });
  } catch (cause) {
    // A transport failure surfaces as "fetch failed", which tells an operator
    // nothing about which URL was tried or why they are seeing it.
    throw new TypeError(
      `Could not reach ${configurationUrl}. Check the issuer URL is correct and reachable from this server.`,
      { cause },
    );
  }
  if (!response.ok) {
    throw new TypeError(
      `Reading the OpenID configuration for ${base} failed with status ${response.status}.`,
    );
  }

  let document: Record<string, unknown>;
  try {
    document = (await response.json()) as Record<string, unknown>;
  } catch (cause) {
    throw new TypeError(
      `${configurationUrl} did not return an OpenID configuration document.`,
      { cause },
    );
  }

  // The document names its own issuer, and it must be the one that was asked
  // for. Without this a redirect could hand back another provider's metadata
  // and tokens would then be verified against the wrong keys.
  const declaredIssuer = readString(document, "issuer").replace(/\/+$/u, "");
  if (declaredIssuer !== base) {
    throw new TypeError(
      `The OpenID configuration at ${base} declares a different issuer, so it cannot be trusted for it.`,
    );
  }

  const authorizationEndpoint = readString(document, "authorization_endpoint");
  const tokenEndpoint = readString(document, "token_endpoint");
  const jwksUrl = readString(document, "jwks_uri");
  for (const [label, value] of [
    ["The authorization endpoint", authorizationEndpoint],
    ["The token endpoint", tokenEndpoint],
    ["The key set URL", jwksUrl],
  ] as const) {
    assertHttps(new URL(value), label);
  }

  const algorithms = Array.isArray(document.id_token_signing_alg_values_supported)
    ? document.id_token_signing_alg_values_supported.filter(
        (value): value is string => typeof value === "string",
      )
    : undefined;

  return Object.freeze({
    name: options.name ?? issuerUrl.hostname,
    title: options.title ?? issuerUrl.hostname,
    authorizationEndpoint,
    tokenEndpoint,
    issuer: base,
    jwksUrl,
    scopes: options.scopes ?? ["email", "profile"],
    // Narrowed to what this issuer says it signs with, so a token signed with
    // anything else is refused rather than merely unexpected.
    ...(algorithms?.length ? { algorithms } : {}),
  });
}
