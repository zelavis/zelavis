/**
 * The Zelavis account routes (Zelavis-own), mounted under `/auth` beside the
 * method routes: account administration and access, administrator sessions
 * and MFA reset, import, the registration policy, the first-owner bootstrap,
 * service accounts, security events and the methods catalogue.
 *
 * Where Identity had the same route, the path, access requirement and body
 * are Identity's. Each handler decodes its input, then runs one transaction
 * that re-reads the administrator (`resolveActor`) and applies the
 * delegation rules; refusals are data and answer with the codes below.
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type {
  ZelavisAccessRequirement,
  ZelavisPrincipalGrant,
  ZelavisRouteContext,
  ZelavisRouteResponse,
  ZelavisServerRoute,
} from "../../core/index.js";
import {
  ACCOUNT_ACCESS_BODY_BYTES,
  SetAccountAccessInputSchema,
  accountAccessInputJsonSchema,
  accountGrantKey,
  normalizeAccountAccess,
  projectAccountAccessDigest,
  projectAccountAccessPermissions,
  projectAccountAccessProof,
} from "../access/access.js";
import { type AdministrationContext, accessInputFits, managedAccount, refuse, resolveActor, resolveSettingsActor, setAccountAccess } from "../access/delegation.js";
import { accountsTables } from "../accounts/tables.js";
import { readRoleCatalogue } from "../roles/catalogue.js";
import { NO_ROLES } from "../roles/expand.js";
import { ACCOUNT_PAGE_LIMIT, createAccount, listAccounts } from "../admin/accounts.js";
import { type AccountImportInput, importAccounts, importInputProblem } from "../admin/import.js";
import { listAccountSessions, revokeAccountSessions } from "../admin/sessions.js";
import type { Bootstrap } from "../bootstrap/bootstrap.js";
import type { CoreRuntime } from "../core/context.js";
import type { AuthFailure } from "../core/errors.js";
import type { AuthKeysAdmin } from "../keys/keys.js";
import { DEFAULT_MIN_PASSWORD_LENGTH } from "../lib/password.js";
import { validateNewPassword } from "../password/validation.js";
import { type MethodsCatalogue, MethodsSettingsInputSchema } from "../methods/catalogue.js";
import type { EmailPasswordMethod } from "../methods/email-password.js";
import { hashPassword } from "../password/hashing.js";
import type { RegistrationRefused } from "../registration/errors.js";
import {
  REGISTRATION_SETTINGS_BODY_BYTES,
  type Registration,
  SetRegistrationSettingsInputSchema,
  registrationSettingsInputJsonSchema,
} from "../registration/policy.js";
import { SECURITY_EVENT_PAGE_LIMIT, listSecurityEvents, recordSecurityEvent } from "../security/events.js";
import {
  createServiceAccount,
  listServiceAccounts,
  readGrants,
  readPermissions,
  readTenantId,
  readTokenDays,
  revokeServiceAccount,
  rotateServiceAccountToken,
  setServiceAccountTenant,
} from "../serviceAccounts/serviceAccounts.js";
import { resetSecondFactor } from "../totp/policy.js";
import { validateUsernameFormat } from "../username/validation.js";
import { callOf } from "./core.js";
import { errorBody, noStore, respond } from "./errors.js";
import { type SessionTransport, signInResponse } from "./session-transport.js";
import { userErrorResponse } from "./user-errors.js";

export interface AdminRoutesOptions {
  readonly runtime: CoreRuntime;
  readonly keys: AuthKeysAdmin;
  readonly context: AdministrationContext;
  readonly registration: Registration;
  readonly catalogue: MethodsCatalogue;
  readonly transport: SessionTransport;
  readonly settingsAccess: ZelavisAccessRequirement;
  /** The Platform's first-owner claim; absent in an App. */
  readonly bootstrap?: { readonly claim: Bootstrap; readonly token: string | undefined } | undefined;
  readonly emailPassword: EmailPasswordMethod;
  /** The Platform's check that new grants name Projects and services that exist. */
  readonly validateGrantScopes?: ((scopes: ReadonlyArray<NonNullable<ZelavisPrincipalGrant["scope"]>>) => Effect.Effect<boolean>) | undefined;
}

