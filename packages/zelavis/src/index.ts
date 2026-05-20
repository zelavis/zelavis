import {
  authService as createAuthService,
  AuthDomainError,
  AuthNotFoundError,
  AuthValidationError,
  type AuthServiceOptions,
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
  type ZelavisAnyServiceInput,
  type ZelavisServerDispatchHandler,
  type ZelavisServerErrorHandler,
  type ZelavisServerExecutionContext,
  type ZelavisServerFetchHandler,
  type ZelavisServerPlainHandler,
  type ZelavisServerRuntime,
  type ZelavisService,
} from "@zelavis/server";
import {
  embeddedDashboardAssets,
  embeddedDashboardShell,
  type EmbeddedDashboardAsset,
} from "./generated/dashboard-assets.js";
import {
  activatePluginRegistry,
  applyPluginRegistryState,
  createPluginRegistry,
  findPluginMenuPageById,
  loadPlugin,
  loadPluginRegistry,
  serializePluginRegistryState,
  type ZelavisPluginLoadOptions,
  type ZelavisPluginMenuDefinition,
  type ZelavisPluginRegistryEntry,
  type ZelavisPluginRegistryModuleEntry,
  type ZelavisPluginRegistryStateEntry,
  type ZelavisPluginRegistryStore,
  type ZelavisPluginSetupPlatformContext,
  type ZelavisPluginSetupContext,
} from "./plugin.js";
export * from "./plugin.js";
export * from "./bundle-store.js";
export * from "./tls.js";
export * from "./domain-binding.js";
export * from "./domain-verifier.js";
import { createSharedBundleStore, type BundleStore } from "./bundle-store.js";
import type { TlsProvider } from "./tls.js";
import type { DomainBindingStore } from "./domain-binding.js";
import { createDomainChallengeService } from "./domain-verifier.js";
import { synthesizePluginAppService } from "./plugin-app.js";
import type {
  ZelavisPluginAppShellDefinition,
  ZelavisPluginDefinition,
} from "./plugin.js";
export * from "./storage/s3.js";

export * from "@zelavis/db";
export {
  type ZelavisAnyServiceInput,
  type ZelavisServerErrorHandler,
  type ZelavisServerRoute,
  type ZelavisServerRuntime,
  type ZelavisService,
} from "@zelavis/server";

export type ZelavisAuthCoreServiceOptions = boolean | AuthServiceOptions;

