import { join, resolve } from "node:path";
import { createBetterSqlite3DatabaseDriver } from "../app/db/adapters/node-sqlite.js";
import {
  createShardedDatabaseDriver,
} from "../app/db/topology/index.js";
import {
  defineAdapter,
  type ZelavisOptions,
  type ZelavisResolvedPlatformOptions,
  type ZelavisServiceRegistryEntry,
  type ZelavisServiceSetupContext,
} from "../index.js";
import { createLocalSqliteSystemStore } from "./_sqlite-system-store.js";
import { resolveLocalDatabaseTopology } from "./_database-topology-store.js";
import {
  createLocalProjectRuntime,
  type LocalProjectRuntimeOptions,
} from "./_local-project-runtime.js";
import {
  createLocalFileStorage,
  createMemoryKeyValueStore,
} from "./_shared.js";
import {
  normalizeDataDirectory,
  createLocalFrontendDirectoryResolver,
  createLocalRuntimeServicePackageInstaller,
  createLocalRuntimeServiceImporter,
  createLocalRuntimeServiceManifestResolver,
  type LocalRuntimeServiceOptions,
} from "./_local-runtime.js";
import { officialProjectRecipes } from "../project-recipes.js";
import { migrateLegacyAppDatabase } from "./_legacy-app-database-migration.js";
import { createBuiltinDeploymentBackends } from "../backends/index.js";
export {
  createNodeFileArtifactStore,
  type NodeFileArtifactStoreOptions,
} from "./_node-artifact-store.js";

export interface NodeAdapterDatabaseOptions {
  directory?: string;
  logicalDatabaseId?: string;
  virtualShardCount?: number;
  physicalShardCount?: number;
  readonly?: boolean;
  fileMustExist?: boolean;
  pragma?: readonly string[];
}

export type NodeAdapterServiceOptions = LocalRuntimeServiceOptions & {
  catalog?: readonly ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>[];
};

export interface NodeAdapterSystemStoreOptions {
  filename?: string;
}

export interface NodeAdapterProjectOptions {
  directory?: string;
  startupTimeoutMs?: number;
  startupConcurrency?: number;
  shutdownConcurrency?: number;
  logLimit?: number;
  wordpress?: {
    startupTimeoutMs?: number;
  };
}

export interface NodeAdapterOptions {
  role?: "platform" | "project";
  dataDirectory?: string;
  database?: false | NodeAdapterDatabaseOptions;
  systemStore?: false | NodeAdapterSystemStoreOptions;
  projects?: false | NodeAdapterProjectOptions;
  services?: false | NodeAdapterServiceOptions;
  files?: false | {
    rootDirectory?: string;
  };
  kv?: false | {
    kind?: "memory";
  };
}

export const createNodeServicePackageInstaller = createLocalRuntimeServicePackageInstaller;
export const createNodeServiceImporter = createLocalRuntimeServiceImporter;

export function nodeAdapter(options: NodeAdapterOptions = {}) {
  let projectRuntime: ReturnType<typeof createLocalProjectRuntime> | undefined;

  return defineAdapter({
    name: "node",
    async resolve(
      _constructorOptions: ZelavisOptions,
    ): Promise<ZelavisResolvedPlatformOptions> {
      const dataDirectory = normalizeDataDirectory(options.dataDirectory);
      const isProjectRuntime = options.role === "project";
      const databaseOptions =
        options.database ?? (isProjectRuntime ? {} : false);
      const nextCoreServices: Record<string, unknown> = isProjectRuntime
        ? { dashboard: false, fabric: false }
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
          : createLocalSqliteSystemStore({ filename: systemStoreFilename });

      if (databaseOptions !== false) {
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
            createBetterSqlite3DatabaseDriver({
              filename: join(shardDirectory, `${shard.id}.sqlite`),
              readonly: databaseOptions.readonly,
              fileMustExist: databaseOptions.fileMustExist,
              pragma: databaseOptions.pragma,
            }),
          ]),
        );
        const shardedDriver = createShardedDatabaseDriver({
          topology,
          physicalDrivers,
        });
        if (
          isProjectRuntime &&
          databaseOptions.directory === undefined &&
          !databaseOptions.readonly
        ) {
          await migrateLegacyAppDatabase({
            legacyFilename: join(dataDirectory, "zelavis.sqlite"),
            systemStore,
            targetDriver: shardedDriver,
            physicalDrivers,
            openLegacyDriver: (filename) =>
              createBetterSqlite3DatabaseDriver({
                filename,
                fileMustExist: true,
              }),
            tenantAliases: { default: "zelavis-app" },
          });
        }
        nextCoreServices.database = {
          nodeId: "local",
          driver: shardedDriver,
        };
      }

      const serviceOptions = options.services === false ? undefined : options.services;
      const serviceDirectory = join(dataDirectory, "services");
      const normalizedProjectOptions =
        options.projects === false ? undefined : options.projects;
      const projectsEnabled =
        options.projects !== false &&
        (!isProjectRuntime || normalizedProjectOptions !== undefined);
      const projectOptions = projectsEnabled ? normalizedProjectOptions : undefined;
      if (projectsEnabled && !projectRuntime) {
        const runtimeOptions: LocalProjectRuntimeOptions = {
          directory: projectOptions?.directory
            ? resolve(projectOptions.directory)
            : join(dataDirectory, "projects"),
          ...(projectOptions?.startupTimeoutMs === undefined
            ? {}
            : { startupTimeoutMs: projectOptions.startupTimeoutMs }),
          ...(projectOptions?.startupConcurrency === undefined
            ? {}
            : { startupConcurrency: projectOptions.startupConcurrency }),
          ...(projectOptions?.shutdownConcurrency === undefined
            ? {}
            : { shutdownConcurrency: projectOptions.shutdownConcurrency }),
          ...(projectOptions?.logLimit === undefined
            ? {}
            : { logLimit: projectOptions.logLimit }),
          ...(projectOptions?.wordpress === undefined
            ? {}
            : { wordpress: projectOptions.wordpress }),
          // Without this a frontend Project cannot start at all: the driver
          // refuses rather than falling through to the Zelavis runner and
          // failing in a way that looks like a broken frontend.
          serverFrontend: {
            // The same directory the package installer writes to. Resolving
            // against anything else would look for installed packages where
            // none are.
            resolveFrontendDirectory: createLocalFrontendDirectoryResolver({
              directory: serviceDirectory,
              ...(serviceOptions ?? {}),
            }),
          },
        };
        projectRuntime = createLocalProjectRuntime(runtimeOptions);
      }
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
          projectRuntime: projectsEnabled ? projectRuntime : undefined,
          deploymentBackends: isProjectRuntime
            ? undefined
            : createBuiltinDeploymentBackends({
                nativeProjectRuntime: projectsEnabled ? projectRuntime : undefined,
              }),
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
          runtime: "node",
          role: isProjectRuntime ? "project" : "platform",
          ...(systemStore
            ? { systemStore: systemStoreFilename }
            : {}),
          ...(projectRuntime ? { projectRuntime: projectRuntime.name } : {}),
        },
      };
    },
  });
}
