/**
 * The OAuth routes (Zelavis-own): which providers are offered, starting a sign-in, the provider's callback,
 * redeeming the ticket the callback hands back (to sign in or to link a provider account), and the operator's
 * connections. Failed attempts answer through `user-errors.ts`; a success that signs in answers through
 * `session-transport.ts`. Mounted under `/auth` by the runtime.
 *
 * The callback is the provider's redirect, so it answers a redirect back to the app (the ticket or the error in the
 * URL fragment) or a short plain answer; everything else is JSON.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ZelavisAccessRequirement, ZelavisServerRoute } from "../../core/index.js";
import { type OAuthMethod } from "../methods/oauth.js";
import { OAuthConnectionInvalid, validProviderName } from "../oauth/connections.js";
import { errorBody, noStore, respond } from "./errors.js";
import { callOf } from "./core.js";
import { type SessionTransport, signInResponse } from "./session-transport.js";
import { assertUserErrorsCovered, userErrorResponse } from "./user-errors.js";

export interface OAuthRoutesOptions {
  readonly method: OAuthMethod;
  readonly transport: SessionTransport;
  /** Who may read and change the connections: the settings permission of this runtime. */
  readonly settingsAccess: ZelavisAccessRequirement;
}

const START_LIMIT = 4096;
const REDEEM_LIMIT = 8192;
const CALLBACK_LIMIT = 16384;
const CONNECTION_LIMIT = 16384;

const StartBody = Schema.Struct({ redirectTo: Schema.String });
const RedeemBody = Schema.Struct({ ticket: Schema.String, state: Schema.String, link: Schema.optional(Schema.Boolean) });
const isStart = Schema.is(StartBody);
const isRedeem = Schema.is(RedeemBody);

const invalidRequest = (message: string) => errorBody(400, "invalid_request", message);
const providerParam = { provider: { type: "string", required: true, description: "Provider name" } } as const;

const plain = (status: number, message: string) => ({
  status,
  headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  body: message,
});

