import { publicServiceRegistryIdentity } from "./platform/service-registry-view.js";
import {
  authService as createAuthService,
  createAuth,
  type AuthServiceOptions,
  createOAuthProviderRuntime,
  createPasswordProvider,
  PASSWORD_PROVIDER,
  type AuthMethodContext,
  type AuthMethodPlugin,
  type AuthApi,
} from "./app/auth/index.js";
import {
  defineDatabaseService,
  type DatabaseRuntimeApi,
  type JsonObject,
  CollectionExists,
} from "./db/index.js";
import { DocumentConflict } from "./db/errors.js";
import type { OpenNodeDatabaseOptions } from "./db/node-host.js";
import {
  createFabricService,
  createJsonErrorResponse,
  createServiceRuntime as mountZelavisServer,
  generateOpenApiSpec,
  resolveMountedEndpoints,
  type FabricApi,
  type FabricPlacementState,
  type FabricProjectPlacement,
  type FabricServiceOptions,
  type ZelavisServerDispatchHandler,
  type ZelavisServerErrorHandler,
  type ZelavisServerExecutionContext,
  type ZelavisServerFetchHandler,
  declaresServiceCapability,
  serviceCapabilityFor,
  serviceExtensionOwners,
  serviceExtensionPoints,
  type ZelavisResolvedRoute,
  type ZelavisServerPlainHandler,
  type ZelavisServerRoute,
  type ZelavisServerRuntime,
  type ZelavisPrincipalResolver,
  type ZelavisRuntimeService,
} from "./core/index.js";
import {
  createMissingPlatformFrontendService,
  ZELAVIS_BASELINE_SERVICE_PAGE_STYLESHEET,
  type ZelavisPlatformFrontend,
  type ZelavisPlatformFrontendFactory,
} from "./platform/frontend-host.js";
import { ZELAVIS_BASELINE_SERVICE_ELEMENTS } from "./platform/service-elements.js";
import { createZelavisAuthSettingsService } from "./platform/auth-settings.js";
import { createZelavisMarketplaceService } from "./platform/marketplace.js";
import { createZelavisCoreService } from "./platform/core-service.js";
import { createProjectGatewayRoutes } from "./platform/project-gateway.js";
import { createProjectFrontendPlaceholderService } from "./platform/project-frontend.js";
import { guardControlPlaneHost } from "./platform/public-domain-forwarder.js";
export {
  assertListableFrontend,
  readFrontendManifest,
  ZELAVIS_FRONTEND_MARKETPLACE_CATEGORY,
  ZelavisFrontendListingError,
  toServiceAppDefinition,
  ZelavisFrontendManifestError,
  type ZelavisFrontendManifest,
  type ZelavisFrontendRuntime,
  type ZelavisServerFrontendManifest,
  type ZelavisStaticFrontendManifest,
} from "./core/service/frontend.js";
import { resolveStorageCoreService } from "./platform/storage.js";
export type {
  ZelavisKeyValueStore,
  ZelavisRuntimeEngine,
} from "./platform/shared.js";
import type {
  ZelavisKeyValueStore,
  ZelavisRuntimeEngine,
} from "./platform/shared.js";

export type {
  ZelavisDashboardThemeMode,
  ZelavisDashboardContentPreferences,
  ZelavisDashboardMediaPreferences,
  ZelavisDashboardPreferences,
  ZelavisDashboardSettings,
  ZelavisDashboardSettingsUpdate,
  ZelavisDashboardSettingsStore,
} from "./platform/settings.js";
export {
  createKeyValueDashboardSettingsStore,
  createSystemStoreDashboardSettingsStore,
  createKeyValueServiceRegistryStore,
  createSystemStoreServiceRegistryStore,
  createFileStorageServiceRegistryStore,
} from "./platform/settings.js";
import type {
  ZelavisDashboardSettings,
  ZelavisDashboardSettingsStore,
} from "./platform/settings.js";
import {
  createFileStorageServiceRegistryStore,
  createKeyValueDashboardSettingsStore,
  createKeyValueServiceRegistryStore,
  createMemoryDashboardSettingsStore,
  createMemoryServiceRegistryStore,
  createSystemStoreDashboardSettingsStore,
  createSystemStoreServiceRegistryStore,
  isDashboardThemeMode,
  parseStoredDashboardSettingsUpdate,
  parseStoredServiceRegistryStateEntry,
  readDashboardSettingsUpdate,
  readInitialServiceRegistryState,
  mutateServiceRegistry,
  resolveRuntimeSettingsStore,
  resolveServiceRegistryStore,
} from "./platform/settings.js";
export { createFileReference } from "./platform/storage.js";
export {
  createServiceStore,
  serviceStoreNamespace,
  type ZelavisServiceStore,
} from "./platform/service-store.js";
import {
  encodeStoragePath,
  isBoolean,
  isRuntimeEngine,
  joinPathParts,
  normalizeEditableRootPath,
  normalizePath,
  normalizePathPart,
  readBodyObject,
  zelavisErrorResponse,
  ZelavisValidationError,
} from "./platform/shared.js";
import {
  workloadsService,
  type WorkloadsServiceOptions,
} from "./app/workloads/index.js";
export { ZELAVIS_VERSION } from "./version.js";
import {
  activateServiceRegistry,
  applyServiceRegistryState,
  createServiceRegistry,
  loadService,
  loadServiceRegistry,
  serializeServiceRegistryState,
  type ZelavisServiceLoadOptions,
  type ZelavisServiceMenuDefinition,
  type ZelavisServiceRegistryEntry,
  type ZelavisServiceRegistryModuleEntry,
  type ZelavisServiceRegistryStateEntry,
  type ZelavisServiceRegistryStore,
  type ZelavisServiceSetupPlatformContext,
  type ZelavisServiceSetupContext,
} from "./service.js";
export * from "./service.js";
export * from "./system-store.js";
export * from "./project.js";
export * from "./platform/host-operations.js";
export * from "./assistant.js";
export * from "./bundle-store.js";
export * from "./tls.js";
export * from "./domain-binding.js";
export * from "./domain-verifier.js";
export * from "./edge/index.js";
import { createSharedBundleStore, type BundleStore } from "./bundle-store.js";
import type { TlsProvider } from "./tls.js";
import {
  deleteProjectDomainBindings,
  type DomainBindingStore,
} from "./domain-binding.js";
import {
  createProjectManager,
  ZelavisProjectConflictError,
  ZelavisProjectIsolationError,
  ZelavisProjectNotFoundError,
  ZelavisProjectRuntimeError,
  ZelavisProjectValidationError,
  type ZelavisProjectDispatcher,
  type ZelavisProjectRuntimeDriver,
  type ZelavisProjectManager,
  type ZelavisProjectRecord,
} from "./project.js";
import {
  ZelavisHostOperationForbiddenError,
  ZelavisHostOperationNotFoundError,
  ZelavisHostOperationRateLimitedError,
  type ZelavisHostOperationBroker,
} from "./platform/host-operations.js";
import { ZelavisHostOperationValidationError } from "./core/deployment/index.js";
import type { ZelavisPrincipal as HostOperationPrincipal } from "./core/runtime/contracts.js";
import {
  createAssistantManager,
  ZelavisAssistantNotFoundError,
  ZelavisAssistantValidationError,
  type ZelavisAssistantResponder,
} from "./assistant.js";
import {
  createDeploymentBackendManager,
  createDeploymentBackendProjectRuntime,
  ZelavisDeploymentBackendConflictError,
  ZelavisDeploymentBackendValidationError,
  type ZelavisDeploymentBackendAdapter,
  type ZelavisDeploymentBackendManager,
} from "./backends/registry.js";
// Only the runtime-neutral backend contracts are re-exported from the root
// entrypoint. The concrete Native and Docker adapters import `node:` built-ins
// and stay behind the `zelavis/backends` subpath, which Node hosts import
// directly — otherwise a fetch-native host cannot even typecheck `zelavis`.
export * from "./backends/registry.js";
export * from "./agent/index.js";
import type { ZelavisAgentOperationReader } from "./core/agent/index.js";
import type {
  ZelavisEnvironmentEventReadOptions,
  ZelavisRemoteEnvironment,
  ZelavisEnvironmentOperationInput,
  ZelavisEnvironmentProcess,
  ZelavisEnvironmentProcessInput,
  ZelavisEnvironmentSession,
  ZelavisEnvironmentUsageRecord,
} from "./platform/remote-environment.js";
export * from "./platform/remote-environment.js";
import {
  createMemorySystemStore,
  type ZelavisSystemStore,
} from "./system-store.js";
import {
  createZelavisEdgeRouteStore,
  createTraefikEdgeAdapter,
  createTraefikCertificateDistributor,
  performEdgeOnboarding,
  preflightHostname,
  ZelavisEdgeConflictError,
  ZelavisEdgeSwitchError,
  ZelavisEdgeValidationError,
  createZelavisCertificateController,
  createAcmeChallengeService,
  createAcmeClient,
  type ZelavisCertificateController,
  type ZelavisEdgeCertificateRecord,
  type ZelavisEdgeCertificateSummary,
  type ZelavisEdgeResolvedCertificate,
  type AcmeChallengeStore,
  type OrderCertificateOptions,
  type CheckRenewalsOptions,
  type RenewalsResult,
  type ZelavisEdgeHostname,
  type ZelavisEdgeManager,
  type ZelavisEdgeOnboardingRequest,
  type ZelavisEdgePublication,
  type ZelavisEdgeRoute,
  type ZelavisEdgeRouteStore,
} from "./edge/index.js";
export {
  createTraefikEdgeAdapter,
  createTraefikCertificateDistributor,
  createZelavisCertificateController,
  createAcmeChallengeService,
  createAcmeClient,
  performEdgeOnboarding,
  preflightHostname,
  type ZelavisCertificateController,
  type ZelavisEdgeCertificateRecord,
  type ZelavisEdgeCertificateSummary,
  type ZelavisEdgeResolvedCertificate,
  type AcmeChallengeStore,
  type OrderCertificateOptions,
  type CheckRenewalsOptions,
  type RenewalsResult,
};
import { createDomainChallengeService } from "./domain-verifier.js";
import { synthesizeServiceAppService } from "./service-app.js";
import { createPlatformAuthRepositories } from "./platform/auth-repositories.js";
import { createPlatformAuthBootstrap } from "./platform/auth-bootstrap.js";
import { createServiceStore } from "./platform/service-store.js";
export * from "./storage/s3.js";
export * from "./storage/conditions.js";

export type {
  DatabaseRuntimeApi,
  JsonObject as DatabaseJsonObject,
} from "./db/index.js";
export {
  type ZelavisAnyRuntimeServiceInput,
  type ZelavisServerErrorHandler,
  type ZelavisServerRoute,
  type ZelavisServerRuntime,
  type ZelavisRuntimeService,
} from "./core/index.js";

export type {
  ZelavisFileReference,
  ZelavisFileStorage,
  ZelavisFileStorageCondition,
  ZelavisFileStorageScope,
  ZelavisFileStorageCapabilities,
  ZelavisFileStorageEntry,
  ZelavisFileStorageObject,
  ZelavisFileStoragePutInput,
  ZelavisStorageOptions,
  ZelavisStorageCoreServiceOptions,
} from "./platform/storage-types.js";
import type {
  ZelavisFileStorage,
  ZelavisStorageOptions,
} from "./platform/storage-types.js";


export type ZelavisAuthOptions = boolean | AuthServiceOptions;

/**
 * The face of an installation.
 *
 * This absorbed what `coreServices.dashboard` used to carry. That option
 * predated frontends being a first-class Zelavis concept, and by the end every
 * field it held was about the frontend: the title and subtitle were passed
 * straight into the frontend factory, and `clientRoutes` already fell back to
 * the routes the frontend declared for itself.
 *
 * There is no way to switch the frontend off. Having no frontend is expressed
 * by installing none, and the root path then says so — a state the API is
 * unaffected by. A second, code-level off switch meant the same thing twice
 * and let the two disagree: a factory could be supplied and then ignored.
 */
export type ZelavisFrontendInput =
  | ZelavisPlatformFrontendFactory
  | ZelavisFrontendOptions;

export interface ZelavisFrontendOptions {
  /** Supplies the frontend. Omit for an installation that ships none. */
  factory?: ZelavisPlatformFrontendFactory;
  title?: string;
  subtitle?: string;
  devServerUrl?: string;
  /** Overrides the client-side routes the frontend declares for itself. */
  clientRoutes?: readonly string[];
}

export type {
  ZelavisPlatformFrontend,
  ZelavisPlatformFrontendContext,
  ZelavisPlatformFrontendFactory,
} from "./platform/frontend-host.js";





export type ZelavisWorkloadsOptions =
  | boolean
  | WorkloadsServiceOptions;








/**
 * How the Platform gets its database.
 *
 * `zelavis/db` has no in-memory store, so there is no longer a database a runtime
 * can conjure without being told where to put it. Either the host names a
 * directory, or it hands over an already-open instance whose lifetime it owns;
 * anything else means this runtime has no database.
 */
export type ZelavisDatabaseOptions =
  | false
  | ZelavisDatabaseStorageOptions
  | DatabaseRuntimeApi
  | Promise<DatabaseRuntimeApi>;

export type ZelavisDatabaseStorageOptions = OpenNodeDatabaseOptions;

export type ZelavisFabricOptions = boolean | FabricServiceOptions;

/**
 * Platform subsystems, composed by the host rather than installed.
 *
 * These used to live in a `coreServices` bag, which read as though the Platform
 * had a second, privileged way to install services. It did not: these are the
 * Platform's own subsystems, and every one of them is either infrastructure
 * (a database, object storage) or a policy switch. Services come from the
 * product-services folder and the registry, and only from there.
 *
 * They stay internal to `zelavis(...)`; the public constructor refuses them.
 */
export interface ZelavisSubsystemOptions {
  auth?: ZelavisAuthOptions;
  database?: ZelavisDatabaseOptions;
  fabric?: ZelavisFabricOptions;
  storage?: ZelavisStorageOptions;
  workloads?: ZelavisWorkloadsOptions;
  edgeCertificates?: ZelavisCertificateController;
  /**
   * Whether this installation serves the public root.
   *
   * With it on, Zelavis mounts at `/` and a Project or bound domain can be
   * served from the root path; with it off the installation lives entirely
   * under its root path. Not a service — the placeholder it mounts is the
   * frontend one.
   */
  site?: boolean;
}

export interface ZelavisApiOptions {
  prefix?: string;
  version?: string;
}


export interface ZelavisServiceRegistryOptions {
  catalog?: readonly ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>[];
  /**
   * Services found in a folder on this server rather than composed in code.
   *
   * Kept separate from `catalog` because their trust story differs: a catalog
   * entry was written by whoever composed the runtime, while these arrived as
   * files an operator dropped in. They are loaded through the same importer
   * and validated the same way, and a discovered service never displaces one
   * the installation composed itself.
   */
  discovered?: readonly ZelavisServiceRegistryModuleEntry[];
  store?: ZelavisServiceRegistryStore;
  importer?: ZelavisServiceLoadOptions["importer"];
  /**
   * Resolves a `package.json` manifest for a service specifier.
   *
   * Supplied per runtime by the host adapter rather than installed process
   * globally, so two embedded runtimes in one process cannot affect each
   * other's service loading.
   */
  manifestResolver?: ZelavisServiceLoadOptions["manifestResolver"];
}

export interface ZelavisServiceContextOptions {
  platform?: ZelavisServiceSetupPlatformContext;
}

export interface ZelavisServerOptions {
  rootPath?: string;
  /**
   * How this host runs a Project the Fabric placed on another node.
   *
   * Without one, the local node id still comes from the Fabric options and a
   * Project placed elsewhere is left stopped rather than started here — which
   * is what makes placement authoritative rather than advisory. Supplying a
   * dispatcher is the Agent execution path.
   */
  projectDispatcher?: ZelavisProjectDispatcher;
  api?: ZelavisApiOptions;
  servicePackageInstaller?: ZelavisServicePackageInstaller;
  serviceActivation?: ZelavisServiceActivationController;
  serviceContext?: ZelavisServiceContextOptions;
  subsystems?: ZelavisSubsystemOptions;
  /**
   * What this runtime is.
   *
   * A Platform is its own product and leads `/` to its root path, whether that
   * shows an installed frontend or the page explaining none is installed. A
   * Project exists to host something not yet chosen, so `/` serves its own
   * "no frontend yet" placeholder — a 503 that is deliberately not indexed —
   * rather than bouncing to a Platform page.
   *
   * This used to be carried by `frontend: false`, which read as a preference
   * and was really a statement about the kind of runtime.
   */
  role?: "platform" | "project";
  /** Where Platform runtime settings persist. Supplied from host resources. */
  runtimeSettingsStore?: ZelavisDashboardSettingsStore;
  servicePrefixes?: Record<string, string>;
  pathOverrides?: Record<string, string>;
  onError?: ZelavisServerErrorHandler;
  /** Internal host authority bridge used by adapters and low-level composition. */
  resolvePrincipal?: ZelavisPrincipalResolver;
  /**
   * Backing store for service `app` bundles. When omitted, the runtime
   * tries to wrap `platform.resources.files` in a default
   * `SharedBundleStore`. Services that declare an `app` field but have no
   * `BundleStore` available will still mount, but their asset routes
   * return 404 until a store is configured.
   */
  bundleStore?: BundleStore;
  /**
   * Frontend serving this installation's root path.
   *
   * The Platform names no frontend of its own. Supply one — `@zelavis/ui` is
   * the default product choice — or leave it out: the API is identical either
   * way, and the root path says no frontend is installed rather than 404ing.
   */
  frontend?: ZelavisFrontendInput;
  /**
   * Domain bindings store. Extension service apps only get host-bound
   * routing for hosts with verified bindings owned by their project or
   * service. Service packages declare `app.domainPolicy`; concrete hostnames
   * live in runtime activation state.
   *
   * When omitted, the runtime falls through to
   * `platform.resources.domainBindings`; if neither is set, extension
   * services get no host-bound routing.
   */
  domainBindings?: DomainBindingStore;
  systemStore?: ZelavisSystemStore;
  projectRuntime?: ZelavisProjectRuntimeDriver;
  /** Host-provided deployment backend probes. Platform policy remains in the System Store. */
  deploymentBackends?: readonly ZelavisDeploymentBackendAdapter[];
  /** Read-only connection to a separately supervised Agent operation journal. */
  agentOperations?: ZelavisAgentOperationReader;
  /** Issues authority for release-signed host operations on a supervised Agent. */
  hostOperations?: ZelavisHostOperationBroker;
  /** Provider-neutral remote environment boundary for agent execution. */
  remoteEnvironment?: ZelavisRemoteEnvironment;
  /** Proxy-neutral ingress authority. Concrete proxy execution stays host-provided. */
  edge?: ZelavisEdgeManager;
  /** Canonical route and hostname authority. Defaults to System Store backing. */
  edgeRoutes?: ZelavisEdgeRouteStore;
  /** Edge certificate authority and ACME controller. */
  edgeCertificates?: ZelavisCertificateController;
  assistant?: false | ZelavisAssistantResponder;
  bootstrap?: {
    /** One-time secret required to claim the first Platform owner account. */
    token: string;
  };
}

interface ZelavisRuntimeCompositionOptions extends ZelavisServerOptions {
  serviceRegistry?: ZelavisServiceRegistryOptions;
}



export interface ZelavisServicePackageInstallInput {
  fileName: string;
  contentType?: string;
  body: Uint8Array;
}

export interface ZelavisServicePackageInstallResult {
  specifier: string;
  message?: string;
}

export interface ZelavisServicePackageAcquireInput {
  /** `npm:<name>@<version>` or an https archive URL. */
  reference: string;
}

export interface ZelavisServicePackageAcquireResult
  extends ZelavisServicePackageInstallResult {
  /** What was installed, with any dist-tag resolved to a version. */
  resolved: string;
  /** The digest that was verified against the bytes received. */
  integrity: string;
}

export interface ZelavisServicePackageScaffoldInput {
  /** The create package: `npm:create-<name>@<version>`. */
  reference: string;
  /**
   * Which of the package's commands to run.
   *
   * Only needed when the package declares more than one. Guessing which
   * command scaffolds a project is how a run silently produces the wrong
   * thing, so an ambiguous package is refused instead.
   */
  command?: string;
  /** Arguments passed through to the create package. */
  args?: readonly string[];
}

export interface ZelavisServicePackageInstaller {
  install(
    input: ZelavisServicePackageInstallInput,
  ):
    | Promise<ZelavisServicePackageInstallResult>
    | ZelavisServicePackageInstallResult;
  /**
   * Acquires a package from a remote source.
   *
   * Optional: a host that only accepts uploads implements `install` alone, and
   * an installation without it refuses source references rather than silently
   * treating them as something else.
   */
  acquire?(
    input: ZelavisServicePackageAcquireInput,
  ):
    | Promise<ZelavisServicePackageAcquireResult>
    | ZelavisServicePackageAcquireResult;
  /**
   * Scaffolds a frontend package by running a `create-*` package.
   *
   * Optional, and gated on the same source policy as `acquire`, because it
   * begins with the same verified acquisition: a host that acquires nothing
   * has no create package to run. The result is a specifier the registry
   * installs like any other package.
   */
  scaffold?(
    input: ZelavisServicePackageScaffoldInput,
  ):
    | Promise<ZelavisServicePackageAcquireResult>
    | ZelavisServicePackageAcquireResult;
}

export interface ZelavisPlatformResources {
  systemStore?: ZelavisSystemStore;
  projectRuntime?: ZelavisProjectRuntimeDriver;
  deploymentBackends?: readonly ZelavisDeploymentBackendAdapter[];
  agentOperations?: ZelavisAgentOperationReader;
  /** Issues authority for release-signed host operations on a supervised Agent. */
  hostOperations?: ZelavisHostOperationBroker;
  remoteEnvironment?: ZelavisRemoteEnvironment;
  /** Proxy-neutral ingress authority. */
  edge?: ZelavisEdgeManager;
  /** Canonical route and hostname authority. */
  edgeRoutes?: ZelavisEdgeRouteStore;
  /** Edge certificate authority and ACME controller. */
  edgeCertificates?: ZelavisCertificateController;
  kv?: ZelavisKeyValueStore;
  files?: ZelavisFileStorage;
  services?: ZelavisServiceActivationController;
  servicePackages?: ZelavisServicePackageInstaller;
  /**
   * TLS certificate provider. Adapters that terminate TLS in-process
   * (Node/Bun self-host) wire a real provider here; adapters behind a reverse
   * proxy can wire `createExternalTlsProvider()` so downstream code can distinguish
   * "intentionally handled elsewhere" from "not configured".
   */
  tls?: TlsProvider;
  /**
   * Domain-binding store. The synthesizer consults this for
   * extension-scoped service apps — only hosts with verified bindings
   * owned by the service's project or service are allowed through.
   * System-scope services skip this check (operator deployed them,
   * they're trusted).
   *
   * When undefined, extension services get no host-bound routing
   * (their path-based `/apps/<name>` mount still works).
   */
  domainBindings?: DomainBindingStore;
}

