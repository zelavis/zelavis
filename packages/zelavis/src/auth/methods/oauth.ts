// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/methods/oauth/server.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: one setup binds every provider (Google, Apple, GitHub and the OpenID Connect connections) and resolves each one's credentials from its connection when a request arrives, instead of one `setupOauth` call per provider with a component instance; the functions are Effects over transactions (T1-T4); a signed-in caller can link a provider account (Zelavis-own); the user callbacks are options (as in the other methods).
/**
 * The OAuth sign-in methods: Google, Apple, GitHub, and any OpenID Connect
 * issuer connected by its URL.
 *
 * The flow:
 *
 * 1. `startSignIn` (here): validate, mint `state`, record an authorization
 *    request, and return the provider authorization URL for the client to
 *    navigate to plus the state it must hold onto.
 * 2. The provider sends the callback to the runtime's callback route
 *    (`<api>/auth/oauth/<provider>/callback`), which claims the request,
 *    exchanges the code, and mints a one-time ticket.
 * 3. `completeSignIn` (here): the client presents the one-time code from the
 *    callback redirect plus its original state, and gets back the session
 *    token bundle. A signed-in caller presents the same two to `linkAccount`
 *    and connects the provider account to their own account instead.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ZelavisRouteContext, ZelavisRouteResponse } from "../../core/index.js";
import { accountsModule } from "../accounts/accounts.js";
import { appleCallback } from "../apple/http.js";
import { appleAccounts } from "../apple/provider.js";
import { CALLBACK_METHOD, AUTHORIZATION_ENDPOINT as APPLE_AUTHORIZATION_ENDPOINT, SCOPES as APPLE_SCOPES } from "../apple/constants.js";
import type { AuthCall } from "../core/context.js";
import type { AuthFailure } from "../core/errors.js";
import type { RegistrationRefused } from "../registration/errors.js";
import type { AuthCore, BoundMethod } from "../core/setup.js";
import { getAuthUserId } from "../core/userId.js";
import { githubCallback } from "../github/http.js";
import { githubAccounts } from "../github/provider.js";
import { AUTHORIZATION_ENDPOINT as GITHUB_AUTHORIZATION_ENDPOINT, SCOPES as GITHUB_SCOPES } from "../github/constants.js";
import { googleCallback } from "../google/http.js";
import { googleAccounts } from "../google/provider.js";
import { AUTHORIZATION_ENDPOINT as GOOGLE_AUTHORIZATION_ENDPOINT, SCOPES as GOOGLE_SCOPES } from "../google/constants.js";
import { buildStartSignIn, startSignInResult } from "../lib/oauth/authorize.js";
import { type ClaimedRequest, type OAuthFetch } from "../lib/oauth/callback.js";
import { claimAuthorizationRequest, insertAccount, insertTicket, type AccountStore } from "../lib/oauth/dbHelpers.js";
import { type CallbackProvider, serveCallback } from "../lib/oauth/http.js";
import {
  buildCompleteSignIn,
  completeSignInResult,
  parseUrl,
  redeemTicket,
  type OidcClaims,
  type TicketPayload,
  validateAllowedRedirectOrigins,
} from "../lib/oauth/redemption.js";
import { SignInError, type CreateUserFn, type OnSignInFn } from "../lib/types.js";
import { oauthAccounts } from "../oauth/provider.js";
import { type OAuthConnections, type VersionedOAuthConnection, canSignIn, createConnections, isBuiltInProvider, validProviderName } from "../oauth/connections.js";
import type { OAuthProviderDefinition } from "../oauth/plugins.js";
import { type AuthRuntime, NO_REQUEST, authRequest } from "../runtime/index.js";
import { recordSecurityEvent } from "../security/events.js";
import { type AppleProfile, normalizeAppleProfile } from "./apple.js";
import { type GithubProfile, type GithubUserInfo, normalizeGithubProfile } from "./github.js";
import { type GoogleProfile, normalizeGoogleProfile } from "./google.js";

export type { OidcClaims };

/** The shape every provider's profile has at least: the provider's own id for the account. */
export type OAuthProfile = { readonly id: string } & Readonly<Record<string, unknown>>;

