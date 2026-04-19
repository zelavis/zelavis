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
} from "@zelavis/server";

export { authService } from "@zelavis/auth";
export type { AuthServiceOptions } from "@zelavis/auth";
export * from "@zelavis/database";
export * from "@zelavis/server";

export type ZelavisDatabaseCoreServiceOptions =
  | boolean
  | CreateDatabaseOptions
  | DatabaseApi
  | Promise<DatabaseApi>;

export interface ZelavisCoreServicesOptions {
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
): Promise<ZelavisAnyServiceInput | undefined> {
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

export async function zelavisServer<TResult = unknown>(
  options: ZelavisServerOptions<TResult>,
): Promise<ZelavisServerRuntime<unknown, TResult>> {
  const services = await Promise.all(options.services ?? []);
  const hasDatabaseService = services.some((service) => service.name === "database");
  const databaseService = hasDatabaseService
    ? undefined
    : await resolveDatabaseCoreService(options.coreServices?.database);

  return mountZelavisServer({
    ...options,
    services: databaseService ? [databaseService, ...services] : services,
  });
}
