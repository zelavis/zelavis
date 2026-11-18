// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/lib/oauth/authorize.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: `startSignIn` is an Effect over a transaction (T1-T4); a bad `redirectTo` is a user error (it comes from a request, not from a deploy); the callback URL is the connection's `redirectUri`, whose path must name this provider's callback route; a nonce is minted for a provider that returns an id_token; the `assertCallbackUnderHttpPrefix` check has no counterpart (there is no component to mount).
/**
 * The start of an OAuth flow, shared by every provider.
 *
 * Every provider does the same three things here: check where the flow is
 * allowed to return to, mint the state that ties the callback back to this
 * client, and build the URL to send the browser to. What differs is the
 * endpoint and the scopes.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { AuthCall } from "../../core/context.js";
import type { AuthRuntime } from "../../runtime/index.js";
import { generateRandomToken, sha256Hex } from "../crypto.js";
import { sha256Base64Url } from "./crypto.js";
import { insertAuthorizationRequest } from "./dbHelpers.js";
import type { CallbackMethod } from "./http.js";
import { parseUrl } from "./redemption.js";

export const startSignInResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("started"), redirect: Schema.String, state: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("error"),
    userError: Schema.Struct({ error: Schema.Literals(["INVALID_REDIRECT"]) }),
  }),
]);

/** The result of `startSignIn`. */
export type StartSignInResult = typeof startSignInResult.Type;

/**
 * Build a provider's `startSignIn`.
 *
 * The server mints `state` and returns it; the client keeps it (it must
 * present the same value again to complete sign-in) and navigates to the
 * returned `redirect` URL.
 *
 * An unusable `redirectTo` (not an absolute URL, or of an origin that is not
 * allowed) is the user error `INVALID_REDIRECT`; nothing is stored then.
 */
export function buildStartSignIn(options: {
  /** The provider's name, stored on the request and used in the callback. */
  providerName: string;
  connectionRevision: string;
  /** Origins `redirectTo` may point at, already validated and normalized. */
  allowedOrigins: () => ReadonlyArray<string>;
  /** The provider's authorization endpoint (a full URL). */
  authorizationEndpoint: string;
  /** Scopes to request. Left off the URL entirely when empty. */
  scopes: ReadonlyArray<string>;
  /**
   * The method the provider delivers the callback with. `"POST"` adds
   * `response_mode=form_post` to the authorization URL.
   */
  callbackMethod?: CallbackMethod | undefined;
  /** The OAuth client id and the registered `redirect_uri`. */
  clientId: string;
  callbackUrl: string;
  /** Whether the provider returns an id_token, which then has to echo the nonce minted here. */
  idToken: boolean;
  runtime: AuthRuntime;
}) {
  return (call: AuthCall, args: { redirectTo: string }) =>
    Effect.gen(function* () {
      const redirectTo = parseUrl(args.redirectTo);
      if (redirectTo === null || !options.allowedOrigins().includes(redirectTo.origin)) {
        return { status: "error", userError: { error: "INVALID_REDIRECT" } } satisfies StartSignInResult;
      }

      const state = generateRandomToken();
      const codeVerifier = generateRandomToken();
      const nonce = options.idToken ? generateRandomToken() : undefined;
      const stateHash = yield* sha256Hex(state);
      const codeChallenge = yield* sha256Base64Url(codeVerifier);
      yield* options.runtime.mutation(call, (tx) =>
        insertAuthorizationRequest(tx, {
          providerName: options.providerName,
          connectionRevision: options.connectionRevision,
          stateHash,
          redirectTo: args.redirectTo,
          callbackUrl: options.callbackUrl,
          codeVerifier,
          ...(nonce === undefined ? {} : { nonce }),
        }),
      );

      const params: Record<string, string> = {
        response_type: "code",
        client_id: options.clientId,
        redirect_uri: options.callbackUrl,
        state,
        // Every provider gets a challenge. One that does not implement PKCE
        // ignores the parameters, which RFC 6749 requires of it.
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      };
      if (nonce !== undefined) {
        params.nonce = nonce;
      }
      if (options.scopes.length > 0) {
        params.scope = options.scopes.join(" ");
      }
      if (options.callbackMethod === "POST") {
        params.response_mode = "form_post";
      }

      const url = new URL(options.authorizationEndpoint);
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }

      return { status: "started", redirect: url.toString(), state } satisfies StartSignInResult;
    });
}
