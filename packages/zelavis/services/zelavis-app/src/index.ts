/**
 * Official Zelavis App Project recipe.
 *
 * This is an official first-party Project recipe implemented as a `kind: "app"`
 * service package. It provides the Firebase/Supabase-style application backend
 * stack (database, auth, workloads) and mounts them into the Project runtime.
 */
import { zelavis } from "zelavis/sdk";
import { declaresServiceCapability, type ZelavisAnyRuntimeServiceInput } from "zelavis/core";
import {
  authService,
  createDatabaseAuthRepositories,
  type AuthMethodPlugin,
  type AuthServiceOptions,
} from "zelavis/app/auth";
import {
  defineDatabaseService,
  type DatabaseRuntimeApi,
} from "zelavis/db";
import {
  workloadsService,
  type WorkloadsServiceOptions,
} from "zelavis/app/workloads";

export const ZELAVIS_APP_SERVICE_NAME = "@zelavis/app";

export interface ZelavisAppServiceOptions {
  name?: string;
  version?: string;
  database?: DatabaseRuntimeApi;
  auth?: false | AuthServiceOptions;
  workloads?: false | WorkloadsServiceOptions;
}

export interface ZelavisAppSetupContext {
  registry?: readonly any[];
  core?: {
    database?: DatabaseRuntimeApi;
    [key: string]: unknown;
  };
  platform?: {
    metadata?: {
      projectId?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  runtimeServices?: readonly ZelavisAnyRuntimeServiceInput[];
  addService?: (service: ZelavisAnyRuntimeServiceInput) => void;
  addServices?: (services: readonly ZelavisAnyRuntimeServiceInput[]) => void;
  [key: string]: unknown;
}

export function isDatabaseRuntimeApi(value: unknown): value is DatabaseRuntimeApi {
  return Boolean(
    value &&
      typeof value === "object" &&
      "forTenant" in value &&
      "topology" in value,
  );
}

export const APP_OVERVIEW_MENU = Object.freeze({
  title: "Overview",
  path: "/",
  pageLabel: "Project",
  sectionLabel: "Overview",
  surface: "root" as const,
  access: {
    permissions: ["project.view"],
    scope: { type: "project" as const, projectIdParam: "projectId" },
  },
});

// If loaded inside a plugin execution context (e.g. via loadPluginPackage),
// contribute menus via the official SDK side effect.
if (zelavis.context()) {
  zelavis.plugins.ui.menus.create(APP_OVERVIEW_MENU);
}

function collectAuthMethodPlugins(
  context: ZelavisAppSetupContext,
): readonly AuthMethodPlugin[] {
  return Object.freeze(
    (context.registry ?? [])
      .filter((entry: any) =>
        entry.status === "installed" &&
        declaresServiceCapability(
          entry.service?.capabilities,
          "zelavis/auth",
          "credentials",
        ) &&
        typeof (entry.service?.service as AuthMethodPlugin | undefined)?.register === "function",
      )
      .map((entry: any) => entry.service.service as AuthMethodPlugin),
  );
}

/**
 * The database a Zelavis App project runs on.
 *
 * There is no implicit fallback: the store is durable and belongs to
 * a directory chosen for the Project, so an App that reaches setup without one is a
 * misconfigured Project.
 */
function resolveDatabase(
  context: ZelavisAppSetupContext,
  option: ZelavisAppServiceOptions["database"],
): DatabaseRuntimeApi {
  if (isDatabaseRuntimeApi(option)) {
    return option;
  }

  if (isDatabaseRuntimeApi(context.core?.database)) {
    return context.core.database;
  }

  throw new Error(
    "The Zelavis App recipe requires a database. Configure the runtime's database subsystem with a storage directory, or pass one to zelavisAppService({ database }).",
  );
}

export function zelavisAppService(options: ZelavisAppServiceOptions = {}) {
  const inPluginContext = Boolean(zelavis.context());
  return Object.freeze({
    name: options.name ?? ZELAVIS_APP_SERVICE_NAME,
    version: options.version,
    kind: "app" as const,
    capabilities: Object.freeze(["app:project", "dashboard:menu", "api:routes"] as const),
    project: Object.freeze({ runtimeKinds: Object.freeze(["native"] as const) }),
    service: Object.freeze({}),
    api: {},
    ...(inPluginContext ? {} : { menu: APP_OVERVIEW_MENU }),
    async setup(context: ZelavisAppSetupContext) {
      const runtimeServices: ZelavisAnyRuntimeServiceInput[] = [];
      const database = resolveDatabase(context, options.database);
      runtimeServices.push(defineDatabaseService(database));

      if (options.auth !== false) {
        const authOptions =
          options.auth === undefined ? {} : options.auth;
        runtimeServices.push(
          await authService({
            ...authOptions,
            authOptions: {
              ...(authOptions.authOptions ?? {}),
              projectId:
                typeof context.platform?.metadata?.projectId === "string"
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
