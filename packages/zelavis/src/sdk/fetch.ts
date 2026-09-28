import type { IdentityApi } from "../app/identity/index.js";
import { stringifyJsonRequest } from "../core/runtime/json-request.js";
import type { ServiceSourceDiagnostic } from "../platform/service-registry-view.js";
import type {
  ZelavisProjectLogEntry,
  ZelavisProjectRecord,
} from "../project.js";
import type { ZelavisProjectIsolationIntent } from "../project-isolation.js";
import type {
  ZelavisEdgeAdapterStatus,
  ZelavisEdgeCertificateSummary,
  ZelavisEdgeCompiledPublication,
  ZelavisEdgeHostname,
  ZelavisEdgePolicy,
  ZelavisEdgePublication,
  ZelavisEdgeRoute,
  ZelavisEdgeSwitchPlan,
  ZelavisEdgeSwitchRecord,
} from "../edge/index.js";
import type {
  ZelavisHostOperationCatalogEntry,
  ZelavisHostOperationRecord,
  ZelavisHostOperationSubmitInput,
} from "../platform/host-operations.js";
import type {
  ZelavisEnvironmentHealth,
  ZelavisEnvironmentIdentity,
  ZelavisEnvironmentEventPage,
  ZelavisEnvironmentEventReadOptions,
  ZelavisEnvironmentOperationInput,
  ZelavisEnvironmentOperationResult,
  ZelavisEnvironmentProcess,
  ZelavisEnvironmentProcessInput,
  ZelavisEnvironmentSession,
  ZelavisEnvironmentSessionInput,
  ZelavisEnvironmentSessionUpdate,
  ZelavisEnvironmentUsageInput,
  ZelavisEnvironmentUsageRecord,
} from "../platform/remote-environment.js";
import type {
  DatabaseRuntimeApi,
  JsonObject as DatabaseJsonObject,
} from "../db/index.js";
import {
  requireActivePluginContext,
  getActivePluginContext,
  type PluginExecutionContext,
  type ZelavisCommandDefinition,
  type PluginFrontendBehavior,
  type PluginSetupHandler,
} from "../core/service/context.js";
import type {
  ZelavisServerRoute,
  ZelavisAnyRuntimeServiceInput,
  ZelavisPrincipal,
  ZelavisPrincipalGrant,
} from "../core/runtime/contracts.js";
import { createPluginClients, validateOperationName, type RegisteredPluginClients, type PluginOperation } from "./plugins.js";
export type { PluginClients, PluginApiRegistry, RegisteredPluginClients, PluginOperation, PluginOperationOptions } from "./plugins.js";
import { createAPI, pluginsProxy, type CreateApiOptions, type PluginApiTree, type RegisteredPluginApis } from "./create-api.js";
export { createAPI, type CreateApiOptions, type PluginApiTree, type RegisteredPluginApis };
export type { PluginAuthoringApiRegistry, ZelavisCreateApiFunction, ZelavisMenuApi } from "./create-api.js";
import { isSandboxedServicePage, createServicePageFetch } from "./service-page.js";

export type { IdentityApi, DatabaseRuntimeApi, DatabaseJsonObject };
export {
  IdentityDomainError,
  IdentityNotFoundError,
  IdentityValidationError,
  identityService,
} from "../app/identity/index.js";
// The database is reached through `zelavis/db`, not re-exported here: its
// store is a host resource that opens files, and an SDK bundle a browser can
// load must not carry one.
export type {
  CollectionField,
  CollectionFieldEntry,
  CollectionSchema,
  CollectionSchemaSummary,
} from "../db/schema/index.js";

export type ZelavisSdkSurfaceTarget = "fetch" | "browser" | "node";
export type ZelavisSdkRuntimeName = "node" | "bun" | "deno";
export type ZelavisSdkServiceName =
  | "zelavis/app/identity"
  | "zelavis/db"
  | "zelavis/app/workloads"
  | "zelavis/runtime"
  | "@zelavis/ui";

export interface ZelavisSdkSurfaceManifest {
  readonly target: ZelavisSdkSurfaceTarget;
  readonly includes: {
    readonly contracts: true;
    readonly fetchClient: true;
    readonly localDatabaseCore: true;
    readonly services: readonly ZelavisSdkServiceName[];
  };
  readonly excludes: {
    readonly ui: true;
    readonly runtimes: readonly ZelavisSdkRuntimeName[];
    readonly services: readonly ZelavisSdkServiceName[];
  };
}

export interface ZelavisClientOptions {
  baseUrl?: string | URL;
  rootPath?: string;
  apiPrefix?: string;
  apiVersion?: string;
  fetch?: typeof fetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
}

export interface ZelavisClientRequestOptions extends Omit<RequestInit, "body"> {
  body?: BodyInit | object | null;
  headers?: HeadersInit;
}

export interface ZelavisRuntimeConfigResponse {
  pluginOperations?: readonly PluginOperation[];
  rootPath: string;
  api: {
    basePath: string;
    version: string;
  };
  runtime?: {
    engine?: string;
    availableEngines?: readonly string[];
  };
  [key: string]: unknown;
}

export interface ZelavisDashboardSettingsResponse {
  rootPath?: {
    current: string;
    desired: string;
    pending?: string | null;
    restartRequired: boolean;
  };
  runtimeEngine?: {
    current: string;
    desired: string;
    available: readonly string[];
  };
  [key: string]: unknown;
}

export interface ZelavisDashboardSettingsUpdate {
  rootPath?: string;
  theme?: "light" | "dark" | "auto";
  runtimeEngine?: "node" | "bun" | "deno";
  pageBuilderEnabled?: boolean;
  preferences?: Record<string, unknown>;
}