export interface ZelavisPlatformContext {
  presets: readonly string[];
  resources: ZelavisPlatformResources;
  metadata: Record<string, unknown>;
}

export interface ZelavisResolvedPlatformOptions
  extends Partial<ZelavisRuntimeCompositionOptions> {
  resources?: ZelavisPlatformResources;
  metadata?: Record<string, unknown>;
}

export interface ZelavisAdapterDefinition {
  name: string;
  resolve?(
    options: ZelavisOptions,
  ):
    | Promise<ZelavisResolvedPlatformOptions>
    | ZelavisResolvedPlatformOptions;
}

export interface ZelavisAdapter {
  name: string;
  resolve?(
    options: ZelavisOptions,
  ):
    | Promise<ZelavisResolvedPlatformOptions>
    | ZelavisResolvedPlatformOptions;
}

export interface ZelavisServiceActivationRequest {
  serviceName: string;
  action: "register" | "install" | "uninstall" | "update";
  specifier?: string;
  registry: readonly ZelavisServiceRegistryStateEntry[];
}

export interface ZelavisServiceActivationResult {
  status: "active" | "pending";
  message?: string;
}

export interface ZelavisServiceActivationCapabilities {
  strategy: "runtime-graph" | "external";
  supportsRuntimeInstall: boolean;
  supportsUploadedSpecifiers: boolean;
  supportsPackageUploads: boolean;
  /**
   * Whether packages can be acquired from remote sources.
   *
   * False both when the host cannot acquire at all and when it can but has no
   * trusted sources configured — a caller offering an install action needs to
   * know whether it will work, not whether the code exists. Hosts express this
   * by exposing `acquire` only when acquisition is actually available.
   */
  supportsPackageAcquisition: boolean;
  /**
   * Whether a frontend can be scaffolded by running a `create-*` package.
   *
   * Separate from acquisition because it is a stronger claim: the host has to
   * be able to run a child process under the isolation the scaffold requires,
   * not only download and unpack bytes.
   */
  supportsFrontendScaffolding?: boolean;
  supportsIsolatedExecution: boolean;
  description?: string;
}

export interface ZelavisServiceActivationController {
  mode: "runtime" | "host";
  capabilities: ZelavisServiceActivationCapabilities;
  activate(
    request: ZelavisServiceActivationRequest,
  ): Promise<ZelavisServiceActivationResult> | ZelavisServiceActivationResult;
}

export interface ZelavisOptions {
  rootPath?: string;
  api?: ZelavisApiOptions;
  /**
   * Frontend serving this installation's root path.
   *
   * Omit it and the API is unchanged while the root path says no frontend is
   * installed. The Platform names none of its own.
   */
  frontend?: ZelavisFrontendInput;
  assistant?: false | ZelavisAssistantResponder;
  onError?: ZelavisServerErrorHandler;
  adapter?: ZelavisAdapter;
  bootstrap?: {
    /** One-time secret required to claim the first Platform owner account. */
    token: string;
  };
}


export function defineAdapter(
  definition: ZelavisAdapterDefinition,
): ZelavisAdapter {
  return definition;
}

const RESERVED_CORE_SERVICE_NAMES = new Set([
  "zelavis/app",
  "zelavis/auth",
  "zelavis/platform",
  "@zelavis/marketplace",
  "@zelavis/auth",
  "zelavis/fabric",
  "@zelavis/ui",
  "@zelavis/ui:app",
  "@zelavis/db",
  "@zelavis/storage",
  "@zelavis/frontend",
  "@zelavis/workloads",
  "zelavis-domain-challenge",
]);


function readOptionalProcessEnv(name: string): string | undefined {
  const runtimeProcess = (
    globalThis as typeof globalThis & {
      process?: {
        env?: Record<string, string | undefined>;
        versions?: {
          node?: string;
        };
      };
    }
  ).process;

  return runtimeProcess?.env?.[name];
}






function normalizeBundleAssetPath(path: string): string {
  const normalized = path.replace(/^\/+/, "").replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new ZelavisValidationError(
      "Service page file must be a bundle-relative path.",
    );
  }

  return segments.join("/");
}

const SERVICE_ASSET_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function guessServiceAssetContentType(path: string): string {
  const dotIndex = path.lastIndexOf(".");
  if (dotIndex < 0) {
    return "application/octet-stream";
  }

  return (
    SERVICE_ASSET_CONTENT_TYPES[path.slice(dotIndex).toLowerCase()] ??
    "application/octet-stream"
  );
}


function normalizeExternalUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return new URL(trimmed).toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}



function detectCurrentRuntimeEngine(
  metadata?: Record<string, unknown>,
): ZelavisRuntimeEngine {
  const declared = metadata?.runtime;
  if (isRuntimeEngine(declared)) {
    return declared;
  }

  const globals = globalThis as typeof globalThis & {
    Bun?: unknown;
    Deno?: unknown;
  };

  if (globals.Bun) {
    return "bun";
  }

  if (globals.Deno) {
    return "deno";
  }

  return "node";
}





function toBase64(bytes: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const value = (first << 16) | (second << 8) | third;

    result += alphabet[(value >> 18) & 63];
    result += alphabet[(value >> 12) & 63];
    result += index + 1 < bytes.length ? alphabet[(value >> 6) & 63] : "=";
    result += index + 2 < bytes.length ? alphabet[value & 63] : "=";
  }

  return result;
}

function isServiceUploadFile(value: unknown): value is Blob & { name?: string } {
  return (
    typeof Blob !== "undefined" &&
    value instanceof Blob &&
    typeof value.arrayBuffer === "function"
  );
}























function readDashboardServiceRegistryUpdate(
  body: unknown,
): Omit<ZelavisServiceRegistryStateEntry, "name"> {
  const input = readBodyObject(body);
  const update: Omit<ZelavisServiceRegistryStateEntry, "name"> = {};

  if ("status" in input) {
    if (input.status !== "installed" && input.status !== "available") {
      throw new ZelavisValidationError(
        'Service status must be "installed" or "available".',
      );
    }

    update.status = input.status;
  }

  if ("source" in input) {
    if (
      input.source !== undefined &&
      input.source !== "official" &&
      input.source !== "community"
    ) {
      throw new ZelavisValidationError(
        'Service source must be "official" or "community" when provided.',
      );
    }

    update.source = input.source;
  }

  if ("order" in input) {
    if (
      input.order !== undefined &&
      (typeof input.order !== "number" ||
        !Number.isInteger(input.order) ||
        input.order < 0)
    ) {
      throw new ZelavisValidationError(
        "Service order must be a non-negative integer when provided.",
      );
    }

    update.order = input.order as number | undefined;
  }

  return update;
}