/** The account profile of an OpenID Connect connection: what its validated id_token attests. */
export const OidcProfile = Schema.Struct({
  /** The issuer's `sub` claim, the stable provider account id. */
  id: Schema.String,
  email: Schema.optional(Schema.String),
  emailVerified: Schema.Boolean,
  name: Schema.optional(Schema.String),
  picture: Schema.optional(Schema.String),
});
export type OidcProfile = typeof OidcProfile.Type;

/** Map validated id_token claims to {@link OidcProfile}. An OpenID Connect issuer returns an id_token, so a missing one is a bug. */
export function normalizeOidcProfile(claims: OidcClaims | undefined): OidcProfile {
  if (claims === undefined) {
    throw new Error("The issuer returned no id_token to build a profile from");
  }
  return {
    id: claims.sub,
    email: typeof claims.email === "string" ? claims.email : undefined,
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
    name: typeof claims.name === "string" ? claims.name : undefined,
    picture: typeof claims.picture === "string" ? claims.picture : undefined,
  };
}

/** Options for {@link setupOAuth}. */
export type OAuthOptions = {
  /** The module runtime: the flow and the connections live in its Auth partition. */
  readonly runtime: AuthRuntime;
  /** Seals the connections' client secrets. */
  readonly masterSecret: string;
  /**
   * Origins `redirectTo` may point at, beside the origin of each connection's
   * registered callback URL, which is always a public origin of this runtime
   * (for example the Platform's configured hostname, or an App's verified
   * hostnames). A function is read at each start.
   */
  readonly allowedRedirectOrigins?: ReadonlyArray<string> | (() => ReadonlyArray<string>);
  readonly fetch?: OAuthFetch | undefined;
  readonly clock?: (() => number) | undefined;
  /** Where `ZELAVIS_AUTH_<PROVIDER>_*` bootstrap values are read from; none by default. */
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined;
  readonly providers?: ReadonlyMap<string, OAuthProviderDefinition> | undefined;
  /** The user callbacks of these methods (see {@link CreateUserFn}); the accounts module's by default. */
  readonly createUser?: CreateUserFn<unknown>;
  readonly onSignIn?: OnSignInFn<unknown>;
};

const providerErrors = Schema.Union([
  SignInError(Schema.Struct({ error: Schema.Literal("UNKNOWN_PROVIDER") })),
]);

export const startResult = Schema.Union([startSignInResult, providerErrors]);
/** The result of `startSignIn`: where to send the browser and the state the client keeps, or a user error. */
export type StartResult = typeof startResult.Type;

export const signInResult = Schema.Union([completeSignInResult, providerErrors]);
/** The result of `completeSignIn`: the session token bundle, or a user error. */
export type SignInResult = typeof signInResult.Type;

export const linkResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("linked") }),
  SignInError(
    Schema.Union([
      Schema.Struct({ error: Schema.Literal("NOT_LOGGED_IN") }),
      Schema.Struct({ error: Schema.Literal("INVALID_CODE") }),
      Schema.Struct({ error: Schema.Literal("PROVIDER_ACCOUNT_IN_USE") }),
      Schema.Struct({ error: Schema.Literal("UNKNOWN_PROVIDER") }),
    ]),
  ),
]);
/** The result of `linkAccount`. */
export type LinkResult = typeof linkResult.Type;

/** A provider a request resolved to: its definition and its connection's credentials. */
interface ResolvedProvider {
  readonly name: string;
  readonly title: string;
  /** The module that authenticates the session: `google`, `apple`, `github` or `oauth`. */
  readonly module: "google" | "apple" | "github" | "oauth";
  readonly connection: VersionedOAuthConnection;
  readonly authorizationEndpoint: string;
  readonly scopes: ReadonlyArray<string>;
  readonly callbackMethod?: "GET" | "POST";
  /** Whether the provider returns an id_token, which then has to echo the nonce minted at the start. */
  readonly idToken: boolean;
  readonly accounts: AccountStore;
  readonly callback: CallbackProvider<ClaimedRequest & { providerName: string }>;
  readonly profile: (payload: TicketPayload) => OAuthProfile;
}

const unique = (scopes: ReadonlyArray<string>) => [...new Set(scopes)];

/**
 * Set up OAuth sign-in against the connected identity providers.
 *
 * Every function is a few transactions around the network calls, which never
 * run inside one.
 */
