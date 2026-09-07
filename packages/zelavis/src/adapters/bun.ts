import { join, resolve } from "node:path";
import {
  defineAdapter,
  type ZelavisOptions,
  type ZelavisResolvedPlatformOptions,
  type ZelavisServiceRegistryEntry,
  type ZelavisServiceSetupContext,
} from "../index.js";
import {
  createShardedDatabaseDriver,
} from "../app/db/topology/index.js";
import { createBunSqliteSystemStore } from "./_bun-sqlite-system-store.js";
import { resolveLocalDatabaseTopology } from "./_database-topology-store.js";
import { createLocalFileStorage, createMemoryKeyValueStore } from "./_shared.js";
import {
  normalizeDataDirectory,
  createLocalRuntimeServicePackageInstaller,
  createLocalRuntimeServiceImporter,
  createLocalRuntimeServiceManifestResolver,
  type LocalRuntimeServiceOptions,
} from "./_local-runtime.js";
import { officialProjectRecipes } from "../project-recipes.js";

export interface BunAdapterDatabaseOptions {
  directory?: string;
  logicalDatabaseId?: string;
  virtualShardCount?: number;
  physicalShardCount?: number;
  readonly?: boolean;
  create?: boolean;
}

export interface BunAdapterFileStorageOptions {
  rootDirectory?: string;
}

export interface BunAdapterKeyValueOptions {
  kind?: "memory";
}

export type BunAdapterServiceOptions = LocalRuntimeServiceOptions & {
  catalog?: readonly ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>[];
};

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
      const nextSubsystems: Record<string, unknown> = isProjectRuntime
        ? { fabric: false }
        : {
            database: false,
            // The frontend service stays on for the Platform: with the
            // dashboard enabled it makes `/` lead there instead of returning a
            // 404 that reads as a broken installation.
            storage: false,
            workloads: false,
          };

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

      if (databaseOptions !== false) {
        const { createBunSqliteDatabaseDriver } = await import(
          "../app/db/adapters/bun-sqlite.js"
        );
        const topology = await resolveLocalDatabaseTopology({
          systemStore,
          logicalDatabaseId: databaseOptions.logicalDatabaseId,
          nodeId: "local",
          engine: "sqlite",
          virtualShardCount: databaseOptions.virtualShardCount,
          physicalShardCount: databaseOptions.physicalShardCount,
        });
        const shardDirectory = databaseOptions.directory
          ? resolve(databaseOptions.directory)
          : join(dataDirectory, "data", "primary", "shards");
        const physicalDrivers = new Map(
          topology.desired.physicalShards.map((shard) => [
            shard.id,
            createBunSqliteDatabaseDriver({
              filename: join(shardDirectory, `${shard.id}.sqlite`),
              readonly: databaseOptions.readonly,
              create: databaseOptions.create,
            }),
          ]),
        );
        const shardedDriver = createShardedDatabaseDriver({
          topology,
          physicalDrivers,
        });
        nextSubsystems.database = {
          nodeId: "local",
          driver: shardedDriver,
        };
      }

      const serviceOptions = options.services === false ? undefined : options.services;
      const serviceDirectory = join(dataDirectory, "services");
      const fileStorage =
        options.files === false
          ? undefined
          : createLocalFileStorage(
              options.files?.rootDirectory
                ? resolve(options.files.rootDirectory)
                : join(dataDirectory, "files"),
            );

      return {
        subsystems: nextSubsystems,
        role: isProjectRuntime ? "project" : "platform",
        serviceRegistry:
          options.services === false
            ? undefined
            : {
                catalog: isProjectRuntime
                  ? []
                  : [
                      ...officialProjectRecipes,
                      ...(serviceOptions?.catalog ?? []),
                    ],
                importer: createLocalRuntimeServiceImporter({
                  directory: serviceDirectory,
                  ...(serviceOptions ?? {}),
                }),
                // Supplied per runtime rather than installed process-globally,
                // so two embedded runtimes cannot affect each other.
                manifestResolver: createLocalRuntimeServiceManifestResolver(),
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
