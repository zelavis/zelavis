// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/lib/oauth/callback.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: every async step is an Effect (T1) and every `console` call an Effect log (T9); the redirect is a route response and carries the outcome in the URL fragment; plain http is allowed to a loopback host (as the catalogue check of the generic method allows); the fetch is injected; the id_token also has to echo the request's nonce, and for a provider that publishes a key set (an OpenID Connect connection) its signature is verified against it; a transport or HTTP failure of the provider redirects with `provider_unavailable`.
/**
 * The provider callback, shared by every OAuth provider.
 *
 * This takes the callback parameters already pulled out of the request, plus
 * the endpoints and credentials to exchange the code with, and runs the rest
 * of the flow.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import type { ZelavisRouteResponse } from "../../../core/index.js";
import { integration } from "../../../core/runtime/effect-boundary.js";
import type { AuthFailure } from "../../core/errors.js";
import { sha256Hex } from "../crypto.js";
import { OAUTH_CODE_PARAM, OAUTH_ERROR_PARAM } from "../oauthParams.js";
import {
  decodeJwtPayloadUnverified,
  encryptTicketPayload,
  generateRandomToken,
  type IssuerDeliveredJwt,
  type OAuthProviderFailure,
  providerFailure,
} from "./crypto.js";
import { parseUrl, type OidcClaims, type TicketPayload } from "./redemption.js";

const FETCH_TIMEOUT_MS = 10 * 1000;

/** The fetch the flow uses; tests and hosts inject their own. */
export type OAuthFetch = typeof globalThis.fetch;

/**
 * The status a redirect back to the app uses. A provider that sends the
 * callback as a POST needs 303, which tells the browser to follow with a GET;
 * a provider that redirects there with a GET keeps 302.
 */
export type RedirectStatus = 302 | 303;

const redirect = (location: string, status: RedirectStatus): ZelavisRouteResponse => ({
  status,
  headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
});

/**
 * Redirect back to the app's `redirectTo` with outcome params in the URL
 * fragment. Stale outcome params from a previous attempt are removed first,
 * so a `redirectTo` derived from the app's current URL can't carry a
 * contradictory outcome.
 */
export function redirectToApp(redirectTo: string, params: Record<string, string>, status: RedirectStatus): ZelavisRouteResponse {
  const url = new URL(redirectTo);
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  fragment.delete(OAUTH_CODE_PARAM);
  fragment.delete(OAUTH_ERROR_PARAM);
  for (const [key, value] of Object.entries(params)) {
    fragment.set(key, value);
  }
  url.hash = fragment.toString();
  return redirect(url.toString(), status);
}

const plain = (status: number, message: string): ZelavisRouteResponse => ({
  status,
  headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  body: message,
});

/**
 * The response for a callback request that is rejected as invalid. It is sent
 * before any flow is claimed, so there is no `redirectTo` to send the user
 * back to.
 */
export const invalidCallbackResponse = (path: string, reason: string) =>
  Effect.as(
    Effect.logWarning(`OAuth callback at "${path}": ${reason}`),
    plain(400, "This sign-in link is invalid. Return to the app and try signing in again."),
  );

/**
 * Turn the provider's `error` parameter into one of the codes the client
 * understands. Everything unrecognized is a generic failure.
 */
export function normalizeProviderError(
  error: string | null,
  // Accepts additional provider-specific codes that are synonymous with
  // "access_denied".
  extraDeniedErrorCodes: string[] = [],
): string {
  const deniedCodes = ["access_denied", ...extraDeniedErrorCodes];
  if (error !== null && deniedCodes.includes(error)) {
    // Generally means the user declined.
    return "access_denied";
  }
  return "oauth_error";
}

const isLoopback = (hostname: string) => hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const decodeJsonObject = Schema.decodeUnknownExit(Schema.fromJsonString(JsonObject));
const decodeJsonValue = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const Jwks = Schema.Struct({ keys: Schema.Array(JsonObject) });
const decodeJwks = Schema.decodeUnknownExit(Schema.fromJsonString(Jwks));

/**
 * Fetch that requires https (or a loopback host), enforces a timeout, and
 * treats any HTTP redirect as an error. Token and userinfo endpoints never
 * legitimately redirect; following one could forward credentials to an
 * unintended host, and a non-https endpoint would expose them in transit.
 */
