import { join, resolve } from "node:path";
import {
  createPlatform,
  type ZelavisOptions,
  type ZelavisPlatformPreset,
  type ZelavisResolvedPlatformOptions,
} from "../index.js";
import { createFileDashboardSettingsStore } from "../adapters/node.js";
import { createLocalFileStorage, createMemoryKeyValueStore } from "./_shared.js";

export interface BunPlatformDatabaseOptions {
  filename?: string;
  readonly?: boolean;
  create?: boolean;
  defaultTenantId?: string;
}

export interface BunPlatformDashboardOptions {
  settingsFile?: string;
}

export interface BunPlatformFileStorageOptions {
  rootDirectory?: string;
}

export interface BunPlatformKeyValueOptions {
  kind?: "memory";
}

export interface BunPlatformOptions {
  dataDirectory?: string;
  database?: false | BunPlatformDatabaseOptions;
  dashboard?: false | BunPlatformDashboardOptions;
  files?: false | BunPlatformFileStorageOptions;
  kv?: false | BunPlatformKeyValueOptions;
}

function normalizeDataDirectory(path: string | undefined): string {
  return resolve(path?.trim() ? path : ".zelavis");
}

export function bunPlatform(
  options: BunPlatformOptions = {},
): ZelavisPlatformPreset {
  return createPlatform({
    name: "bun",
    async resolve(
      _constructorOptions: ZelavisOptions<any>,
    ): Promise<ZelavisResolvedPlatformOptions> {
      const dataDirectory = normalizeDataDirectory(options.dataDirectory);
      const nextCoreServices: Record<string, unknown> = {};

      if (options.database !== false) {
        const { createBunSqliteDatabaseDriver } = await import(
          "@zelavis/database-bun-sqlite"
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

      return {
        coreServices: nextCoreServices,
        resources: {
          kv:
            options.kv === false
              ? undefined
              : createMemoryKeyValueStore(),
          files:
            options.files === false
              ? undefined
              : createLocalFileStorage(
                  options.files?.rootDirectory
                    ? resolve(options.files.rootDirectory)
                    : join(dataDirectory, "files"),
                ),
        },
        metadata: {
          runtime: "bun",
        },
      };
    },
  });
}
