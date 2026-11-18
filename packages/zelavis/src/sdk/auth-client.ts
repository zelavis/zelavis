/**
 * The JS client for Zelavis Auth (`client.auth`), grouped as its routes are: one method per `/auth/...` operation, taking
 * the route's request body and answering its response body. Errors are `ZelavisClientHttpError` carrying the route's
 * `code`. The same operations are the CLI's `zelavis auth <group> <action>`.
 */
import type { AcceptInvitationInput, CreateInvitationInput, InvitationListOptions, InvitationPage, PublicInvitation } from "../auth/invitations/tables.js";
import type { RoleCatalogueView, RoleDefinitionInput } from "../auth/roles/catalogue.js";
import type { ZelavisClientRequestOptions } from "./fetch.js";

type Json = <T>(path: string, options?: ZelavisClientRequestOptions) => Promise<T>;
type Body = Readonly<Record<string, unknown>>;
type RequestBody = object;
type EmailChallenge = { readonly emailCode: string; readonly browserSecret: string };
type BrowserSecret = { readonly browserSecret: string };
type PasswordChange = { readonly currentPassword: string; readonly newPassword: string };
type SecondFactorCode = { readonly code: string };

/** The token bundle a native client keeps (a browser page of a Zelavis origin gets cookies instead). */
export interface ZelavisAuthTokens {
  readonly userId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt?: number;
  readonly refreshTokenExpiresAt: number;
}

/** A sign-in or sign-up: complete with a session, or waiting for a second factor or a verification step. */
export interface ZelavisAuthSignInResult {
  readonly status: "complete" | "mfa_required" | "mfa_enrollment_required" | (string & {});
  readonly userId?: string;
  readonly tokens?: ZelavisAuthTokens;
  readonly challenge?: string;
  readonly [key: string]: unknown;
}

export type ZelavisAuthRefreshResult =
  | { readonly kind: "rotated"; readonly tokens?: ZelavisAuthTokens; readonly userId?: string }
  | { readonly kind: "noSession" };

export interface ZelavisAuthAccountView {
  readonly id: string;
  readonly kind: string;
  readonly displayName?: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly grants: readonly { readonly permission: string; readonly scope?: Readonly<Record<string, unknown>> }[];
  readonly roleAssignments?: readonly { readonly roleId: string; readonly projectIds?: readonly string[] }[];
  readonly accessRevision?: number;
  readonly [key: string]: unknown;
}

export interface ZelavisAuthCurrentSession {
  readonly sessionId: string;
  readonly account: ZelavisAuthAccountView;
}

export interface ZelavisAuthMethodEntry {
  readonly name: string;
  readonly signIn: boolean;
  readonly signUp: boolean;
  readonly recovery: boolean;
  readonly reason?: string;
}

