import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
  clientRoutes?: readonly string[];
  devServerUrl?: string;
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

export interface ZelavisServerOptions<TResult = unknown> {
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

function normalizeExternalUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return new URL(trimmed).toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function readRequestUrl(request: unknown): string | undefined {
  if (!request || typeof request !== "object") {
    return undefined;
  }

  const candidate =
    "originalUrl" in request && typeof request.originalUrl === "string"
      ? request.originalUrl
      : "url" in request && typeof request.url === "string"
        ? request.url
        : undefined;

  return candidate && candidate.length > 0 ? candidate : undefined;
}

function stripRootPath(pathname: string, rootPath: string): string {
  if (pathname === rootPath) {
    return "/";
  }

  if (pathname.startsWith(`${rootPath}/`)) {
    return pathname.slice(rootPath.length) || "/";
  }

  return pathname || "/";
}

function createDashboardDevRedirect(
  context: {
    query: URLSearchParams;
    request: unknown;
  },
  options: {
    devServerUrl: string;
    rootPath: string;
    fallbackPath: string;
  },
) {
  const requestUrl = readRequestUrl(context.request);
  const parsed = requestUrl
    ? new URL(requestUrl, "http://127.0.0.1")
    : undefined;
  const pathname = stripRootPath(
    parsed?.pathname ?? options.fallbackPath,
    options.rootPath,
  );
  const search =
    parsed?.search ??
    (() => {
      const query = context.query.toString();
      return query ? `?${query}` : "";
    })();

  return {
    status: 307,
    headers: {
      location: `${options.devServerUrl}${pathname}${search}`,
      "cache-control": "no-cache",
    },
  };
}

const dashboardDistPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "dashboard",
);

const defaultDashboardClientRoutes = [
  "/agents",
  "/auth",
  "/builder",
  "/commerce",
  "/content",
  "/database",
  "/marketplace",
  "/services",
  "/settings",
] as const;

interface DashboardAsset {
  path: string;
  filePath: string;
  contentType: string;
  cacheControl: string;
}

function toDashboardRoutePath(filePath: string): string {
  const relativePath = relative(dashboardDistPath, filePath)
    .split(sep)
    .join("/");
  return `/${relativePath}`;
}

function getContentType(routePath: string): string {
  if (routePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }

  if (routePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }

  if (routePath.endsWith(".js") || routePath.endsWith(".mjs")) {
    return "text/javascript; charset=utf-8";
  }

  if (routePath.endsWith(".json") || routePath.endsWith(".webmanifest")) {
    return "application/json; charset=utf-8";
  }

  if (routePath.endsWith(".ico")) {
    return "image/x-icon";
  }

  if (routePath.endsWith(".png")) {
    return "image/png";
  }

  if (routePath.endsWith(".svg")) {
    return "image/svg+xml; charset=utf-8";
  }

  if (routePath.endsWith(".txt")) {
    return "text/plain; charset=utf-8";
  }

  return "application/octet-stream";
}

function collectDashboardAssets(
  directory = dashboardDistPath,
): DashboardAsset[] {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory)
    .flatMap((entry) => {
      const filePath = join(directory, entry);
      const stats = statSync(filePath);

      if (stats.isDirectory()) {
        return collectDashboardAssets(filePath);
      }

      const routePath = toDashboardRoutePath(filePath);
      if (routePath === "/_shell.html") {
        return [];
      }

      const isFingerprintedAsset = routePath.startsWith("/assets/");

      return [
        {
          path: routePath,
          filePath,
          contentType: getContentType(routePath),
          cacheControl: isFingerprintedAsset
            ? "public, max-age=31536000, immutable"
            : "public, max-age=300",
        },
      ];
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function prefixDashboardAssetReferences(
  content: string,
  rootPath: string,
): string {
  const prefix = rootPath === "/" ? "" : rootPath;

  return content
    .replace(
      /\b(href|src|action)="\/(?!\/)([^"]*)"/g,
      (_match, attribute, path) => {
        return `${attribute}="${prefix}/${path}"`;
      },
    )
    .replaceAll('"/assets/', `"${prefix}/assets/`)
    .replaceAll("'/assets/", `'${prefix}/assets/`)
    .replaceAll("`/assets/", `\`${prefix}/assets/`)
    .replaceAll('"assets/', `"${prefix}/assets/`)
    .replaceAll("'assets/", `'${prefix}/assets/`)
    .replaceAll("`assets/", `\`${prefix}/assets/`);
}

