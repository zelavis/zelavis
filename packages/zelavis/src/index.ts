import {
  authService as createAuthService,
  createAuth,
  type AuthServiceOptions,
  type AuthMethodPlugin,
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
  type ZelavisServerPlainHandler,
  type ZelavisServerRoute,
  type ZelavisServerRuntime,
  type ZelavisPrincipalResolver,
  type ZelavisRuntimeService,
} from "./core/index.js";
import {
  createZelavisDashboardBundleStore,
  createZelavisDashboardService,
  defaultZelavisDashboardClientRoutes,
} from "@zelavis/ui/service";
import { zelavisServicePageStylesheet } from "@zelavis/ui/service-page-styles";
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
  ZelavisStorageCoreServiceInput,
  ZelavisStorageCoreServiceOptions,
} from "./platform/storage-types.js";
import type {
  ZelavisFileStorage,
  ZelavisStorageCoreServiceInput,
} from "./platform/storage-types.js";


export type ZelavisAuthCoreServiceOptions = boolean | AuthServiceOptions;

export interface ZelavisDashboardCoreServiceOptions {
  title?: string;
  subtitle?: string;
  clientRoutes?: readonly string[];
  devServerUrl?: string;
  settingsStore?: ZelavisDashboardSettingsStore;
}

export type ZelavisDashboardCoreServiceInput =
  | boolean
  | ZelavisDashboardCoreServiceOptions;



export type ZelavisWebsiteCoreServiceInput = boolean;


export type ZelavisWorkloadsCoreServiceInput =
  | boolean
  | WorkloadsServiceOptions;








export type ZelavisDatabaseCoreServiceOptions =
  | boolean
  | CreateDatabaseOptions
  | DatabaseApi
  | Promise<DatabaseApi>;

export type ZelavisFabricCoreServiceInput = boolean | FabricServiceOptions;

export interface ZelavisCoreServicesOptions {
  auth?: ZelavisAuthCoreServiceOptions;
  dashboard?: ZelavisDashboardCoreServiceInput;
  database?: ZelavisDatabaseCoreServiceOptions;
  fabric?: ZelavisFabricCoreServiceInput;
  storage?: ZelavisStorageCoreServiceInput;
  website?: ZelavisWebsiteCoreServiceInput;
  workloads?: ZelavisWorkloadsCoreServiceInput;
}

export interface ZelavisApiOptions {
  prefix?: string;
  version?: string;
}


