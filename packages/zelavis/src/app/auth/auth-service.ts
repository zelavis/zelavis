import type { PasswordProviderOptions } from "./providers/password.js";
import {
  createMappedJsonErrorResponse,
  type ZelavisServerErrorStatusRule,
  type ZelavisRuntimeService,
  type ZelavisServerRoute,
} from "../../core/index.js";
import type { AuthApi, AuthMethodPlugin } from "./core/types.js";
import type { AuthBootstrapCapability } from "./core/types.js";
import { createAuth, type CreateAuthOptions } from "./core/create-auth.js";
import { createSessionCookie } from "./core/session-authenticator.js";
import {
  AuthDomainError,
  AuthInvalidCredentialsError,
  AuthNotFoundError,
  AuthRateLimitError,
  AuthValidationError,
} from "./core/errors.js";

const authErrorRules: readonly ZelavisServerErrorStatusRule[] = [
  {
    matches: (error) => error instanceof AuthInvalidCredentialsError,
    status: 401,
  },
  {
    matches: (error) => error instanceof AuthRateLimitError,
    status: 429,
  },
  {
    matches: (error) => error instanceof AuthNotFoundError,
    status: 404,
  },
  {
    matches: (error) =>
      error instanceof AuthValidationError || error instanceof TypeError,
    status: 400,
  },
  {
    matches: (error) => error instanceof AuthDomainError,
    status: 400,
  },
];

function authErrorResponse(error: unknown, fallback = 500) {
  return createMappedJsonErrorResponse(error, authErrorRules, fallback);
}

function publicSession<T extends { tokenHash: string }>(session: T) {
  const { tokenHash: _tokenHash, ...safe } = session;
  return safe;
}

export type AuthServiceDefinition = Readonly<
  ZelavisRuntimeService<AuthApi> & {
    kind?: string;
    capabilities?: readonly string[];
  }
>;