async function readDashboardServiceRegistryCreate(
  body: unknown,
  options: {
    importer?: ZelavisServiceLoadOptions["importer"];
    manifestResolver?: ZelavisServiceLoadOptions["manifestResolver"];
    packageInstaller?: ZelavisServicePackageInstaller;
  } = {},
): Promise<ZelavisServiceRegistryStateEntry> {
  const input = readBodyObject(body);
  const explicitName = typeof input.name === "string" ? input.name.trim() : "";
  let specifier =
    typeof input.specifier === "string" ? input.specifier.trim() : "";
  const uploadedFile = input.file;
  const sourceReference =
    typeof input.packageSource === "string" ? input.packageSource.trim() : "";

  const scaffoldReference =
    typeof input.scaffoldFrom === "string" ? input.scaffoldFrom.trim() : "";

  if (!specifier && sourceReference) {
    if (!options.packageInstaller?.acquire) {
      throw new ZelavisValidationError(
        "This installation cannot acquire packages from remote sources.",
      );
    }

    const acquired = await options.packageInstaller.acquire({
      reference: sourceReference,
    });
    specifier = acquired.specifier;
  }

  // Scaffolding produces a package the same way acquiring one does, so it
  // joins the registry through the same path rather than a parallel install
  // flow that would have to repeat the loading and naming below.
  if (!specifier && scaffoldReference) {
    if (!options.packageInstaller?.scaffold) {
      throw new ZelavisValidationError(
        "This installation cannot scaffold a frontend from a create package.",
      );
    }

    const scaffolded = await options.packageInstaller.scaffold({
      reference: scaffoldReference,
      ...(typeof input.scaffoldCommand === "string" && input.scaffoldCommand.trim()
        ? { command: input.scaffoldCommand.trim() }
        : {}),
      ...(Array.isArray(input.scaffoldArgs)
        ? {
            args: input.scaffoldArgs.filter(
              (value): value is string => typeof value === "string",
            ),
          }
        : {}),
    });
    specifier = scaffolded.specifier;
  }

  if (!specifier && isServiceUploadFile(uploadedFile)) {
    const bytes = new Uint8Array(await uploadedFile.arrayBuffer());

    if (options.packageInstaller) {
      const installed = await options.packageInstaller.install({
        fileName:
          typeof uploadedFile.name === "string" && uploadedFile.name.trim()
            ? uploadedFile.name
            : "service.zip",
        contentType:
          typeof uploadedFile.type === "string" && uploadedFile.type.trim()
            ? uploadedFile.type
            : undefined,
        body: bytes,
      });
      specifier = installed.specifier;
    } else {
      specifier = `data:text/javascript;base64,${toBase64(bytes)}`;
    }
  }

  if (!specifier) {
    throw new ZelavisValidationError(
      "Service module file or ESM specifier is required.",
    );
  }

  let serviceName = explicitName;

  if (!serviceName) {
    try {
      const service = await loadService<ZelavisServiceSetupContext>(specifier, {
        importer: options.importer,
        manifestResolver: options.manifestResolver,
      });
      serviceName = service.name;
    } catch (error) {
      throw new ZelavisValidationError(
        `Service module could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return parseStoredServiceRegistryStateEntry({
    name: serviceName,
    specifier,
    status: input.status ?? "available",
    source: input.source ?? "community",
    ...(input.order !== undefined ? { order: input.order } : {}),
  });
}

const defaultDashboardServiceRegistry = createServiceRegistry<ZelavisServiceSetupContext>([]);

async function loadStoredServiceRegistryModules(
  entries: readonly ZelavisServiceRegistryStateEntry[] | undefined,
  importer?: ZelavisServiceLoadOptions["importer"],
  manifestResolver?: ZelavisServiceLoadOptions["manifestResolver"],
): Promise<readonly Readonly<ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>>[]> {
  const moduleEntries = (entries ?? [])
    .filter((entry) => entry.specifier)
    .map((entry) => ({
      specifier: entry.specifier as string,
      status: entry.status ?? "available",
      source: entry.source ?? "community",
      ...(entry.order !== undefined ? { order: entry.order } : {}),
    }));

  if (moduleEntries.length === 0) {
    return [];
  }

  const resolvedEntries: Readonly<
    ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>
  >[] = [];

  for (const entry of moduleEntries) {
    try {
      const loaded = await loadServiceRegistry<ZelavisServiceSetupContext>(
        [entry],
        { importer, ...(manifestResolver ? { manifestResolver } : {}) },
      );

      // Runtime-installed services are always extension-scoped regardless of
      // what `scope` or `menu.surface` their definition declares. Trust is
      // granted by the registration path (static), not the definition itself.
      const scoped = loaded.map((registryEntry) => {
        if (!registryEntry.service) {
          return registryEntry;
        }

        const service = registryEntry.service;
        const needsPatch =
          service.scope !== "extension" ||
          (service.menu && "surface" in service.menu && service.menu.surface !== undefined);

        if (!needsPatch) {
          return registryEntry;
        }

        return Object.freeze({
          ...registryEntry,
          service: Object.freeze({
            ...service,
            scope: "extension" as const,
            menu: service.menu
              ? Object.freeze({ ...service.menu, surface: undefined })
              : service.menu,
          }),
        });
      });

      resolvedEntries.push(...scoped);
    } catch {
      continue;
    }
  }

  return resolvedEntries;
}

/**
 * Resolves configured catalog entries.
 *
 * A specifier is authoritative when it resolves: callers such as the project
 * runner deliberately pass a metadata-only placeholder alongside the specifier
 * and rely on the loaded module for the real menu, setup, and runtime services.
 *
 * When the specifier cannot be resolved from this package the entry's own
 * service instance is used instead. A host application registering a plugin it
 * depends on (`services.catalog`) names that package by specifier for registry
 * identity, but the package is installed for the application, not for
 * `zelavis`, so importing it from here would fail.
 */
async function loadConfiguredServiceRegistryModules(
  entries: readonly ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>[],
  importer?: ZelavisServiceLoadOptions["importer"],
  manifestResolver?: ZelavisServiceLoadOptions["manifestResolver"],
): Promise<readonly Readonly<ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>>[]> {
  const resolved: Readonly<ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>>[] = [];

  for (const entry of entries) {
    if (!entry.specifier) {
      resolved.push(...createServiceRegistry([entry]));
      continue;
    }

    let loaded: Readonly<ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>> | undefined;
    try {
      [loaded] = await loadServiceRegistry<ZelavisServiceSetupContext>(
        [
          {
            specifier: entry.specifier,
            status: entry.status,
            source: entry.source,
            ...(entry.order !== undefined ? { order: entry.order } : {}),
          },
        ],
        { importer, ...(manifestResolver ? { manifestResolver } : {}) },
      );
    } catch {
      // The specifier is not resolvable from `zelavis`; the caller supplied the
      // live service instance, so register that instead.
      resolved.push(...createServiceRegistry([entry]));
      continue;
    }

    resolved.push(
      entry.service.scope === undefined
        ? loaded
        : Object.freeze({
            ...loaded,
            service: Object.freeze({
              ...loaded.service,
              scope: entry.service.scope,
            }),
          }),
    );
  }

  return createServiceRegistry(resolved);
}

function createServiceSetupPlatformContext(
  platform?:
    | Partial<ZelavisPlatformContext>
    | ZelavisServiceSetupPlatformContext,
): ZelavisServiceSetupPlatformContext {
  const resources = platform?.resources;
  const keyValueStore =
    resources && "keyValueStore" in resources
      ? resources.keyValueStore
      : resources && "kv" in resources
        ? Boolean(resources.kv)
        : false;
  const fileStorage =
    resources && "fileStorage" in resources
      ? resources.fileStorage
      : resources && "files" in resources
        ? Boolean(resources.files)
        : false;

  return {
    presets: Object.freeze([...(platform?.presets ?? [])]),
    resources: {
      keyValueStore,
      fileStorage,
    },
    metadata: Object.freeze({ ...(platform?.metadata ?? {}) }),
  };
}


function isDatabaseRuntimeApi(value: unknown): value is DatabaseRuntimeApi {
  return Boolean(
    value &&
    typeof value === "object" &&
    "forTenant" in value &&
    "topology" in value,
  );
}

interface ResolvedDatabaseSubsystem {
  readonly api: DatabaseRuntimeApi;
  /** Present only when this runtime opened the shards and therefore owns them. */
  readonly close?: () => Promise<void>;
}

/**
 * Opens the Platform's database, or adopts one it was handed.
 *
 * The opener lives behind a dynamic import because it is the one part of the
 * database that is host-specific — it reaches for `node:sqlite` and the
 * filesystem — and the composition entry point stays runtime-neutral. A host
 * that opens its own instance never loads it.
 */
async function resolveDatabaseCoreService(
  option: ZelavisDatabaseOptions | undefined,
): Promise<ResolvedDatabaseSubsystem | undefined> {
  if (option === undefined || option === false) {
    return undefined;
  }

  const resolved = await option;
  if (isDatabaseRuntimeApi(resolved)) {
    return { api: resolved };
  }

  const { openNodeDatabase } = await import("./db/node-host.js");
  const opened = await openNodeDatabase(resolved);
  return { api: opened.api, close: opened.close };
}

async function resolveAuthCoreService(
  option: ZelavisAuthOptions | undefined,
  methods: readonly AuthMethodPlugin[] = [],
  systemStore?: ZelavisSystemStore,
  registryEntries: readonly Readonly<
    ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>
  >[] = [],
  methodServiceNames: ReadonlyMap<AuthMethodPlugin, string> = new Map(),
  rootPath = "/zelavis",
  bootstrapToken?: string,
): Promise<ZelavisRuntimeService<any> | undefined> {
  const authOption = option ?? true;

  if (authOption === false) {
    return undefined;
  }

  const configured = authOption === true ? {} : authOption;
  const oauth = createOAuthProviderRuntime({
    ...(configured.oauth ?? {}),
    environmentConnections: true,
  });
  // Password sign-in ships with Zelavis. It used to be a plugin the
  // distribution copied into the product-services folder on first boot,
  // because an installation with no credential provider can never create its
  // first owner — mandatory in everything but name.
  const builtInMethods: AuthMethodPlugin[] = [
    {
      name: PASSWORD_PROVIDER,
      register(api) {
        api.authentication.registerProvider(
          createPasswordProvider(configured.password ?? {}),
        );
      },
    },
    oauth.method,
  ];
  const auth = configured.auth ?? await createAuth({
    ...(configured.authOptions ?? {}),
    repositories: {
      ...(systemStore ? createPlatformAuthRepositories(systemStore) : {}),
      ...(configured.authOptions?.repositories ?? {}),
    },
    // Installed providers only. Handing credential providers to composition in
    // code was a second way to supply a service, and the two disagreed: a
    // provider passed here never appeared in the registry, so it could not be
    // listed, disabled, or updated like the same provider installed normally.
    methods: [...builtInMethods, ...methods],
    // Each method sees the installed services and gets storage scoped to the
    // service that supplied it, so a plugin hosting other plugins' providers
    // can find them and read what an operator configured. Registration runs
    // before service setup, so this is the only point where it can.
    methodContext: (method) => ({
      registry: registryEntries as AuthMethodContext["registry"],
      ...(systemStore
        ? { store: createServiceStore(systemStore, methodServiceNames.get(method) ?? method.name) }
        : {}),
    }),
  });

  return createAuthService({
    ...configured,
    auth,
    methods: [],
    definition: {
      ...(configured.definition ?? {}),
      authority: "platform",
      bootstrap: createPlatformAuthBootstrap(auth, { store: systemStore }),
      oauthConnections: oauth.connections,
      bootstrapToken,
      sessionCookie: configured.definition?.sessionCookie === false
        ? false
        : {
            path: rootPath,
            ...(configured.definition?.sessionCookie ?? {}),
          },
    },
  });
}

/** The capability a credential provider declares to extend Platform auth. */
export const ZELAVIS_AUTH_CREDENTIALS_CAPABILITY = serviceCapabilityFor(
  "zelavis/auth",
  "credentials",
);

/**
 * Finds the credential providers installed on this Platform.
 *
 * Providers are ordinary installed services found by capability, and this is
 * now the only way one reaches auth: there is no option for handing providers
 * to the constructor. A provider arrives by being installed, which means the
 * same path whether it came from the product-services folder, the registry
 * endpoints, or the marketplace.
 *
 * The capability names the plugin being extended rather than a bare domain, so
 * a provider written for Platform auth is not also collected by some other
 * service that happens to want credentials.
 */
/** Maps each collected method back to the service that supplied it. */
function collectAuthMethodServiceNames(
  registry: readonly Readonly<ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>>[],
): ReadonlyMap<AuthMethodPlugin, string> {
  const names = new Map<AuthMethodPlugin, string>();
  for (const entry of registry) {
    const method = entry.service.service as AuthMethodPlugin | undefined;
    if (typeof method?.register === "function") {
      names.set(method, entry.service.name);
    }
  }
  return names;
}

function collectAuthMethodPlugins(
  registry: readonly Readonly<ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>>[],
): readonly AuthMethodPlugin[] {
  return Object.freeze(
    registry
      .filter(
        (entry) =>
          entry.status === "installed" &&
          declaresServiceCapability(
            entry.service.capabilities,
            "zelavis/auth",
            "credentials",
          ) &&
          typeof (entry.service.service as AuthMethodPlugin | undefined)?.register === "function",
      )
      .map((entry) => entry.service.service as AuthMethodPlugin),
  );
}

type DashboardServicePageReference = {
  id: string;
  title?: string;
  file?: string;
  src: string;
};

type DashboardSerializedServiceMenuDefinition = Omit<
  ZelavisServiceMenuDefinition,
  "items" | "page"
> & {
  page?: DashboardServicePageReference;
  items?: readonly DashboardSerializedServiceMenuDefinition[];
};

function createDashboardAccess(principal: NonNullable<ZelavisServerExecutionContext["principal"]>) {
  const mode = principal.roles?.includes("owner")
    ? "owner"
    : principal.roles?.includes("operator")
      ? "operator"
      : principal.roles?.includes("reseller")
        ? "reseller"
        : "customer";
  return {
    mode,
    label: mode[0].toUpperCase() + mode.slice(1),
    principal,
  };
}

interface ZelavisRuntimeManagementCore {
  createRuntimeConfig: () => Promise<unknown>;
  routes: readonly ZelavisServerRoute<any>[];
}

async function resolveRuntimeManagementCore(
  option: ZelavisFrontendInput | undefined,
  context: {
    apiPrefix: string;
    apiVersion: string;
    serviceRegistry: readonly Readonly<
      ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>
    >[];
    serviceRegistryStore: ZelavisServiceRegistryStore;
    serviceImporter?: ZelavisServiceLoadOptions["importer"];
    serviceManifestResolver?: ZelavisServiceLoadOptions["manifestResolver"];
    servicePackageInstaller?: ZelavisServicePackageInstaller;
    serviceActivation?: ZelavisServiceActivationController;
    rootPath: string;
    getServices: () => readonly ZelavisRuntimeService<any>[];
    settingsStore?: ZelavisDashboardSettingsStore;
    siteEnabled: boolean;
    bundleStore?: BundleStore;
    platform?: ZelavisServiceSetupPlatformContext;
    /**
     * The routes this runtime actually mounted.
     *
     * Late-bound, because mounting happens after this core is composed. The
     * spec used to re-resolve endpoints from the service list with a different
     * prefix and no service prefixes, so it published paths that did not
     * exist: `/api/auth/accounts` for an endpoint served at
     * `/zelavis/api/v1/auth/accounts`.
     */
    getMountedRoutes?: () => readonly ZelavisResolvedRoute[];
    /** Paths the installed frontend resolves client-side, if any. */
    frontendClientRoutes?: readonly string[];
    /** Design tokens the installed frontend supplies for service pages. */
    servicePageStylesheet?: string;
    serviceElementsScript?: string;
    /** Name of the service serving the root path, whichever frontend that is. */
    frontendServiceName?: string;
  },
): Promise<ZelavisRuntimeManagementCore> {
  const options = readFrontendOptions(option);
  const title = options.title ?? "zelavis";
  const rootPath = context.rootPath;
  const currentRuntimeEngine = detectCurrentRuntimeEngine(
    context.platform?.metadata,
  );
  const availableRuntimeEngines: readonly ZelavisRuntimeEngine[] = [
    "node",
    "bun",
    "deno",
  ];
  const settingsStore =
    context.settingsStore ?? createMemoryDashboardSettingsStore();
  const clientRoutes = [
    ...new Set(
      (options.clientRoutes ?? context.frontendClientRoutes ?? [])
        .map((route: string) => normalizePath(route, "/"))
        .filter((route: string) => route !== "/"),
    ),
  ];
  const readResolvedServiceRegistry = async (
    entries?: readonly ZelavisServiceRegistryStateEntry[],
  ) => {
    const storedEntries = entries ?? await context.serviceRegistryStore.read();
    const storedServiceRegistry = await loadStoredServiceRegistryModules(
      storedEntries,
      context.serviceImporter,
      context.serviceManifestResolver,
    );

    // Static services (passed directly to zelavis()) are system-scoped — they
    // can use any dashboard surface. Runtime-installed services are already
    // forced to extension scope inside loadStoredServiceRegistryModules.
    const systemServiceRegistry = context.serviceRegistry.map((entry) =>
      entry.service.scope === "system"
        ? entry
        : Object.freeze({
            ...entry,
            service: Object.freeze({ ...entry.service, scope: "system" as const }),
          }),
    );

    const knownServiceNames = new Set(
      systemServiceRegistry.map((entry) => entry.service.name),
    );
    const completeServiceRegistry = createServiceRegistry([
      ...systemServiceRegistry,
      ...storedServiceRegistry.filter(
        (entry) => !knownServiceNames.has(entry.service.name),
      ),
    ]);

    return applyServiceRegistryState(completeServiceRegistry, storedEntries);
  };
  const serializeServiceMenuForDashboard = (
    serviceName: string,
    menu: ZelavisServiceMenuDefinition | undefined,
  ): DashboardSerializedServiceMenuDefinition | undefined => {
    if (!menu) {
      return undefined;
    }

    return {
      ...menu,
      page: menu.page
        ? {
            id: menu.page.id,
            title: menu.page.title,
            file: menu.page.file,
            src: joinPathParts(
              rootPath,
              context.apiPrefix,
              context.apiVersion,
              "runtime",
              "service-page-assets",
              encodeURIComponent(serviceName),
              joinPathParts(
                encodeURIComponent(menu.page.bundle ?? "dist"),
                encodeStoragePath(normalizeBundleAssetPath(menu.page.file)),
              ).replace(/^\/+/, ""),
            ),
          }
        : undefined,
      items: menu.items?.map((item) =>
        serializeServiceMenuForDashboard(serviceName, item),
      ) as readonly DashboardSerializedServiceMenuDefinition[] | undefined,
    };
  };
  const renderServicePageAsset = async (
    serviceName: string,
    bundle: string,
    assetPath: string,
  ) => {
    const serviceRegistry = await readResolvedServiceRegistry();
    const registryEntry = serviceRegistry.find(
      (candidate) => candidate.service.name === serviceName,
    );
    // Core services are composed into the runtime rather than installed
    // through the registry, so they never appear above. They still own pages,
    // and a page must not depend on how its service arrived.
    const coreService = registryEntry
      ? undefined
      : context
          .getServices()
          .find((candidate) => candidate.name === serviceName);

    const entry =
      registryEntry?.status === "installed"
        ? registryEntry
        : coreService
          ? { service: coreService as ZelavisServiceRegistryEntry<any>["service"] }
          : undefined;

    if (!entry) {
      return {
        status: 404,
        body: {
          error: "Service asset not found.",
        },
      };
    }

    const normalizedPath = normalizeBundleAssetPath(assetPath);

    // Static service page assets served directly from disk (classic webspace behavior).
    // If the service has a package directory on disk, resolve files within it.
    let packageDir = entry.service.packageDir ?? (entry as any).packageDir;
    if (typeof packageDir === "string" && packageDir.startsWith("file://")) {
      try {
        const { fileURLToPath } = await import("node:url");
        packageDir = fileURLToPath(packageDir);
      } catch {
        // ignore
      }
    }

    if (!packageDir && (entry as any).specifier) {
      const spec = (entry as any).specifier as string;
      if (spec.startsWith("file://") || spec.startsWith("/") || spec.startsWith(".")) {
        try {
          const { fileURLToPath } = await import("node:url");
          const { dirname, join } = await import("node:path");
          const { stat, readFile } = await import("node:fs/promises");
          const filePath = spec.startsWith("file://") ? fileURLToPath(spec) : spec;
          const s = await stat(filePath).catch(() => undefined);
          if (s?.isDirectory()) {
            packageDir = filePath;
          } else if (s?.isFile()) {
            let cur = dirname(filePath);
            while (cur !== dirname(cur)) {
              const hasPkg = await readFile(join(cur, "package.json")).then(
                () => true,
                () => false,
              );
              if (hasPkg) {
                packageDir = cur;
                break;
              }
              cur = dirname(cur);
            }
            if (!packageDir) {
              packageDir = dirname(filePath);
            }
          }
        } catch {
          // ignore
        }
      }
    }

    if (packageDir) {
      try {
        const { resolve, join, sep } = await import("node:path");
        const { stat, readFile } = await import("node:fs/promises");
        const root = resolve(packageDir);

        const isContained = (candidate: string) => {
          const res = resolve(candidate);
          return res === root || res.startsWith(`${root}${sep}`);
        };

        const cleanBundle = bundle.replace(/^[/\\]+/, "");
        const cleanPath = normalizedPath.replace(/^[/\\]+/, "");

        const candidates = [
          join(root, cleanBundle, cleanPath),
          join(root, cleanPath),
        ];

        for (const candidate of candidates) {
          if (isContained(candidate)) {
            try {
              const candidateStat = await stat(candidate);
              if (candidateStat.isFile()) {
                const body = await readFile(candidate);
                const headers = new Headers();
                headers.set(
                  "content-type",
                  guessServiceAssetContentType(candidate),
                );
                headers.set("cache-control", "no-cache");
                return { status: 200, headers, body };
              }
            } catch {
              // File not accessible or not found, try next candidate
            }
          }
        }
      } catch {
        // dynamic import failed in non-node/bun environment
      }
    }

    const asset = await context.bundleStore?.read(
      {
        serviceName: entry.service.name,
        bundle,
      },
      normalizedPath,
    );

    if (!asset) {
      return {
        status: 404,
        body: {
          error: "Service asset not found.",
        },
      };
    }

    const headers = new Headers();
    headers.set(
      "content-type",
      asset.contentType ?? guessServiceAssetContentType(normalizedPath),
    );
    headers.set("cache-control", asset.cacheControl ?? "no-cache");
    if (asset.contentDisposition) {
      headers.set("content-disposition", asset.contentDisposition);
    }

    return {
      status: 200,
      headers,
      body: asset.body,
    };
  };
  const listPluginOperations = () =>
    context.getServices().flatMap((service) =>
      service.namespace
        ? Object.values(service.api ?? {}).flatMap((routes) => routes.flatMap((route) =>
            typeof route.meta?.pluginResource === "string" && typeof route.meta?.pluginAction === "string"
              ? [{
                  namespace: service.namespace,
                  resource: route.meta.pluginResource,
                  action: route.meta.pluginAction,
                  method: route.method,
                  path: joinPathParts(service.basePath, route.path),
                  spec: route.spec,
                }]
              : []))
        : []);
  const createDashboardRuntimeConfig = async () => {
    const serviceRegistry = await readResolvedServiceRegistry();
    const serializedServices = serviceRegistry.map((entry) => ({
      ...publicServiceRegistryIdentity(entry),
      marketplace: entry.service.marketplace,
      // Present only on a service that extends another. A client listing a
      // general catalogue leaves these out and shows them beside the plugin
      // they extend instead.
      extends: serviceExtensionPoints(entry.service),
      project: entry.service.project,
      menu: serializeServiceMenuForDashboard(entry.service.name, entry.service.menu),
      menus: entry.service.menus?.map((menu) =>
        serializeServiceMenuForDashboard(entry.service.name, menu),
      ),
    }));

    return {
      name: "zelavis",
      pluginOperations: listPluginOperations(),
      rootPath,
      api: {
        prefix: context.apiPrefix,
        version: context.apiVersion,
        basePath: joinPathParts(rootPath, context.apiPrefix, context.apiVersion),
      },
      dashboard: {
        title,
        clientRoutes,
        assetRoot: joinPathParts(rootPath, "assets"),
      },
      runtime: {
        engine: currentRuntimeEngine,
        availableEngines: availableRuntimeEngines,
      },
      services: context.getServices().map((service) => ({
        name: service.name,
        namespace: service.namespace,
        kind: service.kind,
        // Composed into the runtime by the operator rather than installed at
        // runtime, which is what "system" means here.
        scope: "system" as const,
        core:
          service.name === context.frontendServiceName ||
          service.name === "zelavis/platform" ||
          service.name === "@zelavis/marketplace" ||
          service.name === "zelavis/fabric" ||
          service.name === "zelavis/auth" ||
          service.name === "@zelavis/db" ||
          service.name === "@zelavis/storage" ||
          service.name === "@zelavis/frontend" ||
          service.name === "@zelavis/workloads",
        apiPath:
          service.name === "@zelavis/frontend"
            ? "/"
            : service.name === context.frontendServiceName
              ? rootPath
              : joinPathParts(
                  rootPath,
                  context.apiPrefix,
                  context.apiVersion,
                  service.basePath ?? service.name,
                ),
        // Serialized the same way registry menus are: a core service's page
        // needs a resolvable `src` too, or the dashboard mounts a frame with
        // nothing in it.
        menu: serializeServiceMenuForDashboard(service.name, service.menu),
        menus: service.menus?.map((menu) =>
          serializeServiceMenuForDashboard(service.name, menu),
        ),
      })),
      serviceRegistry: serializedServices,
      serviceActivation: context.serviceActivation
        ? {
            mode: context.serviceActivation.mode,
            capabilities: {
              ...context.serviceActivation.capabilities,
              supportsPackageUploads: Boolean(context.servicePackageInstaller),
              supportsPackageAcquisition: Boolean(
                context.servicePackageInstaller?.acquire,
              ),
              supportsFrontendScaffolding: Boolean(
                context.servicePackageInstaller?.scaffold,
              ),
            },
          }
        : {
            mode: "host",
            capabilities: {
              strategy: "custom",
              supportsRuntimeInstall: false,
              supportsUploadedSpecifiers: false,
              supportsPackageUploads: false,
              supportsIsolatedExecution: false,
              description:
                "No service activation controller is configured for this runtime.",
            },
      },
    };
  };
  const serializeServiceRegistryForDashboard = async () =>
    {
      const serviceRegistry = await readResolvedServiceRegistry();
      const serialized = serviceRegistry.map((entry) => ({
        ...publicServiceRegistryIdentity(entry),
        // The trust boundary a client needs to render this service's page
        // safely. "extension" means the service was installed at runtime and is
        // not part of what the operator composed; the dashboard sandboxes its
        // page rather than running it with the operator's ambient session.
        scope: entry.service.scope ?? "extension",
        // The API namespace this service owns, which is the only surface a
        // sandboxed page of its own may be brokered access to.
        apiPath: joinPathParts(
          rootPath,
          context.apiPrefix,
          context.apiVersion,
          entry.service.basePath ?? entry.service.name,
        ),
        marketplace: entry.service.marketplace,
        // Present only on a service that extends another. A client listing a
        // general catalogue leaves these out and shows them beside the plugin
        // they extend instead.
        extends: serviceExtensionPoints(entry.service),
        project: entry.service.project,
        menu: serializeServiceMenuForDashboard(entry.service.name, entry.service.menu),
        menus: entry.service.menus?.map((menu) =>
          serializeServiceMenuForDashboard(entry.service.name, menu),
        ),
      }));
      const seen = new Set(serialized.map((entry) => entry.name));
      const storedEntries = await context.serviceRegistryStore.read();

      return [
        ...serialized,
        ...(storedEntries ?? [])
          .filter((entry) => !seen.has(entry.name))
          .map((entry) => ({
            ...publicServiceRegistryIdentity(entry),
          })),
      ];
    };
  const activateServiceRegistryChange = async (
    request: Omit<ZelavisServiceActivationRequest, "registry">,
    registry: readonly ZelavisServiceRegistryStateEntry[],
  ): Promise<ZelavisServiceActivationResult> => {
    if (!context.serviceActivation) {
      return {
        status: "pending",
        message:
          "Service registry state changed. This host has not configured runtime service activation yet.",
      };
    }

    return context.serviceActivation.activate({
      ...request,
      registry,
    });
  };
  const readDashboardSettings = async (): Promise<ZelavisDashboardSettings> => {
    const stored = parseStoredDashboardSettingsUpdate(
      readBodyObject((await settingsStore.read()) ?? {}),
    );
    const storedRootPath = normalizeEditableRootPath(stored.rootPath);
    const pendingRootPath =
      storedRootPath && storedRootPath !== rootPath
        ? storedRootPath
        : undefined;
    const theme = isDashboardThemeMode(stored.theme) ? stored.theme : "auto";
    const pageBuilderEnabled = isBoolean(stored.pageBuilderEnabled)
      ? stored.pageBuilderEnabled
      : false;
    const preferences = stored.preferences ?? {};
    const desiredRuntimeEngine = stored.runtimeEngine ?? currentRuntimeEngine;
    const runtimeEngineRestartRequired =
      desiredRuntimeEngine !== currentRuntimeEngine;

    return {
      rootPath,
      pendingRootPath,
      apiBasePath: joinPathParts(
        rootPath,
        context.apiPrefix,
        context.apiVersion,
      ),
      runtimeEngine: {
        current: currentRuntimeEngine,
        desired: desiredRuntimeEngine,
        available: availableRuntimeEngines,
        restartRequired: runtimeEngineRestartRequired,
      },
      theme,
      pageBuilderEnabled,
      preferences,
      persistence: "runtime",
      editable: {
        rootPath: true,
        runtimeEngine: true,
        theme: true,
        pageBuilder: context.siteEnabled,
      },
      restartRequired: Boolean(pendingRootPath) || runtimeEngineRestartRequired,
    };
  };
  const routes: ZelavisServerRoute<any>[] = [
        {
          id: "runtime.config",
          spec: {
            operationId: "getRuntimeConfig",
            summary: "Read this installation's runtime configuration",
            tags: ["runtime"],
            responses: {
              200: { description: "Runtime configuration, services and menus" },
            },
          },
          method: "GET",
          path: joinPathParts(
            context.apiPrefix,
            context.apiVersion,
            "runtime/config",
          ),
          handler: async () => ({
            status: 200,
            body: await createDashboardRuntimeConfig(),
          }),
        },
        {
          id: "runtime.plugin-operations.list",
          spec: {
            operationId: "listPluginOperations",
            summary: "The installed plugin operation catalogue",
            description:
              "Revisioned by an ETag. Clients revalidate with If-None-Match on every call, so a disabled or uninstalled operation disappears immediately while an unchanged catalogue costs a bodyless 304.",
            tags: ["runtime"],
            responses: {
              200: { description: "Operations and their revision" },
              304: { description: "Unchanged since the revision the client holds" },
            },
          },
          method: "GET",
          path: joinPathParts(
            context.apiPrefix,
            context.apiVersion,
            "runtime/plugin-operations",
          ),
          handler: async ({ request }: { request: Request }) => {
            const operations = listPluginOperations();
            const serialized = JSON.stringify(operations);
            const digest = await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(serialized),
            );
            const revision = [...new Uint8Array(digest)]
              .map((value) => value.toString(16).padStart(2, "0"))
              .join("");
            const etag = `"${revision}"`;
            // Never cached by intermediaries without revalidation: an
            // uninstalled operation must not stay callable from a cache.
            const headers = { etag, "cache-control": "no-cache" };
            const presented = request.headers.get("if-none-match");
            if (presented?.split(",").some((value) => value.trim() === etag)) {
              return { status: 304, headers };
            }
            return { status: 200, headers, body: { revision, operations } };
          },
        },
        {
          id: "runtime.services.read",
          spec: {
            operationId: "listRuntimeServices",
            summary: "List the service registry",
            tags: ["runtime"],
            responses: {
              200: { description: "Registered services and their install state" },
            },
          },
          method: "GET",
          path: joinPathParts(
            context.apiPrefix,
            context.apiVersion,
            "runtime/services",
          ),
          handler: async () => {
            try {
              return {
                status: 200,
                body: {
                  services: await serializeServiceRegistryForDashboard(),
                },
              };
            } catch (error) {
              return zelavisErrorResponse(error, 400);
            }
          },
        },
        {
          id: "runtime.services.sources",
          method: "GET",
          path: joinPathParts(context.apiPrefix, context.apiVersion, "runtime/services/sources"),
          access: { permissions: ["system.services.manage"] },
          spec: {
            operationId: "listRuntimeServiceSources",
            summary: "Inspect private service acquisition references",
            tags: ["runtime"],
            responses: { 200: { description: "Administrative source diagnostics" } },
          },
          handler: async () => {
            const registry = await readResolvedServiceRegistry();
            const names = new Set(registry.map((entry) => entry.service.name));
            const stored = await context.serviceRegistryStore.read();
            return {
              status: 200,
              headers: { "cache-control": "no-store" },
              body: { sources: [
                ...registry.map((entry) => ({ ...publicServiceRegistryIdentity(entry), specifier: entry.specifier })),
                ...(stored ?? []).filter((entry) => !names.has(entry.name))
                  .map((entry) => ({ ...publicServiceRegistryIdentity(entry), specifier: entry.specifier })),
              ] },
            };
          },
        },
        {
          id: "runtime.extensions.read",
          method: "GET",
          path: joinPathParts(
            context.apiPrefix,
            context.apiVersion,
            "runtime/extensions",
          ),
          spec: {
            operationId: "listServiceExtensions",
            summary: "List services that extend another, grouped by what they extend",
            tags: ["runtime"],
            queryParams: {
              owner: {
                type: "string",
                description:
                  "Limit the result to extensions of this service, such as zelavis/auth.",
              },
            },
            responses: {
              200: { description: "Extension points and the services declaring them" },
            },
          },
          handler: async ({ request }: { request: Request }) => {
            try {
              const wanted = new URL(request.url).searchParams.get("owner") ?? undefined;
              const services = await serializeServiceRegistryForDashboard();
              // Composed services count as present. A core service such as
              // `zelavis/auth` never appears in the registry, so a listing
              // built from that alone would report the one thing every auth
              // extension points at as missing.
              const installed = new Set<string>([
                ...services
                  .filter((service: any) => service.status === "installed")
                  .map((service: any) => service.name as string),
                ...context.getServices().map((service) => service.name),
              ]);

              const points = new Map<string, any>();
              for (const service of services as any[]) {
                for (const point of service.extends ?? []) {
                  if (wanted && point.owner !== wanted) continue;
                  const group = points.get(point.owner) ?? {
                    owner: point.owner,
                    // An extension is only usable once what it extends is
                    // there, so a client can say so rather than offering an
                    // install that would do nothing.
                    ownerInstalled: installed.has(point.owner),
                    capabilities: new Set<string>(),
                    extensions: [] as unknown[],
                  };
                  for (const capability of point.capabilities) {
                    group.capabilities.add(capability);
                  }
                  group.extensions.push({
                    name: service.name,
                    version: service.version,
                    status: service.status,
                    source: service.source,
                    capabilities: point.capabilities,
                    marketplace: service.marketplace,
                  });
                  points.set(point.owner, group);
                }
              }

              return {
                status: 200,
                body: {
                  extensionPoints: [...points.values()]
                    .map((group) => ({
                      ...group,
                      capabilities: [...group.capabilities].sort(),
                    }))
                    .sort((left, right) => left.owner.localeCompare(right.owner)),
                },
              };
            } catch (error) {
              return zelavisErrorResponse(error, 400);
            }
          },
        },
        {
          id: "runtime.services.create",
          spec: {
            operationId: "registerRuntimeService",
            summary: "Register a service by specifier or package source",
            tags: ["runtime"],
            responses: {
              200: { description: "Service registered" },
              400: { description: "Invalid registration" },
              409: { description: "Registry mutation conflicted after bounded retries" },
            },
          },
          method: "POST",
          access: { permissions: ["system.services.manage"] },
          path: joinPathParts(
            context.apiPrefix,
            context.apiVersion,
            "runtime/services",
          ),
          handler: async ({ body }: { body: unknown }) => {
            try {
              const created = await readDashboardServiceRegistryCreate(body, {
                importer: context.serviceImporter,
                manifestResolver: context.serviceManifestResolver,
                packageInstaller: context.servicePackageInstaller,
              });
              const nextEntries = await mutateServiceRegistry(context.serviceRegistryStore, (entries) => [
                ...entries.filter((entry) => entry.name !== created.name),
                { ...entries.find((entry) => entry.name === created.name), ...created },
              ]);
              const activation = await activateServiceRegistryChange(
                {
                  serviceName: created.name,
                  action:
                    created.status === "installed" ? "install" : "register",
                  specifier: created.specifier,
                },
                nextEntries,
              );

              return {
                status: 201,
                body: {
                  services: await serializeServiceRegistryForDashboard(),
                  activation,
                },
              };
            } catch (error) {
              return zelavisErrorResponse(error, 400);
            }
          },
        },
        {
          // Linked by service pages, which render in their own document and so
          // inherit nothing from the dashboard. Serving the design tokens at a
          // stable path is what lets a service ship a plain HTML page that
          // still looks like it belongs, without depending on the dashboard's
          // component classes or shipping its own palette.
          id: "runtime.service-page-styles.read",
          spec: {
            operationId: "getServicePageStylesheet",
            summary: "Read the design tokens service pages render against",
            tags: ["runtime"],
            responses: {
              200: { description: "Stylesheet" },
            },
          },
          method: "GET",
          access: { authenticated: true },
          path: joinPathParts(
            context.apiPrefix,
            context.apiVersion,
            "runtime/service-page.css",
          ),
          handler: () => ({
            status: 200,
            headers: new Headers({
              "content-type": "text/css; charset=utf-8",
              "cache-control": "no-cache",
            }),
            body:
              context.servicePageStylesheet ??
              ZELAVIS_BASELINE_SERVICE_PAGE_STYLESHEET,
          }),
        },
        {
          // The components half of the same contract as the stylesheet above.
          // Served as a module so a page's `<script type="module">` has the
          // elements defined before its own first line runs.
          id: "runtime.service-elements.read",
          spec: {
            operationId: "getServicePageElements",
            summary: "Read the component library service pages render with",
            tags: ["runtime"],
            responses: {
              200: { description: "JavaScript module" },
            },
          },
          method: "GET",
          access: { authenticated: true },
          path: joinPathParts(
            context.apiPrefix,
            context.apiVersion,
            "runtime/service-elements.js",
          ),
          handler: () => ({
            status: 200,
            headers: new Headers({
              "content-type": "text/javascript; charset=utf-8",
              "cache-control": "no-cache",
            }),
            body:
              context.serviceElementsScript ??
              ZELAVIS_BASELINE_SERVICE_ELEMENTS,
          }),
        },
        {
          id: "runtime.service-page-asset.read",
          spec: {
            operationId: "getServicePageAsset",
            summary: "Read a page a service ships itself",
            tags: ["runtime"],
            responses: {
              200: { description: "Page asset" },
              404: { description: "No such asset" },
            },
          },
          method: "GET",
          access: { authenticated: true },
          path: joinPathParts(
            context.apiPrefix,
            context.apiVersion,
            "runtime/service-page-assets/:service/:bundle/*path",
          ),
          handler: async ({
            params,
          }: {
            params: Record<string, string>;
          }) => {
            try {
              const serviceName = params.service?.trim();
              const bundle = params.bundle?.trim();
              const assetPath = params.path?.trim();
              if (!serviceName || !bundle || !assetPath) {
                throw new ZelavisValidationError(
                  "Service name, bundle, and asset path are required.",
                );
              }

              return await renderServicePageAsset(
                serviceName,
                bundle,
                assetPath,
              );
            } catch (error) {
              return zelavisErrorResponse(error, 400);
            }
          },
        },
        {
          id: "runtime.services.update",
          spec: {
            operationId: "updateRuntimeService",
            summary: "Install, disable or reorder a registered service",
            tags: ["runtime"],
            responses: {
              200: { description: "Service updated" },
              400: { description: "Invalid update or unmet extension owner" },
              409: { description: "Registry mutation conflicted after bounded retries" },
            },
          },
          method: "PATCH",
          access: { permissions: ["system.services.manage"] },
          path: joinPathParts(
            context.apiPrefix,
            context.apiVersion,
            "runtime/services/:name",
          ),
          handler: async ({ body, params }: { body: unknown; params: Record<string, string> }) => {
            try {
              const serviceName = params.name?.trim();
              if (!serviceName) {
                throw new ZelavisValidationError("Service name is required.");
              }

              const update = readDashboardServiceRegistryUpdate(body);
              const serializedNextEntries = await mutateServiceRegistry(context.serviceRegistryStore, async (currentEntries) => {
                const currentRegistry = await readResolvedServiceRegistry(currentEntries);
                const nextRegistry = createServiceRegistry(
                  currentRegistry.map((entry) =>
                    entry.service.name === serviceName
                      ? {
                          ...entry,
                          ...(update.status ? { status: update.status } : {}),
                          ...(update.source !== undefined
                            ? { source: update.source }
                            : {}),
                          ...(update.order !== undefined
                            ? { order: update.order }
                            : {}),
                        }
                      : entry,
                  ),
                );
                const updatedRegistryEntry = nextRegistry.find(
                  (entry) => entry.service.name === serviceName,
                );
                const updatedStoredEntry = currentEntries.find(
                  (entry) => entry.name === serviceName,
                );

                if (!updatedRegistryEntry && !updatedStoredEntry) {
                  throw new ZelavisValidationError(
                    `Unknown service "${serviceName}".`,
                  );
                }

                // An extension does nothing until what it extends is running:
                // the plugin it points at is what discovers it. Installing one
                // on its own would look like it worked and quietly do nothing.
                if (update.status === "installed" && updatedRegistryEntry) {
                  // Composed services as well as installed registry entries. A
                  // core service like `zelavis/auth` never appears in the
                  // registry, so checking only that would refuse every extension
                  // of one — which is most of them.
                  const installedNames = new Set([
                    ...nextRegistry
                      .filter((entry) => entry.status === "installed")
                      .map((entry) => entry.service.name),
                    ...context.getServices().map((service) => service.name),
                  ]);
                  const missing = serviceExtensionOwners(
                    updatedRegistryEntry.service,
                  ).filter((owner) => !installedNames.has(owner));
                  if (missing.length > 0) {
                    throw new ZelavisValidationError(
                      `"${serviceName}" extends ${missing.join(", ")}, which ${
                        missing.length === 1 ? "is" : "are"
                      } not installed.`,
                    );
                  }
                }

                const base = updatedStoredEntry ?? (updatedRegistryEntry
                  ? serializeServiceRegistryState([updatedRegistryEntry])[0]
                  : undefined);
                const changed = { ...base, name: serviceName, ...update };
                return updatedStoredEntry
                  ? currentEntries.map((entry) => entry.name === serviceName ? changed : entry)
                  : [...currentEntries, changed];
              });
              const activation = await activateServiceRegistryChange(
                {
                  serviceName,
                  action:
                    update.status === "installed"
                      ? "install"
                      : update.status === "available"
                        ? "uninstall"
                        : "update",
                  specifier: serializedNextEntries.find((entry) => entry.name === serviceName)?.specifier,
                },
                serializedNextEntries,
              );

              return {
                status: 200,
                body: {
                  services: await serializeServiceRegistryForDashboard(),
                  activation,
                },
              };
            } catch (error) {
              return zelavisErrorResponse(error, 400);
            }
          },
        },
        {
          id: "runtime.settings.read",
          spec: {
            operationId: "getRuntimeSettings",
            summary: "Read Platform runtime settings",
            tags: ["runtime"],
            responses: {
              200: { description: "Current settings" },
              400: { description: "Stored settings are invalid" },
            },
          },
          method: "GET",
          path: joinPathParts(
            context.apiPrefix,
            context.apiVersion,
            "runtime/settings",
          ),
          handler: async () => {
            try {
              return {
                status: 200,
                body: await readDashboardSettings(),
              };
            } catch (error) {
              return zelavisErrorResponse(error, 400);
            }
          },
        },
        {
          id: "runtime.settings.update",
          spec: {
            operationId: "updateRuntimeSettings",
            summary: "Update Platform runtime settings",
            tags: ["runtime"],
            responses: {
              200: { description: "Settings updated" },
              400: { description: "Invalid settings" },
            },
          },
          method: "PATCH",
          access: { permissions: ["system.settings.manage"] },
          path: joinPathParts(
            context.apiPrefix,
            context.apiVersion,
            "runtime/settings",
          ),
          handler: async ({ body }: { body: unknown }) => {
            try {
              const update = readDashboardSettingsUpdate(body);
              await settingsStore.write(update);

              return {
                status: 200,
                body: await readDashboardSettings(),
              };
            } catch (error) {
              return zelavisErrorResponse(error, 400);
            }
          },
        },
        // Served at both `runtime/openapi` and `runtime/openapi.json`. The
        // extensionless path is what a reader tries first, and answering it
        // with a 404 reads as "this Platform publishes no spec".
        ...["runtime/openapi", "runtime/openapi.json"].map((suffix) => ({
          id: `runtime.openapi${suffix.endsWith(".json") ? "" : ".bare"}`,
          spec: {
            operationId: suffix.endsWith(".json")
              ? "getOpenApiDocumentJson"
              : "getOpenApiDocument",
            summary: "Read the OpenAPI document for this installation",
            description:
              "Describes every route this runtime actually serves, including the ones installed services contribute.",
            tags: ["runtime"],
            responses: {
              200: { description: "OpenAPI 3.1 document" },
            },
          },
          method: "GET" as const,
          path: joinPathParts(context.apiPrefix, context.apiVersion, suffix),
          handler: ({ request }: { request: Request }) => {
            const mounted = context.getMountedRoutes?.();
            const resolved =
              mounted ??
              resolveMountedEndpoints(context.getServices(), {
                prefix: joinPathParts(
                  context.rootPath,
                  context.apiPrefix,
                  context.apiVersion,
                ),
                version: context.apiVersion,
              });
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: generateOpenApiSpec(resolved, {
                title: "Zelavis API",
                version: context.apiVersion,
                description:
                  "Auto-generated OpenAPI specification for this Zelavis instance.",
                // Paths are absolute from the host root, so the server is the
                // origin this document was fetched from. Without it a client
                // has to guess where to send the requests it just read about.
                servers: [{ url: new URL(request.url).origin }],
              }),
            };
          },
        })),
      ];

  const routePrefix = joinPathParts(
    context.apiPrefix,
    context.apiVersion,
    "runtime",
  );

  return {
    createRuntimeConfig: createDashboardRuntimeConfig,
    routes: routes.map((route) => ({
      ...route,
      path:
        route.path === routePrefix
          ? "/"
          : route.path.slice(routePrefix.length) || "/",
    })),
  };
}

/**
 * Resolves the frontend serving this installation's root path.
 *
 * The Platform names no frontend. A caller supplies one — `@zelavis/ui` is the
 * default product choice, a theme from the marketplace is another — and an
 * installation with none is a supported state rather than a broken one: the
 * API is unaffected, and the root path explains itself.
 */
/**
 * Reads the frontend option in its three accepted forms.
 *
 * `frontend` is a factory for the common case, an object when an installation
 * wants to name itself or point at a dev server, and `false` for a Platform
 * that serves nothing at its root.
 */
function readFrontendOptions(
  option: ZelavisFrontendInput | undefined,
): ZelavisFrontendOptions {
  if (option === undefined) return {};
  return typeof option === "function" ? { factory: option } : option;
}

function readFrontendTitle(
  option: ZelavisFrontendInput | undefined,
): string | undefined {
  return readFrontendOptions(option).title;
}

async function resolvePlatformFrontend(
  option: ZelavisFrontendInput | undefined,
  context: {
    rootPath: string;
    createRuntimeConfig: () => Promise<unknown>;
  },
): Promise<ZelavisPlatformFrontend | undefined> {
  const options = readFrontendOptions(option);
  if (!options.factory) {
    return undefined;
  }

  return options.factory({
    rootPath: context.rootPath,
    ...(options.title ? { title: options.title } : {}),
    ...(options.subtitle ? { subtitle: options.subtitle } : {}),
    ...(() => {
      const devServerUrl = normalizeExternalUrl(
        options.devServerUrl ?? readOptionalProcessEnv("ZELAVIS_UI_DEV_SERVER"),
      );
      return devServerUrl ? { devServerUrl } : {};
    })(),
    createRuntimeConfig: context.createRuntimeConfig,
  });
}

async function resolveWorkloadsCoreService(
  option: ZelavisWorkloadsOptions | undefined,
): Promise<ZelavisRuntimeService<any> | undefined> {
  const workloadsOption = option ?? true;

  if (workloadsOption === false) {
    return undefined;
  }

  return workloadsService(workloadsOption === true ? {} : workloadsOption);
}

/**
 * Projects a Project runtime status onto a Fabric placement state.
 *
 * Deliberately an allow-list: only a running Project is `active`. The previous
 * default-to-active mapping reported `stopping` and `stopped` Projects as
 * active placements, and would have reported any future status the same way.
 * Inventory accuracy matters more as the Gateway comes to rely on authoritative
 * Fabric state for routing.
 */
function placementStateFromRuntimeStatus(
  status: string,
): FabricPlacementState {
  switch (status) {
    case "running":
      return "active";
    case "provisioning":
    case "starting":
      return "preparing";
    case "failed":
    case "stopping":
    case "stopped":
      return "unavailable";
    default:
      return "unavailable";
  }
}

/**
 * The node this host is.
 *
 * The same default the Fabric service uses, read separately because the
 * Project manager needs it before the Fabric is composed — it is composed
 * after the Projects it plans for.
 */
function resolveLocalNodeId(option: ZelavisFabricOptions | undefined): string {
  const fabricOption = option ?? true;
  if (fabricOption === false) return "local";
  const configured = fabricOption === true ? {} : fabricOption;
  return configured.localNode?.id ?? "local";
}

function resolveFabricCoreService(
  option: ZelavisFabricOptions | undefined,
  context: {
    projects?: ZelavisProjectManager;
    runtimeEngine: ZelavisRuntimeEngine;
  },
): ZelavisRuntimeService<FabricApi> | undefined {
  const fabricOption = option ?? true;
  if (fabricOption === false) {
    return undefined;
  }

  const configured = fabricOption === true ? {} : fabricOption;
  const localNodeId = configured.localNode?.id ?? "local";
  const platformScopeId = configured.authority?.scopeId ?? "local-platform";
  const projectPlacements = async (): Promise<
    readonly FabricProjectPlacement[]
  > => {
    if (!context.projects) {
      return [];
    }
    const projects = context.projects;

    return (await projects.list()).map((project) => toPlacement(project));
  };
  const toPlacement = (
    project: ZelavisProjectRecord,
  ): FabricProjectPlacement => ({
    identity: {
      scopeId: platformScopeId,
      workloadId: project.id,
      type: "project" as const,
    },
    projectKind: project.kind,
    // The node it is actually on. A Project the planner placed elsewhere is
    // recorded as such by the Project manager, and reporting it as local here
    // would have the Fabric's own inventory contradict its placement decision.
    runtimeNodeId: project.placement?.nodeId ?? localNodeId,
    ...(project.capabilities.managedDatabase
      ? { databaseNodeId: project.placement?.nodeId ?? localNodeId }
      : {}),
    generation: 1,
    state: placementStateFromRuntimeStatus(project.runtime.status),
    runtimeStatus: project.runtime.status,
  });
  const projectPlacement = async (
    projectId: string,
  ): Promise<FabricProjectPlacement | undefined> => {
    const project = await context.projects?.get(projectId);
    return project ? toPlacement(project) : undefined;
  };

  return createFabricService({
    ...configured,
    localNode:
      configured.localNode ??
      {
        id: localNodeId,
        status: "ready",
        roles: ["gateway", "control", "worker"],
        runtimeEngine: context.runtimeEngine,
        runtimeDriver: context.projects?.runtime.driver ?? "local",
      },
    inventory: {
      ...configured.inventory,
      projectPlacements:
        configured.inventory?.projectPlacements ?? projectPlacements,
      ...(configured.inventory?.projectPlacement
        ? { projectPlacement: configured.inventory.projectPlacement }
        : configured.inventory?.projectPlacements
          ? {}
          : { projectPlacement }),
    },
  });
}

function hostOperationErrorResponse(error: unknown) {
  if (error instanceof ZelavisHostOperationRateLimitedError) {
    return {
      status: 429,
      headers: { "retry-after": String(error.retryAfterSeconds) },
      body: { error: error.message, retryAfterSeconds: error.retryAfterSeconds },
    };
  }
  if (error instanceof ZelavisHostOperationForbiddenError) {
    return { status: error.status, body: { error: error.message } };
  }
  if (error instanceof ZelavisHostOperationNotFoundError) {
    return { status: 404, body: { error: error.message } };
  }
  if (error instanceof ZelavisHostOperationValidationError) {
    return { status: 400, body: { error: error.message } };
  }
  return createJsonErrorResponse(502, error);
}

/**
 * Release-signed host operations: catalog, request, status. Authentication is
 * the route requirement; the permission comes from each operation's signed
 * manifest and is checked by the broker for the requested scope.
 */
function hostOperationRoutes(
  broker: ZelavisHostOperationBroker | undefined,
): ZelavisServerRoute<any>[] {
  const unavailable = () => ({
    status: 503,
    body: { error: "Host operations require a supervised Agent with installed operations." },
  });
  type Context = {
    principal?: HostOperationPrincipal;
    body?: unknown;
    params: Record<string, string>;
    query: URLSearchParams;
  };
  return [
    {
      id: "runtime.host-operations.catalog",
      spec: {
        operationId: "listHostOperations",
        summary: "Host operations the caller may request",
        tags: ["host-operations"],
        responses: { 200: { description: "Requestable operations" } },
      },
      method: "GET",
      path: "/host-operations",
      access: { authenticated: true },
      handler: async ({ principal }: Context) => {
        if (!broker) return unavailable();
        try {
          return { status: 200, body: { operations: await broker.catalog(principal) } };
        } catch (error) {
          return hostOperationErrorResponse(error);
        }
      },
    },
    {
      id: "runtime.host-operations.submit",
      spec: {
        operationId: "submitHostOperation",
        summary: "Request a release-signed host operation",
        tags: ["host-operations"],
        responses: {
          202: { description: "Accepted by the Agent" },
          400: { description: "Invalid request" },
          403: { description: "Missing the operation's permission" },
          404: { description: "Not installed or not requestable" },
        },
      },
      method: "POST",
      path: "/host-operations",
      access: { authenticated: true },
      handler: async ({ principal, body }: Context) => {
        if (!broker) return unavailable();
        try {
          const input = (body && typeof body === "object" && !Array.isArray(body)
            ? body
            : {}) as Record<string, unknown>;
          const args = input.arguments;
          if (
            args !== undefined &&
            (!args || typeof args !== "object" || Array.isArray(args) ||
              Object.values(args).some((value) => typeof value !== "string"))
          ) {
            throw new ZelavisHostOperationValidationError("arguments must be an object of strings.");
          }
          const operation = await broker.submit({
            operation: typeof input.operation === "string" ? input.operation : "",
            ...(typeof input.version === "string" ? { version: input.version } : {}),
            ...(typeof input.projectId === "string" ? { projectId: input.projectId } : {}),
            ...(args ? { arguments: args as Record<string, string> } : {}),
            ...(typeof input.deadlineMs === "number" ? { deadlineMs: input.deadlineMs } : {}),
          }, principal);
          return { status: 202, body: { operation } };
        } catch (error) {
          return hostOperationErrorResponse(error);
        }
      },
    },
    {
      id: "runtime.host-operations.audit",
      spec: {
        operationId: "listHostOperationAudit",
        summary: "Host operation issuance records (never argument values)",
        tags: ["host-operations"],
        responses: { 200: { description: "Records, newest first" }, 403: { description: "Missing audit permission" } },
      },
      method: "GET",
      path: "/host-operations/audit",
      access: { authenticated: true },
      handler: async ({ principal, query }: Context) => {
        if (!broker) return unavailable();
        try {
          const limit = query.get("limit");
          const projectId = query.get("projectId");
          return {
            status: 200,
            body: {
              records: await broker.audit({
                ...(projectId ? { projectId } : {}),
                ...(limit !== null ? { limit: Number(limit) } : {}),
              }, principal),
            },
          };
        } catch (error) {
          return hostOperationErrorResponse(error);
        }
      },
    },
    {
      id: "runtime.host-operations.get",
      spec: {
        operationId: "getHostOperation",
        summary: "Read a requested host operation",
        tags: ["host-operations"],
        responses: { 200: { description: "Operation" }, 404: { description: "Not found" } },
      },
      method: "GET",
      path: "/host-operations/:operationId",
      access: { authenticated: true },
      handler: async ({ principal, params }: Context) => {
        if (!broker) return unavailable();
        try {
          return { status: 200, body: { operation: await broker.get(params.operationId ?? "", principal) } };
        } catch (error) {
          return hostOperationErrorResponse(error);
        }
      },
    },
  ];
}

function remoteEnvironmentRoutes(
  environment: ZelavisRemoteEnvironment | undefined,
  database?: DatabaseRuntimeApi,
): ZelavisServerRoute<any>[] {
  const unavailable = () => ({
    status: 503,
    body: { error: "Remote environment execution is unavailable." },
  });
  const principalTenant = (principal: NonNullable<ZelavisServerExecutionContext["principal"]>) => {
    const claimed = principal.metadata?.tenantId;
    return typeof claimed === "string" && claimed.trim() ? claimed : principal.id;
  };
  const ensureCollection = async (tenantId: string, name: string) => {
    if (!database) return;
    const tenant = database.forTenant(tenantId);
    if (await tenant.documents.collectionExists(name)) return;
    try {
      await tenant.documents.createCollection({ name, surface: "database" });
    } catch (error) {
      if (!(error instanceof CollectionExists)) throw error;
    }
  };
  const readSession = async (tenantId: string, sessionId: string) => {
    if (!database) return undefined;
    return database.forTenant(tenantId).documents.findById({ collection: "zelavis_agent_sessions", id: sessionId });
  };
  const readProcess = async (tenantId: string, processId: string) => {
    if (!database) return undefined;
    return database.forTenant(tenantId).documents.findById({ collection: "zelavis_agent_processes", id: processId });
  };
  const readUsage = async (tenantId: string, usageId: string) => {
    if (!database) return undefined;
    return database.forTenant(tenantId).documents.findById({ collection: "zelavis_agent_usage", id: usageId });
  };
  const sessionFromRecord = (record: NonNullable<Awaited<ReturnType<typeof readSession>>>): ZelavisEnvironmentSession => {
    const data = record.data as Record<string, unknown>;
    return {
      id: record.id,
      version: record.version,
      status: data.status === "closed" ? "closed" as const : "active" as const,
      createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
      ...(typeof data.closedAt === "string" ? { closedAt: data.closedAt } : {}),
      ...(data.scope && typeof data.scope === "object" ? { scope: data.scope } : {}),
      ...(data.metadata && typeof data.metadata === "object" ? { metadata: data.metadata } : {}),
    } as ZelavisEnvironmentSession;
  };
  const processFromRecord = (record: NonNullable<Awaited<ReturnType<typeof readProcess>>>): ZelavisEnvironmentProcess => {
    const data = record.data as Record<string, unknown>;
    const status = data.status === "starting" || data.status === "running" || data.status === "exited" || data.status === "failed"
      ? data.status
      : "failed";
    return {
      id: record.id,
      sessionId: String(data.sessionId ?? ""),
      status,
      ...(typeof data.startedAt === "string" && data.startedAt ? { startedAt: data.startedAt } : {}),
      ...(typeof data.exitCode === "number" ? { exitCode: data.exitCode } : {}),
    };
  };
  const processData = (process: ZelavisEnvironmentProcess): JsonObject => ({
    processId: process.id,
    sessionId: process.sessionId,
    status: process.status,
    startedAt: process.startedAt ?? "",
    exitCode: process.exitCode ?? null,
  });
  const usageFromRecord = (
    record: NonNullable<Awaited<ReturnType<typeof readUsage>>>,
  ): ZelavisEnvironmentUsageRecord => ({
    id: record.id,
    version: record.version,
    ...(record.data as unknown as Omit<ZelavisEnvironmentUsageRecord, "id" | "version">),
  });
  const reconcilePersistedProcesses = async (tenantId: string, sessionId: string) => {
    if (!database || !environment?.listProcesses) return;
    const attached = (await environment.listProcesses(sessionId))
      .filter((process) => process.sessionId === sessionId);
    const documents = database.forTenant(tenantId).documents;
    const collectionExists = await documents.collectionExists("zelavis_agent_processes");
    const persisted = collectionExists
      ? await documents.findMany({
          collection: "zelavis_agent_processes",
          where: [{ path: "sessionId", value: sessionId }],
        })
      : [];
    if (!collectionExists && attached.length > 0) {
      await ensureCollection(tenantId, "zelavis_agent_processes");
    }

    const persistedById = new Map(persisted.map((record) => [record.id, record]));
    const attachedById = new Map(attached.map((process) => [process.id, process]));
    for (const process of attached) {
      const record = persistedById.get(process.id);
      if (!record) {
        try {
          await documents.insert({
            collection: "zelavis_agent_processes",
            id: process.id,
            data: processData(process),
          });
        } catch (error) {
          if (!(error instanceof DocumentConflict)) throw error;
        }
        continue;
      }
      const current = processFromRecord(record);
      if (
        current.status !== process.status
        || current.startedAt !== process.startedAt
        || current.exitCode !== process.exitCode
      ) {
        await documents.update({
          collection: "zelavis_agent_processes",
          id: process.id,
          data: processData(process),
          mode: "merge",
        });
      }
    }

    for (const record of persisted) {
      if (attachedById.has(record.id)) continue;
      const process = processFromRecord(record);
      if (process.status !== "starting" && process.status !== "running") continue;
      await documents.update({
        collection: "zelavis_agent_processes",
        id: record.id,
        data: { status: "failed", exitCode: null },
        mode: "merge",
      });
    }
  };
  const resumePersistedSession = async (
    tenantId: string,
    record: NonNullable<Awaited<ReturnType<typeof readSession>>>,
  ) => {
    const session = sessionFromRecord(record);
    const resumed = environment?.resumeSession ? await environment.resumeSession(session) : session;
    if (session.status === "active") await reconcilePersistedProcesses(tenantId, session.id);
    return resumed;
  };
  return [
    {
      id: "runtime.environment.identity",
      method: "GET",
      path: "/environment",
      access: { authenticated: true },
      spec: { operationId: "getEnvironment", summary: "Read remote environment identity", tags: ["environment"] },
      handler: async () => environment
        ? { status: 200, body: { environment: typeof environment.identity === "function" ? await environment.identity() : environment.identity } }
        : unavailable(),
    },
    {
      id: "runtime.environment.health",
      method: "GET",
      path: "/environment/health",
      access: { authenticated: true },
      spec: { operationId: "getEnvironmentHealth", summary: "Read remote environment health", tags: ["environment"] },
      handler: async () => environment
        ? { status: 200, body: await environment.health() }
        : unavailable(),
    },
    {
      id: "runtime.environment.sessions.create",
      method: "POST",
      path: "/environment/sessions",
      access: { authenticated: true },
      spec: { operationId: "createEnvironmentSession", summary: "Create an agent session", tags: ["environment"] },
      handler: async ({ body, principal }) => {
        if (!environment) return unavailable();
        if (!principal) return { status: 401, body: { error: "Authentication required" } };
        const input = body && typeof body === "object" && !Array.isArray(body)
          ? body as Record<string, unknown>
          : {};
        const scope = input.scope && typeof input.scope === "object" && !Array.isArray(input.scope)
          ? input.scope as Record<string, unknown>
          : undefined;
        const tenantId = principalTenant(principal);
        if (
          typeof scope?.tenantId !== "string" || !scope.tenantId.trim()
          || scope.tenantId !== tenantId
          || typeof scope.projectId !== "string" || !scope.projectId.trim()
          || typeof scope.laneId !== "string" || !scope.laneId.trim()
        ) {
          return { status: 403, body: { error: "Session scope must match the authenticated tenant and include project and lane ids." } };
        }
        const session = await environment.createSession({
          scope: {
            tenantId,
            projectId: scope.projectId,
            laneId: scope.laneId,
          },
          metadata: input.metadata as Readonly<Record<string, unknown>> | undefined,
        });
        if (database) {
          try {
            await ensureCollection(tenantId, "zelavis_agent_sessions");
            await database.forTenant(tenantId).documents.insert({
              collection: "zelavis_agent_sessions",
              id: session.id,
              data: {
                sessionId: session.id,
                status: session.status,
                createdAt: session.createdAt,
                scope: { tenantId, projectId: scope.projectId, laneId: scope.laneId },
                metadata: (input.metadata ?? {}) as JsonObject,
              },
            });
          } catch (error) {
            // Provider and tenant storage are deliberately different systems,
            // so no database transaction can cover both. Compensate a failed
            // projection write instead of leaving an unowned live session.
            try {
              await environment.closeSession?.(session.id);
            } catch {
              // Keep the persistence failure as the request's primary error.
              // A provider that cannot clean up is handled by reconciliation.
            }
            throw error;
          }
        }
        return { status: 201, body: { session } };
      },
    },
    {
      id: "runtime.environment.sessions.update",
      method: "PATCH",
      path: "/environment/sessions/:sessionId",
      access: { authenticated: true },
      spec: { operationId: "updateEnvironmentSession", summary: "Update an agent session projection", tags: ["environment"] },
      handler: async ({ params, body, principal }) => {
        if (!environment) return unavailable();
        if (!principal) return { status: 401, body: { error: "Authentication required" } };
        if (!database) return { status: 503, body: { error: "Environment session persistence is unavailable." } };
        const tenantId = principalTenant(principal);
        const sessionId = params.sessionId ?? "";
        const current = await readSession(tenantId, sessionId);
        if (!current) return { status: 404, body: { error: "Environment session was not found." } };
        if (current.data.status === "closed") {
          return { status: 409, body: { error: "Environment session is closed." } };
        }
        const input = body && typeof body === "object" && !Array.isArray(body)
          ? body as Record<string, unknown>
          : {};
        if (!Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 0) {
          return { status: 400, body: { error: "expectedVersion must be a non-negative integer." } };
        }
        if (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata)) {
          return { status: 400, body: { error: "Session metadata must be an object." } };
        }
        try {
          const updated = await database.forTenant(tenantId).documents.update({
            collection: "zelavis_agent_sessions",
            id: sessionId,
            data: { metadata: input.metadata as JsonObject },
            mode: "merge",
            expectedVersion: Number(input.expectedVersion),
          });
          return { status: 200, body: { session: sessionFromRecord(updated) } };
        } catch (error) {
          if (error instanceof DocumentConflict) {
            return { status: 409, body: { error: "Environment session changed concurrently." } };
          }
          throw error;
        }
      },
    },
    {
      id: "runtime.environment.sessions.get",
      method: "GET",
      path: "/environment/sessions/:sessionId",
      access: { authenticated: true },
      spec: { operationId: "getEnvironmentSession", summary: "Read an agent session", tags: ["environment"] },
      handler: async ({ params, principal }) => {
        if (!environment) return unavailable();
        if (!principal) return { status: 401, body: { error: "Authentication required" } };
        if (!database) return { status: 503, body: { error: "Environment session persistence is unavailable." } };
        const session = await readSession(principalTenant(principal), params.sessionId ?? "");
        if (!session) return { status: 404, body: { error: "Environment session was not found." } };
        const resumed = await resumePersistedSession(principalTenant(principal), session);
        return { status: 200, body: { session: resumed } };
      },
    },
    {
      id: "runtime.environment.sessions.usage.record",
      method: "POST",
      path: "/environment/sessions/:sessionId/usage",
      access: { authenticated: true },
      spec: { operationId: "recordEnvironmentSessionUsage", summary: "Record usage for an agent run", tags: ["environment"] },
      handler: async ({ params, body, principal }) => {
        if (!environment) return unavailable();
        if (!principal) return { status: 401, body: { error: "Authentication required" } };
        if (!database) return { status: 503, body: { error: "Environment usage persistence is unavailable." } };
        const tenantId = principalTenant(principal);
        const sessionId = params.sessionId ?? "";
        const session = await readSession(tenantId, sessionId);
        if (!session) return { status: 404, body: { error: "Environment session was not found." } };
        const input = body && typeof body === "object" && !Array.isArray(body)
          ? body as Record<string, unknown>
          : {};
        if (typeof input.runId !== "string" || !input.runId.trim() || input.runId.length > 256) {
          return { status: 400, body: { error: "Usage runId must be a non-empty string of at most 256 characters." } };
        }
        if (input.source !== "provider" && input.source !== "estimated") {
          return { status: 400, body: { error: "Usage source must be provider or estimated." } };
        }
        const counterNames = [
          "contextTokens",
          "contextLimit",
          "inputTokens",
          "outputTokens",
          "cacheReadTokens",
          "cacheWriteTokens",
        ] as const;
        for (const name of counterNames) {
          const value = input[name];
          if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 0)) {
            return { status: 400, body: { error: `Usage ${name} must be a non-negative safe integer.` } };
          }
        }
        if (
          input.premiumRequests !== undefined
          && (typeof input.premiumRequests !== "number" || !Number.isFinite(input.premiumRequests) || input.premiumRequests < 0)
        ) {
          return { status: 400, body: { error: "Usage premiumRequests must be a non-negative finite number." } };
        }
        if (input.model !== undefined && (typeof input.model !== "string" || !input.model.trim() || input.model.length > 256)) {
          return { status: 400, body: { error: "Usage model must be a non-empty string of at most 256 characters." } };
        }
        if (![...counterNames, "premiumRequests", "model"].some((name) => input[name] !== undefined)) {
          return { status: 400, body: { error: "Usage must include at least one metric or model." } };
        }
        const sessionScope = session.data.scope;
        if (!sessionScope || typeof sessionScope !== "object" || Array.isArray(sessionScope)) {
          return { status: 409, body: { error: "Environment session has no durable scope." } };
        }
        const projectId = (sessionScope as Record<string, unknown>).projectId;
        const laneId = (sessionScope as Record<string, unknown>).laneId;
        if (typeof projectId !== "string" || typeof laneId !== "string") {
          return { status: 409, body: { error: "Environment session has no durable project and lane scope." } };
        }
        const usageId = JSON.stringify([sessionId, input.runId]);
        const metrics = Object.fromEntries(
          [...counterNames, "premiumRequests", "model"]
            .filter((name) => input[name] !== undefined)
            .map((name) => [name, input[name]]),
        ) as JsonObject;
        const usageData: JsonObject = {
          sessionId,
          projectId,
          laneId,
          runId: input.runId,
          source: input.source,
          recordedAt: new Date().toISOString(),
          ...metrics,
        };
        await ensureCollection(tenantId, "zelavis_agent_usage");
        const documents = database.forTenant(tenantId).documents;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const current = await readUsage(tenantId, usageId);
          try {
            const stored = current
              ? await documents.update({
                  collection: "zelavis_agent_usage",
                  id: usageId,
                  data: usageData,
                  mode: "merge",
                  expectedVersion: current.version,
                })
              : await documents.insert({
                  collection: "zelavis_agent_usage",
                  id: usageId,
                  data: usageData,
                });
            return { status: current ? 200 : 201, body: { usage: usageFromRecord(stored) } };
          } catch (error) {
            if (!(error instanceof DocumentConflict) || attempt === 2) throw error;
          }
        }
        throw new Error("Environment usage persistence retry exhausted.");
      },
    },
    {
      id: "runtime.environment.sessions.close",
      method: "DELETE",
      path: "/environment/sessions/:sessionId",
      access: { authenticated: true },
      spec: { operationId: "closeEnvironmentSession", summary: "Close an agent session", tags: ["environment"] },
      handler: async ({ params, principal }) => {
        if (!environment) return unavailable();
        if (!principal) return { status: 401, body: { error: "Authentication required" } };
        const tenantId = principalTenant(principal);
        const sessionId = params.sessionId ?? "";
        const session = await readSession(tenantId, sessionId);
        if (database && !session) return { status: 404, body: { error: "Environment session was not found." } };
        if (session) await resumePersistedSession(tenantId, session);
        if (environment.closeSession) await environment.closeSession(sessionId);
        if (database && session) {
          await database.forTenant(tenantId).documents.update({
            collection: "zelavis_agent_sessions",
            id: sessionId,
            data: { status: "closed", closedAt: new Date().toISOString() },
            mode: "merge",
          });
        }
        return { status: 200, body: { closed: true } };
      },
    },
    {
      id: "runtime.environment.sessions.events",
      method: "GET",
      path: "/environment/sessions/:sessionId/events",
      access: { authenticated: true },
      spec: { operationId: "readEnvironmentSessionEvents", summary: "Replay agent process events", tags: ["environment"] },
      handler: async ({ params, principal, request }) => {
        if (!environment) return unavailable();
        if (!principal) return { status: 401, body: { error: "Authentication required" } };
        if (!environment.readEvents) return { status: 503, body: { error: "Environment event replay is unavailable." } };
        if (!database) return { status: 503, body: { error: "Environment session persistence is unavailable." } };
        const sessionId = params.sessionId ?? "";
        const session = await readSession(principalTenant(principal), sessionId);
        if (!session) return { status: 404, body: { error: "Environment session was not found." } };
        await resumePersistedSession(principalTenant(principal), session);
        const search = new URL(request.url).searchParams;
        const after = search.get("after") ?? undefined;
        const rawLimit = search.get("limit");
        const limit = rawLimit === null ? undefined : Number(rawLimit);
        if (after !== undefined && after.length > 512) {
          return { status: 400, body: { error: "Environment event cursor is too long." } };
        }
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) {
          return { status: 400, body: { error: "Environment event limit must be an integer from 1 to 1000." } };
        }
        const options: ZelavisEnvironmentEventReadOptions = {
          ...(after === undefined ? {} : { after }),
          ...(limit === undefined ? {} : { limit }),
        };
        return { status: 200, body: await environment.readEvents(sessionId, options) };
      },
    },
    {
      id: "runtime.environment.processes.start",
      method: "POST",
      path: "/environment/sessions/:sessionId/processes",
      access: { authenticated: true },
      spec: { operationId: "startEnvironmentProcess", summary: "Start a process in an agent session", tags: ["environment"] },
      handler: async ({ params, body, principal }) => {
        if (!environment) return unavailable();
        if (!principal) return { status: 401, body: { error: "Authentication required" } };
        const session = await readSession(principalTenant(principal), params.sessionId ?? "");
        if (database && !session) return { status: 404, body: { error: "Environment session was not found." } };
        if (database && session?.data.status === "closed") {
          return { status: 409, body: { error: "Environment session is closed." } };
        }
        if (session) await resumePersistedSession(principalTenant(principal), session);
        const input = body && typeof body === "object" && !Array.isArray(body)
          ? body as Record<string, unknown>
          : {};
        if (typeof input.command !== "string" || !input.command.trim()) {
          return { status: 400, body: { error: "Process command is required." } };
        }
        if (typeof input.cwd !== "string" || !input.cwd.trim()) {
          return { status: 400, body: { error: "Process cwd is required." } };
        }
        if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some((value) => typeof value !== "string"))) {
          return { status: 400, body: { error: "Process args must be an array of strings." } };
        }
        if (
          input.env !== undefined
          && (
            !input.env || typeof input.env !== "object" || Array.isArray(input.env)
            || Object.values(input.env).some((value) => typeof value !== "string")
          )
        ) {
          return { status: 400, body: { error: "Process env must contain only string values." } };
        }
        const process = await environment.startProcess(
          params.sessionId ?? "",
          input as unknown as ZelavisEnvironmentProcessInput,
        );
        if (database) {
          const tenantId = principalTenant(principal);
          try {
            await ensureCollection(tenantId, "zelavis_agent_processes");
            await database.forTenant(tenantId).documents.insert({
              collection: "zelavis_agent_processes",
              id: process.id,
              data: {
                processId: process.id,
                sessionId: process.sessionId,
                status: process.status,
                startedAt: process.startedAt ?? "",
                exitCode: process.exitCode ?? null,
              },
            });
          } catch (error) {
            // Starting a provider process and writing its tenant projection
            // cannot be atomic. Terminate on a failed write so the provider
            // does not keep work the control plane cannot subsequently own.
            try {
              await environment.operateProcess(process.id, { type: "terminate" });
            } catch {
              // Reconciliation remains responsible if termination also fails.
            }
            throw error;
          }
        }
        return { status: 201, body: { process } };
      },
    },
    {
      id: "runtime.environment.processes.get",
      method: "GET",
      path: "/environment/processes/:processId",
      access: { authenticated: true },
      spec: { operationId: "getEnvironmentProcess", summary: "Read an agent process", tags: ["environment"] },
      handler: async ({ params, principal }) => {
        if (!environment) return unavailable();
        if (!principal) return { status: 401, body: { error: "Authentication required" } };
        if (!database) return { status: 503, body: { error: "Environment process persistence is unavailable." } };
        const process = await readProcess(principalTenant(principal), params.processId ?? "");
        return process
          ? { status: 200, body: { process: processFromRecord(process) } }
          : { status: 404, body: { error: "Environment process was not found." } };
      },
    },
    {
      id: "runtime.environment.processes.operate",
      method: "POST",
      path: "/environment/processes/:processId/operations",
      access: { authenticated: true },
      spec: { operationId: "operateEnvironmentProcess", summary: "Send an operation to an agent process", tags: ["environment"] },
      handler: async ({ params, body, principal }) => {
        if (!environment) return unavailable();
        if (!principal) return { status: 401, body: { error: "Authentication required" } };
        const tenantId = principalTenant(principal);
        const processRecord = await readProcess(tenantId, params.processId ?? "");
        if (database && !processRecord) return { status: 404, body: { error: "Environment process was not found." } };
        if (processRecord && database) {
          const session = await readSession(tenantId, String(processRecord.data.sessionId ?? ""));
          if (session) await resumePersistedSession(tenantId, session);
        }
        const operation = body && typeof body === "object" && !Array.isArray(body)
          ? body as Record<string, unknown>
          : {};
        const operationType = operation.type;
        if (operationType !== "stdin" && operationType !== "signal" && operationType !== "terminate") {
          return { status: 400, body: { error: "Process operation type must be stdin, signal, or terminate." } };
        }
        if ((operationType === "stdin" || operationType === "signal") && typeof operation.data !== "string") {
          return { status: 400, body: { error: `Process ${operationType} requires string data.` } };
        }
        const operationInput: ZelavisEnvironmentOperationInput = {
          type: operationType,
          ...(typeof operation.data === "string" ? { data: operation.data } : {}),
        };
        const result = await environment.operateProcess(
          params.processId ?? "",
          operationInput,
        );
        if (database && processRecord) {
          await database.forTenant(tenantId).documents.update({
            collection: "zelavis_agent_processes",
            id: params.processId ?? "",
            data: {
              status: result.process.status,
              exitCode: result.process.exitCode ?? null,
            },
            mode: "merge",
          });
        }
        return { status: 202, body: { result } };
      },
    },
  ];
}

async function resolvePlatformCoreService(
  projectRecipes: readonly Readonly<ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>>[],
  projects?: ZelavisProjectManager,
  fabric?: FabricApi,
  systemStore?: ZelavisSystemStore,
  deploymentBackends?: ZelavisDeploymentBackendManager,
  agentOperations?: ZelavisAgentOperationReader,
  hostOperations?: ZelavisHostOperationBroker,
  edge?: ZelavisEdgeManager,
  runtimeManagementRoutes: readonly ZelavisServerRoute<any>[] = [],
  assistantOption?: false | ZelavisAssistantResponder,
  edgeRoutes?: ZelavisEdgeRouteStore,
  edgeCertificates?: ZelavisCertificateController,
  remoteEnvironment?: ZelavisRemoteEnvironment,
  database?: DatabaseRuntimeApi,
): Promise<ZelavisRuntimeService<any>> {
  const assistant =
    systemStore && assistantOption !== false
      ? createAssistantManager({
          store: systemStore,
          ...(assistantOption ? { responder: assistantOption } : {}),
        })
      : undefined;

  function unavailableProjectsResponse() {
    return {
      status: 503,
      body: {
        error:
          "Project management requires a System Store and project runtime driver.",
      },
    };
  }

  function projectErrorResponse(error: unknown) {
    if (error instanceof ZelavisProjectIsolationError) {
      // A stable code and the assessment, so SDK and CLI callers can act on
      // the refusal without parsing its message.
      return {
        status: 409,
        body: {
          error: error.message,
          code: "project.isolation.unsatisfied",
          isolation: error.assessment,
        },
      };
    }
    const status =
      error instanceof ZelavisProjectNotFoundError
        ? 404
        : error instanceof ZelavisProjectConflictError
          ? 409
          : error instanceof ZelavisProjectValidationError
            ? 400
            : error instanceof ZelavisProjectRuntimeError
              ? 503
            : 500;
    return createJsonErrorResponse(status, error);
  }

  function assistantErrorResponse(error: unknown) {
    const status =
      error instanceof ZelavisAssistantNotFoundError
        ? 404
        : error instanceof ZelavisAssistantValidationError
          ? 400
          : 500;
    return createJsonErrorResponse(status, error);
  }

  function deploymentBackendErrorResponse(error: unknown) {
    const status = error instanceof ZelavisDeploymentBackendValidationError
      ? 400
      : error instanceof ZelavisDeploymentBackendConflictError
        ? 409
        : 500;
    return createJsonErrorResponse(status, error);
  }

  function edgeErrorResponse(error: unknown) {
    const status = error instanceof ZelavisEdgeValidationError
      ? 400
      : error instanceof ZelavisEdgeConflictError
        ? 409
        : error instanceof ZelavisEdgeSwitchError
          ? 503
          : 500;
    return createJsonErrorResponse(status, error);
  }

  function readEdgeSwitchInput(body: unknown): {
    adapterId: string;
    publication: ZelavisEdgePublication;
  } {
    const input = readBodyObject(body);
    if (typeof input.adapterId !== "string") {
      throw new ZelavisEdgeValidationError("Edge switch requires adapterId.");
    }
    if (!input.publication ||
        typeof input.publication !== "object" ||
        Array.isArray(input.publication)) {
      throw new ZelavisEdgeValidationError(
        "Edge switch requires a publication object.",
      );
    }
    return {
      adapterId: input.adapterId,
      publication: input.publication as unknown as ZelavisEdgePublication,
    };
  }

  return createZelavisCoreService({
    service: {},
    routes: [
        ...runtimeManagementRoutes,
        {
          id: "runtime.agent.read",
          spec: {
            operationId: "getAgentStatus",
            summary: "Read the Agent's identity and status",
            tags: ["runtime"],
            responses: {
              200: { description: "Agent status" },
            },
          },
          method: "GET",
          path: "/agent",
          access: { permissions: ["server.agents.view"] },
          handler: async () => agentOperations
            ? {
                status: 200,
                body: {
                  identity: agentOperations.identity,
                  operations: await agentOperations.list({ limit: 100 }),
                },
              }
            : {
                status: 503,
                body: { error: "Agent operation journal is unavailable." },
              },
        },
        {
          id: "runtime.agent.operations.list",
          spec: {
            operationId: "listAgentOperations",
            summary: "List entries in the Agent operation journal",
            tags: ["runtime"],
            responses: {
              200: { description: "Operations" },
            },
          },
          method: "GET",
          path: "/agent/operations",
          access: { permissions: ["server.agents.view"] },
          handler: async () => agentOperations
            ? {
                status: 200,
                body: { operations: await agentOperations.list({ limit: 100 }) },
              }
            : {
                status: 503,
                body: { error: "Agent operation journal is unavailable." },
              },
        },
        {
          id: "runtime.agent.operations.get",
          spec: {
            operationId: "getAgentOperation",
            summary: "Read one Agent operation",
            tags: ["runtime"],
            responses: {
              200: { description: "Operation" },
              404: { description: "No such operation" },
            },
          },
          method: "GET",
          path: "/agent/operations/:operationId",
          access: { permissions: ["server.agents.view"] },
          handler: async ({ params }: { params: Record<string, string> }) => {
            if (!agentOperations) {
              return { status: 503, body: { error: "Agent operation journal is unavailable." } };
            }
            const operation = await agentOperations.get(params.operationId ?? "");
            return operation
              ? { status: 200, body: { operation } }
              : { status: 404, body: { error: "Agent operation was not found." } };
          },
        },
        ...hostOperationRoutes(hostOperations),
        ...remoteEnvironmentRoutes(remoteEnvironment, database),
        {
          id: "runtime.edge.read",
          spec: {
            operationId: "getEdgeStatus",
            summary: "Read Edge proxy policy, adapters, and active cutover",
            tags: ["edge"],
            responses: {
              200: { description: "Edge status" },
              503: { description: "Edge management unavailable" },
            },
          },
          method: "GET",
          path: "/edge",
          access: { permissions: ["server.edge.view"] },
          handler: async () => edge
            ? {
                status: 200,
                body: {
                  policy: await edge.getPolicy(),
                  adapters: await edge.listAdapters(),
                  activeSwitch: await edge.getActiveSwitch(),
                },
              }
            : {
                status: 503,
                body: { error: "Edge management is unavailable." },
              },
        },
        ...(["plan", "switch"] as const).map((action) => ({
          id: `runtime.edge.${action}`,
          spec: {
            operationId: action === "plan" ? "planEdgeSwitch" : "switchEdgeAdapter",
            summary: action === "plan"
              ? "Preflight an Edge adapter cutover"
              : "Run a staged, verified Edge adapter cutover",
            tags: ["edge"],
            responses: {
              200: { description: action === "plan" ? "Cutover plan" : "Cutover result" },
              400: { description: "Invalid publication or unsupported target" },
              409: { description: "Another cutover is active" },
              503: { description: "Edge management unavailable or cutover failed" },
            },
          },
          method: "POST" as const,
          path: `/edge/${action}`,
          access: { permissions: ["server.edge.manage"] },
          handler: async ({ body }: { body: unknown }) => {
            if (!edge) {
              return {
                status: 503,
                body: { error: "Edge management is unavailable." },
              };
            }
            try {
              const input = readEdgeSwitchInput(body);
              return action === "plan"
                ? {
                    status: 200,
                    body: {
                      plan: await edge.planSwitch(
                        input.adapterId,
                        input.publication,
                      ),
                    },
                  }
                : {
                    status: 200,
                    body: {
                      edgeSwitch: await edge.switchAdapter(
                        input.adapterId,
                        input.publication,
                      ),
                    },
                  };
            } catch (error) {
              return edgeErrorResponse(error);
            }
          },
        })),
        {
          id: "runtime.edge.routes.list",
          spec: {
            operationId: "listEdgeRoutes",
            summary: "List canonical Edge routes, hostnames, and current publication",
            tags: ["edge"],
            responses: {
              200: { description: "Edge routes, hostnames, and publication" },
              503: { description: "Edge route management unavailable" },
            },
          },
          method: "GET",
          path: "/edge/routes",
          access: { permissions: ["server.edge.view"] },
          handler: async ({ query }: { query: URLSearchParams }) => {
            if (!edgeRoutes) {
              return {
                status: 503,
                body: { error: "Edge route management is unavailable." },
              };
            }
            try {
              const scope = query.get("scope") ?? undefined;
              const projectId = query.get("projectId") ?? undefined;
              const hostname = query.get("hostname") ?? undefined;
              const [routes, hostnames, publication] = await Promise.all([
                edgeRoutes.listRoutes({
                  ...(scope === "platform" || scope === "project" ? { scope } : {}),
                  ...(projectId ? { projectId } : {}),
                  ...(hostname ? { hostname } : {}),
                }),
                edgeRoutes.listHostnames({
                  ...(scope === "platform" || scope === "project" ? { scope } : {}),
                  ...(projectId ? { projectId } : {}),
                }),
                edgeRoutes.getCurrentPublication(),
              ]);
              return {
                status: 200,
                body: { routes, hostnames, publication },
              };
            } catch (error) {
              return edgeErrorResponse(error);
            }
          },
        },
        {
          id: "runtime.edge.routes.put",
          spec: {
            operationId: "putEdgeRoute",
            summary: "Create or update a canonical Edge route and optional hostname",
            tags: ["edge"],
            responses: {
              200: { description: "Stored Edge route and optional hostname" },
              400: { description: "Invalid route or hostname definition" },
              503: { description: "Edge route management unavailable" },
            },
          },
          method: "POST",
          path: "/edge/routes",
          access: { permissions: ["server.edge.manage"] },
          handler: async ({ body }: { body: unknown }) => {
            if (!edgeRoutes) {
              return {
                status: 503,
                body: { error: "Edge route management is unavailable." },
              };
            }
            try {
              const input = readBodyObject(body);
              const routeInput = "route" in input ? (input.route as ZelavisEdgeRoute) : (input as unknown as ZelavisEdgeRoute);
              const hostnameInput = "hostname" in input && input.hostname && typeof input.hostname === "object"
                ? (input.hostname as ZelavisEdgeHostname)
                : undefined;
              let storedHostname: ZelavisEdgeHostname | undefined;
              if (hostnameInput) {
                storedHostname = await edgeRoutes.putHostname(hostnameInput);
              }
              const storedRoute = await edgeRoutes.putRoute(routeInput);
              return {
                status: 200,
                body: {
                  route: storedRoute,
                  ...(storedHostname ? { hostname: storedHostname } : {}),
                },
              };
            } catch (error) {
              return edgeErrorResponse(error);
            }
          },
        },
        {
          id: "runtime.edge.routes.delete",
          spec: {
            operationId: "deleteEdgeRoute",
            summary: "Delete a canonical Edge route",
            tags: ["edge"],
            responses: {
              200: { description: "Deletion result" },
              404: { description: "Route not found" },
              503: { description: "Edge route management unavailable" },
            },
          },
          method: "DELETE",
          path: "/edge/routes/:routeId",
          access: { permissions: ["server.edge.manage"] },
          handler: async ({ params }: { params: Record<string, string> }) => {
            if (!edgeRoutes) {
              return {
                status: 503,
                body: { error: "Edge route management is unavailable." },
              };
            }
            try {
              const deleted = await edgeRoutes.deleteRoute(params.routeId);
              return deleted
                ? { status: 200, body: { deleted: true } }
                : { status: 404, body: { error: `Route "${params.routeId}" was not found.` } };
            } catch (error) {
              return edgeErrorResponse(error);
            }
          },
        },
        {
          id: "runtime.edge.publish",
          spec: {
            operationId: "publishEdgeRoutes",
            summary: "Compile canonical routes and hostnames into an immutable publication",
            tags: ["edge"],
            responses: {
              200: { description: "Compiled Edge publication" },
              503: { description: "Edge route management unavailable" },
            },
          },
          method: "POST",
          path: "/edge/publish",
          access: { permissions: ["server.edge.manage"] },
          handler: async () => {
            if (!edgeRoutes) {
              return {
                status: 503,
                body: { error: "Edge route management is unavailable." },
              };
            }
            try {
              const publication = await edgeRoutes.compile();
              return {
                status: 200,
                body: { publication },
              };
            } catch (error) {
              return edgeErrorResponse(error);
            }
          },
        },
        {
          id: "runtime.edge.onboard.preflight",
          spec: {
            operationId: "preflightEdgeHostname",
            summary: "Preflight validate hostname syntax and DNS resolution",
            tags: ["edge"],
            responses: {
              200: { description: "Hostname preflight check result" },
            },
          },
          method: "GET",
          path: "/edge/onboard/preflight",
          access: { permissions: ["server.edge.view"] },
          handler: async ({ query }: { query: URLSearchParams }) => {
            const hostname = query.get("hostname") ?? "";
            const result = await preflightHostname(hostname);
            return { status: 200, body: result };
          },
        },
        {
          id: "runtime.edge.onboard",
          spec: {
            operationId: "onboardEdgeHostname",
            summary: "Onboard a Platform hostname or defer public routing",
            tags: ["edge"],
            responses: {
              200: { description: "Hostname onboarding result" },
              400: { description: "Invalid onboarding request" },
              503: { description: "Edge route management unavailable" },
            },
          },
          method: "POST",
          path: "/edge/onboard",
          access: { permissions: ["server.edge.manage"] },
          handler: async ({ body }: { body: unknown }) => {
            if (!edgeRoutes) {
              return {
                status: 503,
                body: { error: "Edge route management is unavailable." },
              };
            }
            try {
              const input = readBodyObject(body) as unknown as ZelavisEdgeOnboardingRequest;
              const result = await performEdgeOnboarding(
                {
                  routeStore: edgeRoutes,
                  edgeManager: edge,
                  certificateController: edgeCertificates,
                },
                input,
              );
              return {
                status: result.status === "failed" ? 400 : 200,
                body: result,
              };
            } catch (error) {
              return edgeErrorResponse(error);
            }
          },
        },
        {
          id: "runtime.edge.certificates.list",
          spec: {
            operationId: "listEdgeCertificates",
            summary: "List managed and manual TLS certificates",
            tags: ["edge"],
            responses: {
              200: { description: "Certificate records" },
              503: { description: "Certificate management unavailable" },
            },
          },
          method: "GET",
          path: "/edge/certificates",
          access: { permissions: ["server.edge.view"] },
          handler: async () => {
            if (!edgeCertificates) {
              return {
                status: 503,
                body: { error: "Certificate management is unavailable." },
              };
            }
            try {
              const certificates = await edgeCertificates.listCertificates();
              return { status: 200, body: { certificates } };
            } catch (error) {
              return edgeErrorResponse(error);
            }
          },
        },
        {
          id: "runtime.edge.certificates.renew",
          spec: {
            operationId: "renewEdgeCertificates",
            summary: "Renew certificates nearing expiry or order a specific certificate",
            tags: ["edge"],
            responses: {
              200: { description: "Renewal result" },
              400: { description: "Renewal failed" },
              503: { description: "Certificate management unavailable" },
            },
          },
          method: "POST",
          path: "/edge/certificates/renew",
          access: { permissions: ["server.edge.manage"] },
          handler: async ({ body }: { body: unknown }) => {
            if (!edgeCertificates) {
              return {
                status: 503,
                body: { error: "Certificate management is unavailable." },
              };
            }
            try {
              const input = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
              const hostname = typeof input.hostname === "string" ? input.hostname : undefined;
              if (hostname) {
                const certificate = await edgeCertificates.orderCertificate({
                  hostname,
                  forceRenew: true,
                });
                return { status: 200, body: { renewed: [certificate.ref], certificate } };
              }
              const result = await edgeCertificates.checkRenewals({
                renewIfWithinDays: typeof input.renewIfWithinDays === "number" ? input.renewIfWithinDays : undefined,
              });
              return { status: 200, body: result };
            } catch (error) {
              return edgeErrorResponse(error);
            }
          },
        },
        {
          id: "runtime.deployment-backends.list",
          spec: {
            operationId: "listDeploymentBackends",
            summary: "List deployment backends and their policy",
            tags: ["runtime"],
            responses: {
              200: { description: "Backends" },
            },
          },
          method: "GET",
          path: "/deployment-backends",
          access: { permissions: ["server.backends.view"] },
          handler: async () => deploymentBackends
            ? {
                status: 200,
                body: {
                  policy: await deploymentBackends.getPolicy(),
                  backends: await deploymentBackends.list(),
                },
              }
            : {
                status: 503,
                body: { error: "Deployment backend management is unavailable." },
              },
        },
        {
          id: "runtime.deployment-backends.detect",
          spec: {
            operationId: "detectDeploymentBackends",
            summary: "Probe which deployment backends this host supports",
            tags: ["runtime"],
            responses: {
              200: { description: "Detection results" },
            },
          },
          method: "POST",
          path: "/deployment-backends/detect",
          access: { permissions: ["server.backends.manage"] },
          handler: async ({ body }: { body: unknown }) => {
            if (!deploymentBackends) {
              return { status: 503, body: { error: "Deployment backend management is unavailable." } };
            }
            try {
              const input = readBodyObject(body);
              return {
                status: 200,
                body: {
                  backends: await deploymentBackends.detect(
                    typeof input.id === "string" ? input.id : undefined,
                  ),
                },
              };
            } catch (error) {
              return deploymentBackendErrorResponse(error);
            }
          },
        },
        ...(["enable", "disable", "default"] as const).map((action) => ({
          id: `runtime.deployment-backends.${action}`,
          method: "POST" as const,
          path: `/deployment-backends/:backendId/${action}`,
          access: { permissions: ["server.backends.manage"] },
          spec: {
            operationId: `${action}DeploymentBackend`,
            summary:
              action === "enable"
                ? "Allow a deployment backend on this installation"
                : action === "disable"
                  ? "Stop allowing a deployment backend"
                  : "Choose the backend new Projects use",
            tags: ["runtime"],
            pathParams: {
              backendId: {
                type: "string" as const,
                required: true,
                description: "Deployment backend identifier",
              },
            },
            responses: {
              200: { description: "Backend policy updated" },
              404: { description: "No such backend" },
              503: { description: "Deployment backend management is unavailable" },
            },
          },
          handler: async ({ params }: { params: Record<string, string> }) => {
            if (!deploymentBackends) {
              return { status: 503, body: { error: "Deployment backend management is unavailable." } };
            }
            try {
              const backendId = params.backendId ?? "";
              const policy = action === "enable"
                ? await deploymentBackends.enable(backendId)
                : action === "disable"
                  ? await deploymentBackends.disable(backendId)
                  : await deploymentBackends.setDefault(backendId);
              return { status: 200, body: { policy } };
            } catch (error) {
              return deploymentBackendErrorResponse(error);
            }
          },
        })),
        {
          id: "runtime.access",
          spec: {
            operationId: "getRuntimeAccess",
            summary: "Describe the caller's access to this installation",
            tags: ["runtime"],
            responses: {
              200: { description: "Access mode and principal" },
            },
          },
          method: "GET",
          path: "/access",
          access: { authenticated: true },
          handler: ({ principal }) => principal
            ? {
                status: 200,
                body: createDashboardAccess(principal),
              }
            : { status: 401, body: { error: "Authentication required" } },
        },
        {
          id: "runtime.project-recipes.list",
          spec: {
            operationId: "listProjectRecipes",
            summary: "List the recipes a Project can be created from",
            tags: ["runtime"],
            responses: {
              200: { description: "Installed recipes" },
            },
          },
          method: "GET",
          path: "/project-recipes",
          access: { authenticated: true },
          handler: () => ({
            status: 200,
            body: {
              projectRecipes: projectRecipes
                .filter((entry) => entry.service.kind === "app")
                .map((entry) => ({
                  ...publicServiceRegistryIdentity(entry),
                  title:
                    entry.service.marketplace?.title ??
                    entry.service.menu?.title ??
                    entry.service.name,
                  summary: entry.service.marketplace?.summary,
                  marketplace: entry.service.marketplace,
                  runtimeKinds: entry.service.project?.runtimeKinds ?? ["native"],
                  ...(entry.service.project?.isolation
                    ? { isolation: entry.service.project.isolation }
                    : {}),
                })),
            },
          }),
        },
        {
          id: "runtime.assistant.threads.list",
          spec: {
            operationId: "listAssistantThreads",
            summary: "List assistant threads",
            tags: ["assistant"],
            responses: {
              200: { description: "Threads" },
            },
          },
          method: "GET",
          path: "/assistant/threads",
          access: { permissions: ["assistant.use"] },
          handler: async ({ query }: { query: URLSearchParams }) =>
            assistant
              ? {
                  status: 200,
                  body: {
                    responder: assistant.responder,
                    threads: await assistant.list(query.get("projectId") ?? undefined),
                  },
                }
              : {
                  status: 503,
                  body: { error: "Assistant requires the Platform System Store." },
                },
        },
        {
          id: "runtime.assistant.threads.create",
          spec: {
            operationId: "createAssistantThread",
            summary: "Start an assistant thread",
            tags: ["assistant"],
            responses: {
              201: { description: "Thread created" },
              400: { description: "Invalid thread" },
            },
          },
          method: "POST",
          path: "/assistant/threads",
          access: { permissions: ["assistant.use"] },
          handler: async ({ body }: { body: unknown }) => {
            if (!assistant) {
              return { status: 503, body: { error: "Assistant requires the Platform System Store." } };
            }
            try {
              const input = readBodyObject(body);
              return {
                status: 201,
                body: {
                  thread: await assistant.create({
                    ...(typeof input.title === "string" ? { title: input.title } : {}),
                    ...(typeof input.projectId === "string"
                      ? { projectId: input.projectId }
                      : {}),
                  }),
                },
              };
            } catch (error) {
              return assistantErrorResponse(error);
            }
          },
        },
        {
          id: "runtime.assistant.threads.get",
          spec: {
            operationId: "getAssistantThread",
            summary: "Read one assistant thread",
            tags: ["assistant"],
            responses: {
              200: { description: "Thread" },
              404: { description: "No such thread" },
            },
          },
          method: "GET",
          path: "/assistant/threads/:threadId",
          access: { permissions: ["assistant.use"] },
          handler: async ({ params }: { params: Record<string, string> }) => {
            if (!assistant) {
              return { status: 503, body: { error: "Assistant requires the Platform System Store." } };
            }
            try {
              const thread = await assistant.get(params.threadId ?? "");
              if (!thread) {
                throw new ZelavisAssistantNotFoundError(
                  `Assistant thread "${params.threadId ?? ""}" was not found.`,
                );
              }
              return { status: 200, body: { thread } };
            } catch (error) {
              return assistantErrorResponse(error);
            }
          },
        },
        {
          id: "runtime.assistant.messages.create",
          spec: {
            operationId: "createAssistantMessage",
            summary: "Post a message to an assistant thread",
            tags: ["assistant"],
            responses: {
              201: { description: "Message accepted" },
              404: { description: "No such thread" },
            },
          },
          method: "POST",
          path: "/assistant/threads/:threadId/messages",
          access: { permissions: ["assistant.use"] },
          handler: async ({
            body,
            params,
          }: {
            body: unknown;
            params: Record<string, string>;
          }) => {
            if (!assistant) {
              return { status: 503, body: { error: "Assistant requires the Platform System Store." } };
            }
            try {
              const input = readBodyObject(body);
              return {
                status: 201,
                body: await assistant.appendMessage(
                  params.threadId ?? "",
                  typeof input.content === "string" ? input.content : "",
                ),
              };
            } catch (error) {
              return assistantErrorResponse(error);
            }
          },
        },
        {
          id: "runtime.projects.list",
          spec: {
            operationId: "listProjects",
            summary: "List Projects on this installation",
            tags: ["projects"],
            responses: {
              200: { description: "Projects" },
            },
          },
          method: "GET",
          path: "/projects",
          access: { permissions: ["projects.list"] },
          handler: async () =>
            projects
              ? {
                  status: 200,
                  body: {
                    runtime: projects.runtime,
                    projects: await projects.list(),
                  },
                }
              : unavailableProjectsResponse(),
        },
        {
          id: "runtime.projects.create",
          spec: {
            operationId: "createProject",
            summary: "Create a Project from a recipe",
            tags: ["projects"],
            responses: {
              201: { description: "Project created" },
              400: { description: "Invalid Project" },
            },
          },
          method: "POST",
          path: "/projects",
          access: { permissions: ["projects.create"] },
          handler: async ({ body }: { body: unknown }) => {
            if (!projects) {
              return unavailableProjectsResponse();
            }
            try {
              const input = readBodyObject(body);
              if (input.runtimeKind !== undefined) {
                throw new ZelavisProjectValidationError(
                  "New Project deployment backends are selected by server policy. Change the server default or use an explicit migration workflow for an existing Project.",
                );
              }
              const project = await projects.create({
                name: typeof input.name === "string" ? input.name : "",
                ...(typeof input.id === "string" ? { id: input.id } : {}),
                ...(typeof input.recipeName === "string"
                  ? { recipeName: input.recipeName }
                  : {}),
                ...(typeof input.start === "boolean" ? { start: input.start } : {}),
              });
              return { status: 201, body: { project } };
            } catch (error) {
              return projectErrorResponse(error);
            }
          },
        },
        {
          id: "runtime.projects.get",
          spec: {
            operationId: "getProject",
            summary: "Read one Project",
            tags: ["projects"],
            responses: {
              200: { description: "Project" },
              404: { description: "No such Project" },
            },
          },
          method: "GET",
          path: "/projects/:projectId",
          access: {
            permissions: ["project.view"],
            scope: { type: "project", projectIdParam: "projectId" },
          },
          handler: async ({ params }: { params: Record<string, string> }) => {
            if (!projects) {
              return unavailableProjectsResponse();
            }
            try {
              const project = await projects.get(params.projectId ?? "");
              if (!project) {
                throw new ZelavisProjectNotFoundError(
                  `Project "${params.projectId ?? ""}" was not found.`,
                );
              }
              return { status: 200, body: { project } };
            } catch (error) {
              return projectErrorResponse(error);
            }
          },
        },
        {
          id: "runtime.projects.update",
          spec: {
            operationId: "updateProject",
            summary: "Update a Project's metadata",
            tags: ["projects"],
            responses: {
              200: { description: "Project updated" },
              400: { description: "Invalid Project update" },
              404: { description: "No such Project" },
            },
          },
          method: "PATCH",
          path: "/projects/:projectId",
          access: {
            permissions: ["project.settings.manage"],
            scope: { type: "project", projectIdParam: "projectId" },
          },
          handler: async ({ params, body }: { params: Record<string, string>; body: unknown }) => {
            if (!projects) {
              return unavailableProjectsResponse();
            }
            try {
              const input = readBodyObject(body);
              return {
                status: 200,
                body: {
                  project: await projects.update(params.projectId ?? "", {
                    name: typeof input.name === "string" ? input.name : "",
                  }),
                },
              };
            } catch (error) {
              return projectErrorResponse(error);
            }
          },
        },
        {
          id: "runtime.projects.start",
          spec: {
            operationId: "startProject",
            summary: "Start a Project's runtime",
            tags: ["projects"],
            responses: {
              200: { description: "Project starting" },
              404: { description: "No such Project" },
            },
          },
          method: "POST",
          path: "/projects/:projectId/start",
          access: {
            permissions: ["project.runtime.manage"],
            scope: { type: "project", projectIdParam: "projectId" },
          },
          handler: async ({ params }: { params: Record<string, string> }) => {
            if (!projects) {
              return unavailableProjectsResponse();
            }
            try {
              return {
                status: 200,
                body: { project: await projects.start(params.projectId ?? "") },
              };
            } catch (error) {
              return projectErrorResponse(error);
            }
          },
        },
        {
          id: "runtime.projects.stop",
          spec: {
            operationId: "stopProject",
            summary: "Stop a Project's runtime",
            tags: ["projects"],
            responses: {
              200: { description: "Project stopping" },
              404: { description: "No such Project" },
            },
          },
          method: "POST",
          path: "/projects/:projectId/stop",
          access: {
            permissions: ["project.runtime.manage"],
            scope: { type: "project", projectIdParam: "projectId" },
          },
          handler: async ({ params }: { params: Record<string, string> }) => {
            if (!projects) {
              return unavailableProjectsResponse();
            }
            try {
              return {
                status: 200,
                body: { project: await projects.stop(params.projectId ?? "") },
              };
            } catch (error) {
              return projectErrorResponse(error);
            }
          },
        },
        {
          id: "runtime.projects.restart",
          spec: {
            operationId: "restartProject",
            summary: "Restart a Project's runtime",
            tags: ["projects"],
            responses: {
              200: { description: "Project restarting" },
              404: { description: "No such Project" },
            },
          },
          method: "POST",
          path: "/projects/:projectId/restart",
          access: {
            permissions: ["project.runtime.manage"],
            scope: { type: "project", projectIdParam: "projectId" },
          },
          handler: async ({ params }: { params: Record<string, string> }) => {
            if (!projects) {
              return unavailableProjectsResponse();
            }
            try {
              return {
                status: 200,
                body: { project: await projects.restart(params.projectId ?? "") },
              };
            } catch (error) {
              return projectErrorResponse(error);
            }
          },
        },
        {
          id: "runtime.projects.logs",
          spec: {
            operationId: "getProjectLogs",
            summary: "Read a Project's recent runtime logs",
            tags: ["projects"],
            responses: {
              200: { description: "Log lines" },
              404: { description: "No such Project" },
            },
          },
          method: "GET",
          path: "/projects/:projectId/logs",
          access: {
            permissions: ["project.logs.read"],
            scope: { type: "project", projectIdParam: "projectId" },
          },
          handler: async ({ params }: { params: Record<string, string> }) => {
            if (!projects) {
              return unavailableProjectsResponse();
            }
            try {
              return {
                status: 200,
                body: { logs: await projects.logs(params.projectId ?? "") },
              };
            } catch (error) {
              return projectErrorResponse(error);
            }
          },
        },
        ...createProjectGatewayRoutes({
          projects,
          fabric,
          unavailableProjectsResponse,
          projectErrorResponse,
        }),
        {
          id: "runtime.projects.remove",
          spec: {
            operationId: "deleteProject",
            summary: "Delete a Project and its runtime state",
            tags: ["projects"],
            responses: {
              204: { description: "Deletion started" },
              404: { description: "No such Project" },
            },
          },
          method: "DELETE",
          path: "/projects/:projectId",
          access: {
            permissions: ["project.delete"],
            scope: { type: "project", projectIdParam: "projectId" },
          },
          handler: async ({ params }: { params: Record<string, string> }) => {
            if (!projects) {
              return unavailableProjectsResponse();
            }
            try {
              const deleted = await projects.remove(params.projectId ?? "");
              if (!deleted) {
                throw new ZelavisProjectNotFoundError(
                  `Project "${params.projectId ?? ""}" was not found.`,
                );
              }
              return { status: 200, body: { deleted: true } };
            } catch (error) {
              return projectErrorResponse(error);
            }
          },
        },
    ],
  });
}

async function synthesizeFrontendAppService(
  frontend: ZelavisPlatformFrontend,
): Promise<ZelavisRuntimeService | undefined> {
  // A frontend that ships no assets serves everything from its own routes, so
  // there is nothing to mount.
  if (!frontend.bundleStore) {
    return undefined;
  }

  return synthesizeServiceAppService({
    service: frontend.service as any,
    bundleStore: frontend.bundleStore,
    effectiveMount: "/",
  });
}

function stripFrontendServiceFields(
  frontendService: ZelavisRuntimeService<any>,
): ZelavisRuntimeService<any> {
  const { app: _app, ...rest } = frontendService as ZelavisRuntimeService<any> & {
    app?: unknown;
  };
  return {
    ...rest,
  };
}

function createServicePrefixes(
  services: readonly ZelavisRuntimeService<any>[],
  options: {
    rootPath: string;
    mountPrefix: string;
    apiPrefix: string;
    apiVersion: string;
    overrides?: Record<string, string>;
    /**
     * Services serving this installation's face, by name.
     *
     * Passed in rather than matched against a known name: the Platform serves
     * whichever frontend it was given, and a frontend from the marketplace has
     * to mount the same way the first-party one does.
     */
    frontendServiceNames?: readonly string[];
  },
): Record<string, string> {
  const prefixes: Record<string, string> = {};
  const mountAtRoot = options.mountPrefix === "/";
  const frontendServices = new Set(options.frontendServiceNames ?? []);
  const namespaceOwners = new Map<string, string>();

  for (const service of services) {
    if (service.namespace) {
      const previous = namespaceOwners.get(service.namespace);
      if (previous && previous !== service.name) {
        throw new TypeError(`Plugin namespace "${service.namespace}" is already owned by "${previous}"; "${service.name}" cannot claim it.`);
      }
      namespaceOwners.set(service.namespace, service.name);
    }
    if (service.name === "@zelavis/frontend") {
      prefixes[service.name] = "/";
      continue;
    }

    if (frontendServices.has(service.name) && !service.namespace) {
      prefixes[service.name] = mountAtRoot ? options.rootPath : "/";
      continue;
    }

    if (service.name === "zelavis-domain-challenge") {
      // Leave the route's declared path verbatim under whatever the
      // global mount prefix is. In typical hosting setups (website
      // enabled → mountPrefix `/`) the challenge ends up at the
      // literal well-known path. In path-only-API setups (no
      // website, mountPrefix `/zelavis`) it lands at
      // `/zelavis/.well-known/zelavis-challenge/...`; operators in
      // that mode can pass a matching `challengePath` to the
      // verifier, or — more practically — enable the website service
      // when they want HTTP-01 verification.
      prefixes[service.name] = "/";
      continue;
    }

    const servicePath = service.basePath ?? service.name;
    prefixes[service.name] = mountAtRoot
      ? joinPathParts(
          options.rootPath,
          options.apiPrefix,
          options.apiVersion,
          servicePath,
        )
      : joinPathParts(options.apiPrefix, options.apiVersion, servicePath);
  }

  return {
    ...prefixes,
    ...options.overrides,
  };
}

export async function zelavis(
  options: ZelavisServerOptions = {},
): Promise<ZelavisRuntime> {
  const rawOptions = options as Record<string, unknown>;
  const obsoleteKeys = ["services", "runtimeServices"].filter(
    (key) => rawOptions[key] !== undefined,
  );

  if (obsoleteKeys.length > 0) {
    throw new TypeError(
      `zelavis(...) no longer accepts direct service options (${obsoleteKeys.join(", ")}). Put services in the product-services folder or install them through the service registry endpoints.`,
    );
  }

  // Refused rather than ignored. Silently dropping a removed option leaves a
  // caller believing they turned a subsystem off when it is still running,
  // which for `auth: false` or `site: false` is a security-relevant surprise.
  if (rawOptions.coreServices !== undefined) {
    throw new TypeError(
      'zelavis(...) no longer accepts "coreServices". Platform subsystems moved to "subsystems" (auth, database, fabric, storage, workloads, site), the dashboard options moved to "frontend", and its settings store is now "runtimeSettingsStore".',
    );
  }

  const compositionOptions = options as ZelavisRuntimeCompositionOptions;
  const rootPath = normalizePath(options.rootPath, "/zelavis");
  const apiPrefix = normalizePath(options.api?.prefix, "/api");
  const apiVersion = normalizePathPart(options.api?.version ?? "v1");
  const baseServiceRegistry =
    compositionOptions.serviceRegistry?.catalog !== undefined
      ? await loadConfiguredServiceRegistryModules(
          compositionOptions.serviceRegistry.catalog,
          compositionOptions.serviceRegistry.importer,
          compositionOptions.serviceRegistry.manifestResolver,
        )
      : defaultDashboardServiceRegistry;
  const systemStore = options.systemStore ?? createMemorySystemStore();
  const serviceRegistryStore = resolveServiceRegistryStore(
    compositionOptions.serviceRegistry,
    createSystemStoreServiceRegistryStore(systemStore),
  );
  const initialServiceRegistryState =
    await readInitialServiceRegistryState(serviceRegistryStore);
  const storedServiceRegistry = await loadStoredServiceRegistryModules(
    initialServiceRegistryState,
    compositionOptions.serviceRegistry?.importer,
    compositionOptions.serviceRegistry?.manifestResolver,
  );
  // Loaded through the same importer and manifest resolver as everything else,
  // so a package dropped into the folder is subject to the same validation as
  // one installed through the registry endpoints.
  const discoveredServiceRegistry: Readonly<
    ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>
  >[] = [];
  for (const entry of compositionOptions.serviceRegistry?.discovered ?? []) {
    // Refused before loading, not after. A dropped-in package naming a core
    // service reaches the activation guard otherwise, and that one throws —
    // turning a bad package in the folder into a Platform that will not boot.
    const declaredName =
      typeof entry.manifest?.name === "string" ? entry.manifest.name : undefined;
    if (declaredName && RESERVED_CORE_SERVICE_NAMES.has(declaredName)) {
      console.warn(
        `Zelavis skipped product service "${declaredName}": that name is reserved for a core Platform service.`,
      );
      continue;
    }
    try {
      discoveredServiceRegistry.push(
        ...(await loadServiceRegistry<ZelavisServiceSetupContext>([entry], {
          importer: compositionOptions.serviceRegistry?.importer,
          ...(compositionOptions.serviceRegistry?.manifestResolver
            ? {
                manifestResolver:
                  compositionOptions.serviceRegistry.manifestResolver,
              }
            : {}),
        })),
      );
    } catch (error) {
      // Loaded one at a time so a single unusable package cannot stop the
      // Platform from booting. An operator who drops in a broken download
      // should lose that service, not their installation.
      console.warn(
        `Zelavis could not load product service ${entry.specifier}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const knownServiceNames = new Set(
    baseServiceRegistry.map((entry) => entry.service.name),
  );
  // A dropped-in package must not take over a name the installation composed
  // itself: shadowing `@zelavis/auth` from the folder would replace the
  // Platform's own auth with whatever was on disk.
  const discoveredServices = discoveredServiceRegistry.filter((entry) => {
    if (knownServiceNames.has(entry.service.name)) return false;
    knownServiceNames.add(entry.service.name);
    return true;
  });
  const completeServiceRegistry = createServiceRegistry([
    ...baseServiceRegistry,
    ...discoveredServices,
    ...storedServiceRegistry.filter(
      (entry) => !knownServiceNames.has(entry.service.name),
    ),
  ]);
  const serviceRegistry = applyServiceRegistryState(
    completeServiceRegistry,
    initialServiceRegistryState,
  );
  const hasAppService = serviceRegistry.some(
    (entry) => entry.status === "installed" && entry.service.kind === "app",
  );
  const databaseSubsystem = await resolveDatabaseCoreService(
    options.subsystems?.database,
  );
  const databaseService = databaseSubsystem && !hasAppService
    ? defineDatabaseService(databaseSubsystem.api)
    : undefined;
  const resolvedDatabaseApi = databaseSubsystem?.api;
  const authService = hasAppService
      ? undefined
      : await resolveAuthCoreService(
        options.subsystems?.auth,
        collectAuthMethodPlugins(serviceRegistry),
        systemStore,
        serviceRegistry,
        collectAuthMethodServiceNames(serviceRegistry),
        rootPath,
        options.bootstrap?.token ?? readOptionalProcessEnv("ZELAVIS_BOOTSTRAP_TOKEN"),
      );
  const activatedServices = await activateServiceRegistry(
    serviceRegistry,
    {
      rootPath,
      api: {
        prefix: apiPrefix,
        version: apiVersion,
        basePath: joinPathParts(rootPath, apiPrefix, apiVersion),
      },
      platform: createServiceSetupPlatformContext(options.serviceContext?.platform),
      core: {
        ...(resolvedDatabaseApi ? { database: resolvedDatabaseApi } : {}),
      },
    },
    {
      bundleStore: options.bundleStore,
      domainBindings: options.domainBindings,
      reservedRuntimeServiceNames: [...RESERVED_CORE_SERVICE_NAMES],
      // Scoped per service, so the namespace a plugin writes to is decided
      // here rather than by the plugin naming one for itself.
      serviceStore: (serviceName: string) =>
        createServiceStore(systemStore, serviceName),
    },
  );
  const serviceRuntimeServices = await Promise.all(activatedServices.services);
  const dashboardSettingsStore = resolveRuntimeSettingsStore(
    options.runtimeSettingsStore,
    createSystemStoreDashboardSettingsStore(systemStore),
  );
  const siteEnabled = options.subsystems?.site !== false;
  // Every installation serves something at its root, and what that is depends
  // on which installation it is.
  //
  // An installation that runs the dashboard *is* its own product: the dashboard
  // is its default frontend, so `/` leads there. A Project runtime has no such
  // default — it exists to host something that has not been chosen yet — so it
  // serves the placeholder until a Frontend is installed.
  //
  // Either way `/` answers, rather than returning the 404 that reads as a
  // broken installation.

  let runtimeConfigServices: readonly ZelavisRuntimeService<any>[] = [];
  // Filled in once mounting resolves them, and read at request time.
  let mountedRoutes: readonly ZelavisResolvedRoute[] | undefined;
  // Resolved before the management core, which needs the paths this frontend
  // claims and the design tokens it supplies. The frontend needs the runtime
  // configuration in return, so it receives a thunk rather than the document —
  // a frontend reads it when serving a request, long after composition.
  let runtimeManagement: ZelavisRuntimeManagementCore | undefined;
  const platformFrontend = await resolvePlatformFrontend(
    options.frontend,
    {
      rootPath,
      createRuntimeConfig: async () => {
        if (!runtimeManagement) {
          throw new Error(
            "The runtime configuration was requested before composition finished.",
          );
        }
        return runtimeManagement.createRuntimeConfig();
      },
    },
  );

  const websiteService = !siteEnabled
      ? undefined
      : createProjectFrontendPlaceholderService({
          reservedPrefixes: [rootPath, joinPathParts(rootPath, apiPrefix)],
          ...(options.role === "project" ? {} : { redirectTo: rootPath }),
          publicDomains: {
            ...(options.domainBindings ? { domainBindings: options.domainBindings } : {}),
            // Late-bound: the Project manager is composed after this service.
            projects: () => projects,
          },
        });
  const storageService = await resolveStorageCoreService(options.subsystems?.storage, {
        rootPath,
        apiPrefix,
        apiVersion,
      });
  const workloadsCoreService = hasAppService
      ? undefined
      : await resolveWorkloadsCoreService(options.subsystems?.workloads);
  const deletionAssistant = systemStore
    ? createAssistantManager({ store: systemStore })
    : undefined;
  const edgeRoutes =
    options.edgeRoutes ??
    (systemStore ? createZelavisEdgeRouteStore({ store: systemStore }) : undefined);
  const edgeCertificates =
    options.edgeCertificates ??
    options.subsystems?.edgeCertificates;
  const deploymentBackends =
    systemStore && options.deploymentBackends?.length
      ? createDeploymentBackendManager({
          store: systemStore,
          backends: options.deploymentBackends,
          assignedProjectCount: async (backendId) =>
            (await systemStore.list("projects")).filter((record) => {
              if (
                !record.value ||
                typeof record.value !== "object" ||
                Array.isArray(record.value)
              ) {
                return false;
              }
              const value = record.value as Readonly<Record<string, unknown>>;
              return value.runtimeKind === backendId;
            }).length,
        })
      : undefined;
  const projectRuntime = systemStore && options.deploymentBackends?.length
    ? createDeploymentBackendProjectRuntime({
        store: systemStore,
        backends: options.deploymentBackends,
      }) ?? options.projectRuntime
    : options.projectRuntime;
  const projects =
    systemStore && projectRuntime
      ? await createProjectManager({
          projectRecipes: serviceRegistry,
          store: systemStore,
          runtime: projectRuntime,
          // Resolved lazily: Fabric is composed further down, after the
          // Project manager it plans for. Reconciliation is deferred to match,
          // because it runs once and a pass before Fabric exists would enforce
          // nothing.
          placement: () => fabricCoreService?.service,
          dispatch: () => ({
            localNodeId: resolveLocalNodeId(options.subsystems?.fabric),
            ...(options.projectDispatcher?.dispatchStart
              ? { dispatchStart: options.projectDispatcher.dispatchStart }
              : {}),
          }),
          autoReconcile: false,
          ...(deploymentBackends
            ? {
                resolveDefaultRuntimeKind: async () =>
                  (await deploymentBackends.getPolicy()).defaultBackend,
                // Administrator order (the order backends were enabled in),
                // restricted to ones that can run a Project here right now.
                resolveAlternativeRuntimeKinds: async () => {
                  const [policy, snapshots] = await Promise.all([
                    deploymentBackends.getPolicy(),
                    deploymentBackends.list(),
                  ]);
                  const runnable = new Set(
                    snapshots
                      .filter((backend) =>
                        backend.executable && backend.detection.state === "ready")
                      .map((backend) => backend.id),
                  );
                  return policy.enabledBackends.filter((id) => runnable.has(id));
                },
                // Only a backend that can execute Projects describes a
                // Project's isolation; a detection-only adapter's capability
                // literals prove nothing about how a Project would run.
                backendCapabilities: (runtimeKind: string) => {
                  const backend = options.deploymentBackends?.find(
                    (candidate) => candidate.id === runtimeKind,
                  );
                  return backend?.projectRuntime ? backend.capabilities : undefined;
                },
              }
            : {}),
          cleanupParticipants: [
            ...(deletionAssistant
              ? [{
                  id: "assistant-threads",
                  cleanup: (project: Readonly<ZelavisProjectRecord>) =>
                    deletionAssistant.deleteProjectThreads(project.id).then(
                      () => undefined,
                    ),
                }]
              : []),
            ...(options.domainBindings
              ? [{
                  id: "domain-bindings",
                  cleanup: (project: Readonly<ZelavisProjectRecord>) =>
                    deleteProjectDomainBindings(
                      options.domainBindings!,
                      project.id,
                    ).then(() => undefined),
                }]
              : []),
            ...(options.bundleStore
              ? [{
                  id: "bundle-assets",
                  cleanup: async (project: Readonly<ZelavisProjectRecord>) => {
                    if (!options.bundleStore?.deleteProject) {
                      throw new Error(
                        "The configured BundleStore cannot delete Project-owned assets.",
                      );
                    }
                    await options.bundleStore.deleteProject(project.id);
                  },
                }]
              : []),
            ...(edgeRoutes
              ? [{
                  id: "edge-routes",
                  cleanup: (project: Readonly<ZelavisProjectRecord>) =>
                    edgeRoutes.deleteProjectRoutes(project.id).then(
                      () => undefined,
                    ),
                }]
              : []),
          ],
        })
      : undefined;
  const fabricCoreService = resolveFabricCoreService(
    options.subsystems?.fabric,
    {
      projects,
      runtimeEngine: detectCurrentRuntimeEngine(
        options.serviceContext?.platform?.metadata,
      ),
    },
  );
  const siteMounted = Boolean(websiteService);
  // An installation with no frontend still serves its API. The root path
  // explains that rather than returning a 404, which reads as a broken
  // deployment when it is a supported state — and it is the only way to have
  // no frontend, so there is nothing to reconcile against a second switch.
  const frontendService =
    platformFrontend?.service ??
    createMissingPlatformFrontendService({
      rootPath,
      reservedPrefixes: [joinPathParts(rootPath, apiPrefix)],
      ...(readFrontendTitle(options.frontend)
        ? { title: readFrontendTitle(options.frontend)! }
        : {}),
    });
  // Synthesize the sibling app service through the same primitive user
  // services use, then hide the service-only `app` field from the externally
  // visible service map.
  const dashboardAppService = platformFrontend
    ? await synthesizeFrontendAppService(platformFrontend)
    : undefined;
  const sanitizedDashboardService = frontendService
    ? stripFrontendServiceFields(frontendService)
    : undefined;

  runtimeManagement = await resolveRuntimeManagementCore(
    options.frontend,
    {
      apiPrefix,
      apiVersion,
      serviceRegistry,
      serviceRegistryStore,
      serviceImporter: compositionOptions.serviceRegistry?.importer,
      serviceManifestResolver:
        compositionOptions.serviceRegistry?.manifestResolver,
      servicePackageInstaller: options.servicePackageInstaller,
      serviceActivation: options.serviceActivation,
      rootPath,
      getServices: () => runtimeConfigServices,
      getMountedRoutes: () => mountedRoutes ?? [],
      settingsStore: dashboardSettingsStore,
      siteEnabled: siteMounted,
      bundleStore: options.bundleStore,
      platform: options.serviceContext?.platform,
      ...(platformFrontend?.clientRoutes
        ? { frontendClientRoutes: platformFrontend.clientRoutes }
        : {}),
      ...(platformFrontend?.servicePageStylesheet
        ? { servicePageStylesheet: platformFrontend.servicePageStylesheet }
        : {}),
      ...(platformFrontend?.serviceElementsScript
        ? { serviceElementsScript: platformFrontend.serviceElementsScript }
        : {}),
      ...(frontendService ? { frontendServiceName: frontendService.name } : {}),
    },
  );
  // Composition is far enough along for placement to resolve, so the startup
  // reconcile can run with the group rule in force. Fire-and-forget, as before:
  // Platform readiness does not wait for every Project runtime.
  void projects?.reconcile();
  const platformCoreService = await resolvePlatformCoreService(
    serviceRegistry,
    projects,
    fabricCoreService?.service,
    systemStore,
    deploymentBackends,
    options.agentOperations,
    options.hostOperations,
    options.edge,
    runtimeManagement.routes,
    options.assistant,
    edgeRoutes,
    edgeCertificates,
    options.remoteEnvironment,
    resolvedDatabaseApi,
  );
  const subsystemServices = [
    platformCoreService,
    await createZelavisMarketplaceService(),
    // Composed only where auth is: a settings page for a service that is not
    // running would configure nothing.
    ...(authService ? [await createZelavisAuthSettingsService()] : []),
    fabricCoreService,
    databaseService,
    authService,
    websiteService,
    storageService,
    workloadsCoreService,
    ...serviceRuntimeServices,
  ].filter(
    (service): service is ZelavisRuntimeService<any> => Boolean(service),
  );
  // Mount the HTTP-01 challenge responder when a domain-binding store
  // is configured. The endpoint serves `verificationToken` back to
  // requesters who hit `<host>/.well-known/zelavis-challenge/<token>`,
  // making automatic verification a no-op for the operator once they
  // point their DNS at this zelavis instance.
  const domainChallengeService = options.domainBindings
    ? createDomainChallengeService(options.domainBindings)
    : undefined;
  // Mount the ACME HTTP-01 challenge responder when Edge certificate
  // controller is active, allowing automated issuance and renewal.
  const acmeChallengeService = edgeCertificates
    ? createAcmeChallengeService(edgeCertificates.challengeStore)
    : undefined;
  runtimeConfigServices = [
    sanitizedDashboardService,
    ...subsystemServices,
  ].filter(
    (service): service is ZelavisRuntimeService<any> => Boolean(service),
  );
  const finalServices = [
    sanitizedDashboardService,
    dashboardAppService,
    domainChallengeService,
    acmeChallengeService,
    ...subsystemServices,
  ].filter(
    (service): service is ZelavisRuntimeService<any> => Boolean(service),
  );
  const mountPrefix = siteMounted ? "/" : rootPath;

  const runtime = await mountZelavisServer({
    ...options,
    prefix: mountPrefix,
    version: "v1",
    services: finalServices,
    servicePrefixes: createServicePrefixes(finalServices, {
      rootPath,
      mountPrefix,
      apiPrefix,
      apiVersion,
      overrides: options.servicePrefixes,
      frontendServiceNames: [
        ...(frontendService ? [frontendService.name] : []),
        ...(dashboardAppService ? [dashboardAppService.name] : []),
      ],
    }),
  });
  // The spec describes what this runtime actually serves, so it reads the
  // routes mounting produced rather than recomputing them from the service
  // list with inputs that were never guaranteed to match.
  mountedRoutes = runtime.routes as readonly ZelavisResolvedRoute[];
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      await projects?.close();
      // The shards are a scoped resource this runtime acquired, so closing it
      // has to release them. Closing twice is already safe.
      await databaseSubsystem?.close?.();
      // Release the local store handle too. Optional and idempotent, so custom
      // and embeddable stores that do not implement it are unaffected; without
      // it a repeatedly constructed embedded runtime retains database handles
      // until the process exits.
      await systemStore?.close?.();
    })();
    return closePromise;
  };

  // A hostname bound to a Project is that Project's, not the Platform's. The
  // dashboard route otherwise matches before the public forwarder runs, so
  // `/zelavis` would serve a Platform login page on every customer domain.
  const publicDomainOptions = options.domainBindings
    ? { domainBindings: options.domainBindings, projects: () => projects }
    : undefined;

  // Captured before the assignment below: `Object.assign` mutates `runtime`, so
  // reading `runtime.fetch` inside the wrapper would call the wrapper.
  const composedFetch = runtime.fetch.bind(runtime);
  const guardedFetch: typeof runtime.fetch = async (request, context) => {
    if (publicDomainOptions) {
      const refused = await guardControlPlaneHost(
        publicDomainOptions,
        request,
        rootPath,
      );
      if (refused) return refused;
    }
    return composedFetch(request, context);
  };

  return Object.assign(runtime, {
    fetch: guardedFetch,
    close,
    auth: authService?.service as AuthApi | undefined,
    database: databaseSubsystem?.api as DatabaseRuntimeApi | undefined,
  });
}

