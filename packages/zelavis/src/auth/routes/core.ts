/**
 * The core HTTP routes: the session, its refresh and sign-out, the caller's
 * sessions, and the key set. Sign-in methods add their own routes.
 */
import * as Effect from "effect/Effect";
import type { ZelavisPrincipal, ZelavisRouteContext, ZelavisRouteResponse, ZelavisServerRoute } from "../../core/index.js";
import { accountsModule } from "../accounts/accounts.js";
import type { AuthAuthenticator } from "../core/authenticator.js";
import type { AuthCall, CoreRuntime } from "../core/context.js";
import { type AuthCookieConfig, clearAuthCookies, readCookie, responseCookies, writeAuthCookies } from "../core/cookies.js";
import type { AuthCore } from "../core/setup.js";
import type { AuthKeysAdmin } from "../keys/keys.js";
import { authRequest } from "../runtime/index.js";
import { errorBody, noStore, respond } from "./errors.js";

export interface AuthCoreRoutesOptions {
  readonly core: AuthCore;
  readonly runtime: CoreRuntime;
  readonly keys: AuthKeysAdmin;
  readonly authenticator: AuthAuthenticator;
  readonly role: "platform" | "project";
  readonly projectId?: string | undefined;
  readonly cookies: { readonly accessName: string; readonly refreshName: string; readonly apiBase: string; readonly accessPath?: string };
  readonly clock: () => number;
}

/** A refresh token is 32 random bytes in base64url (`generateRefreshToken`). */
const REFRESH_TOKEN = /^[A-Za-z0-9_-]{43}$/;

const BODY_LIMIT = 4096;

const sessionIdOf = (principal: ZelavisPrincipal): string | undefined => {
  const sessionId = principal.metadata?.sessionId;
  return typeof sessionId === "string" ? sessionId : undefined;
};

/** The call a signed-in request makes: its trusted client address and its session. */
export const callOf = (context: ZelavisRouteContext): AuthCall => {
  const sessionId = context.principal === undefined ? undefined : sessionIdOf(context.principal);
  return {
    ...authRequest(context.request),
    caller: context.principal === undefined || sessionId === undefined ? undefined : { sessionId, userId: context.principal.id },
  };
};

const cookieConfig = (options: AuthCoreRoutesOptions, request: Request): AuthCookieConfig => ({
  ...options.cookies,
  secure: new URL(request.url).protocol === "https:",
});

/**
 * Where a request's refresh token comes from: its body (SDK, CLI and native
 * clients) or its refresh cookie (browsers on Zelavis origins). A browser
 * request that carries an `Origin` must carry this one's, so a page of another
 * origin cannot spend or end the cookie's session.
 */
type RefreshSource =
  | { readonly mode: "body" | "cookie"; readonly token: string }
  | { readonly mode: "none" }
  | { readonly mode: "refused"; readonly response: ZelavisRouteResponse };

const refreshSource = (options: AuthCoreRoutesOptions, context: ZelavisRouteContext): RefreshSource => {
  const body = context.body;
  if (typeof body === "object" && body !== null && "refreshToken" in body && body.refreshToken !== undefined) {
    return typeof body.refreshToken === "string" && REFRESH_TOKEN.test(body.refreshToken)
      ? { mode: "body", token: body.refreshToken }
      : { mode: "refused", response: errorBody(400, "invalid_token", "The refresh token is malformed.") };
  }
  const cookie = readCookie(context.request, options.cookies.refreshName);
  if (cookie === undefined) return { mode: "none" };
  const origin = context.request.headers.get("origin");
  if (origin !== null && origin !== new URL(context.request.url).origin) {
    return { mode: "refused", response: errorBody(403, "forbidden", "Cross-origin session requests are refused.") };
  }
  return REFRESH_TOKEN.test(cookie)
    ? { mode: "cookie", token: cookie }
    : { mode: "refused", response: errorBody(400, "invalid_token", "The refresh token is malformed.") };
};

