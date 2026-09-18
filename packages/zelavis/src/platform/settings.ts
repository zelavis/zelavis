/**
 * Dashboard settings and service-registry persistence.
 *
 * Parsing and merging stored preferences, and the store implementations that
 * back them — in memory, over a key-value resource, over the System Store, and
 * over file storage. Split out of the Platform composition so the persisted
 * shapes and their validation can be read in one place.
 */
import type {
  ZelavisFileStorage,
  ZelavisFileStorageScope,
} from "./storage-types.js";
import {
  isBoolean,
  isRuntimeEngine,
  normalizeEditableRootPath,
  readBodyObject,
  toSystemStoreValue,
  ZelavisValidationError,
  ZelavisConflictError,
  type ZelavisKeyValueStore,
  type ZelavisRuntimeEngine,
} from "./shared.js";
import type {
  ZelavisServiceRegistryStateEntry,
  ZelavisServiceRegistryStore,
  ZelavisServiceRegistrySnapshot,
} from "../service.js";
import type { ZelavisSystemStore } from "../system-store.js";
import type {
  ZelavisServiceRegistryOptions,
} from "../index.js";
import {
  requireFileStorageGuarantees, invalidateFileStorageGuarantees,
  ZelavisStorageConditionError, ZelavisStorageGuaranteeError,
} from "../storage/conditions.js";
const DEFAULT_PLATFORM_DASHBOARD_SETTINGS_KEY =
  "zelavis/dashboard-settings.json";


const DEFAULT_PLATFORM_SERVICE_REGISTRY_KEY = "zelavis/services.json";
const SYSTEM_STORE_DASHBOARD_NAMESPACE = "dashboard";
const SYSTEM_STORE_DASHBOARD_SETTINGS_KEY = "settings";
const SYSTEM_STORE_SERVICES_NAMESPACE = "services";
const SYSTEM_STORE_SERVICE_REGISTRY_KEY = "registry";


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
  runtimeEngine: {
    current: ZelavisRuntimeEngine;
    desired: ZelavisRuntimeEngine;
    available: readonly ZelavisRuntimeEngine[];
    restartRequired: boolean;
  };
  theme: ZelavisDashboardThemeMode;
  pageBuilderEnabled: boolean;
  preferences: ZelavisDashboardPreferences;
  persistence: "runtime" | "read-only";
  editable: {
    rootPath: boolean;
    runtimeEngine: boolean;
    theme: boolean;
    pageBuilder: boolean;
  };
  restartRequired: boolean;
}

