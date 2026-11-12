import { Cause, Effect, Schema } from "effect";
import { importAccounts, type AccountImportInput } from "./account-import.js";
import { present, evaluate, integration, integrationValue, unwrapFailure, type IntegrationFailure } from "../../core/runtime/effect-boundary.js";
import type { PasswordProviderOptions } from "./providers/password.js";
import {
  createMappedJsonErrorResponse,
  type ZelavisServerErrorStatusRule,
  type ZelavisEndpointGroup,
  type ZelavisServerRoute,
  type ZelavisRouteResponse,
  type ZelavisRequestAuthenticator,
  type ZelavisPrincipalGrant,
  type ZelavisPrincipal,
} from "../../core/index.js";
import type { IdentityApi, IdentityMethodPlugin } from "./core/types.js";
import type { RegistrationRecovery } from "./services/registration-service.js";
import type { IdentityBootstrapCapability } from "./core/types.js";
import { createIdentity, type CreateIdentityOptions } from "./core/create-identity.js";
import { createSessionCookie } from "./core/session-authenticator.js";
import {
  IdentityDomainError,
  AccountAccessError,
  AuthInvalidCredentialsError,
  IdentityNotFoundError,
  AuthRateLimitError,
  IdentityValidationError,
  RegistrationError,
  RegistrationRateLimitError,
} from "./core/errors.js";
import type { Account } from "./domain/entities.js";
import {
  ACCOUNT_ACCESS_BODY_BYTES,
  accountAccessInputJsonSchema,
  accountAccessResultJsonSchema,
} from "./domain/account-access.js";
import {
  accountAccessForbidden,
  accountNotFound,
  assertCanDelegateAccountAccess,
  hasReservedAccountMetadata,
  isServiceAccount,
  type AccountAdministrationContext,
} from "./services/account-service.js";
import {
  decodeSetRegistrationSettingsInput,
  REGISTRATION_SETTINGS_BODY_BYTES,
  registrationSettingsInputJsonSchema,
  registrationSettingsJsonSchema,
  registrationStatusJsonSchema,
} from "./domain/registration.js";
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

const registrationErrors = {
  RegistrationClosed: { status: 403, code: "registration_closed" },
  RegistrationSettingsConflict: { status: 409, code: "registration_settings_conflict" },
  RegistrationConflict: { status: 409, code: "registration_conflict" },
  RegistrationBusy: { status: 429, code: "registration_busy", retryAfter: 1 },
  RegistrationUnavailable: { status: 503, code: "registration_unavailable" },
  EnrollmentRequired: { status: 403, code: "enrollment_required" },
} as const;

const noStore = { "cache-control": "no-store" };

const accountAccessErrors = {
  InvalidAccountAccess: { status: 400, code: "invalid_account_access" },
  AccountAccessForbidden: { status: 403, code: "account_access_forbidden" },
  AccountNotFound: { status: 404, code: "account_not_found" },
  AccountAccessConflict: { status: 409, code: "account_access_conflict" },
  AccountAccessBusy: { status: 429, code: "account_access_busy" },
  AccountAccessAuditFailed: { status: 503, code: "account_access_audit_failed" },
} as const;