export const fetchRefusingRedirects = Effect.fn("auth.lib.oauth.fetchRefusingRedirects")(function* (fetchImpl: OAuthFetch, url: string, init: RequestInit) {
  const parsed = parseUrl(url);
  if (parsed === null || !(parsed.protocol === "https:" || (parsed.protocol === "http:" && isLoopback(parsed.hostname)))) {
    return yield* providerFailure(`Refusing non-https request to ${url}`);
  }
  const unreachable = () => providerFailure(`Request to ${url} failed`, true);
  const timedOut = () => Effect.fail(providerFailure(`Request to ${url} timed out`, true));
  const response = yield* integration((signal) => fetchImpl(url, { ...init, redirect: "manual", signal }), { interruptible: true }).pipe(
    Effect.mapError(unreachable),
    Effect.timeoutOrElse({ duration: FETCH_TIMEOUT_MS, orElse: timedOut }),
  );
  if (response.status >= 300 && response.status < 400) {
    return yield* providerFailure(`Request to ${url} responded with a redirect`);
  }
  const bodyText = yield* integration(() => response.text(), { interruptible: true }).pipe(
    Effect.mapError(unreachable),
    Effect.timeoutOrElse({ duration: FETCH_TIMEOUT_MS, orElse: timedOut }),
  );
  return { ok: response.ok, status: response.status, bodyText };
});

/**
 * Exchange an authorization code for tokens at the provider's token
 * endpoint. Credentials go in the POST body because HTTP Basic has a
 * form-urlencoding ambiguity many providers get wrong.
 */
export const exchangeCode = Effect.fn("auth.lib.oauth.exchangeCode")(function* (
  fetchImpl: OAuthFetch,
  args: {
    tokenEndpoint: string;
    code: string;
    callbackUrl: string;
    codeVerifier: string;
    clientId: string;
    clientSecret: string;
  },
) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    // Must byte-match the redirect_uri from the authorization request, so
    // it comes off the authorization request rather than being rebuilt here.
    redirect_uri: args.callbackUrl,
    code_verifier: args.codeVerifier,
  });
  const response = yield* fetchRefusingRedirects(fetchImpl, args.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      // GitHub's token endpoint returns form-encoded output without this.
      Accept: "application/json",
    },
    body,
  });
  if (!response.ok) {
    return yield* providerFailure(`Token exchange failed with ${response.status}`, response.status >= 500);
  }
  const tokens = decodeJsonObject(response.bodyText);
  if (tokens._tag !== "Success") {
    return yield* providerFailure("Token exchange returned no JSON object");
  }
  return {
    // Straight off the issuer's TLS response, which is what the brand attests.
    idToken: typeof tokens.value.id_token === "string" ? (tokens.value.id_token as IssuerDeliveredJwt) : undefined,
    accessToken: typeof tokens.value.access_token === "string" ? tokens.value.access_token : undefined,
  };
});

/** The key set an OpenID Connect connection publishes, and what it signs with. */
export type IdTokenVerification = {
  readonly jwksUrl: string;
  readonly algorithms?: ReadonlyArray<string>;
};

/**
 * Decode an id_token and check its claims:
 *
 * - `iss` must match one of the configured `issuers`, which are required
 *   whenever an id_token comes back: `sub` is only unique within an issuer,
 *   and a shared or multi-tenant token endpoint can serve several.
 * - `sub` must be a non-empty string. It becomes the provider account id, so
 *   without it there is no identity to sign anyone in as.
 * - `aud` must be exactly CLIENT_ID. Multi-audience tokens are rejected
 *   because no other audience is trusted.
 * - `azp`, when present, must be CLIENT_ID.
 * - `exp` must be in the future.
 * - `nonce` must be the request's, when the request carried one.
 *
 * Signature verification is skipped unless the provider publishes a key set
 * (`verification`): the token came directly from the provider's token
 * endpoint over TLS, which OIDC Core sanctions in place of checking the
 * signature. When a key set is configured the signature is verified against
 * it as well, before any claim is believed.
 */