export interface ZelavisRuntimeAccessResponse {
  readonly mode: string;
  readonly label: string;
  readonly principal: {
    readonly id: string;
    readonly type: string;
    readonly roles?: readonly string[];
    readonly permissions?: readonly string[];
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
}

export interface ZelavisAuthAccount {
  readonly id: string;
  readonly email?: string;
  readonly username?: string;
  readonly displayName?: string;
  readonly verified: boolean;
  readonly roles?: readonly string[];
  readonly permissions?: readonly string[];
  readonly grants?: readonly ZelavisPrincipalGrant[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ZelavisAuthSession {
  readonly id: string;
  readonly accountId: string;
  readonly status: "active" | "revoked" | "expired";
  readonly expiresAt: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ZelavisAuthSessionResult {
  readonly account: ZelavisAuthAccount;
  readonly session?: {
    readonly token: string;
    readonly session: ZelavisAuthSession;
  };
}

export interface ZelavisOAuthConnection {
  readonly provider: string;
  readonly title?: string;
  readonly issuer?: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes?: readonly string[];
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly hasClientSecret: boolean;
  readonly updatedAt: string;
}

export interface ZelavisServiceAccountCreateInput {
  readonly name: string;
  readonly permissions?: readonly string[];
  readonly grants?: readonly ZelavisPrincipalGrant[];
  readonly expiresInDays?: number;
  /**
   * The App Tenant this account acts in.
   *
   * Omitted, the account is its own Tenant — a generated id no operator will
   * recognise, and one no second client can ever join. Name it when more than
   * one credential belongs to the same customer.
   */
  readonly tenantId?: string;
}

export interface ZelavisAuthClient {
  providers(): Promise<readonly string[]>;
  oauthProviders(): Promise<readonly string[]>;
  signUp(provider: string, input: { identifier: string; password?: string; displayName?: string; [key: string]: unknown }): Promise<ZelavisAuthSessionResult>;
  signUpWithPassword(input: { identifier: string; password: string; displayName?: string }): Promise<ZelavisAuthSessionResult>;
  signIn(provider: string, input: { identifier: string; password?: string; [key: string]: unknown }): Promise<ZelavisAuthSessionResult>;
  signInWithPassword(input: { identifier: string; password: string }): Promise<ZelavisAuthSessionResult>;
  signInWithOAuth(provider: string): Promise<{ readonly authorizationUrl: string; readonly expiresAt: string }>;
  linkIdentity(provider: string): Promise<{ readonly authorizationUrl: string; readonly expiresAt: string }>;
  getSession(): Promise<{ readonly principal: ZelavisPrincipal }>;
  refreshSession(): Promise<{ readonly token: string; readonly session: ZelavisAuthSession }>;
  signOut(): Promise<void>;
  readonly admin: {
    oauthConnections(): Promise<readonly ZelavisOAuthConnection[]>;
    configureOAuth(provider: string, input: {
      readonly issuer?: string;
      readonly clientId: string;
      readonly clientSecret?: string;
      readonly redirectUri: string;
      readonly scopes?: readonly string[];
      readonly enabled?: boolean;
    }): Promise<ZelavisOAuthConnection>;
    removeOAuth(provider: string): Promise<void>;
    serviceAccounts(): Promise<readonly ZelavisAuthAccount[]>;
    createServiceAccount(input: ZelavisServiceAccountCreateInput): Promise<{
      readonly serviceAccount: ZelavisAuthAccount;
      readonly token: string;
      readonly session: ZelavisAuthSession;
    }>;
    rotateServiceAccountToken(accountId: string, expiresInDays?: number): Promise<{
      readonly token: string;
      readonly session: ZelavisAuthSession;
    }>;
    /** Names the App Tenant an existing service account acts in. */
    setServiceAccountTenant(accountId: string, tenantId: string): Promise<ZelavisAuthAccount>;
    revokeServiceAccount(accountId: string): Promise<void>;
  };
}

export interface ZelavisClient {
  readonly plugins: RegisteredPluginClients;
  readonly baseUrl: URL;
  readonly rootPath: string;
  pluginOperations(): Promise<readonly PluginOperation[]>;
  request(
    path: string,
    options?: ZelavisClientRequestOptions,
  ): Promise<Response>;
  json<T = unknown>(
    path: string,
    options?: ZelavisClientRequestOptions,
  ): Promise<T>;
  /** Platform Projects, over `/runtime/projects`. Same contract as `zelavis projects`. */
  readonly projects: ZelavisProjectsClient;
  /**
   * App data in one App Project, as the caller's own Tenant.
   *
   * A function rather than an object because the Project is part of the
   * address: there is no ambient "current Project", and inventing one is how a
   * client ends up writing another App's records.
   */
  data(projectId: string): ZelavisDataClient;
  /** Release-signed host operations, over `/runtime/host-operations`. Same contract as `zelavis host-operations`. */
  readonly hostOperations: ZelavisHostOperationsClient;
  readonly environment: ZelavisEnvironmentClient;
  /** Proxy-neutral Edge management. Same contract as `zelavis edge`. */
  readonly edge: ZelavisEdgeClient;
  /** Accounts, login ceremonies, sessions, provider settings, and service clients. */
  readonly auth: ZelavisAuthClient;
  readonly runtime: {
    access(): Promise<ZelavisRuntimeAccessResponse>;
    serviceSources(): Promise<{ sources: readonly ServiceSourceDiagnostic[] }>;
    config(): Promise<ZelavisRuntimeConfigResponse>;
    settings(): Promise<ZelavisDashboardSettingsResponse>;
    updateSettings(
      update: ZelavisDashboardSettingsUpdate,
    ): Promise<ZelavisDashboardSettingsResponse>;
  };
}


/**
 * App data for one Zelavis App Project, as the caller's own Tenant.
 *
 * The Tenant is never a parameter here. It is resolved from the authenticated
 * principal and signed into the Gateway envelope, so a client can address only
 * its own records however it composes a request. Reaching this surface needs
 * `project.data.read`/`project.data.write` on the Project and no Platform
 * authority over it — the same contract as `zelavis data`.
 */
export interface ZelavisDataClient {
  readonly collections: {
    list(): Promise<readonly ZelavisDataCollection[]>;
    create(input: ZelavisDataCollectionCreateInput): Promise<ZelavisDataCollection>;
    exists(collection: string): Promise<boolean>;
    /**
     * Removes a collection and everything in it.
     *
     * Refused while another collection references this one. There is no undo:
     * the documents are gone, not archived.
     */
    drop(collection: string): Promise<boolean>;
  };
  readonly documents: {
    insert(collection: string, input: ZelavisDataInsertInput): Promise<ZelavisDataDocument>;
    get(collection: string, id: string): Promise<ZelavisDataDocument | undefined>;
    /** Documents matching a query, up to `limit`. */
    query(collection: string, input?: ZelavisDataQueryInput): Promise<readonly ZelavisDataDocument[]>;
    /** One page plus the cursor that continues it. */
    page(collection: string, input?: ZelavisDataPageInput): Promise<ZelavisDataPage>;
    update(collection: string, id: string, input: ZelavisDataUpdateInput): Promise<ZelavisDataDocument>;
    delete(collection: string, id: string, input?: ZelavisDataDeleteInput): Promise<boolean>;
    /** Several changes applied atomically, in the order given. */
    write(input: ZelavisDataWriteInput): Promise<readonly ZelavisDataWritten[]>;
  };
}

export interface ZelavisDataCollection {
  readonly name: string;
  readonly surface?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ZelavisDataCollectionCreateInput {
  readonly name: string;
  readonly surface?: "database" | "content";
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ZelavisDataDocument {
  readonly id: string;
  readonly collection: string;
  readonly version: number;
  readonly data: Readonly<Record<string, unknown>>;
}

/** A write that may be retried without being applied twice. */
export interface ZelavisDataIdempotent {
  readonly idempotencyKey?: string;
}

export interface ZelavisDataInsertInput extends ZelavisDataIdempotent {
  readonly id?: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface ZelavisDataQueryInput {
  readonly where?: readonly unknown[];
  readonly orderBy?: readonly unknown[];
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ZelavisDataPageInput extends Omit<ZelavisDataQueryInput, "offset"> {
  /** The `next` cursor from the previous page. */
  readonly after?: string;
}

export interface ZelavisDataPage {
  readonly documents: readonly ZelavisDataDocument[];
  /** Present only when another matching document follows. */
  readonly next?: string;
}

export interface ZelavisDataUpdateInput extends ZelavisDataIdempotent {
  readonly data: Readonly<Record<string, unknown>>;
  /** `merge` unless given. */
  readonly mode?: "merge" | "replace";
  /** Compare-and-set against the version last read. */
  readonly expectedVersion?: number;
  readonly precondition?: readonly unknown[];
}

export interface ZelavisDataDeleteInput extends ZelavisDataIdempotent {
  readonly expectedVersion?: number;
  readonly precondition?: readonly unknown[];
}

export interface ZelavisDataWriteInput extends ZelavisDataIdempotent {
  readonly operations: readonly ZelavisDataWriteOperation[];
}

export type ZelavisDataWriteOperation =
  | { readonly _tag: "Insert"; readonly collection: string; readonly id?: string; readonly data: Readonly<Record<string, unknown>> }
  | { readonly _tag: "Update"; readonly collection: string; readonly id: string; readonly data: Readonly<Record<string, unknown>>; readonly mode?: "merge" | "replace"; readonly expectedVersion?: number }
  | { readonly _tag: "Delete"; readonly collection: string; readonly id: string; readonly expectedVersion?: number };

export type ZelavisDataWritten =
  | { readonly _tag: "Inserted"; readonly document: ZelavisDataDocument }
  | { readonly _tag: "Updated"; readonly document: ZelavisDataDocument }
  | { readonly _tag: "Deleted"; readonly collection: string; readonly id: string };

export interface ZelavisProjectCreateInput {
  readonly name: string;
  readonly id?: string;
  readonly recipeName?: string;
  /** Defaults to true. */
  readonly start?: boolean;
}

export interface ZelavisProjectUpdateInput {
  readonly name: string;
}

export interface ZelavisProjectRecipeSummary {
  readonly name: string;
  readonly title: string;
  readonly summary?: string;
  readonly runtimeKinds: readonly string[];
  readonly isolation?: ZelavisProjectIsolationIntent;
  readonly [key: string]: unknown;
}

export interface ZelavisProjectListResponse {
  readonly runtime: Readonly<Record<string, unknown>>;
  readonly projects: readonly ZelavisProjectRecord[];
}

/**
 * Project lifecycle operations.
 *
 * Every method is one HTTP route; refusals arrive as `ZelavisClientHttpError`
 * with the route's status and body, including `code` and `isolation` when a
 * recipe's required isolation is not met (409).
 */
export interface ZelavisProjectsClient {
  list(): Promise<ZelavisProjectListResponse>;
  get(projectId: string): Promise<ZelavisProjectRecord>;
  create(input: ZelavisProjectCreateInput): Promise<ZelavisProjectRecord>;
  update(projectId: string, input: ZelavisProjectUpdateInput): Promise<ZelavisProjectRecord>;
  start(projectId: string): Promise<ZelavisProjectRecord>;
  stop(projectId: string): Promise<ZelavisProjectRecord>;
  restart(projectId: string): Promise<ZelavisProjectRecord>;
  logs(projectId: string): Promise<readonly ZelavisProjectLogEntry[]>;
  remove(projectId: string): Promise<{ readonly deleted: boolean }>;
  recipes(): Promise<readonly ZelavisProjectRecipeSummary[]>;
}

export interface ZelavisHostOperationsClient {
  /** Operations the caller may request somewhere. */
  catalog(): Promise<readonly ZelavisHostOperationCatalogEntry[]>;
  /** Issues authority and hands the request to the Agent; resolves once accepted. */
  submit(input: ZelavisHostOperationSubmitInput): Promise<ZelavisHostOperationRecord>;
  get(operationId: string): Promise<ZelavisHostOperationRecord>;
  /** Issuance records, newest first; needs the audit permission for the scope. */
  audit(query?: { readonly projectId?: string; readonly limit?: number }): Promise<readonly ZelavisHostOperationRecord[]>;
}

export interface ZelavisEnvironmentClient {
  identity(): Promise<ZelavisEnvironmentIdentity>;
  health(): Promise<ZelavisEnvironmentHealth>;
  createSession(input?: ZelavisEnvironmentSessionInput): Promise<ZelavisEnvironmentSession>;
  updateSession(sessionId: string, update: ZelavisEnvironmentSessionUpdate): Promise<ZelavisEnvironmentSession>;
  getSession(sessionId: string): Promise<ZelavisEnvironmentSession>;
  closeSession(sessionId: string): Promise<{ readonly closed: boolean }>;
  recordUsage(sessionId: string, input: ZelavisEnvironmentUsageInput): Promise<ZelavisEnvironmentUsageRecord>;
  startProcess(sessionId: string, input: ZelavisEnvironmentProcessInput): Promise<ZelavisEnvironmentProcess>;
  getProcess(processId: string): Promise<ZelavisEnvironmentProcess>;
  operateProcess(processId: string, input: ZelavisEnvironmentOperationInput): Promise<ZelavisEnvironmentOperationResult>;
  readEvents(sessionId: string, options?: ZelavisEnvironmentEventReadOptions): Promise<ZelavisEnvironmentEventPage>;
}

export interface ZelavisEdgeStatusResponse {
  readonly policy: ZelavisEdgePolicy;
  readonly adapters: readonly ZelavisEdgeAdapterStatus[];
  readonly activeSwitch?: ZelavisEdgeSwitchRecord;
}

export interface ZelavisEdgeSwitchInput {
  readonly adapterId: string;
  readonly publication: ZelavisEdgePublication;
}

export interface ZelavisEdgeRoutesResponse {
  readonly routes: readonly ZelavisEdgeRoute[];
  readonly hostnames: readonly ZelavisEdgeHostname[];
  readonly publication?: ZelavisEdgeCompiledPublication;
}

export interface ZelavisEdgePutRouteInput {
  readonly route: ZelavisEdgeRoute;
  readonly hostname?: ZelavisEdgeHostname;
}

export interface ZelavisEdgePutRouteResponse {
  readonly route: ZelavisEdgeRoute;
  readonly hostname?: ZelavisEdgeHostname;
}

export interface ZelavisEdgeRoutesFilter {
  readonly scope?: "platform" | "project";
  readonly projectId?: string;
  readonly hostname?: string;
}

export type ZelavisEdgeOnboardingMode = "managed" | "external" | "later";

export interface ZelavisEdgeOnboardingRequest {
  readonly mode: ZelavisEdgeOnboardingMode;
  readonly hostname?: string;
  readonly localTargetUrl?: string;
}

export interface ZelavisEdgeOnboardingPreflightResult {
  readonly hostname: string;
  readonly valid: boolean;
  readonly dnsResolved: boolean;
  readonly addresses?: readonly string[];
  readonly error?: string;
}

export interface ZelavisEdgeOnboardingResult {
  readonly mode: ZelavisEdgeOnboardingMode;
  readonly status: "configured" | "deferred" | "failed";
  readonly hostname?: string;
  readonly canonicalUrl?: string;
  readonly publication?: ZelavisEdgePublication;
  readonly error?: string;
}

export interface ZelavisEdgeCertificatesResponse {
  readonly certificates: readonly ZelavisEdgeCertificateSummary[];
}

export interface ZelavisEdgeRenewCertificatesInput {
  readonly hostname?: string;
  readonly renewIfWithinDays?: number;
}

export interface ZelavisEdgeRenewCertificatesResponse {
  readonly checked?: number;
  readonly renewed: readonly string[];
  readonly failed?: readonly { readonly ref: string; readonly error: string }[];
  readonly certificate?: ZelavisEdgeCertificateSummary;
}

export interface ZelavisEdgeClient {
  status(): Promise<ZelavisEdgeStatusResponse>;
  plan(input: ZelavisEdgeSwitchInput): Promise<ZelavisEdgeSwitchPlan>;
  switch(input: ZelavisEdgeSwitchInput): Promise<ZelavisEdgeSwitchRecord>;
  routes(filter?: ZelavisEdgeRoutesFilter): Promise<ZelavisEdgeRoutesResponse>;
  putRoute(
    input: ZelavisEdgePutRouteInput | ZelavisEdgeRoute,
  ): Promise<ZelavisEdgePutRouteResponse>;
  deleteRoute(routeId: string): Promise<boolean>;
  publish(): Promise<ZelavisEdgeCompiledPublication>;
  preflightHostname(
    hostname: string,
  ): Promise<ZelavisEdgeOnboardingPreflightResult>;
  onboardHostname(
    input: ZelavisEdgeOnboardingRequest,
  ): Promise<ZelavisEdgeOnboardingResult>;
  certificates(): Promise<ZelavisEdgeCertificatesResponse>;
  renewCertificates(
    input?: ZelavisEdgeRenewCertificatesInput,
  ): Promise<ZelavisEdgeRenewCertificatesResponse>;
}

export const fetchSdkSurface: ZelavisSdkSurfaceManifest = {
  target: "fetch",
  includes: {
    contracts: true,
    fetchClient: true,
    localDatabaseCore: true,
    services: ["zelavis/app/identity", "zelavis/db"],
  },
  excludes: {
    ui: true,
    runtimes: ["node", "bun", "deno"],
    services: ["zelavis/app/workloads", "zelavis/runtime", "@zelavis/ui"],
  },
};

export function createZelavisClient(
  options: ZelavisClientOptions = {},
): ZelavisClient {
  const sandboxed = isSandboxedServicePage();
  const resolvedFetch: typeof fetch =
    options.fetch ??
    (sandboxed
      ? createServicePageFetch()
      : typeof globalThis.fetch === "function"
        ? globalThis.fetch.bind(globalThis)
        : (undefined as unknown as typeof fetch));

  if (typeof resolvedFetch !== "function") {
    throw new TypeError(
      "createZelavisClient requires a fetch implementation for this environment.",
    );
  }

  const defaultBaseUrl =
    typeof location !== "undefined" && location.origin && location.origin !== "null"
      ? location.origin
      : "http://localhost";
  const baseUrl = new URL(options.baseUrl ?? defaultBaseUrl);
  const rootPath = normalizeRootPath(
    options.rootPath ?? (sandboxed ? "" : "/zelavis"),
  );
  const apiPrefix = normalizeRootPath(
    options.apiPrefix ?? (sandboxed ? "" : "/api"),
  );
  const apiVersion = options.apiVersion ?? (sandboxed ? "" : "v1");
  if (apiVersion && !/^[a-zA-Z0-9_-]+$/.test(apiVersion)) throw new TypeError("Invalid API version.");

  async function resolveHeaders(headers?: HeadersInit): Promise<Headers> {
    const resolved = new Headers(
      typeof options.headers === "function"
        ? await options.headers()
        : options.headers,
    );
    const next = new Headers(headers);
    next.forEach((value, key) => {
      resolved.set(key, value);
    });
    return resolved;
  }

  async function request(
    path: string,
    requestOptions: ZelavisClientRequestOptions = {},
  ): Promise<Response> {
    const { body, headers: requestHeaders, ...fetchOptions } = requestOptions;
    const headers = await resolveHeaders(requestHeaders);
    const init: RequestInit = {
      ...fetchOptions,
      headers,
    };

    if (body !== undefined && body !== null) {
      if (isBodyInit(body)) {
        init.body = body;
      } else {
        headers.set("content-type", "application/json");
        init.body = stringifyJsonRequest(body);
      }
    }

    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const prefix = [rootPath, apiPrefix, apiVersion ? `/${apiVersion}` : ""]
      .join("")
      .replace(/\/+/g, "/");
    const fullPath = `${prefix}${normalizedPath}`.replace(/\/+/g, "/");
    return resolvedFetch(new URL(fullPath, baseUrl), init);
  }

  async function json<T = unknown>(
    path: string,
    requestOptions?: ZelavisClientRequestOptions,
  ): Promise<T> {
    const response = await request(path, requestOptions);
    if (!response.ok) {
      const body = await response.clone().json().catch(() => undefined);
      throw new ZelavisClientHttpError(response, body);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  // The last catalogue and its ETag. Every discovery still asks the server,
  // so revocation is immediate; an unchanged catalogue answers 304 and is not
  // transferred again.
  let catalogue: { etag: string; operations: readonly PluginOperation[] } | undefined;
  async function discoverPluginOperations(): Promise<readonly PluginOperation[]> {
    const response = await request("/runtime/plugin-operations", {
      headers: catalogue ? { "if-none-match": catalogue.etag } : {},
    });
    if (response.status === 304 && catalogue) return catalogue.operations;
    if (!response.ok) {
      const body = await response.clone().json().catch(() => undefined);
      throw new ZelavisClientHttpError(response, body);
    }
    const body = await response.json() as { operations?: readonly PluginOperation[] };
    const operations = body.operations ?? [];
    const etag = response.headers.get("etag");
    catalogue = etag ? { etag, operations } : undefined;
    return operations;
  }

  return {
    plugins: createPluginClients(
      discoverPluginOperations,
      async (path, method, body) => json(path, { method, body: body as object | undefined }),
    ),
    pluginOperations: discoverPluginOperations,
    projects: createProjectsClient(json),
    data: (projectId) => createDataClient(json, projectId),
    auth: {
      providers: () => json<readonly string[]>("/auth/providers"),
      oauthProviders: () => json<readonly string[]>("/auth/oauth/providers"),
      signUp: (provider, input) =>
        json<ZelavisAuthSessionResult>(
          `/auth/sign-up/${encodeURIComponent(provider)}`,
          { method: "POST", body: input },
        ),
      signUpWithPassword: (input) =>
        json<ZelavisAuthSessionResult>("/auth/sign-up/password", {
          method: "POST",
          body: input,
        }),
      signIn: (provider, input) =>
        json<ZelavisAuthSessionResult>(
          `/auth/authenticate/${encodeURIComponent(provider)}`,
          { method: "POST", body: input },
        ),
      signInWithPassword: (input) =>
        json<ZelavisAuthSessionResult>("/auth/authenticate/password", {
          method: "POST",
          body: input,
        }),
      signInWithOAuth: (provider) =>
        json<{ readonly authorizationUrl: string; readonly expiresAt: string }>(
          `/auth/oauth/${encodeURIComponent(provider)}/start`,
          { method: "POST" },
        ),
      linkIdentity: (provider) =>
        json<{ readonly authorizationUrl: string; readonly expiresAt: string }>(
          `/auth/oauth/${encodeURIComponent(provider)}/link/start`,
          { method: "POST" },
        ),
      getSession: () =>
        json<{ readonly principal: ZelavisPrincipal }>("/auth/session"),
      refreshSession: () =>
        json<{ readonly token: string; readonly session: ZelavisAuthSession }>(
          "/auth/session/rotate",
          { method: "POST" },
        ),
      signOut: () => json<void>("/auth/session", { method: "DELETE" }),
      admin: {
        oauthConnections: async () =>
          (await json<{ readonly providers: readonly ZelavisOAuthConnection[] }>(
            "/auth/oauth/connections",
          )).providers,
        configureOAuth: async (provider, input) =>
          (await json<{ readonly connection: ZelavisOAuthConnection }>(
            `/auth/oauth/connections/${encodeURIComponent(provider)}`,
            { method: "PUT", body: input },
          )).connection,
        removeOAuth: (provider) =>
          json<void>(`/auth/oauth/connections/${encodeURIComponent(provider)}`, {
            method: "DELETE",
          }),
        serviceAccounts: async () =>
          (await json<{ readonly serviceAccounts: readonly ZelavisAuthAccount[] }>(
            "/auth/service-accounts",
          )).serviceAccounts,
        createServiceAccount: (input) =>
          json<{
            readonly serviceAccount: ZelavisAuthAccount;
            readonly token: string;
            readonly session: ZelavisAuthSession;
          }>("/auth/service-accounts", { method: "POST", body: input }),
        rotateServiceAccountToken: (accountId, expiresInDays) =>
          json<{ readonly token: string; readonly session: ZelavisAuthSession }>(
            `/auth/service-accounts/${encodeURIComponent(accountId)}/token`,
            {
              method: "POST",
              body: expiresInDays === undefined ? {} : { expiresInDays },
            },
          ),
        setServiceAccountTenant: async (accountId, tenantId) =>
          (await json<{ serviceAccount: ZelavisAuthAccount }>(
            `/auth/service-accounts/${encodeURIComponent(accountId)}`,
            { method: "PATCH", body: { tenantId } },
          )).serviceAccount,
        revokeServiceAccount: (accountId) =>
          json<void>(`/auth/service-accounts/${encodeURIComponent(accountId)}`, {
            method: "DELETE",
          }),
      },
    },
    edge: {
      status: () => json<ZelavisEdgeStatusResponse>("/runtime/edge"),
      plan: async (input) =>
        (await json<{ plan: ZelavisEdgeSwitchPlan }>("/runtime/edge/plan", {
          method: "POST",
          body: input,
        })).plan,
      switch: async (input) =>
        (await json<{ edgeSwitch: ZelavisEdgeSwitchRecord }>(
          "/runtime/edge/switch",
          { method: "POST", body: input },
        )).edgeSwitch,
      routes: async (filter = {}) => {
        const search = new URLSearchParams();
        if (filter.scope) search.set("scope", filter.scope);
        if (filter.projectId) search.set("projectId", filter.projectId);
        if (filter.hostname) search.set("hostname", filter.hostname);
        const suffix = search.size ? `?${search}` : "";
        return json<ZelavisEdgeRoutesResponse>(`/runtime/edge/routes${suffix}`);
      },
      putRoute: async (input) => {
        const body = "id" in input ? { route: input } : input;
        return json<ZelavisEdgePutRouteResponse>("/runtime/edge/routes", {
          method: "POST",
          body,
        });
      },
      deleteRoute: async (routeId) => {
        try {
          const response = await json<{ deleted?: boolean }>(
            `/runtime/edge/routes/${encodeURIComponent(routeId)}`,
            { method: "DELETE" },
          );
          return Boolean(response.deleted);
        } catch (error) {
          if (error instanceof ZelavisClientHttpError && error.status === 404) {
            return false;
          }
          throw error;
        }
      },
      publish: async () =>
        (await json<{ publication: ZelavisEdgeCompiledPublication }>(
          "/runtime/edge/publish",
          { method: "POST" },
        )).publication,
      preflightHostname: async (hostname) =>
        json<ZelavisEdgeOnboardingPreflightResult>(
          `/runtime/edge/onboard/preflight?hostname=${encodeURIComponent(hostname)}`,
        ),
      onboardHostname: async (input) =>
        json<ZelavisEdgeOnboardingResult>("/runtime/edge/onboard", {
          method: "POST",
          body: input,
        }),
      certificates: async () =>
        json<ZelavisEdgeCertificatesResponse>("/runtime/edge/certificates"),
      renewCertificates: async (input = {}) =>
        json<ZelavisEdgeRenewCertificatesResponse>(
          "/runtime/edge/certificates/renew",
          {
            method: "POST",
            body: input,
          },
        ),
    },
    hostOperations: {
      catalog: async () =>
        (await json<{ operations: readonly ZelavisHostOperationCatalogEntry[] }>("/runtime/host-operations")).operations,
      submit: async (input) =>
        (await json<{ operation: ZelavisHostOperationRecord }>("/runtime/host-operations", {
          method: "POST",
          body: input,
        })).operation,
      audit: async (query = {}) => {
        const search = new URLSearchParams();
        if (query.projectId !== undefined) search.set("projectId", query.projectId);
        if (query.limit !== undefined) search.set("limit", String(query.limit));
        const suffix = search.size ? `?${search}` : "";
        return (await json<{ records: readonly ZelavisHostOperationRecord[] }>(
          `/runtime/host-operations/audit${suffix}`,
        )).records;
      },
      get: async (operationId) => {
        if (typeof operationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) {
          throw new TypeError("Invalid host operation id.");
        }
        return (await json<{ operation: ZelavisHostOperationRecord }>(
          `/runtime/host-operations/${operationId}`,
        )).operation;
      },
    },
    environment: {
      identity: async () =>
        (await json<{ environment: ZelavisEnvironmentIdentity }>("/runtime/environment")).environment,
      health: () => json<ZelavisEnvironmentHealth>("/runtime/environment/health"),
      createSession: async (input = {}) =>
        (await json<{ session: ZelavisEnvironmentSession }>("/runtime/environment/sessions", {
          method: "POST",
          body: input,
        })).session,
      updateSession: async (sessionId, update) => {
        if (!sessionId || sessionId === "." || sessionId === "..") throw new TypeError("Invalid environment session id.");
        if (!Number.isSafeInteger(update.expectedVersion) || update.expectedVersion < 0) {
          throw new TypeError("Environment session expectedVersion must be a non-negative integer.");
        }
        return (await json<{ session: ZelavisEnvironmentSession }>(
          `/runtime/environment/sessions/${encodeURIComponent(sessionId)}`,
          { method: "PATCH", body: update },
        )).session;
      },
      getSession: async (sessionId) => {
        if (!sessionId || sessionId === "." || sessionId === "..") throw new TypeError("Invalid environment session id.");
        return (await json<{ session: ZelavisEnvironmentSession }>(
          `/runtime/environment/sessions/${encodeURIComponent(sessionId)}`,
        )).session;
      },
      closeSession: async (sessionId) => {
        if (!sessionId || sessionId === "." || sessionId === "..") throw new TypeError("Invalid environment session id.");
        return json<{ readonly closed: boolean }>(
          `/runtime/environment/sessions/${encodeURIComponent(sessionId)}`,
          { method: "DELETE" },
        );
      },
      recordUsage: async (sessionId, input) => {
        if (!sessionId || sessionId === "." || sessionId === "..") throw new TypeError("Invalid environment session id.");
        return (await json<{ usage: ZelavisEnvironmentUsageRecord }>(
          `/runtime/environment/sessions/${encodeURIComponent(sessionId)}/usage`,
          { method: "POST", body: input },
        )).usage;
      },
      startProcess: async (sessionId, input) => {
        if (!sessionId || sessionId === "." || sessionId === "..") throw new TypeError("Invalid environment session id.");
        return (await json<{ process: ZelavisEnvironmentProcess }>(
          `/runtime/environment/sessions/${encodeURIComponent(sessionId)}/processes`,
          { method: "POST", body: input },
        )).process;
      },
      getProcess: async (processId) => {
        if (!processId || processId === "." || processId === "..") throw new TypeError("Invalid environment process id.");
        return (await json<{ process: ZelavisEnvironmentProcess }>(
          `/runtime/environment/processes/${encodeURIComponent(processId)}`,
        )).process;
      },
      operateProcess: async (processId, input) => {
        if (!processId || processId === "." || processId === "..") throw new TypeError("Invalid environment process id.");
        return (await json<{ result: ZelavisEnvironmentOperationResult }>(
          `/runtime/environment/processes/${encodeURIComponent(processId)}/operations`,
          { method: "POST", body: input },
        )).result;
      },
      readEvents: async (sessionId, options = {}) => {
        if (!sessionId || sessionId === "." || sessionId === "..") throw new TypeError("Invalid environment session id.");
        const search = new URLSearchParams();
        if (options.after !== undefined) search.set("after", options.after);
        if (options.limit !== undefined) search.set("limit", String(options.limit));
        const suffix = search.size ? `?${search}` : "";
        return json<ZelavisEnvironmentEventPage>(
          `/runtime/environment/sessions/${encodeURIComponent(sessionId)}/events${suffix}`,
        );
      },
    },
    baseUrl,
    rootPath,
    request,
    json,
    runtime: {
      access() {
        return json<ZelavisRuntimeAccessResponse>("/runtime/access");
      },
      serviceSources() {
        return json<{ sources: readonly ServiceSourceDiagnostic[] }>("/runtime/services/sources");
      },
      config() {
        return json<ZelavisRuntimeConfigResponse>("/runtime/config");
      },
      settings() {
        return json<ZelavisDashboardSettingsResponse>("/runtime/settings");
      },
      updateSettings(update) {
        return json<ZelavisDashboardSettingsResponse>("/runtime/settings", {
          method: "PATCH",
          body: update,
        });
      },
    },
  };
}

function dataPath(projectId: string, path: string): string {
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw new TypeError("A Project id is required.");
  }
  const encoded = encodeURIComponent(projectId);
  if (encoded === "." || encoded === "..") throw new TypeError("Invalid Project id.");
  return `/runtime/projects/${encoded}/data/${path}`;
}

function dataName(value: string, what: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`A ${what} is required.`);
  }
  const encoded = encodeURIComponent(value);
  if (encoded === "." || encoded === "..") throw new TypeError(`Invalid ${what}.`);
  return encoded;
}

/**
 * The App data client for one Project.
 *
 * Every call is a path under that Project's data route, so the Platform
 * resolves the Tenant and the caller never sends one. Bodies are passed
 * through rather than reshaped: the query and write vocabulary is the
 * database's own, and a translation layer here would be a second dialect to
 * keep in step with it.
 */
function createDataClient(
  json: <T>(path: string, options?: ZelavisClientRequestOptions) => Promise<T>,
  projectId: string,
): ZelavisDataClient {
  const post = <T>(path: string, body: object) =>
    json<T>(dataPath(projectId, path), { method: "POST", body });
  return {
    collections: {
      list: async () =>
        (await json<{ collections: readonly ZelavisDataCollection[] }>(
          dataPath(projectId, "documents/collections"),
        )).collections,
      create: (input) => post<ZelavisDataCollection>("documents/collections", input),
      exists: async (collection) =>
        (await json<{ exists: boolean }>(
          dataPath(projectId, `documents/collections/${dataName(collection, "collection name")}/exists`),
        )).exists,
      drop: async (collection) =>
        (await json<{ dropped: boolean }>(
          dataPath(projectId, `documents/collections/${dataName(collection, "collection name")}`),
          { method: "DELETE", body: {} },
        )).dropped,
    },
    documents: {
      insert: (collection, input) =>
        post<ZelavisDataDocument>(`documents/${dataName(collection, "collection name")}`, input),
      get: async (collection, id) => {
        const path = dataPath(
          projectId,
          `documents/${dataName(collection, "collection name")}/${dataName(id, "document id")}`,
        );
        try {
          return await json<ZelavisDataDocument>(path);
        } catch (error) {
          // A document that is not there is an answer, not a failure: callers
          // read before writing and would otherwise wrap every read in a try.
          if (error instanceof ZelavisClientHttpError && error.status === 404) {
            return undefined;
          }
          throw error;
        }
      },
      query: async (collection, input = {}) =>
        (await post<{ documents: readonly ZelavisDataDocument[] }>(
          `documents/${dataName(collection, "collection name")}/query`,
          input,
        )).documents,
      page: (collection, input = {}) =>
        post<ZelavisDataPage>(`documents/${dataName(collection, "collection name")}/page`, input),
      update: (collection, id, input) =>
        json<ZelavisDataDocument>(
          dataPath(
            projectId,
            `documents/${dataName(collection, "collection name")}/${dataName(id, "document id")}`,
          ),
          { method: "PATCH", body: input },
        ),
      delete: async (collection, id, input = {}) =>
        (await json<{ deleted: boolean }>(
          dataPath(
            projectId,
            `documents/${dataName(collection, "collection name")}/${dataName(id, "document id")}`,
          ),
          { method: "DELETE", body: input },
        )).deleted,
      write: async (input) =>
        (await post<{ written: readonly ZelavisDataWritten[] }>("documents/write", input)).written,
    },
  };
}

function projectPath(projectId: string, action?: string): string {
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw new TypeError("A Project id is required.");
  }
  const encoded = encodeURIComponent(projectId);
  if (encoded === "." || encoded === "..") throw new TypeError("Invalid Project id.");
  return `/runtime/projects/${encoded}${action ? `/${action}` : ""}`;
}

function createProjectsClient(
  json: <T>(path: string, options?: ZelavisClientRequestOptions) => Promise<T>,
): ZelavisProjectsClient {
  type ProjectBody = { project: ZelavisProjectRecord };
  const lifecycle = (action: "start" | "stop" | "restart") =>
    async (projectId: string) =>
      (await json<ProjectBody>(projectPath(projectId, action), { method: "POST" })).project;
  return {
    list: () => json<ZelavisProjectListResponse>("/runtime/projects"),
    get: async (projectId) => (await json<ProjectBody>(projectPath(projectId))).project,
    create: async (input) =>
      (await json<ProjectBody>("/runtime/projects", { method: "POST", body: input })).project,
    update: async (projectId, input) =>
      (await json<ProjectBody>(projectPath(projectId), { method: "PATCH", body: input })).project,
    start: lifecycle("start"),
    stop: lifecycle("stop"),
    restart: lifecycle("restart"),
    logs: async (projectId) =>
      (await json<{ logs: readonly ZelavisProjectLogEntry[] }>(projectPath(projectId, "logs"))).logs,
    remove: (projectId) =>
      json<{ deleted: boolean }>(projectPath(projectId), { method: "DELETE" }),
    recipes: async () =>
      (await json<{ projectRecipes: readonly ZelavisProjectRecipeSummary[] }>(
        "/runtime/project-recipes",
      )).projectRecipes,
  };
}

export class ZelavisClientHttpError extends Error {
  readonly response: Response;
  readonly body: unknown;

  constructor(response: Response, body?: unknown) {
    super(body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error : `Zelavis request failed with status ${response.status}.`);
    this.name = "ZelavisClientHttpError";
    this.response = response;
    this.body = body;
  }

  get status(): number {
    return this.response.status;
  }
}

export interface ZelavisRoutesApi {
  create(
    routes: ZelavisServerRoute | readonly ZelavisServerRoute[],
  ): readonly ZelavisServerRoute[];
}

export interface ZelavisCommandsApi {
  register(command: ZelavisCommandDefinition): ZelavisCommandDefinition;
}

export interface ZelavisEventsApi {
  on(
    event: string,
    handler: (...args: unknown[]) => void | Promise<void>,
  ): () => void;
}

export interface ZelavisPluginServicesApi {
  add(service: ZelavisAnyRuntimeServiceInput): void;
}

export type { PluginFrontendBehavior, PluginSetupHandler } from "../core/service/context.js";

export interface ZelavisSdk {
  readonly operations: {
    create(operation: ZelavisServerRoute & { resource: string; action: string }): void;
  };
  readonly plugins: RegisteredPluginApis;
  readonly routes: ZelavisRoutesApi;
  readonly commands: ZelavisCommandsApi;
  readonly events: ZelavisEventsApi;
  readonly services: ZelavisPluginServicesApi;
  readonly context: () => PluginExecutionContext | undefined;
  readonly createAPI: typeof createAPI;
  readonly frontend: { configure(behavior: PluginFrontendBehavior): void };
  readonly setup: (handler: PluginSetupHandler) => void;
  createClient(options: ZelavisClientOptions): ZelavisClient;
}

export const zelavis: ZelavisSdk = {
  operations: {
    create({ resource, action, ...route }) {
      const context = requireActivePluginContext("zelavis.operations.create");
      validateOperationName(resource);
      validateOperationName(action);
      if (!/^\/(?:[a-zA-Z0-9_-]+|:[a-zA-Z][a-zA-Z0-9]*)(?:\/(?:[a-zA-Z0-9_-]+|:[a-zA-Z][a-zA-Z0-9]*))*$/.test(route.path)) {
        throw new TypeError("Plugin operations require a resource path beginning with / without wildcards, queries or traversal.");
      }
      if (!route.spec) throw new TypeError("Plugin operations require a documented route spec.");
      if (context.routes.some((item) => item.meta?.pluginResource === resource && item.meta?.pluginAction === action)) {
        throw new TypeError(`Duplicate plugin operation: ${resource}.${action}`);
      }
      context.routes.push({ ...route, meta: { ...route.meta, pluginResource: resource, pluginAction: action } });
    },
  },
  plugins: pluginsProxy,
  routes: {
    create(routes) {
      const context = requireActivePluginContext("zelavis.routes.create");
      const list = Array.isArray(routes) ? routes : [routes];
      context.routes.push(...list);
      return list;
    },
  },
  commands: {
    register(command) {
      const context = requireActivePluginContext("zelavis.commands.register");
      context.commands.set(command.name, command);
      return command;
    },
  },
  events: {
    on(event, handler) {
      const context = requireActivePluginContext("zelavis.events.on");
      const entry = { event, handler };
      context.events.push(entry);
      return () => {
        const index = context.events.indexOf(entry);
        if (index >= 0) context.events.splice(index, 1);
      };
    },
  },
  services: {
    add(service) {
      const context = requireActivePluginContext("zelavis.services.add");
      context.services.push(service);
    },
  },
  context: () => getActivePluginContext(),
  createAPI,
  setup(handler) {
    const context = requireActivePluginContext("zelavis.setup");
    if (context.setup) throw new TypeError("Plugin setup is already registered.");
    if (typeof handler !== "function") throw new TypeError("Plugin setup requires a function.");
    context.setup = handler;
  },
  frontend: {
    configure(behavior) {
      const context = requireActivePluginContext("zelavis.frontend.configure");
      if (context.kind !== "frontend" || (context.manifest.zelavis?.frontend as { runtime?: string } | undefined)?.runtime !== "static") {
        throw new TypeError("Frontend behavior requires a static frontend manifest.");
      }
      if (context.frontend) throw new TypeError("Frontend behavior is already registered.");
      for (const key of Object.keys(behavior)) {
        if (!["shell", "devUrl", "devUrlExcludePaths"].includes(key)) {
          throw new TypeError(`Frontend metadata belongs in package.json: ${key}`);
        }
      }
      if (behavior.shell && typeof behavior.shell.render !== "function") {
        throw new TypeError("A frontend shell requires a render function.");
      }
      context.frontend = Object.freeze({ ...behavior });
    },
  },
  createClient: createZelavisClient,
};

export default zelavis;

function normalizeRootPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function isBodyInit(value: unknown): value is BodyInit {
  return (
    typeof value === "string" ||
    value instanceof ArrayBuffer ||
    (typeof Blob !== "undefined" && value instanceof Blob) ||
    (typeof FormData !== "undefined" && value instanceof FormData) ||
    (typeof URLSearchParams !== "undefined" &&
      value instanceof URLSearchParams) ||
    (typeof ReadableStream !== "undefined" && value instanceof ReadableStream)
  );
}
