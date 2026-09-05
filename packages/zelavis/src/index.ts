import {
  authService as createAuthService,
  createAuth,
  type AuthServiceOptions,
  createAuthorizationCodeFlow,
  createConnectionStore,
  createPasswordProvider,
  builtInOAuthProviders,
  environmentConnection,
  discoverOidcProvider,
  OAUTH_PROVIDER_CAPABILITY,
  PASSWORD_PROVIDER,
  publicConnection,
  type PublicOAuthConnection,
  type AuthMethodContext,
  type AuthMethodPlugin,
  type OAuthConnection,
  type OAuthProviderDefinition,
  type AuthApi,
} from "./app/auth/index.js";
import {
  createDatabase,
  defineDatabaseService,
  type CreateDatabaseOptions,
  type DatabaseApi,
} from "./app/db/index.js";
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
export * from "./assistant.js";
export * from "./bundle-store.js";
export * from "./tls.js";
export * from "./domain-binding.js";
export * from "./domain-verifier.js";
import { createSharedBundleStore, type BundleStore } from "./bundle-store.js";
import type { TlsProvider } from "./tls.js";
import {
  deleteProjectDomainBindings,
  type DomainBindingStore,
} from "./domain-binding.js";
import {
  createProjectManager,
  ZelavisProjectConflictError,
  ZelavisProjectNotFoundError,
  ZelavisProjectRuntimeError,
  ZelavisProjectValidationError,
  type ZelavisProjectDispatcher,
  type ZelavisProjectRuntimeDriver,
  type ZelavisProjectManager,
  type ZelavisProjectRecord,
} from "./project.js";
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
import {
  createMemorySystemStore,
  type ZelavisSystemStore,
} from "./system-store.js";
import { createDomainChallengeService } from "./domain-verifier.js";
import { synthesizeServiceAppService } from "./service-app.js";
import { createPlatformAuthRepositories } from "./platform/auth-repositories.js";
import { createPlatformAuthBootstrap } from "./platform/auth-bootstrap.js";
import { createServiceStore } from "./platform/service-store.js";
export * from "./storage/s3.js";

export type {
  CreateDatabaseOptions,
  DatabaseApi,
  DatabaseJsonObject,
} from "./app/db/index.js";
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








export type ZelavisDatabaseOptions =
  | boolean
  | CreateDatabaseOptions
  | DatabaseApi
  | Promise<DatabaseApi>;

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


function isDatabaseApi(value: unknown): value is DatabaseApi {
  return Boolean(
    value &&
    typeof value === "object" &&
    "forTenant" in value &&
    "capabilities" in value,
  );
}

async function resolveDatabaseCoreService(
  option: ZelavisDatabaseOptions | undefined,
): Promise<DatabaseApi | undefined> {
  const databaseOption = option ?? true;

  if (databaseOption === false) {
    return undefined;
  }

  if (databaseOption === true) {
    return createDatabase();
  }

  const resolvedDatabaseOption = await databaseOption;
  return isDatabaseApi(resolvedDatabaseOption)
    ? resolvedDatabaseOption
    : await createDatabase(resolvedDatabaseOption);
}

/**
 * Registers a credential provider for every installed OAuth definition.
 *
 * Core runs the Authorization Code flow — it holds the state, nonce and PKCE
 * verifier, and it is the only place those are handled — and a plugin
 * declaring `zelavis/auth:oauth` supplies the endpoints and claim mapping for
 * one identity provider. Google, GitHub, and a generic OIDC builder ship in
 * the box; anything else arrives as an ordinary plugin.
 *
 * The credentials an installation was issued are the operator's, so they are
 * read from the store rather than from any package. The Authorization Code
 * contract is synchronous, so the configuration is loaded once here and
 * refreshed whenever it is written.
 */
