/**
 * Zelavis Auth as a runtime subsystem (Zelavis-own): the one auth engine of a
 * Platform or an App runtime, composed by `zelavis()`.
 *
 * Each runtime has its own instance on its own database: the Platform's on the
 * Platform identity database, an App's on its Project database, both in the
 * `service:zelavis-auth` partition. Nothing (route, cookie, key or store) is
 * shared between them; a Platform principal reaches an App only through the
 * Gateway's signed authority.
 */
import * as Effect from "effect/Effect";
import type { TenantApi } from "../db/database.js";
import type { EmailOutbox } from "../app/email/contracts.js";
import type { ZelavisEndpointGroup, ZelavisPrincipal, ZelavisPrincipalGrant } from "../core/index.js";
import { present } from "../core/runtime/effect-boundary.js";
import type { TtlConfig } from "./lib/ttl.js";
import type { IdentitySource } from "./import/sources.js";
import type { PasskeyDefaults } from "./passkey/settings.js";
import type { OAuthFetch } from "./lib/oauth/callback.js";
import { type AuthApi, createAuth } from "./create-auth.js";
import type { OAuthProviderDefinition } from "./oauth/plugins.js";
import { NO_REQUEST } from "./runtime/index.js";
import type { MethodEntry } from "./methods/catalogue.js";

/** The Auth partition's Tenant, in the Platform identity database and in every Project database. */
export const AUTH_TENANT = "service:zelavis-auth";

/** `subsystems.auth`: `false` composes no Auth; an object tunes it. */
export type ZelavisAuthOptions = boolean | {
  /** Session, refresh-token and access-token lifetimes. */
  readonly ttl?: Partial<TtlConfig> | undefined;
  /** Whether sign-ups are admitted before an operator saves a setting (closed unless given). */
  readonly registration?: boolean | undefined;
  /** Passkey relying party defaults for this runtime. */
  readonly passkeys?: PasskeyDefaults | undefined;
  /** OAuth: extra origins `redirectTo` may name, and the fetch provider calls use. */
  readonly oauth?: {
    readonly allowedRedirectOrigins?: ReadonlyArray<string> | undefined;
    readonly fetch?: OAuthFetch | undefined;
  } | undefined;
};

/** An account as a service sees it: never a secret, never a credential. */
export interface PublicAccount {
  readonly id: string;
  readonly kind: string;
  readonly displayName?: string | undefined;
  readonly roles: ReadonlyArray<string>;
  readonly permissions: ReadonlyArray<string>;
  readonly grants: ReadonlyArray<ZelavisPrincipalGrant>;
}

/** `core.auth` for services: who a request is, what sign-in offers, and an account by id. */
export interface AuthServiceApi {
  principalFor(request: Request): Promise<ZelavisPrincipal | undefined>;
  methods(request: Request): Promise<{ readonly methods: ReadonlyArray<MethodEntry>; readonly registration: { readonly enabled: boolean } }>;
  readonly accounts: { get(accountId: string): Promise<PublicAccount | undefined> };
}

/** Private adapter input for a Project whose database can move to a standby. */
export const projectAuthSealingSecret = Symbol("projectAuthSealingSecret");

export interface AuthSubsystemOptions {
  readonly tenant: TenantApi;
  readonly role: "platform" | "project";
  readonly projectId?: string | undefined;
  readonly masterSecret: string;
  readonly apiBase: string;
  readonly dashboardPath?: string | undefined;
  readonly options: Exclude<ZelavisAuthOptions, boolean> | undefined;
  readonly emailOutbox?: EmailOutbox | undefined;
  readonly importFrom?: IdentitySource | undefined;
  readonly bootstrapToken?: string | undefined;
  readonly validateGrantScopes?: ((scopes: ReadonlyArray<NonNullable<ZelavisPrincipalGrant["scope"]>>) => Effect.Effect<boolean>) | undefined;
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined;
  readonly oauthProviders?: ReadonlyMap<string, OAuthProviderDefinition> | undefined;
}

export interface AuthSubsystem {
  readonly auth: AuthApi;
  readonly service: AuthServiceApi;
  readonly endpointGroup: ZelavisEndpointGroup<AuthServiceApi>;
  /** Names of the cookies this runtime's Auth sets, which a public site must never receive. */
  readonly cookieNames: ReadonlyArray<string>;
}

const publicAccount = (account: { readonly _id: string; readonly kind: string; readonly displayName?: string | undefined; readonly roles: ReadonlyArray<string>; readonly permissions: ReadonlyArray<string>; readonly grants: ReadonlyArray<ZelavisPrincipalGrant> }): PublicAccount => ({
  id: account._id,
  kind: account.kind,
  ...(account.displayName === undefined ? {} : { displayName: account.displayName }),
  roles: [...account.roles],
  permissions: [...account.permissions],
  grants: account.grants.map((grant) => ({ ...grant })),
});

export const createAuthSubsystem = Effect.fn("auth.subsystem.create")(function* (input: AuthSubsystemOptions) {
  const auth = yield* createAuth({
    tenant: input.tenant,
    role: input.role,
    projectId: input.projectId,
    masterSecret: input.masterSecret,
    apiBase: input.apiBase,
    dashboardPath: input.dashboardPath,
    ttl: input.options?.ttl,
    passkeys: input.options?.passkeys,
    emailOutbox: input.emailOutbox,
    importFrom: input.importFrom,
    bootstrapToken: input.role === "platform" ? input.bootstrapToken : undefined,
    validateGrantScopes: input.validateGrantScopes,
    registration: { initiallyEnabled: input.options?.registration ?? false },
    oauth: {
      allowedRedirectOrigins: input.options?.oauth?.allowedRedirectOrigins,
      fetch: input.options?.oauth?.fetch,
      environment: input.environment,
      providers: input.oauthProviders,
    },
  });
  const service: AuthServiceApi = Object.freeze({
    principalFor: (request: Request) => present(auth.authenticate(request)),
    methods: (request: Request) => present(auth.methodsCatalogue.list(request)),
    accounts: Object.freeze({
      get: (accountId: string) => present(auth.runtime.query(NO_REQUEST, (tx) => auth.accounts.get(tx, accountId)).pipe(
        Effect.map((account) => (account === null ? undefined : publicAccount(account))),
      )),
    }),
  });
  const endpointGroup: ZelavisEndpointGroup<AuthServiceApi> = Object.freeze({
    id: "auth",
    basePath: "/auth",
    // No menu: the settings page is `@zelavis/auth`, a product service.
    context: service,
    authenticators: [auth.requestAuthenticator],
    origin: { type: "subsystem" as const, subsystem: "auth" },
    api: { v1: auth.routes },
  });
  return { auth, service, endpointGroup, cookieNames: [auth.cookies.accessName, auth.cookies.refreshName] } satisfies AuthSubsystem;
});