export interface ZelavisRuntime extends ZelavisServerRuntime<unknown> {
  close(): Promise<void>;
  auth?: AuthApi;
  database?: DatabaseRuntimeApi;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNoInternalConstructorOptions(
  options: ZelavisOptions,
): void {
  const raw = options as Record<string, unknown>;
  if ((raw as { coreServices?: unknown }).coreServices !== undefined) {
    throw new TypeError(
      'new Zelavis(...) no longer accepts "coreServices". Platform subsystems moved to "subsystems" on zelavis(...), and the dashboard options moved to the public "frontend" option.',
    );
  }

  const forbiddenKeys = [
    "services",
    "serviceRegistry",
    "runtimeServices",
    "subsystems",
    "serviceContext",
    "servicePrefixes",
    "pathOverrides",
    "servicePackageInstaller",
    "serviceActivation",
    "resolvePrincipal",
  ].filter((key) => raw[key] !== undefined);

  if (forbiddenKeys.length === 0) {
    return;
  }

  throw new TypeError(
    `new Zelavis(...) does not accept internal runtime options (${forbiddenKeys.join(", ")}). Use zelavis(...) for low-level service composition.`,
  );
}


function mergeMaybeRecord<TValue>(
  base: TValue | undefined,
  override: TValue | undefined,
): TValue | undefined {
  if (override === undefined) {
    return base;
  }

  if (base === undefined) {
    return override;
  }

  if (isRecord(base) && isRecord(override)) {
    return {
      ...base,
      ...override,
    } as TValue;
  }

  return override;
}

function mergeSubsystemOptions(
  base: ZelavisSubsystemOptions | undefined,
  override: ZelavisSubsystemOptions | undefined,
): ZelavisSubsystemOptions | undefined {
  if (!base) return override;
  if (!override) return base;

  // Every member, listed once. The version this replaced omitted `fabric`
  // entirely, so an adapter and a host that both configured it silently lost
  // one of them — the same failure the registry merge had.
  return {
    auth: mergeMaybeRecord(base.auth, override.auth),
    database: mergeMaybeRecord(base.database, override.database),
    fabric: mergeMaybeRecord(base.fabric, override.fabric),
    storage: mergeMaybeRecord(base.storage, override.storage),
    workloads: mergeMaybeRecord(base.workloads, override.workloads),
    site: override.site ?? base.site,
  };
}

function assertResolvedServiceApi<TService>(
  value: unknown,
  serviceName: string,
): asserts value is TService {
  if (!value) {
    throw new Error(
      `Zelavis core service \`${serviceName}\` is not enabled on this runtime.`,
    );
  }
}

function readResolvedPath(
  root: unknown,
  path: readonly PropertyKey[],
): { found: true; value: unknown } | { found: false } {
  let value = root;

  for (const property of path) {
    if (
      (typeof value !== "object" && typeof value !== "function") ||
      value === null ||
      !(property in value)
    ) {
      return { found: false };
    }

    value = (value as Record<PropertyKey, unknown>)[property];
  }

  return { found: true, value };
}

function createRuntimeServiceApiProxy<TService>(
  resolve: () => Promise<TService>,
  resolved: () => TService | undefined,
  path: readonly PropertyKey[] = [],
): TService {
  return new Proxy(function () {}, {
    get(_target, property) {
      if (property === "then") {
        return undefined;
      }

      if (property === Symbol.toStringTag) {
        return "ZelavisRuntimeServiceApi";
      }

      if (path.length === 0 && property === "forTenant") {
        return (tenantId: string) =>
          createRuntimeServiceApiProxy(
            async () => {
              const service = await resolve();
              const method = (service as Record<string, unknown>).forTenant;
              if (typeof method !== "function") {
                throw new TypeError("Zelavis service member `forTenant` is not callable.");
              }
              return method.call(service, tenantId) as TService;
            },
            () => {
              const service = resolved();
              if (!service) return undefined;
              const method = (service as Record<string, unknown>).forTenant;
              return typeof method === "function"
                ? (method.call(service, tenantId) as TService)
                : undefined;
            },
          );
      }

      const current = resolved();
      if (current) {
        const read = readResolvedPath(current, [...path, property]);
        if (read.found) {
          return read.value;
        }
      }

      return createRuntimeServiceApiProxy(resolve, resolved, [
        ...path,
        property,
      ]);
    },
    apply(_target, _thisArg, args) {
      return resolve().then((service) => {
        let receiver: unknown = service;
        let value: unknown = service;

        for (const property of path) {
          receiver = value;
          value = (value as Record<PropertyKey, unknown>)[property];
        }

        if (typeof value !== "function") {
          throw new TypeError(
            `Zelavis service member \`${path.map(String).join(".")}\` is not callable.`,
          );
        }

        return value.apply(receiver, args);
      });
    },
  }) as TService;
}

function mergeZelavisServerOptions(
  base: ZelavisRuntimeCompositionOptions,
  override: ZelavisRuntimeCompositionOptions,
): ZelavisRuntimeCompositionOptions {
  const serviceCatalog = [
    ...(base.serviceRegistry?.catalog ?? []),
    ...(override.serviceRegistry?.catalog ?? []),
  ];
  const serviceStore =
    override.serviceRegistry?.store ?? base.serviceRegistry?.store;
  const serviceImporter =
    override.serviceRegistry?.importer ?? base.serviceRegistry?.importer;
  // Carried through the merge like every other registry field. Rebuilding the
  // object from a fixed list of keys silently dropped whichever ones nobody
  // remembered to add, which is how an adapter-supplied manifest resolver was
  // being lost.
  const serviceManifestResolver =
    override.serviceRegistry?.manifestResolver ??
    base.serviceRegistry?.manifestResolver;
  const discoveredServices = [
    ...(base.serviceRegistry?.discovered ?? []),
    ...(override.serviceRegistry?.discovered ?? []),
  ];
  const serviceContext = {
    ...(base.serviceContext ?? {}),
    ...(override.serviceContext ?? {}),
  };

  return {
    ...base,
    ...override,
    api: {
      ...(base.api ?? {}),
      ...(override.api ?? {}),
    },
    servicePackageInstaller:
      override.servicePackageInstaller ?? base.servicePackageInstaller,
    serviceActivation: override.serviceActivation ?? base.serviceActivation,
    systemStore: override.systemStore ?? base.systemStore,
    projectRuntime: override.projectRuntime ?? base.projectRuntime,
    deploymentBackends:
      override.deploymentBackends ?? base.deploymentBackends,
    agentOperations: override.agentOperations ?? base.agentOperations,
    hostOperations: override.hostOperations ?? base.hostOperations,
    remoteEnvironment: override.remoteEnvironment ?? base.remoteEnvironment,
    edge: override.edge ?? base.edge,
    edgeRoutes: override.edgeRoutes ?? base.edgeRoutes,
    serviceRegistry:
      serviceCatalog.length > 0 ||
      discoveredServices.length > 0 ||
      serviceStore ||
      serviceImporter ||
      serviceManifestResolver
        ? {
            ...(serviceCatalog.length > 0 ? { catalog: serviceCatalog } : {}),
            ...(discoveredServices.length > 0
              ? { discovered: discoveredServices }
              : {}),
            ...(serviceStore ? { store: serviceStore } : {}),
            ...(serviceImporter ? { importer: serviceImporter } : {}),
            ...(serviceManifestResolver
              ? { manifestResolver: serviceManifestResolver }
              : {}),
          }
        : undefined,
    serviceContext:
      Object.keys(serviceContext).length > 0 ? serviceContext : undefined,
    subsystems: mergeSubsystemOptions(base.subsystems, override.subsystems),
    frontend: override.frontend ?? base.frontend,
    servicePrefixes: {
      ...(base.servicePrefixes ?? {}),
      ...(override.servicePrefixes ?? {}),
    },
    pathOverrides: {
      ...(base.pathOverrides ?? {}),
      ...(override.pathOverrides ?? {}),
    },
  };
}

function mergePlatformResources(
  base: ZelavisPlatformResources | undefined,
  override: ZelavisPlatformResources | undefined,
): ZelavisPlatformResources {
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  };
}