function shouldPrefixDashboardAsset(asset: DashboardAsset): boolean {
  return (
    asset.contentType.startsWith("text/") ||
    asset.contentType.startsWith("application/json") ||
    asset.path.endsWith(".js") ||
    asset.path.endsWith(".mjs")
  );
}

function readDashboardAsset(
  asset: DashboardAsset,
  rootPath: string,
): Buffer | string {
  if (!shouldPrefixDashboardAsset(asset)) {
    return readFileSync(asset.filePath);
  }

  return prefixDashboardAssetReferences(
    readFileSync(asset.filePath, "utf8"),
    rootPath,
  );
}

function injectDashboardRuntimeConfig(html: string, config: unknown): string {
  const script = `<script>window.__ZELAVIS_RUNTIME_CONFIG__=${JSON.stringify(config).replaceAll("<", "\\u003c")};</script>`;
  return html.includes("</head>")
    ? html.replace("</head>", `${script}</head>`)
    : `${script}${html}`;
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
  context: {
    apiPrefix: string;
    apiVersion: string;
    rootPath: string;
    serviceNames: readonly string[];
  },
): Promise<ZelavisServerService<any> | undefined> {
  const dashboardOption = option ?? true;

  if (dashboardOption === false) {
    return undefined;
  }

  const options = dashboardOption === true ? {} : dashboardOption;
  const title = options.title ?? "zelavis";
  const subtitle = options.subtitle ?? "Backend, dashboard, and core services.";
  const rootPath = context.rootPath;
  const devServerUrl = normalizeExternalUrl(
    options.devServerUrl ?? process.env.ZELAVIS_UI_DEV_SERVER,
  );
  const shellPath = join(dashboardDistPath, "_shell.html");
  const assets = devServerUrl ? [] : collectDashboardAssets();
  const clientRoutes = [
    ...new Set(
      (options.clientRoutes ?? defaultDashboardClientRoutes)
        .map((route) => normalizePath(route, "/"))
        .filter((route) => route !== "/"),
    ),
  ];
  const config = {
    name: "zelavis",
    rootPath,
    api: {
      prefix: context.apiPrefix,
      version: context.apiVersion,
      basePath: joinPathParts(rootPath, context.apiPrefix, context.apiVersion),
    },
    dashboard: {
      title,
      clientRoutes,
      assetRoot: joinPathParts(rootPath, "assets"),
    },
    services: context.serviceNames.map((name) => ({
      name,
      core: name === "dashboard" || name === "auth" || name === "database",
      apiPath:
        name === "dashboard"
          ? rootPath
          : joinPathParts(
              rootPath,
              context.apiPrefix,
              context.apiVersion,
              name,
            ),
    })),
  };
  const shell = existsSync(shellPath)
    ? injectDashboardRuntimeConfig(
        prefixDashboardAssetReferences(
          readFileSync(shellPath, "utf8"),
          rootPath,
        ),
        config,
      )
    : undefined;
  const shellHandler = ({
    query,
    request,
  }: {
    query: URLSearchParams;
    request: unknown;
  }) => {
    if (devServerUrl) {
      return createDashboardDevRedirect(
        { query, request },
        {
          devServerUrl,
          rootPath,
          fallbackPath: "/",
        },
      );
    }

    if (!shell) {
      return {
        status: 503,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
        },
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p><p>Dashboard assets have not been built yet.</p></body></html>`,
      };
    }

    return {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      },
      body: shell,
    };
  };
  const dashboardFallbackHandler = ({
    params,
    query,
    request,
  }: {
    params: Record<string, string>;
    query: URLSearchParams;
    request: unknown;
  }) => {
    const path = params.path ?? "";

    if (devServerUrl) {
      return createDashboardDevRedirect(
        { query, request },
        {
          devServerUrl,
          rootPath,
          fallbackPath: path ? `/${path}` : "/",
        },
      );
    }

    if (
      path === "api" ||
      path.startsWith("api/") ||
      path === "assets" ||
      path.startsWith("assets/")
    ) {
      return {
        status: 404,
        body: {
          error: "Not found",
        },
      };
    }

    return shellHandler({ query, request });
  };

  return defineServerService({
    name: "dashboard",
    basePath: "/",
    service: {
      title,
      subtitle,
      assetRoot: joinPathParts(rootPath, "assets"),
    },
    api: {
      v1: [
        {
          id: "dashboard.view.overview",
          method: "GET",
          path: "/",
          handler: shellHandler,
        },
        ...clientRoutes.map((route) => ({
          id: `dashboard.view${route.replaceAll("/", ".")}`,
          method: "GET" as const,
          path: route,
          handler: ({
            query,
            request,
          }: {
            query: URLSearchParams;
            request: unknown;
          }) =>
            devServerUrl
              ? createDashboardDevRedirect(
                  { query, request },
                  {
                    devServerUrl,
                    rootPath,
                    fallbackPath: route,
                  },
                )
              : shellHandler({ query, request }),
        })),
        {
          id: "dashboard.config",
          method: "GET",
          path: joinPathParts(
            context.apiPrefix,
            context.apiVersion,
            "dashboard/config",
          ),
          handler: () => ({
            status: 200,
            body: config,
          }),
        },
        ...assets.map((asset) => ({
          id: `dashboard.assets${asset.path.replaceAll("/", ".")}`,
          method: "GET" as const,
          path: asset.path,
          handler: () => ({
            status: 200,
            headers: {
              "content-type": asset.contentType,
              "cache-control": asset.cacheControl,
            },
            body: readDashboardAsset(asset, rootPath),
          }),
        })),
        {
          id: "dashboard.view.fallback",
          method: "GET",
          path: "/*path",
          handler: dashboardFallbackHandler,
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

export async function zelavis<TResult = unknown>(
  options: ZelavisServerOptions<TResult>,
): Promise<ZelavisServerRuntime<unknown, TResult>> {
  const rootPath = normalizePath(options.rootPath, "/zelavis");
  const apiPrefix = normalizePath(options.api?.prefix, "/api");
  const apiVersion = normalizePathPart(options.api?.version ?? "v1");
  const services = await Promise.all(options.services ?? []);
  const hasAuthService = services.some((service) => service.name === "auth");
  const hasDashboardService = services.some(
    (service) => service.name === "dashboard",
  );
  const hasDatabaseService = services.some(
    (service) => service.name === "database",
  );
  const authService = hasAuthService
    ? undefined
    : await resolveAuthCoreService(options.coreServices?.auth);
  const databaseService = hasDatabaseService
    ? undefined
    : await resolveDatabaseCoreService(options.coreServices?.database);
  const coreServices = [databaseService, authService].filter(
    (service): service is ZelavisServerService<any> => Boolean(service),
  );
  const serviceNames = [
    ...(hasDashboardService || options.coreServices?.dashboard === false
      ? []
      : ["dashboard"]),
    ...coreServices.map((service) => service.name),
    ...services.map((service) => service.name),
  ];
  const dashboardService = hasDashboardService
    ? undefined
    : await resolveDashboardCoreService(options.coreServices?.dashboard, {
        apiPrefix,
        apiVersion,
        rootPath,
        serviceNames,
      });
  const finalServices = [...coreServices, ...services, dashboardService].filter(
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
