import {
  authService as createAuthService,
  AuthDomainError,
  AuthNotFoundError,
  AuthValidationError,
  type AuthServiceOptions,
  type AuthProviderService,
  type AuthApi,
} from "@zelavis/auth";
import {
  createDatabase,
  defineDatabaseService,
  DatabaseConflictError,
  DatabaseRevisionMismatchError,
  DatabaseValidationError,
  type CreateDatabaseOptions,
  type DatabaseApi,
  type DatabaseJsonObject,
  DatabaseNotFoundError,
} from "@zelavis/db";
import {
  createMappedJsonErrorResponse,
  zelavisServer as mountZelavisServer,
  type ZelavisServerErrorStatusRule,
  type ZelavisAnyRuntimeServiceInput,
  type ZelavisServerDispatchHandler,
  type ZelavisServerErrorHandler,
  type ZelavisServerExecutionContext,
  type ZelavisServerFetchHandler,
  type ZelavisServerPlainHandler,
  type ZelavisServerRoute,
  type ZelavisServerRuntime,
  type ZelavisRuntimeService,
} from "@zelavis/server";
import {
  createZelavisDashboardBundleStore,
  createZelavisDashboardService,
  defaultZelavisDashboardClientRoutes,
} from "@zelavis/ui/service";
import {
  workloadsService,
  type WorkloadsServiceOptions,
} from "@zelavis/workloads";
import {
  activateServiceRegistry,
  applyServiceRegistryState,
  createServiceRegistry,
  findServiceMenuPageById,
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
export * from "./blueprint.js";
export * from "./system-store.js";
export * from "./project.js";
export * from "./assistant.js";
export * from "./bundle-store.js";
export * from "./tls.js";
export * from "./domain-binding.js";
export * from "./domain-verifier.js";
import { createSharedBundleStore, type BundleStore } from "./bundle-store.js";
import type { TlsProvider } from "./tls.js";
import type { DomainBindingStore } from "./domain-binding.js";
import type { ZelavisBlueprintRegistry } from "./blueprint.js";
import {
  createProjectManager,
  ZelavisProjectConflictError,
  ZelavisProjectNotFoundError,
  ZelavisProjectValidationError,
  type ZelavisProjectRuntimeDriver,
} from "./project.js";
import {
  createAssistantManager,
  ZelavisAssistantNotFoundError,
  ZelavisAssistantValidationError,
  type ZelavisAssistantResponder,
} from "./assistant.js";
import {
  createMemorySystemStore,
  type ZelavisSystemStore,
  type ZelavisSystemStoreValue,
} from "./system-store.js";
import { createDomainChallengeService } from "./domain-verifier.js";
import { synthesizeServiceAppService } from "./service-app.js";
import type {
  ZelavisServiceDefinition,
} from "./service.js";
export * from "./storage/s3.js";

export type {
  CreateDatabaseOptions,
  DatabaseApi,
  DatabaseJsonObject,
} from "@zelavis/db";
export {
  type ZelavisAnyRuntimeServiceInput,
  type ZelavisServerErrorHandler,
  type ZelavisServerRoute,
  type ZelavisServerRuntime,
  type ZelavisRuntimeService,
} from "@zelavis/server";

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

export interface ZelavisWebsiteAction {
  label: string;
  href: string;
  variant?: "primary" | "secondary";
}

export interface ZelavisWebsiteCard {
  title: string;
  description: string;
  href?: string;
}

export interface ZelavisWebsitePage {
  path: string;
  title: string;
  kicker?: string;
  headline?: string;
  description?: string;
  actions?: readonly ZelavisWebsiteAction[];
  cards?: readonly ZelavisWebsiteCard[];
}

export interface ZelavisWebsitePagesStore {
  read: () =>
    | Promise<readonly ZelavisWebsitePage[]>
    | readonly ZelavisWebsitePage[];
  write: (
    pages: readonly ZelavisWebsitePage[],
  ) => Promise<readonly ZelavisWebsitePage[]> | readonly ZelavisWebsitePage[];
}

export interface ZelavisWebsiteCoreServiceOptions {
  pagesStore?: ZelavisWebsitePagesStore;
}

export type ZelavisWebsiteCoreServiceInput =
  | boolean
  | ZelavisWebsiteCoreServiceOptions;

export interface ZelavisStorageCoreServiceOptions {
  storage?: ZelavisFileStorage;
}

export type ZelavisStorageCoreServiceInput =
  | boolean
  | ZelavisStorageCoreServiceOptions;

export type ZelavisWorkloadsCoreServiceInput =
  | boolean
  | WorkloadsServiceOptions;

class ZelavisDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZelavisDomainError";
  }
}

class ZelavisValidationError extends ZelavisDomainError {
  constructor(message: string) {
    super(message);
    this.name = "ZelavisValidationError";
  }
}

class ZelavisConflictError extends ZelavisDomainError {
  constructor(message: string) {
    super(message);
    this.name = "ZelavisConflictError";
  }
}

function parseStoredDashboardSettingsUpdate(
  input: Record<string, unknown>,
): ZelavisDashboardSettingsUpdate {
  const update: ZelavisDashboardSettingsUpdate = {};

  if ("rootPath" in input) {
    if (typeof input.rootPath !== "string") {
      throw new ZelavisValidationError(
        "Stored dashboard root path must be a string.",
      );
    }

    update.rootPath = normalizeEditableRootPath(input.rootPath);
  }

  if ("theme" in input) {
    if (!isDashboardThemeMode(input.theme)) {
      throw new ZelavisValidationError(
        'Stored dashboard theme must be one of "light", "dark", or "auto".',
      );
    }

    update.theme = input.theme;
  }

  if ("pageBuilderEnabled" in input) {
    if (!isBoolean(input.pageBuilderEnabled)) {
      throw new ZelavisValidationError(
        "Stored page builder enabled must be a boolean.",
      );
    }

    update.pageBuilderEnabled = input.pageBuilderEnabled;
  }

  if ("preferences" in input) {
    update.preferences = parseStoredDashboardPreferences(input.preferences);
  }

  return update;
}

function parseStoredDashboardContentPreferences(
  value: unknown,
): ZelavisDashboardContentPreferences {
  const input = readBodyObject(value);
  const preferences: ZelavisDashboardContentPreferences = {};

  if ("pinnedTypes" in input) {
    if (!Array.isArray(input.pinnedTypes)) {
      throw new ZelavisValidationError(
        "Stored dashboard content pinned types must be an array.",
      );
    }

    preferences.pinnedTypes = input.pinnedTypes.map((entry) => {
      if (typeof entry !== "string" || !entry.trim()) {
        throw new ZelavisValidationError(
          "Stored dashboard content pinned types must contain non-empty strings.",
        );
      }

      return entry.trim();
    });
  }

  if ("labels" in input) {
    const labels = readBodyObject(input.labels);
    preferences.labels = Object.fromEntries(
      Object.entries(labels)
        .filter(([, label]) => label !== undefined)
        .map(([key, label]) => {
          if (typeof label !== "string" || !label.trim()) {
            throw new ZelavisValidationError(
              "Stored dashboard content labels must be non-empty strings.",
            );
          }

          return [key, label.trim()] as const;
        }),
    );
  }

  return preferences;
}

function parseStoredDashboardMediaPreferences(
  value: unknown,
): ZelavisDashboardMediaPreferences {
  const input = readBodyObject(value);
  const preferences: ZelavisDashboardMediaPreferences = {};

  if ("orderedPaths" in input) {
    if (!Array.isArray(input.orderedPaths)) {
      throw new ZelavisValidationError(
        "Stored dashboard media ordered paths must be an array.",
      );
    }

    preferences.orderedPaths = input.orderedPaths.map((entry) => {
      if (typeof entry !== "string" || !entry.trim()) {
        throw new ZelavisValidationError(
          "Stored dashboard media ordered paths must contain non-empty strings.",
        );
      }

      return entry.trim();
    });
  }

  return preferences;
}

function parseStoredDashboardPreferences(
  value: unknown,
): ZelavisDashboardPreferences {
  const input = readBodyObject(value);
  const preferences: ZelavisDashboardPreferences = {};

  if ("content" in input && input.content !== undefined) {
    preferences.content = parseStoredDashboardContentPreferences(input.content);
  }

  if ("media" in input && input.media !== undefined) {
    preferences.media = parseStoredDashboardMediaPreferences(input.media);
  }

  return preferences;
}

function parseStoredServiceRegistryStateEntry(
  value: unknown,
): ZelavisServiceRegistryStateEntry {
  const input = readBodyObject(value);
  const name = typeof input.name === "string" ? input.name.trim() : "";

  if (!name) {
    throw new ZelavisValidationError(
      "Stored service registry entries must include a service name.",
    );
  }

  const entry: ZelavisServiceRegistryStateEntry = { name };

  if ("specifier" in input && input.specifier !== undefined) {
    if (typeof input.specifier !== "string" || !input.specifier.trim()) {
      throw new ZelavisValidationError(
        "Stored service registry specifier must be a non-empty string when provided.",
      );
    }

    entry.specifier = input.specifier.trim();
  }

  if ("status" in input) {
    if (input.status !== "installed" && input.status !== "available") {
      throw new ZelavisValidationError(
        'Stored service registry status must be "installed" or "available".',
      );
    }

    entry.status = input.status;
  }

  if ("source" in input && input.source !== undefined) {
    if (input.source !== "official" && input.source !== "community") {
      throw new ZelavisValidationError(
        'Stored service registry source must be "official" or "community" when provided.',
      );
    }

    entry.source = input.source;
  }

  if ("order" in input && input.order !== undefined) {
    if (typeof input.order !== "number" || !Number.isInteger(input.order) || input.order < 0) {
      throw new ZelavisValidationError(
        "Stored service registry order must be a non-negative integer.",
      );
    }

    entry.order = input.order;
  }

  return entry;
}