export interface ZelavisServiceRegistryOptions {
  catalog?: readonly ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>[];
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
  api?: ZelavisApiOptions;
  servicePackageInstaller?: ZelavisServicePackageInstaller;
  serviceActivation?: ZelavisServiceActivationController;
  serviceContext?: ZelavisServiceContextOptions;
  coreServices?: ZelavisCoreServicesOptions;
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
  "@zelavis/auth",
  "zelavis/platform",
  "@zelavis/marketplace",
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
  option: ZelavisDatabaseCoreServiceOptions | undefined,
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

async function resolveAuthCoreService(
  option: ZelavisAuthCoreServiceOptions | undefined,
  methods: readonly AuthMethodPlugin[] = [],
  systemStore?: ZelavisSystemStore,
  rootPath = "/zelavis",
  bootstrapToken?: string,
): Promise<ZelavisRuntimeService<any> | undefined> {
  const authOption = option ?? true;

  if (authOption === false) {
    return undefined;
  }

  const configured = authOption === true ? {} : authOption;
  const auth = configured.auth ?? await createAuth({
    ...(configured.authOptions ?? {}),
    repositories: {
      ...(systemStore ? createPlatformAuthRepositories(systemStore) : {}),
      ...(configured.authOptions?.repositories ?? {}),
    },
    methods: [
      ...(configured.authOptions?.methods ?? []),
      ...(configured.methods ?? []),
      ...methods,
    ],
  });

  return createAuthService({
    ...configured,
    auth,
    methods: [],
    definition: {
      ...(configured.definition ?? {}),
      authority: "platform",
      bootstrap: createPlatformAuthBootstrap(auth, { store: systemStore }),
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

function collectAuthMethodPlugins(
  registry: readonly Readonly<ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>>[],
): readonly AuthMethodPlugin[] {
  return Object.freeze(
    registry
      .filter(
        (entry) =>
          entry.status === "installed" &&
          entry.service.capabilities?.includes("provider:auth") &&
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
  option: ZelavisDashboardCoreServiceInput | undefined,
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
    websiteEnabled: boolean;
    bundleStore?: BundleStore;
    platform?: ZelavisServiceSetupPlatformContext;
  },
): Promise<ZelavisRuntimeManagementCore> {
  const dashboardOption = option ?? true;
  const options =
    dashboardOption === true || dashboardOption === false ? {} : dashboardOption;
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
    context.settingsStore ??
    options.settingsStore ??
    createMemoryDashboardSettingsStore();
  const clientRoutes = [
    ...new Set(
      (options.clientRoutes ?? defaultZelavisDashboardClientRoutes)
        .map((route) => normalizePath(route, "/"))
        .filter((route) => route !== "/"),
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
        core:
          service.name === "@zelavis/ui" ||
          service.name === "zelavis/platform" ||
          service.name === "@zelavis/marketplace" ||
          service.name === "zelavis/fabric" ||
          service.name === "@zelavis/auth" ||
          service.name === "@zelavis/db" ||
          service.name === "@zelavis/storage" ||
          service.name === "@zelavis/frontend" ||
          service.name === "@zelavis/workloads",
        apiPath:
          service.name === "@zelavis/frontend"
            ? "/"
            : service.name === "@zelavis/ui"
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
        specifier: entry.specifier,
        status: entry.status,
        source: entry.source,
        order: entry.order,
        marketplace: entry.service.marketplace,
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
        pageBuilder: context.websiteEnabled,
      },
      restartRequired: Boolean(pendingRootPath) || runtimeEngineRestartRequired,
    };
  };
  const routes: ZelavisServerRoute<any>[] = [
        {
          id: "runtime.config",
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
          id: "runtime.services.create",
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
            body: zelavisServicePageStylesheet,
          }),
        },
        {
          id: "runtime.service-page-asset.read",
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
        {
          id: "runtime.openapi",
          method: "GET",
          path: joinPathParts(
            context.apiPrefix,
            context.apiVersion,
            "runtime/openapi.json",
          ),
          handler: () => {
            const services = context.getServices();
            const resolved = resolveMountedEndpoints(services, {
              prefix: context.apiPrefix,
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
              }),
            };
          },
        },
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

async function resolveDashboardCoreService(
  option: ZelavisDashboardCoreServiceInput | undefined,
  context: {
    rootPath: string;
    createRuntimeConfig: () => Promise<unknown>;
  },
): Promise<ZelavisRuntimeService<any> | undefined> {
  const dashboardOption = option ?? true;
  if (dashboardOption === false) {
    return undefined;
  }

  const options = dashboardOption === true ? {} : dashboardOption;
  return createZelavisDashboardService({
    title: options.title,
    subtitle: options.subtitle,
    rootPath: context.rootPath,
    devServerUrl: normalizeExternalUrl(
      options.devServerUrl ?? readOptionalProcessEnv("ZELAVIS_UI_DEV_SERVER"),
    ),
    createRuntimeConfig: context.createRuntimeConfig,
  }) as unknown as ZelavisRuntimeService<any>;
}

async function resolveWorkloadsCoreService(
  option: ZelavisWorkloadsCoreServiceInput | undefined,
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

function resolveFabricCoreService(
  option: ZelavisFabricCoreServiceInput | undefined,
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
    runtimeNodeId: localNodeId,
    ...(project.capabilities.managedDatabase
      ? { databaseNodeId: localNodeId }
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
  appServices: readonly Readonly<ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>>[],
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
          id: "runtime.app-services.list",
          method: "GET",
          path: "/app-services",
          access: { authenticated: true },
          handler: () => ({
            status: 200,
            body: {
              appServices: appServices
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
                ...(typeof input.appServiceName === "string"
                  ? { appServiceName: input.appServiceName }
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

async function synthesizeDashboardAppService(
  dashboardService: ZelavisRuntimeService<any>,
  rootPath: string,
): Promise<ZelavisRuntimeService | undefined> {
  const dashboardBundleStore = createZelavisDashboardBundleStore(rootPath);
  const bundleStore: BundleStore = {
    async read(scope, path) {
      return dashboardBundleStore.read(scope, path);
    },
  };

  const appService = await synthesizeServiceAppService({
    service: dashboardService as any,
    bundleStore,
    effectiveMount: "/",
  });

  return appService;
}

function stripDashboardServiceFields(
  dashboardService: ZelavisRuntimeService<any>,
): ZelavisRuntimeService<any> {
  const { app: _app, ...rest } = dashboardService as ZelavisRuntimeService<any> & {
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
  },
): Record<string, string> {
  const prefixes: Record<string, string> = {};
  const mountAtRoot = options.mountPrefix === "/";

  for (const service of services) {
    if (service.name === "@zelavis/frontend") {
      prefixes[service.name] = "/";
      continue;
    }

    if (service.name === "@zelavis/ui" || service.name === "@zelavis/ui:app") {
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
      `zelavis(...) no longer accepts direct service options (${obsoleteKeys.join(", ")}). Put services in the services folder or install them through the service registry endpoints.`,
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
  const knownServiceNames = new Set(
    baseServiceRegistry.map((entry) => entry.service.name),
  );
  const completeServiceRegistry = createServiceRegistry([
    ...baseServiceRegistry,
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
  const databaseApi = await resolveDatabaseCoreService(options.coreServices?.database);
  const databaseService = databaseApi && !hasAppService
    ? defineDatabaseService(databaseApi)
    : undefined;
  const resolvedDatabaseApi = databaseApi;
  const authService = hasAppService
      ? undefined
      : await resolveAuthCoreService(
        options.coreServices?.auth,
        collectAuthMethodPlugins(serviceRegistry),
        systemStore,
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
    },
  );
  const serviceRuntimeServices = await Promise.all(activatedServices.services);
  const dashboardSettingsStore = resolveRuntimeSettingsStore(
    options.coreServices?.dashboard,
    createSystemStoreDashboardSettingsStore(systemStore),
  );
  const websiteCoreOptions = options.coreServices?.website;
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
  const dashboardEnabled = options.coreServices?.dashboard !== false;
  const websiteService =
    websiteCoreOptions === false
      ? undefined
      : createProjectFrontendPlaceholderService({
          reservedPrefixes: [rootPath, joinPathParts(rootPath, apiPrefix)],
          ...(dashboardEnabled ? { redirectTo: rootPath } : {}),
          publicDomains: {
            ...(options.domainBindings ? { domainBindings: options.domainBindings } : {}),
            // Late-bound: the Project manager is composed after this service.
            projects: () => projects,
          },
        });
  const storageService = await resolveStorageCoreService(options.coreServices?.storage, {
        rootPath,
        apiPrefix,
        apiVersion,
      });
  const workloadsCoreService = hasAppService
      ? undefined
      : await resolveWorkloadsCoreService(options.coreServices?.workloads);
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
          appServices: serviceRegistry,
          store: systemStore,
          runtime: projectRuntime,
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
    options.coreServices?.fabric,
    {
      projects,
      runtimeEngine: detectCurrentRuntimeEngine(
        options.serviceContext?.platform?.metadata,
      ),
    },
  );
  const websiteEnabled = Boolean(websiteService);
  let runtimeConfigServices: readonly ZelavisRuntimeService<any>[] = [];
  const runtimeManagement = await resolveRuntimeManagementCore(
    options.coreServices?.dashboard,
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
      settingsStore: dashboardSettingsStore,
      websiteEnabled,
      bundleStore: options.bundleStore,
      platform: options.serviceContext?.platform,
    },
  );
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
  const coreServices = [
    platformCoreService,
    await createZelavisMarketplaceService(),
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
  const dashboardService = await resolveDashboardCoreService(options.coreServices?.dashboard, {
        rootPath,
        createRuntimeConfig: runtimeManagement.createRuntimeConfig,
      });
  // Synthesize the sibling app service through the same primitive user
  // services use, then hide the service-only `app` field from the externally
  // visible service map.
  const dashboardAppService = dashboardService
    ? await synthesizeDashboardAppService(dashboardService, rootPath)
    : undefined;
  const sanitizedDashboardService = dashboardService
    ? stripDashboardServiceFields(dashboardService)
    : undefined;
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
    ...coreServices,
  ].filter(
    (service): service is ZelavisRuntimeService<any> => Boolean(service),
  );
  const finalServices = [
    sanitizedDashboardService,
    dashboardAppService,
    domainChallengeService,
    ...coreServices,
  ].filter(
    (service): service is ZelavisRuntimeService<any> => Boolean(service),
  );
  const mountPrefix = websiteEnabled ? "/" : rootPath;

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
    }),
  });
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
  const forbiddenKeys = [
    "services",
    "serviceRegistry",
    "runtimeServices",
    "coreServices",
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

function mergeCoreServicesOptions(
  base: ZelavisCoreServicesOptions | undefined,
  override: ZelavisCoreServicesOptions | undefined,
): ZelavisCoreServicesOptions | undefined {
  if (!base) {
    return override;
  }

  if (!override) {
    return base;
  }

  return {
    auth: mergeMaybeRecord(base.auth, override.auth),
    dashboard: mergeMaybeRecord(base.dashboard, override.dashboard),
    database: mergeMaybeRecord(base.database, override.database),
    storage: mergeMaybeRecord(base.storage, override.storage),
    website: mergeMaybeRecord(base.website, override.website),
    workloads: mergeMaybeRecord(base.workloads, override.workloads),
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
      serviceCatalog.length > 0 || serviceStore || serviceImporter
        ? {
            ...(serviceCatalog.length > 0 ? { catalog: serviceCatalog } : {}),
            ...(serviceStore ? { store: serviceStore } : {}),
            ...(serviceImporter ? { importer: serviceImporter } : {}),
          }
        : undefined,
    serviceContext:
      Object.keys(serviceContext).length > 0 ? serviceContext : undefined,
    coreServices: mergeCoreServicesOptions(
      base.coreServices,
      override.coreServices,
    ),
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
  const nextCoreServices: ZelavisCoreServicesOptions = {
    ...(options.coreServices ?? {}),
  };
  const nextServiceRegistry: ZelavisServiceRegistryOptions = {
    ...(options.serviceRegistry ?? {}),
  };

  if (nextCoreServices.dashboard !== false) {
    const currentDashboard =
      nextCoreServices.dashboard === true || nextCoreServices.dashboard === undefined
        ? {}
        : nextCoreServices.dashboard;

    if (!currentDashboard.settingsStore) {
      const settingsStore = resources.systemStore
        ? createSystemStoreDashboardSettingsStore(resources.systemStore)
        : resources.kv
          ? createKeyValueDashboardSettingsStore(resources.kv)
          : undefined;

      if (settingsStore) {
        nextCoreServices.dashboard = {
          ...currentDashboard,
          settingsStore,
        };
      }
    }
  }

  if (nextCoreServices.storage !== false) {
    const currentStorage =
      nextCoreServices.storage === true || nextCoreServices.storage === undefined
        ? {}
        : nextCoreServices.storage;

    if (!currentStorage.storage && resources.files) {
      nextCoreServices.storage = {
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
    coreServices: nextCoreServices,
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
    const service = runtime.services["@zelavis/auth"]?.service;
    assertResolvedServiceApi<AuthApi>(service, "@zelavis/auth");
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
