import { ZelavisAuthenticationError } from "../core/runtime/authentication.js";
/**
 * Zelavis Auth: one instance per runtime, on that runtime's own Auth
 * partition. `createAuth` creates the tables and the first signing key, then
 * assembles the core, the accounts module, the request authenticator, the
 * sign-in methods, the Zelavis account modules (registration, bootstrap,
 * administration, service accounts, security events, the methods catalogue)
 * and their routes. `subsystem.ts` composes it into the Platform and
 * every App runtime.
 */
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { TransactionConflict, TransactionTooLarge } from "../db/errors.js";
import type { TenantApi } from "../db/database.js";
import type { EmailOutbox } from "../app/email/contracts.js";
import type { ZelavisPrincipal, ZelavisRequestAuthenticator, ZelavisServerRoute } from "../core/index.js";
import { present } from "../core/runtime/effect-boundary.js";
import { type AccountsModule, accountsModule } from "./accounts/accounts.js";
import { type AuthAuthenticator, createAuthAuthenticator } from "./core/authenticator.js";
import type { OAuthProviderDefinition } from "./oauth/plugins.js";
import { createCoreRuntime, signUpRolesFor } from "./core/context.js";
import { PLATFORM_ACCESS_COOKIE, PLATFORM_REFRESH_COOKIE, projectAuthCookieNames } from "./core/cookies.js";
import type { AuthStartupFailure } from "./core/errors.js";
import { createOrphanTokensSweep } from "./core/sessions.js";
import { type AuthCore, createAuthCore } from "./core/setup.js";
import { coreTables } from "./core/tables.js";
import { accountsTables } from "./accounts/tables.js";
import { type AuthKeysAdmin, createAuthKeys } from "./keys/keys.js";
import { keysTables } from "./keys/tables.js";
import { projectAuthAudience } from "./core/audience.js";
import { createExpiredChallengesSweep } from "./email/cleanup.js";
import { emailTables } from "./email/tables.js";
import { emailReservationTables } from "./email/reservations.js";
import { identityImporter } from "./import/importer.js";
import { IdentityImportFailure, type IdentitySource } from "./import/sources.js";
import { importTables } from "./import/state.js";
import { createInvitationAcceptance } from "./invitations/accept.js";
import { createInvitations } from "./invitations/invitations.js";
import { defineInvitationRoutes } from "./routes/invitations.js";
import { expiredInvitationsSweep } from "./invitations/sweep.js";
import { invitationsTables } from "./invitations/tables.js";
import { errorBody } from "./routes/errors.js";
import { createExpiredFlowsSweep } from "./oauth/cleanup.js";
import { oauthFlowTables } from "./lib/oauth/schema.js";
import { oauthConnectionsTables, oauthTables } from "./oauth/tables.js";
import { appleTables } from "./apple/tables.js";
import { githubTables } from "./github/tables.js";
import { googleTables } from "./google/tables.js";
import { type OAuthMethod, setupOAuth } from "./methods/oauth.js";
import { defineOAuthRoutes } from "./routes/oauth.js";
import type { ZelavisAccessRequirement } from "../core/index.js";
import type { OAuthFetch } from "./lib/oauth/callback.js";
import { type EmailPasswordMethod, setupEmailPassword } from "./methods/email-password.js";
import { type UsernamePasswordMethod, setupUsernamePassword } from "./methods/username-password.js";
import { passwordTables } from "./password/tables.js";
import { usernameTables } from "./username/tables.js";
import { createExpiredPendingSignInsSweep } from "./totp/cleanup.js";
import { createSecondFactorGate } from "./totp/gate.js";
import { type MfaMethod, setupMfa } from "./methods/totp.js";
import { defineMfaRoutes } from "./routes/totp.js";
import { totpKey } from "./totp/helpers.js";
import { totpTables } from "./totp/tables.js";
import type { TtlConfig } from "./lib/ttl.js";
import { setupUsernamePasskey, type UsernamePasskeyMethod } from "./methods/username-passkey/server.js";
import { createExpiredPasskeyChallengesSweep } from "./passkey/cleanup.js";
import { createPasskeySettings, type PasskeyDefaults, type PasskeySettings } from "./passkey/settings.js";
import { passkeyTables } from "./passkey/tables.js";
import { defineAuthCoreRoutes } from "./routes/core.js";
import { defineEmailRoutes } from "./routes/email.js";
import { definePasskeyRoutes } from "./routes/passkeys.js";
import { defineUsernamePasswordRoutes } from "./routes/username-password.js";
import { bootstrapTables } from "./bootstrap/tables.js";
import { type Bootstrap, createBootstrap } from "./bootstrap/bootstrap.js";
import { type Registration, createRegistration } from "./registration/policy.js";
import { registrationTables } from "./registration/tables.js";
import { createSecurityRetentionSweep } from "./security/events.js";
import { securityTables } from "./security/tables.js";
import { serviceAccountTables } from "./serviceAccounts/tables.js";
import { type MethodsCatalogue, createMethodsCatalogue } from "./methods/catalogue.js";
import { methodsTables } from "./methods/settings.js";
import type { AdministrationContext } from "./access/delegation.js";
import { defineAdminRoutes } from "./routes/admin.js";
import { defineRoleRoutes } from "./routes/roles.js";
import { createRoleCatalogueCache } from "./roles/cache.js";
import { rolesTables } from "./roles/tables.js";
import type { ZelavisPrincipalGrant } from "../core/index.js";
import {
  NO_REQUEST,
  type AuthRuntime,
  type AuthSweep,
  type AuthTableRef,
  createAuthOutboxRelay,
  createAuthRuntime,
  createLimiterBucketsSweep,
  ensureTables,
  limiterTables,
  startSweeps,
} from "./runtime/index.js";