export function defineAuthCoreRoutes(options: AuthCoreRoutesOptions): ReadonlyArray<ZelavisServerRoute> {
  const settingsAccess = options.role === "platform"
    ? { permissions: ["system.settings.manage"] }
    : {
        permissions: ["project.settings.manage"],
        ...(options.projectId === undefined ? {} : { scope: { type: "project" as const, projectId: options.projectId } }),
      };

  const signedIn = (context: ZelavisRouteContext) => context.principal;

  return [
    {
      id: "auth.session.current",
      method: "GET",
      path: "/session",
      spec: {
        operationId: "getCurrentSession",
        summary: "The caller's session and account",
        tags: ["auth"],
        responses: { 200: { description: "The session" }, 401: { description: "Not signed in, or the access token expired" } },
      },
      handler: (context) => respond(Effect.gen(function* () {
        const principal = signedIn(context);
        const sessionId = principal === undefined ? undefined : sessionIdOf(principal);
        if (principal === undefined || sessionId === undefined) {
          return options.authenticator.expiredToken(context.request)
            ? errorBody(401, "access_token_expired", "The access token expired; refresh the session.")
            : errorBody(401, "not_signed_in", "Not signed in.");
        }
        const account = yield* options.runtime.query(callOf(context), (tx) => accountsModule.get(tx, principal.id));
        if (account === null) return errorBody(401, "not_signed_in", "Not signed in.");
        return {
          status: 200,
          headers: noStore,
          body: {
            sessionId,
            account: {
              id: account._id,
              kind: account.kind,
              displayName: account.displayName,
              roles: account.roles,
              permissions: account.permissions,
              grants: account.grants,
              accessRevision: account.accessRevision,
            },
          },
        };
      })),
    },
    {
      id: "auth.session.refresh",
      method: "POST",
      path: "/session/refresh",
      maxRequestBodyBytes: BODY_LIMIT,
      invalidJsonBodyCode: "invalid_token",
      spec: {
        operationId: "refreshSession",
        summary: "Exchange a refresh token for new tokens",
        tags: ["auth"],
        requestBody: { required: false, schema: { type: "object", properties: { refreshToken: { type: "string" } } } },
        responses: { 200: { description: "A rotated bundle, or noSession" }, 400: { description: "Malformed refresh token" } },
      },
      handler: (context) => respond(Effect.gen(function* () {
        const source = refreshSource(options, context);
        if (source.mode === "refused") return source.response;
        const cookies = responseCookies();
        const config = cookieConfig(options, context.request);
        if (source.mode === "none") return errorBody(400, "invalid_token", "A refresh token is required.");
        const result = yield* options.core.refreshSession(callOf(context), { refreshToken: source.token });
        if (source.mode === "cookie") {
          if (result.kind === "rotated") {
            writeAuthCookies(cookies.store, result.tokens, config, options.clock());
            return {
              status: 200,
              headers: [...Object.entries(noStore), ...cookies.headers()],
              // The tokens stay in the cookies: the page never sees them.
              body: { kind: "rotated", userId: result.tokens.userId, refreshTokenExpiresAt: result.tokens.refreshTokenExpiresAt },
            };
          }
          clearAuthCookies(cookies.store, config);
          return { status: 200, headers: [...Object.entries(noStore), ...cookies.headers()], body: { kind: "noSession" } };
        }
        return { status: 200, headers: noStore, body: result };
      })),
    },
    {
      id: "auth.session.revokeCurrent",
      method: "DELETE",
      path: "/session",
      maxRequestBodyBytes: BODY_LIMIT,
      invalidJsonBodyCode: "invalid_token",
      spec: {
        operationId: "signOut",
        summary: "End the current session",
        tags: ["auth"],
        requestBody: { required: false, schema: { type: "object", properties: { refreshToken: { type: "string" } } } },
        responses: { 204: { description: "Signed out" }, 400: { description: "Malformed refresh token" } },
      },
      handler: (context) => respond(Effect.gen(function* () {
        const source = refreshSource(options, context);
        if (source.mode === "refused") return source.response;
        const call = callOf(context);
        if (source.mode !== "none") yield* options.core.signOut(call, { refreshToken: source.token });
        const sessionId = call.caller?.sessionId;
        if (sessionId !== undefined) yield* options.core.revokeSessions(call, { sessionIds: [sessionId] });
        const cookies = responseCookies();
        clearAuthCookies(cookies.store, cookieConfig(options, context.request));
        return { status: 204, headers: [...Object.entries(noStore), ...cookies.headers()] };
      })),
    },
    {
      id: "auth.sessions.listCurrentAccount",
      method: "GET",
      path: "/sessions",
      access: { authenticated: true },
      spec: {
        operationId: "listSessions",
        summary: "The caller's sessions",
        tags: ["auth"],
        responses: { 200: { description: "Sessions, newest first" } },
      },
      handler: (context) => respond(Effect.gen(function* () {
        const call = callOf(context);
        const caller = call.caller;
        if (caller === undefined) return errorBody(401, "not_signed_in", "Not signed in.");
        const sessions = yield* options.core.listSessions(call, { userId: caller.userId });
        return {
          status: 200,
          headers: noStore,
          body: sessions.map((session) => ({ ...session, current: session.sessionId === caller.sessionId })),
        };
      })),
    },
    {
      id: "auth.sessions.revokeCurrentAccountSession",
      method: "DELETE",
      path: "/sessions/:sessionId",
      access: { authenticated: true },
      spec: {
        operationId: "revokeSession",
        summary: "End one of the caller's sessions",
        tags: ["auth"],
        pathParams: { sessionId: { type: "string", required: true } },
        responses: { 204: { description: "Revoked" }, 404: { description: "No such session of the caller's" } },
      },
      handler: (context) => respond(Effect.gen(function* () {
        const call = callOf(context);
        const caller = call.caller;
        if (caller === undefined) return errorBody(401, "not_signed_in", "Not signed in.");
        const sessionId = context.params.sessionId ?? "";
        // Only the caller's own sessions: another account's session reads as absent.
        const session = yield* options.core.getSession(call, { sessionId });
        if (session === null || session.userId !== caller.userId) return errorBody(404, "not_found", "No such session.");
        yield* options.core.revokeSessions(call, { sessionIds: [sessionId] });
        if (sessionId !== caller.sessionId) return { status: 204, headers: noStore };
        const cookies = responseCookies();
        clearAuthCookies(cookies.store, cookieConfig(options, context.request));
        return { status: 204, headers: [...Object.entries(noStore), ...cookies.headers()] };
      })),
    },
    {
      id: "auth.sessions.revokeOthers",
      method: "POST",
      path: "/sessions/revoke-others",
      access: { authenticated: true },
      spec: {
        operationId: "revokeOtherSessions",
        summary: "End every other session of the caller's account",
        tags: ["auth"],
        responses: { 200: { description: "How many active sessions were ended" } },
      },
      handler: (context) => respond(Effect.gen(function* () {
        const revoked = yield* options.core.revokeOtherSessions(callOf(context));
        return { status: 200, headers: noStore, body: { revoked } };
      })),
    },
    {
      id: "auth.keys.jwks",
      method: "GET",
      path: "/jwks",
      spec: {
        operationId: "getJwks",
        summary: "The keys that verify this runtime's access tokens",
        tags: ["auth"],
        responses: { 200: { description: "A JSON Web Key Set" } },
      },
      handler: () => respond(Effect.map(options.keys.jwks(), (set) => ({
        status: 200,
        headers: { "cache-control": "public, max-age=300" },
        body: set,
      }))),
    },
    {
      id: "auth.keys.rotate",
      method: "POST",
      path: "/keys/rotate",
      access: settingsAccess,
      spec: {
        operationId: "rotateSigningKey",
        summary: "Retire the signing key and create a new one",
        tags: ["auth"],
        responses: { 200: { description: "The new key id" }, 403: { description: "Forbidden" } },
      },
      handler: () => respond(Effect.map(options.keys.rotate(), ({ kid }) => ({ status: 200, headers: noStore, body: { kid } }))),
    },
  ];
}