function mergePlatformMetadata(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  };
}

async function resolvePlatformState(
  options: ZelavisOptions,
): Promise<{
  serverOptions: ZelavisRuntimeCompositionOptions;
  context: ZelavisPlatformContext;
}> {
  let resolved: ZelavisRuntimeCompositionOptions = {};
  let resources: ZelavisPlatformResources = {};
  let metadata: Record<string, unknown> = {};
  const presets: string[] = [];

  if (options.adapter?.resolve) {
    const next = await options.adapter.resolve(options);
    presets.push(options.adapter.name);
    resolved = mergeZelavisServerOptions(resolved, next);
    resources = mergePlatformResources(resources, next.resources);
    metadata = mergePlatformMetadata(metadata, next.metadata);
  }

  const { adapter: _adapter, ...serverOptions } = options;
  return {
    serverOptions: mergeZelavisServerOptions(resolved, serverOptions),
    context: {
      presets,
      resources,
      metadata,
    },
  };
}

function applyPlatformResourceDefaults(
  options: ZelavisRuntimeCompositionOptions,
  resources: ZelavisPlatformResources,
): ZelavisRuntimeCompositionOptions {
  const nextSubsystems: ZelavisSubsystemOptions = {
    ...(options.subsystems ?? {}),
  };
  if (!nextSubsystems.edgeCertificates && resources.edgeCertificates) {
    nextSubsystems.edgeCertificates = resources.edgeCertificates;
  }
  const nextServiceRegistry: ZelavisServiceRegistryOptions = {
    ...(options.serviceRegistry ?? {}),
  };

  // The runtime settings store is a resource, not a frontend concern. It used
  // to hang off `coreServices.dashboard`, which is why turning the dashboard
  // off also took the Platform's own settings persistence with it.
  const runtimeSettingsStore =
    options.runtimeSettingsStore ??
    (resources.systemStore
      ? createSystemStoreDashboardSettingsStore(resources.systemStore)
      : resources.kv
        ? createKeyValueDashboardSettingsStore(resources.kv)
        : undefined);

  if (nextSubsystems.storage !== false) {
    const currentStorage =
      nextSubsystems.storage === true || nextSubsystems.storage === undefined
        ? {}
        : nextSubsystems.storage;

    if (!currentStorage.storage && resources.files) {
      nextSubsystems.storage = {
        ...currentStorage,
        storage: resources.files,
      };
    }
  }

  if (!nextServiceRegistry.store) {
    nextServiceRegistry.store = resources.systemStore
      ? createSystemStoreServiceRegistryStore(resources.systemStore)
      : resources.kv
        ? createKeyValueServiceRegistryStore(resources.kv)
      : resources.files
        ? createFileStorageServiceRegistryStore(resources.files)
        : undefined;
  }

  return {
    ...options,
    serviceRegistry: nextServiceRegistry,
    subsystems: nextSubsystems,
    ...(runtimeSettingsStore ? { runtimeSettingsStore } : {}),
    systemStore: options.systemStore ?? resources.systemStore,
    projectRuntime: options.projectRuntime ?? resources.projectRuntime,
    deploymentBackends:
      options.deploymentBackends ?? resources.deploymentBackends,
    agentOperations: options.agentOperations ?? resources.agentOperations,
    hostOperations: options.hostOperations ?? resources.hostOperations,
    remoteEnvironment: options.remoteEnvironment ?? resources.remoteEnvironment,
    edge: options.edge ?? resources.edge,
    edgeRoutes: options.edgeRoutes ?? resources.edgeRoutes,
    edgeCertificates: options.edgeCertificates ?? resources.edgeCertificates,
  };
}