async function registerOAuthProviders(
  api: AuthApi,
  context: AuthMethodContext | undefined,
  options: { fetch?: typeof globalThis.fetch },
): Promise<void> {
  const definitions = new Map<string, OAuthProviderDefinition>();
  for (const entry of context?.registry ?? []) {
    if (entry.status !== "installed") continue;
    if (!entry.service.capabilities?.includes(OAUTH_PROVIDER_CAPABILITY)) continue;
    const declared = (
      entry.service.service as
        | { oauthProviders?: readonly OAuthProviderDefinition[] }
        | undefined
    )?.oauthProviders;
    if (!Array.isArray(declared)) continue;
    for (const definition of declared) {
      // First installed plugin wins, and the built-ins go in last: a later
      // install must not redirect sign-in for a name accounts already use.
      if (definition?.name && !definitions.has(definition.name)) {
        definitions.set(definition.name, definition);
      }
    }
  }
  for (const definition of builtInOAuthProviders) {
    if (!definitions.has(definition.name)) definitions.set(definition.name, definition);
  }

  const connections = context?.store
    ? createConnectionStore(context.store as never)
    : undefined;
  const active = new Map<string, OAuthConnection>();
  // Awaited rather than floated: a sign-in arriving immediately after boot
  // would otherwise find an empty map and be told the provider is unavailable.
  for (const stored of (await connections?.list()) ?? []) {
    active.set(stored.provider, stored);
    // A connection carrying its own discovered definition defines a provider
    // nothing installed knows about — an issuer an operator pasted in.
    if (!definitions.has(stored.provider) && stored.discovered) {
      definitions.set(
        stored.provider,
        stored.discovered as OAuthProviderDefinition,
      );
    }
  }
  for (const name of definitions.keys()) {
    if (active.has(name)) continue;
    const fromEnvironment = environmentConnection(name);
    if (fromEnvironment) active.set(name, fromEnvironment);
  }

  const require = (name: string): OAuthConnection => {
    const connection = active.get(name);
    if (!connection?.enabled) {
      // The same message whether a provider is unconfigured or switched off:
      // which it is describes the installation's setup to a stranger.
      throw new TypeError(`${name} sign-in is not available on this installation.`);
    }
    return connection;
  };

  const registerProvider = (definition: OAuthProviderDefinition) => {
    const name = definition.name;
    api.authentication.registerProvider({
      name,
      authorizationCode: {
        get redirectUri() {
          return require(name).redirectUri;
        },
        createAuthorizationUrl(input) {
          return createAuthorizationCodeFlow(definition, require(name), options)
            .createAuthorizationUrl(input);
        },
        exchange(input) {
          return createAuthorizationCodeFlow(definition, require(name), options)
            .exchange(input);
        },
      },
    });
  };
  for (const definition of definitions.values()) registerProvider(definition);

  oauthRuntime = {
    definitions,
    connections,
    active,
    fetch: options.fetch,
    register: registerProvider,
  };
}

/**
 * Saves the credentials an installation was issued for one provider.
 *
 * Kept beside registration rather than in a service of its own: the same map
 * the flow reads is the one this writes, and a second copy of it would drift
 * from whatever an operator last saved.
 */
async function configureOAuthConnection(
  provider: string,
  input: unknown,
): Promise<PublicOAuthConnection | undefined> {
  const runtime = oauthRuntime;
  if (!runtime) return undefined;

  const body = (input ?? {}) as Partial<OAuthConnection>;
  // An issuer turns a provider nobody shipped into one this installation has.
  // Every OIDC issuer publishes its own endpoints, so adding Okta, Auth0,
  // Keycloak, Google or a company's SSO is a URL rather than a plugin.
  let discovered: OAuthProviderDefinition | undefined;
  if (typeof body.issuer === "string" && body.issuer.trim()) {
    discovered = await discoverOidcProvider(body.issuer.trim(), {
      name: provider,
      ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
    });
    runtime.definitions.set(provider, discovered);
    runtime.register?.(discovered);
  }

  if (!runtime.definitions.has(provider)) return undefined;
  if (!runtime.connections) {
    throw new ZelavisValidationError(
      "This installation has no durable store, so OAuth configuration cannot be saved.",
    );
  }

  if (typeof body.clientId !== "string" || !body.clientId.trim()) {
    throw new ZelavisValidationError("A clientId is required.");
  }
  if (typeof body.redirectUri !== "string" || !body.redirectUri.trim()) {
    throw new ZelavisValidationError("A redirectUri is required.");
  }
  let redirect: URL;
  try {
    redirect = new URL(body.redirectUri);
  } catch {
    throw new ZelavisValidationError("The redirectUri must be an absolute URL.");
  }
  if (redirect.protocol !== "https:" && redirect.hostname !== "localhost") {
    // The authorization code arrives on this URL. Over plaintext anyone on the
    // path can take it, and a code is enough to complete a sign-in.
    throw new ZelavisValidationError(
      "The redirectUri must use https, except on localhost for development.",
    );
  }

  const existing = await runtime.connections.read(provider);
  const connection: OAuthConnection = {
    provider,
    clientId: body.clientId.trim(),
    // An omitted secret keeps the stored one: the API never returns it, so an
    // operator editing a redirect URI has nothing to send back.
    ...(typeof body.clientSecret === "string" && body.clientSecret
      ? { clientSecret: body.clientSecret }
      : existing?.clientSecret
        ? { clientSecret: existing.clientSecret }
        : {}),
    redirectUri: redirect.toString(),
    ...(discovered
      ? { issuer: discovered.issuer, discovered }
      : existing?.discovered
        ? { issuer: existing.issuer, discovered: existing.discovered }
        : {}),
    ...(Array.isArray(body.scopes)
      ? { scopes: body.scopes.filter((scope) => typeof scope === "string") }
      : {}),
    enabled: body.enabled !== false,
    updatedAt: new Date().toISOString(),
  };

  await runtime.connections.write(connection);
  runtime.active.set(provider, connection);
  return publicConnection(connection);
}

