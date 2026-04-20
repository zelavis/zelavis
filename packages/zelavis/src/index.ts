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
  defineServerService,
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

export interface ZelavisDashboardCoreServiceOptions {
  title?: string;
  subtitle?: string;
  assetPath?: string;
}

export type ZelavisDashboardCoreServiceInput =
  | boolean
  | ZelavisDashboardCoreServiceOptions;

export type ZelavisDatabaseCoreServiceOptions =
  | boolean
  | CreateDatabaseOptions
  | DatabaseApi
  | Promise<DatabaseApi>;

export interface ZelavisCoreServicesOptions {
  auth?: ZelavisAuthCoreServiceOptions;
  dashboard?: ZelavisDashboardCoreServiceInput;
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
  option: ZelavisDashboardCoreServiceInput | undefined,
  rootPath: string,
): Promise<ZelavisServerService<any> | undefined> {
  const dashboardOption = option ?? true;

  if (dashboardOption === false) {
    return undefined;
  }

  const options = dashboardOption === true ? {} : dashboardOption;
  const title = options.title ?? "zelavis";
  const subtitle = options.subtitle ?? "Backend, dashboard, and core services.";
  const assetPath = options.assetPath ?? joinPathParts(rootPath, "assets/dashboard.css");
  const escapedTitle = escapeHtml(title);
  const escapedSubtitle = escapeHtml(subtitle);
  const escapedAssetPath = escapeHtml(assetPath);

  return defineServerService({
    name: "dashboard",
    basePath: "/",
    service: {
      title,
      subtitle,
      assetPath,
    },
    api: {
      v1: [
        {
          id: "dashboard.view.overview",
          method: "GET",
          path: "/",
          handler: ({ service }) => ({
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
            },
            body: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapedTitle}</title>
    <link rel="stylesheet" href="${escapedAssetPath}" />
  </head>
  <body>
    <main class="zelavis-dashboard">
      <p class="zelavis-eyebrow">zelavis</p>
      <h1>${escapedTitle}</h1>
      <p>${escapedSubtitle}</p>
    </main>
  </body>
</html>`,
          }),
        },
        {
          id: "dashboard.assets.styles",
          method: "GET",
          path: "/assets/dashboard.css",
          handler: () => ({
            status: 200,
            headers: {
              "content-type": "text/css; charset=utf-8",
              "cache-control": "public, max-age=300",
            },
            body: `
:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: #f8fafc;
  color: #0f172a;
}

.zelavis-dashboard {
  width: min(720px, calc(100vw - 48px));
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: #ffffff;
  padding: 32px;
  box-shadow: 0 20px 50px rgba(15, 23, 42, 0.08);
}

.zelavis-eyebrow {
  margin: 0 0 12px;
  color: #2563eb;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

h1 {
  margin: 0 0 12px;
  font-size: 2.5rem;
  line-height: 1;
}

p {
  margin: 0;
  color: #475569;
  line-height: 1.6;
}
`,
          }),
        },
      ],
    },
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
