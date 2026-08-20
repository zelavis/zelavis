import { join, resolve } from "node:path";
import {
  defineAdapter,
  type ZelavisOptions,
  type ZelavisResolvedPlatformOptions,
} from "../index.js";
import { loadLocalBlueprintRegistry } from "./_local-blueprints.js";
import { createBunSqliteSystemStore } from "./_bun-sqlite-system-store.js";
import { createLocalFileStorage, createMemoryKeyValueStore } from "./_shared.js";
import {
  normalizeDataDirectory,
  createLocalRuntimeServicePackageInstaller,
  createLocalRuntimeServiceImporter,
  type LocalRuntimeServiceOptions,
} from "./_local-runtime.js";

export interface BunAdapterDatabaseOptions {
  filename?: string;
  readonly?: boolean;
  create?: boolean;
  defaultTenantId?: string;
}

export interface BunAdapterFileStorageOptions {
  rootDirectory?: string;
}

export interface BunAdapterKeyValueOptions {
  kind?: "memory";
}

export type BunAdapterServiceOptions = LocalRuntimeServiceOptions;
export interface BunAdapterBlueprintOptions {
  directory?: string;
  cacheDirectory?: string;
}

export interface BunAdapterSystemStoreOptions {
  filename?: string;
}

export interface BunAdapterOptions {
  dataDirectory?: string;
  database?: false | BunAdapterDatabaseOptions;
  blueprints?: false | BunAdapterBlueprintOptions;
  systemStore?: false | BunAdapterSystemStoreOptions;
  files?: false | BunAdapterFileStorageOptions;
  kv?: false | BunAdapterKeyValueOptions;
  services?: false | BunAdapterServiceOptions;
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

      const serviceOptions = options.services === false ? undefined : options.services;
      const serviceDirectory = join(dataDirectory, "services");
      const systemStoreOptions =
        options.systemStore === false ? undefined : options.systemStore;
      const systemStoreFilename = systemStoreOptions?.filename
        ? resolve(systemStoreOptions.filename)
        : join(dataDirectory, "system", "zelavis.sqlite");
      const systemStore =
        options.systemStore === false
          ? undefined
          : await createBunSqliteSystemStore({ filename: systemStoreFilename });
      const blueprints =
        options.blueprints === false
          ? undefined
          : await loadLocalBlueprintRegistry({
              ...(options.blueprints?.directory
                ? { directory: resolve(options.blueprints.directory) }
                : {}),
              cacheDirectory: options.blueprints?.cacheDirectory
                ? resolve(options.blueprints.cacheDirectory)
                : join(dataDirectory, "blueprints"),
            });
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
        services:
          options.services === false
            ? undefined
            : {
                importer: createLocalRuntimeServiceImporter({
                  directory: serviceDirectory,
                  ...(serviceOptions ?? {}),
                }),
              },
        resources: {
          systemStore,
          blueprints,
          kv: options.kv === false ? undefined : createMemoryKeyValueStore(),
          files: fileStorage,
          servicePackages:
            options.services === false
              ? undefined
              : createLocalRuntimeServicePackageInstaller({
                  directory: serviceDirectory,
                  ...(serviceOptions ?? {}),
                }),
        },
        metadata: {
          runtime: "bun",
          ...(systemStore
            ? { systemStore: systemStoreFilename }
            : {}),
        },
      };
    },
  });
}
