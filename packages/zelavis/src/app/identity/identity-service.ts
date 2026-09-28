import type { PasswordProviderOptions } from "./providers/password.js";
import {
  createMappedJsonErrorResponse,
  type ZelavisServerErrorStatusRule,
  type ZelavisRuntimeService,
  type ZelavisServerRoute,
  type ZelavisRequestAuthenticator,
  type ZelavisPrincipalGrant,
} from "../../core/index.js";
import type { IdentityApi, IdentityMethodPlugin } from "./core/types.js";
import type { IdentityBootstrapCapability } from "./core/types.js";
import { createIdentity, type CreateIdentityOptions } from "./core/create-identity.js";
import { createSessionCookie } from "./core/session-authenticator.js";
import {
  IdentityDomainError,
  AuthInvalidCredentialsError,
  IdentityNotFoundError,
  AuthRateLimitError,
  IdentityValidationError,
} from "./core/errors.js";
import { isValidTenantId } from "../../db/naming.js";

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
    matches: (error) => error instanceof IdentityNotFoundError,
    status: 404,
  },
  {
    matches: (error) =>
      error instanceof IdentityValidationError || error instanceof TypeError,
    status: 400,
  },
  {
    matches: (error) => error instanceof IdentityDomainError,
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

function publicCredential<T extends { secretHash?: string }>(credential: T) {
  const { secretHash: _secretHash, ...safe } = credential;
  return safe;
}

export type IdentityServiceDefinition = Readonly<
  ZelavisRuntimeService<IdentityApi> & {
    kind?: string;
    capabilities?: readonly string[];
  }
>;

export interface IdentitySessionCookieOptions {
  name?: string;
  path?: string;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface DefineAuthServiceOptions {
  authority?: "project" | "platform";
  /** Allow anonymous account enrollment. Intended for Project auth, never Platform owner creation. */
  registration?: boolean;
  bootstrap?: IdentityBootstrapCapability;
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
  sessionCookie?: false | IdentitySessionCookieOptions;
}

function sessionCookieHeader(
  token: string,
  expiresAt: Date,
  request: Request,
  options: IdentitySessionCookieOptions,
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
  options: IdentitySessionCookieOptions,
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
  options: IdentitySessionCookieOptions,
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

function serviceAccountGrants(value: unknown): readonly ZelavisPrincipalGrant[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new IdentityValidationError("Service account grants must be an array of at most 100 entries.");
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new IdentityValidationError("Each service account grant must be an object.");
    }
    const grant = entry as { permission?: unknown; scope?: unknown };
    if (typeof grant.permission !== "string" || !grant.permission.trim()) {
      throw new IdentityValidationError("Each service account grant requires a permission.");
    }
    const scope = grant.scope;
    if (!scope || typeof scope !== "object") {
      throw new IdentityValidationError("Service account grants require an explicit scope.");
    }
    const candidate = scope as Record<string, unknown>;
    if (candidate.type === "project" && typeof candidate.projectId === "string" && candidate.projectId.trim()) {
      return { permission: grant.permission.trim(), scope: { type: "project", projectId: candidate.projectId.trim() } };
    }
    if (candidate.type === "service" && typeof candidate.serviceName === "string" && candidate.serviceName.trim()) {
      return { permission: grant.permission.trim(), scope: { type: "service", serviceName: candidate.serviceName.trim() } };
    }
    if (candidate.type === "system") {
      return { permission: grant.permission.trim(), scope: { type: "system" } };
    }
    throw new IdentityValidationError("Service account grant scopes must name a system, Project, or service.");
  });
}

/**
 * The Tenant a service account acts in, if the caller named one.
 *
 * Validated rather than trusted, because a Tenant id becomes part of the
 * storage namespace: an id carrying a `/` would be read back as a different
 * Tenant entirely.
 */
