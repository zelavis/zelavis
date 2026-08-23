import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBetterSqlite3DatabaseDriver } from "@zelavis/db-node-sqlite";
import {
  defineAdapter,
  type ZelavisOptions,
  type ZelavisServiceLoadOptions,
  type ZelavisServicePackageInstaller,
  type ZelavisResolvedPlatformOptions,
  type ZelavisServiceRegistryEntry,
} from "../index.js";
import { createLocalSqliteSystemStore } from "./_sqlite-system-store.js";
import {
  createNodeProcessProjectRuntime,
  type NodeProcessProjectRuntimeOptions,
} from "./_node-project-runtime.js";
import {
  createLocalFileStorage,
  createMemoryKeyValueStore,
} from "./_shared.js";
import {
  normalizeDataDirectory,
  createLocalRuntimeServicePackageInstaller,
  createLocalRuntimeServiceImporter,
  type LocalRuntimeServiceOptions,
} from "./_local-runtime.js";

export interface NodeAdapterDatabaseOptions {
  filename?: string;
  readonly?: boolean;
  fileMustExist?: boolean;
  defaultTenantId?: string;
  pragma?: readonly string[];
}

export type NodeAdapterServiceOptions = LocalRuntimeServiceOptions;

export interface NodeAdapterSystemStoreOptions {
  filename?: string;
}

export interface NodeAdapterProjectOptions {
  directory?: string;
  startupTimeoutMs?: number;
  logLimit?: number;
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

export function nodeAdapter(options: NodeAdapterOptions = {}) {
  let projectRuntime: ReturnType<typeof createNodeProcessProjectRuntime> | undefined;

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
        ? { dashboard: false }
        : {
            database: false,
            website: false,
            storage: false,
            workloads: false,
          };

      if (databaseOptions !== false) {
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
          : createLocalSqliteSystemStore({ filename: systemStoreFilename });
      const normalizedProjectOptions =
        options.projects === false ? undefined : options.projects;
      const projectsEnabled =
        options.projects !== false &&
        (!isProjectRuntime || normalizedProjectOptions !== undefined);
      const projectOptions = projectsEnabled ? normalizedProjectOptions : undefined;
      if (projectsEnabled && !projectRuntime) {
        const runtimeOptions: NodeProcessProjectRuntimeOptions = {
          directory: projectOptions?.directory
            ? resolve(projectOptions.directory)
            : join(dataDirectory, "projects"),
          ...(projectOptions?.startupTimeoutMs === undefined
            ? {}
            : { startupTimeoutMs: projectOptions.startupTimeoutMs }),
          ...(projectOptions?.logLimit === undefined
            ? {}
            : { logLimit: projectOptions.logLimit }),
        };
        projectRuntime = createNodeProcessProjectRuntime(runtimeOptions);
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
          projectRuntime: projectsEnabled ? projectRuntime : undefined,
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