type ImportFailure = IdentityImportFailure | TransactionConflict | TransactionTooLarge;

interface RunningAuth {
  readonly stop: () => Effect.Effect<void>;
  /** The candidate host waits for this before admitting traffic on an upgraded App. */
  readonly waitForImport: Effect.Effect<void, ImportFailure>;
}

export interface CreateAuthOptions {
  /** The Auth partition: the one Tenant holding every module's tables. */
  readonly tenant: TenantApi;
  /** Seals the signing keys and the outbox; the runtime's master secret. */
  readonly masterSecret: string;
  /**
   * The `iss` of this runtime's access tokens. "platform" (the default for the
   * Platform) derives `zelavis:platform:<keySetId>`; a Project derives
   * `zelavis:project:<projectId>`; any other value is used as given.
   */
  readonly issuer?: string | undefined;
  readonly role: "platform" | "project";
  /** The prior engine must release write authority before supplying this source. */
  readonly importFrom?: IdentitySource | undefined;
  readonly projectId?: string | undefined;
  readonly ttl?: Partial<TtlConfig> | undefined;
  readonly emailOutbox?: EmailOutbox | undefined;
  readonly clock?: (() => number) | undefined;
  /** The path the API is served under (for example `/zelavis/api/v1`), where the cookies are scoped. Empty for the root. */
  readonly apiBase?: string | undefined;
  readonly dashboardPath?: string | undefined;
  readonly passkeys?: PasskeyDefaults | undefined;
  /** TOTP: the name authenticator apps show for this runtime; the passkey name, else "Zelavis", unless given. */
  readonly mfa?: { readonly issuer?: string | undefined } | undefined;
  /** OAuth: where redirects back to the app may point, and the rest of what the providers need. */
  readonly oauth?: {
    /** Origins `redirectTo` may point at, beside the origin of each connection's registered callback URL. */
    readonly allowedRedirectOrigins?: ReadonlyArray<string> | (() => ReadonlyArray<string>) | undefined;
    readonly fetch?: OAuthFetch | undefined;
    /** Where `ZELAVIS_AUTH_<PROVIDER>_*` bootstrap values are read from. */
    readonly environment?: Readonly<Record<string, string | undefined>> | undefined;
    readonly providers?: ReadonlyMap<string, OAuthProviderDefinition> | undefined;
  } | undefined;
  /** Registration: whether sign-ups are admitted before an operator saves a setting. Closed unless given. */
  readonly registration?: { readonly initiallyEnabled?: boolean | undefined } | undefined;
  /** The Platform's first-owner bootstrap token (32 to 1024 characters); without one, `POST /auth/bootstrap` answers 503. */
  readonly bootstrapToken?: string | undefined;
  /** The Platform's check that new grants name Projects and services that exist. */
  readonly validateGrantScopes?: ((scopes: ReadonlyArray<NonNullable<ZelavisPrincipalGrant["scope"]>>) => Effect.Effect<boolean>) | undefined;
}