const REFUSALS: Readonly<Record<string, readonly [number, string]>> = {
  account_access_forbidden: [403, "The caller cannot delegate this account access."],
  account_not_found: [404, "Account not found."],
  account_access_conflict: [409, "The account access revision has changed."],
  invalid_account_access: [400, "Invalid account access."],
  role_not_found: [404, "The access assigns a role that does not exist."],
  role_expansion_limit: [400, "The access would expand to more permissions and grants than an account may hold."],
  session_not_found: [404, "Session not found."],
  username_taken: [409, "That username is taken."],
  invalid_role: [400, "That role cannot be given to a new account here."],
  bootstrap_complete: [409, "Platform owner bootstrap is already complete."],
  owner_sign_in_required: [409, "Keep the Platform owner's password sign-in method enabled."],
};

const refused = (refusal: { readonly code: string; readonly message?: string }): ZelavisRouteResponse => {
  const known = REFUSALS[refusal.code];
  return errorBody(known?.[0] ?? 400, refusal.code, refusal.message ?? known?.[1] ?? "The request was refused.");
};

const ok = (body: unknown, status = 200): ZelavisRouteResponse => ({ status, headers: noStore, body });

const strict = { onExcessProperty: "error" } as const;

/** A natural number from the query string, or undefined when absent; NaN when malformed. */
const queryNumber = (context: ZelavisRouteContext, name: string): number | undefined => {
  const value = context.query.get(name);
  if (value === null) return undefined;
  return /^\d{1,16}(?:\.\d+)?$/u.test(value) ? Number(value) : Number.NaN;
};

const isProblem = (value: unknown): value is { readonly ok: false; readonly code: "invalid_service_account"; readonly message: string } =>
  typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;

/** Constant-time comparison of the bootstrap token. */
const tokensEqual = (expected: string, given: unknown): boolean => {
  if (typeof given !== "string") return false;
  const left = new TextEncoder().encode(expected);
  const right = new TextEncoder().encode(given);
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
};

const BootstrapBody = Schema.Struct({
  bootstrapToken: Schema.String,
  username: Schema.String,
  password: Schema.String,
  displayName: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  email: Schema.optional(Schema.String),
});

const CreateAccountBody = Schema.Struct({
  username: Schema.String,
  password: Schema.String,
  displayName: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  role: Schema.optional(Schema.String),
});

