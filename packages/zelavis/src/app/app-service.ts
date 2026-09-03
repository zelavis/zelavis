import { declaresServiceCapability } from "../core/index.js";
import {
  authService,
  createDatabaseAuthRepositories,
  type AuthMethodPlugin,
  type AuthServiceOptions,
} from "./auth/index.js";
import {
  createDatabase,
  defineDatabaseService,
  type CreateDatabaseOptions,
  type DatabaseApi,
} from "./db/index.js";
import {
  type ZelavisAnyRuntimeServiceInput,
} from "../core/index.js";
import type { ZelavisServiceSetupContext } from "../service.js";
import {
  workloadsService,
  type WorkloadsServiceOptions,
} from "./workloads/index.js";
import { ZELAVIS_VERSION } from "../version.js";

export interface ZelavisAppServiceOptions {
  database?: CreateDatabaseOptions | DatabaseApi;
  auth?: false | AuthServiceOptions;
  workloads?: false | WorkloadsServiceOptions;
}

function isDatabaseApi(value: unknown): value is DatabaseApi {
  return Boolean(
    value &&
      typeof value === "object" &&
      "forTenant" in value &&
      "capabilities" in value,
  );
}

function collectAuthMethodPlugins(
  context: ZelavisServiceSetupContext,
): readonly AuthMethodPlugin[] {
  return Object.freeze(
    context.registry
      .filter((entry) =>
        entry.status === "installed" &&
        declaresServiceCapability(
          entry.service.capabilities,
          "zelavis/auth",
          "credentials",
        ) &&
        typeof (entry.service.service as AuthMethodPlugin | undefined)?.register === "function",
      )
      .map((entry) => entry.service.service as AuthMethodPlugin),
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
  return Object.freeze({
    name: "zelavis/app",
    version: ZELAVIS_VERSION,
    kind: "app",
    capabilities: Object.freeze(["app:project", "dashboard:menu", "api:routes"]),
    project: Object.freeze({ runtimeKinds: Object.freeze(["native"] as const) }),
    service: Object.freeze({}),
    api: {},
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
      surface: "root" as const,
      access: {
        permissions: ["project.view"],
        scope: { type: "project" as const, projectIdParam: "projectId" },
      },
    },
    async setup(context: ZelavisServiceSetupContext) {
      const runtimeServices: ZelavisAnyRuntimeServiceInput[] = [];
      const database = await resolveDatabase(context, options.database);
      runtimeServices.push(defineDatabaseService(database));

      if (options.auth !== false) {
        const authOptions =
          options.auth === undefined ? {} : options.auth;
        runtimeServices.push(
          authService({
            ...authOptions,
            authOptions: {
              ...(authOptions.authOptions ?? {}),
              projectId:
                typeof context.platform.metadata.projectId === "string"
                  ? context.platform.metadata.projectId
                  : authOptions.authOptions?.projectId,
              repositories: {
                ...createDatabaseAuthRepositories(database),
                ...(authOptions.authOptions?.repositories ?? {}),
              },
            },
            methods: [
              ...(authOptions.methods ?? []),
              ...collectAuthMethodPlugins(context),
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
