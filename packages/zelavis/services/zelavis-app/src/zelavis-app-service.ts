import {
  authService,
  type AuthProviderService,
  type AuthServiceOptions,
} from "./auth/index.js";
import {
  createDatabase,
  defineDatabaseService,
  type CreateDatabaseOptions,
  type DatabaseApi,
} from "./db/index.js";
import {
  defineService,
  type ZelavisAnyRuntimeServiceInput,
  type ZelavisServiceSetupContext,
} from "@zelavis/server";
import {
  workloadsService,
  type WorkloadsServiceOptions,
} from "./workloads/index.js";

export interface ZelavisAppServiceOptions {
  database?: CreateDatabaseOptions | DatabaseApi;
  auth?: false | AuthServiceOptions;
  workloads?: false | WorkloadsServiceOptions;
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

function collectAuthProviderServices(
  children: readonly Readonly<{ name: string; setup?: unknown }>[],
): readonly AuthProviderService[] {
  return Object.freeze(
    children
      .filter((service) => typeof service.setup === "function")
      .map((service) => service as unknown as AuthProviderService),
  );
}

async function resolveDatabase(
  context: ZelavisServiceSetupContext,
  option: ZelavisAppServiceOptions["database"],
) {
  if (isDatabaseApi(option)) {
    return option;
  }

  if (isDatabaseApi(context.core.database)) {
    return context.core.database;
  }

  return createDatabase(option);
}

export function zelavisAppService(options: ZelavisAppServiceOptions = {}) {
  return defineService<ZelavisServiceSetupContext>({
    name: "@zelavis/app",
    version: "1.0.1-alpha.2",
    kind: "app",
    capabilities: ["app:project", "dashboard:menu", "api:routes"],
    service: Object.freeze({}),
    marketplace: {
      title: "Zelavis App",
      summary:
        "The official Zelavis-native project backend with database, auth, and workloads.",
      categories: ["apps", "official"],
      tags: ["backend", "database", "auth", "workloads"],
    },
    menu: {
      title: "Overview",
      path: "/",
      pageLabel: "Project",
      sectionLabel: "Overview",
      surface: "root",
      access: {
        permissions: ["project.view"],
        scope: { type: "project", projectIdParam: "projectId" },
      },
    },
    async setup(context) {
      const runtimeServices: ZelavisAnyRuntimeServiceInput[] = [];
      const database = await resolveDatabase(context, options.database);
      runtimeServices.push(defineDatabaseService(database));

      if (options.auth !== false) {
        const authOptions =
          options.auth === undefined ? {} : options.auth;
        const childServices = context.children.map((service) => service.name);
        runtimeServices.push(
          authService({
            ...authOptions,
            services: [
              ...(authOptions.services ?? []),
              ...collectAuthProviderServices(context.children),
            ],
            childServices: [
              ...(authOptions.childServices ?? []),
              ...childServices,
            ],
          }),
        );
      }

      if (options.workloads !== false) {
        runtimeServices.push(
          workloadsService(
            options.workloads === undefined ? {} : options.workloads,
          ),
        );
      }

      return { runtimeServices };
    },
  });
}

export const zelavisApp = zelavisAppService();
export default zelavisApp;
