import {
  createMappedJsonErrorResponse,
  type ZelavisServerErrorStatusRule,
  defineService,
  type ZelavisServiceDefinition,
  type ZelavisRuntimeService,
} from "../../core/index.js";
import type { AuthApi, AuthMethodPlugin } from "./core/types.js";
import type { AuthBootstrapCapability } from "./core/types.js";
import { createAuth, type CreateAuthOptions } from "./core/create-auth.js";
import { createSessionCookie } from "./core/session-authenticator.js";
import {
  AuthDomainError,
  AuthInvalidCredentialsError,
  AuthNotFoundError,
  AuthValidationError,
} from "./core/errors.js";

const authErrorRules: readonly ZelavisServerErrorStatusRule[] = [
  {
    matches: (error) => error instanceof AuthInvalidCredentialsError,
    status: 401,
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
  ZelavisRuntimeService<AuthApi> & ZelavisServiceDefinition<AuthApi, AuthApi>
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
  return defineService<AuthApi, AuthApi>({
    name: "@zelavis/auth",
    kind: "plugin",
    capabilities: ["api:routes", "dashboard:menu"],
    authenticators: [auth.requestAuthenticator],
    basePath: "/auth",
    menu: {
      title: "Auth",
      path: "/auth",
      surface: "core",
    },
    service: auth,
    api: {
      v1: [
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
            try {
              const result = await service.authentication.authenticate(
                params.provider,
                body as Parameters<
                  AuthApi["authentication"]["authenticate"]
                >[1],
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
                  ? { "set-cookie": sessionCookie }
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
              return authErrorResponse(error, 404);
            }
          },
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
      ],
    },
  });
}

export interface AuthServiceOptions {
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