function readTenantIdInput(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new IdentityValidationError("A Tenant id must be a non-empty string.");
  }
  const tenantId = value.trim();
  if (!isValidTenantId(tenantId)) {
    throw new IdentityValidationError(
      "A Tenant id may use letters, digits, dot, dash and underscore, must start with a letter or digit, and may not begin with the reserved \"zv.\" prefix.",
    );
  }
  return tenantId;
}

function serviceAccountPermissions(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some((permission) => typeof permission !== "string" || !permission.trim())) {
    throw new IdentityValidationError("Service account permissions must be an array of at most 100 names.");
  }
  return [...new Set(value.map((permission) => permission.trim()))];
}

export function defineAuthService(
  auth: IdentityApi,
  options: DefineAuthServiceOptions = {},
): IdentityServiceDefinition {
  const managePermission = options.authority === "platform"
    ? "system.users.manage"
    : "project.users.manage";
  const manageAccess = {
    permissions: [managePermission],
    ...(options.authority !== "platform" && auth.context.projectId
      ? { scope: { type: "project" as const, projectId: auth.context.projectId } }
      : {}),
  };
  const settingsAccess = {
    permissions: [options.authority === "platform"
      ? "system.settings.manage"
      : "project.settings.manage"],
    ...(options.authority !== "platform" && auth.context.projectId
      ? { scope: { type: "project" as const, projectId: auth.context.projectId } }
      : {}),
  };
  const cookieOptions = options.sessionCookie === false
    ? undefined
    : options.sessionCookie;
  const bootstrapToken = validateBootstrapToken(options.bootstrapToken);
  const routes: readonly ZelavisServerRoute<IdentityApi>[] = [
        {
          id: "auth.accounts.list",
          method: "GET",
          path: "/accounts",
          access: manageAccess,
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
          access: manageAccess,
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
                  body as Parameters<IdentityApi["accounts"]["create"]>[0],
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
          access: manageAccess,
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
                body: publicCredential(await service.credentials.create(
                  body as Parameters<IdentityApi["credentials"]["create"]>[0],
                )),
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
        ...(options.authority !== "platform" && options.registration
          ? [
              {
                id: "auth.registration.create",
                method: "POST" as const,
                path: "/sign-up/:provider",
                spec: {
                  operationId: "signUp",
                  summary: "Create an app account with a credential provider",
                  tags: ["auth"],
                  responses: {
                    201: { description: "Account created and signed in" },
                    400: { description: "Registration failed" },
                  },
                },
                handler: async ({ service, params, body, request }: { service: IdentityApi; params: Record<string, string>; body: unknown; request: Request }) => {
                  let accountId: string | undefined;
                  try {
                    const input = (body ?? {}) as Record<string, unknown>;
                    const prepared = await service.authentication.prepareCredential(
                      params.provider,
                      input as Parameters<IdentityApi["authentication"]["prepareCredential"]>[1],
                    );
                    accountId = `account_${crypto.randomUUID().replaceAll("-", "")}`;
                    const account = await service.accounts.create({
                      id: accountId,
                      ...prepared.accountIdentity,
                      ...(typeof input.displayName === "string" && input.displayName.trim()
                        ? { displayName: input.displayName.trim() }
                        : {}),
                    });
                    const credential = await service.credentials.create({
                      id: `credential_${crypto.randomUUID().replaceAll("-", "")}`,
                      accountId: account.id,
                      provider: params.provider,
                      identifier: prepared.identifier,
                      secretHash: prepared.secretHash,
                      metadata: prepared.metadata,
                    });
                    const session = await service.sessions.create({
                      accountId: account.id,
                      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
                      metadata: { provider: params.provider, authentication: "registration" },
                    });
                    const sessionCookie = cookieOptions
                      ? browserSessionCookieHeader(
                          session.token,
                          session.session.expiresAt,
                          request,
                          cookieOptions,
                        )
                      : undefined;
                    return {
                      status: 201,
                      headers: sessionCookie ? { "set-cookie": sessionCookie } : undefined,
                      body: {
                        account,
                        credential: publicCredential(credential),
                        session: { token: session.token, session: publicSession(session.session) },
                      },
                    };
                  } catch (error) {
                    if (accountId) await service.repositories.accounts.delete(accountId).catch(() => false);
                    return authErrorResponse(error, 400);
                  }
                },
              },
            ]
          : []),
        {
          id: "auth.recovery.providers.list",
          spec: {
            operationId: "listRecoveryProviders",
            summary: "List providers that support credential recovery",
            tags: ["auth"],
            responses: {
              200: { description: "Providers" },
            },
          },
          method: "GET",
          path: "/recovery/providers",
          handler: ({ service }) => ({
            status: 200,
            body: service.authentication.listRecoveryProviders(),
          }),
        },
        {
          id: "auth.authorizationCode.providers.list",
          spec: {
            operationId: "listAuthorizationCodeProviders",
            summary: "List providers offering an Authorization Code flow",
            tags: ["auth"],
            responses: {
              200: { description: "Providers" },
            },
          },
          method: "GET",
          path: "/oauth/providers",
          handler: ({ service }) => ({
            status: 200,
            body: service.authentication.listAuthorizationCodeProviders(),
          }),
        },
        {
          id: "auth.authorizationCode.start",
          spec: {
            operationId: "startAuthorizationCode",
            summary: "Begin an Authorization Code sign-in",
            tags: ["auth"],
            responses: {
              200: { description: "Authorization URL" },
              404: { description: "Provider unavailable" },
            },
          },
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
          spec: {
            operationId: "startAuthorizationCodeLink",
            summary: "Begin linking a provider to the signed-in account",
            tags: ["auth"],
            responses: {
              200: { description: "Authorization URL" },
              401: { description: "Not signed in" },
              404: { description: "Provider unavailable" },
            },
          },
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
          spec: {
            operationId: "completeAuthorizationCode",
            summary: "Complete an Authorization Code sign-in",
            tags: ["auth"],
            responses: {
              200: { description: "Signed in" },
              400: { description: "The callback does not match a pending flow" },
            },
          },
          method: "GET",
          path: "/oauth/:provider/callback",
          handler: async ({ service, params, query, request }) => {
            try {
              const providerError = query.get("error");
              if (providerError) {
                throw new IdentityValidationError(
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
                  credential: publicCredential(result.credential),
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
                  body as Parameters<IdentityApi["authentication"]["beginRecovery"]>[1],
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
                body as Parameters<IdentityApi["authentication"]["completeRecovery"]>[1],
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
                  IdentityApi["authentication"]["authenticate"]
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
                      credential: publicCredential(result.credential),
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
          access: manageAccess,
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
          access: manageAccess,
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
          access: manageAccess,
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
          access: manageAccess,
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
        ...(options.authority === "platform"
          ? [
              {
                id: "auth.serviceAccounts.list",
                method: "GET" as const,
                path: "/service-accounts",
                access: manageAccess,
                spec: {
                  operationId: "listServiceAccounts",
                  summary: "List Platform service accounts",
                  tags: ["auth", "service-accounts"],
                  responses: { 200: { description: "Service accounts" } },
                },
                handler: async ({ service }: { service: IdentityApi }) => ({
                  status: 200,
                  body: {
                    serviceAccounts: (await service.accounts.list()).filter(
                      (account) => account.metadata?.principalType === "service",
                    ),
                  },
                }),
              },
              {
                id: "auth.serviceAccounts.create",
                method: "POST" as const,
                path: "/service-accounts",
                access: manageAccess,
                spec: {
                  operationId: "createServiceAccount",
                  summary: "Create a Platform service account and issue its first token",
                  tags: ["auth", "service-accounts"],
                  responses: {
                    201: { description: "Service account and one-time token" },
                    400: { description: "Invalid service account" },
                  },
                },
                handler: async ({ service, body }: { service: IdentityApi; body: unknown }) => {
                  try {
                    const input = (body ?? {}) as Record<string, unknown>;
                    const name = typeof input.name === "string" ? input.name.trim() : "";
                    if (!name || name.length > 100) {
                      throw new IdentityValidationError("A service account name of at most 100 characters is required.");
                    }
                    const days = input.expiresInDays === undefined ? 90 : Number(input.expiresInDays);
                    if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
                      throw new IdentityValidationError("Service account token lifetime must be between 1 and 3650 days.");
                    }
                    const tenantId = readTenantIdInput(input.tenantId);
                    const id = `service_${crypto.randomUUID().replaceAll("-", "")}`;
                    const account = await service.accounts.create({
                      id,
                      username: id,
                      displayName: name,
                      verified: true,
                      roles: ["service"],
                      permissions: serviceAccountPermissions(input.permissions),
                      grants: serviceAccountGrants(input.grants),
                      // Without a Tenant an account is its own, which is a
                      // generated id no operator would recognise and no second
                      // client can ever join. Naming it is what lets an App's
                      // web client and its worker be one customer.
                      metadata: {
                        principalType: "service",
                        serviceAccount: true,
                        ...(tenantId ? { tenantId } : {}),
                      },
                    });
                    const issued = await service.sessions.create({
                      accountId: account.id,
                      expiresAt: new Date(Date.now() + days * 24 * 60 * 60_000),
                      metadata: { authentication: "service-token", serviceAccount: true },
                    });
                    return {
                      status: 201,
                      body: {
                        serviceAccount: account,
                        token: issued.token,
                        session: publicSession(issued.session),
                      },
                    };
                  } catch (error) {
                    return authErrorResponse(error, 400);
                  }
                },
              },
              {
                id: "auth.serviceAccounts.setTenant",
                method: "PATCH" as const,
                path: "/service-accounts/:accountId",
                access: manageAccess,
                spec: {
                  operationId: "setServiceAccountTenant",
                  summary: "Name the App Tenant a service account acts in",
                  tags: ["auth", "service-accounts"],
                  responses: {
                    200: { description: "Updated service account" },
                    400: { description: "Invalid Tenant id" },
                    404: { description: "Service account not found" },
                  },
                },
                handler: async ({ service, params, body }: { service: IdentityApi; params: Record<string, string>; body: unknown }) => {
                  try {
                    const account = await service.accounts.findById(params.accountId);
                    if (!account || account.metadata?.principalType !== "service") {
                      return { status: 404, body: { error: "Service account not found" } };
                    }
                    const input = (body ?? {}) as Record<string, unknown>;
                    const tenantId = readTenantIdInput(input.tenantId);
                    if (!tenantId) {
                      throw new IdentityValidationError("A Tenant id is required.");
                    }
                    // Records already written under the old Tenant stay where
                    // they are: this names who the account is from now on, and
                    // moving data is a separate, deliberate act.
                    const updated = await service.accounts.setMetadata(account.id, {
                      ...(account.metadata ?? {}),
                      tenantId,
                    });
                    return { status: 200, body: { serviceAccount: updated } };
                  } catch (error) {
                    return authErrorResponse(error, 400);
                  }
                },
              },
              {
                id: "auth.serviceAccounts.rotateToken",
                method: "POST" as const,
                path: "/service-accounts/:accountId/token",
                access: manageAccess,
                spec: {
                  operationId: "rotateServiceAccountToken",
                  summary: "Revoke existing tokens and issue a new service account token",
                  tags: ["auth", "service-accounts"],
                  responses: {
                    200: { description: "One-time service account token" },
                    404: { description: "Service account not found" },
                  },
                },
                handler: async ({ service, params, body }: { service: IdentityApi; params: Record<string, string>; body: unknown }) => {
                  try {
                    const account = await service.accounts.findById(params.accountId);
                    if (!account || account.metadata?.principalType !== "service") {
                      return { status: 404, body: { error: "Service account not found" } };
                    }
                    const input = (body ?? {}) as Record<string, unknown>;
                    const days = input.expiresInDays === undefined ? 90 : Number(input.expiresInDays);
                    if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
                      throw new IdentityValidationError("Service account token lifetime must be between 1 and 3650 days.");
                    }
                    await service.sessions.revokeAll(account.id);
                    const issued = await service.sessions.create({
                      accountId: account.id,
                      expiresAt: new Date(Date.now() + days * 24 * 60 * 60_000),
                      metadata: { authentication: "service-token", serviceAccount: true },
                    });
                    return {
                      status: 200,
                      body: { token: issued.token, session: publicSession(issued.session) },
                    };
                  } catch (error) {
                    return authErrorResponse(error, 400);
                  }
                },
              },
              {
                id: "auth.serviceAccounts.revoke",
                method: "DELETE" as const,
                path: "/service-accounts/:accountId",
                access: manageAccess,
                spec: {
                  operationId: "revokeServiceAccount",
                  summary: "Revoke and remove a Platform service account",
                  tags: ["auth", "service-accounts"],
                  responses: {
                    204: { description: "Service account revoked" },
                    404: { description: "Service account not found" },
                  },
                },
                handler: async ({ service, params }: { service: IdentityApi; params: Record<string, string> }) => {
                  const account = await service.accounts.findById(params.accountId);
                  if (!account || account.metadata?.principalType !== "service") {
                    return { status: 404, body: { error: "Service account not found" } };
                  }
                  await service.sessions.revokeAll(account.id);
                  await service.repositories.accounts.delete(account.id);
                  return { status: 204 };
                },
              },
            ]
          : []),
        ...(options.oauthConnections
          ? [
              {
                id: "auth.oauth.connections.list",
                method: "GET" as const,
                path: "/oauth/connections",
                access: settingsAccess,
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
                access: settingsAccess,
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
                access: settingsAccess,
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
                      body as Parameters<IdentityBootstrapCapability["bootstrap"]>[0],
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
    name: "zelavis/identity",
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

/**
 * The Platform Identity & Permissions Subsystem.
 *
 * A foundational Platform OS capability providing accounts, sessions,
 * passwords, credentials, and authenticators. This is a native platform
 * subsystem, not a loadable plugin service.
 */
export interface IdentitySubsystem {
  readonly auth: IdentityApi;
  readonly authenticators: readonly ZelavisRequestAuthenticator[];
  readonly routes: readonly ZelavisServerRoute<IdentityApi>[];
  /** Backwards-compatible runtime service definition. */
  readonly definition: IdentityServiceDefinition;
}

export function defineAuthSubsystem(
  auth: IdentityApi,
  options: DefineAuthServiceOptions = {},
): IdentitySubsystem {
  const definition = defineAuthService(auth, options);
  return Object.freeze({
    auth,
    authenticators: definition.authenticators ?? [auth.requestAuthenticator],
    routes: (definition.api?.v1 ?? []) as readonly ZelavisServerRoute<IdentityApi>[],
    definition,
  });
}

export interface IdentityServiceOptions {
  /** Options for the built-in password provider. */
  password?: PasswordProviderOptions;
  /** Options for the built-in OAuth Authorization Code client. */
  oauth?: {
    /** Used for token and profile requests. Defaults to the global fetch. */
    fetch?: typeof globalThis.fetch;
  };
  auth?: IdentityApi;
  authOptions?: CreateIdentityOptions;
  methods?: readonly IdentityMethodPlugin[];
  /** Allow anonymous Project-user registration. */
  registration?: boolean;
  definition?: DefineAuthServiceOptions;
}

export async function createIdentitySubsystem(
  options: IdentityServiceOptions = {},
): Promise<IdentitySubsystem> {
  const auth =
    options.auth ??
    (await createIdentity({
      ...(options.authOptions ?? {}),
      methods: [
        ...(options.authOptions?.methods ?? []),
        ...(options.methods ?? []),
      ],
    }));

  return defineAuthSubsystem(auth, {
    ...(options.definition ?? {}),
    ...(options.registration === undefined ? {} : { registration: options.registration }),
  });
}

export async function identityService(
  options: IdentityServiceOptions = {},
): Promise<IdentityServiceDefinition> {
  const subsystem = await createIdentitySubsystem(options);
  return subsystem.definition;
}