export function setupOAuth(core: AuthCore, options: OAuthOptions) {
  const clock = options.clock ?? Date.now;
  const fetchImpl: OAuthFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const environment = options.environment ?? {};
  const connections: OAuthConnections = createConnections({ runtime: options.runtime, masterSecret: options.masterSecret, fetch: fetchImpl, clock, environment, providers: options.providers });

  // Validate the runtime-supplied origins up front so a mistake fails at start, not on the first sign-in.
  const configured = options.allowedRedirectOrigins ?? [];
  const staticOrigins = typeof configured === "function" ? undefined : validateAllowedRedirectOrigins(configured);
  const configuredOrigins = (): ReadonlyArray<string> =>
    staticOrigins ?? (configured as () => ReadonlyArray<string>)().flatMap((origin) => parseUrl(origin)?.origin ?? []);

  // One bound method per module (an OpenID Connect connection is bound under `oauth:<name>`), created on first use.
  const bound = new Map<string, BoundMethod<OAuthProfile>>();
  const methodNameOf = (provider: string) => isBuiltInProvider(provider) ? provider : `oauth:${provider}`;
  const boundFor = (provider: string) => {
    const name = methodNameOf(provider);
    const existing = bound.get(name);
    if (existing !== undefined) return existing;
    const method = core.bindMethod<OAuthProfile>({
      name,
      pendingProviderIsCurrent: (tx, revision) => connections.isCurrent(tx, provider, revision),
      createUser: (options.createUser ?? accountsModule.createUser) as CreateUserFn<OAuthProfile>,
      ...("onSignIn" in options
        ? options.onSignIn === undefined ? {} : { onSignIn: options.onSignIn as OnSignInFn<OAuthProfile> }
        : { onSignIn: accountsModule.onSignIn as OnSignInFn<OAuthProfile> }),
    });
    bound.set(name, method);
    return method;
  };

  // A persisted MFA proof can be the first use of this provider in a replacement engine.
  const bindPendingMethod = (method: string): void => {
    const provider = method.startsWith("oauth:") ? method.slice("oauth:".length) : method;
    if (validProviderName(provider) && methodNameOf(provider) === method) boundFor(provider);
  };

  const resolve = Effect.fn("auth.methods.oauth.resolve")(function* (name: string): Effect.fn.Return<ResolvedProvider | undefined, AuthFailure> {
    const read = yield* connections.read(name);
    if (!canSignIn(read)) return undefined;
    const clientId = read.clientId;
    const clientSecret = read.clientSecret;
    const extra = read.scopes ?? [];
    switch (name) {
      case "google":
        return {
          name, title: "Google", module: "google", connection: read, authorizationEndpoint: GOOGLE_AUTHORIZATION_ENDPOINT,
          scopes: unique([...GOOGLE_SCOPES, ...extra]), idToken: true, accounts: googleAccounts,
          callback: googleCallback({ clientId, clientSecret }),
          profile: (payload) => normalizeGoogleProfile(payload.claims) satisfies GoogleProfile,
        };
      case "apple":
        if (read.teamId === undefined || read.keyId === undefined) return undefined;
        return {
          name, title: "Apple", module: "apple", connection: read, authorizationEndpoint: APPLE_AUTHORIZATION_ENDPOINT,
          scopes: unique([...APPLE_SCOPES, ...extra]), callbackMethod: CALLBACK_METHOD, idToken: true, accounts: appleAccounts,
          callback: appleCallback({ clientId, privateKey: clientSecret, teamId: read.teamId, keyId: read.keyId }, clock),
          profile: (payload) => {
            if (payload.claims === undefined) {
              throw new Error("Apple returned no id_token to build a profile from");
            }
            const user = payload.callbackParams?.user as { name: { firstName?: string; lastName?: string } } | undefined;
            return normalizeAppleProfile(payload.claims, user) satisfies AppleProfile;
          },
        };
      case "github":
        return {
          name, title: "GitHub", module: "github", connection: read, authorizationEndpoint: GITHUB_AUTHORIZATION_ENDPOINT,
          scopes: unique([...GITHUB_SCOPES, ...extra]), idToken: false, accounts: githubAccounts,
          callback: githubCallback({ clientId, clientSecret }),
          profile: (payload) => normalizeGithubProfile(payload.userInfoResponses as GithubUserInfo | undefined) satisfies GithubProfile,
        };
      default: {
        // Any other name is an OpenID Connect issuer, which describes itself.
        const connection = yield* connections.refreshed(read);
        const discovered = connection.discovered;
        if (connection.issuer === undefined || discovered === undefined) return undefined;
        return {
          name, title: options.providers?.get(name)?.title ?? name, module: "oauth", connection, authorizationEndpoint: discovered.authorizationEndpoint,
          // `openid` is what makes the issuer return the id_token the identity is read from.
          scopes: unique(["openid", ...(connection.scopes ?? ["email", "profile"])]), idToken: true, accounts: oauthAccounts(discovered.issuer),
          callback: {
            methods: ["GET", "POST"],
            exchangeConfig: () => Effect.succeed({
              providerName: name,
              tokenEndpoint: discovered.tokenEndpoint,
              clientId,
              clientSecret: () => Effect.succeed(clientSecret),
              issuers: [discovered.issuer],
              verification: { jwksUrl: discovered.jwksUrl, ...(discovered.algorithms === undefined ? {} : { algorithms: discovered.algorithms }) },
            }),
          },
          profile: (payload) => normalizeOidcProfile(payload.claims),
        };
      }
    }
  });

  const unknownProvider = { status: "error", userError: { error: "UNKNOWN_PROVIDER" } } as const;

  /**
   * Start a sign-in with a provider: where to send the browser, and the state
   * the client keeps until it redeems the ticket.
   */
  const startSignIn = Effect.fn("auth.methods.oauth.startSignIn")(function* (call: AuthCall, args: { provider: string; redirectTo: string }): Effect.fn.Return<StartResult, AuthFailure> {
    const provider = yield* resolve(args.provider);
    if (provider === undefined) return unknownProvider;
    // The origin of the registered callback is a public origin of this runtime, beside the ones it was given.
    const allowed = () => [...configuredOrigins(), new URL(provider.connection.redirectUri).origin];
    return yield* buildStartSignIn({
      providerName: provider.name,
      connectionRevision: provider.connection.revision,
      allowedOrigins: allowed,
      authorizationEndpoint: provider.authorizationEndpoint,
      scopes: provider.scopes,
      callbackMethod: provider.callbackMethod,
      clientId: provider.connection.clientId,
      callbackUrl: provider.connection.redirectUri,
      idToken: provider.idToken,
      runtime: options.runtime,
    })(call, { redirectTo: args.redirectTo });
  });

  /**
   * Complete an OAuth sign-in by redeeming the one-time `code` from the
   * callback redirect together with the state held since `startSignIn`.
   */
  const completeSignIn = Effect.fn("auth.methods.oauth.completeSignIn")(function* (call: AuthCall, args: { provider: string; code: string; state: string }): Effect.fn.Return<SignInResult, AuthFailure | RegistrationRefused> {
    const provider = yield* resolve(args.provider);
    if (provider === undefined) return unknownProvider;
    return yield* buildCompleteSignIn<OAuthProfile, TicketPayload>({
      providerName: provider.name,
      connectionRevision: provider.connection.revision,
      isCurrent: (tx) => connections.isCurrent(tx, provider.name, provider.connection.revision),
      bound: boundFor(provider.name),
      authenticatedBy: provider.module,
      accounts: provider.accounts,
      profile: provider.profile,
    })(call, { code: args.code, state: args.state });
  });

  /**
   * Connect a provider account to the signed-in caller's account. Never
   * creates a session, and never connects an account that already belongs to
   * another user.
   */
  const linkAccount = Effect.fn("auth.methods.oauth.linkAccount")(function* (call: AuthCall, args: { provider: string; code: string; state: string }): Effect.fn.Return<LinkResult, AuthFailure> {
    const provider = yield* resolve(args.provider);
    if (provider === undefined) return unknownProvider;
    return yield* boundFor(provider.name).mutation(call, (tx) =>
      Effect.gen(function* (): Effect.fn.Return<LinkResult, AuthFailure> {
        // A stolen ticket must not be spent on a session that is gone.
        const userId = yield* getAuthUserId(tx);
        if (userId === null) return { status: "error", userError: { error: "NOT_LOGGED_IN" } };
        const revision = provider.connection.revision;
        if (!(yield* connections.isCurrent(tx, provider.name, revision))) return { status: "error", userError: { error: "INVALID_CODE" } };
        const payload = yield* redeemTicket<TicketPayload>(tx, { providerName: provider.name, connectionRevision: revision, code: args.code, state: args.state });
        if (payload === null) return { status: "error", userError: { error: "INVALID_CODE" } };
        const profile = provider.profile(payload);
        if (typeof profile.id !== "string" || profile.id === "") {
          return yield* Effect.die(new Error(`Profile mapping for provider "${provider.name}" returned no id`));
        }
        const existing = yield* provider.accounts.findUserId(tx, profile.id);
        if (existing !== null && existing !== userId) return { status: "error", userError: { error: "PROVIDER_ACCOUNT_IN_USE" } };
        if (existing === null) yield* insertAccount(tx, provider.accounts, { providerAccountId: profile.id, userId });
        return { status: "linked" };
      }),
    );
  });

  const plain = (status: number, message: string): ZelavisRouteResponse => ({
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", allow: "GET, POST" },
    body: message,
  });

  /**
   * Serve the callback of a provider: the redirect (or, for Apple, the form
   * post) the provider sends the browser back with. Every outcome is a
   * redirect to the app's `redirectTo`, or a short plain answer when the flow
   * cannot be found.
   */
  const callback = Effect.fn("auth.methods.oauth.callback")(function* (context: ZelavisRouteContext, name: string): Effect.fn.Return<ZelavisRouteResponse, AuthFailure | RegistrationRefused> {
    const provider = yield* resolve(name);
    const method = context.request.method === "POST" ? "POST" : "GET";
    if (!(provider?.callback.methods ?? ["GET"]).includes(method)) {
      return plain(405, "This sign-in link is invalid. Return to the app and try signing in again.");
    }
    type Request = ClaimedRequest & { providerName: string; connectionRevision: string };
    return yield* serveCallback<Request>({
      context,
      provider: {
        ...(provider?.callback.methods === undefined ? {} : { methods: provider.callback.methods }),
        // A request of another provider must not be exchanged with this one's credentials.
        exchangeConfig: (request) => provider !== undefined && request.providerName === name
          && request.connectionRevision === provider.connection.revision
          ? provider.callback.exchangeConfig(request) : Effect.succeed(undefined),
        ...(provider?.callback.sanitizeParams === undefined ? {} : { sanitizeParams: provider.callback.sanitizeParams }),
        ...(provider?.callback.extraDeniedErrorCodes === undefined ? {} : { extraDeniedErrorCodes: provider.callback.extraDeniedErrorCodes }),
      },
      claim: (stateHash) =>
        options.runtime.mutation(NO_REQUEST, (tx) => Effect.gen(function* () {
          const claimed = yield* claimAuthorizationRequest(tx, stateHash);
          if (claimed === null || claimed.expired || provider === undefined) return claimed;
          const current = yield* connections.isCurrent(tx, name, provider.connection.revision);
          return current ? claimed : null;
        })).pipe(
          Effect.map((claimed) =>
            claimed === null || claimed.expired
              ? claimed
              : ({
                  expired: false,
                  providerName: claimed.doc.providerName,
                  connectionRevision: claimed.doc.connectionRevision,
                  stateHash: claimed.doc.stateHash,
                  redirectTo: claimed.doc.redirectTo,
                  callbackUrl: claimed.doc.callbackUrl,
                  codeVerifier: claimed.doc.codeVerifier,
                  nonce: claimed.doc.nonce,
                } as const),
          ),
        ),
      mintTicket: (request, ticket) =>
        options.runtime.mutation(NO_REQUEST, (tx) => Effect.gen(function* () {
          if (!(yield* connections.isCurrent(tx, request.providerName, request.connectionRevision))) return false;
          yield* insertTicket(tx, { providerName: request.providerName, connectionRevision: request.connectionRevision, stateHash: request.stateHash, ...ticket });
          return true;
        })),
      recordFailure: () => options.runtime.mutation(authRequest(context.request), (tx) =>
        recordSecurityEvent(tx, { kind: "authentication.failed", detail: { method: `oauth:${name}`, stage: "callback" } })),
      fetch: fetchImpl,
      clock,
    });
  });

  return { providers: connections.offered, startSignIn, completeSignIn, linkAccount, callback, connections, bindPendingMethod };
}

/** The OAuth methods as the runtime composes them. */
export type OAuthMethod = ReturnType<typeof setupOAuth>;