function authErrorResponse(error: unknown, fallback = 500, registration = false): ZelavisRouteResponse {
  if (error instanceof AccountAccessError) {
    const { status, code } = accountAccessErrors[error._tag];
    return {
      status,
      headers: error._tag === "AccountAccessBusy" ? { ...noStore, "retry-after": "1" } : noStore,
      body: {
        error: error.message, code,
        ...(error.accessRevision === undefined ? {} : { accessRevision: error.accessRevision }),
      },
    };
  }
  if (error instanceof RegistrationError || error instanceof RegistrationRateLimitError) {
    const mapped = error instanceof RegistrationRateLimitError
      ? { status: 429, code: "registration_rate_limited", retryAfter: error.retryAfterSeconds }
      : registrationErrors[error._tag];
    return {
      status: mapped.status,
      headers: { ...noStore, ...("retryAfter" in mapped ? { "retry-after": String(mapped.retryAfter) } : {}) },
      body: { error: error.message, code: mapped.code },
    };
  }
  if (registration && error instanceof IdentityNotFoundError) {
    return { status: 404, headers: noStore, body: { error: error.message, code: "provider_not_found" } };
  }
  if (registration && error instanceof IdentityValidationError) {
    return { status: 400, headers: noStore, body: { error: error.message, code: "invalid_registration" } };
  }
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

function administrativeAccount(account: Account) {
  const { registrationPending: _pending, sessionEpoch: _epoch, ...safe } = account;
  return { ...safe, accessRevision: account.accessRevision ?? 0 };
}

const optionalString = Schema.optional(Schema.String);
const optionalMetadata = Schema.optional(Schema.Record(Schema.String, Schema.Unknown));
const decodeAdministrativeAccount = Schema.decodeUnknownSync(Schema.Struct({
  id: Schema.String,
  email: optionalString,
  username: optionalString,
  displayName: optionalString,
  verified: Schema.optional(Schema.Boolean),
  metadata: optionalMetadata,
  roles: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(3))),
  permissions: Schema.optional(Schema.Unknown),
  grants: Schema.optional(Schema.Unknown),
}), { onExcessProperty: "error" });
const decodeAdministrativeCredential = Schema.decodeUnknownSync(Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  provider: Schema.String,
  identifier: Schema.String,
  secretHash: optionalString,
  metadata: optionalMetadata,
}), { onExcessProperty: "error" });

export type IdentityEndpointGroup = Readonly<ZelavisEndpointGroup<IdentityApi>>;