export const validateIdToken = Effect.fn("auth.lib.oauth.validateIdToken")(function* (
  fetchImpl: OAuthFetch,
  idToken: IssuerDeliveredJwt,
  expected: {
    issuers: string[] | undefined;
    clientId: string;
    nonce: string | undefined;
    now: number;
    verification: IdTokenVerification | undefined;
  },
) {
  if (expected.issuers === undefined) {
    return yield* providerFailure(
      "The provider returned an id_token but no issuer is configured; set `issuer` in the provider options so the token can be validated",
    );
  }
  if (expected.verification !== undefined) {
    const { verification } = expected;
    const response = yield* fetchRefusingRedirects(fetchImpl, verification.jwksUrl, { headers: { Accept: "application/json" } });
    const jwks = response.ok ? decodeJwks(response.bodyText) : undefined;
    if (jwks === undefined || jwks._tag !== "Success") {
      return yield* providerFailure("The provider's key set could not be read", jwks === undefined && response.status >= 500);
    }
    const keySet = createLocalJWKSet({ keys: jwks.value.keys.map((key) => ({ ...key })) } as unknown as JSONWebKeySet);
    yield* integration(() =>
      jwtVerify(idToken, keySet, {
        issuer: expected.issuers,
        audience: expected.clientId,
        ...(verification.algorithms === undefined ? {} : { algorithms: [...verification.algorithms] }),
        currentDate: new Date(expected.now),
      }),
    ).pipe(Effect.mapError(() => providerFailure("id_token signature or claims are not valid")));
  }
  const claims = yield* decodeJwtPayloadUnverified(idToken);
  if (typeof claims.iss !== "string" || !expected.issuers.includes(claims.iss)) {
    return yield* providerFailure("id_token issuer does not match the configured issuer");
  }
  if (typeof claims.sub !== "string" || claims.sub === "") {
    return yield* providerFailure("id_token has no subject claim");
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (audiences.length !== 1 || audiences[0] !== expected.clientId) {
    return yield* providerFailure("id_token audience must be exactly CLIENT_ID");
  }
  if (claims.azp !== undefined && claims.azp !== expected.clientId) {
    return yield* providerFailure("id_token authorized party does not match CLIENT_ID");
  }
  if (typeof claims.exp !== "number" || claims.exp * 1000 < expected.now) {
    return yield* providerFailure("id_token is expired");
  }
  if (expected.nonce !== undefined && claims.nonce !== expected.nonce) {
    return yield* providerFailure("id_token nonce does not match the authorization request");
  }
  // This asserts only what was checked. `sub` is the one required field of
  // OidcClaims and the check above covers it. The optional claims (`email`,
  // `name`, `picture`) are the provider's word, and each provider's profile
  // mapping checks them at runtime.
  return claims as OidcClaims;
});

/**
 * Fetch each configured userinfo endpoint with the access token.
 */
export const fetchUserInfo = Effect.fn("auth.lib.oauth.fetchUserInfo")(function* (
  fetchImpl: OAuthFetch,
  endpoints: Record<string, string>,
  accessToken: string,
) {
  const responses = yield* Effect.forEach(
    Object.entries(endpoints),
    ([key, endpoint]) =>
      Effect.gen(function* () {
        const response = yield* fetchRefusingRedirects(fetchImpl, endpoint, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
            // GitHub's API rejects requests without a User-Agent.
            "User-Agent": "zelavis-auth",
          },
        });
        if (!response.ok) {
          return yield* providerFailure(`Userinfo request "${key}" failed with ${response.status}`, response.status >= 500);
        }
        const value = decodeJsonValue(response.bodyText);
        if (value._tag !== "Success") {
          return yield* providerFailure(`Userinfo request "${key}" returned no JSON`);
        }
        return [key, value.value] as const;
      }),
    { concurrency: 4 },
  );
  return Object.fromEntries(responses);
});

/**
 * The parameters a provider sends to the callback. This is a transport type
 * that only represents possible values as copied from the provider callback
 * query params, it doesn't indicate what combinations of values are valid.
 */
export type CallbackRequestParams = {
  state: string | null;
  code: string | null;
  error: string | null;
  errorDescription: string | null;
};

