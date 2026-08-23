import type {
  ZelavisResolvedRoute,
  ZelavisRuntimeServiceInput,
  ZelavisServerMountOptions,
  ZelavisRuntimeService,
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
  services: readonly ZelavisRuntimeService<TContext>[],
  options: Pick<
    ZelavisServerMountOptions<TContext>,
    "prefix" | "version" | "servicePrefixes" | "pathOverrides"
  > = {},
): ZelavisResolvedRoute<TContext>[] {
  const resolved: ZelavisResolvedRoute<TContext>[] = [];
  const version = options.version ?? "v1";

  function visitService(service: ZelavisRuntimeService<TContext>, prefix: string | undefined): void {
    const routes = service.api[version];
    const servicePrefix = options.servicePrefixes?.[service.name] ?? service.basePath ?? service.name;
    const nextPrefix = joinPathParts(prefix, servicePrefix, "/");

    if (routes) {
      for (const route of routes) {
        const overridePath = options.pathOverrides?.[route.id];
        const routePath = normalizePath(overridePath ?? route.path);

        resolved.push({
          service,
          route,
          fullPath: joinPathParts(prefix, servicePrefix, routePath),
        });
      }
    }

    for (const child of service.services ?? []) {
      if (isPromiseLike(child)) {
        throw new TypeError(
          `Nested service "${service.name}" contains an unresolved promise. Resolve nested services before mounting.`,
        );
      }

      visitService(child as ZelavisRuntimeService<TContext>, nextPrefix);
    }
  }

  for (const service of services) {
    visitService(service, options.prefix);
  }

  return resolved;
}

function isPromiseLike<TContext>(
  value: ZelavisRuntimeServiceInput<TContext>,
): value is Promise<ZelavisRuntimeService<TContext>> {
  return Boolean(value && typeof (value as Promise<ZelavisRuntimeService<TContext>>).then === "function");
}
