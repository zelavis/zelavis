import { acquireLocalDataOwnership, type LocalOwnershipLease } from "./_local-ownership.js";
import { join, resolve } from "node:path";
import { installAsyncPluginContextStorage } from "./_async-plugin-context.js";
import {
  defineAdapter,
  type ZelavisOptions,
  type ZelavisResolvedPlatformOptions,
} from "../index.js";
import { createBunSqliteSystemStore } from "./_bun-sqlite-system-store.js";
import { createLocalFileStorage, createMemoryKeyValueStore } from "./_shared.js";
import {
  normalizeDataDirectory,
  createLocalServiceSources,
  type LocalServiceSourceOptions,
} from "./_local-runtime.js";

export interface BunAdapterDatabaseOptions {
  /** Directory holding one SQLite file per shard. */
  directory?: string;
  /** Adopted only the first time a Project opens; the stored map wins afterwards. */
  shards?: readonly string[];
  virtualRanges?: number;
}

export interface BunAdapterFileStorageOptions {
  rootDirectory?: string;
}

export interface BunAdapterKeyValueOptions {
  kind?: "memory";
}

export type BunAdapterServiceOptions = LocalServiceSourceOptions;

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
  installAsyncPluginContextStorage();
  let ownership: Promise<LocalOwnershipLease> | undefined;
  let ownerOptions: ZelavisOptions | undefined;
  const stores = new Set<{ close?(): void | Promise<void> }>();
  return defineAdapter({
    name: "bun",
    async close(requester) {
      if (requester && ownerOptions && requester !== ownerOptions) return;
      await Promise.all([...stores].map((store) => store.close?.()));
      stores.clear();
      const lease = await ownership?.catch(() => undefined);
      await lease?.release();
      ownership = undefined;
      ownerOptions = undefined;
    },
    async resolve(
      _constructorOptions: ZelavisOptions,
    ): Promise<ZelavisResolvedPlatformOptions> {
      const dataDirectory = normalizeDataDirectory(options.dataDirectory);
      const isProjectRuntime = options.role === "project";
      if (!isProjectRuntime && options.systemStore !== false) {
        if (ownerOptions && ownerOptions !== _constructorOptions) throw new Error("This adapter already owns a Platform; close it before creating another.");
        ownerOptions = _constructorOptions;
        ownership ??= acquireLocalDataOwnership(dataDirectory);
        await ownership;
      }
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
      if (systemStore) stores.add(systemStore);

      if (databaseOptions !== false) {
        // One store implementation over SQLite. Bun has no `node:sqlite`, so the
        // engine binds `bun:sqlite` there; the file format is the same.
        nextSubsystems.database = {
          directory: databaseOptions.directory
            ? resolve(databaseOptions.directory)
            : join(dataDirectory, "data", "primary", "shards"),
          nodeId: "local",
          ...(databaseOptions.shards ? { shards: databaseOptions.shards } : {}),
          ...(databaseOptions.virtualRanges === undefined
            ? {}
            : { virtualRanges: databaseOptions.virtualRanges }),
        };
      }

      const fileStorage =
        options.files === false
          ? undefined
          : createLocalFileStorage(
              options.files?.rootDirectory
                ? resolve(options.files.rootDirectory)
                : join(dataDirectory, "files"),
            );
      // The same sources the Node adapter serves: the official catalog, the
      // runtime's own services folder, installed packages and folder frontends.
      const serviceSources = await createLocalServiceSources({
        dataDirectory,
        services: options.services,
        isProjectRuntime,
        fileStorage,
        systemStore,
      });

      return {
        subsystems: nextSubsystems,
        role: isProjectRuntime ? "project" : "platform",
        ...(serviceSources.bundleStore ? { bundleStore: serviceSources.bundleStore } : {}),
        serviceRegistry: serviceSources.serviceRegistry,
        resources: {
          systemStore,
          kv: options.kv === false ? undefined : createMemoryKeyValueStore(),
          files: fileStorage,
          servicePackages: serviceSources.servicePackages,
          ...(serviceSources.marketplace ? { marketplace: serviceSources.marketplace.control } : {}),
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
