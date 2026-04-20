import {
  authService as createAuthService,
  type AuthServiceOptions,
} from "@zelavis/auth";
import {
  dashboardService as createDashboardService,
  type DashboardServiceOptions,
} from "@zelavis/dashboard";
import {
  createDatabase,
  createDatabaseServerService,
  type CreateDatabaseOptions,
  type DatabaseApi,
} from "@zelavis/database";
import {
  zelavisServer as mountZelavisServer,
  type ZelavisAnyServiceInput,
  type ZelavisServerIntegration,
  type ZelavisServerErrorHandler,
  type ZelavisServerRuntime,
  type ZelavisServerService,
} from "@zelavis/server";

export * from "@zelavis/database";
export * from "@zelavis/server";

export type ZelavisAuthCoreServiceOptions = boolean | AuthServiceOptions;
export type ZelavisDashboardCoreServiceOptions = boolean | DashboardServiceOptions;

export type ZelavisDatabaseCoreServiceOptions =
  | boolean
  | CreateDatabaseOptions
  | DatabaseApi
  | Promise<DatabaseApi>;

export interface ZelavisCoreServicesOptions {
  auth?: ZelavisAuthCoreServiceOptions;
  dashboard?: ZelavisDashboardCoreServiceOptions;
  database?: ZelavisDatabaseCoreServiceOptions;
}

export interface ZelavisApiOptions {
  prefix?: string;
  version?: string;
}

export interface ZelavisServerOptions<TResult = unknown>
  {
  rootPath?: string;
  api?: ZelavisApiOptions;
  services?: readonly ZelavisAnyServiceInput[];
  coreServices?: ZelavisCoreServicesOptions;
  integration: ZelavisServerIntegration<unknown, TResult>;
  servicePrefixes?: Record<string, string>;
  pathOverrides?: Record<string, string>;
  onError?: ZelavisServerErrorHandler;
}

function normalizePathPart(part: string | undefined): string {
  if (!part) {
    return "";
  }

  const trimmed = part.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  return trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
}

function normalizePath(path: string | undefined, fallback: string): string {
  const normalized = normalizePathPart(path);
  return normalized ? `/${normalized}` : fallback;
}

function joinPathParts(...parts: (string | undefined)[]): string {
  const normalized = parts.map(normalizePathPart).filter(Boolean);
  return normalized.length > 0 ? `/${normalized.join("/")}` : "/";
}

function isDatabaseApi(value: unknown): value is DatabaseApi {
  return Boolean(
    value &&
      typeof value === "object" &&
      "documents" in value &&
      "driver" in value &&
      "capabilities" in value,
  );
}

async function resolveDatabaseCoreService(
  option: ZelavisDatabaseCoreServiceOptions | undefined,
): Promise<ZelavisServerService<any> | undefined> {
  const databaseOption = option ?? true;

  if (databaseOption === false) {
    return undefined;
  }

  if (databaseOption === true) {
    return createDatabaseServerService(await createDatabase());
  }

  const resolvedDatabaseOption = await databaseOption;
  const database = isDatabaseApi(resolvedDatabaseOption)
    ? resolvedDatabaseOption
    : await createDatabase(resolvedDatabaseOption);

  return createDatabaseServerService(database);
}

async function resolveAuthCoreService(
  option: ZelavisAuthCoreServiceOptions | undefined,
): Promise<ZelavisServerService<any> | undefined> {
  const authOption = option ?? true;

  if (authOption === false) {
    return undefined;
  }

  return createAuthService(authOption === true ? {} : authOption);
}

async function resolveDashboardCoreService(
  option: ZelavisDashboardCoreServiceOptions | undefined,
  rootPath: string,
): Promise<ZelavisServerService<any> | undefined> {
  const dashboardOption = option ?? true;

  if (dashboardOption === false) {
    return undefined;
  }

  const options = dashboardOption === true ? {} : dashboardOption;
  return createDashboardService({
    ...options,
    basePath: "/",
    assetPath: options.assetPath ?? joinPathParts(rootPath, "assets/dashboard.css"),
  });
}

function createServicePrefixes(
  services: readonly ZelavisServerService<any>[],
  options: {
    apiPrefix: string;
    apiVersion: string;
    overrides?: Record<string, string>;
  },
): Record<string, string> {
  const prefixes: Record<string, string> = {};

  for (const service of services) {
    prefixes[service.name] =
      service.name === "dashboard"
        ? "/"
        : joinPathParts(options.apiPrefix, options.apiVersion, service.name);
  }

  return {
    ...prefixes,
    ...options.overrides,
  };
}

export async function zelavisServer<TResult = unknown>(
  options: ZelavisServerOptions<TResult>,
): Promise<ZelavisServerRuntime<unknown, TResult>> {
  const rootPath = normalizePath(options.rootPath, "/zelavis");
  const apiPrefix = normalizePath(options.api?.prefix, "/api");
  const apiVersion = normalizePathPart(options.api?.version ?? "v1");
  const services = await Promise.all(options.services ?? []);
  const hasAuthService = services.some((service) => service.name === "auth");
  const hasDashboardService = services.some((service) => service.name === "dashboard");
  const hasDatabaseService = services.some((service) => service.name === "database");
  const dashboardService = hasDashboardService
    ? undefined
    : await resolveDashboardCoreService(options.coreServices?.dashboard, rootPath);
  const authService = hasAuthService
    ? undefined
    : await resolveAuthCoreService(options.coreServices?.auth);
  const databaseService = hasDatabaseService
    ? undefined
    : await resolveDatabaseCoreService(options.coreServices?.database);
  const coreServices = [databaseService, authService].filter(
    (service): service is ZelavisServerService<any> => Boolean(service),
  );
  const finalServices = [dashboardService, ...coreServices, ...services].filter(
    (service): service is ZelavisServerService<any> => Boolean(service),
  );

  return mountZelavisServer({
    ...options,
    prefix: rootPath,
    version: "v1",
    services: finalServices,
    servicePrefixes: createServicePrefixes(finalServices, {
      apiPrefix,
      apiVersion,
      overrides: options.servicePrefixes,
    }),
  });
}
