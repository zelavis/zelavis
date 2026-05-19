import { join, resolve } from "node:path";
import {
  createFileStoragePluginRegistryStore,
  defineAdapter,
  type ZelavisOptions,
  type ZelavisResolvedPlatformOptions,
} from "../index.js";
import { createFileDashboardSettingsStore } from "./node.js";
import { createLocalFileStorage, createMemoryKeyValueStore } from "./_shared.js";
import {
  normalizeDataDirectory,
  createLocalRuntimePluginPackageInstaller,
  createLocalRuntimePluginImporter,
  type LocalRuntimePluginOptions,
} from "./_local-runtime.js";

export interface BunAdapterDatabaseOptions {
  filename?: string;
  readonly?: boolean;
  create?: boolean;
  defaultTenantId?: string;
}

export interface BunAdapterDashboardOptions {
  settingsFile?: string;
}

export interface BunAdapterFileStorageOptions {
  rootDirectory?: string;
}

export interface BunAdapterKeyValueOptions {
  kind?: "memory";
}

export type BunAdapterPluginOptions = LocalRuntimePluginOptions;

export interface BunAdapterOptions {
  dataDirectory?: string;
  database?: false | BunAdapterDatabaseOptions;
  dashboard?: false | BunAdapterDashboardOptions;
  files?: false | BunAdapterFileStorageOptions;
  kv?: false | BunAdapterKeyValueOptions;
  plugins?: false | BunAdapterPluginOptions;
}

export function bunAdapter(options: BunAdapterOptions = {}) {
  return defineAdapter({
    name: "bun",
    async resolve(
      _constructorOptions: ZelavisOptions,
    ): Promise<ZelavisResolvedPlatformOptions> {
      const dataDirectory = normalizeDataDirectory(options.dataDirectory);
      const nextCoreServices: Record<string, unknown> = {};

      if (options.database !== false) {
        const { createBunSqliteDatabaseDriver } = await import(
          "@zelavis/db-bun-sqlite"
        );
        const databaseOptions = options.database ?? {};
        nextCoreServices.database = {
          defaultTenantId: databaseOptions.defaultTenantId,
          driver: createBunSqliteDatabaseDriver({
            filename: databaseOptions.filename
              ? resolve(databaseOptions.filename)
              : join(dataDirectory, "zelavis.sqlite"),
            readonly: databaseOptions.readonly,
            create: databaseOptions.create,
            defaultTenantId: databaseOptions.defaultTenantId,
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
          runtime: "bun",
        },
      };
    },
  });
}