/** What every provider's claimed authorization request has in common. */
export type ClaimedRequest = {
  stateHash: string;
  redirectTo: string;
  callbackUrl: string;
  codeVerifier: string;
  nonce?: string | undefined;
};

/** What claiming an authorization request can produce. */
export type ClaimResult<Request extends ClaimedRequest> =
  null | { expired: true; redirectTo: string } | ({ expired: false } & Request);

/** The fields of a new ticket, for `mintTicket` to store. */
export type MintedTicket = {
  ticketCodeHash: string;
  encryptedPayload: string;
};

/** Everything needed to exchange the code with one provider. */
export type ExchangeConfig = {
  /** The provider's name, for log messages. */
  providerName: string;
  /** The provider's token endpoint (a full URL). */
  tokenEndpoint: string;
  clientId: string;
  /**
   * The client secret to present at the token endpoint.
   *
   * It is an Effect so that a provider that has to build its secret (Apple
   * signs a fresh one per exchange) builds it inside the failure handler
   * below, where a failure redirects back to the app with `oauth_error`.
   */
  clientSecret: () => Effect.Effect<string, OAuthProviderFailure>;
  /** Accepted `iss` values, required when the provider returns an id_token. */
  issuers?: string[];
  /** Endpoints to fetch with the access token, keyed as the mapping reads them. */
  userInfoEndpoints?: Record<string, string>;
  /** The provider's key set, when it publishes one: the id_token's signature is then verified against it. */
  verification?: IdTokenVerification;
};

/**
 * Run the provider callback: claim the flow, exchange the code, and mint the
 * one-time ticket the app redeems, then redirect back to the app.
 *
 * Nothing user-visible (accounts, users, sessions) is created here. The
 * ticket is a short-lived, one-time proof that provider authentication
 * succeeded; only the hash of its code is stored, and the identity payload is
 * encrypted with a key derived from the raw code, so database access alone
 * can read neither.
 *
 * The code exchange and every other network call run outside any
 * transaction; the claim and the ticket are one transaction each.
 */
