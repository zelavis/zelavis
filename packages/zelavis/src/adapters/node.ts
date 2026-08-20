import { join, resolve } from "node:path";
import { createBetterSqlite3DatabaseDriver } from "@zelavis/db-node-sqlite";
import {
  defineAdapter,
  type ZelavisOptions,
  type ZelavisServiceLoadOptions,
  type ZelavisServicePackageInstaller,
  type ZelavisResolvedPlatformOptions,
} from "../index.js";
import { loadLocalBlueprintRegistry } from "./_local-blueprints.js";
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

export interface NodeAdapterBlueprintOptions {
  directory?: string;
  cacheDirectory?: string;
}

export interface NodeAdapterSystemStoreOptions {
  filename?: string;
}

export interface NodeAdapterProjectOptions {
  directory?: string;
  startupTimeoutMs?: number;
  logLimit?: number;
}

export interface NodeAdapterOptions {
  dataDirectory?: string;
  database?: false | NodeAdapterDatabaseOptions;
  blueprints?: false | NodeAdapterBlueprintOptions;
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
  let projectRuntime: ReturnType<typeof createNodeProcessProjectRuntime> | undefined;

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
          : createLocalSqliteSystemStore({ filename: systemStoreFilename });
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
      const projectOptions = options.projects === false ? undefined : options.projects;
      if (options.projects !== false && !projectRuntime) {
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
                importer: createLocalRuntimeServiceImporter({
                  directory: serviceDirectory,
                  ...(serviceOptions ?? {}),
                }),
              },
        resources: {
          systemStore,
          blueprints,
          projectRuntime: options.projects === false ? undefined : projectRuntime,
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
          ...(systemStore
            ? { systemStore: systemStoreFilename }
            : {}),
          ...(projectRuntime ? { projectRuntime: projectRuntime.name } : {}),
        },
      };
    },
  });
}