export interface ZelavisDashboardCoreServiceOptions {
  title?: string;
  subtitle?: string;
  assetPath?: string;
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

function serializeDashboardPreferences(
  preferences: ZelavisDashboardPreferences | undefined,
): DatabaseJsonObject | undefined {
  if (!preferences) {
    return undefined;
  }

  const content =
    preferences.content &&
    (preferences.content.pinnedTypes || preferences.content.labels)
      ? {
          ...(preferences.content.pinnedTypes
            ? { pinnedTypes: [...preferences.content.pinnedTypes] }
            : {}),
          ...(preferences.content.labels
            ? { labels: { ...preferences.content.labels } }
            : {}),
        }
      : undefined;
  const media =
    preferences.media?.orderedPaths
      ? { orderedPaths: [...preferences.media.orderedPaths] }
      : undefined;

  return {
    ...(content ? { content } : {}),
    ...(media ? { media } : {}),
  } satisfies DatabaseJsonObject;
}

function parseStoredPluginRegistryStateEntry(
  value: unknown,
): ZelavisPluginRegistryStateEntry {
  const input = readBodyObject(value);
  const name = typeof input.name === "string" ? input.name.trim() : "";

  if (!name) {
    throw new ZelavisValidationError(
      "Stored plugin registry entries must include a plugin name.",
    );
  }

  const entry: ZelavisPluginRegistryStateEntry = { name };

  if ("specifier" in input && input.specifier !== undefined) {
    if (typeof input.specifier !== "string" || !input.specifier.trim()) {
      throw new ZelavisValidationError(
        "Stored plugin registry specifier must be a non-empty string when provided.",
      );
    }

    entry.specifier = input.specifier.trim();
  }

  if ("status" in input) {
    if (input.status !== "installed" && input.status !== "available") {
      throw new ZelavisValidationError(
        'Stored plugin registry status must be "installed" or "available".',
      );
    }

    entry.status = input.status;
  }

  if ("source" in input && input.source !== undefined) {
    if (input.source !== "official" && input.source !== "community") {
      throw new ZelavisValidationError(
        'Stored plugin registry source must be "official" or "community" when provided.',
      );
    }

    entry.source = input.source;
  }

  if ("order" in input && input.order !== undefined) {
    if (typeof input.order !== "number" || !Number.isInteger(input.order) || input.order < 0) {
      throw new ZelavisValidationError(
        "Stored plugin registry order must be a non-negative integer.",
      );
    }

    entry.order = input.order;
  }

  return entry;
}

function parseStoredPluginRegistryState(
  value: unknown,
): ZelavisPluginRegistryStateEntry[] {
  const input = readBodyObject(value);

  if (!("plugins" in input)) {
    return [];
  }

  if (!Array.isArray(input.plugins)) {
    throw new ZelavisValidationError(
      "Stored plugin registry state must be an array.",
    );
  }

  return input.plugins.map((entry) => parseStoredPluginRegistryStateEntry(entry));
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

export interface ZelavisPluginRegistryOptions {
  entries?: readonly ZelavisPluginRegistryEntry<ZelavisPluginSetupContext>[];
  store?: ZelavisPluginRegistryStore;
  importer?: ZelavisPluginLoadOptions["importer"];
}

export interface ZelavisPluginContextOptions {
  platform?: ZelavisPluginSetupPlatformContext;
}

export interface ZelavisServerOptions {
  rootPath?: string;
  api?: ZelavisApiOptions;
  services?: readonly ZelavisAnyServiceInput[];
  plugins?: ZelavisPluginRegistryOptions;
  pluginPackageInstaller?: ZelavisPluginPackageInstaller;
  pluginActivation?: ZelavisPluginActivationController;
  pluginContext?: ZelavisPluginContextOptions;
  coreServices?: ZelavisCoreServicesOptions;
  servicePrefixes?: Record<string, string>;
  pathOverrides?: Record<string, string>;
  onError?: ZelavisServerErrorHandler;
  /**
   * Backing store for plugin `app` bundles. When omitted, the runtime
   * tries to wrap `platform.resources.files` in a default
   * `SharedBundleStore`. Plugins that declare an `app` field but have no
   * `BundleStore` available will still mount, but their asset routes
   * return 404 until a store is configured.
   */
  bundleStore?: BundleStore;
  /**
   * Domain bindings store. Workspace plugins that declare
   * `app.domains` only get host-bound routing for hosts with verified
   * bindings owned by their workspace+plugin pair.
   *
   * When omitted, the runtime falls through to
   * `platform.resources.domainBindings`; if neither is set, workspace
   * plugins get no host-bound routing.
   */
  domainBindings?: DomainBindingStore;
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

export interface ZelavisPluginPackageInstallInput {
  fileName: string;
  contentType?: string;
  body: Uint8Array;
}

export interface ZelavisPluginPackageInstallResult {
  specifier: string;
  message?: string;
}

export interface ZelavisPluginPackageInstaller {
  install(
    input: ZelavisPluginPackageInstallInput,
  ):
    | Promise<ZelavisPluginPackageInstallResult>
    | ZelavisPluginPackageInstallResult;
}

export interface ZelavisPlatformResources {
  kv?: ZelavisKeyValueStore;
  files?: ZelavisFileStorage;
  plugins?: ZelavisPluginActivationController;
  pluginPackages?: ZelavisPluginPackageInstaller;
  /**
   * TLS certificate provider. Adapters that terminate TLS in-process
   * (Node/Bun self-host) wire a real provider here; adapters whose
   * platform terminates TLS at the edge (Cloudflare/Vercel/Netlify)
   * should wire `createEdgeTlsProvider()` so downstream code can
   * distinguish "intentionally not my problem" from "not configured".
   */
  tls?: TlsProvider;
  /**
   * Domain-binding store. The synthesizer consults this when a
   * workspace-scoped plugin declares `app.domains` — only hosts with
   * verified bindings owned by the plugin's workspace+plugin pair are
   * allowed through. System-scope plugins skip this check (operator
   * deployed them, they're trusted).
   *
   * When undefined, workspace plugins get no host-bound routing
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

export interface ZelavisPluginActivationRequest {
  pluginName: string;
  action: "register" | "install" | "uninstall" | "update";
  specifier?: string;
  registry: readonly ZelavisPluginRegistryStateEntry[];
}

export interface ZelavisPluginActivationResult {
  status: "active" | "pending";
  message?: string;
}

export interface ZelavisPluginActivationCapabilities {
  strategy: "runtime-graph" | "worker-boundary" | "function-boundary" | "custom";
  supportsRuntimeInstall: boolean;
  supportsUploadedSpecifiers: boolean;
  supportsPackageUploads: boolean;
  supportsIsolatedExecution: boolean;
  description?: string;
}

export interface ZelavisPluginActivationController {
  mode: "runtime" | "host";
  capabilities: ZelavisPluginActivationCapabilities;
  activate(
    request: ZelavisPluginActivationRequest,
  ): Promise<ZelavisPluginActivationResult> | ZelavisPluginActivationResult;
}

export interface ZelavisOptions {
  rootPath?: string;
  api?: ZelavisApiOptions;
  plugins?: ZelavisPluginRegistryOptions;
  onError?: ZelavisServerErrorHandler;
  adapter?: ZelavisAdapter;
}

export interface ZelavisDatabaseDocumentStoreOptions {
  collection?: string;
  documentId?: string;
}

export function defineAdapter(
  definition: ZelavisAdapterDefinition,
): ZelavisAdapter {
  return definition;
}

const DEFAULT_ZELAVIS_STATE_COLLECTION = "zelavis_system";
const DEFAULT_DASHBOARD_SETTINGS_DOCUMENT_ID = "dashboard.settings";
const DEFAULT_WEBSITE_PAGES_DOCUMENT_ID = "website.pages";
const DEFAULT_PLUGIN_REGISTRY_DOCUMENT_ID = "plugins.registry";
const DEFAULT_PLATFORM_DASHBOARD_SETTINGS_KEY =
  "zelavis/dashboard-settings.json";
const DEFAULT_PLATFORM_WEBSITE_PAGES_PATH = "zelavis/website-pages.json";
const DEFAULT_PLATFORM_PLUGIN_REGISTRY_KEY = "zelavis/plugins.json";
const STORAGE_CHECKSUM_METADATA_KEY = "checksum-sha256";
const RESERVED_CORE_SERVICE_NAMES = new Set([
  "auth",
  "dashboard",
  "dashboard:app",
  "database",
  "storage",
  "website",
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

function isPluginUploadFile(value: unknown): value is Blob & { name?: string } {
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

function createMemoryPluginRegistryStore(
  initialEntries: readonly ZelavisPluginRegistryStateEntry[],
): ZelavisPluginRegistryStore {
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
  options: Required<ZelavisDatabaseDocumentStoreOptions>,
) {
  await ensureDatabaseCollection(database, options.collection);
  return database.documents.findById({
    collection: options.collection,
    id: options.documentId,
  });
}

async function readValidatedDatabaseDocumentData<T>(
  database: DatabaseApi,
  options: Required<ZelavisDatabaseDocumentStoreOptions>,
  parse: (value: unknown) => T,
): Promise<T> {
  const document = await readDatabaseDocument(database, options);
  return parse(document?.data);
}

async function writeDatabaseDocument(
  database: DatabaseApi,
  options: Required<ZelavisDatabaseDocumentStoreOptions>,
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

export function createDatabaseDashboardSettingsStore(
  database: DatabaseApi,
  options: ZelavisDatabaseDocumentStoreOptions = {},
): ZelavisDashboardSettingsStore {
  const documentOptions = {
    collection: options.collection ?? DEFAULT_ZELAVIS_STATE_COLLECTION,
    documentId: options.documentId ?? DEFAULT_DASHBOARD_SETTINGS_DOCUMENT_ID,
  };

  return {
    async read() {
      return readValidatedDatabaseDocumentData(
        database,
        documentOptions,
        (value) => parseStoredDashboardSettingsUpdate(readBodyObject(value)),
      );
    },
    async write(update) {
      const next = mergeDashboardSettingsUpdate(
        (await this.read()) ?? {},
        update,
      );

      await writeDatabaseDocument(database, documentOptions, {
        kind: "dashboard-settings",
        ...(next.rootPath !== undefined ? { rootPath: next.rootPath } : {}),
        ...(next.theme !== undefined ? { theme: next.theme } : {}),
        ...(next.pageBuilderEnabled !== undefined
          ? { pageBuilderEnabled: next.pageBuilderEnabled }
          : {}),
        ...(next.preferences
          ? { preferences: serializeDashboardPreferences(next.preferences) }
          : {}),
      });

      return next;
    },
  };
}

export function createDatabaseWebsitePagesStore(
  database: DatabaseApi,
  options: ZelavisDatabaseDocumentStoreOptions = {},
): ZelavisWebsitePagesStore {
  const documentOptions = {
    collection: options.collection ?? DEFAULT_ZELAVIS_STATE_COLLECTION,
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

export function createDatabasePluginRegistryStore(
  database: DatabaseApi,
  options: ZelavisDatabaseDocumentStoreOptions = {},
): ZelavisPluginRegistryStore {
  const documentOptions = {
    collection: options.collection ?? DEFAULT_ZELAVIS_STATE_COLLECTION,
    documentId: options.documentId ?? DEFAULT_PLUGIN_REGISTRY_DOCUMENT_ID,
  };

  return {
    async read() {
      return readValidatedDatabaseDocumentData(
        database,
        documentOptions,
        parseStoredPluginRegistryState,
      );
    },
    async write(entries) {
      const normalizedEntries = entries.map((entry) =>
        parseStoredPluginRegistryStateEntry(entry),
      );

      await writeDatabaseDocument(database, documentOptions, {
        kind: "plugin-registry",
        plugins: normalizedEntries.map((entry) => ({
          name: entry.name,
          ...(entry.specifier ? { specifier: entry.specifier } : {}),
          ...(entry.status ? { status: entry.status } : {}),
          ...(entry.source ? { source: entry.source } : {}),
          ...(entry.order !== undefined ? { order: entry.order } : {}),
        })),
      });

      return normalizedEntries;
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

export function createKeyValuePluginRegistryStore(
  store: ZelavisKeyValueStore,
  key = DEFAULT_PLATFORM_PLUGIN_REGISTRY_KEY,
): ZelavisPluginRegistryStore {
  return {
    async read() {
      const value = await store.get(key);
      if (!value) {
        return [];
      }

      return parseStoredPluginRegistryState(
        readBodyObject(JSON.parse(value) as unknown),
      );
    },
    async write(entries) {
      const normalizedEntries = entries.map((entry) =>
        parseStoredPluginRegistryStateEntry(entry),
      );
      await store.set(
        key,
        JSON.stringify(
          {
            kind: "plugin-registry",
            plugins: normalizedEntries,
          },
          null,
          2,
        ),
      );
      return normalizedEntries;
    },
  };
}

export function createFileStoragePluginRegistryStore(
  storage: ZelavisFileStorage,
  path = DEFAULT_PLATFORM_PLUGIN_REGISTRY_KEY,
): ZelavisPluginRegistryStore {
  return {
    async read() {
      const file = await storage.get(path);
      if (!file) {
        return [];
      }

      return parseStoredPluginRegistryState(
        readBodyObject(
          JSON.parse(new TextDecoder().decode(file.body)) as unknown,
        ),
      );
    },
    async write(entries) {
      const normalizedEntries = entries.map((entry) =>
        parseStoredPluginRegistryStateEntry(entry),
      );

      await storage.put({
        path,
        body: JSON.stringify(
          {
            kind: "plugin-registry",
            plugins: normalizedEntries,
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

function resolveDashboardSettingsStore(
  option: ZelavisDashboardCoreServiceInput | undefined,
  fallbackStore?: ZelavisDashboardSettingsStore,
): ZelavisDashboardSettingsStore | undefined {
  const dashboardOption = option ?? true;

  if (dashboardOption === false) {
    return undefined;
  }

  if (dashboardOption === true) {
    return fallbackStore ?? createMemoryDashboardSettingsStore();
  }

  return (
    dashboardOption.settingsStore ??
    fallbackStore ??
    createMemoryDashboardSettingsStore()
  );
}

function resolvePluginRegistryStore(
  option: ZelavisPluginRegistryOptions | undefined,
  fallbackStore: ZelavisPluginRegistryStore,
): ZelavisPluginRegistryStore {
  return option?.store ?? fallbackStore;
}

async function readInitialPluginRegistryState(
  store: ZelavisPluginRegistryStore,
): Promise<readonly ZelavisPluginRegistryStateEntry[] | undefined> {
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

function readDashboardPluginRegistryUpdate(
  body: unknown,
): Omit<ZelavisPluginRegistryStateEntry, "name"> {
  const input = readBodyObject(body);
  const update: Omit<ZelavisPluginRegistryStateEntry, "name"> = {};

  if ("status" in input) {
    if (input.status !== "installed" && input.status !== "available") {
      throw new ZelavisValidationError(
        'Plugin status must be "installed" or "available".',
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
        'Plugin source must be "official" or "community" when provided.',
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
        "Plugin order must be a non-negative integer when provided.",
      );
    }

    update.order = input.order as number | undefined;
  }

  return update;
}

async function readDashboardPluginRegistryCreate(
  body: unknown,
  options: {
    importer?: ZelavisPluginLoadOptions["importer"];
    packageInstaller?: ZelavisPluginPackageInstaller;
  } = {},
): Promise<ZelavisPluginRegistryStateEntry> {
  const input = readBodyObject(body);
  const explicitName = typeof input.name === "string" ? input.name.trim() : "";
  let specifier =
    typeof input.specifier === "string" ? input.specifier.trim() : "";
  const uploadedFile = input.file;

  if (!specifier && isPluginUploadFile(uploadedFile)) {
    const bytes = new Uint8Array(await uploadedFile.arrayBuffer());

    if (options.packageInstaller) {
      const installed = await options.packageInstaller.install({
        fileName:
          typeof uploadedFile.name === "string" && uploadedFile.name.trim()
            ? uploadedFile.name
            : "plugin.zip",
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
      "Plugin module file or ESM specifier is required.",
    );
  }

  let pluginName = explicitName;

  if (!pluginName) {
    try {
      const plugin = await loadPlugin<ZelavisPluginSetupContext>(specifier, {
        importer: options.importer,
      });
      pluginName = plugin.name;
    } catch (error) {
      throw new ZelavisValidationError(
        `Plugin module could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return parseStoredPluginRegistryStateEntry({
    name: pluginName,
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

const defaultDashboardClientRoutes = [
  "/agents",
  "/auth",
  "/builder",
  "/builder/pages",
  "/commerce",
  "/commerce/customers",
  "/commerce/coupons",
  "/commerce/orders",
  "/commerce/products",
  "/content",
  "/database",
  "/media",
  "/marketplace",
  "/services",
  "/settings",
  "/settings/appearance",
  "/storage",
  "/users",
] as const;

const defaultDashboardPluginRegistryModules: readonly ZelavisPluginRegistryModuleEntry[] = [
  {
    specifier: "@zelavis/ecommerce",
    status: "available",
    source: "official",
    order: 0,
  },
];

async function loadStoredPluginRegistryModules(
  entries: readonly ZelavisPluginRegistryStateEntry[] | undefined,
  importer?: ZelavisPluginLoadOptions["importer"],
): Promise<readonly Readonly<ZelavisPluginRegistryEntry<ZelavisPluginSetupContext>>[]> {
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
    ZelavisPluginRegistryEntry<ZelavisPluginSetupContext>
  >[] = [];

  for (const entry of moduleEntries) {
    try {
      const loaded = await loadPluginRegistry<ZelavisPluginSetupContext>(
        [entry],
        { importer },
      );

      // Runtime-installed plugins are always workspace-scoped regardless of
      // what `scope` or `menu.surface` their definition declares. Trust is
      // granted by the registration path (static), not the definition itself.
      const scoped = loaded.map((registryEntry) => {
        if (!registryEntry.plugin) {
          return registryEntry;
        }

        const plugin = registryEntry.plugin;
        const needsPatch =
          plugin.scope !== "workspace" ||
          (plugin.menu && "surface" in plugin.menu && plugin.menu.surface !== undefined);

        if (!needsPatch) {
          return registryEntry;
        }

        return Object.freeze({
          ...registryEntry,
          plugin: Object.freeze({
            ...plugin,
            scope: "workspace" as const,
            menu: plugin.menu
              ? Object.freeze({ ...plugin.menu, surface: undefined })
              : plugin.menu,
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

function createPluginSetupPlatformContext(
  platform?:
    | Partial<ZelavisPlatformContext>
    | ZelavisPluginSetupPlatformContext,
): ZelavisPluginSetupPlatformContext {
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

interface DashboardAsset {
  path: string;
  contentType: string;
  cacheControl: string;
  kind: "text" | "base64";
  content: string;
}

const DASHBOARD_RUNTIME_ASSET_CACHE_KEY = "zelavis-runtime-v1";

function collectDashboardAssets(): DashboardAsset[] {
  return [...embeddedDashboardAssets]
    .map((asset: EmbeddedDashboardAsset) => ({
      path: asset.path,
      contentType: asset.contentType,
      cacheControl: asset.cacheControl,
      kind: asset.kind,
      content: asset.content,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function prefixDashboardAssetReferences(
  content: string,
  rootPath: string,
  options: { cacheAbsoluteAssets?: boolean } = {},
): string {
  const prefix = rootPath === "/" ? "" : rootPath;
  const barePrefix = prefix.replace(/^\/+/, "");
  const bareAssetPrefix = barePrefix ? `${barePrefix}/assets/` : "assets/";
  const maybeCacheAsset = (path: string) => {
    if (!options.cacheAbsoluteAssets) {
      return path;
    }

    return `${path}${path.includes("?") ? "&" : "?"}${DASHBOARD_RUNTIME_ASSET_CACHE_KEY}`;
  };
  const prefixAbsolutePath = (attribute: string, path: string) => {
    const nextPath = `${prefix}/${path}`;

    return `${attribute}="${path.startsWith("assets/") ? maybeCacheAsset(nextPath) : nextPath}"`;
  };
  const prefixQuotedAbsoluteAsset = (
    _match: string,
    quote: string,
    assetPath: string,
  ) => {
    return `${quote}${maybeCacheAsset(`${prefix}/assets/${assetPath}`)}`;
  };
  const prefixQuotedBareAsset = (
    _match: string,
    quote: string,
    assetPath: string,
  ) => {
    return `${quote}${bareAssetPrefix}${assetPath}`;
  };

  return content
    .replace(
      /("basename"\s*:\s*)"\/"/g,
      (_match, property: string) => `${property}${JSON.stringify(rootPath)}`,
    )
    .replace(
      /\b(href|src|action)="\/(?!\/)([^"]*)"/g,
      (_match, attribute, path) => {
        return prefixAbsolutePath(attribute, path);
      },
    )
    .replace(/(["'`])\/assets\/([^"'`\\\s<>)]*)/g, prefixQuotedAbsoluteAsset)
    .replace(/(["'`])assets\/([^"'`\\\s<>)]*)/g, prefixQuotedBareAsset);
}

function shouldPrefixDashboardAsset(asset: DashboardAsset): boolean {
  return (
    asset.contentType.startsWith("text/") ||
    asset.contentType.startsWith("application/json") ||
    asset.path.endsWith(".js") ||
    asset.path.endsWith(".mjs")
  );
}

function readDashboardAsset(
  asset: DashboardAsset,
  rootPath: string,
): Uint8Array | string {
  function decodeBase64(base64: string): Uint8Array {
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const sanitized = base64.replace(/=+$/, "");
    const output: number[] = [];

    for (let index = 0; index < sanitized.length; index += 4) {
      const c1 = alphabet.indexOf(sanitized[index] ?? "A");
      const c2 = alphabet.indexOf(sanitized[index + 1] ?? "A");
      const c3 = alphabet.indexOf(sanitized[index + 2] ?? "A");
      const c4 = alphabet.indexOf(sanitized[index + 3] ?? "A");
      const value = (c1 << 18) | (c2 << 12) | ((c3 & 63) << 6) | (c4 & 63);

      output.push((value >> 16) & 0xff);
      if (sanitized[index + 2] !== undefined) {
        output.push((value >> 8) & 0xff);
      }
      if (sanitized[index + 3] !== undefined) {
        output.push(value & 0xff);
      }
    }

    return Uint8Array.from(output);
  }

  if (!shouldPrefixDashboardAsset(asset)) {
    return asset.kind === "text" ? asset.content : decodeBase64(asset.content);
  }

  return prefixDashboardAssetReferences(asset.content, rootPath);
}

function injectDashboardRuntimeConfig(html: string, config: unknown): string {
  const script = `<script>window.__ZELAVIS_RUNTIME_CONFIG__=${JSON.stringify(config).replaceAll("<", "\\u003c")};</script>`;
  return html.includes("</head>")
    ? html.replace("</head>", `${script}</head>`)
    : `${script}${html}`;
}

/**
 * Internal host-side binding the dashboard core service hands up to
 * `zelavis()`. Allows the dashboard to declare its app bundle + shell
 * renderer + dev-server URL without polluting the public
 * `ZelavisService` shape.
 */
interface DashboardAppHostBinding {
  bundleStore: BundleStore;
  shell: { render: ZelavisPluginAppShellDefinition["render"] };
  devUrl?: string;
}

/**
 * Build a `BundleStore` over the embedded dashboard assets. The dashboard
 * ships its UI bundle as a generated `embeddedDashboardAssets` array
 * (paths, content-type, base64-or-text body). We need to expose those to
 * the request pipeline through the same `BundleStore` interface used by
 * plugin apps, so the dashboard becomes "just another app" from the
 * dispatcher's point of view.
 *
 * Notes on path normalization:
 *
 * - The synthesizer calls `read(scope, relativePath)` with a path that's
 *   the request URL minus the mount prefix and leading slash. For a
 *   dashboard mounted at `/zelavis`, a request for
 *   `/zelavis/assets/main.abc.js` arrives here as `assets/main.abc.js`.
 * - `embeddedDashboardAssets` stores paths with a leading slash
 *   (`/assets/main.abc.js`), so we lookup with that form.
 *
 * Notes on content transformation:
 *
 * - Text assets (HTML, JS, CSS) reference absolute paths like
 *   `/assets/...`. When the dashboard is mounted under a non-root path,
 *   those references need rewriting. `readDashboardAsset` already does
 *   this via `prefixDashboardAssetReferences`, so the bundle store
 *   delegates to it.
 *
 * The store is read-only — there is no write path for embedded assets.
 */
function createEmbeddedDashboardBundleStore(
  rootPath: string,
): BundleStore {
  const assets = collectDashboardAssets();
  const byKey = new Map<string, DashboardAsset>();
  for (const asset of assets) {
    // Index by leading-slash form (`/assets/...`) and bare form
    // (`assets/...`) so callers can use either.
    byKey.set(asset.path, asset);
    byKey.set(asset.path.replace(/^\/+/, ""), asset);
  }

  return {
    async read(_scope, path) {
      const asset = byKey.get(path) ?? byKey.get(`/${path.replace(/^\/+/, "")}`);
      if (!asset) {
        return undefined;
      }
      const body = readDashboardAsset(asset, rootPath);
      const bytes =
        typeof body === "string" ? new TextEncoder().encode(body) : body;
      return {
        path,
        body: bytes,
        size: bytes.byteLength,
        contentType: asset.contentType,
        cacheControl: shouldPrefixDashboardAsset(asset)
          ? "no-cache"
          : asset.cacheControl,
      };
    },
    async list() {
      return assets.map((asset) => asset.path);
    },
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
): Promise<ZelavisService<any> | undefined> {
  const authOption = option ?? true;

  if (authOption === false) {
    return undefined;
  }

  return createAuthService(authOption === true ? {} : authOption);
}

type DashboardPluginPageReference = {
  id: string;
  title?: string;
  src: string;
};

type DashboardSerializedPluginMenuDefinition = Omit<
  ZelavisPluginMenuDefinition,
  "items" | "page"
> & {
  page?: DashboardPluginPageReference;
  items?: readonly DashboardSerializedPluginMenuDefinition[];
};

async function resolveDashboardCoreService(
  option: ZelavisDashboardCoreServiceInput | undefined,
  context: {
    apiPrefix: string;
    apiVersion: string;
    pluginRegistry: readonly Readonly<
      ZelavisPluginRegistryEntry<ZelavisPluginSetupContext>
    >[];
    pluginRegistryStore: ZelavisPluginRegistryStore;
    pluginImporter?: ZelavisPluginLoadOptions["importer"];
    pluginPackageInstaller?: ZelavisPluginPackageInstaller;
    pluginActivation?: ZelavisPluginActivationController;
    rootPath: string;
    services: readonly ZelavisService<any>[];
    settingsStore?: ZelavisDashboardSettingsStore;
    websiteEnabled: boolean;
  },
): Promise<ZelavisService<any> | undefined> {
  const dashboardOption = option ?? true;

  if (dashboardOption === false) {
    return undefined;
  }

  const options = dashboardOption === true ? {} : dashboardOption;
  const title = options.title ?? "zelavis";
  const subtitle = options.subtitle ?? "Backend, dashboard, and core services.";
  const rootPath = context.rootPath;
  const settingsStore =
    context.settingsStore ??
    options.settingsStore ??
    createMemoryDashboardSettingsStore();
  const devServerUrl = normalizeExternalUrl(
    options.devServerUrl ?? readOptionalProcessEnv("ZELAVIS_UI_DEV_SERVER"),
  );
  const finalServicesForDashboard = context.services;
  const clientRoutes = [
    ...new Set(
      (options.clientRoutes ?? defaultDashboardClientRoutes)
        .map((route) => normalizePath(route, "/"))
        .filter((route) => route !== "/"),
    ),
  ];
  const readResolvedPluginRegistry = async () => {
    const storedEntries = await context.pluginRegistryStore.read();
    const storedPluginRegistry = await loadStoredPluginRegistryModules(
      storedEntries,
      context.pluginImporter,
    );

    // Static plugins (passed directly to zelavis()) are system-scoped — they
    // can use any dashboard surface. Runtime-installed plugins are already
    // forced to workspace scope inside loadStoredPluginRegistryModules.
    const systemPluginRegistry = context.pluginRegistry.map((entry) =>
      entry.plugin.scope === "system"
        ? entry
        : Object.freeze({
            ...entry,
            plugin: Object.freeze({ ...entry.plugin, scope: "system" as const }),
          }),
    );

    const knownPluginNames = new Set(
      systemPluginRegistry.map((entry) => entry.plugin.name),
    );
    const completePluginRegistry = createPluginRegistry([
      ...systemPluginRegistry,
      ...storedPluginRegistry.filter(
        (entry) => !knownPluginNames.has(entry.plugin.name),
      ),
    ]);

    return applyPluginRegistryState(completePluginRegistry, storedEntries);
  };
  const serializePluginMenuForDashboard = (
    pluginName: string,
    menu: ZelavisPluginMenuDefinition | undefined,
  ): DashboardSerializedPluginMenuDefinition | undefined => {
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
              "dashboard",
              "plugin-pages",
              pluginName,
              menu.page.id,
            ),
          }
        : undefined,
      items: menu.items?.map((item) =>
        serializePluginMenuForDashboard(pluginName, item),
      ) as readonly DashboardSerializedPluginMenuDefinition[] | undefined,
    };
  };
  const renderPluginPageDocument = async (
    pluginName: string,
    pageId: string,
  ) => {
    const pluginRegistry = await readResolvedPluginRegistry();
    const entry = pluginRegistry.find(
      (candidate) => candidate.plugin.name === pluginName,
    );

    if (!entry || entry.status !== "installed") {
      return {
        status: 404,
        body: {
          error: "Plugin page not found.",
        },
      };
    }

    const page = findPluginMenuPageById(entry.plugin.menu, pageId);
    if (!page?.render) {
      return {
        status: 404,
        body: {
          error: "Plugin page not found.",
        },
      };
    }

    const rendered = await page.render({
      plugin: entry.plugin.name,
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
    const pluginRegistry = await readResolvedPluginRegistry();
    const serializedPlugins = pluginRegistry.map((entry) => ({
      name: entry.plugin.name,
      version: entry.plugin.version,
      specifier: entry.specifier,
      status: entry.status,
      source: entry.source,
      order: entry.order,
      menu: serializePluginMenuForDashboard(entry.plugin.name, entry.plugin.menu),
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
      services: finalServicesForDashboard.map((service) => ({
        name: service.name,
        core:
          service.name === "dashboard" ||
          service.name === "auth" ||
          service.name === "database" ||
          service.name === "storage" ||
          service.name === "website",
        apiPath:
          service.name === "website"
            ? "/"
            : service.name === "dashboard"
              ? rootPath
              : joinPathParts(
                  rootPath,
                  context.apiPrefix,
                  context.apiVersion,
                  service.name,
                ),
        menu: service.menu,
      })),
      plugins: serializedPlugins,
      pluginActivation: context.pluginActivation
        ? {
            mode: context.pluginActivation.mode,
            capabilities: {
              ...context.pluginActivation.capabilities,
              supportsPackageUploads: Boolean(context.pluginPackageInstaller),
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
                "No plugin activation controller is configured for this runtime.",
            },
          },
    };
  };
  const serializePluginRegistryForDashboard = async () =>
    {
      const pluginRegistry = await readResolvedPluginRegistry();
      const serialized = pluginRegistry.map((entry) => ({
        name: entry.plugin.name,
        version: entry.plugin.version,
        specifier: entry.specifier,
        status: entry.status,
        source: entry.source,
        order: entry.order,
        menu: serializePluginMenuForDashboard(entry.plugin.name, entry.plugin.menu),
      }));
      const seen = new Set(serialized.map((entry) => entry.name));
      const storedEntries = await context.pluginRegistryStore.read();

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
  const activatePluginRegistryChange = async (
    request: Omit<ZelavisPluginActivationRequest, "registry">,
    registry: readonly ZelavisPluginRegistryStateEntry[],
  ): Promise<ZelavisPluginActivationResult> => {
    if (!context.pluginActivation) {
      return {
        status: "pending",
        message:
          "Plugin registry state changed. This host has not configured runtime plugin activation yet.",
      };
    }

    return context.pluginActivation.activate({
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
  const baseShell = embeddedDashboardShell
    ? prefixDashboardAssetReferences(embeddedDashboardShell, rootPath, {
        cacheAbsoluteAssets: true,
      })
    : undefined;
  const shellHandler = async ({
    query,
    request,
  }: {
    query: URLSearchParams;
    request: unknown;
  }) => {
    // Dev-server short-circuit lives in the synthesized app handler now
    // (via `app.devUrl`); by the time shellHandler runs, we're serving
    // the embedded bundle's shell with injected runtime config.

    if (!baseShell) {
      return {
        status: 503,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
        },
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p><p>Dashboard assets have not been built yet.</p></body></html>`,
      };
    }

    return {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      },
      body: injectDashboardRuntimeConfig(
        baseShell,
        await createDashboardRuntimeConfig(),
      ),
    };
  };
  // The dashboard's shell renderer. Used by the synthesized
  // `dashboard:app` service for the mount root and for SPA fallback
  // misses. Two concerns merged here (the dev-server redirect used to
  // be the third, but it's now declared via `app.devUrl` and runs
  // inside the synthesizer before this renderer is ever called):
  //
  //  1. `api/*` / `assets/*` 404 — these paths must NOT fall through to
  //     the SPA shell on miss, since they're either real API endpoints
  //     (resolved by the dispatcher first; only unrecognized ones reach
  //     us) or static assets (resolved by the bundle store; only
  //     missing ones reach us).
  //  2. Shell HTML with injected runtime config — for everything else.
  const dashboardShellRender = async (
    context: { request: Request; path: string },
  ): Promise<{ status?: number; headers?: HeadersInit; body?: unknown }> => {
    const { request, path } = context;
    const url = new URL(request.url);
    const query = url.searchParams;

    if (
      path === "api" ||
      path.startsWith("api/") ||
      path === "assets" ||
      path.startsWith("assets/")
    ) {
      return {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: { error: "Not found" },
      };
    }

    return shellHandler({ query, request });
  };

  return {
    name: "dashboard",
    basePath: "/",
    menu: {
      title: "Dashboard",
      path: "/",
      surface: "root",
    },
    service: {
      title,
      subtitle,
      assetRoot: joinPathParts(rootPath, "assets"),
      // Surfaced so `zelavis()` can synthesize the dashboard's
      // asset-serving service via the shared plugin-app primitive. The
      // per-asset routes and SPA-deep-link fallback that used to live
      // in `api.v1` are now produced by `synthesizePluginAppService`,
      // which calls `shell.render` for the index + SPA fallback and
      // serves bundle bytes for everything else.
      //
      // This isn't a public service field — consumers should not poke
      // at it. The runtime reads it once during composition and drops
      // it from the externally-visible service map.
      _app: {
        bundleStore: createEmbeddedDashboardBundleStore(rootPath),
        shell: { render: dashboardShellRender },
        // When set, the synthesizer 307s every request under the
        // dashboard mount to this URL. Previously this was a bespoke
        // branch inside the shell renderer; now it flows through the
        // same `app.devUrl` primitive plugins use.
        devUrl: devServerUrl,
      } as DashboardAppHostBinding,
    },
    api: {
      v1: [
        {
          id: "dashboard.config",
          method: "GET",
          path: joinPathParts(
            context.apiPrefix,
            context.apiVersion,
            "dashboard/config",
          ),
          handler: async () => ({
            status: 200,
            body: await createDashboardRuntimeConfig(),
          }),
        },
        {
          id: "dashboard.plugins.read",
          method: "GET",
          path: joinPathParts(
            context.apiPrefix,
            context.apiVersion,
            "dashboard/plugins",
          ),
          handler: async () => {
            try {
              return {
                status: 200,
                body: {
                  plugins: await serializePluginRegistryForDashboard(),
                },
              };
            } catch (error) {
              return zelavisErrorResponse(error, 400);
            }
          },
        },
        {
          id: "dashboard.plugins.create",
          method: "POST",
          path: joinPathParts(
            context.apiPrefix,
            context.apiVersion,
            "dashboard/plugins",
          ),
          handler: async ({ body }: { body: unknown }) => {
            try {
              const created = await readDashboardPluginRegistryCreate(body, {
                importer: context.pluginImporter,
                packageInstaller: context.pluginPackageInstaller,
              });
              const currentEntries = await context.pluginRegistryStore.read();
              const nextEntries = [
                ...(currentEntries ?? []).filter(
                  (entry) => entry.name !== created.name,
                ),
                created,
              ];

              await context.pluginRegistryStore.write(nextEntries);
              const activation = await activatePluginRegistryChange(
                {
                  pluginName: created.name,
                  action:
                    created.status === "installed" ? "install" : "register",
                  specifier: created.specifier,
                },
                nextEntries,
              );

              return {
                status: 201,
                body: {
                  plugins: await serializePluginRegistryForDashboard(),
                  activation,
                },
              };
            } catch (error) {
              return zelavisErrorResponse(error, 400);
            }
          },
        },
        {
          id: "dashboard.plugin-page.read",
          method: "GET",
          path: joinPathParts(
            context.apiPrefix,
            context.apiVersion,
            "dashboard/plugin-pages/:plugin/:page",
          ),
          handler: async ({
            params,
          }: {
            params: Record<string, string>;
          }) => {
            try {
              const pluginName = params.plugin?.trim();
              const pageId = params.page?.trim();
              if (!pluginName || !pageId) {
                throw new ZelavisValidationError(
                  "Plugin name and page id are required.",
                );
              }

              return await renderPluginPageDocument(pluginName, pageId);
            } catch (error) {
              return zelavisErrorResponse(error, 400);
            }
          },
        },
        {
          id: "dashboard.plugins.update",
          method: "PATCH",
          path: joinPathParts(
            context.apiPrefix,
            context.apiVersion,
            "dashboard/plugins/:name",
          ),
          handler: async ({ body, params }: { body: unknown; params: Record<string, string> }) => {
            try {
              const pluginName = params.name?.trim();
              if (!pluginName) {
                throw new ZelavisValidationError("Plugin name is required.");
              }

              const update = readDashboardPluginRegistryUpdate(body);
              const currentEntries =
                (await context.pluginRegistryStore.read()) ?? [];
              const currentRegistry = await readResolvedPluginRegistry();
              const nextRegistry = createPluginRegistry(
                currentRegistry.map((entry) =>
                  entry.plugin.name === pluginName
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
                (entry) => entry.plugin.name === pluginName,
              );
              const updatedStoredEntry = currentEntries.find(
                (entry) => entry.name === pluginName,
              );

              if (!updatedRegistryEntry && !updatedStoredEntry) {
                throw new ZelavisValidationError(
                  `Unknown plugin "${pluginName}".`,
                );
              }

              const serializedNextRegistry = serializePluginRegistryState(
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
                    entry.name === pluginName
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

              await context.pluginRegistryStore.write(serializedNextEntries);
              const activation = await activatePluginRegistryChange(
                {
                  pluginName,
                  action:
                    update.status === "installed"
                      ? "install"
                      : update.status === "available"
                        ? "uninstall"
                        : "update",
                  specifier: nextRegistry.find(
                    (entry) => entry.plugin.name === pluginName,
                  )?.specifier ?? updatedStoredEntry?.specifier,
                },
                serializedNextEntries,
              );

              return {
                status: 200,
                body: {
                  plugins: await serializePluginRegistryForDashboard(),
                  activation,
                },
              };
            } catch (error) {
              return zelavisErrorResponse(error, 400);
            }
          },
        },
        {
          id: "dashboard.settings.read",
          method: "GET",
          path: joinPathParts(
            context.apiPrefix,
            context.apiVersion,
            "dashboard/settings",
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
          id: "dashboard.settings.update",
          method: "PATCH",
          path: joinPathParts(
            context.apiPrefix,
            context.apiVersion,
            "dashboard/settings",
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
        // Per-asset routes and the SPA-fallback catch-all used to live
        // here. They're now synthesized from `service.app` via the
        // shared plugin-app synthesizer — see the runtime mounting step
        // in `zelavis()`.
      ],
    },
  };
}

async function resolveWebsiteCoreService(
  option: ZelavisWebsiteCoreServiceInput | undefined,
  context: {
    rootPath: string;
    apiPrefix: string;
    apiVersion: string;
    pagesStore?: ZelavisWebsitePagesStore;
  },
): Promise<ZelavisService<any> | undefined> {
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
    name: "website",
    basePath: "/",
    menu: {
      title: "Website",
      path: "/builder/pages",
      pageLabel: "Builder",
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
): Promise<ZelavisService<any> | undefined> {
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
    name: "storage",
    basePath: "/",
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

/**
 * Read the dashboard's host-side app binding (smuggled via `service._app`)
 * and synthesize a sibling asset-serving service through the same
 * plugin-app primitive that ordinary plugins use.
 *
 * Returns `undefined` when the dashboard didn't expose an app binding —
 * e.g. when a user provided their own `dashboard` service that doesn't
 * follow the core convention.
 */
async function synthesizeDashboardAppService(
  dashboardService: ZelavisService<any>,
): Promise<ZelavisService | undefined> {
  const binding = readDashboardAppHostBinding(dashboardService);
  if (!binding) {
    return undefined;
  }

  const synthetic: Readonly<ZelavisPluginDefinition<unknown>> = Object.freeze({
    name: "dashboard",
    scope: "system" as const,
    app: Object.freeze({
      mount: "/",
      mode: "spa" as const,
      shell: binding.shell,
      devUrl: binding.devUrl,
    }),
  }) as Readonly<ZelavisPluginDefinition<unknown>>;

  // System-scope plugin, so domain bindings are bypassed — pass
  // undefined for the binding store rather than threading the real
  // one through. (System plugins are operator-trusted and may declare
  // any host they like.)
  const appService = await synthesizePluginAppService({
    plugin: synthetic,
    bundleStore: binding.bundleStore,
    effectiveMount: "/",
  });

  return appService;
}

function readDashboardAppHostBinding(
  dashboardService: ZelavisService<any>,
): DashboardAppHostBinding | undefined {
  const serviceApi = dashboardService.service;
  if (
    !serviceApi ||
    typeof serviceApi !== "object" ||
    !("_app" in serviceApi)
  ) {
    return undefined;
  }
  const binding = (serviceApi as { _app?: unknown })._app;
  if (
    !binding ||
    typeof binding !== "object" ||
    !("bundleStore" in binding) ||
    !("shell" in binding)
  ) {
    return undefined;
  }
  return binding as DashboardAppHostBinding;
}

/**
 * Produce a copy of the dashboard service with the internal `_app`
 * binding removed, so the externally-visible service map stays a clean
 * `ZelavisService` shape (no leaking host implementation details).
 */
function stripDashboardHostBinding(
  dashboardService: ZelavisService<any>,
): ZelavisService<any> {
  const serviceApi = dashboardService.service;
  if (
    !serviceApi ||
    typeof serviceApi !== "object" ||
    !("_app" in serviceApi)
  ) {
    return dashboardService;
  }
  const { _app: _ignored, ...rest } = serviceApi as Record<string, unknown>;
  return {
    ...dashboardService,
    service: rest,
  };
}

function createServicePrefixes(
  services: readonly ZelavisService<any>[],
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
    if (service.name === "website") {
      prefixes[service.name] = "/";
      continue;
    }

    if (service.name === "dashboard" || service.name === "dashboard:app") {
      // The synthesized asset-serving service mirrors the dashboard's
      // mount, so its routes line up under the same prefix.
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

    prefixes[service.name] = mountAtRoot
      ? joinPathParts(
          options.rootPath,
          options.apiPrefix,
          options.apiVersion,
          service.name,
        )
      : joinPathParts(options.apiPrefix, options.apiVersion, service.name);
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
  const services = await Promise.all(options.services ?? []);
  const basePluginRegistry =
    options.plugins?.entries !== undefined
      ? createPluginRegistry(options.plugins.entries)
      : await loadPluginRegistry<ZelavisPluginSetupContext>(
          defaultDashboardPluginRegistryModules,
        );
  const hasAuthService = services.some((service) => service.name === "auth");
  const hasDashboardService = services.some(
    (service) => service.name === "dashboard",
  );
  const hasWebsiteService = services.some(
    (service) => service.name === "website",
  );
  const hasStorageService = services.some(
    (service) => service.name === "storage",
  );
  const hasDatabaseService = services.some(
    (service) => service.name === "database",
  );
  const providedDatabaseService = services.find(
    (service) => service.name === "database" && isDatabaseApi(service.service),
  );
  const authService = hasAuthService
    ? undefined
    : await resolveAuthCoreService(options.coreServices?.auth);
  const databaseApi = hasDatabaseService
    ? undefined
    : await resolveDatabaseCoreService(options.coreServices?.database);
  const databaseService = databaseApi
    ? defineDatabaseService(databaseApi)
    : undefined;
  const resolvedDatabaseApi =
    (providedDatabaseService?.service as DatabaseApi | undefined) ??
    databaseApi;
  const pluginRegistryStore = resolvePluginRegistryStore(
    options.plugins,
    resolvedDatabaseApi
      ? createDatabasePluginRegistryStore(resolvedDatabaseApi)
      : createMemoryPluginRegistryStore(
          serializePluginRegistryState(basePluginRegistry),
        ),
  );
  const initialPluginRegistryState =
    await readInitialPluginRegistryState(pluginRegistryStore);
  const storedPluginRegistry = await loadStoredPluginRegistryModules(
    initialPluginRegistryState,
    options.plugins?.importer,
  );
  const knownPluginNames = new Set(
    basePluginRegistry.map((entry) => entry.plugin.name),
  );
  const completePluginRegistry = createPluginRegistry([
    ...basePluginRegistry,
    ...storedPluginRegistry.filter(
      (entry) => !knownPluginNames.has(entry.plugin.name),
    ),
  ]);
  const pluginRegistry = applyPluginRegistryState(
    completePluginRegistry,
    initialPluginRegistryState,
  );
  const activatedPlugins = await activatePluginRegistry(
    pluginRegistry,
    {
      rootPath,
      api: {
        prefix: apiPrefix,
        version: apiVersion,
        basePath: joinPathParts(rootPath, apiPrefix, apiVersion),
      },
      platform: createPluginSetupPlatformContext(options.pluginContext?.platform),
      core: {
        ...(resolvedDatabaseApi ? { database: resolvedDatabaseApi } : {}),
      },
    },
    {
      bundleStore: options.bundleStore,
      domainBindings: options.domainBindings,
    },
  );
  const pluginServices = await Promise.all(activatedPlugins.services);
  assertNoReservedPluginServiceNames(pluginServices);
  const dashboardSettingsStore = resolveDashboardSettingsStore(
    options.coreServices?.dashboard,
    resolvedDatabaseApi
      ? createDatabaseDashboardSettingsStore(resolvedDatabaseApi)
      : undefined,
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
  const coreServices = [
    databaseService,
    authService,
    websiteService,
    storageService,
    ...pluginServices,
  ].filter(
    (service): service is ZelavisService<any> => Boolean(service),
  );
  const websiteEnabled = hasWebsiteService || Boolean(websiteService);
  const servicesForDashboard = [
    ...(hasDashboardService || options.coreServices?.dashboard === false
      ? []
      : [
          {
            name: "dashboard",
            basePath: "/",
            service: {},
            api: { v1: [] },
          },
        ]),
    ...coreServices,
    ...services,
  ];
  const dashboardService = hasDashboardService
    ? undefined
    : await resolveDashboardCoreService(options.coreServices?.dashboard, {
        apiPrefix,
        apiVersion,
        pluginRegistry,
        pluginRegistryStore,
        pluginImporter: options.plugins?.importer,
        pluginPackageInstaller: options.pluginPackageInstaller,
        pluginActivation: options.pluginActivation,
        rootPath,
        services: servicesForDashboard,
        settingsStore: dashboardSettingsStore,
        websiteEnabled,
      });
  // Pull the dashboard's host-side `_app` binding (bundle store + shell
  // renderer) and synthesize a sibling `dashboard:app` service that
  // serves the bundle. Strip `_app` off the visible service so consumers
  // see the clean `ZelavisService` shape.
  const dashboardAppService = dashboardService
    ? await synthesizeDashboardAppService(dashboardService)
    : undefined;
  const sanitizedDashboardService = dashboardService
    ? stripDashboardHostBinding(dashboardService)
    : undefined;
  // Mount the HTTP-01 challenge responder when a domain-binding store
  // is configured. The endpoint serves `verificationToken` back to
  // requesters who hit `<host>/.well-known/zelavis-challenge/<token>`,
  // making automatic verification a no-op for the operator once they
  // point their DNS at this zelavis instance.
  const domainChallengeService = options.domainBindings
    ? createDomainChallengeService(options.domainBindings)
    : undefined;
  const finalServices = [
    sanitizedDashboardService,
    dashboardAppService,
    domainChallengeService,
    ...coreServices,
    ...services,
  ].filter(
    (service): service is ZelavisService<any> => Boolean(service),
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
    "services",
    "coreServices",
    "pluginContext",
    "servicePrefixes",
    "pathOverrides",
  ].filter((key) => raw[key] !== undefined);

  if (forbiddenKeys.length === 0) {
    return;
  }

  throw new TypeError(
    `new Zelavis(...) does not accept internal runtime options (${forbiddenKeys.join(", ")}). Use zelavis(...) for low-level service composition.`,
  );
}

function assertNoReservedPluginServiceNames(
  services: readonly ZelavisService<any>[],
): void {
  const reserved = services
    .map((service) => service.name)
    .filter((name) => RESERVED_CORE_SERVICE_NAMES.has(name));

  if (reserved.length === 0) {
    return;
  }

  throw new TypeError(
    `Plugins cannot register reserved core service names: ${reserved.join(", ")}.`,
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
    website: mergeMaybeRecord(base.website, override.website),
  };
}

function mergeZelavisServerOptions(
  base: ZelavisServerOptions,
  override: ZelavisServerOptions,
): ZelavisServerOptions {
  const pluginEntries = [
    ...(base.plugins?.entries ?? []),
    ...(override.plugins?.entries ?? []),
  ];
  const pluginStore = override.plugins?.store ?? base.plugins?.store;
  const pluginImporter = override.plugins?.importer ?? base.plugins?.importer;
  const pluginContext = {
    ...(base.pluginContext ?? {}),
    ...(override.pluginContext ?? {}),
  };

  return {
    ...base,
    ...override,
    api: {
      ...(base.api ?? {}),
      ...(override.api ?? {}),
    },
    services: [...(base.services ?? []), ...(override.services ?? [])],
    pluginPackageInstaller:
      override.pluginPackageInstaller ?? base.pluginPackageInstaller,
    pluginActivation: override.pluginActivation ?? base.pluginActivation,
    plugins:
      pluginEntries.length > 0 || pluginStore || pluginImporter
        ? {
            ...(pluginEntries.length > 0 ? { entries: pluginEntries } : {}),
            ...(pluginStore ? { store: pluginStore } : {}),
            ...(pluginImporter ? { importer: pluginImporter } : {}),
          }
        : undefined,
    pluginContext:
      Object.keys(pluginContext).length > 0 ? pluginContext : undefined,
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
  const nextPlugins: ZelavisPluginRegistryOptions = {
    ...(options.plugins ?? {}),
  };
  const databaseConfigured =
    nextCoreServices.database !== undefined && nextCoreServices.database !== false;

  if (nextCoreServices.dashboard !== false) {
    const currentDashboard =
      nextCoreServices.dashboard === true || nextCoreServices.dashboard === undefined
        ? {}
        : nextCoreServices.dashboard;

    if (!currentDashboard.settingsStore) {
      const settingsStore = resources.kv
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

  if (!nextPlugins.store) {
    nextPlugins.store = resources.kv
      ? createKeyValuePluginRegistryStore(resources.kv)
      : resources.files
        ? createFileStoragePluginRegistryStore(resources.files)
        : undefined;
  }

  return {
    ...options,
    plugins: nextPlugins,
    coreServices: nextCoreServices,
  };
}

export class Zelavis {
  private readonly options: ZelavisOptions;
  private readonly pluginRegistryStore = createMemoryPluginRegistryStore([]);
  private runtimePromise?: Promise<ZelavisServerRuntime<unknown>>;
  private resolvedPlatformContext: ZelavisPlatformContext = {
    presets: [],
    resources: {},
    metadata: {},
  };

  constructor(options: ZelavisOptions = {}) {
    assertNoInternalConstructorOptions(options);
    this.options = options;
  }

  get platform(): ZelavisPlatformContext {
    return this.resolvedPlatformContext;
  }

  private invalidateRuntime() {
    this.runtimePromise = undefined;
  }

  async runtime(): Promise<ZelavisServerRuntime<unknown>> {
    this.runtimePromise ??= (async () => {
      const resolved = await resolvePlatformState(this.options);
      const platformResources: ZelavisPlatformResources = {
        ...resolved.context.resources,
        plugins:
          resolved.context.resources.plugins ??
          {
            mode: "runtime",
            capabilities: {
              strategy: "runtime-graph",
              supportsRuntimeInstall: true,
              supportsUploadedSpecifiers: true,
              supportsPackageUploads: Boolean(
                resolved.context.resources.pluginPackages,
              ),
              supportsIsolatedExecution: false,
              description:
                "Recomposes the in-process Zelavis runtime graph after plugin registry changes.",
            },
            activate: async () => {
              this.invalidateRuntime();
              return {
                status: "active",
                message:
                  "Plugin registry state changed. Zelavis will recompose the runtime for the next request.",
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
      const plugins = {
        ...(serverOptions.plugins ?? {}),
        store: serverOptions.plugins?.store ?? this.pluginRegistryStore,
      };
      // Default bundle store: wrap the adapter's file storage when present.
      // Explicit user-provided `bundleStore` always wins. Without either,
      // plugin `app` routes fall back to 404 — see ZelavisServerOptions.
      const bundleStore =
        serverOptions.bundleStore ??
        (platformResources.files
          ? createSharedBundleStore({ storage: platformResources.files })
          : undefined);
      // Domain bindings: explicit option wins, then fall through to
      // the adapter-supplied resource. No on-the-fly default — leaving
      // both unset means workspace plugins get no host-bound routing,
      // which is the safe default.
      const domainBindings =
        serverOptions.domainBindings ?? platformResources.domainBindings;
      const runtime = await zelavis(
        {
          ...serverOptions,
          plugins,
          pluginPackageInstaller: platformResources.pluginPackages,
          pluginActivation: platformResources.plugins,
          bundleStore,
          domainBindings,
          pluginContext: {
            ...resolved.serverOptions.pluginContext,
            platform: createPluginSetupPlatformContext(
              this.resolvedPlatformContext,
            ),
          },
        },
      );
      return runtime;
    })();

    return this.runtimePromise;
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