export interface ZelavisAuthClient {
  acceptInvitation(input: AcceptInvitationInput): Promise<ZelavisAuthSignInResult>;
  readonly usernamePassword: {
    signUp(input: { readonly username: string; readonly password: string; readonly displayName?: string }): Promise<ZelavisAuthSignInResult>;
    signIn(input: { readonly username: string; readonly password: string }): Promise<ZelavisAuthSignInResult>;
    changePassword(input: PasswordChange): Promise<unknown>;
  };
  readonly emailPassword: {
    signUp(input: { readonly email: string; readonly password: string; readonly displayName?: string }): Promise<BrowserSecret>;
    completeSignUp(input: EmailChallenge): Promise<ZelavisAuthSignInResult>;
    signIn(input: { readonly email: string; readonly password: string }): Promise<ZelavisAuthSignInResult>;
    changePassword(input: PasswordChange): Promise<unknown>;
    startChangeEmail(input: { readonly newEmail: string; readonly password: string }): Promise<BrowserSecret>;
    completeChangeEmail(input: EmailChallenge): Promise<unknown>;
    startRecovery(input: { readonly email: string }): Promise<BrowserSecret>;
    checkRecovery(input: EmailChallenge): Promise<unknown>;
    completeRecovery(input: EmailChallenge & { readonly newPassword: string }): Promise<ZelavisAuthSignInResult>;
  };
  readonly usernamePasskey: {
    startSignUp(input: Body): Promise<unknown>;
    finishSignUp(input: Body): Promise<ZelavisAuthSignInResult>;
    startSignIn(input: Body): Promise<unknown>;
    startAutofill(input?: Body): Promise<unknown>;
    finishSignIn(input: Body): Promise<ZelavisAuthSignInResult>;
  };
  readonly passkeys: {
    list(): Promise<unknown>;
    startAdd(input?: Body): Promise<unknown>;
    verifyAdd(input: Body): Promise<unknown>;
    finishAdd(input: Body): Promise<unknown>;
    rename(passkeyId: string, input: { readonly name: string }): Promise<unknown>;
    startRemove(passkeyId: string, input?: Body): Promise<unknown>;
    finishRemove(passkeyId: string, input: Body): Promise<unknown>;
    settings(): Promise<unknown>;
    setSettings(input: Body): Promise<unknown>;
  };
  readonly oauth: {
    providers(): Promise<{ readonly providers: ReadonlyArray<{ readonly name: string; readonly title: string }> }>;
    start(provider: string, input: { readonly redirectTo: string }): Promise<{ readonly url: string; readonly state: string }>;
    redeem(provider: string, input: { readonly ticket: string; readonly state: string; readonly link?: boolean }): Promise<ZelavisAuthSignInResult | undefined>;
    connections(): Promise<unknown>;
    configure(provider: string, input: Body): Promise<unknown>;
    remove(provider: string): Promise<void>;
  };
  readonly mfa: {
    status(): Promise<unknown>;
    startTotp(input?: { readonly password?: string; readonly challenge?: string; readonly code?: string }): Promise<unknown>;
    confirmTotp(input: SecondFactorCode & { readonly totpId: string; readonly challenge?: string }): Promise<unknown>;
    verify(input: SecondFactorCode & { readonly challenge: string }): Promise<ZelavisAuthSignInResult>;
    removeTotp(totpId: string, input: SecondFactorCode): Promise<unknown>;
    regenerateBackupCodes(input: SecondFactorCode): Promise<unknown>;
    policy(): Promise<unknown>;
    setPolicy(input: Body): Promise<unknown>;
  };
  readonly emails: {
    list(): Promise<unknown>;
    startAdd(input: { readonly email: string }): Promise<BrowserSecret>;
    completeAdd(input: EmailChallenge): Promise<unknown>;
  };
  readonly session: {
    current(): Promise<ZelavisAuthCurrentSession>;
    refresh(input?: { readonly refreshToken?: string }): Promise<ZelavisAuthRefreshResult>;
    signOut(input?: { readonly refreshToken?: string }): Promise<void>;
  };
  readonly sessions: {
    list(): Promise<unknown>;
    revoke(sessionId: string): Promise<void>;
    revokeOthers(): Promise<unknown>;
  };
  readonly keys: {
    jwks(): Promise<{ readonly keys: readonly Readonly<Record<string, unknown>>[] }>;
    rotate(): Promise<unknown>;
  };
  readonly methods: {
    list(): Promise<{ readonly methods: readonly ZelavisAuthMethodEntry[]; readonly registration: { readonly enabled: boolean } }>;
    settings(): Promise<{ readonly enabled: readonly string[]; readonly revision: number }>;
    setSettings(input: { readonly enabled: readonly string[]; readonly expectedRevision: number }): Promise<unknown>;
  };
  readonly registration: {
    status(): Promise<{ readonly enabled: boolean; readonly [key: string]: unknown }>;
    settings(): Promise<unknown>;
    setSettings(input: Body): Promise<unknown>;
  };
  readonly bootstrap: {
    status(): Promise<{ readonly required: boolean; readonly available: boolean; readonly tokenRequired: boolean; readonly methods: readonly string[] }>;
    claim(input: { readonly bootstrapToken: string; readonly username: string; readonly password: string; readonly displayName?: string }): Promise<ZelavisAuthSignInResult>;
  };
  readonly admin: {
    invitations(options?: InvitationListOptions): Promise<InvitationPage>;
    invite(input: CreateInvitationInput): Promise<PublicInvitation>;
    resendInvitation(id: string): Promise<PublicInvitation>;
    revokeInvitation(id: string): Promise<PublicInvitation>;
    accounts(input?: { readonly accountId?: string; readonly limit?: number; readonly after?: string }): Promise<{ readonly accounts: readonly ZelavisAuthAccountView[]; readonly next?: string }>;
    createAccount(input: { readonly username: string; readonly password: string; readonly displayName?: string; readonly role?: string }): Promise<{ readonly account: ZelavisAuthAccountView }>;
    setAccess(accountId: string, input: Body): Promise<unknown>;
    /** The runtime's custom roles and the catalogue revision a change names. */
    roles(): Promise<RoleCatalogueView>;
    createRole(input: RoleDefinitionInput): Promise<RoleCatalogueView>;
    updateRole(roleId: string, input: RoleDefinitionInput): Promise<RoleCatalogueView>;
    deleteRole(roleId: string, expectedRevision: number): Promise<RoleCatalogueView>;
    importAccounts(input: Body): Promise<unknown>;
    accountSessions(accountId: string): Promise<unknown>;
    revokeAccountSession(accountId: string, sessionId: string): Promise<void>;
    revokeAccountSessions(accountId: string): Promise<unknown>;
    resetMfa(accountId: string): Promise<unknown>;
    securityEvents(input?: { readonly limit?: number; readonly after?: string; readonly accountId?: string }): Promise<unknown>;
  };
  readonly serviceAccounts: {
    list(): Promise<{ readonly serviceAccounts: readonly ZelavisServiceAccountView[] }>;
    create(input: {
      readonly name: string;
      readonly permissions?: readonly string[];
      readonly grants?: readonly { readonly permission: string; readonly scope: Readonly<Record<string, unknown>> }[];
      readonly tenantId?: string;
      readonly expiresInDays?: number;
    }): Promise<{ readonly serviceAccount: ZelavisServiceAccountView; readonly token: string; readonly session: Readonly<Record<string, unknown>> }>;
    rotateToken(accountId: string, input?: { readonly expiresInDays?: number }): Promise<{ readonly token: string; readonly session: Readonly<Record<string, unknown>> }>;
    setTenant(accountId: string, tenantId: string): Promise<{ readonly serviceAccount: ZelavisServiceAccountView }>;
    revoke(accountId: string): Promise<void>;
  };
}

