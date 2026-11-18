// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/lib/oauth/http.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the httpRouter is a function that reads the callback parameters from a route's request (the dispatcher has already parsed a form body) and runs `runCallback`; every provider is served by the one route `/auth/oauth/:provider/callback`, so there is no per-component router.
/**
 * The callback transport every OAuth provider shares.
 *
 * This owns the transport around {@link runCallback}: which methods the
 * callback is served over, where the parameters are read from, and which
 * status the redirect back to the app uses.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import type { ZelavisRouteContext } from "../../../core/index.js";
import type { AuthFailure } from "../../core/errors.js";
import {
  invalidCallbackResponse,
  runCallback,
  type CallbackRequestParams,
  type ClaimedRequest,
  type ClaimResult,
  type ExchangeConfig,
  type MintedTicket,
  type OAuthFetch,
} from "./callback.js";

/**
 * How a provider delivers the callback. A GET is a redirect with the
 * parameters in the query string. A POST is a form submission with the
 * parameters as form fields.
 */
export type CallbackMethod = "GET" | "POST";

/** What a provider adds to the callback past the basics. */
export interface CallbackProvider<Request extends ClaimedRequest> {
  /**
   * The methods this provider may deliver the callback with.
   * Defaults to `["GET"]`.
   */
  methods?: readonly CallbackMethod[];
  /** The endpoints and credentials for this flow's provider. */
  exchangeConfig: (request: Request) => Effect.Effect<ExchangeConfig | undefined>;
  /**
   * Read and sanitize provider data that arrived in the callback request
   * itself rather than through a token, such as Apple's `user` field. The
   * browser relayed it, so it is user-controlled.
   */
  sanitizeParams?: (fields: URLSearchParams) => Record<string, unknown> | undefined;
  /**
   * This provider's own error codes for a user who declined, on top of the
   * standard `access_denied` that is always handled.
   */
  extraDeniedErrorCodes?: string[];
}

/** The fields of a callback: the query of a GET, the form of a POST (parsed by the dispatcher). */
export const callbackFields = (context: ZelavisRouteContext): URLSearchParams | undefined => {
  if (context.request.method !== "POST") return context.query;
  const contentType = context.requestHeaders.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) return undefined;
  const fields = new URLSearchParams();
  const body = context.body;
  if (typeof body === "object" && body !== null) {
    for (const [key, value] of Object.entries(body)) {
      for (const one of Array.isArray(value) ? value : [value]) {
        if (typeof one === "string") fields.append(key, one);
      }
    }
  }
  return fields;
};

/**
 * Serve a provider's callback: read the parameters, reject a malformed or
 * repeated one, and run the flow. The callback is the provider's redirect, so
 * every outcome is a redirect back to the app or a short plain answer.
 */
export const serveCallback = Effect.fn("auth.lib.oauth.serveCallback")(function* <Request extends ClaimedRequest>(options: {
  context: ZelavisRouteContext;
  provider: CallbackProvider<Request>;
  /** Claim the flow by state hash, in the shared tables. */
  claim: (stateHash: string) => Effect.Effect<ClaimResult<Request>, AuthFailure>;
  /** Store the minted ticket. */
  mintTicket: (request: Request, ticket: MintedTicket) => Effect.Effect<boolean, AuthFailure>;
  recordFailure?: (() => Effect.Effect<void, AuthFailure>) | undefined;
  fetch: OAuthFetch;
  clock: () => number;
}) {
  const { context, provider } = options;
  const path = new URL(context.request.url).pathname;
  const fields = callbackFields(context);
  // A provider that posts should set an expected content-type.
  if (fields === undefined) {
    return yield* invalidCallbackResponse(path, "a posted callback must be a form submission");
  }
  // Duplicate params aren't expected, return 400 if it happens.
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const key of fields.keys()) {
    if (seen.has(key)) {
      duplicated.add(key);
    }
    seen.add(key);
  }
  if (duplicated.size > 0) {
    return yield* invalidCallbackResponse(path, `these parameters arrived more than once: ${JSON.stringify([...duplicated])}`);
  }
  const params: CallbackRequestParams = {
    state: fields.get("state"),
    code: fields.get("code"),
    error: fields.get("error"),
    errorDescription: fields.get("error_description"),
  };
  return yield* runCallback<Request>({
    path,
    params,
    claim: options.claim,
    mintTicket: options.mintTicket,
    recordFailure: options.recordFailure,
    exchangeConfig: provider.exchangeConfig,
    callbackParams: provider.sanitizeParams?.(fields),
    extraDeniedErrorCodes: provider.extraDeniedErrorCodes,
    redirectStatus: context.request.method === "POST" ? 303 : 302,
    fetch: options.fetch,
    clock: options.clock,
  });
});
