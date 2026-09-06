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
import { createAgentProcessClient } from "./_agent-ipc.js";
import { createLocalAgentProcessRunner } from "./_agent-process-runner.js";
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
  discoverProductServices,
  PRODUCT_SERVICES_DIRECTORY,
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
  /**
   * Run Project processes through a separately supervised Agent.
   *
   * The directory holding its socket and token — what `zelavis agent` created.
   * Omit it and Projects run in the Platform process, which is the default and
   * needs nothing supervised alongside it.
   *
   * Note what this does not yet buy: a Platform restart still stops nothing and
   * adopts nothing. The Agent keeps the processes running, but the new Platform
   * has no handles to them, so it reclaims them and starts fresh.
   */
  agentEndpoint?: string;
}

export interface NodeAdapterOptions {
  role?: "platform" | "project";
  dataDirectory?: string;
  /**
   * Services dropped into a folder on this server.
   *
   * Defaults to `<dataDirectory>/product-services`. Set to `false` to scan
   * nothing, which is what an installation composing every service itself
   * wants.
   */
  productServices?: false | { directory?: string };
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
        nextSubsystems.database = {
          nodeId: "local",
          driver: shardedDriver,
        };
      }

      const serviceOptions = options.services === false ? undefined : options.services;
      const serviceDirectory = join(dataDirectory, "services");
      const productServiceOptions =
        options.productServices === false ? undefined : options.productServices;
      const productServiceDirectory = productServiceOptions?.directory
        ? resolve(productServiceOptions.directory)
        : join(dataDirectory, PRODUCT_SERVICES_DIRECTORY);
      // Scanned before composition so the Platform sees dropped-in services the
      // same way it sees installed ones. A Project runtime deliberately skips
      // it: the folder belongs to the installation, not to each Project.
      const discoveredProductServices =
        options.services === false ||
        options.productServices === false ||
        isProjectRuntime
          ? []
          : await discoverProductServices({
              directory: productServiceDirectory,
              onSkipped: (name, reason) => {
                // Reported rather than swallowed: a package that silently fails
                // to load looks identical to one nobody installed.
                console.warn(
                  `Zelavis skipped product service "${name}": ${reason}`,
                );
              },
            });
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
        // The Agent is resolved here rather than left to the driver so the
        // sweep below can run: the adapter's `resolve` is async, and a driver
        // constructor is not.
        runtimeOptions.agent = projectOptions?.agentEndpoint
          ? // Fails rather than falling back to in-process execution: a host
            // that asked for a supervised Agent and silently got Projects
            // inside the Platform has the opposite of what it configured, and
            // would only find out when the Platform next died.
            await createAgentProcessClient({
              directory: resolve(projectOptions.agentEndpoint),
            })
          : createLocalAgentProcessRunner({
              stateDirectory: join(runtimeOptions.directory, ".agent-processes"),
            });

        projectRuntime = createLocalProjectRuntime(runtimeOptions);

        // Order matters. Adopt first, so a Project the Agent is still running
        // is taken over rather than killed; reclaim second, so what is left
        // afterwards is what nothing can drive. Reclaiming first would stop
        // every Project on the host and then start them again, which is the
        // opposite of what running the Agent separately is for.
        await projectRuntime.adopt?.().catch(() => undefined);

        // What remains is unowned: processes from a crashed Platform that no
        // driver claimed. Reconciliation would reclaim the Projects it
        // restarts, but a Project the operator has since stopped is never
        // started again — and so would never be reclaimed at all.
        await runtimeOptions.agent.reclaim?.().catch(() => undefined);
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
                discovered: discoveredProductServices,
                importer: createLocalRuntimeServiceImporter({
                  directory: serviceDirectory,
                  ...(serviceOptions ?? {}),
                  managedDirectories: [
                    productServiceDirectory,
                    ...(serviceOptions?.managedDirectories ?? []),
                  ],
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