export interface ZelavisServiceAccountView extends ZelavisAuthAccountView {
  readonly metadata?: Readonly<Record<string, unknown>>;
}

function segment(value: string, what: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`A ${what} is required.`);
  const encoded = encodeURIComponent(value);
  if (encoded === "." || encoded === "..") throw new TypeError(`Invalid ${what}.`);
  return encoded;
}

const query = (input: Readonly<Record<string, string | number | undefined>> | undefined): string => {
  const entries = Object.entries(input ?? {}).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)] as [string, string]]));
  return entries.length === 0 ? "" : `?${new URLSearchParams(entries)}`;
};

/** A role deletion's catalogue revision; the route refuses one that is not a natural number. */
export const revisionQuery = (expectedRevision: number): string => `?${new URLSearchParams({ revision: String(expectedRevision) })}`;

export const invitationPageQuery = (options?: InvitationListOptions): string =>
  query({ limit: options?.limit, after: options?.after });

export function createAuthClient(json: Json): ZelavisAuthClient {
  const post = <T>(path: string, body: RequestBody = {}) => json<T>(`/auth/${path}`, { method: "POST", body });
  const get = <T>(path: string) => json<T>(`/auth/${path}`);
  const put = <T>(path: string, body: RequestBody) => json<T>(`/auth/${path}`, { method: "PUT", body });
  const remove = <T>(path: string, body?: RequestBody) => json<T>(`/auth/${path}`, { method: "DELETE", ...(body === undefined ? {} : { body }) });
  return {
    acceptInvitation: (input) => post("invitations/accept", input),
    usernamePassword: {
      signUp: (input) => post("username-password/sign-up", input),
      signIn: (input) => post("username-password/sign-in", input),
      changePassword: (input) => post("username-password/change-password", input),
    },
    emailPassword: {
      signUp: (input) => post("email-password/sign-up", input),
      completeSignUp: (input) => post("email-password/complete-sign-up", input),
      signIn: (input) => post("email-password/sign-in", input),
      changePassword: (input) => post("email-password/change-password", input),
      startChangeEmail: (input) => post("email-password/change-email/start", input),
      completeChangeEmail: (input) => post("email-password/change-email/complete", input),
      startRecovery: (input) => post("email-password/recovery/start", input),
      checkRecovery: (input) => post("email-password/recovery/check", input),
      completeRecovery: (input) => post("email-password/recovery/complete", input),
    },
    usernamePasskey: {
      startSignUp: (input) => post("username-passkey/sign-up/start", input),
      finishSignUp: (input) => post("username-passkey/sign-up/finish", input),
      startSignIn: (input) => post("username-passkey/sign-in/start", input),
      startAutofill: (input) => post("username-passkey/sign-in/autofill", input),
      finishSignIn: (input) => post("username-passkey/sign-in/finish", input),
    },
    passkeys: {
      list: () => get("passkeys"),
      startAdd: (input) => post("passkeys/add/start", input),
      verifyAdd: (input) => post("passkeys/add/verify", input),
      finishAdd: (input) => post("passkeys/add/finish", input),
      rename: (passkeyId, input) => json(`/auth/passkeys/${segment(passkeyId, "passkey id")}`, { method: "PATCH", body: input }),
      startRemove: (passkeyId, input) => post(`passkeys/${segment(passkeyId, "passkey id")}/remove/start`, input),
      finishRemove: (passkeyId, input) => post(`passkeys/${segment(passkeyId, "passkey id")}/remove/finish`, input),
      settings: () => get("passkeys/settings"),
      setSettings: (input) => put("passkeys/settings", input),
    },
    oauth: {
      providers: () => get("oauth/providers"),
      start: (provider, input) => post(`oauth/${segment(provider, "provider")}/start`, input),
      redeem: (provider, input) => post(`oauth/${segment(provider, "provider")}/redeem`, input),
      connections: () => get("oauth/connections"),
      configure: (provider, input) => put(`oauth/connections/${segment(provider, "provider")}`, input),
      remove: (provider) => remove(`oauth/connections/${segment(provider, "provider")}`),
    },
    mfa: {
      status: () => get("mfa"),
      startTotp: (input) => post("mfa/totp", input),
      confirmTotp: (input) => post("mfa/totp/confirm", input),
      verify: (input) => post("mfa/verify", input),
      removeTotp: (totpId, input) => remove(`mfa/totp/${segment(totpId, "authenticator id")}`, input),
      regenerateBackupCodes: (input) => post("mfa/backup-codes", input),
      policy: () => get("mfa/policy"),
      setPolicy: (input) => put("mfa/policy", input),
    },
    emails: {
      list: () => get("emails"),
      startAdd: (input) => post("emails/add/start", input),
      completeAdd: (input) => post("emails/add/complete", input),
    },
    session: {
      current: () => get("session"),
      refresh: (input) => post("session/refresh", input ?? {}),
      signOut: (input) => remove("session", input),
    },
    sessions: {
      list: () => get("sessions"),
      revoke: (sessionId) => remove(`sessions/${segment(sessionId, "session id")}`),
      revokeOthers: () => post("sessions/revoke-others"),
    },
    keys: {
      jwks: () => get("jwks"),
      rotate: () => post("keys/rotate"),
    },
    methods: {
      list: () => get("methods"),
      settings: () => get("methods/settings"),
      setSettings: (input) => put("methods/settings", input),
    },
    registration: {
      status: () => get("registration"),
      settings: () => get("registration/settings"),
      setSettings: (input) => put("registration/settings", input),
    },
    bootstrap: {
      status: () => get("bootstrap"),
      claim: (input) => post("bootstrap", input),
    },
    admin: {
      invitations: (options) => get(`invitations${invitationPageQuery(options)}`),
      invite: (input) => post("invitations", input),
      resendInvitation: (id) => post(`invitations/${segment(id, "invitation id")}/resend`),
      revokeInvitation: (id) => remove(`invitations/${segment(id, "invitation id")}`),
      accounts: (input) => get(`accounts${query(input)}`),
      createAccount: (input) => post("accounts", input),
      setAccess: (accountId, input) => put(`accounts/${segment(accountId, "account id")}/access`, input),
      roles: () => get("roles"),
      createRole: (input) => post("roles", input),
      updateRole: (roleId, input) => put(`roles/${segment(roleId, "role id")}`, input),
      deleteRole: (roleId, expectedRevision) => remove(`roles/${segment(roleId, "role id")}${revisionQuery(expectedRevision)}`),
      importAccounts: (input) => post("accounts/import", input),
      accountSessions: (accountId) => get(`accounts/${segment(accountId, "account id")}/sessions`),
      revokeAccountSession: (accountId, sessionId) => remove(`accounts/${segment(accountId, "account id")}/sessions/${segment(sessionId, "session id")}`),
      revokeAccountSessions: (accountId) => remove(`accounts/${segment(accountId, "account id")}/sessions`),
      resetMfa: (accountId) => remove(`accounts/${segment(accountId, "account id")}/mfa`),
      securityEvents: (input) => get(`security/events${query(input)}`),
    },
    serviceAccounts: {
      list: () => get("service-accounts"),
      create: (input) => post("service-accounts", input),
      rotateToken: (accountId, input) => post(`service-accounts/${segment(accountId, "account id")}/token`, input ?? {}),
      setTenant: (accountId, tenantId) => json(`/auth/service-accounts/${segment(accountId, "account id")}`, { method: "PATCH", body: { tenantId } }),
      revoke: (accountId) => remove(`service-accounts/${segment(accountId, "account id")}`),
    },
  };
}
