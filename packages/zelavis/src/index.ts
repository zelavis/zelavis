import {
  authService as createAuthService,
  AuthDomainError,
  AuthNotFoundError,
  AuthValidationError,
  type AuthServiceOptions,
} from "@zelavis/auth";
import {
  createDatabase,
  createDatabaseServerService,
  DatabaseConflictError,
  DatabaseRevisionMismatchError,
  DatabaseValidationError,
  type CreateDatabaseOptions,
  type DatabaseApi,
  type DatabaseJsonObject,
  DatabaseNotFoundError,
} from "@zelavis/database";
import {
  createMappedJsonErrorResponse,
  defineService,
  zelavisServer as mountZelavisServer,
  type ZelavisServerErrorStatusRule,
  type ZelavisAnyServiceInput,
  type ZelavisServerDispatchHandler,
  type ZelavisServerErrorHandler,
  type ZelavisServerExecutionContext,
  type ZelavisServerFetchHandler,
  type ZelavisServerPlainHandler,
  type ZelavisServerRuntime,
  type ZelavisServerService,
} from "@zelavis/server";
import {
  embeddedDashboardAssets,
  embeddedDashboardShell,
  type EmbeddedDashboardAsset,
} from "./generated/dashboard-assets.js";
import {
  activatePluginRegistry,
  applyPluginRegistryState,
  definePlugin,
  createPluginRegistry,
  serializePluginRegistryState,
  type ZelavisPluginRegistryEntry,
  type ZelavisPluginRegistryStateEntry,
  type ZelavisPluginRegistryStore,
  type ZelavisPluginSetupPlatformContext,
  type ZelavisPluginSetupContext,
} from "./plugin.js";
export * from "./plugin.js";
export * from "./storage/s3.js";

export * from "@zelavis/database";
export {
  defineService,
  type ZelavisAnyServiceInput,
  type ZelavisServerErrorHandler,
  type ZelavisServerRoute,
  type ZelavisServerRuntime,
  type ZelavisServerService,
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
}

export interface ZelavisPluginContextOptions {
  platform?: ZelavisPluginSetupPlatformContext;
}

export interface ZelavisServerOptions {
  rootPath?: string;
  api?: ZelavisApiOptions;
  services?: readonly ZelavisAnyServiceInput[];
  plugins?: ZelavisPluginRegistryOptions;
  pluginContext?: ZelavisPluginContextOptions;
  coreServices?: ZelavisCoreServicesOptions;
  servicePrefixes?: Record<string, string>;
  pathOverrides?: Record<string, string>;
  onError?: ZelavisServerErrorHandler;
}