export class Zelavis {
  private readonly options: ZelavisOptions;
  private readonly serviceRegistryStore = createMemoryServiceRegistryStore([]);
  private runtimePromise?: Promise<ZelavisRuntime>;
  private readonly activeRuntimes = new Set<ZelavisRuntime>();
  private closed = false;
  private closePromise?: Promise<void>;
  private resolvedAuthApi?: AuthApi;
  private resolvedDatabaseApi?: DatabaseRuntimeApi;
  private resolvedPlatformContext: ZelavisPlatformContext = {
    presets: [],
    resources: {},
    metadata: {},
  };
  readonly auth: AuthApi;
  readonly db: DatabaseRuntimeApi;

  constructor(options: ZelavisOptions = {}) {
    assertNoInternalConstructorOptions(options);
    this.options = options;
    this.auth = createRuntimeServiceApiProxy(
      () => this.resolveAuthApi(),
      () => this.resolvedAuthApi,
    );
    this.db = createRuntimeServiceApiProxy(
      () => this.resolveDatabaseApi(),
      () => this.resolvedDatabaseApi,
    );
  }

  get platform(): ZelavisPlatformContext {
    return this.resolvedPlatformContext;
  }

  private invalidateRuntime() {
    this.runtimePromise = undefined;
    this.resolvedAuthApi = undefined;
    this.resolvedDatabaseApi = undefined;
  }

