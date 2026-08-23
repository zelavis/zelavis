import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defineAdapter,
  type ZelavisOptions,
  type ZelavisResolvedPlatformOptions,
  type ZelavisServiceRegistryEntry,
} from "../index.js";
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

export interface BunAdapterSystemStoreOptions {
  filename?: string;
}

export interface BunAdapterOptions {
  role?: "platform" | "project";
  dataDirectory?: string;
  database?: false | BunAdapterDatabaseOptions;
  systemStore?: false | BunAdapterSystemStoreOptions;
  files?: false | BunAdapterFileStorageOptions;
  kv?: false | BunAdapterKeyValueOptions;
  services?: false | BunAdapterServiceOptions;
}

function defaultOfficialAppServiceEntries(): readonly ZelavisServiceRegistryEntry[] {
  return [
    {
      service: {
        name: "@zelavis/app",
        version: "1.0.1-alpha.2",
        kind: "app",
        marketplace: {
          title: "Zelavis App",
          summary:
            "The official Zelavis-native project backend with database, auth, and workloads.",
          categories: ["apps", "official"],
          tags: ["backend", "database", "auth", "workloads"],
        },
      },
      specifier: fileURLToPath(new URL("../../services/zelavis-app/index.js", import.meta.url)),
      status: "available",
      source: "official",
      order: 0,
    },
  ];
}

export function bunAdapter(options: BunAdapterOptions = {}) {
  return defineAdapter({
    name: "bun",
    async resolve(
      _constructorOptions: ZelavisOptions,
    ): Promise<ZelavisResolvedPlatformOptions> {
      const dataDirectory = normalizeDataDirectory(options.dataDirectory);
      const isProjectRuntime = options.role === "project";
      const databaseOptions =
        options.database ?? (isProjectRuntime ? {} : false);
      const nextCoreServices: Record<string, unknown> = isProjectRuntime
        ? { dashboard: false }
        : {
            database: false,
            website: false,
            storage: false,
            workloads: false,
          };

      if (databaseOptions !== false) {
        const { createBunSqliteDatabaseDriver } = await import(
          "@zelavis/db-bun-sqlite"
        );
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
        : join(
            dataDirectory,
            isProjectRuntime ? "runtime" : "system",
            "zelavis.sqlite",
          );
      const systemStore =
        options.systemStore === false
          ? undefined
          : await createBunSqliteSystemStore({ filename: systemStoreFilename });
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
                entries: isProjectRuntime ? [] : defaultOfficialAppServiceEntries(),
                importer: createLocalRuntimeServiceImporter({
                  directory: serviceDirectory,
                  ...(serviceOptions ?? {}),
                }),
              },
        resources: {
          systemStore,
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
          role: isProjectRuntime ? "project" : "platform",
          ...(systemStore
            ? { systemStore: systemStoreFilename }
            : {}),
        },
      };
    },
  });
}