export function defineOAuthRoutes(options: OAuthRoutesOptions): ReadonlyArray<ZelavisServerRoute> {
  // A code the methods can return without an HTTP answer is a defect at startup, not a 500 on a user's request.
  assertUserErrorsCovered(
    Schema.Union([Schema.Struct({ error: Schema.Literal("UNKNOWN_PROVIDER") }), Schema.Struct({ error: Schema.Literal("INVALID_REDIRECT") })]),
    Schema.Union([
      Schema.Struct({ error: Schema.Literal("INVALID_CODE") }),
      Schema.Struct({ error: Schema.Literal("NOT_LOGGED_IN") }),
      Schema.Struct({ error: Schema.Literal("PROVIDER_ACCOUNT_IN_USE") }),
    ]),
  );
  const { method, transport, settingsAccess } = options;

  const callback = (context: Parameters<ZelavisServerRoute["handler"]>[0]) =>
    respond(
      validProviderName(context.params.provider ?? "")
        ? method.callback(context, context.params.provider ?? "")
        : Effect.succeed(plain(404, "There is no such sign-in provider.")),
    );

  return [
    {
      id: "auth.oauth.providers.list",
      method: "GET",
      path: "/oauth/providers",
      spec: {
        operationId: "listOAuthProviders",
        summary: "List the sign-in providers that are connected and enabled",
        tags: ["auth"],
        responses: { 200: { description: "The providers' names and titles, nothing else" } },
      },
      handler: () => respond(Effect.map(method.providers(), (providers) => ({ status: 200, headers: noStore, body: { providers } }))),
    },
    {
      id: "auth.oauth.start",
      method: "POST",
      path: "/oauth/:provider/start",
      maxRequestBodyBytes: START_LIMIT,
      invalidJsonBodyCode: "invalid_request",
      spec: {
        operationId: "startOAuthSignIn",
        summary: "Start signing in with a provider: the URL to send the browser to and the state the client keeps",
        tags: ["auth"],
        pathParams: providerParam,
        requestBody: { required: true, schema: { type: "object", required: ["redirectTo"], properties: { redirectTo: { type: "string" } } } },
        responses: {
          200: { description: "The provider's authorization URL and the state to present when redeeming" },
          400: { description: "redirectTo is not an allowed destination" },
          404: { description: "No such provider is connected" },
        },
      },
      handler: (context) => respond(Effect.gen(function* () {
        if (!isStart(context.body)) return invalidRequest("A redirectTo is required.");
        const result = yield* method.startSignIn(callOf(context), { provider: context.params.provider ?? "", redirectTo: context.body.redirectTo });
        return result.status === "started"
          ? { status: 200, headers: noStore, body: { url: result.redirect, state: result.state } }
          : userErrorResponse(result.userError);
      })),
    },
    {
      id: "auth.oauth.callback",
      method: "GET",
      path: "/oauth/:provider/callback",
      maxRequestBodyBytes: CALLBACK_LIMIT,
      spec: {
        operationId: "oauthCallback",
        summary: "The provider's redirect back: exchanges the code and redirects to the app with a one-time ticket in the URL fragment",
        tags: ["auth"],
        pathParams: providerParam,
        responses: { 302: { description: "Back to the app, with #ticket=… or #error=…" }, 400: { description: "The sign-in link is not valid" } },
      },
      handler: callback,
    },
    {
      id: "auth.oauth.callback.form",
      method: "POST",
      path: "/oauth/:provider/callback",
      maxRequestBodyBytes: CALLBACK_LIMIT,
      handler: callback,
    },
    {
      id: "auth.oauth.redeem",
      method: "POST",
      path: "/oauth/:provider/redeem",
      maxRequestBodyBytes: REDEEM_LIMIT,
      invalidJsonBodyCode: "invalid_request",
      // No `access`: signing in is for a caller with no session, and `link` answers `not_signed_in` itself.
      spec: {
        operationId: "redeemOAuthTicket",
        summary: "Redeem the one-time ticket with the state the client kept: sign in, or with link: true connect the provider account to the signed-in account",
        tags: ["auth"],
        pathParams: providerParam,
        requestBody: {
          required: true,
          schema: { type: "object", required: ["ticket", "state"], properties: { ticket: { type: "string" }, state: { type: "string" }, link: { type: "boolean" } } },
        },
        responses: {
          200: { description: "Signed in: the token bundle, or cookies in a browser page of this origin" },
          204: { description: "The provider account is linked" },
          400: { description: "The ticket is unknown, spent, expired or paired with another state" },
          401: { description: "Linking needs a signed-in caller" },
          404: { description: "No such provider is connected" },
          409: { description: "The provider account belongs to another account" },
        },
      },
      handler: (context) => respond(Effect.gen(function* () {
        if (!isRedeem(context.body)) return invalidRequest("A ticket and a state are required.");
        const args = { provider: context.params.provider ?? "", code: context.body.ticket, state: context.body.state };
        if (context.body.link === true) {
          const linked = yield* method.linkAccount(callOf(context), args);
          return linked.status === "linked" ? { status: 204, headers: noStore } : userErrorResponse(linked.userError);
        }
        const result = yield* method.completeSignIn(callOf(context), args);
        return result.status === "error" ? userErrorResponse(result.userError) : signInResponse(transport, context.request, result);
      })),
    },
    {
      id: "auth.oauth.connections.list",
      method: "GET",
      path: "/oauth/connections",
      access: settingsAccess,
      spec: {
        operationId: "listOAuthConnections",
        summary: "List the OAuth providers and their configuration; a secret is never returned",
        tags: ["auth"],
        responses: { 200: { description: "Every built-in provider and every connection" } },
      },
      handler: () => respond(Effect.map(method.connections.list(), (providers) => ({ status: 200, headers: noStore, body: { providers } }))),
    },
    {
      id: "auth.oauth.connections.configure",
      method: "PUT",
      path: "/oauth/connections/:provider",
      access: settingsAccess,
      maxRequestBodyBytes: CONNECTION_LIMIT,
      invalidJsonBodyCode: "invalid_request",
      spec: {
        operationId: "configureOAuthConnection",
        summary: "Connect an OAuth provider: Google, Apple or GitHub by name, or an OpenID Connect issuer under a name of your choice",
        tags: ["auth"],
        pathParams: providerParam,
        requestBody: { required: true, schema: { type: "object", additionalProperties: true } },
        responses: {
          200: { description: "Connection saved" },
          400: { description: "Invalid connection details" },
          404: { description: "Not a built-in provider, and no issuer was given" },
        },
      },
      handler: (context) => respond(
        method.connections.configure(context.params.provider ?? "", context.body).pipe(
          Effect.map((saved) =>
            saved.status === "saved"
              ? { status: 200, headers: noStore, body: { connection: saved.connection } }
              : errorBody(404, "unknown_provider", "Connect a built-in provider by its name, or give an issuer to connect an OpenID Connect provider."),
          ),
          Effect.catchTag("OAuthConnectionInvalid", (failure: OAuthConnectionInvalid) => Effect.succeed(errorBody(400, "invalid_connection", failure.message))),
        ),
      ),
    },
    {
      id: "auth.oauth.connections.remove",
      method: "DELETE",
      path: "/oauth/connections/:provider",
      access: settingsAccess,
      spec: {
        operationId: "removeOAuthConnection",
        summary: "Remove an OAuth provider's configuration",
        tags: ["auth"],
        pathParams: providerParam,
        responses: { 204: { description: "Connection removed" } },
      },
      handler: (context) => respond(Effect.map(method.connections.remove(context.params.provider ?? ""), () => ({ status: 204, headers: noStore }))),
    },
  ];
}