function parseStoredServiceRegistryState(
  value: unknown,
): ZelavisServiceRegistryStateEntry[] {
  const input = readBodyObject(value);

  if (!("services" in input)) {
    return [];
  }

  if (!Array.isArray(input.services)) {
    throw new ZelavisValidationError(
      "Stored service registry state must be an array.",
    );
  }

  return input.services.map((entry) => parseStoredServiceRegistryStateEntry(entry));
}

export type ZelavisDatabaseCoreServiceOptions =
  | boolean
  | CreateDatabaseOptions
  | DatabaseApi
  | Promise<DatabaseApi>;

export interface ZelavisCoreServicesOptions {
  auth?: ZelavisAuthCoreServiceOptions;
  dashboard?: ZelavisDashboardCoreServiceInput;
  database?: ZelavisDatabaseCoreServiceOptions;
  storage?: ZelavisStorageCoreServiceInput;
  website?: ZelavisWebsiteCoreServiceInput;
  workloads?: ZelavisWorkloadsCoreServiceInput;
}

export interface ZelavisApiOptions {
  prefix?: string;
  version?: string;
}

export type ZelavisDashboardThemeMode = "light" | "dark" | "auto";

export interface ZelavisDashboardContentPreferences {
  pinnedTypes?: string[];
  labels?: Record<string, string>;
}

export interface ZelavisDashboardMediaPreferences {
  orderedPaths?: string[];
}

export interface ZelavisDashboardPreferences {
  content?: ZelavisDashboardContentPreferences;
  media?: ZelavisDashboardMediaPreferences;
}

export interface ZelavisDashboardSettings {
  rootPath: string;
  pendingRootPath?: string;
  apiBasePath: string;
  theme: ZelavisDashboardThemeMode;
  pageBuilderEnabled: boolean;
  preferences: ZelavisDashboardPreferences;
  persistence: "runtime" | "read-only";
  editable: {
    rootPath: boolean;
    theme: boolean;
    pageBuilder: boolean;
  };
  restartRequired: boolean;
}

export interface ZelavisDashboardSettingsUpdate {
  rootPath?: string;
  theme?: ZelavisDashboardThemeMode;
  pageBuilderEnabled?: boolean;
  preferences?: ZelavisDashboardPreferences;
}

export interface ZelavisDashboardSettingsStore {
  read: () =>
    | Promise<ZelavisDashboardSettingsUpdate | undefined>
    | ZelavisDashboardSettingsUpdate
    | undefined;
  write: (
    update: ZelavisDashboardSettingsUpdate,
  ) => Promise<ZelavisDashboardSettingsUpdate> | ZelavisDashboardSettingsUpdate;
}

export interface ZelavisServiceRegistryOptions {
  entries?: readonly ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>[];
  store?: ZelavisServiceRegistryStore;
  importer?: ZelavisServiceLoadOptions["importer"];
}

export interface ZelavisServiceContextOptions {
  platform?: ZelavisServiceSetupPlatformContext;
}

export interface ZelavisServerOptions {
  rootPath?: string;
  api?: ZelavisApiOptions;
  services?: ZelavisServiceRegistryOptions;
  runtimeServices?: readonly ZelavisAnyRuntimeServiceInput[];
  servicePackageInstaller?: ZelavisServicePackageInstaller;
  serviceActivation?: ZelavisServiceActivationController;
  serviceContext?: ZelavisServiceContextOptions;
  coreServices?: ZelavisCoreServicesOptions;
  servicePrefixes?: Record<string, string>;
  pathOverrides?: Record<string, string>;
  onError?: ZelavisServerErrorHandler;
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
  blueprints?: ZelavisBlueprintRegistry;
  projectRuntime?: ZelavisProjectRuntimeDriver;
  assistant?: false | ZelavisAssistantResponder;
}

export interface ZelavisKeyValueStore {
  get(key: string): Promise<string | undefined> | string | undefined;
  set(key: string, value: string): Promise<void> | void;
  delete(key: string): Promise<boolean> | boolean;
  list?(prefix?: string): Promise<readonly string[]> | readonly string[];
}

export interface ZelavisFileStoragePutInput {
  path: string;
  body: string | Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata?: Record<string, string>;
}

export interface ZelavisFileStorageEntry {
  path: string;
  size?: number;
  updatedAt?: Date;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata?: Record<string, string>;
  checksum?: string;
}

export interface ZelavisFileStorageObject extends ZelavisFileStorageEntry {
  body: Uint8Array;
}

export interface ZelavisFileReference {
  kind: "file";
  path: string;
  href: string;
  metadataHref: string;
  size?: number;
  updatedAt?: string;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata?: Record<string, string>;
  checksum?: string;
}

