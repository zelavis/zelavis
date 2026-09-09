import { declaresServiceCapability } from "../core/index.js";
import {
  authService,
  createDatabaseAuthRepositories,
  type AuthMethodPlugin,
  type AuthServiceOptions,
} from "./auth/index.js";
import {
  defineDatabaseService,
  type DatabaseRuntimeApi,
} from "../db/index.js";
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
  database?: DatabaseRuntimeApi;
  auth?: false | AuthServiceOptions;
  workloads?: false | WorkloadsServiceOptions;
}

export function isDatabaseRuntimeApi(value: unknown): value is DatabaseRuntimeApi {
  return Boolean(
    value &&
      typeof value === "object" &&
      "forTenant" in value &&
      "topology" in value,
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

/**
 * The database a Zelavis App project runs on.
 *
 * There is no implicit fallback any more: the store is durable and belongs to
 * a directory the host chose, so an App that reaches setup without one is a
 * misconfigured Project rather than a Project that should quietly get a
 * throwaway database nothing can find again.
 */
function resolveDatabase(
  context: ZelavisServiceSetupContext,
  option: ZelavisAppServiceOptions["database"],
): DatabaseRuntimeApi {
  if (isDatabaseRuntimeApi(option)) {
    return option;
  }

  if (isDatabaseRuntimeApi(context.core.database)) {
    return context.core.database;
  }

  throw new Error(
    "The Zelavis App recipe requires a database. Configure the runtime's database subsystem with a storage directory, or pass one to zelavisAppService({ database }).",
  );
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
      const database = resolveDatabase(context, options.database);
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