export interface AuthApi {
  readonly runtime: AuthRuntime;
  readonly core: AuthCore;
  readonly accounts: AccountsModule;
  readonly keys: AuthKeysAdmin;
  /** The sign-in methods ported so far; later parts add their own. */
  readonly methods: { readonly usernamePassword: UsernamePasswordMethod; readonly usernamePasskey: UsernamePasskeyMethod; readonly emailPassword: EmailPasswordMethod; readonly oauth: OAuthMethod };
  readonly passkeySettings: PasskeySettings;
  /** TOTP enrollment, the second step of a gated sign-in, and the MFA policy. */
  readonly mfa: MfaMethod;
  /** Whether this runtime admits sign-ups. */
  readonly registration: Registration;
  /** The first-owner claim; the Platform's only. */
  readonly bootstrap?: Bootstrap | undefined;
  /** The enabled sign-in methods and what each can do now. */
  readonly methodsCatalogue: MethodsCatalogue;
  readonly authenticator: AuthAuthenticator;
  readonly authenticate: (request: Request) => Effect.Effect<ZelavisPrincipal | undefined>;
  /** The authenticator as the dispatcher takes it. */
  readonly requestAuthenticator: ZelavisRequestAuthenticator;
  /** The core and sign-in method routes, served under `/auth`. */
  readonly routes: ReadonlyArray<ZelavisServerRoute>;
  /** This runtime's cookie names and the API path they are scoped to. */
  readonly cookies: { readonly accessName: string; readonly refreshName: string; readonly apiBase: string; readonly accessPath?: string };
  /** Completes a Platform import or starts an App import, then manages background work. */
  readonly start: () => Effect.Effect<RunningAuth, ImportFailure>;
}

/** Every table of every module this version of Auth ports so far; modules added by later parts join it. */
const tablesOf = (): Readonly<Record<string, AuthTableRef>> => {
  const all: Record<string, AuthTableRef> = {};
  for (const group of [coreTables, accountsTables, keysTables, limiterTables, usernameTables, passwordTables, emailTables, emailReservationTables, importTables, passkeyTables, oauthFlowTables, oauthTables, oauthConnectionsTables, googleTables, appleTables, githubTables, totpTables, registrationTables, bootstrapTables, securityTables, serviceAccountTables, methodsTables, invitationsTables, rolesTables] as ReadonlyArray<Readonly<Record<string, AuthTableRef>>>) {
    for (const table of Object.values(group)) all[table.collection] = table;
  }
  return all;
};

