import { join, resolve } from "node:path";
import { createBetterSqlite3DatabaseDriver } from "@zelavis/database-node-sqlite";
import {
  createPlatform,
  type ZelavisConstructorOptions,
  type ZelavisPlatformPreset,
  type ZelavisResolvedPlatformOptions,
} from "../index.js";
import { createFileDashboardSettingsStore } from "../adapters/node.js";

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
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDataDirectory(path: string | undefined): string {
  return resolve(path?.trim() ? path : ".zelavis");
}

function shouldConfigureDatabase(
  options: ZelavisConstructorOptions<any>,
): boolean {
  return options.coreServices?.database !== false;
}

function shouldConfigureDashboard(
  options: ZelavisConstructorOptions<any>,
): boolean {
  return options.coreServices?.dashboard !== false;
}

function mergeDatabaseCoreService(
  existing: ZelavisConstructorOptions<any>["coreServices"] extends infer _T
    ? unknown
    : never,
  next: Record<string, unknown>,
) {
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

function mergeDashboardCoreService(
  existing: ZelavisConstructorOptions<any>["coreServices"] extends infer _T
    ? unknown
    : never,
  next: Record<string, unknown>,
) {
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

export function nodePlatform(
  options: NodePlatformOptions = {},
): ZelavisPlatformPreset {
  return createPlatform({
    name: "node",
    async resolve(
      constructorOptions: ZelavisConstructorOptions<any>,
    ): Promise<ZelavisResolvedPlatformOptions> {
      const dataDirectory = normalizeDataDirectory(options.dataDirectory);
      const nextCoreServices: Record<string, unknown> = {};

      if (shouldConfigureDatabase(constructorOptions) && options.database !== false) {
        const databaseOptions = options.database ?? {};
        nextCoreServices.database = mergeDatabaseCoreService(
          constructorOptions.coreServices?.database,
          {
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
          },
        );
      }

      if (
        shouldConfigureDashboard(constructorOptions) &&
        options.dashboard !== false
      ) {
        const dashboardOptions = options.dashboard ?? {};
        nextCoreServices.dashboard = mergeDashboardCoreService(
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
      };
    },
  });
}