export interface AuthSessionCookieOptions {
  name?: string;
  path?: string;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface DefineAuthServiceOptions {
  authority?: "project" | "platform";
  bootstrap?: AuthBootstrapCapability;
  /**
   * Reads and writes the credentials an operator configured for OAuth
   * providers. Supplied by the Platform, which owns the store these live in.
   */
  oauthConnections?: {
    list(): Promise<readonly unknown[]>;
    configure(provider: string, input: unknown): Promise<unknown | undefined>;
    remove(provider: string): Promise<void>;
  };
  bootstrapToken?: string;
  sessionCookie?: false | AuthSessionCookieOptions;
}

function sessionCookieHeader(
  token: string,
  expiresAt: Date,
  request: Request,
  options: AuthSessionCookieOptions,
): string {
  return createSessionCookie(token, {
    ...options,
    secure: options.secure ?? new URL(request.url).protocol === "https:",
    maxAgeSeconds: Math.max(
      0,
      Math.floor((expiresAt.getTime() - Date.now()) / 1000),
    ),
  });
}

function browserSessionCookieHeader(
  token: string,
  expiresAt: Date,
  request: Request,
  options: AuthSessionCookieOptions,
): string | undefined {
  const origin = request.headers.get("origin");
  if (!origin) return undefined;
  try {
    if (new URL(origin).origin !== new URL(request.url).origin) return undefined;
  } catch {
    return undefined;
  }
  return sessionCookieHeader(token, expiresAt, request, options);
}

function expiredSessionCookieHeader(
  request: Request,
  options: AuthSessionCookieOptions,
): string | undefined {
  return browserSessionCookieHeader("", new Date(0), request, options);
}

function validateBootstrapToken(token: string | undefined): string | undefined {
  if (token === undefined) return undefined;
  if (typeof token !== "string" || token.length < 32 || token.length > 1024) {
    throw new TypeError(
      "Platform bootstrap tokens must contain between 32 and 1024 characters.",
    );
  }
  return token;
}

function tokensEqual(left: string, right: unknown): boolean {
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

export function defineAuthService(
  auth: AuthApi,
  options: DefineAuthServiceOptions = {},
): AuthServiceDefinition {
  const managePermission = options.authority === "platform"
    ? "system.users.manage"
    : "project.users.manage";
  const cookieOptions = options.sessionCookie === false
    ? undefined
    : options.sessionCookie;
  const bootstrapToken = validateBootstrapToken(options.bootstrapToken);
  const routes: readonly ZelavisServerRoute<AuthApi>[] = [
        {
          id: "auth.accounts.list",
          method: "GET",
          path: "/accounts",
          access: { permissions: [managePermission] },
          spec: {
            operationId: "listAccounts",
            summary: "List accounts",
            tags: ["auth"],
            responses: {
              200: { description: "List of accounts" },
            },
          },
          handler: async ({ service }) => ({
            status: 200,
            body: await service.accounts.list(),
          }),
        },
        {
          id: "auth.accounts.create",
          method: "POST",
          path: "/accounts",
          access: { permissions: [managePermission] },
          spec: {
            operationId: "createAccount",
            summary: "Create an account",
            tags: ["auth"],
            requestBody: {
              required: true,
              schema: { type: "object", additionalProperties: true, description: "Account creation data" },
            },
            responses: {
              201: { description: "Account created successfully" },
              400: { description: "Validation error" },
            },
          },
          handler: async ({ service, body }) => {
            try {
              return {
                status: 201,
                body: await service.accounts.create(
                  body as Parameters<AuthApi["accounts"]["create"]>[0],
                ),
              };
            } catch (error) {
              return authErrorResponse(error, 400);
            }
          },
        },
        {
          id: "auth.credentials.create",
          method: "POST",
          path: "/credentials",
          access: { permissions: [managePermission] },
          spec: {
            operationId: "createCredentials",
            summary: "Create credentials",
            tags: ["auth"],
            requestBody: {
              required: true,
              schema: { type: "object", additionalProperties: true, description: "Credentials data" },
            },
            responses: {
              201: { description: "Credentials created successfully" },
              400: { description: "Validation error" },
            },
          },
          handler: async ({ service, body }) => {
            try {
              return {
                status: 201,
                body: await service.credentials.create(
                  body as Parameters<AuthApi["credentials"]["create"]>[0],
                ),
              };
            } catch (error) {
              return authErrorResponse(error, 400);
            }
          },
        },
        {
          id: "auth.providers.list",
          method: "GET",
          path: "/providers",
          spec: {
            operationId: "listProviders",
            summary: "List auth providers",
            tags: ["auth"],
            responses: {
              200: { description: "List of auth providers" },
            },
          },
          handler: ({ service }) => ({
            status: 200,
            body: service.authentication.listProviders(),
          }),
        },
        {
          id: "auth.recovery.providers.list",
          method: "GET",
          path: "/recovery/providers",
          handler: ({ service }) => ({
            status: 200,
            body: service.authentication.listRecoveryProviders(),
          }),
        },
        {
          id: "auth.authorizationCode.providers.list",
          method: "GET",
          path: "/oauth/providers",
          handler: ({ service }) => ({
            status: 200,
            body: service.authentication.listAuthorizationCodeProviders(),
          }),
        },
        {
          id: "auth.authorizationCode.start",
          method: "POST",
          path: "/oauth/:provider/start",
          handler: async ({ service, params }) => {
            try {
              return {
                status: 200,
                body: await service.authentication.beginAuthorizationCode(
                  params.provider,
                ),
              };
            } catch (error) {
              return authErrorResponse(error, 400);
            }
          },
        },
        {
          id: "auth.authorizationCode.link.start",
          method: "POST",
          path: "/oauth/:provider/link/start",
          access: { authenticated: true },
          handler: async ({ service, params, principal }) => {
            try {
              return {
                status: 200,
                body: await service.authentication.beginAuthorizationCode(
                  params.provider,
                  { mode: "link", accountId: principal!.id },
                ),
              };
            } catch (error) {
              return authErrorResponse(error, 400);
            }
          },
        },
        {
          id: "auth.authorizationCode.callback",
          method: "GET",
          path: "/oauth/:provider/callback",
          handler: async ({ service, params, query, request }) => {
            try {
              const providerError = query.get("error");
              if (providerError) {
                throw new AuthValidationError(
                  `Authorization provider returned ${providerError}.`,
                );
              }
              const result = await service.authentication.completeAuthorizationCode(
                params.provider,
                {
                  state: query.get("state") ?? "",
                  code: query.get("code") ?? "",
                },
              );
              const sessionCookie =
                cookieOptions && result.session && request
                  ? sessionCookieHeader(
                      result.session.token,
                      result.session.session.expiresAt,
                      request,
                      cookieOptions,
                    )
                  : undefined;
              return {
                status: 200,
                headers: sessionCookie
                  ? ({ "set-cookie": sessionCookie } as Record<string, string>)
                  : undefined,
                body: {
                  ...result,
                  session: result.session
                    ? {
                        token: result.session.token,
                        session: publicSession(result.session.session),
                      }
                    : undefined,
                },
              };
            } catch (error) {
              return authErrorResponse(error, 400);
            }
          },
        },
        {
          id: "auth.recovery.begin",
          method: "POST",
          path: "/recovery/:provider",
          spec: {
            operationId: "beginCredentialRecovery",
            summary: "Begin provider-owned credential recovery",
            tags: ["auth"],
            responses: { 202: { description: "Recovery request accepted" } },
          },
          handler: async ({ service, params, body }) => {
            try {
              return {
                status: 202,
                body: await service.authentication.beginRecovery(
                  params.provider,
                  body as Parameters<AuthApi["authentication"]["beginRecovery"]>[1],
                ),
              };
            } catch (error) {
              return authErrorResponse(error, 400);
            }
          },
        },
        {
          id: "auth.recovery.complete",
          method: "POST",
          path: "/recovery/:provider/complete",
          spec: {
            operationId: "completeCredentialRecovery",
            summary: "Complete provider-owned credential recovery",
            tags: ["auth"],
            responses: {
              204: { description: "Credential recovered" },
              400: { description: "Invalid or expired recovery" },
            },
          },
          handler: async ({ service, params, body }) => {
            try {
              await service.authentication.completeRecovery(
                params.provider,
                body as Parameters<AuthApi["authentication"]["completeRecovery"]>[1],
              );
              return { status: 204 };
            } catch (error) {
              return authErrorResponse(error, 400);
            }
          },
        },
        {
          id: "auth.authenticate",
          method: "POST",
          path: "/authenticate/:provider",
          spec: {
            operationId: "authenticate",
            summary: "Authenticate with a provider",
            tags: ["auth"],
            pathParams: {
              provider: { type: "string", required: true, description: "Auth provider name" },
            },
            requestBody: {
              required: true,
              schema: { type: "object", additionalProperties: true, description: "Authentication payload" },
            },
            responses: {
              200: { description: "Authentication successful" },
              404: { description: "Provider not found or auth failed" },
            },
          },
          handler: async ({ service, params, body, request }) => {
            let attempt;
            try {
              attempt = await service.security.beginAuthentication(
                params.provider,
                body,
              );
              const result = await service.authentication.authenticate(
                params.provider,
                body as Parameters<
                  AuthApi["authentication"]["authenticate"]
                >[1],
              );
              await service.security.authenticationSucceeded(
                attempt,
                result.account.id,
              );
              const sessionCookie = result.session && cookieOptions
                ? browserSessionCookieHeader(
                    result.session.token,
                    result.session.session.expiresAt,
                    request,
                    cookieOptions,
                  )
                : undefined;
              return {
                status: 200,
                headers: sessionCookie
                  ? ({ "set-cookie": sessionCookie } as Record<string, string>)
                  : undefined,
                body: result.session
                  ? {
                      ...result,
                      session: {
                        token: result.session.token,
                        session: publicSession(result.session.session),
                      },
                    }
                  : result,
              };
            } catch (error) {
              if (attempt && !(error instanceof AuthRateLimitError)) {
                await service.security.authenticationFailed(attempt);
              }
              if (error instanceof AuthRateLimitError) {
                return {
                  ...authErrorResponse(error, 429),
                  headers: {
                    "retry-after": String(error.retryAfterSeconds),
                  } as Record<string, string>,
                };
              }
              return authErrorResponse(error, 404);
            }
          },
        },
        {
          id: "auth.securityEvents.list",
          method: "GET",
          path: "/security/events",
          access: { permissions: [managePermission] },
          spec: {
            operationId: "listAuthSecurityEvents",
            summary: "List authentication security events",
            tags: ["auth", "security"],
            responses: { 200: { description: "Authentication security events" } },
          },
          handler: async ({ service }) => ({
            status: 200,
            body: { events: await service.security.listEvents() },
          }),
        },
        {
          id: "auth.sessions.listByAccountId",
          method: "GET",
          path: "/accounts/:accountId/sessions",
          access: { permissions: [managePermission] },
          spec: {
            operationId: "listSessionsByAccountId",
            summary: "List sessions for an account",
            tags: ["auth"],
            pathParams: {
              accountId: { type: "string", required: true, description: "Account ID" },
            },
            responses: {
              200: { description: "List of sessions" },
            },
          },
          handler: async ({ service, params }) => ({
            status: 200,
            body: (await service.sessions.listByAccountId(params.accountId)).map(publicSession),
          }),
        },
        {
          id: "auth.session.current",
          method: "GET",
          path: "/session",
          access: { authenticated: true },
          spec: {
            operationId: "getCurrentSession",
            summary: "Get current session",
            tags: ["auth"],
            responses: {
              200: { description: "Current session details" },
            },
          },
          handler: ({ principal }) => ({ status: 200, body: { principal } }),
        },
        {
          id: "auth.sessions.listCurrentAccount",
          method: "GET",
          path: "/sessions",
          access: { authenticated: true },
          spec: {
            operationId: "listCurrentAccountSessions",
            summary: "List devices and sessions for the current account",
            tags: ["auth"],
            responses: { 200: { description: "Current account sessions" } },
          },
          handler: async ({ service, principal }) => ({
            status: 200,
            body: {
              sessions: (
                await service.sessions.listByAccountId(principal!.id)
              ).map(publicSession),
              currentSessionId: principal?.metadata?.sessionId,
            },
          }),
        },
        {
          id: "auth.sessions.revokeCurrentAccountSession",
          method: "DELETE",
          path: "/sessions/:sessionId",
          access: { authenticated: true },
          spec: {
            operationId: "revokeCurrentAccountSession",
            summary: "Revoke one device session owned by the current account",
            tags: ["auth"],
            responses: {
              204: { description: "Session revoked" },
              404: { description: "Session not found" },
            },
          },
          handler: async ({ service, principal, params }) => {
            const session = await service.sessions.findById(params.sessionId);
            if (!session || session.accountId !== principal!.id) {
              return { status: 404, body: { error: "Session not found" } };
            }
            await service.sessions.revoke(session.id);
            return { status: 204 };
          },
        },
        {
          id: "auth.sessions.revokeManagedSession",
          method: "DELETE",
          path: "/accounts/:accountId/sessions/:sessionId",
          access: { permissions: [managePermission] },
          spec: {
            operationId: "revokeManagedAccountSession",
            summary: "Revoke one session for a managed account",
            tags: ["auth"],
            responses: {
              204: { description: "Session revoked" },
              404: { description: "Session not found" },
            },
          },
          handler: async ({ service, params }) => {
            const session = await service.sessions.findById(params.sessionId);
            if (!session || session.accountId !== params.accountId) {
              return { status: 404, body: { error: "Session not found" } };
            }
            await service.sessions.revoke(session.id);
            return { status: 204 };
          },
        },
        {
          id: "auth.sessions.revokeManagedAccountSessions",
          method: "DELETE",
          path: "/accounts/:accountId/sessions",
          access: { permissions: [managePermission] },
          spec: {
            operationId: "revokeManagedAccountSessions",
            summary: "Revoke every active session for a managed account",
            tags: ["auth"],
            responses: { 200: { description: "Sessions revoked" } },
          },
          handler: async ({ service, params }) => ({
            status: 200,
            body: {
              revoked: (
                await service.sessions.revokeAll(params.accountId)
              ).map(publicSession),
            },
          }),
        },
        {
          id: "auth.session.rotateCurrent",
          method: "POST",
          path: "/session/rotate",
          access: { authenticated: true },
          spec: {
            operationId: "rotateCurrentSession",
            summary: "Rotate the current session token",
            tags: ["auth"],
            responses: {
              200: { description: "Session rotated" },
              400: { description: "Not a rotatable session" },
              404: { description: "Session not found or expired" },
            },
          },
          handler: async ({ service, principal, request }) => {
            const sessionId = principal?.metadata?.sessionId;
            if (typeof sessionId !== "string") {
              return { status: 400, body: { error: "The current authentication method is not a rotatable session." } };
            }
            const rotated = await service.sessions.rotate(sessionId);
            if (!rotated) {
              return { status: 404, body: { error: "Session not found or expired" } };
            }
            const sessionCookie = cookieOptions
              ? browserSessionCookieHeader(
                  rotated.token,
                  rotated.session.expiresAt,
                  request,
                  cookieOptions,
                )
              : undefined;
            return {
              status: 200,
              headers: sessionCookie
                ? { "set-cookie": sessionCookie }
                : undefined,
              body: {
                token: rotated.token,
                session: publicSession(rotated.session),
              },
            };
          },
        },
        {
          id: "auth.session.revokeCurrent",
          method: "DELETE",
          path: "/session",
          access: { authenticated: true },
          spec: {
            operationId: "revokeCurrentSession",
            summary: "Revoke current session",
            tags: ["auth"],
            responses: {
              204: { description: "Session revoked" },
              400: { description: "Not a revocable session" },
              404: { description: "Session not found" },
            },
          },
          handler: async ({ service, principal, request }) => {
            const sessionId = principal?.metadata?.sessionId;
            if (typeof sessionId !== "string") {
              return { status: 400, body: { error: "The current authentication method is not a revocable session." } };
            }
            const revoked = await service.sessions.revoke(sessionId);
            const expiredCookie = cookieOptions
              ? expiredSessionCookieHeader(request, cookieOptions)
              : undefined;
            return revoked
              ? {
                  status: 204,
                  headers: expiredCookie
                    ? { "set-cookie": expiredCookie }
                    : undefined,
                }
              : { status: 404, body: { error: "Session not found" } };
          },
        },
        ...(options.oauthConnections
          ? [
              {
                id: "auth.oauth.connections.list",
                method: "GET" as const,
                path: "/oauth/connections",
                access: { permissions: ["system.settings.manage"] },
                spec: {
                  operationId: "listOAuthConnections",
                  summary: "List OAuth providers and their configuration",
                  tags: ["auth"],
                  responses: { 200: { description: "Installed providers" } },
                },
                handler: async () => ({
                  status: 200,
                  body: { providers: await options.oauthConnections!.list() },
                }),
              },
              {
                id: "auth.oauth.connections.configure",
                method: "PUT" as const,
                path: "/oauth/connections/:provider",
                access: { permissions: ["system.settings.manage"] },
                spec: {
                  operationId: "configureOAuthConnection",
                  summary: "Configure an OAuth provider for this installation",
                  tags: ["auth"],
                  pathParams: {
                    provider: { type: "string" as const, required: true, description: "Provider name" },
                  },
                  requestBody: {
                    required: true,
                    schema: { type: "object", additionalProperties: true },
                  },
                  responses: {
                    200: { description: "Connection saved" },
                    400: { description: "Invalid connection details" },
                    404: { description: "No such provider is installed" },
                  },
                },
                handler: async ({ params, body }: { params: Record<string, string>; body: unknown }) => {
                  try {
                    const saved = await options.oauthConnections!.configure(
                      params.provider,
                      body,
                    );
                    return saved
                      ? { status: 200, body: { connection: saved } }
                      : {
                          status: 404,
                          body: {
                            error: `No installed plugin defines "${params.provider}".`,
                          },
                        };
                  } catch (error) {
                    return authErrorResponse(error, 400);
                  }
                },
              },
              {
                id: "auth.oauth.connections.remove",
                method: "DELETE" as const,
                path: "/oauth/connections/:provider",
                access: { permissions: ["system.settings.manage"] },
                spec: {
                  operationId: "removeOAuthConnection",
                  summary: "Remove an OAuth provider's configuration",
                  tags: ["auth"],
                  pathParams: {
                    provider: { type: "string" as const, required: true, description: "Provider name" },
                  },
                  responses: { 204: { description: "Connection removed" } },
                },
                handler: async ({ params }: { params: Record<string, string> }) => {
                  await options.oauthConnections!.remove(params.provider);
                  return { status: 204 };
                },
              },
            ]
          : []),
        ...(options.bootstrap
          ? [
              {
                id: "auth.bootstrap.status",
                method: "GET" as const,
                path: "/bootstrap",
                spec: {
                  operationId: "getAuthBootstrapStatus",
                  summary: "Get first-owner bootstrap status",
                  tags: ["auth"],
                  responses: { 200: { description: "Bootstrap status" } },
                },
                handler: async () => ({
                  status: 200,
                  body: {
                    ...(await options.bootstrap!.status()),
                    available: Boolean(bootstrapToken),
                    tokenRequired: true,
                  },
                }),
              },
              {
                id: "auth.bootstrap.createOwner",
                method: "POST" as const,
                path: "/bootstrap",
                spec: {
                  operationId: "bootstrapPlatformOwner",
                  summary: "Create the first Platform owner",
                  tags: ["auth"],
                  requestBody: {
                    required: true,
                    schema: { type: "object", additionalProperties: true },
                  },
                  responses: {
                    201: { description: "First owner created" },
                    400: { description: "Invalid or completed bootstrap" },
                  },
                },
                handler: async ({ body, request }: { body: unknown; request: Request }) => {
                  try {
                    if (!bootstrapToken) {
                      return {
                        status: 503,
                        body: {
                          error: "First-owner bootstrap is disabled. Configure ZELAVIS_BOOTSTRAP_TOKEN or Zelavis bootstrap.token and restart the Platform.",
                        },
                      };
                    }
                    if (
                      !body ||
                      typeof body !== "object" ||
                      !tokensEqual(
                        bootstrapToken,
                        (body as { bootstrapToken?: unknown }).bootstrapToken,
                      )
                    ) {
                      return {
                        status: 403,
                        body: { error: "Invalid Platform bootstrap token." },
                      };
                    }
                    const result = await options.bootstrap!.bootstrap(
                      body as Parameters<AuthBootstrapCapability["bootstrap"]>[0],
                    );
                    const sessionCookie = cookieOptions
                      ? browserSessionCookieHeader(
                          result.session.token,
                          result.session.session.expiresAt,
                          request,
                          cookieOptions,
                        )
                      : undefined;
                    return {
                      status: 201,
                      headers: sessionCookie
                        ? { "set-cookie": sessionCookie }
                        : undefined,
                      body: {
                        account: result.account,
                        session: {
                          token: result.session.token,
                          session: publicSession(result.session.session),
                        },
                      },
                    };
                  } catch (error) {
                    return authErrorResponse(error, 400);
                  }
                },
              },
            ]
          : []),
  ];

  return Object.freeze({
    name: "zelavis/auth",
    kind: "plugin",
    capabilities: Object.freeze(["api:routes", "dashboard:menu"]),
    authenticators: [auth.requestAuthenticator],
    basePath: "/auth",
    // No menu. Core auth is the API and the authority; the settings page is
    // `@zelavis/auth`, a product service. Both contributing an "Auth" entry
    // would put two of them in the sidebar, and the one without a page would
    // lead nowhere.
    service: auth,
    api: {
      v1: routes,
    },
  });
}

export interface AuthServiceOptions {
  /** Options for the built-in password provider. */
  password?: PasswordProviderOptions;
  /** Options for the built-in OAuth Authorization Code client. */
  oauth?: {
    /** Used for token and profile requests. Defaults to the global fetch. */
    fetch?: typeof globalThis.fetch;
  };
  auth?: AuthApi;
  authOptions?: CreateAuthOptions;
  methods?: readonly AuthMethodPlugin[];
  definition?: DefineAuthServiceOptions;
}

export async function authService(
  options: AuthServiceOptions = {},
): Promise<AuthServiceDefinition> {
  const auth =
    options.auth ??
    (await createAuth({
      ...(options.authOptions ?? {}),
      methods: [
        ...(options.authOptions?.methods ?? []),
        ...(options.methods ?? []),
      ],
    }));

  return defineAuthService(auth, options.definition);
}