  async runtime(): Promise<ZelavisRuntime> {
    if (this.closed) {
      throw new Error("This Zelavis runtime has been closed.");
    }

    this.runtimePromise ??= (async () => {
      const resolved = await resolvePlatformState(this.options);
      const platformResources: ZelavisPlatformResources = {
        ...resolved.context.resources,
        services:
          resolved.context.resources.services ??
          {
            mode: "runtime",
            capabilities: {
              strategy: "runtime-graph",
              supportsRuntimeInstall: true,
              supportsUploadedSpecifiers: true,
              supportsPackageUploads: Boolean(
                resolved.context.resources.servicePackages,
              ),
              supportsPackageAcquisition: Boolean(
                resolved.context.resources.servicePackages?.acquire,
              ),
              supportsFrontendScaffolding: Boolean(
                resolved.context.resources.servicePackages?.scaffold,
              ),
              supportsIsolatedExecution: false,
              description:
                "Recomposes the in-process Zelavis runtime graph after service registry changes.",
            },
            activate: async () => {
              this.invalidateRuntime();
              return {
                status: "active",
                message:
                  "Service registry state changed. Zelavis will recompose the runtime for the next request.",
              };
            },
          },
      };
      this.resolvedPlatformContext = {
        ...resolved.context,
        resources: platformResources,
      };
      const serverOptions = applyPlatformResourceDefaults(
        resolved.serverOptions,
        platformResources,
      );
      const serviceRegistry = {
        ...(serverOptions.serviceRegistry ?? {}),
        store: serverOptions.serviceRegistry?.store ?? this.serviceRegistryStore,
      };
      // Default bundle store: wrap the adapter's file storage when present.
      // Explicit user-provided `bundleStore` always wins. Without either,
      // service `app` routes fall back to 404 — see ZelavisServerOptions.
      const bundleStore =
        serverOptions.bundleStore ??
        (platformResources.files
          ? createSharedBundleStore({ storage: platformResources.files })
          : undefined);
      // Domain bindings: explicit option wins, then fall through to
      // the adapter-supplied resource. No on-the-fly default — leaving
      // both unset means extension services get no host-bound routing,
      // which is the safe default.
      const domainBindings =
        serverOptions.domainBindings ?? platformResources.domainBindings;
      const runtimeOptions: ZelavisRuntimeCompositionOptions = {
          ...serverOptions,
          serviceRegistry,
          servicePackageInstaller: platformResources.servicePackages,
          serviceActivation: platformResources.services,
          bundleStore,
          domainBindings,
          serviceContext: {
            ...resolved.serverOptions.serviceContext,
            platform: createServiceSetupPlatformContext(
              this.resolvedPlatformContext,
            ),
          },
        };
      const runtime = await zelavis(runtimeOptions);
      this.activeRuntimes.add(runtime);
      return runtime;
    })();

    return this.runtimePromise;
  }