export interface ZelavisAdapterBinding {
  ready?(): Promise<void> | void;
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

export interface ZelavisPlatformResources {
  kv?: ZelavisKeyValueStore;
  files?: ZelavisFileStorage;
}

export interface ZelavisPlatformContext {
  presets: readonly string[];
  resources: ZelavisPlatformResources;
  metadata: Record<string, unknown>;
}

export interface ZelavisAdapterRuntimeContext {
  getRuntime: () => Promise<ZelavisServerRuntime<unknown>>;
  getPlatform: () => ZelavisPlatformContext;
}

export interface ZelavisAdapterFactory<TAdapter extends object = object> {
  name: string;
  bind(context: ZelavisAdapterRuntimeContext): TAdapter;
}

export interface ZelavisResolvedPlatformOptions
  extends Partial<ZelavisServerOptions> {
  resources?: ZelavisPlatformResources;
  metadata?: Record<string, unknown>;
}

export interface ZelavisPlatformPreset {
  name: string;
  resolve(
    options: ZelavisOptions<any>,
  ):
    | Promise<ZelavisResolvedPlatformOptions>
    | ZelavisResolvedPlatformOptions;
}

export interface ZelavisOptions<TAdapter extends object = object> {
  rootPath?: string;
  api?: ZelavisApiOptions;
  plugins?: ZelavisPluginRegistryOptions;
  onError?: ZelavisServerErrorHandler;
  adapter?: ZelavisAdapterFactory<TAdapter>;
  platform?: ZelavisPlatformPreset | readonly ZelavisPlatformPreset[];
}

export interface ZelavisDatabaseDocumentStoreOptions {
  collection?: string;
  documentId?: string;
}

export function createAdapter<TAdapter extends object>(
  adapter: ZelavisAdapterFactory<TAdapter>,
): ZelavisAdapterFactory<TAdapter> {
  return adapter;
}

export function createPlatform<TPlatform extends ZelavisPlatformPreset>(
  platform: TPlatform,
): TPlatform {
  return platform;
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
  "database",
  "storage",
  "website",
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

function readRequestUrl(request: unknown): string | undefined {
  if (!request || typeof request !== "object") {
    return undefined;
  }

  const candidate =
    "originalUrl" in request && typeof request.originalUrl === "string"
      ? request.originalUrl
      : "url" in request && typeof request.url === "string"
        ? request.url
        : undefined;

  return candidate && candidate.length > 0 ? candidate : undefined;
}

function stripRootPath(pathname: string, rootPath: string): string {
  if (pathname === rootPath) {
    return "/";
  }

  if (pathname.startsWith(`${rootPath}/`)) {
    return pathname.slice(rootPath.length) || "/";
  }

  return pathname || "/";
}

function createDashboardDevRedirect(
  context: {
    query: URLSearchParams;
    request: unknown;
  },
  options: {
    devServerUrl: string;
    rootPath: string;
    fallbackPath: string;
  },
) {
  const requestUrl = readRequestUrl(context.request);
  const parsed = requestUrl
    ? new URL(requestUrl, "http://127.0.0.1")
    : undefined;
  const pathname = stripRootPath(
    parsed?.pathname ?? options.fallbackPath,
    options.rootPath,
  );
  const search =
    parsed?.search ??
    (() => {
      const query = context.query.toString();
      return query ? `?${query}` : "";
    })();

  return {
    status: 307,
    headers: {
      location: `${options.devServerUrl}${pathname}${search}`,
      "cache-control": "no-cache",
    },
  };
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

const defaultDashboardPluginRegistry = createPluginRegistry([
  {
    plugin: definePlugin<ZelavisPluginSetupContext>({
      name: "zelavis-ecommerce",
      version: "0.1.0",
      menu: {
        title: "Ecommerce",
        path: "/commerce",
        pageLabel: "Commerce",
        items: [
          {
            title: "Products",
            path: "/commerce/products",
          },
          {
            title: "Orders",
            path: "/commerce/orders",
          },
          {
            title: "More",
            items: [
              {
                title: "Customers",
                path: "/commerce/customers",
              },
              {
                title: "Coupons",
                path: "/commerce/coupons",
              },
            ],
          },
        ],
      },
      setup(context) {
        return {
          services: [
            defineService({
              name: "commerce",
              service: {
                plugin: context.plugin.name,
              },
              api: {
                v1: [
                  {
                    id: "commerce.health",
                    method: "GET",
                    path: "/health",
                    handler: () => ({
                      status: 200,
                      body: {
                        plugin: context.plugin.name,
                        rootPath: context.rootPath,
                        apiBasePath: context.api.basePath,
                        platform: {
                          presets: context.platform.presets,
                          resources: context.platform.resources,
                        },
                      },
                    }),
                  },
                ],
              },
            }),
          ],
        };
      },
    }),
    status: "available",
    source: "official",
    order: 0,
  },
]);

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
): string {
  const prefix = rootPath === "/" ? "" : rootPath;

  return content
    .replace(
      /\b(href|src|action)="\/(?!\/)([^"]*)"/g,
      (_match, attribute, path) => {
        return `${attribute}="${prefix}/${path}"`;
      },
    )
    .replaceAll('"/assets/', `"${prefix}/assets/`)
    .replaceAll("'/assets/", `'${prefix}/assets/`)
    .replaceAll("`/assets/", `\`${prefix}/assets/`)
    .replaceAll('"assets/', `"${prefix}/assets/`)
    .replaceAll("'assets/", `'${prefix}/assets/`)
    .replaceAll("`assets/", `\`${prefix}/assets/`);
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
): Promise<ZelavisServerService<any> | undefined> {
  const authOption = option ?? true;

  if (authOption === false) {
    return undefined;
  }

  return createAuthService(authOption === true ? {} : authOption);
}