export const runCallback = Effect.fn("auth.lib.oauth.runCallback")(function* <Request extends ClaimedRequest>(options: {
  /** Where the callback arrived, for log messages. */
  path: string;
  /** The callback parameters the transport adapter pulled out. */
  params: CallbackRequestParams;
  /** Claim the flow by state hash, in the shared tables. */
  claim: (stateHash: string) => Effect.Effect<ClaimResult<Request>, AuthFailure>;
  /** Store the minted ticket. */
  mintTicket: (request: Request, ticket: MintedTicket) => Effect.Effect<boolean, AuthFailure>;
  recordFailure?: (() => Effect.Effect<void, AuthFailure>) | undefined;
  /** The endpoints and credentials for this flow's provider; undefined when it is no longer available. */
  exchangeConfig: (request: Request) => Effect.Effect<ExchangeConfig | undefined>;
  /**
   * Extra provider data that arrived in the callback request itself, as a
   * query or form field rather than through a token, already sanitized.
   * Browser-relayed, so it is user-controlled and untrusted.
   */
  callbackParams?: Record<string, unknown> | undefined;
  /**
   * This provider's own error codes for a user who declined, on top of the
   * standard `access_denied` that is always handled.
   */
  extraDeniedErrorCodes?: string[] | undefined;
  /** The status used by redirects back to the app. */
  redirectStatus: RedirectStatus;
  fetch: OAuthFetch;
  clock: () => number;
}) {
  const { params, redirectStatus } = options;

  // Without state we can't identify the flow.
  if (params.state === null) {
    return yield* invalidCallbackResponse(options.path, "no state parameter");
  }

  // Claiming is atomic (find + delete in one mutation), so a replayed or
  // raced callback finds nothing. Possession of the provider-echoed state
  // is the only check here; binding to the initiating client happens at
  // redemption.
  const authRequest = yield* options.claim(yield* sha256Hex(params.state));
  // Nothing found means the flow is gone entirely (already claimed, or
  // forged); there is nowhere left to redirect to.
  if (authRequest === null) {
    yield* Effect.logWarning(`OAuth callback at "${options.path}": unknown or already-used state`);
    return plain(400, "This sign-in link has expired or was already used. Return to the app and try signing in again.");
  }
  // An expired request still knows where the user came from; send them
  // back to the app instead of stranding them here.
  if (authRequest.expired) {
    yield* Effect.logWarning(`OAuth callback at "${options.path}": expired authorization request`);
    return redirectToApp(authRequest.redirectTo, { [OAUTH_ERROR_PARAM]: "expired" }, redirectStatus);
  }

  const config = yield* options.exchangeConfig(authRequest);
  if (config === undefined) {
    yield* Effect.logError(`OAuth callback at "${options.path}": the provider is not available`);
    return redirectToApp(authRequest.redirectTo, { [OAUTH_ERROR_PARAM]: "oauth_error" }, redirectStatus);
  }

  // From here on the flow is legitimate, so failures go back to the app
  // as a normalized error param; raw detail goes to logs only.
  if (params.error !== null || params.code === null) {
    const error = normalizeProviderError(params.error, options.extraDeniedErrorCodes);
    const message = `OAuth callback error from provider "${config.providerName}": ${error}`;
    if (error === "access_denied") yield* Effect.logInfo(message);
    else {
      yield* Effect.logError(message);
      if (options.recordFailure !== undefined) yield* options.recordFailure();
    }
    return redirectToApp(authRequest.redirectTo, { [OAUTH_ERROR_PARAM]: error }, redirectStatus);
  }
  const code = params.code;

  const minted = yield* Effect.gen(function* () {
    const { idToken, accessToken } = yield* exchangeCode(options.fetch, {
      tokenEndpoint: config.tokenEndpoint,
      code,
      callbackUrl: authRequest.callbackUrl,
      codeVerifier: authRequest.codeVerifier,
      clientId: config.clientId,
      clientSecret: yield* config.clientSecret(),
    });

    const claims =
      idToken === undefined
        ? undefined
        : yield* validateIdToken(options.fetch, idToken, {
            issuers: config.issuers,
            clientId: config.clientId,
            nonce: authRequest.nonce,
            now: options.clock(),
            verification: config.verification,
          });

    if (config.userInfoEndpoints !== undefined && accessToken === undefined) {
      return yield* providerFailure("Token exchange returned no access_token");
    }
    const userInfoResponses =
      config.userInfoEndpoints === undefined || accessToken === undefined
        ? undefined
        : yield* fetchUserInfo(options.fetch, config.userInfoEndpoints, accessToken);

    // A provider that returns no id_token and has no configured userinfo
    // endpoints gives us nothing to identify the user with.
    if (claims === undefined && userInfoResponses === undefined) {
      return yield* providerFailure("Token exchange returned no id_token and no userInfoEndpoints are configured");
    }

    const ticketCode = generateRandomToken();
    return {
      ticketCode,
      ticketCodeHash: yield* sha256Hex(ticketCode),
      encryptedPayload: yield* encryptTicketPayload(
        ticketCode,
        JSON.stringify({
          claims,
          userInfoResponses,
          callbackParams: options.callbackParams,
        } satisfies TicketPayload),
      ),
    };
  }).pipe(
    Effect.map((ticket) => ({ ok: true, ticket }) as const),
    Effect.catchTag("OAuthProviderFailure", (failure) =>
      Effect.as(Effect.logError(`OAuth exchange failed for provider "${config.providerName}": ${failure.message}`), { ok: false, failure } as const),
    ),
  );

  if (!minted.ok) {
    if (options.recordFailure !== undefined) yield* options.recordFailure();
    return redirectToApp(
      authRequest.redirectTo,
      { [OAUTH_ERROR_PARAM]: minted.failure.unavailable ? "provider_unavailable" : "oauth_error" },
      redirectStatus,
    );
  }
  const stored = yield* options.mintTicket(authRequest, { ticketCodeHash: minted.ticket.ticketCodeHash, encryptedPayload: minted.ticket.encryptedPayload });
  if (!stored) return redirectToApp(authRequest.redirectTo, { [OAUTH_ERROR_PARAM]: "oauth_error" }, redirectStatus);
  return redirectToApp(authRequest.redirectTo, { [OAUTH_CODE_PARAM]: minted.ticket.ticketCode }, redirectStatus);
});