export interface ZelavisDashboardSettingsUpdate {
  rootPath?: string;
  runtimeEngine?: ZelavisRuntimeEngine;
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

export function parseStoredDashboardSettingsUpdate(
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

  if ("runtimeEngine" in input) {
    if (!isRuntimeEngine(input.runtimeEngine)) {
      throw new ZelavisValidationError(
        'Stored runtime engine must be one of "node", "bun", or "deno".',
      );
    }

    update.runtimeEngine = input.runtimeEngine;
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

export function parseStoredServiceRegistryStateEntry(
  value: unknown,
): ZelavisServiceRegistryStateEntry {
  const input = readBodyObject(value);
  const name = typeof input.name === "string" ? input.name.trim() : "";

  if (!name) {
    throw new ZelavisValidationError(
      "Stored service registry entries must include a service name.",
    );
  }

  const entry: ZelavisServiceRegistryStateEntry = { ...input, name };

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

export function parseStoredServiceRegistryState(
  value: unknown,
): ZelavisServiceRegistryStateEntry[] {
  const input = readBodyObject(value);

  if (!("services" in input)) {
    throw new ZelavisValidationError("Stored service registry is missing services; refusing an ambiguous overwrite.");
  }

  if (!Array.isArray(input.services)) {
    throw new ZelavisValidationError(
      "Stored service registry state must be an array.",
    );
  }

  const entries = input.services.map((entry) => parseStoredServiceRegistryStateEntry(entry));
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) {
    throw new ZelavisValidationError("Stored service registry has duplicate service names.");
  }
  return entries;
}

export function mergeDashboardPreferences(
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

export function mergeDashboardSettingsUpdate(
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

export function createMemoryDashboardSettingsStore(): ZelavisDashboardSettingsStore {
  let settings: ZelavisDashboardSettingsUpdate = {};

  return {
    read: () => settings,
    write(update) {
      settings = mergeDashboardSettingsUpdate(settings, update);

      return settings;
    },
  };
}

/** Apply an intent again only after a clean conflict and a fresh read. */
export async function mutateServiceRegistry(
  store: ZelavisServiceRegistryStore,
  mutation: (entries: readonly ZelavisServiceRegistryStateEntry[]) =>
    readonly ZelavisServiceRegistryStateEntry[] | Promise<readonly ZelavisServiceRegistryStateEntry[]>,
): Promise<readonly ZelavisServiceRegistryStateEntry[]> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const snapshot = await store.readSnapshot();
    const entries = await mutation(snapshot.entries);
    if (await store.compareAndSet(snapshot.revision, entries)) return entries;
  }
  throw new ZelavisConflictError("Service registry changed during all 8 mutation attempts; retry the request.");
}

export function createMemoryServiceRegistryStore(
  initialEntries: readonly ZelavisServiceRegistryStateEntry[],
): ZelavisServiceRegistryStore {
  let entries = structuredClone([...initialEntries]);
  let revision = crypto.randomUUID();
  return {
    read: () => structuredClone(entries),
    readSnapshot: () => ({ entries: structuredClone(entries), revision }),
    compareAndSet(expected, next) {
      if (expected !== revision) return false;
      entries = structuredClone(parseStoredServiceRegistryState({ services: next }));
      revision = crypto.randomUUID();
      return true;
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

export function createKeyValueServiceRegistryStore(
  store: ZelavisKeyValueStore,
  key = DEFAULT_PLATFORM_SERVICE_REGISTRY_KEY,
): ZelavisServiceRegistryStore {
  return {
    async read() { return (await this.readSnapshot()).entries; },
    async readSnapshot() {
      const value = await store.get(key);
      return { entries: value === undefined ? [] : parseStoredServiceRegistryState(JSON.parse(value)), revision: value ?? null };
    },
    compareAndSet() {
      throw new ZelavisStorageGuaranteeError("Key-value storage has no atomic conditional write contract; service registry is read-only. Use a System Store or qualified file storage.");
    },
  };
}

function registryDocument(value: unknown, entries: readonly ZelavisServiceRegistryStateEntry[]) {
  return {
    ...(value === undefined ? {} : readBodyObject(value)),
    kind: "service-registry",
    // Content etags may repeat. A fresh nonce makes cooperative registry writes
    // distinct even for A -> B -> A, including recreation by this adapter.
    revision: crypto.randomUUID(),
    services: parseStoredServiceRegistryState({ services: entries }),
  };
}

export function createSystemStoreServiceRegistryStore(
  store: ZelavisSystemStore,
): ZelavisServiceRegistryStore {
  const read = () => store.get(SYSTEM_STORE_SERVICES_NAMESPACE, SYSTEM_STORE_SERVICE_REGISTRY_KEY);
  // Carry both the CAS token and the stored value: repeated timestamps after
  // deletion/recreation must not silently match a caller's earlier snapshot.
  const revisionOf = (record: NonNullable<Awaited<ReturnType<typeof read>>>) =>
    JSON.stringify([record.updatedAt, record.value]);
  return {
    async read() { return (await this.readSnapshot()).entries; },
    async readSnapshot() {
      const record = await read();
      return { entries: record ? parseStoredServiceRegistryState(record.value) : [], revision: record ? revisionOf(record) : null };
    },
    async compareAndSet(revision, entries) {
      const current = await read();
      if ((current ? revisionOf(current) : null) !== revision) return false;
      const value = toSystemStoreValue(registryDocument(current?.value, entries));
      if (!current) return (await store.setIfAbsent(SYSTEM_STORE_SERVICES_NAMESPACE, SYSTEM_STORE_SERVICE_REGISTRY_KEY, value)).created;
      return Boolean(await store.compareAndSet(SYSTEM_STORE_SERVICES_NAMESPACE, SYSTEM_STORE_SERVICE_REGISTRY_KEY, current.updatedAt, value, current.value));
    },
  };
}

export function createFileStorageServiceRegistryStore(
  storage: ZelavisFileStorage,
  path = DEFAULT_PLATFORM_SERVICE_REGISTRY_KEY,
  options: { scope?: ZelavisFileStorageScope } = {},
): ZelavisServiceRegistryStore {
  const scope = options.scope ?? "distributed";
  const decode = (body: Uint8Array) => JSON.parse(new TextDecoder().decode(body)) as unknown;
  const read = async () => {
    await requireFileStorageGuarantees(storage, scope);
    const file = await storage.get(path);
    if (file && !file.etag) throw new ZelavisStorageGuaranteeError("Service registry storage returned no etag; refusing mutation.");
    return file;
  };
  const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); } catch (error) {
      if (!(error instanceof ZelavisStorageConditionError)) invalidateFileStorageGuarantees(storage);
      throw error;
    }
  };
  return {
    async read() { return (await this.readSnapshot()).entries; },
    readSnapshot() {
      return guarded(async (): Promise<ZelavisServiceRegistrySnapshot> => {
        const file = await read();
        return { entries: file ? parseStoredServiceRegistryState(decode(file.body)) : [], revision: file?.etag ?? null };
      });
    },
    compareAndSet(revision, entries) {
      return guarded(async () => {
        const file = await read();
        if ((file?.etag ?? null) !== revision) return false;
        const previous = file ? decode(file.body) : undefined;
        if (previous !== undefined) parseStoredServiceRegistryState(previous);
        try {
          const written = await storage.put({
            path,
            body: JSON.stringify(registryDocument(previous, entries), null, 2),
            contentType: "application/json; charset=utf-8",
            condition: revision === null ? { ifAbsent: true } : { ifMatch: revision },
          });
          if (!written.etag || written.etag === revision) {
            throw new ZelavisStorageGuaranteeError("Registry write returned no fresh etag; outcome is unknown.");
          }
          return true;
        } catch (error) {
          if (error instanceof ZelavisStorageConditionError) return false;
          throw error;
        }
      });
    },
  };
}

/**
 * Resolves where Platform runtime settings persist.
 *
 * The store used to be reached through the dashboard option, which tied the
 * Platform's own settings persistence to whether it had a face. It is a
 * resource; an installation serving no frontend still has settings.
 */
export function resolveRuntimeSettingsStore(
  configured: ZelavisDashboardSettingsStore | undefined,
  fallbackStore?: ZelavisDashboardSettingsStore,
): ZelavisDashboardSettingsStore {
  return configured ?? fallbackStore ?? createMemoryDashboardSettingsStore();
}

export function resolveServiceRegistryStore(
  option: ZelavisServiceRegistryOptions | undefined,
  fallbackStore: ZelavisServiceRegistryStore,
): ZelavisServiceRegistryStore {
  return option?.store ?? fallbackStore;
}

export async function readInitialServiceRegistryState(
  store: ZelavisServiceRegistryStore,
): Promise<readonly ZelavisServiceRegistryStateEntry[] | undefined> {
  // An outage or malformed persisted registry is not an empty installation.
  return await store.read();
}

export function readDashboardSettingsUpdate(
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
      .replace(/^Stored dashboard root path/, "Root path")
      .replace(/^Stored runtime engine/, "Runtime engine");

    throw new ZelavisValidationError(
      normalizedMessage.charAt(0).toUpperCase() + normalizedMessage.slice(1),
    );
  }
}

export function isDashboardThemeMode(
  value: unknown,
): value is ZelavisDashboardThemeMode {
  return value === "light" || value === "dark" || value === "auto";
}