export interface ZelavisFileStorage {
  get(
    path: string,
  ):
    | Promise<ZelavisFileStorageObject | undefined>
    | ZelavisFileStorageObject
    | undefined;
  put(
    input: ZelavisFileStoragePutInput,
  ):
    | Promise<ZelavisFileStorageEntry>
    | ZelavisFileStorageEntry;
  delete(path: string): Promise<boolean> | boolean;
  list?(
    prefix?: string,
  ): Promise<readonly ZelavisFileStorageEntry[]> | readonly ZelavisFileStorageEntry[];
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

export interface ZelavisServicePackageInstaller {
  install(
    input: ZelavisServicePackageInstallInput,
  ):
    | Promise<ZelavisServicePackageInstallResult>
    | ZelavisServicePackageInstallResult;
}

export interface ZelavisPlatformResources {
  systemStore?: ZelavisSystemStore;
  blueprints?: ZelavisBlueprintRegistry;
  projectRuntime?: ZelavisProjectRuntimeDriver;
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
  extends Partial<ZelavisServerOptions> {
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
  services?: ZelavisServiceRegistryOptions;
  assistant?: false | ZelavisAssistantResponder;
  onError?: ZelavisServerErrorHandler;
  adapter?: ZelavisAdapter;
}

export interface ZelavisWebsiteDatabaseStoreOptions {
  collection?: string;
  documentId?: string;
}

export function defineAdapter(
  definition: ZelavisAdapterDefinition,
): ZelavisAdapter {
  return definition;
}

const DEFAULT_WEBSITE_STATE_COLLECTION = "zelavis_system";
const DEFAULT_WEBSITE_PAGES_DOCUMENT_ID = "website.pages";
const DEFAULT_PLATFORM_DASHBOARD_SETTINGS_KEY =
  "zelavis/dashboard-settings.json";
const DEFAULT_PLATFORM_WEBSITE_PAGES_PATH = "zelavis/website-pages.json";
const DEFAULT_PLATFORM_SERVICE_REGISTRY_KEY = "zelavis/services.json";
const SYSTEM_STORE_DASHBOARD_NAMESPACE = "dashboard";
const SYSTEM_STORE_DASHBOARD_SETTINGS_KEY = "settings";
const SYSTEM_STORE_SERVICES_NAMESPACE = "services";
const SYSTEM_STORE_SERVICE_REGISTRY_KEY = "registry";
const STORAGE_CHECKSUM_METADATA_KEY = "checksum-sha256";
const RESERVED_CORE_SERVICE_NAMES = new Set([
  "@zelavis/auth",
  "@zelavis/ui",
  "@zelavis/ui:app",
  "@zelavis/db",
  "@zelavis/storage",
  "@zelavis/website",
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

function normalizePathPart(part: string | undefined): string {
  if (!part) {
    return "";
  }

  const trimmed = part.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  return trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
}

function normalizePath(path: string | undefined, fallback: string): string {
  if (path === undefined) {
    return fallback;
  }

  const trimmed = path.trim();
  if (!trimmed) {
    return fallback;
  }

  if (trimmed === "/") {
    return "/";
  }

  const normalized = normalizePathPart(trimmed);
  return normalized ? `/${normalized}` : fallback;
}

function normalizeEditableRootPath(
  path: string | undefined,
): string | undefined {
  if (path === undefined) {
    return undefined;
  }

  return normalizePath(path, "/");
}

function joinPathParts(...parts: (string | undefined)[]): string {
  const normalized = parts.map(normalizePathPart).filter(Boolean);
  return normalized.length > 0 ? `/${normalized.join("/")}` : "/";
}

function encodeStoragePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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

function isDashboardThemeMode(
  value: unknown,
): value is ZelavisDashboardThemeMode {
  return value === "light" || value === "dark" || value === "auto";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function toIsoDate(value: Date | undefined): string | undefined {
  return value ? value.toISOString() : undefined;
}

function readBodyObject(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function toSystemStoreValue(value: unknown): ZelavisSystemStoreValue {
  return JSON.parse(JSON.stringify(value)) as ZelavisSystemStoreValue;
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

const zelavisErrorRules: readonly ZelavisServerErrorStatusRule[] = [
  {
    matches: (error) =>
      error instanceof TypeError ||
      error instanceof AuthValidationError ||
      error instanceof DatabaseValidationError ||
      error instanceof ZelavisValidationError,
    status: 400,
  },
  {
    matches: (error) =>
      error instanceof DatabaseNotFoundError ||
      error instanceof AuthNotFoundError,
    status: 404,
  },
  {
    matches: (error) =>
      error instanceof DatabaseRevisionMismatchError ||
      error instanceof DatabaseConflictError ||
      error instanceof ZelavisConflictError,
    status: 409,
  },
  {
    matches: (error) =>
      error instanceof AuthDomainError || error instanceof ZelavisDomainError,
    status: 400,
  },
];

function zelavisErrorResponse(error: unknown, fallback = 500) {
  return createMappedJsonErrorResponse(error, zelavisErrorRules, fallback);
}

function mergeDashboardPreferences(
  base: ZelavisDashboardPreferences | undefined,
  update: ZelavisDashboardPreferences | undefined,
): ZelavisDashboardPreferences | undefined {
  if (!update) {
    return base;
  }

  if (!base) {
    return update;
  }

  return {
    ...base,
    ...(update.content
      ? {
          content: {
            ...base.content,
            ...update.content,
            ...(update.content.labels
              ? {
                  labels: {
                    ...(base.content?.labels ?? {}),
                    ...update.content.labels,
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(update.media
      ? {
          media: {
            ...base.media,
            ...update.media,
          },
        }
      : {}),
  };
}

function mergeDashboardSettingsUpdate(
  base: ZelavisDashboardSettingsUpdate,
  update: ZelavisDashboardSettingsUpdate,
): ZelavisDashboardSettingsUpdate {
  return {
    ...base,
    ...update,
    ...(update.preferences
      ? {
          preferences: mergeDashboardPreferences(
            base.preferences,
            update.preferences,
          ),
        }
      : {}),
  };
}

function createMemoryDashboardSettingsStore(): ZelavisDashboardSettingsStore {
  let settings: ZelavisDashboardSettingsUpdate = {};

  return {
    read: () => settings,
    write(update) {
      settings = mergeDashboardSettingsUpdate(settings, update);

      return settings;
    },
  };
}

function createMemoryWebsitePagesStore(
  initialPages: readonly ZelavisWebsitePage[],
): ZelavisWebsitePagesStore {
  let pages = [...initialPages];

  return {
    read: () => pages,
    write(nextPages) {
      pages = [...nextPages];
      return pages;
    },
  };
}

function createMemoryServiceRegistryStore(
  initialEntries: readonly ZelavisServiceRegistryStateEntry[],
): ZelavisServiceRegistryStore {
  let entries = [...initialEntries];

  return {
    read: () => entries,
    write(nextEntries) {
      entries = [...nextEntries];
      return entries;
    },
  };
}

async function ensureDatabaseCollection(
  database: DatabaseApi,
  name: string,
): Promise<void> {
  if (await database.documents.collectionExists({ name })) {
    return;
  }

  try {
    await database.documents.createCollection({
      name,
      metadata: {
        internal: true,
        managedBy: "zelavis",
      },
    });
  } catch (error) {
    if (await database.documents.collectionExists({ name })) {
      return;
    }

    throw error;
  }
}

function normalizeStoredWebsiteAction(
  value: unknown,
): ZelavisWebsiteAction | undefined {
  const input = readBodyObject(value);
  const label = typeof input.label === "string" ? input.label.trim() : "";
  const href = typeof input.href === "string" ? input.href.trim() : "";
  const variant =
    input.variant === "primary" || input.variant === "secondary"
      ? input.variant
      : undefined;

  if (!label || !href) {
    return undefined;
  }

  return {
    label,
    href,
    ...(variant ? { variant } : {}),
  };
}

function normalizeStoredWebsiteCard(
  value: unknown,
): ZelavisWebsiteCard | undefined {
  const input = readBodyObject(value);
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const description =
    typeof input.description === "string" ? input.description.trim() : "";
  const href =
    typeof input.href === "string" && input.href.trim()
      ? input.href.trim()
      : undefined;

  if (!title || !description) {
    return undefined;
  }

  return {
    title,
    description,
    ...(href ? { href } : {}),
  };
}

function parseStoredWebsiteAction(value: unknown): ZelavisWebsiteAction {
  const action = normalizeStoredWebsiteAction(value);
  if (!action) {
    throw new ZelavisValidationError(
      "Stored website actions require a label and href.",
    );
  }

  return action;
}

function parseStoredWebsiteCard(value: unknown): ZelavisWebsiteCard {
  const card = normalizeStoredWebsiteCard(value);
  if (!card) {
    throw new ZelavisValidationError(
      "Stored website cards require a title and description.",
    );
  }

  return card;
}

function normalizeStoredWebsitePage(
  value: unknown,
): ZelavisWebsitePage | undefined {
  const input = readBodyObject(value);
  const path = normalizePath(
    typeof input.path === "string" ? input.path : undefined,
    "",
  );
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const kicker =
    typeof input.kicker === "string" && input.kicker.trim()
      ? input.kicker.trim()
      : undefined;
  const headline =
    typeof input.headline === "string" && input.headline.trim()
      ? input.headline.trim()
      : undefined;
  const description =
    typeof input.description === "string" && input.description.trim()
      ? input.description.trim()
      : undefined;
  const actions = Array.isArray(input.actions)
    ? input.actions
        .map((action) => normalizeStoredWebsiteAction(action))
        .filter((action): action is ZelavisWebsiteAction => Boolean(action))
    : undefined;
  const cards = Array.isArray(input.cards)
    ? input.cards
        .map((card) => normalizeStoredWebsiteCard(card))
        .filter((card): card is ZelavisWebsiteCard => Boolean(card))
    : undefined;

  if (!path || !title) {
    return undefined;
  }

  return {
    path,
    title,
    ...(kicker ? { kicker } : {}),
    ...(headline ? { headline } : {}),
    ...(description ? { description } : {}),
    ...(actions && actions.length > 0 ? { actions } : {}),
    ...(cards && cards.length > 0 ? { cards } : {}),
  };
}

function parseStoredWebsitePage(value: unknown): ZelavisWebsitePage {
  const input = readBodyObject(value);
  const page = normalizeStoredWebsitePage(value);

  if (!page) {
    throw new ZelavisValidationError(
      "Stored website pages require a path and title.",
    );
  }

  if ("actions" in input && !Array.isArray(input.actions)) {
    throw new ZelavisValidationError(
      "Stored website page actions must be an array.",
    );
  }

  if ("cards" in input && !Array.isArray(input.cards)) {
    throw new ZelavisValidationError(
      "Stored website page cards must be an array.",
    );
  }

  const actions = Array.isArray(input.actions)
    ? input.actions.map((action) => parseStoredWebsiteAction(action))
    : undefined;
  const cards = Array.isArray(input.cards)
    ? input.cards.map((card) => parseStoredWebsiteCard(card))
    : undefined;

  return {
    ...page,
    ...(actions && actions.length > 0 ? { actions } : {}),
    ...(cards && cards.length > 0 ? { cards } : {}),
  };
}

function parseStoredWebsitePages(value: unknown): ZelavisWebsitePage[] {
  const input = readBodyObject(value);

  if (!("pages" in input)) {
    return [];
  }

  if (!Array.isArray(input.pages)) {
    throw new ZelavisValidationError(
      "Stored website pages must be an array.",
    );
  }

  return input.pages.map((page) => parseStoredWebsitePage(page));
}

function normalizeWebsitePages(
  pages: readonly ZelavisWebsitePage[],
): ZelavisWebsitePage[] {
  return pages
    .map((page) => normalizeStoredWebsitePage(page))
    .filter((page): page is ZelavisWebsitePage => Boolean(page));
}

function serializeWebsitePage(page: ZelavisWebsitePage): DatabaseJsonObject {
  return {
    path: page.path,
    title: page.title,
    ...(page.kicker ? { kicker: page.kicker } : {}),
    ...(page.headline ? { headline: page.headline } : {}),
    ...(page.description ? { description: page.description } : {}),
    ...(page.actions
      ? {
          actions: page.actions.map((action) => ({
            label: action.label,
            href: action.href,
            ...(action.variant ? { variant: action.variant } : {}),
          })),
        }
      : {}),
    ...(page.cards
      ? {
          cards: page.cards.map((card) => ({
            title: card.title,
            description: card.description,
            ...(card.href ? { href: card.href } : {}),
          })),
        }
      : {}),
  };
}

async function readDatabaseDocument(
  database: DatabaseApi,
  options: Required<ZelavisWebsiteDatabaseStoreOptions>,
) {
  await ensureDatabaseCollection(database, options.collection);
  return database.documents.findById({
    collection: options.collection,
    id: options.documentId,
  });
}

async function readValidatedDatabaseDocumentData<T>(
  database: DatabaseApi,
  options: Required<ZelavisWebsiteDatabaseStoreOptions>,
  parse: (value: unknown) => T,
): Promise<T> {
  const document = await readDatabaseDocument(database, options);
  return parse(document?.data);
}

async function writeDatabaseDocument(
  database: DatabaseApi,
  options: Required<ZelavisWebsiteDatabaseStoreOptions>,
  data: DatabaseJsonObject,
): Promise<void> {
  await ensureDatabaseCollection(database, options.collection);
  const current = await database.documents.findById({
    collection: options.collection,
    id: options.documentId,
  });

  if (current) {
    await database.documents.update({
      collection: options.collection,
      id: options.documentId,
      data,
      mode: "replace",
    });
    return;
  }

  await database.documents.insert({
    collection: options.collection,
    id: options.documentId,
    data,
  });
}

export function createDatabaseWebsitePagesStore(
  database: DatabaseApi,
  options: ZelavisWebsiteDatabaseStoreOptions = {},
): ZelavisWebsitePagesStore {
  const documentOptions = {
    collection: options.collection ?? DEFAULT_WEBSITE_STATE_COLLECTION,
    documentId: options.documentId ?? DEFAULT_WEBSITE_PAGES_DOCUMENT_ID,
  };

  return {
    async read() {
      return readValidatedDatabaseDocumentData(
        database,
        documentOptions,
        parseStoredWebsitePages,
      );
    },
    async write(pages) {
      const normalizedPages = normalizeWebsitePages(pages);

      await writeDatabaseDocument(database, documentOptions, {
        kind: "website-pages",
        pages: normalizedPages.map((page) => serializeWebsitePage(page)),
      });

      return normalizedPages;
    },
  };
}

export function createKeyValueDashboardSettingsStore(
  store: ZelavisKeyValueStore,
  key = DEFAULT_PLATFORM_DASHBOARD_SETTINGS_KEY,
): ZelavisDashboardSettingsStore {
  return {
    async read() {
      const value = await store.get(key);
      if (!value) {
        return undefined;
      }

      return parseStoredDashboardSettingsUpdate(
        readBodyObject(JSON.parse(value) as unknown),
      );
    },
    async write(update) {
      const normalized = mergeDashboardSettingsUpdate(
        (await this.read()) ?? {},
        parseStoredDashboardSettingsUpdate(readBodyObject(update)),
      );
      await store.set(key, JSON.stringify(normalized));
      return normalized;
    },
  };
}

export function createSystemStoreDashboardSettingsStore(
  store: ZelavisSystemStore,
): ZelavisDashboardSettingsStore {
  return {
    async read() {
      const record = await store.get(
        SYSTEM_STORE_DASHBOARD_NAMESPACE,
        SYSTEM_STORE_DASHBOARD_SETTINGS_KEY,
      );
      return record
        ? parseStoredDashboardSettingsUpdate(readBodyObject(record.value))
        : undefined;
    },
    async write(update) {
      const normalized = mergeDashboardSettingsUpdate(
        (await this.read()) ?? {},
        parseStoredDashboardSettingsUpdate(readBodyObject(update)),
      );
      await store.set(
        SYSTEM_STORE_DASHBOARD_NAMESPACE,
        SYSTEM_STORE_DASHBOARD_SETTINGS_KEY,
        toSystemStoreValue(normalized),
      );
      return normalized;
    },
  };
}

export function createFileStorageDashboardSettingsStore(
  storage: ZelavisFileStorage,
  path = DEFAULT_PLATFORM_DASHBOARD_SETTINGS_KEY,
): ZelavisDashboardSettingsStore {
  return {
    async read() {
      const file = await storage.get(path);
      if (!file) {
        return undefined;
      }

      return parseStoredDashboardSettingsUpdate(
        readBodyObject(
          JSON.parse(new TextDecoder().decode(file.body)) as unknown,
        ),
      );
    },
    async write(update) {
      const normalized = mergeDashboardSettingsUpdate(
        (await this.read()) ?? {},
        parseStoredDashboardSettingsUpdate(readBodyObject(update)),
      );
      await storage.put({
        path,
        body: JSON.stringify(normalized, null, 2),
        contentType: "application/json; charset=utf-8",
      });
      return normalized;
    },
  };
}

export function createFileStorageWebsitePagesStore(
  storage: ZelavisFileStorage,
  path = DEFAULT_PLATFORM_WEBSITE_PAGES_PATH,
): ZelavisWebsitePagesStore {
  return {
    async read() {
      const file = await storage.get(path);
      if (!file) {
        return [];
      }

      return normalizeWebsitePages(
        parseStoredWebsitePages(
          readBodyObject(
            JSON.parse(new TextDecoder().decode(file.body)) as unknown,
          ),
        ),
      );
    },
    async write(pages) {
      const normalizedPages = normalizeWebsitePages(pages);

      await storage.put({
        path,
        body: JSON.stringify(
          {
            kind: "website-pages",
            pages: normalizedPages.map((page) => serializeWebsitePage(page)),
          },
          null,
          2,
        ),
        contentType: "application/json; charset=utf-8",
      });

      return normalizedPages;
    },
  };
}

export function createKeyValueServiceRegistryStore(
  store: ZelavisKeyValueStore,
  key = DEFAULT_PLATFORM_SERVICE_REGISTRY_KEY,
): ZelavisServiceRegistryStore {
  return {
    async read() {
      const value = await store.get(key);
      if (!value) {
        return [];
      }

      return parseStoredServiceRegistryState(
        readBodyObject(JSON.parse(value) as unknown),
      );
    },
    async write(entries) {
      const normalizedEntries = entries.map((entry) =>
        parseStoredServiceRegistryStateEntry(entry),
      );
      await store.set(
        key,
        JSON.stringify(
          {
            kind: "service-registry",
            services: normalizedEntries,
          },
          null,
          2,
        ),
      );
      return normalizedEntries;
    },
  };
}

export function createSystemStoreServiceRegistryStore(
  store: ZelavisSystemStore,
): ZelavisServiceRegistryStore {
  return {
    async read() {
      const record = await store.get(
        SYSTEM_STORE_SERVICES_NAMESPACE,
        SYSTEM_STORE_SERVICE_REGISTRY_KEY,
      );
      return record ? parseStoredServiceRegistryState(record.value) : [];
    },
    async write(entries) {
      const normalized = entries.map((entry) =>
        parseStoredServiceRegistryStateEntry(entry),
      );
      await store.set(
        SYSTEM_STORE_SERVICES_NAMESPACE,
        SYSTEM_STORE_SERVICE_REGISTRY_KEY,
        toSystemStoreValue({ services: normalized }),
      );
      return normalized;
    },
  };
}

export function createFileStorageServiceRegistryStore(
  storage: ZelavisFileStorage,
  path = DEFAULT_PLATFORM_SERVICE_REGISTRY_KEY,
): ZelavisServiceRegistryStore {
  return {
    async read() {
      const file = await storage.get(path);
      if (!file) {
        return [];
      }

      return parseStoredServiceRegistryState(
        readBodyObject(
          JSON.parse(new TextDecoder().decode(file.body)) as unknown,
        ),
      );
    },
    async write(entries) {
      const normalizedEntries = entries.map((entry) =>
        parseStoredServiceRegistryStateEntry(entry),
      );

      await storage.put({
        path,
        body: JSON.stringify(
          {
            kind: "service-registry",
            services: normalizedEntries,
          },
          null,
          2,
        ),
        contentType: "application/json; charset=utf-8",
      });

      return normalizedEntries;
    },
  };
}

function resolveRuntimeSettingsStore(
  option: ZelavisDashboardCoreServiceInput | undefined,
  fallbackStore?: ZelavisDashboardSettingsStore,
): ZelavisDashboardSettingsStore | undefined {
  const dashboardOption = option ?? true;

  if (dashboardOption === true || dashboardOption === false) {
    return fallbackStore ?? createMemoryDashboardSettingsStore();
  }

  return (
    dashboardOption.settingsStore ??
    fallbackStore ??
    createMemoryDashboardSettingsStore()
  );
}

function resolveServiceRegistryStore(
  option: ZelavisServiceRegistryOptions | undefined,
  fallbackStore: ZelavisServiceRegistryStore,
): ZelavisServiceRegistryStore {
  return option?.store ?? fallbackStore;
}

async function readInitialServiceRegistryState(
  store: ZelavisServiceRegistryStore,
): Promise<readonly ZelavisServiceRegistryStateEntry[] | undefined> {
  try {
    return await store.read();
  } catch {
    return undefined;
  }
}

function readDashboardSettingsUpdate(
  body: unknown,
): ZelavisDashboardSettingsUpdate {
  const input = readBodyObject(body);

  try {
    return parseStoredDashboardSettingsUpdate(input);
  } catch (error) {
    if (!(error instanceof ZelavisValidationError)) {
      throw error;
    }

    const normalizedMessage = error.message
      .replace(/^Stored dashboard /, "")
      .replace(/^Stored page builder enabled/, "Page builder enabled")
      .replace(/^Stored dashboard theme/, "Theme")
      .replace(/^Stored dashboard root path/, "Root path");

    throw new ZelavisValidationError(
      normalizedMessage.charAt(0).toUpperCase() + normalizedMessage.slice(1),
    );
  }
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

function readStorageMetadataHeaders(
  headers: Headers | undefined,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  const metadata: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (!key.toLowerCase().startsWith("x-zelavis-meta-")) {
      return;
    }

    const name = key.slice("x-zelavis-meta-".length).trim();
    if (!name) {
      return;
    }

    metadata[name] = value;
  });

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

async function readRequestBytes(
  request: Request | undefined,
): Promise<Uint8Array> {
  if (!request) {
    return new Uint8Array();
  }

  const body = await request.arrayBuffer();
  return new Uint8Array(body);
}

async function computeSha256Hex(body: Uint8Array): Promise<string> {
  if (
    typeof crypto === "undefined" ||
    !crypto.subtle ||
    typeof crypto.subtle.digest !== "function"
  ) {
    throw new ZelavisDomainError(
      "This runtime does not support Web Crypto digest operations.",
    );
  }

  const view = body.buffer.slice(
    body.byteOffset,
    body.byteOffset + body.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", view);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function readStorageChecksum(
  entry: Pick<ZelavisFileStorageEntry, "checksum" | "metadata">,
): string | undefined {
  return entry.checksum ?? entry.metadata?.[STORAGE_CHECKSUM_METADATA_KEY];
}

function createStorageMetadata(
  metadata: Record<string, string> | undefined,
  checksum: string,
): Record<string, string> {
  return {
    ...(metadata ?? {}),
    [STORAGE_CHECKSUM_METADATA_KEY]: checksum,
  };
}

export function createFileReference(
  entry: ZelavisFileStorageEntry,
  options: {
    rootPath?: string;
    apiPrefix?: string;
    apiVersion?: string;
  } = {},
): ZelavisFileReference {
  const rootPath = normalizePath(options.rootPath, "/zelavis");
  const apiPrefix = normalizePath(options.apiPrefix, "/api");
  const apiVersion = normalizePathPart(options.apiVersion ?? "v1");
  const encodedPath = encodeStoragePath(entry.path);
  const href = joinPathParts(
    rootPath,
    apiPrefix,
    apiVersion,
    "storage",
    "files",
    encodedPath,
  );

  return {
    kind: "file",
    path: entry.path,
    href,
    metadataHref: `${href}?format=metadata`,
    size: entry.size,
    updatedAt: toIsoDate(entry.updatedAt),
    contentType: entry.contentType,
    cacheControl: entry.cacheControl,
    contentDisposition: entry.contentDisposition,
    metadata: entry.metadata,
    checksum: readStorageChecksum(entry),
  };
}

const defaultDashboardServiceRegistry = createServiceRegistry<ZelavisServiceSetupContext>([
  {
    service: {
      name: "@zelavis/ecommerce",
      version: "1.0.1-alpha.2",
      menu: {
        title: "Ecommerce",
        path: "/commerce",
        pageLabel: "Commerce",
        items: [
          { title: "Products", path: "/commerce/products" },
          { title: "Orders", path: "/commerce/orders" },
          {
            title: "More",
            items: [
              { title: "Customers", path: "/commerce/customers" },
              { title: "Coupons", path: "/commerce/coupons" },
            ],
          },
        ],
      },
    },
    specifier: "@zelavis/ecommerce",
    status: "available",
    source: "official",
    order: 0,
  },
]);

async function loadStoredServiceRegistryModules(
  entries: readonly ZelavisServiceRegistryStateEntry[] | undefined,
  importer?: ZelavisServiceLoadOptions["importer"],
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
        { importer },
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

function renderWebsitePage(page: ZelavisWebsitePage): string {
  const title = escapeHtml(page.title);
  const kicker = page.kicker
    ? `<span class="kicker">${escapeHtml(page.kicker)}</span>`
    : "";
  const headline = escapeHtml(page.headline ?? page.title);
  const description = page.description
    ? `<p>${escapeHtml(page.description)}</p>`
    : "";
  const actions =
    page.actions && page.actions.length > 0
      ? `<div class="actions">${page.actions
          .map((action) => {
            const variantClass = action.variant === "primary" ? " primary" : "";
            return `<a class="button${variantClass}" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`;
          })
          .join("")}</div>`
      : "";
  const cards =
    page.cards && page.cards.length > 0
      ? `<section class="grid">${page.cards
          .map((card) => {
            const content = `<h2>${escapeHtml(card.title)}</h2><p>${escapeHtml(card.description)}</p>`;

            if (!card.href) {
              return `<article class="card">${content}</article>`;
            }

            return `<a class="card card-link" href="${escapeHtml(card.href)}">${content}</a>`;
          })
          .join("")}</section>`
      : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #09090b;
        --panel: #111114;
        --muted: #a1a1aa;
        --text: #fafafa;
        --accent: #8b5cf6;
        --border: #27272a;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        min-height: 100vh;
        background: radial-gradient(circle at top, #18181b 0%, var(--bg) 50%);
        color: var(--text);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      main {
        width: 100%;
        max-width: 72rem;
        margin: 0 auto;
        padding: 5rem 1.5rem;
      }

      .hero {
        padding: 2rem 0 3rem;
      }

      .kicker {
        display: inline-block;
        margin-bottom: 1rem;
        padding: 0.375rem 0.625rem;
        border: 1px solid var(--border);
        border-radius: 999px;
        color: #c4b5fd;
        background: rgba(139, 92, 246, 0.1);
        font-size: 0.875rem;
      }

      h1 {
        margin: 0;
        font-size: clamp(2.5rem, 8vw, 4.75rem);
        line-height: 1;
      }

      p {
        color: var(--muted);
        font-size: 1.05rem;
        line-height: 1.7;
        max-width: 44rem;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.875rem;
        margin-top: 2rem;
      }

      a.button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 0.75rem;
        padding: 0.9rem 1.1rem;
        text-decoration: none;
        font-weight: 600;
        border: 1px solid var(--border);
        color: var(--text);
        background: var(--panel);
      }

      a.button.primary {
        background: var(--accent);
        border-color: var(--accent);
      }

      .grid {
        display: grid;
        gap: 1rem;
        grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
        margin-top: 2rem;
      }

      .card {
        border: 1px solid var(--border);
        border-radius: 1rem;
        padding: 1rem;
        background: rgba(17, 17, 20, 0.8);
        text-decoration: none;
      }

      .card-link {
        color: inherit;
      }

      .card h2 {
        margin: 0 0 0.5rem;
        font-size: 1rem;
      }

      .card p {
        margin: 0;
        font-size: 0.95rem;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        ${kicker}
        <h1>${headline}</h1>
        ${description}
        ${actions}
      </section>
      ${cards}
    </main>
  </body>
</html>`;
}

function createWebsitePageRouteId(path: string): string {
  const normalized = normalizePathPart(path);
  return normalized
    ? `website.page.${normalized.replaceAll("/", ".")}`
    : "website.page.home";
}

function isReservedWebsitePath(path: string, rootPath: string): boolean {
  return (
    path === rootPath ||
    path.startsWith(`${rootPath}/`) ||
    path === "/api" ||
    path.startsWith("/api/")
  );
}

function isDatabaseApi(value: unknown): value is DatabaseApi {
  return Boolean(
    value &&
    typeof value === "object" &&
    "documents" in value &&
    "driver" in value &&
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
  services: readonly AuthProviderService[] = [],
): Promise<ZelavisRuntimeService<any> | undefined> {
  const authOption = option ?? true;

  if (authOption === false) {
    return undefined;
  }

  const allowedChildServices =
    authOption === true ? [] : [...(authOption.childServices ?? [])];
  const allowedServiceNames = new Set(allowedChildServices);
  const childServices = services.filter((service) =>
    allowedServiceNames.has(service.name),
  );

  return createAuthService(
    authOption === true
      ? { services: childServices, childServices: allowedChildServices }
      : {
          ...authOption,
          services: [...(authOption.services ?? []), ...childServices],
          childServices: allowedChildServices,
        },
  );
}

function collectAuthProviderServices(
  registry: readonly Readonly<ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>>[],
): readonly AuthProviderService[] {
  return Object.freeze(
    registry
      .filter(
        (entry) =>
          entry.status === "installed" &&
          entry.service.extends === "@zelavis/auth" &&
          typeof entry.service.setup === "function",
      )
      .map((entry) => entry.service as unknown as AuthProviderService),
  );
}

type DashboardServicePageReference = {
  id: string;
  title?: string;
  src: string;
};

type DashboardSerializedServiceMenuDefinition = Omit<
  ZelavisServiceMenuDefinition,
  "items" | "page"
> & {
  page?: DashboardServicePageReference;
  items?: readonly DashboardSerializedServiceMenuDefinition[];
};

function createDashboardAccess(mode: string | null | undefined) {
  if (mode === "customer") {
    return {
      mode: "customer",
      label: "Customer",
      principal: {
        id: "customer_demo",
        type: "user",
        roles: ["customer"],
        grants: [
          {
            permission: "projects.list",
            scope: { type: "system" },
          },
          {
            permission: "project.view",
            scope: { type: "project", projectId: "default" },
          },
          {
            permission: "project.content.read",
            scope: { type: "project", projectId: "default" },
          },
          {
            permission: "project.website.manage",
            scope: { type: "project", projectId: "default" },
          },
        ],
      },
      projects: [
        {
          id: "default",
          permissions: [
            "project.view",
            "project.content.read",
            "project.website.manage",
          ],
        },
      ],
    };
  }

  return {
    mode: "owner",
    label: "Owner",
    principal: {
      id: "owner_demo",
      type: "user",
      roles: ["owner"],
      permissions: ["*"],
    },
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
    servicePackageInstaller?: ZelavisServicePackageInstaller;
    serviceActivation?: ZelavisServiceActivationController;
    rootPath: string;
    getServices: () => readonly ZelavisRuntimeService<any>[];
    settingsStore?: ZelavisDashboardSettingsStore;
    websiteEnabled: boolean;
  },
): Promise<ZelavisRuntimeManagementCore> {
  const dashboardOption = option ?? true;
  const options =
    dashboardOption === true || dashboardOption === false ? {} : dashboardOption;
  const title = options.title ?? "zelavis";
  const rootPath = context.rootPath;
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
            src: joinPathParts(
              rootPath,
              context.apiPrefix,
              context.apiVersion,
              "runtime",
              "service-pages",
              encodeURIComponent(serviceName),
              encodeURIComponent(menu.page.id),
            ),
          }
        : undefined,
      items: menu.items?.map((item) =>
        serializeServiceMenuForDashboard(serviceName, item),
      ) as readonly DashboardSerializedServiceMenuDefinition[] | undefined,
    };
  };
  const renderServicePageDocument = async (
    serviceName: string,
    pageId: string,
  ) => {
    const serviceRegistry = await readResolvedServiceRegistry();
    const entry = serviceRegistry.find(
      (candidate) => candidate.service.name === serviceName,
    );

    if (!entry || entry.status !== "installed") {
      return {
        status: 404,
        body: {
          error: "Service page not found.",
        },
      };
    }

    const page = findServiceMenuPageById(entry.service.menu, pageId);
    if (!page?.render) {
      return {
        status: 404,
        body: {
          error: "Service page not found.",
        },
      };
    }

    const rendered = await page.render({
      service: entry.service.name,
      page: page.id,
      rootPath,
      api: {
        prefix: context.apiPrefix,
        version: context.apiVersion,
        basePath: joinPathParts(
          rootPath,
          context.apiPrefix,
          context.apiVersion,
        ),
      },
    });
    const document =
      typeof rendered === "string" ? { html: rendered } : rendered;
    const headers = new Headers(document.headers);

    if (!headers.has("content-type")) {
      headers.set(
        "content-type",
        document.contentType ?? "text/html; charset=utf-8",
      );
    }
    if (!headers.has("cache-control")) {
      headers.set("cache-control", "no-cache");
    }

    return {
      status: document.status ?? 200,
      headers,
      body: document.html,
    };
  };
  const createDashboardRuntimeConfig = async () => {
    const serviceRegistry = await readResolvedServiceRegistry();
    const serializedServices = serviceRegistry.map((entry) => ({
      name: entry.service.name,
      version: entry.service.version,
      specifier: entry.specifier,
      status: entry.status,
      source: entry.source,
      order: entry.order,
      menu: serializeServiceMenuForDashboard(entry.service.name, entry.service.menu),
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
      services: context.getServices().map((service) => ({
        name: service.name,
        core:
          service.name === "@zelavis/ui" ||
          service.name === "@zelavis/server" ||
          service.name === "@zelavis/auth" ||
          service.name === "@zelavis/db" ||
          service.name === "@zelavis/storage" ||
          service.name === "@zelavis/website" ||
          service.name === "@zelavis/workloads",
        apiPath:
          service.name === "@zelavis/website"
            ? "/"
            : service.name === "@zelavis/ui"
              ? rootPath
              : joinPathParts(
                  rootPath,
                  context.apiPrefix,
                  context.apiVersion,
                  service.basePath ?? service.name,
                ),
        menu: service.menu,
      })),
      serviceRegistry: serializedServices,
      serviceActivation: context.serviceActivation
        ? {
            mode: context.serviceActivation.mode,
            capabilities: {
              ...context.serviceActivation.capabilities,
              supportsPackageUploads: Boolean(context.servicePackageInstaller),
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
        specifier: entry.specifier,
        status: entry.status,
        source: entry.source,
        order: entry.order,
        menu: serializeServiceMenuForDashboard(entry.service.name, entry.service.menu),
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

    return {
      rootPath,
      pendingRootPath,
      apiBasePath: joinPathParts(
        rootPath,
        context.apiPrefix,
        context.apiVersion,
      ),
      theme,
      pageBuilderEnabled,
      preferences,
      persistence: "runtime",
      editable: {
        rootPath: true,
        theme: true,
        pageBuilder: context.websiteEnabled,
      },
      restartRequired: Boolean(pendingRootPath),
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
          id: "runtime.service-page.read",
          method: "GET",
          path: joinPathParts(
            context.apiPrefix,
            context.apiVersion,
            "runtime/service-pages/:service/:page",
          ),
          handler: async ({
            params,
          }: {
            params: Record<string, string>;
          }) => {
            try {
              const serviceName = params.service?.trim();
              const pageId = params.page?.trim();
              if (!serviceName || !pageId) {
                throw new ZelavisValidationError(
                  "Service name and page id are required.",
                );
              }

              return await renderServicePageDocument(serviceName, pageId);
            } catch (error) {
              return zelavisErrorResponse(error, 400);
            }
          },
        },
        {
          id: "runtime.services.update",
          method: "PATCH",
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

async function resolveWebsiteCoreService(
  option: ZelavisWebsiteCoreServiceInput | undefined,
  context: {
    rootPath: string;
    apiPrefix: string;
    apiVersion: string;
    pagesStore?: ZelavisWebsitePagesStore;
  },
): Promise<ZelavisRuntimeService<any> | undefined> {
  const websiteOption = option ?? true;

  if (websiteOption === false) {
    return undefined;
  }

  const options = websiteOption === true ? {} : websiteOption;
  const pagesStore =
    options.pagesStore ??
    context.pagesStore ??
    createMemoryWebsitePagesStore([]);

  async function readPages(): Promise<ZelavisWebsitePage[]> {
    return [...((await pagesStore.read()) ?? [])].map((page) => ({
      ...page,
      path: normalizePath(page.path, "/"),
    }));
  }

  async function writePages(
    pages: readonly ZelavisWebsitePage[],
  ): Promise<readonly ZelavisWebsitePage[]> {
    return pagesStore.write(
      pages.map((page) => ({
        ...page,
        path: normalizePath(page.path, "/"),
      })),
    );
  }

  return {
    name: "@zelavis/website",
    basePath: "/",
    menu: {
      title: "Website",
      path: "/website",
      pageLabel: "Website",
      sectionLabel: "Build",
      surface: "root",
      access: {
        permissions: ["project.website.manage"],
        scope: { type: "project", projectIdParam: "projectId" },
      },
    },
    service: {
      pages: [],
    },
    api: {
      v1: [
        {
          id: "website.pages.list",
          method: "GET",
          path: joinPathParts(
            context.rootPath,
            context.apiPrefix,
            context.apiVersion,
            "website/pages",
          ),
          handler: async () => {
            try {
              return {
                status: 200,
                body: {
                  pages: await readPages(),
                },
              };
            } catch (error) {
              return zelavisErrorResponse(error, 400);
            }
          },
        },
        {
          id: "website.pages.create",
          method: "POST",
          path: joinPathParts(
            context.rootPath,
            context.apiPrefix,
            context.apiVersion,
            "website/pages",
          ),
          handler: async ({ body }: { body: unknown }) => {
            try {
              const input = readBodyObject(body);
              const title =
                typeof input.title === "string" ? input.title.trim() : "";
              const path = normalizePath(
                typeof input.path === "string" ? input.path : undefined,
                "",
              );
              const headline =
                typeof input.headline === "string" && input.headline.trim()
                  ? input.headline.trim()
                  : undefined;
              const description =
                typeof input.description === "string" && input.description.trim()
                  ? input.description.trim()
                  : undefined;

              if (!title) {
                throw new ZelavisValidationError(
                  "Website pages require a title.",
                );
              }

              if (!path) {
                throw new ZelavisValidationError(
                  "Website pages require a path.",
                );
              }

              if (isReservedWebsitePath(path, context.rootPath)) {
                throw new ZelavisValidationError(
                  "That path is reserved by Zelavis.",
                );
              }

              const pages = await readPages();
              if (pages.some((page) => page.path === path)) {
                throw new ZelavisConflictError(
                  "A website page already exists for that path.",
                );
              }

              const page: ZelavisWebsitePage = {
                path,
                title,
                headline,
                description,
              };

              await writePages([...pages, page]);

              return {
                status: 201,
                body: page,
              };
            } catch (error) {
              return zelavisErrorResponse(error, 400);
            }
          },
        },
        {
          id: "website.page.dynamic",
          method: "GET",
          path: "/*path",
          handler: async ({ params }: { params: Record<string, string> }) => {
            try {
              const pages = await readPages();
              const requestPath = normalizePath(params.path, "/");
              const hasHomePage = pages.some((entry) => entry.path === "/");

              if (requestPath === context.rootPath) {
                return {
                  status: 404,
                  body: {
                    error: "Not found",
                  },
                };
              }

              if (!hasHomePage) {
                if (requestPath === "/") {
                  return {
                    status: 307,
                    headers: {
                      location: context.rootPath,
                      "cache-control": "no-cache",
                    } as Record<string, string>,
                  };
                }

                return {
                  status: 404,
                  body: {
                    error: "Not found",
                  },
                };
              }

              const page = pages.find((entry) => entry.path === requestPath);
              if (!page) {
                return {
                  status: 404,
                  body: {
                    error: "Not found",
                  },
                };
              }

              return {
                status: 200,
                headers: {
                  "content-type": "text/html; charset=utf-8",
                  "cache-control": "no-cache",
                } as Record<string, string>,
                body: renderWebsitePage(page),
              };
            } catch (error) {
              return zelavisErrorResponse(error, 400);
            }
          },
        },
      ],
    },
  };
}

async function resolveStorageCoreService(
  option: ZelavisStorageCoreServiceInput | undefined,
  context: {
    rootPath: string;
    apiPrefix: string;
    apiVersion: string;
  },
): Promise<ZelavisRuntimeService<any> | undefined> {
  const storageOption = option ?? false;

  if (storageOption === false) {
    return undefined;
  }

  const options = storageOption === true ? {} : storageOption;
  const storage = options.storage;

  if (!storage) {
    return undefined;
  }

  return {
    name: "@zelavis/storage",
    basePath: "/storage",
    menu: {
      title: "Storage",
      path: "/storage",
      surface: "core",
    },
    service: {
      storage,
    },
    api: {
      v1: [
        {
          id: "storage.files.list",
          method: "GET",
          path: "/files",
          handler: async ({ query }) => {
            try {
              const prefix = query.get("prefix") ?? undefined;
              const files = storage.list ? await storage.list(prefix) : [];
              return {
                status: 200,
                body: {
                  files,
                  references: files.map((file) =>
                    createFileReference(file, {
                      rootPath: context.rootPath,
                      apiPrefix: context.apiPrefix,
                      apiVersion: context.apiVersion,
                    }),
                  ),
                },
              };
            } catch (error) {
              return zelavisErrorResponse(error, 400);
            }
          },
        },
        {
          id: "storage.files.read",
          method: "GET",
          path: "/files/*path",
          handler: async ({ params, query }) => {
            try {
              const path = params.path ?? "";
              if (!path) {
                throw new ZelavisValidationError("Storage file path is required.");
              }

              const file = await storage.get(path);
              if (!file) {
                throw new ZelavisValidationError("Storage file not found.");
              }

              if (query.get("format") === "metadata") {
                return {
                  status: 200,
                  body: {
                  file: {
                    path: file.path,
                    size: file.size,
                    updatedAt: toIsoDate(file.updatedAt),
                    contentType: file.contentType,
                    cacheControl: file.cacheControl,
                    contentDisposition: file.contentDisposition,
                    metadata: file.metadata,
                    checksum: readStorageChecksum(file),
                  },
                    reference: createFileReference(file, {
                      rootPath: context.rootPath,
                      apiPrefix: context.apiPrefix,
                      apiVersion: context.apiVersion,
                    }),
                  },
                };
              }

              return {
                status: 200,
                headers: {
                  "content-type":
                    file.contentType ?? "application/octet-stream",
                  ...(file.cacheControl
                    ? { "cache-control": file.cacheControl }
                    : {}),
                  ...(file.contentDisposition
                    ? { "content-disposition": file.contentDisposition }
                    : {}),
                  ...(readStorageChecksum(file)
                    ? {
                        "x-zelavis-checksum-sha256":
                          readStorageChecksum(file) as string,
                      }
                    : {}),
                  ...(file.size !== undefined
                    ? { "content-length": String(file.size) }
                    : {}),
                },
                body: file.body,
              };
            } catch (error) {
              return zelavisErrorResponse(error, 404);
            }
          },
        },
        {
          id: "storage.files.write",
          method: "PUT",
          path: "/files/*path",
          handler: async ({ params, request, requestHeaders }) => {
            try {
              const path = params.path ?? "";
              if (!path) {
                throw new ZelavisValidationError("Storage file path is required.");
              }

              const body = await readRequestBytes(request);
              const checksum = await computeSha256Hex(body);
              const metadata = createStorageMetadata(
                readStorageMetadataHeaders(requestHeaders),
                checksum,
              );
              const contentType =
                requestHeaders?.get("content-type") ?? undefined;
              const cacheControl =
                requestHeaders?.get("cache-control") ?? undefined;
              const contentDisposition =
                requestHeaders?.get("content-disposition") ?? undefined;
              const storedEntry = await storage.put({
                path,
                body,
                contentType,
                cacheControl,
                contentDisposition,
                metadata,
              });
              const entry: ZelavisFileStorageEntry = {
                ...storedEntry,
                checksum: readStorageChecksum(storedEntry) ?? checksum,
                cacheControl: storedEntry.cacheControl ?? cacheControl,
                contentDisposition:
                  storedEntry.contentDisposition ?? contentDisposition,
                metadata:
                  storedEntry.metadata && storedEntry.metadata !== metadata
                    ? {
                        ...metadata,
                        ...storedEntry.metadata,
                      }
                    : metadata,
              };

              return {
                status: 200,
                body: {
                  file: entry,
                  reference: createFileReference(entry, {
                    rootPath: context.rootPath,
                    apiPrefix: context.apiPrefix,
                    apiVersion: context.apiVersion,
                  }),
                },
              };
            } catch (error) {
              return zelavisErrorResponse(error, 400);
            }
          },
        },
        {
          id: "storage.files.delete",
          method: "DELETE",
          path: "/files/*path",
          handler: async ({ params }) => {
            try {
              const path = params.path ?? "";
              if (!path) {
                throw new ZelavisValidationError("Storage file path is required.");
              }

              const deleted = await storage.delete(path);
              if (!deleted) {
                throw new ZelavisValidationError("Storage file not found.");
              }

              return {
                status: 200,
                body: {
                  deleted: true,
                  path,
                },
              };
            } catch (error) {
              return zelavisErrorResponse(error, 404);
            }
          },
        },
      ],
    },
  };
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

async function resolveServerCoreService(
  blueprints?: ZelavisBlueprintRegistry,
  systemStore?: ZelavisSystemStore,
  projectRuntime?: ZelavisProjectRuntimeDriver,
  runtimeManagementRoutes: readonly ZelavisServerRoute<any>[] = [],
  assistantOption?: false | ZelavisAssistantResponder,
): Promise<ZelavisRuntimeService<any>> {
  const projects =
    blueprints && systemStore && projectRuntime
      ? await createProjectManager({
          blueprints,
          store: systemStore,
          runtime: projectRuntime,
        })
      : undefined;
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
          "Project management requires a System Store, Blueprint registry, and project runtime driver.",
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
            : 500;
    return {
      status,
      body: { error: error instanceof Error ? error.message : String(error) },
    };
  }

  function assistantErrorResponse(error: unknown) {
    const status =
      error instanceof ZelavisAssistantNotFoundError
        ? 404
        : error instanceof ZelavisAssistantValidationError
          ? 400
          : 500;
    return {
      status,
      body: { error: error instanceof Error ? error.message : String(error) },
    };
  }

  return {
    name: "@zelavis/server",
    basePath: "/runtime",
    menu: {
      title: "Access",
      path: "/access",
      pageLabel: "Access",
      panelLabel: "Access",
      sectionLabel: "Projects",
      surface: "platform",
      access: {
        permissions: ["access.manage"],
        scope: { type: "system" },
      },
      items: [
        {
          title: "Overview",
          path: "/access",
          pageLabel: "Access",
        },
        {
          title: "Users",
          path: "/access/users",
          pageLabel: "Users",
        },
        {
          title: "Permissions",
          path: "/access/permissions",
          pageLabel: "Permissions",
        },
      ],
    },
    service: {},
    api: {
      v1: [
        ...runtimeManagementRoutes,
        {
          id: "runtime.access",
          method: "GET",
          path: "/access",
          handler: ({ query }: { query: URLSearchParams }) => ({
            status: 200,
            body: createDashboardAccess(query.get("as")),
          }),
        },
        {
          id: "runtime.blueprints.list",
          method: "GET",
          path: "/blueprints",
          handler: () => ({
            status: 200,
            body: {
              blueprints: (blueprints?.list() ?? []).map((entry) => ({
                ...entry.manifest,
                origin: entry.origin,
              })),
            },
          }),
        },
        {
          id: "runtime.assistant.threads.list",
          method: "GET",
          path: "/assistant/threads",
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
          handler: async ({ body }: { body: unknown }) => {
            if (!projects) {
              return unavailableProjectsResponse();
            }
            try {
              const input = readBodyObject(body);
              const project = await projects.create({
                name: typeof input.name === "string" ? input.name : "",
                ...(typeof input.id === "string" ? { id: input.id } : {}),
                ...(typeof input.blueprintId === "string"
                  ? { blueprintId: input.blueprintId }
                  : {}),
                ...(typeof input.blueprintVersion === "string"
                  ? { blueprintVersion: input.blueprintVersion }
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
          id: "runtime.projects.logs",
          method: "GET",
          path: "/projects/:projectId/logs",
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
        ...(["GET", "POST", "PUT", "PATCH", "DELETE"] as const).map(
          (method) => ({
            id: `runtime.projects.proxy.${method.toLowerCase()}`,
            method,
            path: "/projects/:projectId/proxy/*path",
            handler: async ({
              params,
              query,
              request,
            }: {
              params: Record<string, string>;
              query: URLSearchParams;
              request: Request;
            }) => {
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
                if (project.runtime.status !== "running" || !project.runtime.url) {
                  return {
                    status: 409,
                    body: { error: `Project "${project.id}" is not running.` },
                  };
                }

                const target = new URL(
                  (params.path ?? "").replace(/^\/+/, ""),
                  `${project.runtime.url.replace(/\/+$/, "")}/`,
                );
                target.search = query.toString();
                const headers = new Headers(request.headers);
                headers.delete("host");
                headers.delete("content-length");
                const body =
                  request.method === "GET" || request.method === "HEAD"
                    ? undefined
                    : await request.clone().arrayBuffer();
                const response = await fetch(target, {
                  method: request.method,
                  headers,
                  redirect: "manual",
                  ...(body && body.byteLength > 0 ? { body } : {}),
                });
                const responseHeaders = new Headers(response.headers);
                responseHeaders.delete("content-length");
                responseHeaders.delete("transfer-encoding");
                return {
                  status: response.status,
                  headers: responseHeaders,
                  body: new Uint8Array(await response.arrayBuffer()),
                };
              } catch (error) {
                return projectErrorResponse(error);
              }
            },
          }),
        ),
        {
          id: "runtime.projects.remove",
          method: "DELETE",
          path: "/projects/:projectId",
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
    },
  };
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
    service: dashboardService as unknown as Readonly<ZelavisServiceDefinition<unknown>>,
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
    if (service.name === "@zelavis/website") {
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
): Promise<ZelavisServerRuntime<unknown>> {
  const rootPath = normalizePath(options.rootPath, "/zelavis");
  const apiPrefix = normalizePath(options.api?.prefix, "/api");
  const apiVersion = normalizePathPart(options.api?.version ?? "v1");
  const runtimeServices = await Promise.all(options.runtimeServices ?? []);
  const baseServiceRegistry =
    options.services?.entries !== undefined
      ? createServiceRegistry(options.services.entries)
      : defaultDashboardServiceRegistry;
  const hasAuthService = runtimeServices.some((service) => service.name === "@zelavis/auth");
  const hasDashboardService = runtimeServices.some(
    (service) => service.name === "@zelavis/ui",
  );
  const hasServerService = runtimeServices.some(
    (service) => service.name === "@zelavis/server",
  );
  const hasWebsiteService = runtimeServices.some(
    (service) => service.name === "@zelavis/website",
  );
  const hasStorageService = runtimeServices.some(
    (service) => service.name === "@zelavis/storage",
  );
  const hasWorkloadsService = runtimeServices.some(
    (service) => service.name === "@zelavis/workloads",
  );
  const hasDatabaseService = runtimeServices.some(
    (service) => service.name === "@zelavis/db",
  );
  const providedDatabaseService = runtimeServices.find(
    (service) => service.name === "@zelavis/db" && isDatabaseApi(service.service),
  );
  const databaseApi = hasDatabaseService
    ? undefined
    : await resolveDatabaseCoreService(options.coreServices?.database);
  const databaseService = databaseApi
    ? defineDatabaseService(databaseApi)
    : undefined;
  const resolvedDatabaseApi =
    (providedDatabaseService?.service as DatabaseApi | undefined) ??
    databaseApi;
  const systemStore = options.systemStore ?? createMemorySystemStore();
  const serviceRegistryStore = resolveServiceRegistryStore(
    options.services,
    createSystemStoreServiceRegistryStore(systemStore),
  );
  const initialServiceRegistryState =
    await readInitialServiceRegistryState(serviceRegistryStore);
  const storedServiceRegistry = await loadStoredServiceRegistryModules(
    initialServiceRegistryState,
    options.services?.importer,
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
  const authService = hasAuthService
    ? undefined
    : await resolveAuthCoreService(
        options.coreServices?.auth,
        collectAuthProviderServices(serviceRegistry),
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
    },
  );
  const serviceRuntimeServices = await Promise.all(activatedServices.services);
  assertNoReservedServiceRuntimeServiceNames(serviceRuntimeServices);
  const dashboardSettingsStore = resolveRuntimeSettingsStore(
    options.coreServices?.dashboard,
    createSystemStoreDashboardSettingsStore(systemStore),
  );
  const websiteCoreOptions = options.coreServices?.website;
  const websiteService = hasWebsiteService
    ? undefined
    : await resolveWebsiteCoreService(websiteCoreOptions, {
        rootPath,
        apiPrefix,
        apiVersion,
        pagesStore: resolvedDatabaseApi
          ? createDatabaseWebsitePagesStore(resolvedDatabaseApi)
          : undefined,
      });
  const storageService = hasStorageService
    ? undefined
    : await resolveStorageCoreService(options.coreServices?.storage, {
        rootPath,
        apiPrefix,
        apiVersion,
      });
  const workloadsCoreService = hasWorkloadsService
    ? undefined
    : await resolveWorkloadsCoreService(options.coreServices?.workloads);
  const websiteEnabled = hasWebsiteService || Boolean(websiteService);
  let runtimeConfigServices: readonly ZelavisRuntimeService<any>[] = [];
  const runtimeManagement = await resolveRuntimeManagementCore(
    options.coreServices?.dashboard,
    {
      apiPrefix,
      apiVersion,
      serviceRegistry,
      serviceRegistryStore,
      serviceImporter: options.services?.importer,
      servicePackageInstaller: options.servicePackageInstaller,
      serviceActivation: options.serviceActivation,
      rootPath,
      getServices: () => runtimeConfigServices,
      settingsStore: dashboardSettingsStore,
      websiteEnabled,
    },
  );
  const effectiveRuntimeServices = runtimeServices.map((service) =>
    service.name === "@zelavis/server"
      ? {
          ...service,
          api: {
            ...service.api,
            v1: [
              ...(service.api.v1 ?? []),
              ...runtimeManagement.routes,
            ],
          },
        }
      : service,
  );
  const serverCoreService = hasServerService
    ? undefined
    : await resolveServerCoreService(
        options.blueprints,
        systemStore,
        options.projectRuntime,
        runtimeManagement.routes,
        options.assistant,
      );
  const coreServices = [
    serverCoreService,
    databaseService,
    authService,
    websiteService,
    storageService,
    workloadsCoreService,
    ...serviceRuntimeServices,
  ].filter(
    (service): service is ZelavisRuntimeService<any> => Boolean(service),
  );
  const dashboardService = hasDashboardService
    ? undefined
    : await resolveDashboardCoreService(options.coreServices?.dashboard, {
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
    ...effectiveRuntimeServices,
  ].filter(
    (service): service is ZelavisRuntimeService<any> => Boolean(service),
  );
  const finalServices = [
    sanitizedDashboardService,
    dashboardAppService,
    domainChallengeService,
    ...coreServices,
    ...effectiveRuntimeServices,
  ].filter(
    (service): service is ZelavisRuntimeService<any> => Boolean(service),
  );
  const mountPrefix = websiteEnabled ? "/" : rootPath;

  return mountZelavisServer({
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNoInternalConstructorOptions(
  options: ZelavisOptions,
): void {
  const raw = options as Record<string, unknown>;
  const forbiddenKeys = [
    "runtimeServices",
    "coreServices",
    "serviceContext",
    "servicePrefixes",
    "pathOverrides",
    "servicePackageInstaller",
    "serviceActivation",
  ].filter((key) => raw[key] !== undefined);

  if (forbiddenKeys.length === 0) {
    return;
  }

  throw new TypeError(
    `new Zelavis(...) does not accept internal runtime options (${forbiddenKeys.join(", ")}). Use zelavis(...) for low-level service composition.`,
  );
}

function assertNoReservedServiceRuntimeServiceNames(
  services: readonly ZelavisRuntimeService<any>[],
): void {
  const reserved = services
    .map((service) => service.name)
    .filter((name) => RESERVED_CORE_SERVICE_NAMES.has(name));

  if (reserved.length === 0) {
    return;
  }

  throw new TypeError(
    `Services cannot register reserved core service names: ${reserved.join(", ")}.`,
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
  base: ZelavisServerOptions,
  override: ZelavisServerOptions,
): ZelavisServerOptions {
  const serviceEntries = [
    ...(base.services?.entries ?? []),
    ...(override.services?.entries ?? []),
  ];
  const serviceStore = override.services?.store ?? base.services?.store;
  const serviceImporter = override.services?.importer ?? base.services?.importer;
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
    runtimeServices: [
      ...(base.runtimeServices ?? []),
      ...(override.runtimeServices ?? []),
    ],
    servicePackageInstaller:
      override.servicePackageInstaller ?? base.servicePackageInstaller,
    serviceActivation: override.serviceActivation ?? base.serviceActivation,
    systemStore: override.systemStore ?? base.systemStore,
    blueprints: override.blueprints ?? base.blueprints,
    projectRuntime: override.projectRuntime ?? base.projectRuntime,
    services:
      serviceEntries.length > 0 || serviceStore || serviceImporter
        ? {
            ...(serviceEntries.length > 0 ? { entries: serviceEntries } : {}),
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
  serverOptions: ZelavisServerOptions;
  context: ZelavisPlatformContext;
}> {
  let resolved: ZelavisServerOptions = {};
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
  options: ZelavisServerOptions,
  resources: ZelavisPlatformResources,
): ZelavisServerOptions {
  const nextCoreServices: ZelavisCoreServicesOptions = {
    ...(options.coreServices ?? {}),
  };
  const nextServices: ZelavisServiceRegistryOptions = {
    ...(options.services ?? {}),
  };
  const databaseConfigured =
    nextCoreServices.database !== undefined && nextCoreServices.database !== false;

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
        : resources.files
          ? createFileStorageDashboardSettingsStore(resources.files)
          : undefined;

      if (settingsStore) {
        nextCoreServices.dashboard = {
          ...currentDashboard,
          settingsStore,
        };
      }
    }
  }

  if (nextCoreServices.website !== false) {
    const currentWebsite =
      nextCoreServices.website === true || nextCoreServices.website === undefined
        ? {}
        : nextCoreServices.website;

    if (!currentWebsite.pagesStore && !databaseConfigured && resources.files) {
      nextCoreServices.website = {
        ...currentWebsite,
        pagesStore: createFileStorageWebsitePagesStore(resources.files),
      };
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

  if (!nextServices.store) {
    nextServices.store = resources.systemStore
      ? createSystemStoreServiceRegistryStore(resources.systemStore)
      : resources.kv
        ? createKeyValueServiceRegistryStore(resources.kv)
      : resources.files
        ? createFileStorageServiceRegistryStore(resources.files)
        : undefined;
  }

  return {
    ...options,
    services: nextServices,
    coreServices: nextCoreServices,
    systemStore: options.systemStore ?? resources.systemStore,
    blueprints: options.blueprints ?? resources.blueprints,
    projectRuntime: options.projectRuntime ?? resources.projectRuntime,
  };
}

export class Zelavis {
  private readonly options: ZelavisOptions;
  private readonly serviceRegistryStore = createMemoryServiceRegistryStore([]);
  private runtimePromise?: Promise<ZelavisServerRuntime<unknown>>;
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

  async runtime(): Promise<ZelavisServerRuntime<unknown>> {
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
      const services = {
        ...(serverOptions.services ?? {}),
        store: serverOptions.services?.store ?? this.serviceRegistryStore,
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
      const runtime = await zelavis(
        {
          ...serverOptions,
          services,
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
        },
      );
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
}