export function defineAdminRoutes(options: AdminRoutesOptions): ReadonlyArray<ZelavisServerRoute> {
  const { runtime, context: administration } = options;
  const manageAccess: ZelavisAccessRequirement = {
    permissions: [administration.authority === "platform" ? "system.users.manage" : "project.users.manage"],
    ...(administration.authority === "platform"
      ? { scope: { type: "system" as const } }
      : administration.projectId === undefined ? {} : { scope: { type: "project" as const, projectId: administration.projectId } }),
  };
  const settingsAccess: ZelavisAccessRequirement = administration.authority === "platform"
    ? { ...options.settingsAccess, scope: { type: "system" } }
    : options.settingsAccess;

  const route = (
    definition: Omit<ZelavisServerRoute, "handler" | "spec"> & { readonly summary: string; readonly operationId: string; readonly responses: Record<number, string>; readonly requestSchema?: unknown; readonly tags?: ReadonlyArray<string> },
    run: (context: ZelavisRouteContext) => Effect.Effect<ZelavisRouteResponse, AuthFailure | RegistrationRefused>,
  ): ZelavisServerRoute => {
    const { summary, operationId, responses, requestSchema, tags, ...rest } = definition;
    return {
      ...rest,
      spec: {
        operationId,
        summary,
        tags: [...(tags ?? ["auth"])],
        ...(rest.path.includes(":accountId")
          ? { pathParams: { accountId: { type: "string", required: true }, ...(rest.path.includes(":sessionId") ? { sessionId: { type: "string", required: true } } : {}) } }
          : {}),
        ...(requestSchema === undefined ? {} : { requestBody: { required: true, schema: requestSchema as Record<string, unknown> } }),
        responses: Object.fromEntries(Object.entries(responses).map(([status, description]) => [status, { description }])),
      },
      handler: (context) => respond(run(context)),
    };
  };

  const accountRoutes: ZelavisServerRoute[] = [
    route({
      id: "auth.accounts.list", method: "GET", path: "/accounts", access: manageAccess,
      operationId: "listAccounts", summary: "List accounts, a page at a time",
      responses: { 200: "{ accounts, next? }", 400: "Malformed paging", 403: "Forbidden" },
    }, (context) => Effect.gen(function* () {
      const limit = queryNumber(context, "limit") ?? 50;
      const after = queryNumber(context, "after");
      if (Number.isNaN(limit) || (after !== undefined && Number.isNaN(after))) return errorBody(400, "invalid_request", "limit and after are numbers.");
      const accountId = context.query.get("accountId") ?? undefined;
      const listed = yield* runtime.query(callOf(context), (tx) =>
        listAccounts(tx, { principal: context.principal, context: administration, limit: Math.min(limit, ACCOUNT_PAGE_LIMIT), after, accountId }));
      return listed.ok ? ok({ accounts: listed.accounts, ...("next" in listed ? { next: String(listed.next) } : {}) }) : refused(listed);
    })),
    route({
      id: "auth.accounts.create", method: "POST", path: "/accounts", access: manageAccess, maxRequestBodyBytes: 8192, invalidJsonBodyCode: "invalid_request",
      operationId: "createAccount", summary: "Create an account with a username and password",
      requestSchema: Schema.toJsonSchemaDocument(CreateAccountBody, strict).schema,
      responses: { 201: "{ account }", 400: "Invalid account", 403: "Delegation forbidden", 409: "Username taken" },
    }, (context) => Effect.gen(function* () {
      const decoded = Schema.decodeUnknownExit(CreateAccountBody, strict)(context.body);
      if (Exit.isFailure(decoded)) return errorBody(400, "invalid_request", "An account is { username, password, displayName?, role? }.");
      const input = decoded.value;
      const usernameError = validateUsernameFormat(input.username);
      if (usernameError !== null) return userErrorResponse(usernameError);
      const passwordError = validateNewPassword(input.password, DEFAULT_MIN_PASSWORD_LENGTH);
      if (passwordError !== null) return userErrorResponse(passwordError);
      const passwordHashPHC = yield* hashPassword(input.password);
      const created = yield* runtime.mutation(callOf(context), (tx) => createAccount(tx, {
        principal: context.principal, context: administration, username: input.username, passwordHashPHC, displayName: input.displayName, role: input.role,
      }));
      return created.ok ? ok({ account: created.account }, 201) : refused(created);
    })),
    route({
      id: "auth.accounts.access.set", method: "PUT", path: "/accounts/:accountId/access", access: manageAccess,
      maxRequestBodyBytes: ACCOUNT_ACCESS_BODY_BYTES, invalidJsonBodyCode: "invalid_account_access",
      operationId: "setAccountAccess", summary: "Replace a human account's role and authority",
      requestSchema: accountAccessInputJsonSchema,
      responses: { 200: "Current account access and revision", 400: "Invalid account access", 403: "Delegation or account modification forbidden", 404: "Account not found", 409: "Account access revision changed" },
    }, (context) => Effect.gen(function* () {
      const decoded = Schema.decodeUnknownExit(SetAccountAccessInputSchema, strict)(context.body);
      if (Exit.isFailure(decoded)) return refused({ code: "invalid_account_access" });
      const input = normalizeAccountAccess(decoded.value);
      if (!accessInputFits(administration, input)) return refused({ code: "account_access_forbidden" });
      const accountId = context.params.accountId ?? "";
      const call = callOf(context);
      const principal = context.principal;
      let proved: ReadonlyArray<string> | undefined;
      const proof = principal === undefined ? undefined : projectAccountAccessProof(principal);
      if (proof !== undefined) {
        // A Platform principal forwarded by the Gateway: the signed digest must bind this target, input and current authority.
        if (proof.digest === undefined || administration.authority !== "project" || administration.projectId === undefined) return refused({ code: "account_access_forbidden" });
        const projectId = administration.projectId;
        const read = yield* runtime.query(call, (tx) => Effect.gen(function* () {
          const account = yield* tx.db.get(accountsTables.accounts, accountId);
          const roles = (account?.roleAssignments?.length ?? 0) > 0 || input.roleAssignments.length > 0 ? yield* readRoleCatalogue(tx) : NO_ROLES;
          return { account, roles };
        }));
        const current = read.account;
        if (current === null) return refused({ code: "account_not_found" });
        if (current.accessRevision !== input.expectedRevision) return refused({ code: "account_access_conflict" });
        const permissions = projectAccountAccessPermissions(projectId, current, input, read.roles);
        if (permissions === undefined || (yield* projectAccountAccessDigest(accountId, input, permissions).pipe(Effect.orDie)) !== proof.digest) {
          return refused({ code: "account_access_forbidden" });
        }
        proved = permissions;
      }
      if (administration.authority === "platform" && options.validateGrantScopes !== undefined &&
          (input.grants.length > 0 || input.roleAssignments.some(({ projectIds }) => projectIds !== undefined))) {
        const current = yield* runtime.query(call, (tx) => tx.db.get(accountsTables.accounts, accountId));
        if (current === null) return refused({ code: "account_not_found" });
        const existing = new Set(current.grants.map(accountGrantKey));
        const assignedProjects = new Set((current.roleAssignments ?? []).flatMap(({ roleId, projectIds }) => (projectIds ?? []).map((projectId) => `${roleId}\u0000${projectId}`)));
        const added = [
          ...input.grants.filter((grant) => !existing.has(accountGrantKey(grant))).map(({ scope }) => scope),
          ...input.roleAssignments.flatMap(({ roleId, projectIds }) => (projectIds ?? [])
            .filter((projectId) => !assignedProjects.has(`${roleId}\u0000${projectId}`))
            .map((projectId) => ({ type: "project" as const, projectId }))),
        ];
        if (added.length > 0 && !(yield* options.validateGrantScopes(added))) {
          return refused({ code: "invalid_account_access", message: "New account grants and role assignments must name existing Projects or installed services." });
        }
      }
      const result = yield* runtime.mutation(call, (tx) => Effect.gen(function* () {
        const actor = yield* resolveActor(tx, principal, administration);
        if (actor === null) return refuse("account_access_forbidden");
        return yield* setAccountAccess(tx, { actor, context: administration, accountId, input, provedProjectPermissions: proved });
      }));
      return result.ok ? ok(result.result) : refused(result);
    })),
    route({
      id: "auth.accounts.import", method: "POST", path: "/accounts/import", access: manageAccess, maxRequestBodyBytes: 16 * 1024 * 1024,
      operationId: "importAccounts", summary: "Import accounts from another system",
      requestSchema: { type: "object", required: ["accounts"], properties: { accounts: { type: "array" }, dryRun: { type: "boolean" } } },
      responses: { 200: "{ dryRun, accounts, created, skipped, needsReset, rehashOnSignIn, problems }", 400: "Malformed import", 403: "Forbidden" },
    }, (context) => Effect.gen(function* () {
      const problem = importInputProblem(context.body);
      if (problem !== undefined) return errorBody(400, "invalid_request", problem);
      const imported = yield* importAccounts(runtime, callOf(context), { principal: context.principal, context: administration, input: context.body as AccountImportInput });
      return imported.ok ? ok(imported.result) : refused(imported);
    })),
    route({
      id: "auth.sessions.listByAccountId", method: "GET", path: "/accounts/:accountId/sessions", access: manageAccess,
      operationId: "listSessionsByAccountId", summary: "List the sessions of a managed account",
      responses: { 200: "{ sessions }", 403: "Forbidden", 404: "Account not found" },
    }, (context) => Effect.gen(function* () {
      const listed = yield* runtime.query(callOf(context), (tx) =>
        listAccountSessions(tx, { principal: context.principal, context: administration, accountId: context.params.accountId ?? "" }));
      return listed.ok ? ok({ sessions: listed.sessions }) : refused(listed);
    })),
    route({
      id: "auth.sessions.revokeManagedAccountSessions", method: "DELETE", path: "/accounts/:accountId/sessions", access: manageAccess,
      operationId: "revokeManagedAccountSessions", summary: "End every session of a managed account",
      responses: { 200: "{ revoked }", 403: "Forbidden", 404: "Account not found" },
    }, (context) => Effect.gen(function* () {
      const revoked = yield* runtime.mutation(callOf(context), (tx) =>
        revokeAccountSessions(tx, { principal: context.principal, context: administration, accountId: context.params.accountId ?? "" }));
      return revoked.ok ? ok({ revoked: revoked.revoked }) : refused(revoked);
    })),
    route({
      id: "auth.sessions.revokeManagedSession", method: "DELETE", path: "/accounts/:accountId/sessions/:sessionId", access: manageAccess,
      operationId: "revokeManagedAccountSession", summary: "End one session of a managed account",
      responses: { 204: "Session ended", 403: "Forbidden", 404: "Account or session not found" },
    }, (context) => Effect.gen(function* () {
      const revoked = yield* runtime.mutation(callOf(context), (tx) => revokeAccountSessions(tx, {
        principal: context.principal, context: administration, accountId: context.params.accountId ?? "", sessionId: context.params.sessionId ?? "",
      }));
      return revoked.ok ? { status: 204, headers: noStore } : refused(revoked);
    })),
    route({
      id: "auth.accounts.mfa.reset", method: "DELETE", path: "/accounts/:accountId/mfa", access: manageAccess,
      operationId: "resetAccountMfa", summary: "Remove every second factor of a managed account and end its sessions",
      responses: { 200: "{ removed }: how many authenticators were removed", 403: "Forbidden", 404: "Account not found" },
    }, (context) => Effect.gen(function* () {
      const accountId = context.params.accountId ?? "";
      const reset = yield* runtime.mutation(callOf(context), (tx) => Effect.gen(function* () {
        const actor = yield* resolveActor(tx, context.principal, administration);
        if (actor === null) return refuse("account_access_forbidden");
        const target = yield* managedAccount(tx, actor, administration, accountId);
        if (!target.ok) return target;
        const removed = yield* resetSecondFactor(tx, accountId);
        yield* recordSecurityEvent(tx, { kind: "mfa.reset", accountId, actorId: actor.id, detail: { removed } });
        return { ok: true, removed } as const;
      }));
      return reset.ok ? ok({ removed: reset.removed }) : refused(reset);
    })),
    route({
      id: "auth.securityEvents.list", method: "GET", path: "/security/events", access: manageAccess, tags: ["auth", "security"],
      operationId: "listAuthSecurityEvents", summary: "List authentication security events, newest first",
      responses: { 200: "{ events, next? }", 400: "Malformed paging", 403: "Forbidden" },
    }, (context) => Effect.gen(function* () {
      const limit = queryNumber(context, "limit") ?? 100;
      const before = queryNumber(context, "before");
      if (Number.isNaN(limit) || (before !== undefined && Number.isNaN(before))) return errorBody(400, "invalid_request", "limit and before are numbers.");
      const page = yield* runtime.query(callOf(context), (tx) => Effect.gen(function* () {
        if ((yield* resolveActor(tx, context.principal, administration)) === null) return null;
        return yield* listSecurityEvents(tx, { limit: Math.min(limit, SECURITY_EVENT_PAGE_LIMIT), before });
      }));
      if (page === null) return refused({ code: "account_access_forbidden" });
      return ok({ events: page.events, ...(page.next === undefined ? {} : { next: String(page.next) }) });
    })),
  ];

  const registrationRoutes: ZelavisServerRoute[] = [
    route({
      id: "auth.registration.status", method: "GET", path: "/registration",
      operationId: "registrationStatus", summary: "Whether this runtime admits sign-ups, and with which methods",
      responses: { 200: "{ enabled, providers }" },
    }, (context) => Effect.gen(function* () {
      const listed = yield* options.catalogue.list(context.request);
      return ok({ enabled: listed.registration.enabled, providers: listed.methods.filter((entry) => entry.signUp).map((entry) => entry.name) });
    })),
    route({
      id: "auth.registration.settings.get", method: "GET", path: "/registration/settings", access: settingsAccess,
      operationId: "registrationSettings", summary: "Read the runtime's registration setting",
      responses: { 200: "Saved registration setting and revision" },
    }, (context) => Effect.map(runtime.query(callOf(context), (tx) => options.registration.settings(tx)), (settings) => ok(settings))),
    route({
      id: "auth.registration.settings.set", method: "PUT", path: "/registration/settings", access: settingsAccess,
      maxRequestBodyBytes: REGISTRATION_SETTINGS_BODY_BYTES, invalidJsonBodyCode: "invalid_registration",
      operationId: "setRegistrationSettings", summary: "Open or close registration",
      requestSchema: registrationSettingsInputJsonSchema,
      responses: { 200: "Updated registration setting and revision", 400: "Invalid registration settings", 409: "Settings revision has changed" },
    }, (context) => Effect.gen(function* () {
      const decoded = Schema.decodeUnknownExit(SetRegistrationSettingsInputSchema, strict)(context.body);
      if (Exit.isFailure(decoded)) return errorBody(400, "invalid_registration", "Invalid registration settings.");
      const call = callOf(context);
      const result = yield* runtime.mutation(call, (tx) => Effect.gen(function* () {
        const actor = yield* resolveSettingsActor(tx, context.principal, administration);
        if (actor === null) return refuse("account_access_forbidden");
        const set = yield* options.registration.setSettings(tx, decoded.value);
        if (set.success && set.changed) {
          yield* recordSecurityEvent(tx, { kind: "registration.settings.changed", actorId: actor.id, detail: { enabled: set.settings.enabled } });
        }
        return set;
      }));
      if ("ok" in result) return refused(result);
      return result.success
        ? ok(result.settings)
        : { ...errorBody(409, "registration_settings_conflict", "Registration settings have changed."), body: { error: "Registration settings have changed.", code: "registration_settings_conflict", current: result.conflict } };
    })),
  ];

  const methodRoutes: ZelavisServerRoute[] = [
    route({
      id: "auth.methods.list", method: "GET", path: "/methods",
      operationId: "listAuthMethods", summary: "The sign-in methods this runtime offers and what each can do now",
      responses: { 200: "{ methods, registration }" },
    }, (context) => Effect.map(options.catalogue.list(context.request), (listed) => ok(listed))),
    route({
      id: "auth.methods.settings.get", method: "GET", path: "/methods/settings", access: settingsAccess,
      operationId: "getAuthMethodsSettings", summary: "Which sign-in methods are enabled",
      responses: { 200: "{ enabled, revision }" },
    }, () => Effect.map(options.catalogue.settings(), (settings) => ok(settings))),
    route({
      id: "auth.methods.settings.set", method: "PUT", path: "/methods/settings", access: settingsAccess, maxRequestBodyBytes: 8192, invalidJsonBodyCode: "invalid_request",
      operationId: "setAuthMethodsSettings", summary: "Choose the enabled sign-in methods",
      requestSchema: Schema.toJsonSchemaDocument(MethodsSettingsInputSchema, strict).schema,
      responses: { 200: "{ enabled, revision }", 400: "Invalid settings", 409: "Settings revision has changed" },
    }, (context) => Effect.gen(function* () {
      const decoded = Schema.decodeUnknownExit(MethodsSettingsInputSchema, strict)(context.body);
      if (Exit.isFailure(decoded)) return errorBody(400, "invalid_request", "Method settings are { enabled: [names], expectedRevision }.");
      const result = yield* options.catalogue.setSettings(callOf(context), context.principal, administration, decoded.value);
      if (result.code !== undefined) return refused({ code: result.code });
      return result.success
        ? ok(result.settings)
        : { status: 409, headers: noStore, body: { error: "Method settings have changed.", code: "methods_settings_conflict", current: result.conflict } };
    })),
  ];

  const bootstrap = options.bootstrap;
  const bootstrapRoutes: ZelavisServerRoute[] = bootstrap === undefined ? [] : [
    route({
      id: "auth.bootstrap.status", method: "GET", path: "/bootstrap",
      operationId: "getAuthBootstrapStatus", summary: "Whether the first owner is still to be created",
      responses: { 200: "{ required, available, tokenRequired }" },
    }, (context) => Effect.map(bootstrap.claim.status(callOf(context)), ({ required }) =>
      ok({ required, available: bootstrap.token !== undefined, tokenRequired: true, methods: ["usernamePassword"] }))),
    route({
      id: "auth.bootstrap.createOwner", method: "POST", path: "/bootstrap", maxRequestBodyBytes: 8192, invalidJsonBodyCode: "invalid_request",
      operationId: "bootstrapPlatformOwner", summary: "Create the first Platform owner",
      requestSchema: Schema.toJsonSchemaDocument(BootstrapBody, strict).schema,
      responses: { 201: "The owner and its session", 400: "Invalid owner", 403: "Invalid bootstrap token", 409: "Bootstrap already complete", 503: "No bootstrap token configured" },
    }, (context) => Effect.gen(function* () {
      if (bootstrap.token === undefined) {
        return errorBody(503, "bootstrap_disabled", "First-owner bootstrap is disabled. Configure ZELAVIS_BOOTSTRAP_TOKEN or Zelavis bootstrap.token and restart the Platform.");
      }
      const body = context.body;
      if (typeof body !== "object" || body === null || !tokensEqual(bootstrap.token, (body as { bootstrapToken?: unknown }).bootstrapToken)) {
        return errorBody(403, "invalid_bootstrap_token", "Invalid Platform bootstrap token.");
      }
      const decoded = Schema.decodeUnknownExit(BootstrapBody, strict)(body);
      if (Exit.isFailure(decoded)) return errorBody(400, "invalid_request", "The owner is { bootstrapToken, username, password, displayName?, email? }.");
      const input = decoded.value;
      const usernameError = validateUsernameFormat(input.username);
      if (usernameError !== null) return userErrorResponse(usernameError);
      const passwordError = validateNewPassword(input.password, DEFAULT_MIN_PASSWORD_LENGTH);
      if (passwordError !== null) return userErrorResponse(passwordError);
      const passwordHashPHC = yield* hashPassword(input.password);
      const call = callOf(context);
      const claimed = yield* bootstrap.claim.claim(call, { username: input.username, passwordHashPHC, displayName: input.displayName });
      if (!claimed.ok) return claimed.code === "invalid_username" ? userErrorResponse(claimed.userError) : refused(claimed);
      // An email starts the add-email challenge as the new owner, once email delivery is configured.
      let emailVerification: Record<string, unknown> | undefined;
      if (input.email !== undefined && claimed.outcome.status === "complete") {
        const checked = yield* options.keys.verify(claimed.outcome.tokens.accessToken);
        if (checked.kind !== "valid" || !(yield* options.emailPassword.emailAvailable())) {
          emailVerification = { status: "unavailable" };
        } else {
          const started = yield* options.emailPassword.startAddEmail({ ...call, caller: { sessionId: checked.sub, userId: claimed.userId } }, { email: input.email });
          emailVerification = started.success ? { status: "sent", browserSecret: started.browserSecret } : { status: "refused", code: started.userError.error.toLowerCase() };
        }
      }
      const answer = signInResponse(options.transport, context.request, claimed.outcome, {
        account: { id: claimed.userId, username: input.username, roles: ["owner"], permissions: ["*"] },
        ...(emailVerification === undefined ? {} : { emailVerification }),
      });
      return { ...answer, status: 201 };
    })),
  ];

  const serviceRoutes: ZelavisServerRoute[] = administration.authority !== "platform" ? [] : [
    route({
      id: "auth.serviceAccounts.list", method: "GET", path: "/service-accounts", access: manageAccess, tags: ["auth", "service-accounts"],
      operationId: "listServiceAccounts", summary: "List Platform service accounts",
      responses: { 200: "{ serviceAccounts }", 403: "Forbidden" },
    }, (context) => Effect.gen(function* () {
      const listed = yield* runtime.query(callOf(context), (tx) => listServiceAccounts(tx, { principal: context.principal, context: administration }));
      return listed.ok ? ok({ serviceAccounts: listed.serviceAccounts }) : refused(listed);
    })),
    route({
      id: "auth.serviceAccounts.create", method: "POST", path: "/service-accounts", access: manageAccess, tags: ["auth", "service-accounts"],
      maxRequestBodyBytes: 64 * 1024, invalidJsonBodyCode: "invalid_service_account",
      operationId: "createServiceAccount", summary: "Create a Platform service account and issue its first token",
      responses: { 201: "{ serviceAccount, token, session }: the token is shown once", 400: "Invalid service account", 403: "Delegation forbidden" },
    }, (context) => Effect.gen(function* () {
      const input = (typeof context.body === "object" && context.body !== null ? context.body : {}) as Record<string, unknown>;
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name || name.length > 100) return errorBody(400, "invalid_service_account", "A service account name of at most 100 characters is required.");
      const days = readTokenDays(input.expiresInDays);
      const tenantId = readTenantId(input.tenantId);
      const permissions = readPermissions(input.permissions);
      const grants = readGrants(input.grants);
      for (const value of [days, tenantId, permissions, grants]) if (isProblem(value)) return errorBody(400, value.code, value.message);
      const created = yield* runtime.mutation(callOf(context), (tx) => createServiceAccount(tx, {
        principal: context.principal, context: administration, name,
        days: days as number, tenantId: tenantId as string | undefined, permissions: permissions as ReadonlyArray<string>, grants: grants as ReadonlyArray<ZelavisPrincipalGrant>,
      }));
      return created.ok ? ok({ serviceAccount: created.serviceAccount, token: created.token, session: created.session }, 201) : refused(created);
    })),
    route({
      id: "auth.serviceAccounts.setTenant", method: "PATCH", path: "/service-accounts/:accountId", access: manageAccess, tags: ["auth", "service-accounts"],
      maxRequestBodyBytes: 4096, invalidJsonBodyCode: "invalid_service_account",
      operationId: "setServiceAccountTenant", summary: "Name the App Tenant a service account acts in",
      responses: { 200: "{ serviceAccount }", 400: "Invalid Tenant id", 404: "Service account not found" },
    }, (context) => Effect.gen(function* () {
      const input = (typeof context.body === "object" && context.body !== null ? context.body : {}) as Record<string, unknown>;
      const tenantId = readTenantId(input.tenantId);
      if (isProblem(tenantId)) return errorBody(400, tenantId.code, tenantId.message);
      if (tenantId === undefined) return errorBody(400, "invalid_service_account", "A Tenant id is required.");
      const updated = yield* runtime.mutation(callOf(context), (tx) => setServiceAccountTenant(tx, {
        principal: context.principal, context: administration, accountId: context.params.accountId ?? "", tenantId,
      }));
      return updated.ok ? ok({ serviceAccount: updated.serviceAccount }) : refused(updated);
    })),
    route({
      id: "auth.serviceAccounts.rotateToken", method: "POST", path: "/service-accounts/:accountId/token", access: manageAccess, tags: ["auth", "service-accounts"],
      maxRequestBodyBytes: 4096, invalidJsonBodyCode: "invalid_service_account",
      operationId: "rotateServiceAccountToken", summary: "Revoke a service account's tokens and issue a new one",
      responses: { 200: "{ token, session }: the token is shown once", 404: "Service account not found" },
    }, (context) => Effect.gen(function* () {
      const input = (typeof context.body === "object" && context.body !== null ? context.body : {}) as Record<string, unknown>;
      const days = readTokenDays(input.expiresInDays);
      if (isProblem(days)) return errorBody(400, days.code, days.message);
      const rotated = yield* runtime.mutation(callOf(context), (tx) => rotateServiceAccountToken(tx, {
        principal: context.principal, context: administration, accountId: context.params.accountId ?? "", days,
      }));
      return rotated.ok ? ok({ token: rotated.token, session: rotated.session }) : refused(rotated);
    })),
    route({
      id: "auth.serviceAccounts.revoke", method: "DELETE", path: "/service-accounts/:accountId", access: manageAccess, tags: ["auth", "service-accounts"],
      operationId: "revokeServiceAccount", summary: "Revoke and remove a Platform service account",
      responses: { 204: "Service account removed", 404: "Service account not found" },
    }, (context) => Effect.gen(function* () {
      const revoked = yield* runtime.mutation(callOf(context), (tx) =>
        revokeServiceAccount(tx, { principal: context.principal, context: administration, accountId: context.params.accountId ?? "" }));
      return revoked.ok ? { status: 204, headers: noStore } : refused(revoked);
    })),
  ];

  return [...accountRoutes, ...registrationRoutes, ...methodRoutes, ...bootstrapRoutes, ...serviceRoutes];
}
