import { Effect } from "effect";
import { present, integration, integrationValue, unwrapFailure, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
import type { ZelavisSystemStoreNamespace, ZelavisSystemStorePage } from "../system-store.js";
import type { IdentityApi } from "../app/identity/index.js";
import type { ZelavisUpdateStatus } from "../updates.js";
import { stringifyJsonRequest } from "../core/runtime/json-request.js";
import type { ServiceSourceDiagnostic } from "../platform/service-registry-view.js";
import type {
  ZelavisProjectLogEntry,
  ZelavisProjectRecord,
  ZelavisProjectSetupValue,
  ZelavisProjectVersions,
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
  identityEndpointGroup,
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
  /** The marketplace allow-list, over `/runtime/marketplace`. Same contract as `zelavis marketplace`. */
  readonly marketplace: ZelavisMarketplaceClient;
  readonly updates: ZelavisUpdatesClient;
  /** Nodes that join this Platform, over `/runtime/nodes`. Same contract as `zelavis nodes`. */
  readonly nodes: ZelavisNodesClient;
  /** Cloud capacity, over `/runtime/cloud`. Same contract as `zelavis cloud`. */
  readonly cloud: ZelavisCloudClient;
  /**
   * App data in one App Project, as the caller's own Tenant.
   *
   * A function rather than an object because the Project is part of the
   * address: there is no ambient "current Project", and inventing one is how a
   * client ends up writing another App's records.
   */
  data(projectId: string): ZelavisDataClient;
  /** Host operations, over `/runtime/host-operations`. Same contract as `zelavis host-operations`. */
  readonly hostOperations: ZelavisHostOperationsClient;
  readonly environment: ZelavisEnvironmentClient;
  /** Proxy-neutral Edge management. Same contract as `zelavis edge`. */
  readonly edge: ZelavisEdgeClient;
  /** Accounts, login ceremonies, sessions, provider settings, and service clients. */
  readonly auth: ZelavisAuthClient;
  readonly runtime: {
    readonly systemStore: {
      namespaces(): Promise<readonly ZelavisSystemStoreNamespace[]>;
      records(namespace: string, options?: { limit?: number; after?: string }): Promise<ZelavisSystemStorePage>;
    };
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
    modalities(collection: string): Promise<ZelavisDataCollectionModalities>;
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
  /** A collection addressed by document id, over the same payloads and projections. */
  readonly kv: {
    get(namespace: string, key: string): Promise<ZelavisDataKeyValueEntry | undefined>;
    has(namespace: string, key: string): Promise<boolean>;
    set(
      namespace: string,
      key: string,
      value: Readonly<Record<string, unknown>>,
      options?: ZelavisDataKeyValueSetOptions,
    ): Promise<ZelavisDataKeyValueEntry>;
    remove(
      namespace: string,
      key: string,
      options?: Pick<ZelavisDataKeyValueSetOptions, "expectedVersion" | "idempotencyKey">,
    ): Promise<boolean>;
    scan(namespace: string, options?: {
      readonly prefix?: string;
      readonly lower?: string;
      readonly upper?: string;
      readonly direction?: "asc" | "desc";
      readonly limit?: number;
      readonly after?: string;
    }): Promise<ZelavisDataKeyValuePage>;
    changes(namespace: string, options?: {
      readonly after?: string;
      readonly limit?: number;
    }): Promise<ReadonlyArray<ZelavisDataKeyValueChange>>;
    write(namespace: string, input: {
      readonly operations: ReadonlyArray<ZelavisDataKeyValueWrite>;
      readonly idempotencyKey?: string;
    }): Promise<ReadonlyArray<ZelavisDataKeyValueEntry | { readonly key: string; readonly deleted: boolean }>>;
    size(namespace: string): Promise<number>;
    clear(namespace: string): Promise<number>;
  };
}

export interface ZelavisDataKeyValueEntry {
  readonly key: string;
  readonly value: Readonly<Record<string, unknown>>;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
}

export interface ZelavisDataKeyValueSetOptions extends ZelavisDataIdempotent {
  readonly expectedVersion?: number;
  readonly ifAbsent?: boolean;
  readonly expiresAt?: string;
  readonly ttlMs?: number;
}

export type ZelavisDataKeyValueWrite =
  | {
    readonly _tag: "Set";
    readonly key: string;
    readonly value: Readonly<Record<string, unknown>>;
    readonly expectedVersion?: number;
    readonly ifAbsent?: boolean;
    readonly expiresAt?: string;
    readonly ttlMs?: number;
  }
  | { readonly _tag: "Remove"; readonly key: string; readonly expectedVersion?: number };

export interface ZelavisDataKeyValuePage {
  readonly entries: ReadonlyArray<ZelavisDataKeyValueEntry>;
  readonly next?: string;
}

export interface ZelavisDataKeyValueChange {
  readonly cursor: string;
  readonly eventId: string;
  readonly key: string;
  readonly type: "set" | "remove";
  readonly revision: number;
  readonly timestamp: string;
  readonly value?: Readonly<Record<string, unknown>>;
}

export interface ZelavisDataCollection {
  readonly name: string;
  readonly surface?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ZelavisDataCollectionModalities {
  readonly collection: string;
  readonly document: { readonly status: "ready" };
  readonly keyValue: { readonly status: "ready"; readonly key: "document.id" };
  readonly events: { readonly status: "ready" };
  readonly columns: { readonly status: "ready"; readonly fields: "all-json-scalars" };
  readonly search: { readonly status: "ready" | "requires-declaration"; readonly fields: readonly string[] };
  readonly measures: { readonly status: "ready" | "requires-declaration"; readonly fields: readonly string[] };
  readonly graph: { readonly status: "ready" | "requires-declaration"; readonly edges: readonly string[] };
  readonly spatial: { readonly status: "ready" | "requires-declaration"; readonly fields: readonly string[] };
  readonly vector: { readonly status: "ready" | "requires-declaration"; readonly field?: string };
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
  /** Explicitly approve the recipe's fixed host package sets; requires server.packages.install. */
  readonly installHostPackages?: boolean;
  readonly name: string;
  readonly id?: string;
  readonly recipeName?: string;
  readonly engineVersion?: string;
  /** Install method id, from the recipe's `install.methods`; refused when this host cannot run it. */
  readonly method?: string;
  /** Software version, from the recipe's `install.software`; defaults to the newest. */
  readonly softwareVersion?: string;
  /** Defaults to true. */
  readonly start?: boolean;
}

export interface ZelavisProjectUpdateInput {
  readonly name: string;
}

export interface ZelavisProjectRecipeSummary {
  readonly hostPackages?: readonly string[];
  readonly name: string;
  readonly title: string;
  readonly summary?: string;
  readonly runtimeKinds: readonly string[];
  readonly isolation?: ZelavisProjectIsolationIntent;
  /** What can be chosen at creation, when the recipe offers a choice. */
  readonly install?: {
    readonly methods: readonly { readonly id: string; readonly driver: "js" | "oci"; readonly requires: readonly string[] }[];
    readonly software: readonly { readonly version: string }[];
  };
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
export interface ZelavisMarketplaceAllowlistStatus {
  /** Whether installs are limited to what the allow-list vouches for. */
  readonly gated: boolean;
  /** How many sources the list is fetched from. */
  readonly sources: number;
  readonly list?: {
    readonly sequence: number;
    readonly issuedAt: string;
    readonly expiresAt: string;
    readonly origin: "remote" | "cache" | "bundled";
    readonly fetchedAt?: string;
    readonly status: "fresh" | "stale" | "expired";
    readonly services: number;
  };
}

export interface ZelavisMarketplaceRefreshResult
  extends Omit<ZelavisMarketplaceAllowlistStatus, "gated" | "sources"> {
  readonly updated: boolean;
  readonly attempts: readonly { readonly source: string; readonly outcome: string; readonly detail?: string }[];
}

export interface ZelavisMarketplaceClient {
  /** How current the list is; needs `marketplace.view`. */
  allowlist(): Promise<ZelavisMarketplaceAllowlistStatus>;
  /** Fetches the list again from its sources; needs `system.services.manage`. */
  refresh(): Promise<ZelavisMarketplaceRefreshResult>;
}

export interface ZelavisUpdatesClient {
  /** Which version runs and whether a newer one is available; needs `system.updates.view`. */
  status(): Promise<ZelavisUpdateStatus>;
  /** Looks up the newest version on this installation's channel; needs `system.updates.manage`. */
  check(): Promise<ZelavisUpdateStatus>;
  /**
   * Asks for the update to the newest version and returns at once (HTTP 202);
   * the update runs as root and survives a restart, so poll `status`. Refused
   * with 409 when it cannot run; needs `system.updates.manage`.
   */
  apply(): Promise<ZelavisUpdateStatus>;
}

/** An enrolled node, without its certificate. */
export interface ZelavisNode {
  readonly nodeId: string;
  readonly agentId: string;
  readonly url: string;
  /** SHA-256 of the Agent's certificate, which the Platform pins. */
  readonly certSha256: string;
  readonly enrolledAt: number;
  readonly state: "active" | "revoked";
  readonly revokedAt?: number;
  /** The Zelavis version the machine reported when it joined. */
  readonly version?: string;
  /** `behind` when older than this Platform, `unknown` when it reported no version. Newer machines are refused at enrollment. */
  readonly compatibility: "current" | "behind" | "unknown";
}

/** An enrollment as an operator sees it: never its token. */
export interface ZelavisNodeEnrollment {
  readonly nodeId: string;
  readonly origin: "cloud" | "operator";
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly state: "unused" | "consumed";
}

export interface ZelavisNodeList {
  readonly nodes: readonly ZelavisNode[];
  readonly enrollments: readonly ZelavisNodeEnrollment[];
}

export interface ZelavisNodeEnrollmentToken {
  readonly nodeId: string;
  /** Shown once. Only its hash is kept. */
  readonly token: string;
  readonly expiresAt: number;
}

export interface ZelavisNodeEnrollInput {
  readonly nodeId: string;
  readonly token: string;
  /** The Agent's own certificate (PEM), generated on the machine; the Platform pins it. */
  readonly certPem: string;
  /** The Agent's HTTPS origin. */
  readonly url: string;
  /** The Zelavis version the machine runs. A machine newer than the Platform is refused with 409 `worker-newer`. */
  readonly version: string;
}

export interface ZelavisNodeEnrollResult {
  readonly nodeId: string;
  readonly agentId: string;
  /** The Platform's public keys, which the Agent trusts to verify what the Platform signs. */
  readonly trust: { readonly keys: readonly { readonly keyId: string; readonly publicKey: string; readonly notBefore: string; readonly notAfter: string }[] };
}

/** One answered enrollment attempt. Never carries a token, certificate or address. */
export interface ZelavisNodeEnrollmentAuditEntry {
  readonly at: number;
  readonly outcome: "enrolled" | "refused" | "worker-newer" | "node-exists" | "invalid";
  /** Present only when what the caller sent had the shape of a node id. */
  readonly nodeId?: string;
  /** Why a refused attempt was refused: the caller is never told. */
  readonly reason?: "unknown-node" | "bad-token" | "expired" | "already-consumed" | "source-mismatch" | "node-registered" | "node-revoked";
  readonly version?: string;
}

export interface ZelavisNodesClient {
  /**
   * The Platform's current public keys, for a joined machine to refresh its trust; no session
   * is needed. 409 when this installation does not accept nodes.
   */
  trust(): Promise<{ readonly keys: readonly { readonly keyId: string; readonly publicKey: string; readonly notBefore: string; readonly notAfter: string }[]; readonly revokedKeyIds?: readonly string[] }>;
  /** Recent enrollment attempts, newest first, with the reason a refusal had; needs `server.nodes.manage`. */
  audit(): Promise<readonly ZelavisNodeEnrollmentAuditEntry[]>;
  /** Enrolled nodes and pending enrollments; needs `server.nodes.view`. */
  list(): Promise<ZelavisNodeList>;
  /**
   * Issues a single-use credential for a machine to join; needs `server.nodes.enroll`.
   * `ttlMinutes` defaults to 60. The token is returned once.
   */
  createEnrollment(input: { readonly nodeId: string; readonly ttlMinutes?: number; readonly replace?: boolean }): Promise<ZelavisNodeEnrollmentToken>;
  /**
   * What a joining machine calls. The token is the credential, so no session is
   * needed. Refused with 403 and no reason; 409 when this installation does not accept nodes.
   */
  enroll(input: ZelavisNodeEnrollInput): Promise<ZelavisNodeEnrollResult>;
  /** Where machines enroll and the certificate fingerprint to pin, or null; needs `server.nodes.view`. */
  platform(): Promise<{ readonly url: string; readonly fingerprint: string } | null>;
  /** Revokes a node; refused with 409 while Projects are placed on it; needs `server.nodes.manage`. */
  remove(nodeId: string): Promise<{ readonly removed: boolean }>;
}

export interface ZelavisCloudConnection {
  readonly provider: string;
  readonly label: string;
  readonly connectedAt: number;
  readonly connectedBy: string;
  /** Last four characters of the token; the token itself is never returned. */
  readonly tokenHint: string;
}

export interface ZelavisCloudNode {
  readonly id: string;
  readonly provider: string;
  readonly state: "provisioning" | "ready" | "releasing" | "failed";
  readonly region?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface ZelavisCloudScalingSettings {
  /** Whether Zelavis may request machines by itself. Off until a person turns it on. */
  readonly consent: boolean;
  readonly maxMachines: number;
  readonly cooldownMinutes: number;
  readonly updatedAt: number;
  readonly updatedBy: string;
}

export interface ZelavisCloudScaling {
  readonly settings: ZelavisCloudScalingSettings;
  /** What the last look at unmet demand did: `waiting`, `booting`, `at-limit`, `cooling-down`, `requested`, `no-consent`, `no-provider` or `failed`. */
  readonly last?: { readonly outcome: string; readonly at: number };
}

export interface ZelavisCloudClient {
  /** Whether automatic machine requests are allowed, and the last decision; needs `server.cloud.view`. */
  scaling(): Promise<ZelavisCloudScaling>;
  /** Allows or forbids automatic machine requests, with limits; 409 when not connected; needs `server.cloud.connect`. */
  setScaling(input: { readonly consent: boolean; readonly maxMachines: number; readonly cooldownMinutes: number }): Promise<ZelavisCloudScalingSettings>;
  /** The provider connection, or null; needs `server.cloud.view`. */
  connection(): Promise<ZelavisCloudConnection | null>;
  /** Connects a provider. The token is proved by use, sealed, and never returned; needs `server.cloud.connect`. */
  connect(input: { readonly provider: string; readonly token: string; readonly label?: string }): Promise<ZelavisCloudConnection>;
  /** Forgets the token; 409 while machines this Platform created still exist; needs `server.cloud.connect`. */
  disconnect(): Promise<{ readonly disconnected: boolean }>;
  /** Machines this Platform created in its cloud; needs `server.cloud.view`. */
  nodes(): Promise<readonly ZelavisCloudNode[]>;
  /** Creates a machine that enrolls itself as a worker; idempotent per `requestId`; needs `server.cloud.manage`. */
  requestNode(input: { readonly requestId: string; readonly region?: string; readonly resources?: { readonly cpuCores?: number; readonly memoryBytes?: number; readonly diskBytes?: number } }): Promise<ZelavisCloudNode>;
  /** Deletes a machine this Platform created; needs `server.cloud.manage`. */
  releaseNode(nodeId: string): Promise<{ readonly released: boolean }>;
}

export interface ZelavisProjectsClient {
  versions(projectId?: string): Promise<ZelavisProjectVersions>;
  /** What a person needs to finish the application's own setup; a secret carries no value. Needs `project.view`. */
  setup(projectId: string): Promise<readonly ZelavisProjectSetupValue[]>;
  /** The same with secret values, audited. Needs `project.setup.reveal`. */
  revealSetup(projectId: string): Promise<readonly ZelavisProjectSetupValue[]>;
  switchVersion(projectId: string, version: string): Promise<ZelavisProjectRecord>;
  list(): Promise<ZelavisProjectListResponse>;
  get(projectId: string): Promise<ZelavisProjectRecord>;
  create(input: ZelavisProjectCreateInput): Promise<ZelavisProjectRecord>;
  update(projectId: string, input: ZelavisProjectUpdateInput): Promise<ZelavisProjectRecord>;
  start(projectId: string): Promise<ZelavisProjectRecord>;
  stop(projectId: string): Promise<ZelavisProjectRecord>;
  restart(projectId: string): Promise<ZelavisProjectRecord>;
  /** Updates managed SDK integrations without restarting the app, or hands a supported native App to its selected engine; data is kept. */
  /**
   * `restart: true` takes a running Project down for an upgrade that cannot be done live, and starts
   * it again afterwards (also when the upgrade fails). Without it that upgrade is refused (409)
   * until the Project is stopped.
   */
  upgrade(projectId: string, input?: { readonly recipeName?: string; readonly engineVersion?: string; readonly restart?: boolean }): Promise<ZelavisProjectRecord>;
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

  function resolveHeaders(headers?: HeadersInit): Promise<Headers> {
    return present(Effect.gen(function* (): Effect.fn.Return<Headers, IntegrationFailure> {
    const resolved = new Headers(
      typeof options.headers === "function"
        ? (yield* integrationValue(options.headers()))
        : options.headers,
    );
    const next = new Headers(headers);
    next.forEach((value, key) => {
      resolved.set(key, value);
    });
    return resolved;
  }));
  }

  function request(
    path: string,
    requestOptions: ZelavisClientRequestOptions = {},
  ): Promise<Response> {
    return present(Effect.gen(function* (): Effect.fn.Return<Response, IntegrationFailure> {
    const { body, headers: requestHeaders, ...fetchOptions } = requestOptions;
    const headers = (yield* integrationValue(resolveHeaders(requestHeaders)));
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
    return (yield* integrationValue(resolvedFetch(new URL(fullPath, baseUrl), init)));
  }));
  }

  function json<T = unknown>(
    path: string,
    requestOptions?: ZelavisClientRequestOptions,
  ): Promise<T> {
    return present(Effect.gen(function* (): Effect.fn.Return<T, IntegrationFailure> {
    const response = (yield* integrationValue(request(path, requestOptions)));
    if (!response.ok) {
      const body = (yield* integrationValue(response.clone().json().catch(() => undefined)));
      throw new ZelavisClientHttpError(response, body);
    }
    if (response.status === 204) return undefined as T;
    return (yield* integrationValue(response.json() as Promise<T>));
  }));
  }

  // The last catalogue and its ETag. Every discovery still asks the server,
  // so revocation is immediate; an unchanged catalogue answers 304 and is not
  // transferred again.
  let catalogue: { etag: string; operations: readonly PluginOperation[] } | undefined;
  function discoverPluginOperations(): Promise<readonly PluginOperation[]> {
    return present(Effect.gen(function* (): Effect.fn.Return<readonly PluginOperation[], IntegrationFailure> {
    const response = (yield* integrationValue(request("/runtime/plugin-operations", {
      headers: catalogue ? { "if-none-match": catalogue.etag } : {},
    })));
    if (response.status === 304 && catalogue) return catalogue.operations;
    if (!response.ok) {
      const body = (yield* integrationValue(response.clone().json().catch(() => undefined)));
      throw new ZelavisClientHttpError(response, body);
    }
    const body = (yield* integrationValue(response.json())) as { operations?: readonly PluginOperation[] };
    const operations = body.operations ?? [];
    const etag = response.headers.get("etag");
    catalogue = etag ? { etag, operations } : undefined;
    return operations;
  }));
  }

  return {
    plugins: createPluginClients(
      discoverPluginOperations,
      (path, method, body) => present(integration(() => json(path, { method, body: body as object | undefined }))),
    ),
    pluginOperations: discoverPluginOperations,
    projects: createProjectsClient(json),
    marketplace: {
      allowlist: () => json<ZelavisMarketplaceAllowlistStatus>("/runtime/marketplace/allowlist"),
      refresh: () =>
        json<ZelavisMarketplaceRefreshResult>("/runtime/marketplace/allowlist/refresh", { method: "POST" }),
    },
    updates: {
      status: () => json<ZelavisUpdateStatus>("/runtime/updates"),
      check: () => json<ZelavisUpdateStatus>("/runtime/updates/check", { method: "POST" }),
      apply: () => json<ZelavisUpdateStatus>("/runtime/updates/apply", { method: "POST" }),
    },
    cloud: {
      scaling: () => json<{ scaling: ZelavisCloudScaling }>("/runtime/cloud/scaling").then((r) => r.scaling),
      setScaling: (input) => json<{ settings: ZelavisCloudScalingSettings }>("/runtime/cloud/scaling", { method: "PUT", body: input }).then((r) => r.settings),
      connection: () => json<{ connection: ZelavisCloudConnection | null }>("/runtime/cloud").then((r) => r.connection),
      connect: (input) => json<{ connection: ZelavisCloudConnection }>("/runtime/cloud/connection", { method: "POST", body: input }).then((r) => r.connection),
      disconnect: () => json<{ disconnected: boolean }>("/runtime/cloud/connection", { method: "DELETE" }),
      nodes: () => json<{ nodes: readonly ZelavisCloudNode[] }>("/runtime/cloud/nodes").then((r) => r.nodes),
      requestNode: (input) => json<{ node: ZelavisCloudNode }>("/runtime/cloud/nodes", { method: "POST", body: input }).then((r) => r.node),
      releaseNode: (nodeId) => json<{ released: boolean }>(`/runtime/cloud/nodes/${encodeURIComponent(nodeId)}`, { method: "DELETE" }),
    },
    nodes: {
      trust: () => json<{ trust: Awaited<ReturnType<ZelavisNodesClient["trust"]>> }>("/runtime/nodes/trust", { method: "POST", body: {} }).then((r) => r.trust),
      audit: () => json<{ entries: readonly ZelavisNodeEnrollmentAuditEntry[] }>("/runtime/nodes/audit").then((r) => r.entries),
      list: () => json<ZelavisNodeList>("/runtime/nodes"),
      createEnrollment: (input) => json<ZelavisNodeEnrollmentToken>("/runtime/nodes/enrollments", { method: "POST", body: input }),
      enroll: (input) => json<ZelavisNodeEnrollResult>("/runtime/nodes/enroll", { method: "POST", body: input }),
      platform: () => json<{ endpoint: { url: string; fingerprint: string } | null }>("/runtime/nodes/platform").then((r) => r.endpoint),
      remove: (nodeId) => json<{ removed: boolean }>(`/runtime/nodes/${encodeURIComponent(nodeId)}`, { method: "DELETE" }),
    },
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
        oauthConnections: () =>
          present(Effect.gen(function* () {
    return ((yield* integrationValue(json<{ readonly providers: readonly ZelavisOAuthConnection[] }>(
            "/auth/oauth/connections",
          )))).providers;
  })),
        configureOAuth: (provider, input) =>
          present(Effect.gen(function* () {
    return ((yield* integrationValue(json<{ readonly connection: ZelavisOAuthConnection }>(
            `/auth/oauth/connections/${encodeURIComponent(provider)}`,
            { method: "PUT", body: input },
          )))).connection;
  })),
        removeOAuth: (provider) =>
          json<void>(`/auth/oauth/connections/${encodeURIComponent(provider)}`, {
            method: "DELETE",
          }),
        serviceAccounts: () =>
          present(Effect.gen(function* () {
    return ((yield* integrationValue(json<{ readonly serviceAccounts: readonly ZelavisAuthAccount[] }>(
            "/auth/service-accounts",
          )))).serviceAccounts;
  })),
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
        setServiceAccountTenant: (accountId, tenantId) =>
          present(Effect.gen(function* () {
    return ((yield* integrationValue(json<{ serviceAccount: ZelavisAuthAccount }>(
            `/auth/service-accounts/${encodeURIComponent(accountId)}`,
            { method: "PATCH", body: { tenantId } },
          )))).serviceAccount;
  })),
        revokeServiceAccount: (accountId) =>
          json<void>(`/auth/service-accounts/${encodeURIComponent(accountId)}`, {
            method: "DELETE",
          }),
      },
    },
    edge: {
      status: () => json<ZelavisEdgeStatusResponse>("/runtime/edge"),
      plan: (input) =>
        present(Effect.gen(function* () {
    return ((yield* integrationValue(json<{ plan: ZelavisEdgeSwitchPlan }>("/runtime/edge/plan", {
          method: "POST",
          body: input,
        })))).plan;
  })),
      switch: (input) =>
        present(Effect.gen(function* () {
    return ((yield* integrationValue(json<{ edgeSwitch: ZelavisEdgeSwitchRecord }>(
          "/runtime/edge/switch",
          { method: "POST", body: input },
        )))).edgeSwitch;
  })),
      routes: (filter = {}) => present(Effect.gen(function* () {
        const search = new URLSearchParams();
        if (filter.scope) search.set("scope", filter.scope);
        if (filter.projectId) search.set("projectId", filter.projectId);
        if (filter.hostname) search.set("hostname", filter.hostname);
        const suffix = search.size ? `?${search}` : "";
        return (yield* integrationValue(json<ZelavisEdgeRoutesResponse>(`/runtime/edge/routes${suffix}`)));
      })),
      putRoute: (input) => present(Effect.gen(function* () {
        const body = "id" in input ? { route: input } : input;
        return (yield* integrationValue(json<ZelavisEdgePutRouteResponse>("/runtime/edge/routes", {
          method: "POST",
          body,
        })));
      })),
      deleteRoute: (routeId) => present(integration(() => json<{ deleted?: boolean }>(
        `/runtime/edge/routes/${encodeURIComponent(routeId)}`,
        { method: "DELETE" },
      )).pipe(
        Effect.map((response) => Boolean(response.deleted)),
        Effect.catchIf(isNotFound, () => Effect.succeed(false)),
      )),
      publish: () =>
        present(Effect.gen(function* () {
    return ((yield* integrationValue(json<{ publication: ZelavisEdgeCompiledPublication }>(
          "/runtime/edge/publish",
          { method: "POST" },
        )))).publication;
  })),
      preflightHostname: (hostname) =>
        present(integration(() => json<ZelavisEdgeOnboardingPreflightResult>(
          `/runtime/edge/onboard/preflight?hostname=${encodeURIComponent(hostname)}`,
        ))),
      onboardHostname: (input) =>
        present(integration(() => json<ZelavisEdgeOnboardingResult>("/runtime/edge/onboard", {
          method: "POST",
          body: input,
        }))),
      certificates: () =>
        present(integration(() => json<ZelavisEdgeCertificatesResponse>("/runtime/edge/certificates"))),
      renewCertificates: (input = {}) =>
        present(integration(() => json<ZelavisEdgeRenewCertificatesResponse>(
          "/runtime/edge/certificates/renew",
          {
            method: "POST",
            body: input,
          },
        ))),
    },
    hostOperations: {
      catalog: () =>
        present(Effect.gen(function* () {
    return ((yield* integrationValue(json<{ operations: readonly ZelavisHostOperationCatalogEntry[] }>("/runtime/host-operations")))).operations;
  })),
      submit: (input) =>
        present(Effect.gen(function* () {
    return ((yield* integrationValue(json<{ operation: ZelavisHostOperationRecord }>("/runtime/host-operations", {
          method: "POST",
          body: input,
        })))).operation;
  })),
      audit: (query = {}) => present(Effect.gen(function* () {
        const search = new URLSearchParams();
        if (query.projectId !== undefined) search.set("projectId", query.projectId);
        if (query.limit !== undefined) search.set("limit", String(query.limit));
        const suffix = search.size ? `?${search}` : "";
        return ((yield* integrationValue(json<{ records: readonly ZelavisHostOperationRecord[] }>(
          `/runtime/host-operations/audit${suffix}`,
        )))).records;
      })),
      get: (operationId) => present(Effect.gen(function* () {
        if (typeof operationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) {
          throw new TypeError("Invalid host operation id.");
        }
        return ((yield* integrationValue(json<{ operation: ZelavisHostOperationRecord }>(
          `/runtime/host-operations/${operationId}`,
        )))).operation;
      })),
    },
    environment: {
      identity: () =>
        present(Effect.gen(function* () {
    return ((yield* integrationValue(json<{ environment: ZelavisEnvironmentIdentity }>("/runtime/environment")))).environment;
  })),
      health: () => json<ZelavisEnvironmentHealth>("/runtime/environment/health"),
      createSession: (input = {}) =>
        present(Effect.gen(function* () {
    return ((yield* integrationValue(json<{ session: ZelavisEnvironmentSession }>("/runtime/environment/sessions", {
          method: "POST",
          body: input,
        })))).session;
  })),
      updateSession: (sessionId, update) => present(Effect.gen(function* () {
        if (!sessionId || sessionId === "." || sessionId === "..") throw new TypeError("Invalid environment session id.");
        if (!Number.isSafeInteger(update.expectedVersion) || update.expectedVersion < 0) {
          throw new TypeError("Environment session expectedVersion must be a non-negative integer.");
        }
        return ((yield* integrationValue(json<{ session: ZelavisEnvironmentSession }>(
          `/runtime/environment/sessions/${encodeURIComponent(sessionId)}`,
          { method: "PATCH", body: update },
        )))).session;
      })),
      getSession: (sessionId) => present(Effect.gen(function* () {
        if (!sessionId || sessionId === "." || sessionId === "..") throw new TypeError("Invalid environment session id.");
        return ((yield* integrationValue(json<{ session: ZelavisEnvironmentSession }>(
          `/runtime/environment/sessions/${encodeURIComponent(sessionId)}`,
        )))).session;
      })),
      closeSession: (sessionId) => present(Effect.gen(function* () {
        if (!sessionId || sessionId === "." || sessionId === "..") throw new TypeError("Invalid environment session id.");
        return (yield* integrationValue(json<{ readonly closed: boolean }>(
          `/runtime/environment/sessions/${encodeURIComponent(sessionId)}`,
          { method: "DELETE" },
        )));
      })),
      recordUsage: (sessionId, input) => present(Effect.gen(function* () {
        if (!sessionId || sessionId === "." || sessionId === "..") throw new TypeError("Invalid environment session id.");
        return ((yield* integrationValue(json<{ usage: ZelavisEnvironmentUsageRecord }>(
          `/runtime/environment/sessions/${encodeURIComponent(sessionId)}/usage`,
          { method: "POST", body: input },
        )))).usage;
      })),
      startProcess: (sessionId, input) => present(Effect.gen(function* () {
        if (!sessionId || sessionId === "." || sessionId === "..") throw new TypeError("Invalid environment session id.");
        return ((yield* integrationValue(json<{ process: ZelavisEnvironmentProcess }>(
          `/runtime/environment/sessions/${encodeURIComponent(sessionId)}/processes`,
          { method: "POST", body: input },
        )))).process;
      })),
      getProcess: (processId) => present(Effect.gen(function* () {
        if (!processId || processId === "." || processId === "..") throw new TypeError("Invalid environment process id.");
        return ((yield* integrationValue(json<{ process: ZelavisEnvironmentProcess }>(
          `/runtime/environment/processes/${encodeURIComponent(processId)}`,
        )))).process;
      })),
      operateProcess: (processId, input) => present(Effect.gen(function* () {
        if (!processId || processId === "." || processId === "..") throw new TypeError("Invalid environment process id.");
        return ((yield* integrationValue(json<{ result: ZelavisEnvironmentOperationResult }>(
          `/runtime/environment/processes/${encodeURIComponent(processId)}/operations`,
          { method: "POST", body: input },
        )))).result;
      })),
      readEvents: (sessionId, options = {}) => present(Effect.gen(function* () {
        if (!sessionId || sessionId === "." || sessionId === "..") throw new TypeError("Invalid environment session id.");
        const search = new URLSearchParams();
        if (options.after !== undefined) search.set("after", options.after);
        if (options.limit !== undefined) search.set("limit", String(options.limit));
        const suffix = search.size ? `?${search}` : "";
        return (yield* integrationValue(json<ZelavisEnvironmentEventPage>(
          `/runtime/environment/sessions/${encodeURIComponent(sessionId)}/events${suffix}`,
        )));
      })),
    },
    baseUrl,
    rootPath,
    request,
    json,
    runtime: {
      systemStore: {
        namespaces: () => json<{ namespaces: readonly ZelavisSystemStoreNamespace[] }>("/runtime/system-store/namespaces").then(result => result.namespaces),
        records: (namespace, options = {}) => {
          const query = new URLSearchParams();
          if (options.limit !== undefined) query.set("limit", String(options.limit));
          if (options.after !== undefined) query.set("after", options.after);
          return json<ZelavisSystemStorePage>(`/runtime/system-store/namespaces/${encodeURIComponent(namespace)}/records?${query}`);
        },
      },
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
      list: () =>
        present(Effect.gen(function* () {
    return ((yield* integrationValue(json<{ collections: readonly ZelavisDataCollection[] }>(
          dataPath(projectId, "documents/collections"),
        )))).collections;
  })),
      modalities: (collection) => json<ZelavisDataCollectionModalities>(dataPath(
        projectId,
        `documents/collections/${dataName(collection, "collection name")}/modalities`,
      )),
      create: (input) => post<ZelavisDataCollection>("documents/collections", input),
      exists: (collection) =>
        present(Effect.gen(function* () {
    return ((yield* integrationValue(json<{ exists: boolean }>(
          dataPath(projectId, `documents/collections/${dataName(collection, "collection name")}/exists`),
        )))).exists;
  })),
      drop: (collection) =>
        present(Effect.gen(function* () {
    return ((yield* integrationValue(json<{ dropped: boolean }>(
          dataPath(projectId, `documents/collections/${dataName(collection, "collection name")}`),
          { method: "DELETE", body: {} },
        )))).dropped;
  })),
    },
    documents: {
      insert: (collection, input) =>
        post<ZelavisDataDocument>(`documents/${dataName(collection, "collection name")}`, input),
      get: (collection, id) => present(Effect.gen(function* () {
        const path = dataPath(
          projectId,
          `documents/${dataName(collection, "collection name")}/${dataName(id, "document id")}`,
        );
        return yield* integration(() => json<ZelavisDataDocument>(path)).pipe(
          // A document that is not there is an answer, not a failure: callers
          // read before writing and would otherwise wrap every read in a try.
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );
      })),
      query: (collection, input = {}) =>
        present(Effect.gen(function* () {
    return ((yield* integrationValue(post<{ documents: readonly ZelavisDataDocument[] }>(
          `documents/${dataName(collection, "collection name")}/query`,
          input,
        )))).documents;
  })),
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
      delete: (collection, id, input = {}) =>
        present(Effect.gen(function* () {
    return ((yield* integrationValue(json<{ deleted: boolean }>(
          dataPath(
            projectId,
            `documents/${dataName(collection, "collection name")}/${dataName(id, "document id")}`,
          ),
          { method: "DELETE", body: input },
        )))).deleted;
  })),
      write: (input) =>
        present(Effect.gen(function* () {
    return ((yield* integrationValue(post<{ written: readonly ZelavisDataWritten[] }>("documents/write", input)))).written;
  })),
    },
    kv: {
      get: (namespace, key) => present(Effect.gen(function* () {
        const path = dataPath(
          projectId,
          `kv/${dataName(namespace, "KV namespace")}/${dataName(key, "KV key")}`,
        );
        return yield* integration(() => json<ZelavisDataKeyValueEntry>(path)).pipe(
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );
      })),
      has: (namespace, key) =>
        present(Effect.gen(function* () {
    return ((yield* integrationValue(json<{ exists: boolean }>(dataPath(
          projectId,
          `kv/${dataName(namespace, "KV namespace")}/${dataName(key, "KV key")}/exists`,
        ))))).exists;
  })),
      set: (namespace, key, value, options = {}) =>
        json<ZelavisDataKeyValueEntry>(dataPath(
          projectId,
          `kv/${dataName(namespace, "KV namespace")}/${dataName(key, "KV key")}`,
        ), { method: "PUT", body: { value, ...options } }),
      remove: (namespace, key, options = {}) =>
        present(Effect.gen(function* () {
    return ((yield* integrationValue(json<{ deleted: boolean }>(dataPath(
          projectId,
          `kv/${dataName(namespace, "KV namespace")}/${dataName(key, "KV key")}`,
        ), { method: "DELETE", body: options })))).deleted;
  })),
      scan: (namespace, options = {}) =>
        post<ZelavisDataKeyValuePage>(`kv/${dataName(namespace, "KV namespace")}/scan`, options),
      changes: (namespace, options = {}) =>
        present(Effect.gen(function* () {
    return ((yield* integrationValue(post<{ changes: ReadonlyArray<ZelavisDataKeyValueChange> }>(
          `kv/${dataName(namespace, "KV namespace")}/changes`,
          options,
        )))).changes;
  })),
      write: (namespace, input) =>
        present(Effect.gen(function* () {
    return ((yield* integrationValue(post<{
          written: ReadonlyArray<ZelavisDataKeyValueEntry | { readonly key: string; readonly deleted: boolean }>;
        }>(`kv/${dataName(namespace, "KV namespace")}/write`, input)))).written;
  })),
      size: (namespace) =>
        present(Effect.gen(function* () {
    return ((yield* integrationValue(json<{ size: number }>(dataPath(
          projectId,
          `kv/${dataName(namespace, "KV namespace")}`,
        ))))).size;
  })),
      clear: (namespace) =>
        present(Effect.gen(function* () {
    return ((yield* integrationValue(json<{ removed: number }>(dataPath(
          projectId,
          `kv/${dataName(namespace, "KV namespace")}`,
        ), { method: "DELETE", body: {} })))).removed;
  })),
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
    (projectId: string) =>
      present(Effect.gen(function* () {
    return ((yield* integrationValue(json<ProjectBody>(projectPath(projectId, action), { method: "POST" })))).project;
  }));
  return {
    versions: projectId => json<ZelavisProjectVersions>(projectId === undefined ? "/runtime/project-versions" : projectPath(projectId, "versions")),
    setup: (projectId) => json<{ values: readonly ZelavisProjectSetupValue[] }>(projectPath(projectId, "setup")).then(result => result.values),
    revealSetup: (projectId) => json<{ values: readonly ZelavisProjectSetupValue[] }>(projectPath(projectId, "setup/reveal"), { method: "POST" }).then(result => result.values),
    switchVersion: (projectId, version) => json<ProjectBody>(projectPath(projectId, "version"), { method: "POST", body: { version } }).then(result => result.project),
    list: () => json<ZelavisProjectListResponse>("/runtime/projects"),
    get: (projectId) => present(Effect.gen(function* () {
    return ((yield* integrationValue(json<ProjectBody>(projectPath(projectId))))).project;
  })),
    create: (input) =>
      present(Effect.gen(function* () {
    return ((yield* integrationValue(json<ProjectBody>("/runtime/projects", { method: "POST", body: input })))).project;
  })),
    update: (projectId, input) =>
      present(Effect.gen(function* () {
    return ((yield* integrationValue(json<ProjectBody>(projectPath(projectId), { method: "PATCH", body: input })))).project;
  })),
    start: lifecycle("start"),
    stop: lifecycle("stop"),
    restart: lifecycle("restart"),
    upgrade: (projectId, input) =>
      present(Effect.gen(function* () {
    return ((yield* integrationValue(json<ProjectBody>(projectPath(projectId, "upgrade"), {
        method: "POST",
        body: input ?? {},
      })))).project;
  })),
    logs: (projectId) =>
      present(Effect.gen(function* () {
    return ((yield* integrationValue(json<{ logs: readonly ZelavisProjectLogEntry[] }>(projectPath(projectId, "logs"))))).logs;
  })),
    remove: (projectId) =>
      json<{ deleted: boolean }>(projectPath(projectId), { method: "DELETE" }),
    recipes: () =>
      present(Effect.gen(function* () {
    return ((yield* integrationValue(json<{ projectRecipes: readonly ZelavisProjectRecipeSummary[] }>(
        "/runtime/project-recipes",
      )))).projectRecipes;
  })),
  };
}

const isNotFound = (failure: IntegrationFailure): boolean => {
  const error = unwrapFailure(failure);
  return error instanceof ZelavisClientHttpError && error.status === 404;
};

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

export type { PluginFrontendBehavior, PluginSetupHandler } from "../core/service/context.js";

export interface ZelavisSdk {
  readonly operations: {
    create(operation: ZelavisServerRoute & { resource: string; action: string }): void;
  };
  readonly plugins: RegisteredPluginApis;
  readonly routes: ZelavisRoutesApi;
  readonly commands: ZelavisCommandsApi;
  readonly events: ZelavisEventsApi;
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