  async resolveAuthApi(): Promise<AuthApi> {
    if (this.resolvedAuthApi) {
      return this.resolvedAuthApi;
    }

    const runtime = await this.runtime();
    const service = runtime.auth ?? runtime.services["zelavis/auth"]?.service;
    assertResolvedServiceApi<AuthApi>(service, "zelavis/auth");
    this.resolvedAuthApi = service;
    return service;
  }

  async resolveDatabaseApi(): Promise<DatabaseRuntimeApi> {
    if (this.resolvedDatabaseApi) {
      return this.resolvedDatabaseApi;
    }

    const runtime = await this.runtime();
    const service = runtime.database ?? runtime.services["@zelavis/db"]?.service;
    assertResolvedServiceApi<DatabaseRuntimeApi>(service, "@zelavis/db");
    this.resolvedDatabaseApi = service;
    return service;
  }

  async fetch(
    request: Request,
    context?: ZelavisServerExecutionContext,
  ): Promise<Response> {
    const runtime = await this.runtime();
    const handler = runtime.fetch as ZelavisServerFetchHandler<unknown>;
    return handler(request, context);
  }

  async dispatch(
    request: Request,
    context?: ZelavisServerExecutionContext,
  ) {
    const runtime = await this.runtime();
    const handler = runtime.dispatch as ZelavisServerDispatchHandler<unknown>;
    return handler(request, context);
  }

  async plain(request: Parameters<ZelavisServerPlainHandler<unknown>>[0]) {
    const runtime = await this.runtime();
    const handler = runtime.plain as ZelavisServerPlainHandler<unknown>;
    return handler(request);
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.closed = true;
      await this.runtimePromise?.catch(() => undefined);
      await Promise.all(
        [...this.activeRuntimes].map((runtime) => runtime.close()),
      );
      this.activeRuntimes.clear();
    })();
    return this.closePromise;
  }
}
