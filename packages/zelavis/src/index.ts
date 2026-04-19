import {
  authService as createAuthService,
  type AuthServiceOptions,
} from "@zelavis/auth";
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
  type ZelavisServerMountOptions,
  type ZelavisServerRuntime,
  type ZelavisServerService,
} from "@zelavis/server";

export * from "@zelavis/database";
export * from "@zelavis/server";

export type ZelavisAuthCoreServiceOptions = boolean | AuthServiceOptions;

export type ZelavisDatabaseCoreServiceOptions =
  | boolean
  | CreateDatabaseOptions
  | DatabaseApi
  | Promise<DatabaseApi>;

export interface ZelavisCoreServicesOptions {
  auth?: ZelavisAuthCoreServiceOptions;
  database?: ZelavisDatabaseCoreServiceOptions;
}

export interface ZelavisServerOptions<TResult = unknown>
  extends ZelavisServerMountOptions {
  services?: readonly ZelavisAnyServiceInput[];
  coreServices?: ZelavisCoreServicesOptions;
  integration: ZelavisServerIntegration<unknown, TResult>;
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

export async function zelavisServer<TResult = unknown>(
  options: ZelavisServerOptions<TResult>,
): Promise<ZelavisServerRuntime<unknown, TResult>> {
  const services = await Promise.all(options.services ?? []);
  const hasAuthService = services.some((service) => service.name === "auth");
  const hasDatabaseService = services.some((service) => service.name === "database");
  const authService = hasAuthService
    ? undefined
    : await resolveAuthCoreService(options.coreServices?.auth);
  const databaseService = hasDatabaseService
    ? undefined
    : await resolveDatabaseCoreService(options.coreServices?.database);
  const coreServices = [databaseService, authService].filter(
    (service): service is ZelavisServerService<any> => Boolean(service),
  );

  return mountZelavisServer({
    ...options,
    services: [...coreServices, ...services],
  });
}