async function resolveDashboardCoreService(
  option: ZelavisDashboardCoreServiceInput | undefined,
  context: {
    apiPrefix: string;
    apiVersion: string;
    pluginRegistry: readonly Readonly<
      ZelavisPluginRegistryEntry<ZelavisPluginSetupContext>
    >[];
    pluginRegistryStore: ZelavisPluginRegistryStore;
    rootPath: string;
    services: readonly ZelavisServerService<any>[];
    settingsStore?: ZelavisDashboardSettingsStore;
    websiteEnabled: boolean;
  },
): Promise<ZelavisServerService<any> | undefined> {
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
  const assets = devServerUrl ? [] : collectDashboardAssets();
  const finalServicesForDashboard = context.services;
  const clientRoutes = [
    ...new Set(
      (options.clientRoutes ?? defaultDashboardClientRoutes)
        .map((route) => normalizePath(route, "/"))
        .filter((route) => route !== "/"),
    ),
  ];
  const readResolvedPluginRegistry = async () =>
    applyPluginRegistryState(
      context.pluginRegistry,
      await context.pluginRegistryStore.read(),
    );
  const createDashboardRuntimeConfig = async () => {
    const pluginRegistry = await readResolvedPluginRegistry();
    const serializedPlugins = pluginRegistry.map((entry) => ({
      name: entry.plugin.name,
      version: entry.plugin.version,
      status: entry.status,
      source: entry.source,
      order: entry.order,
      menu: entry.plugin.menu,
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
    };
  };
  const serializePluginRegistryForDashboard = async () =>
    (await readResolvedPluginRegistry()).map((entry) => ({
      name: entry.plugin.name,
      version: entry.plugin.version,
      status: entry.status,
      source: entry.source,
      order: entry.order,
      menu: entry.plugin.menu,
    }));
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
    ? prefixDashboardAssetReferences(embeddedDashboardShell, rootPath)
    : undefined;
  const shellHandler = async ({
    query,
    request,
  }: {
    query: URLSearchParams;
    request: unknown;
  }) => {
    if (devServerUrl) {
      return createDashboardDevRedirect(
        { query, request },
        {
          devServerUrl,
          rootPath,
          fallbackPath: "/",
        },
      );
    }

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
  const dashboardFallbackHandler = async ({
    params,
    query,
    request,
  }: {
    params: Record<string, string>;
    query: URLSearchParams;
    request: unknown;
  }) => {
    const path = params.path ?? "";

    if (devServerUrl) {
      return createDashboardDevRedirect(
        { query, request },
        {
          devServerUrl,
          rootPath,
          fallbackPath: path ? `/${path}` : "/",
        },
      );
    }

    if (
      path === "api" ||
      path.startsWith("api/") ||
      path === "assets" ||
      path.startsWith("assets/")
    ) {
      return {
        status: 404,
        body: {
          error: "Not found",
        },
      };
    }

    return shellHandler({ query, request });
  };

  return defineService({
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
    },
    api: {
      v1: [
        {
          id: "dashboard.view.overview",
          method: "GET",
          path: "/",
          handler: shellHandler,
        },
        ...clientRoutes.map((route) => ({
          id: `dashboard.view${route.replaceAll("/", ".")}`,
          method: "GET" as const,
          path: route,
          handler: async ({
            query,
            request,
          }: {
            query: URLSearchParams;
            request: unknown;
          }) =>
            devServerUrl
              ? createDashboardDevRedirect(
                  { query, request },
                  {
                    devServerUrl,
                    rootPath,
                    fallbackPath: route,
                  },
                )
              : shellHandler({ query, request }),
        })),
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

              if (!nextRegistry.some((entry) => entry.plugin.name === pluginName)) {
                throw new ZelavisValidationError(
                  `Unknown plugin "${pluginName}".`,
                );
              }

              await context.pluginRegistryStore.write(
                serializePluginRegistryState(nextRegistry),
              );

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
        ...assets.map((asset) => ({
          id: `dashboard.assets${asset.path.replaceAll("/", ".")}`,
          method: "GET" as const,
          path: asset.path,
          handler: () => ({
            status: 200,
            headers: {
              "content-type": asset.contentType,
              "cache-control": asset.cacheControl,
            },
            body: readDashboardAsset(asset, rootPath),
          }),
        })),
        {
          id: "dashboard.view.fallback",
          method: "GET",
          path: "/*path",
          handler: dashboardFallbackHandler,
        },
      ],
    },
  });
}

async function resolveWebsiteCoreService(
  option: ZelavisWebsiteCoreServiceInput | undefined,
  context: {
    rootPath: string;
    apiPrefix: string;
    apiVersion: string;
    pagesStore?: ZelavisWebsitePagesStore;
  },
): Promise<ZelavisServerService<any> | undefined> {
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

  return defineService({
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
  });
}

async function resolveStorageCoreService(
  option: ZelavisStorageCoreServiceInput | undefined,
  context: {
    rootPath: string;
    apiPrefix: string;
    apiVersion: string;
  },
): Promise<ZelavisServerService<any> | undefined> {
  const storageOption = option ?? false;

  if (storageOption === false) {
    return undefined;
  }

  const options = storageOption === true ? {} : storageOption;
  const storage = options.storage;

  if (!storage) {
    return undefined;
  }

  return defineService({
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
  });
}

function createServicePrefixes(
  services: readonly ZelavisServerService<any>[],
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

    if (service.name === "dashboard") {
      prefixes[service.name] = mountAtRoot ? options.rootPath : "/";
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
  const basePluginRegistry = createPluginRegistry(
    options.plugins?.entries ?? defaultDashboardPluginRegistry,
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
    ? createDatabaseServerService(databaseApi)
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
  const pluginRegistry = applyPluginRegistryState(
    basePluginRegistry,
    await readInitialPluginRegistryState(pluginRegistryStore),
  );
  const activatedPlugins = await activatePluginRegistry(pluginRegistry, {
    rootPath,
    api: {
      prefix: apiPrefix,
      version: apiVersion,
      basePath: joinPathParts(rootPath, apiPrefix, apiVersion),
    },
    platform: createPluginSetupPlatformContext(options.pluginContext?.platform),
  });
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
    (service): service is ZelavisServerService<any> => Boolean(service),
  );
  const websiteEnabled = hasWebsiteService || Boolean(websiteService);
  const servicesForDashboard = [
    ...(hasDashboardService || options.coreServices?.dashboard === false
      ? []
      : [
          defineService({
            name: "dashboard",
            basePath: "/",
            service: {},
            api: { v1: [] },
          }),
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
        rootPath,
        services: servicesForDashboard,
        settingsStore: dashboardSettingsStore,
        websiteEnabled,
      });
  const finalServices = [dashboardService, ...coreServices, ...services].filter(
    (service): service is ZelavisServerService<any> => Boolean(service),
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
  options: ZelavisOptions<any>,
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
  services: readonly ZelavisServerService<any>[],
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
    plugins:
      pluginEntries.length > 0 || pluginStore
        ? {
            ...(pluginEntries.length > 0 ? { entries: pluginEntries } : {}),
            ...(pluginStore ? { store: pluginStore } : {}),
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
  options: ZelavisOptions<any>,
): Promise<{
  serverOptions: ZelavisServerOptions;
  context: ZelavisPlatformContext;
}> {
  const platforms = options.platform
    ? Array.isArray(options.platform)
      ? options.platform
      : [options.platform]
    : [];
  let resolved: ZelavisServerOptions = {};
  let resources: ZelavisPlatformResources = {};
  let metadata: Record<string, unknown> = {};
  const presets: string[] = [];

  for (const platform of platforms) {
    const next = await platform.resolve(options);
    presets.push(platform.name);
    resolved = mergeZelavisServerOptions(resolved, next);
    resources = mergePlatformResources(resources, next.resources);
    metadata = mergePlatformMetadata(metadata, next.metadata);
  }

  const { adapter: _adapter, platform: _platform, ...serverOptions } = options;
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

export class Zelavis<TAdapter extends object = {}> {
  readonly adapter: TAdapter;
  private readonly options: ZelavisOptions<TAdapter>;
  private runtimePromise?: Promise<ZelavisServerRuntime<unknown>>;
  private resolvedPlatformContext: ZelavisPlatformContext = {
    presets: [],
    resources: {},
    metadata: {},
  };

  constructor(options: ZelavisOptions<TAdapter> = {}) {
    assertNoInternalConstructorOptions(options);
    this.options = options;
    this.adapter = options.adapter
      ? options.adapter.bind({
          getRuntime: () => this.runtime(),
          getPlatform: () => this.platform,
        })
      : ({} as TAdapter);
  }

  get platform(): ZelavisPlatformContext {
    return this.resolvedPlatformContext;
  }

  async runtime(): Promise<ZelavisServerRuntime<unknown>> {
    this.runtimePromise ??= (async () => {
      const resolved = await resolvePlatformState(this.options);
      this.resolvedPlatformContext = resolved.context;
      const runtime = await zelavis(
        {
          ...applyPlatformResourceDefaults(
            resolved.serverOptions,
            resolved.context.resources,
          ),
          pluginContext: {
            ...resolved.serverOptions.pluginContext,
            platform: createPluginSetupPlatformContext(resolved.context),
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
