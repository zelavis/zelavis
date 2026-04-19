import type {
  ZelavisResolvedRoute,
  ZelavisServerMountOptions,
  ZelavisServerService,
} from "../contracts.js";

function normalizePathPart(part: string | undefined): string {
  if (!part) {
    return "";
  }

  const trimmed = part.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  const noLeading = trimmed.replace(/^\/+/, "");
  const noTrailing = noLeading.replace(/\/+$/, "");
  return noTrailing;
}

function normalizePath(path: string): string {
  const cleaned = path.trim();
  if (!cleaned || cleaned === "/") {
    return "/";
  }

  return `/${cleaned.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

function joinPathParts(
  globalPrefix: string | undefined,
  servicePrefix: string | undefined,
  routePath: string,
): string {
  const parts = [
    normalizePathPart(globalPrefix),
    normalizePathPart(servicePrefix),
    normalizePathPart(routePath),
  ].filter(Boolean);

  if (parts.length === 0) {
    return "/";
  }

  return `/${parts.join("/")}`;
}

export function resolveMountedEndpoints<TContext = unknown>(
  services: readonly ZelavisServerService<TContext>[],
  options: Pick<
    ZelavisServerMountOptions<TContext>,
    "prefix" | "version" | "servicePrefixes" | "pathOverrides"
  > = {},
): ZelavisResolvedRoute<TContext>[] {
  const resolved: ZelavisResolvedRoute<TContext>[] = [];
  const version = options.version ?? "v1";

  for (const service of services) {
    const routes = service.api[version];
    if (!routes) {
      continue;
    }

    const servicePrefix = options.servicePrefixes?.[service.name] ?? service.basePath ?? service.name;

    for (const route of routes) {
      const overridePath = options.pathOverrides?.[route.id];
      const routePath = normalizePath(overridePath ?? route.path);

      resolved.push({
        service,
        route,
        fullPath: joinPathParts(options.prefix, servicePrefix, routePath),
      });
    }
  }

  return resolved;
}
