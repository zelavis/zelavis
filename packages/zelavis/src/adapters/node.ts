import {
  existsSync,
  readFileSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createBetterSqlite3DatabaseDriver } from "@zelavis/db-node-sqlite";
import {
  createFileStoragePluginRegistryStore,
  defineAdapter,
  type ZelavisDashboardSettingsStore,
  type ZelavisDashboardSettingsUpdate,
  type ZelavisDashboardThemeMode,
  type ZelavisOptions,
  type ZelavisPluginLoadOptions,
  type ZelavisPluginPackageInstaller,
  type ZelavisResolvedPlatformOptions,
} from "../index.js";
import {
  createLocalFileStorage,
  createMemoryKeyValueStore,
} from "./_shared.js";
import {
  normalizeDataDirectory,
  createLocalRuntimePluginPackageInstaller,
  createLocalRuntimePluginImporter,
  type LocalRuntimePluginOptions,
} from "./_local-runtime.js";

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

function isDashboardThemeMode(
  value: unknown,
): value is ZelavisDashboardThemeMode {
  return value === "light" || value === "dark" || value === "auto";
}

export function createFileDashboardSettingsStore(
  filePath = ".zelavis/dashboard-settings.json",
): ZelavisDashboardSettingsStore {
  const resolvedPath = resolve(filePath);

  function read(): ZelavisDashboardSettingsUpdate {
    if (!existsSync(resolvedPath)) {
      return {};
    }

    const parsed = JSON.parse(readFileSync(resolvedPath, "utf8")) as Record<
      string,
      unknown
    >;
    const settings: ZelavisDashboardSettingsUpdate = {};

    if (typeof parsed.rootPath === "string") {
      settings.rootPath = normalizeEditableRootPath(parsed.rootPath);
    }

    if (isDashboardThemeMode(parsed.theme)) {
      settings.theme = parsed.theme;
    }

    if (typeof parsed.pageBuilderEnabled === "boolean") {
      settings.pageBuilderEnabled = parsed.pageBuilderEnabled;
    }

    return settings;
  }

  function write(update: ZelavisDashboardSettingsUpdate) {
    const next = {
      ...read(),
      ...update,
    };
    const temporaryPath = `${resolvedPath}.tmp`;

    mkdirSync(dirname(resolvedPath), { recursive: true });
    writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(temporaryPath, resolvedPath);

    return next;
  }

  return {
    read,
    write,
  };
}

export interface NodeAdapterDatabaseOptions {
  filename?: string;
  readonly?: boolean;
  fileMustExist?: boolean;
  defaultTenantId?: string;
  pragma?: readonly string[];
}

export interface NodeAdapterDashboardOptions {
  settingsFile?: string;
}

export type NodeAdapterPluginOptions = LocalRuntimePluginOptions;

export interface NodeAdapterOptions {
  dataDirectory?: string;
  database?: false | NodeAdapterDatabaseOptions;
  dashboard?: false | NodeAdapterDashboardOptions;
  plugins?: false | NodeAdapterPluginOptions;
  files?: false | {
    rootDirectory?: string;
  };
  kv?: false | {
    kind?: "memory";
  };
}

// Back-compat exports so existing code importing from node.ts still works.
export const createNodePluginPackageInstaller = createLocalRuntimePluginPackageInstaller;
export const createNodePluginImporter = createLocalRuntimePluginImporter;

export function nodeAdapter(options: NodeAdapterOptions = {}) {
  return defineAdapter({
    name: "node",
    async resolve(
      _constructorOptions: ZelavisOptions,
    ): Promise<ZelavisResolvedPlatformOptions> {
      const dataDirectory = normalizeDataDirectory(options.dataDirectory);
      const nextCoreServices: Record<string, unknown> = {};

      if (options.database !== false) {
        const databaseOptions = options.database ?? {};
        nextCoreServices.database = {
          defaultTenantId: databaseOptions.defaultTenantId,
          driver: createBetterSqlite3DatabaseDriver({
            filename: databaseOptions.filename
              ? resolve(databaseOptions.filename)
              : join(dataDirectory, "zelavis.sqlite"),
            readonly: databaseOptions.readonly,
            fileMustExist: databaseOptions.fileMustExist,
            defaultTenantId: databaseOptions.defaultTenantId,
            pragma: databaseOptions.pragma,
          }),
        };
      }

      if (options.dashboard !== false) {
        const dashboardOptions = options.dashboard ?? {};
        nextCoreServices.dashboard = {
          settingsStore: createFileDashboardSettingsStore(
            dashboardOptions.settingsFile
              ? resolve(dashboardOptions.settingsFile)
              : join(dataDirectory, "dashboard-settings.json"),
          ),
        };
      }

      const pluginOptions = options.plugins === false ? undefined : options.plugins;
      const pluginDirectory = join(dataDirectory, "plugins");
      const fileStorage =
        options.files === false
          ? undefined
          : createLocalFileStorage(
              options.files?.rootDirectory
                ? resolve(options.files.rootDirectory)
                : join(dataDirectory, "files"),
            );

      return {
        coreServices: nextCoreServices,
        plugins:
          options.plugins === false
            ? undefined
            : {
                importer: createLocalRuntimePluginImporter({
                  directory: pluginDirectory,
                  ...(pluginOptions ?? {}),
                }),
                ...(fileStorage
                  ? { store: createFileStoragePluginRegistryStore(fileStorage) }
                  : {}),
              },
        resources: {
          kv: options.kv === false ? undefined : createMemoryKeyValueStore(),
          files: fileStorage,
          pluginPackages:
            options.plugins === false
              ? undefined
              : createLocalRuntimePluginPackageInstaller({
                  directory: pluginDirectory,
                  ...(pluginOptions ?? {}),
                }),
        },
        metadata: {
          runtime: "node",
        },
      };
    },
  });
}