export const createAuth = Effect.fn("auth.create")(function* (options: CreateAuthOptions) {
  const clock = options.clock ?? Date.now;
  const relay = options.emailOutbox === undefined ? undefined : createAuthOutboxRelay({ tenant: options.tenant, outbox: options.emailOutbox, masterSecret: options.masterSecret });
  const runtime = createAuthRuntime({ tenant: options.tenant, masterSecret: options.masterSecret, clock, ...(relay === undefined ? {} : { relay }) });
  yield* ensureTables(options.tenant, tablesOf());
  const keys = createAuthKeys({ runtime, masterSecret: options.masterSecret, role: options.role, projectId: options.projectId, issuer: options.issuer, clock });
  yield* keys.ensure();
  const coreRuntime = createCoreRuntime(runtime, keys, signUpRolesFor(options.role));
  const secondFactorKey = totpKey(options.masterSecret);
  const bootstrapToken = options.bootstrapToken;
  if (bootstrapToken !== undefined && (bootstrapToken.length < 32 || bootstrapToken.length > 1024)) {
    return yield* Effect.die(new TypeError("Platform bootstrap tokens must contain between 32 and 1024 characters."));
  }
  const registration = createRegistration({ role: options.role, initiallyEnabled: options.registration?.initiallyEnabled ?? false });
  const core = createAuthCore({
    runtime: coreRuntime,
    ttl: options.ttl ?? {},
    secondFactor: createSecondFactorGate({ key: secondFactorKey }),
    registration,
  });

  // The Project session audience: the first 24 hex characters of SHA-256 of the Project id.
  const projectAudience = options.role === "project" ? yield* projectAuthAudience(options.projectId ?? "") : undefined;
  const names = projectAudience === undefined
    ? { accessName: PLATFORM_ACCESS_COOKIE, refreshName: PLATFORM_REFRESH_COOKIE }
    : projectAuthCookieNames(projectAudience);
  // The role catalogue authentication expands from; the role routes clear it after each change.
  const roleCatalogue = createRoleCatalogueCache(runtime);
  const baseAuthenticator = createAuthAuthenticator({
    runtime, keys, cookieName: names.accessName,
    projectId: projectAudience === undefined ? undefined : options.projectId,
    projectAudience,
    roles: roleCatalogue,
  });
  const usernamePassword = setupUsernamePassword(core);
  const passkeySettings = createPasskeySettings(runtime, options.passkeys);
  const usernamePasskey = setupUsernamePasskey(core, { settings: passkeySettings.read });
  const emailPassword = setupEmailPassword(core, { emailOutbox: options.emailOutbox });
  const oauth = setupOAuth(core, {
    runtime,
    masterSecret: options.masterSecret,
    clock,
    allowedRedirectOrigins: options.oauth?.allowedRedirectOrigins,
    fetch: options.oauth?.fetch,
    environment: options.oauth?.environment,
    providers: options.oauth?.providers,
  });
  const tables = tablesOf();
  // A rebuilt import starts from empty tables: every module's rows go, the signing keys with them.
  const reset = () => Effect.gen(function* () {
    for (const table of Object.values(tables)) {
      // This checkpoint fences an interrupted rebuild even if every other table has been emptied.
      if (table.collection !== importTables.state.collection) yield* options.tenant.documents.dropCollection({ name: table.collection });
    }
    yield* ensureTables(options.tenant, tables);
    yield* keys.ensure();
    roleCatalogue.invalidate();
  }).pipe(Effect.mapError((failure) => new IdentityImportFailure({ message: `Auth could not be emptied for a rebuilt import: ${failure._tag}` })));
  const importer = options.importFrom === undefined ? undefined : identityImporter({
    runtime, role: options.role, masterSecret: options.masterSecret, source: options.importFrom, connections: oauth.connections, reset,
  });
  if (importer === undefined) {
    const checkpoint = yield* runtime.query(NO_REQUEST, (tx) => tx.db.query(importTables.state).first());
    if (checkpoint !== null && checkpoint.status !== "done") {
      return yield* new IdentityImportFailure({ message: "An interrupted Identity import needs its original source." });
    }
  }
  let importing = importer !== undefined && (yield* importer.prepare());
  const finishImport = importer === undefined ? Effect.void : importer.run().pipe(
    Effect.tap(() => Effect.sync(() => { importing = false; })),
  );
  const authenticator: AuthAuthenticator = {
    ...baseAuthenticator,
    authenticate: (request) => Effect.suspend(() => importing ? Effect.succeed(undefined) : baseAuthenticator.authenticate(request)),
  };

  const mfa = setupMfa(core, { runtime: coreRuntime, key: secondFactorKey, issuer: options.mfa?.issuer ?? options.passkeys?.name ?? "Zelavis" });
  const methods = { usernamePassword, usernamePasskey, emailPassword, oauth };
  // Who may read and change the OAuth connections: the settings permission of this runtime.
  const settingsAccess: ZelavisAccessRequirement = options.role === "platform"
    ? { permissions: ["system.settings.manage"] }
    : { permissions: ["project.settings.manage"], ...(options.projectId === undefined ? {} : { scope: { type: "project" as const, projectId: options.projectId } }) };
  const cookies = { ...names, apiBase: options.apiBase ?? "", ...(options.dashboardPath === undefined ? {} : { accessPath: options.dashboardPath || "/" }) };
  const coreRoutes = defineAuthCoreRoutes({
    core,
    runtime: coreRuntime,
    keys,
    authenticator,
    role: options.role,
    projectId: options.projectId,
    cookies,
    clock,
  });
  const methodsCatalogue = createMethodsCatalogue({ runtime, registration, passkeys: passkeySettings, oauth, emailPassword });
  const bootstrap = options.role === "platform" ? createBootstrap(core, coreRuntime) : undefined;
  const administration: AdministrationContext = { authority: options.role, ...(options.role === "project" ? { projectId: options.projectId } : {}) };
  // A disabled method's sign-in, sign-up and recovery routes answer 404 `method_disabled`.
  const routes = methodsCatalogue.gate([
    ...coreRoutes,
    ...defineUsernamePasswordRoutes({ method: usernamePassword, transport: { cookies, clock } }),
    ...defineEmailRoutes({ method: emailPassword, transport: { cookies, clock } }),
    ...defineOAuthRoutes({ method: oauth, transport: { cookies, clock }, settingsAccess }),
    ...definePasskeyRoutes({ method: usernamePasskey, transport: { cookies, clock }, settings: passkeySettings, settingsAccess }),
    ...defineMfaRoutes({ method: mfa, transport: { cookies, clock }, settingsAccess }),
    ...defineInvitationRoutes({
      management: createInvitations({ runtime, context: administration, emailOutbox: options.emailOutbox, validateGrantScopes: options.validateGrantScopes }),
      accept: createInvitationAcceptance(core, administration),
      context: administration,
      transport: { cookies, clock },
      authenticator,
    }),
    ...defineAdminRoutes({
      runtime: coreRuntime,
      keys,
      context: administration,
      registration,
      catalogue: methodsCatalogue,
      transport: { cookies, clock },
      settingsAccess,
      bootstrap: bootstrap === undefined ? undefined : { claim: bootstrap, token: bootstrapToken },
      emailPassword,
      validateGrantScopes: options.validateGrantScopes,
    }),
    ...defineRoleRoutes({ runtime: coreRuntime, context: administration, cache: roleCatalogue, validateGrantScopes: options.validateGrantScopes }),
  ]);

  const sweeps: ReadonlyArray<AuthSweep<AuthRuntime>> = [createOrphanTokensSweep(options.tenant), createExpiredChallengesSweep(options.tenant, clock), createExpiredPasskeyChallengesSweep(options.tenant, clock), createExpiredFlowsSweep(options.tenant, clock), createExpiredPendingSignInsSweep(options.tenant, clock), createLimiterBucketsSweep(options.tenant, clock), createSecurityRetentionSweep(options.tenant, clock), expiredInvitationsSweep, ...keys.sweeps];
  const api: AuthApi = {
    runtime,
    core,
    accounts: accountsModule,
    methods,
    passkeySettings,
    mfa,
    keys,
    registration,
    bootstrap,
    methodsCatalogue,
    authenticator,
    cookies,
    authenticate: authenticator.authenticate,
    requestAuthenticator: {
      name: "zelavis-auth",
      authenticate: (context) => present(Effect.gen(function* () {
        const { request, resolvedRoute } = context;
        const principal = yield* authenticator.authenticate(request);
        if (principal === undefined && resolvedRoute?.route.access && authenticator.expiredToken(request)) {
          throw new ZelavisAuthenticationError("The access token expired; refresh the session.", { code: "access_token_expired" });
        }
        return principal;
      })),
    },
    routes: importer === undefined ? routes : routes.map((route) => ({
      ...route,
      handler: (context) => importing
        ? errorBody(503, "auth_importing", "Account data is being imported. Try again shortly.", { "retry-after": "1" })
        : route.handler(context),
    })),
    start: () => Effect.gen(function* () {
      if (importing && options.role === "platform") yield* finishImport;
      const sweeping = yield* startSweeps(runtime, sweeps);
      const relaying = relay === undefined ? undefined : yield* relay.start();
      const migration = importing ? yield* Effect.forkDetach(finishImport.pipe(
        Effect.tapError((failure) => Effect.logError(`Auth import stopped: ${failure._tag === "IdentityImportFailure" ? failure.message : failure._tag}`)),
      )) : undefined;
      return {
        waitForImport: migration === undefined ? Effect.void : Fiber.join(migration),
        stop: () => Effect.gen(function* () {
          if (migration !== undefined) yield* Fiber.interrupt(migration);
          yield* sweeping.stop();
          if (relaying !== undefined) yield* relaying.stop();
        }),
      };
    }),
  };
  return api;
}) satisfies (options: CreateAuthOptions) => Effect.Effect<AuthApi, AuthStartupFailure>;