async function listOAuthConnections(): Promise<
  readonly (PublicOAuthConnection & { title?: string; configured: boolean })[]
> {
  const runtime = oauthRuntime;
  if (!runtime) return [];
  return [...runtime.definitions].map(([name, definition]) => {
    const connection = runtime.active.get(name);
    return {
      ...(connection
        ? publicConnection(connection)
        : {
            provider: name,
            clientId: "",
            redirectUri: "",
            enabled: false,
            updatedAt: new Date(0).toISOString(),
            hasClientSecret: false,
          }),
      ...(definition.title ? { title: definition.title } : {}),
      configured: Boolean(connection),
    };
  });
}

async function removeOAuthConnection(provider: string): Promise<void> {
  const runtime = oauthRuntime;
  if (!runtime) return;
  await runtime.connections?.remove(provider);
  // The environment may still define it, so the active map is recomputed for
  // this provider rather than the entry simply dropped.
  const fallback = environmentConnection(provider);
  if (fallback) runtime.active.set(provider, fallback);
  else runtime.active.delete(provider);
}

/** Set when auth is composed, so the endpoints below can reach the same state. */
let oauthRuntime:
  | {
      definitions: Map<string, OAuthProviderDefinition>;
      connections: ReturnType<typeof createConnectionStore> | undefined;
      active: Map<string, OAuthConnection>;
      fetch?: typeof globalThis.fetch;
      register?: (definition: OAuthProviderDefinition) => void;
    }
  | undefined;

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
    {
      name: "zelavis/auth:oauth",
      register(api, context) {
        return registerOAuthProviders(api, context, configured.oauth ?? {});
      },
    },
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
      oauthConnections: {
        list: listOAuthConnections,
        configure: configureOAuthConnection,
        remove: removeOAuthConnection,
      },
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
  const readResolvedServiceRegistry = async () => {
    const storedEntries = await context.serviceRegistryStore.read();
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

    // A service that ships its own pages serves them from its declaration.
    // The lookup is scoped to this registry entry, so one service can never
    // reach another's assets, and no bundle store needs to exist at all.
    const shipped = entry.service.pageAssets?.[normalizedPath.replace(/^\/+/, "")];
    if (shipped) {
      const body =
        typeof shipped.body === "string"
          ? new TextEncoder().encode(shipped.body)
          : shipped.body;
      const shippedHeaders = new Headers();
      shippedHeaders.set(
        "content-type",
        shipped.contentType ?? guessServiceAssetContentType(normalizedPath),
      );
      shippedHeaders.set("cache-control", shipped.cacheControl ?? "no-cache");
      return { status: 200, headers: shippedHeaders, body };
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
  const createDashboardRuntimeConfig = async () => {
    const serviceRegistry = await readResolvedServiceRegistry();
    const serializedServices = serviceRegistry.map((entry) => ({
      name: entry.service.name,
      version: entry.service.version,
      kind: entry.service.kind,
      specifier: entry.specifier,
      status: entry.status,
      source: entry.source,
      order: entry.order,
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
        name: entry.service.name,
        version: entry.service.version,
        kind: entry.service.kind,
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
        specifier: entry.specifier,
        status: entry.status,
        source: entry.source,
        order: entry.order,
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
            name: entry.name,
            specifier: entry.specifier,
            status: entry.status ?? "available",
            source: entry.source,
            order: entry.order,
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
                    specifier: service.specifier,
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
                packageInstaller: context.servicePackageInstaller,
              });
              const currentEntries = await context.serviceRegistryStore.read();
              const nextEntries = [
                ...(currentEntries ?? []).filter(
                  (entry) => entry.name !== created.name,
                ),
                created,
              ];

              await context.serviceRegistryStore.write(nextEntries);
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
              const currentEntries =
                (await context.serviceRegistryStore.read()) ?? [];
              const currentRegistry = await readResolvedServiceRegistry();
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

              const serializedNextRegistry = serializeServiceRegistryState(
                nextRegistry,
              );
              const registryNames = new Set(
                serializedNextRegistry.map((entry) => entry.name),
              );
              const serializedNextEntries = updatedRegistryEntry
                ? [
                    ...serializedNextRegistry,
                    ...currentEntries.filter(
                      (entry) => !registryNames.has(entry.name),
                    ),
                  ]
                : currentEntries.map((entry) =>
                    entry.name === serviceName
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
                  );

              await context.serviceRegistryStore.write(serializedNextEntries);
              const activation = await activateServiceRegistryChange(
                {
                  serviceName,
                  action:
                    update.status === "installed"
                      ? "install"
                      : update.status === "available"
                        ? "uninstall"
                        : "update",
                  specifier: nextRegistry.find(
                    (entry) => entry.service.name === serviceName,
                  )?.specifier ?? updatedStoredEntry?.specifier,
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

async function resolvePlatformCoreService(
  projectRecipes: readonly Readonly<ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>>[],
  projects?: ZelavisProjectManager,
  fabric?: FabricApi,
  systemStore?: ZelavisSystemStore,
  deploymentBackends?: ZelavisDeploymentBackendManager,
  agentOperations?: ZelavisAgentOperationReader,
  runtimeManagementRoutes: readonly ZelavisServerRoute<any>[] = [],
  assistantOption?: false | ZelavisAssistantResponder,
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
                  name: entry.service.name,
                  version: entry.service.version,
                  specifier: entry.specifier,
                  status: entry.status,
                  source: entry.source,
                  title:
                    entry.service.marketplace?.title ??
                    entry.service.menu?.title ??
                    entry.service.name,
                  summary: entry.service.marketplace?.summary,
                  marketplace: entry.service.marketplace,
                  runtimeKinds: entry.service.project?.runtimeKinds ?? ["native"],
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

  for (const service of services) {
    if (service.name === "@zelavis/frontend") {
      prefixes[service.name] = "/";
      continue;
    }

    if (frontendServices.has(service.name)) {
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
  const databaseApi = await resolveDatabaseCoreService(options.subsystems?.database);
  const databaseService = databaseApi && !hasAppService
    ? defineDatabaseService(databaseApi)
    : undefined;
  const resolvedDatabaseApi = databaseApi;
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
              return (value.runtimeKind ?? "native") === backendId;
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
    runtimeManagement.routes,
    options.assistant,
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

  return Object.assign(runtime, { fetch: guardedFetch, close });
}

export interface ZelavisRuntime extends ZelavisServerRuntime<unknown> {
  close(): Promise<void>;
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
  private resolvedDatabaseApi?: DatabaseApi;
  private resolvedPlatformContext: ZelavisPlatformContext = {
    presets: [],
    resources: {},
    metadata: {},
  };
  readonly auth: AuthApi;
  readonly db: DatabaseApi;

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
    const service = runtime.services["zelavis/auth"]?.service;
    assertResolvedServiceApi<AuthApi>(service, "zelavis/auth");
    this.resolvedAuthApi = service;
    return service;
  }

  async resolveDatabaseApi(): Promise<DatabaseApi> {
    if (this.resolvedDatabaseApi) {
      return this.resolvedDatabaseApi;
    }

    const runtime = await this.runtime();
    const service = runtime.services["@zelavis/db"]?.service;
    assertResolvedServiceApi<DatabaseApi>(service, "@zelavis/db");
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
