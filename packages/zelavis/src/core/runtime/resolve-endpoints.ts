import type {
  ZelavisEndpointGroup,
  ZelavisResolvedRoute,
  ZelavisServerMountOptions,
} from "./contracts.js";

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
  endpointGroups: readonly ZelavisEndpointGroup<TContext>[],
  options: Pick<
    ZelavisServerMountOptions<TContext>,
    "prefix" | "version" | "servicePrefixes" | "pathOverrides"
  > = {},
): ZelavisResolvedRoute<TContext>[] {
  const resolved: ZelavisResolvedRoute<TContext>[] = [];
  const version = options.version ?? "v1";

  for (const endpointGroup of endpointGroups) {
    const routes = endpointGroup.api?.[version];
    const endpointPrefix =
      options.servicePrefixes?.[endpointGroup.id] ??
      endpointGroup.basePath ??
      endpointGroup.id;

    if (routes) {
      for (const route of routes) {
        const overridePath = options.pathOverrides?.[route.id];
        const routePath = normalizePath(overridePath ?? route.path);

        resolved.push({
          endpointGroup,
          route,
          fullPath: joinPathParts(options.prefix, endpointPrefix, routePath),
        });
      }
    }
  }

  return resolved;
}