export interface IdentitySessionCookieOptions {
  name?: string;
  path?: string;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface DefineAuthServiceOptions {
  authority?: "project" | "platform";
  validateGrantScopes?: Extract<AccountAdministrationContext, { authority: "platform" }>["validateGrantScopes"];
  /** Initial public registration setting for a runtime with no saved policy. */
  registration?: boolean;
  registrationRecovery?: RegistrationRecovery;
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

export function defineAuthEndpointGroup(
  auth: IdentityApi,
  options: DefineAuthServiceOptions = {},
): IdentityEndpointGroup {
  if (options.authority !== undefined || options.registration !== undefined) {
    const bootstrap = options.bootstrap;
    auth.registration.bindRuntime(options.registrationRecovery ?? options, {
      ...(options.authority === undefined ? {} : {
        authority: options.authority,
        enrollmentReady: () => bootstrap?.isComplete() ?? present(Effect.succeed(options.authority === "project")),
      }),
      ...(options.registration === undefined ? {} : { initiallyEnabled: options.registration }),
    });
  }
  const managePermission = options.authority === "platform"
    ? "system.users.manage"
    : "project.users.manage";
  const administrationContext = (principal: ZelavisPrincipal | undefined): AccountAdministrationContext =>
    options.authority === "platform" ? { principal, authority: "platform", validateGrantScopes: options.validateGrantScopes }
      : { principal, authority: "project", projectId: auth.context.projectId };
  const manageAccess = {
    permissions: [managePermission],
    ...(options.authority === "platform" ? { scope: { type: "system" as const } } : auth.context.projectId
      ? { scope: { type: "project" as const, projectId: auth.context.projectId } }
      : {}),
  };
  const managedAccount = (service: IdentityApi, accountId: string, actor: ZelavisPrincipal, serviceOnly = false) =>
    Effect.gen(function* () {
      const account = yield* integration(() => service.accounts.findById(accountId));
      if (!account || (serviceOnly && account.metadata?.principalType !== "service")) {
        return yield* Effect.fail(accountNotFound());
      }
      yield* evaluate(() => assertCanDelegateAccountAccess(actor, administrationContext(actor), serviceOnly
        ? { ...account, roles: account.roles?.filter((role) => role !== "service") }
        : account));
      return account;
    });
  const settingsAccess = {
    permissions: [options.authority === "platform"
      ? "system.settings.manage"
      : "project.settings.manage"],
    ...(options.authority !== "platform" && auth.context.projectId
      ? { scope: { type: "project" as const, projectId: auth.context.projectId } }
      : {}),
  };
  const cookieName = auth.context.sessionCookieName;
  const cookieOptions = options.sessionCookie === false || cookieName === false || !options.sessionCookie
    ? undefined
    : { ...options.sessionCookie, name: cookieName ?? options.sessionCookie.name };
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
            queryParams: { accountId: { type: "string", description: "Restrict the list to this exact account." } },
            responses: {
              200: { description: "List of accounts" },
            },
          },
          handler: ({ service, query }) => present(Effect.gen(function* () {
            const accountId = query.get("accountId");
            const account = accountId === null ? null : yield* integration(() => service.accounts.findById(accountId));
            const accounts = accountId === null ? yield* integration(() => service.accounts.list()) : account ? [account] : [];
            return { status: 200, headers: noStore, body: accounts.map(administrativeAccount) };
          })),
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
          handler: ({ service, body, principal }) => present(Effect.gen(function* () {
            const input = yield* evaluate(() => decodeAdministrativeAccount(body));
            if (!input.email?.trim() && !input.username?.trim()) {
              return yield* Effect.fail(new IdentityValidationError("Account creation requires at least an email or username."));
            }
            const context = administrationContext(principal);
            const permissions = yield* evaluate(() => serviceAccountPermissions(input.permissions));
            const grants = yield* evaluate(() => serviceAccountGrants(input.grants));
            const humanRoles = context.authority === "platform" ? ["customer", "operator", "reseller"] : ["user"];
            if (input.roles?.some((role) => !humanRoles.includes(role)) || permissions.includes("*") ||
                grants.some(({ permission }) => permission === "*") ||
                (input.metadata && hasReservedAccountMetadata(input.metadata))) {
              return yield* Effect.fail(accountAccessForbidden());
            }
            const account = { ...input, permissions, grants };
            return yield* service.accounts.administer(context, (actor) => Effect.gen(function* () {
              yield* evaluate(() => assertCanDelegateAccountAccess(actor, context, account));
              const created = yield* integration(() => service.accounts.create(account));
              return { status: 201, headers: noStore, body: administrativeAccount(created) };
            }));
          }).pipe(Effect.catchCause((cause) => Effect.succeed(authErrorResponse(unwrapFailure(Cause.squash(cause)), 400))))),
        },
        {
          id: "auth.accounts.access.set",
          method: "PUT",
          path: "/accounts/:accountId/access",
          access: manageAccess,
          maxRequestBodyBytes: ACCOUNT_ACCESS_BODY_BYTES,
          invalidJsonBodyCode: "invalid_account_access",
          spec: {
            operationId: "setAccountAccess",
            summary: "Replace a human account's role and authority",
            tags: ["auth"],
            pathParams: { accountId: { type: "string", required: true } },
            requestBody: { required: true, schema: accountAccessInputJsonSchema },
            responses: {
              200: { description: "Current account access and revision", schema: accountAccessResultJsonSchema },
              400: { description: "Invalid account access" },
              403: { description: "Delegation or account modification forbidden" },
              404: { description: "Account not found" },
              409: { description: "Account access revision changed" },
              429: { description: "Account administration busy" },
              503: { description: "Access changed but its security event could not be recorded" },
            },
          },
          handler: ({ service, principal, params, body }) => present(Effect.gen(function* () {
            const updated = yield* integration(() => service.accounts.setAccess(params.accountId, body, administrationContext(principal)));
            return { status: 200, headers: noStore, body: updated };
          }).pipe(Effect.catchCause((cause) => Effect.succeed(authErrorResponse(unwrapFailure(Cause.squash(cause))))))),
        },
        {
          id: "auth.accounts.import",
          method: "POST",
          path: "/accounts/import",
          access: manageAccess,
          spec: {
            operationId: "importAccounts",
            summary: "Import accounts from another system",
            description: "Creates accounts from `{ accounts: [{ email?, username?, displayName?, verified?, metadata?, passwordHash? }], dryRun? }`. PBKDF2-SHA256 password hashes (Zelavis or Django format, at least 100000 iterations) carry over; any other hash leaves the account to recover its password (`needsReset`). Accounts whose email or username is held are skipped; with any problem, or `dryRun`, nothing is written.",
            tags: ["auth"],
            requestBody: { required: true, schema: { type: "object", required: ["accounts"], properties: { accounts: { type: "array" }, dryRun: { type: "boolean" } } } },
            responses: { 200: { description: "{ dryRun, accounts, created, skipped, needsReset, problems }" }, 400: { description: "Validation error" } },
          },
          handler: ({ service, body, principal }) => present(service.accounts.administer(administrationContext(principal), () => Effect.gen(function* () {
            return { status: 200, body: yield* integration(() => importAccounts(service, body as AccountImportInput)) };
          })).pipe(Effect.catchCause((cause) => Effect.succeed(authErrorResponse(unwrapFailure(Cause.squash(cause)), 400))))),
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
          handler: ({ service, body, principal }) => present(service.accounts.administer(administrationContext(principal), (actor) => Effect.gen(function* () {
            const input = yield* evaluate(() => decodeAdministrativeCredential(body));
            const account = yield* managedAccount(service, input.accountId, actor);
            if (isServiceAccount(account) || account.metadata?.principalType === "system" ||
                (account.roles?.includes("owner") && account.id !== actor.id)) {
              return yield* Effect.fail(accountAccessForbidden());
            }
            return {
              status: 201,
              body: publicCredential(yield* integration(() => service.credentials.create(input))),
            };
          })).pipe(Effect.catchCause((cause) => Effect.succeed(authErrorResponse(unwrapFailure(Cause.squash(cause)), 400))))),
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
          id: "auth.registration.status",
          method: "GET",
          path: "/registration",
          spec: {
            operationId: "registrationStatus",
            summary: "Read public registration availability",
            tags: ["auth"],
            responses: {
              200: { description: "Effective registration availability and enrollment providers", schema: registrationStatusJsonSchema },
              503: { description: "Registration unavailable" },
            },
          },
          handler: ({ service }) => present(Effect.gen(function* () {
            const body = yield* integration(() => service.registration.status());
            return { status: 200, headers: noStore, body };
          }).pipe(Effect.catch((error) => Effect.succeed(authErrorResponse(unwrapFailure(error)))))),
        },
        {
          id: "auth.registration.settings.get",
          method: "GET",
          path: "/registration/settings",
          access: options.authority === "platform"
            ? { ...settingsAccess, scope: { type: "system" } }
            : settingsAccess,
          spec: {
            operationId: "registrationSettings",
            summary: "Read the runtime's registration settings",
            tags: ["auth"],
            responses: {
              200: { description: "Saved registration setting and revision", schema: registrationSettingsJsonSchema },
              503: { description: "Registration settings unavailable" },
            },
          },
          handler: ({ service }) => present(Effect.gen(function* () {
            const body = yield* integration(() => service.registration.settings());
            return { status: 200, headers: noStore, body };
          }).pipe(Effect.catch((error) => Effect.succeed(authErrorResponse(unwrapFailure(error)))))),
        },
        {
          id: "auth.registration.settings.set",
          method: "PUT",
          path: "/registration/settings",
          access: options.authority === "platform"
            ? { ...settingsAccess, scope: { type: "system" } }
            : settingsAccess,
          maxRequestBodyBytes: REGISTRATION_SETTINGS_BODY_BYTES,
          invalidJsonBodyCode: "invalid_registration",
          spec: {
            operationId: "setRegistrationSettings",
            summary: "Update the runtime's registration settings",
            tags: ["auth"],
            requestBody: { required: true, schema: registrationSettingsInputJsonSchema },
            responses: {
              200: { description: "Updated registration setting and revision", schema: registrationSettingsJsonSchema },
              400: { description: "Invalid registration settings" },
              409: { description: "Settings revision has changed" },
              413: { description: "Request exceeds 1024 bytes" },
              503: { description: "Registration settings unavailable" },
            },
          },
          handler: ({ service, body }) => present(Effect.gen(function* () {
            const input = yield* evaluate(() => decodeSetRegistrationSettingsInput(body)).pipe(
              Effect.mapError(() => new IdentityValidationError("Invalid registration settings.")),
            );
            const updated = yield* integration(() => service.registration.setSettings(input));
            return { status: 200, headers: noStore, body: updated };
          }).pipe(Effect.catch((error) => Effect.succeed(authErrorResponse(unwrapFailure(error), 500, true))))),
        },
        {
          id: "auth.registration.create",
          method: "POST",
          path: "/sign-up/:provider",
          maxRequestBodyBytes: 8192,
          invalidJsonBodyCode: "invalid_registration",
          spec: {
            operationId: "signUp",
            summary: "Create an account with a credential provider",
            tags: ["auth"],
            responses: {
              201: { description: "Account created and signed in" },
              400: { description: "Invalid enrollment input" },
              403: { description: "Registration is closed" },
              404: { description: "Enrollment provider unavailable" },
              409: { description: "Registration conflict" },
              413: { description: "Registration request exceeds 8192 bytes" },
              429: { description: "Registration is busy or rate limited" },
              503: { description: "Registration unavailable" },
            },
          },
          handler: ({ service, params, body, request }) => present(Effect.gen(function* () {
            const { account, credential, session } = yield* integration(() => service.registration.signUp(params.provider, body));
            const sessionCookie = cookieOptions
              ? browserSessionCookieHeader(session.token, session.session.expiresAt, request, cookieOptions)
              : undefined;
            return {
              status: 201,
              headers: { ...noStore, ...(sessionCookie ? { "set-cookie": sessionCookie } : {}) },
              body: { account, credential: publicCredential(credential), session: { token: session.token, session: publicSession(session.session) } },
            };
          }).pipe(Effect.catchCause((cause) => Effect.succeed(authErrorResponse(unwrapFailure(Cause.squash(cause)), 500, true))))),
        },
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
          handler: ({ service, params })  => present(Effect.gen(function* () {
              return {
                status: 200,
                body: yield* integration(() => service.authentication.beginAuthorizationCode(
                  params.provider,
                )),
              };
            }).pipe(Effect.catchCause((cause) => Effect.succeed(authErrorResponse(unwrapFailure(Cause.squash(cause)), 400))))),
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
          handler: ({ service, params, principal })  => present(Effect.gen(function* () {
              return {
                status: 200,
                body: yield* integration(() => service.authentication.beginAuthorizationCode(
                  params.provider,
                  { mode: "link", accountId: principal!.id },
                )),
              };
            }).pipe(Effect.catchCause((cause) => Effect.succeed(authErrorResponse(unwrapFailure(Cause.squash(cause)), 400))))),
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
              403: { description: "First-time registration is closed" },
              409: { description: "Registration conflict" },
              429: { description: "Registration is busy or rate limited" },
              503: { description: "Registration unavailable" },
            },
          },
          method: "GET",
          path: "/oauth/:provider/callback",
          handler: ({ service, params, query, request })  => present(Effect.gen(function* () {
              const providerError = query.get("error");
              if (providerError) {
                throw new IdentityValidationError(
                  `Authorization provider returned ${providerError}.`,
                );
              }
              const result = yield* integration(() => service.authentication.completeAuthorizationCode(
                params.provider,
                {
                  state: query.get("state") ?? "",
                  code: query.get("code") ?? "",
                },
              ));
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
                headers: { ...noStore, ...(sessionCookie ? { "set-cookie": sessionCookie } : {}) },
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
            }).pipe(Effect.catchCause((cause) => Effect.succeed(authErrorResponse(unwrapFailure(Cause.squash(cause)), 400))))),
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
          handler: ({ service, params, body })  => present(Effect.gen(function* () {
              return {
                status: 202,
                body: yield* integration(() => service.authentication.beginRecovery(
                  params.provider,
                  body as Parameters<IdentityApi["authentication"]["beginRecovery"]>[1],
                )),
              };
            }).pipe(Effect.catchCause((cause) => Effect.succeed(authErrorResponse(unwrapFailure(Cause.squash(cause)), 400))))),
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
          handler: ({ service, params, body })  => present(Effect.gen(function* () {
              yield* integration(() => service.authentication.completeRecovery(
                params.provider,
                body as Parameters<IdentityApi["authentication"]["completeRecovery"]>[1],
              ));
              return { status: 204 };
            }).pipe(Effect.catchCause((cause) => Effect.succeed(authErrorResponse(unwrapFailure(Cause.squash(cause)), 400))))),
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
          handler: ({ service, params, body, request })  => present(Effect.gen(function* () {
            let attempt: Awaited<ReturnType<IdentityApi["security"]["beginAuthentication"]>> | undefined;
            return yield* Effect.gen(function* () {
              const began = yield* integration(() => service.security.beginAuthentication(
                params.provider,
                body,
              ));
              attempt = began;
              const result = yield* integration(() => service.authentication.authenticate(
                params.provider,
                body as Parameters<
                  IdentityApi["authentication"]["authenticate"]
                >[1],
              ));
              yield* integration(() => service.security.authenticationSucceeded(
                began,
                result.account.id,
              ));
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
            }).pipe(Effect.catchCause((cause) => Effect.gen(function* () {
  const error = unwrapFailure(Cause.squash(cause));
              const begun = attempt;
              if (begun && !(error instanceof AuthRateLimitError)) {
                yield* integration(() => service.security.authenticationFailed(begun));
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
            })));
})),
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
          handler: ({ service }) => present(Effect.gen(function* () {
    return {
            status: 200,
            body: { events: (yield* integrationValue(service.security.listEvents())) },
          };
  })),
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
          handler: ({ service, params }) => present(Effect.gen(function* () {
    return {
            status: 200,
            body: ((yield* integrationValue(service.sessions.listByAccountId(params.accountId)))).map(publicSession),
          };
  })),
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
          handler: ({ service, principal }) => present(Effect.gen(function* () {
    return {
            status: 200,
            body: {
              sessions: (
                (yield* integrationValue(service.sessions.listByAccountId(principal!.id)))
              ).map(publicSession),
              currentSessionId: principal?.metadata?.sessionId,
            },
          };
  })),
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
          handler: ({ service, principal, params }) => present(Effect.gen(function* () {
            const session = (yield* integrationValue(service.sessions.findById(params.sessionId)));
            if (!session || session.accountId !== principal!.id) {
              return { status: 404, body: { error: "Session not found" } };
            }
            (yield* integrationValue(service.sessions.revoke(session.id)));
            return { status: 204 };
          })),
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
          handler: ({ service, params, principal }) => present(service.accounts.administer(administrationContext(principal), (actor) => Effect.gen(function* () {
            yield* managedAccount(service, params.accountId, actor);
            const session = (yield* integrationValue(service.sessions.findById(params.sessionId)));
            if (!session || session.accountId !== params.accountId) {
              return { status: 404, body: { error: "Session not found" } };
            }
            (yield* integrationValue(service.sessions.revoke(session.id)));
            return { status: 204 };
          })).pipe(Effect.catchCause((cause) => Effect.succeed(authErrorResponse(unwrapFailure(Cause.squash(cause))))))),
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
          handler: ({ service, params, principal }) => present(service.accounts.administer(administrationContext(principal), (actor) => Effect.gen(function* () {
            yield* managedAccount(service, params.accountId, actor);
    return {
            status: 200,
            body: {
              revoked: (
                (yield* integrationValue(service.sessions.revokeAll(params.accountId)))
              ).map(publicSession),
            },
          };
  })).pipe(Effect.catchCause((cause) => Effect.succeed(authErrorResponse(unwrapFailure(Cause.squash(cause))))))),
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
          handler: ({ service, principal, request }) => present(Effect.gen(function* () {
            const sessionId = principal?.metadata?.sessionId;
            if (typeof sessionId !== "string") {
              return { status: 400, body: { error: "The current authentication method is not a rotatable session." } };
            }
            const rotated = (yield* integrationValue(service.sessions.rotate(sessionId)));
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
          })),
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
          handler: ({ service, principal, request }) => present(Effect.gen(function* () {
            const sessionId = principal?.metadata?.sessionId;
            if (typeof sessionId !== "string") {
              return { status: 400, body: { error: "The current authentication method is not a revocable session." } };
            }
            const revoked = (yield* integrationValue(service.sessions.revoke(sessionId)));
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
          })),
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
                handler: ({ service }: { service: IdentityApi }) => present(Effect.gen(function* () {
    return {
                  status: 200,
                  body: {
                    serviceAccounts: ((yield* integrationValue(service.accounts.list()))).filter(
                      (account) => account.metadata?.principalType === "service",
                    ).map(administrativeAccount),
                  },
                };
  })),
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
                handler: ({ service, body, principal }: { service: IdentityApi; body: unknown; principal?: ZelavisPrincipal })  => present(service.accounts.administer(administrationContext(principal), (actor) => Effect.gen(function* () {
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
                    const permissions = serviceAccountPermissions(input.permissions);
                    const grants = serviceAccountGrants(input.grants);
                    yield* evaluate(() => assertCanDelegateAccountAccess(actor, administrationContext(actor), { permissions, grants }));
                    const account = yield* integration(() => service.accounts.create({
                      id,
                      username: id,
                      displayName: name,
                      verified: true,
                      roles: ["service"],
                      permissions,
                      grants,
                      // Without a Tenant an account is its own, which is a
                      // generated id no operator would recognise and no second
                      // client can ever join. Naming it is what lets an App's
                      // web client and its worker be one customer.
                      metadata: {
                        principalType: "service",
                        serviceAccount: true,
                        ...(tenantId ? { tenantId } : {}),
                      },
                    }));
                    const issued = yield* integration(() => service.sessions.create({
                      accountId: account.id,
                      expiresAt: new Date(Date.now() + days * 24 * 60 * 60_000),
                      metadata: { authentication: "service-token", serviceAccount: true },
                    }));
                    return {
                      status: 201,
                      body: {
                        serviceAccount: administrativeAccount(account),
                        token: issued.token,
                        session: publicSession(issued.session),
                      },
                    };
                  })).pipe(Effect.catchCause((cause) => Effect.succeed(authErrorResponse(unwrapFailure(Cause.squash(cause)), 400))))),
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
                handler: ({ service, params, body, principal }: { service: IdentityApi; params: Record<string, string>; body: unknown; principal?: ZelavisPrincipal })  => present(service.accounts.administer(administrationContext(principal), (actor) => Effect.gen(function* () {
                    const account = yield* managedAccount(service, params.accountId, actor, true);
                    const input = (body ?? {}) as Record<string, unknown>;
                    const tenantId = readTenantIdInput(input.tenantId);
                    if (!tenantId) {
                      throw new IdentityValidationError("A Tenant id is required.");
                    }
                    // Records already written under the old Tenant stay where
                    // they are: this names who the account is from now on, and
                    // moving data is a separate, deliberate act.
                    const updated = yield* integration(() => service.accounts.setMetadata(account.id, {
                      ...(account.metadata ?? {}),
                      tenantId,
                    }));
                    return { status: 200, body: { serviceAccount: administrativeAccount(updated) } };
                  })).pipe(Effect.catchCause((cause) => Effect.succeed(authErrorResponse(unwrapFailure(Cause.squash(cause)), 400))))),
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
                handler: ({ service, params, body, principal }: { service: IdentityApi; params: Record<string, string>; body: unknown; principal?: ZelavisPrincipal })  => present(service.accounts.administer(administrationContext(principal), (actor) => Effect.gen(function* () {
                    const account = yield* managedAccount(service, params.accountId, actor, true);
                    const input = (body ?? {}) as Record<string, unknown>;
                    const days = input.expiresInDays === undefined ? 90 : Number(input.expiresInDays);
                    if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
                      throw new IdentityValidationError("Service account token lifetime must be between 1 and 3650 days.");
                    }
                    yield* integration(() => service.sessions.revokeAll(account.id));
                    const issued = yield* integration(() => service.sessions.create({
                      accountId: account.id,
                      expiresAt: new Date(Date.now() + days * 24 * 60 * 60_000),
                      metadata: { authentication: "service-token", serviceAccount: true },
                    }));
                    return {
                      status: 200,
                      body: { token: issued.token, session: publicSession(issued.session) },
                    };
                  })).pipe(Effect.catchCause((cause) => Effect.succeed(authErrorResponse(unwrapFailure(Cause.squash(cause)), 400))))),
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
                handler: ({ service, params, principal }: { service: IdentityApi; params: Record<string, string>; principal?: ZelavisPrincipal }) => present(service.accounts.administer(administrationContext(principal), (actor) => Effect.gen(function* () {
                  const account = yield* managedAccount(service, params.accountId, actor, true);
                  (yield* integrationValue(service.sessions.revokeAll(account.id)));
                  (yield* integrationValue(service.repositories.accounts.delete(account.id)));
                  return { status: 204 };
                })).pipe(Effect.catchCause((cause) => Effect.succeed(authErrorResponse(unwrapFailure(Cause.squash(cause))))))),
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
                handler: () => present(Effect.gen(function* () {
    return {
                  status: 200,
                  body: { providers: (yield* integrationValue(options.oauthConnections!.list())) },
                };
  })),
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
                handler: ({ params, body }: { params: Record<string, string>; body: unknown })  => present(Effect.gen(function* () {
                    const saved = yield* integration(() => options.oauthConnections!.configure(
                      params.provider,
                      body,
                    ));
                    return saved
                      ? { status: 200, body: { connection: saved } }
                      : {
                          status: 404,
                          body: {
                            error: `No installed plugin defines "${params.provider}".`,
                          },
                        };
                  }).pipe(Effect.catchCause((cause) => Effect.succeed(authErrorResponse(unwrapFailure(Cause.squash(cause)), 400))))),
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
                handler: ({ params }: { params: Record<string, string> }) => present(Effect.gen(function* () {
                  (yield* integrationValue(options.oauthConnections!.remove(params.provider)));
                  return { status: 204 };
                })),
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
                handler: () => present(Effect.gen(function* () {
    return {
                  status: 200,
                  body: {
                    ...((yield* integrationValue(options.bootstrap!.status()))),
                    available: Boolean(bootstrapToken),
                    tokenRequired: true,
                  },
                };
  })),
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
                handler: ({ body, request }: { body: unknown; request: Request })  => present(Effect.gen(function* () {
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
                    const result = yield* integration(() => options.bootstrap!.bootstrap(
                      body as Parameters<IdentityBootstrapCapability["bootstrap"]>[0],
                    ));
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
                  }).pipe(Effect.catchCause((cause) => Effect.succeed(authErrorResponse(unwrapFailure(Cause.squash(cause)), 400))))),
              },
            ]
          : []),
  ];

  return Object.freeze({
    id: "identity",
    authenticators: [auth.requestAuthenticator],
    basePath: "/auth",
    // No menu. Core auth is the API and the authority; the settings page is
    // `@zelavis/auth`, a product service. Both contributing an "Auth" entry
    // would put two of them in the sidebar, and the one without a page would
    // lead nowhere.
    context: auth,
    origin: {
      type: "subsystem" as const,
      subsystem: "identity",
    },
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
  readonly endpointGroup: IdentityEndpointGroup;
}

export function defineAuthSubsystem(
  auth: IdentityApi,
  options: DefineAuthServiceOptions = {},
): IdentitySubsystem {
  const endpointGroup = defineAuthEndpointGroup(auth, options);
  return Object.freeze({
    auth,
    authenticators: endpointGroup.authenticators ?? [auth.requestAuthenticator],
    routes: (endpointGroup.api?.v1 ?? []) as readonly ZelavisServerRoute<IdentityApi>[],
    endpointGroup,
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
  /** Seed public registration when this runtime has no saved policy. */
  registration?: boolean;
  definition?: DefineAuthServiceOptions;
}

export function createIdentitySubsystem(
  options: IdentityServiceOptions = {},
): Promise<IdentitySubsystem> {
    return present(Effect.gen(function* (): Effect.fn.Return<IdentitySubsystem, IntegrationFailure> {
  const auth =
    options.auth ??
    ((yield* integrationValue(createIdentity({
      ...(options.authOptions ?? {}),
      methods: [
        ...(options.authOptions?.methods ?? []),
        ...(options.methods ?? []),
      ],
    }))));

  return (yield* integrationValue(defineAuthSubsystem(auth, {
    ...(options.definition ?? {}),
    ...(options.registration === undefined ? {} : { registration: options.registration }),
  })));
}));
  }

export function identityEndpointGroup(
  options: IdentityServiceOptions = {},
): Promise<IdentityEndpointGroup> {
    return present(Effect.gen(function* (): Effect.fn.Return<IdentityEndpointGroup, IntegrationFailure> {
  const subsystem = (yield* integrationValue(createIdentitySubsystem(options)));
  return subsystem.endpointGroup;
}));
  }
