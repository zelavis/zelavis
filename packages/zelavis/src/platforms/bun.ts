import { join, resolve } from "node:path";
import {
  createPlatform,
  type ZelavisConstructorOptions,
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDataDirectory(path: string | undefined): string {
  return resolve(path?.trim() ? path : ".zelavis");
}

function mergeExisting(
  existing: unknown,
  next: Record<string, unknown>,
): unknown {
  if (existing === undefined || existing === true) {
    return next;
  }

  if (isObject(existing)) {
    return {
      ...next,
      ...existing,
    };
  }

  return existing;
}

export function bunPlatform(
  options: BunPlatformOptions = {},
): ZelavisPlatformPreset {
  return createPlatform({
    name: "bun",
    async resolve(
      constructorOptions: ZelavisConstructorOptions<any>,
    ): Promise<ZelavisResolvedPlatformOptions> {
      const dataDirectory = normalizeDataDirectory(options.dataDirectory);
      const nextCoreServices: Record<string, unknown> = {};

      if (
        constructorOptions.coreServices?.database !== false &&
        options.database !== false
      ) {
        const { createBunSqliteDatabaseDriver } = await import(
          "@zelavis/database-bun-sqlite"
        );
        const databaseOptions = options.database ?? {};
        nextCoreServices.database = mergeExisting(
          constructorOptions.coreServices?.database,
          {
            defaultTenantId: databaseOptions.defaultTenantId,
            driver: createBunSqliteDatabaseDriver({
              filename: databaseOptions.filename
                ? resolve(databaseOptions.filename)
                : join(dataDirectory, "zelavis.sqlite"),
              readonly: databaseOptions.readonly,
              create: databaseOptions.create,
              defaultTenantId: databaseOptions.defaultTenantId,
            }),
          },
        );
      }

      if (
        constructorOptions.coreServices?.dashboard !== false &&
        options.dashboard !== false
      ) {
        const dashboardOptions = options.dashboard ?? {};
        nextCoreServices.dashboard = mergeExisting(
          constructorOptions.coreServices?.dashboard,
          {
            settingsStore: createFileDashboardSettingsStore(
              dashboardOptions.settingsFile
                ? resolve(dashboardOptions.settingsFile)
                : join(dataDirectory, "dashboard-settings.json"),
            ),
          },
        );
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
