import { join, resolve } from "node:path";
import { createBetterSqlite3DatabaseDriver } from "@zelavis/database-node-sqlite";
import {
  defineAdapter,
  type ZelavisOptions,
  type ZelavisResolvedPlatformOptions,
} from "../index.js";
import { createFileDashboardSettingsStore } from "../adapters/node.js";
import { createLocalFileStorage, createMemoryKeyValueStore } from "./_shared.js";

export interface NodePlatformDatabaseOptions {
  filename?: string;
  readonly?: boolean;
  fileMustExist?: boolean;
  defaultTenantId?: string;
  pragma?: readonly string[];
}

export interface NodePlatformDashboardOptions {
  settingsFile?: string;
}

export interface NodePlatformOptions {
  dataDirectory?: string;
  database?: false | NodePlatformDatabaseOptions;
  dashboard?: false | NodePlatformDashboardOptions;
  files?: false | {
    rootDirectory?: string;
  };
  kv?: false | {
    kind?: "memory";
  };
}

function normalizeDataDirectory(path: string | undefined): string {
  return resolve(path?.trim() ? path : ".zelavis");
}

export function nodePlatform(options: NodePlatformOptions = {}) {
  return defineAdapter({
    name: "node",
    platform: async (
      _constructorOptions: ZelavisOptions<any>,
    ): Promise<ZelavisResolvedPlatformOptions> => {
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
          runtime: "node",
        },
      };
    },
  });
}
