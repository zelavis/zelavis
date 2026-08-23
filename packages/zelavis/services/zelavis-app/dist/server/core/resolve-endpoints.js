function normalizePathPart(part) {
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
function normalizePath(path) {
    const cleaned = path.trim();
    if (!cleaned || cleaned === "/") {
        return "/";
    }
    return `/${cleaned.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}
function joinPathParts(globalPrefix, servicePrefix, routePath) {
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
export function resolveMountedEndpoints(services, options = {}) {
    const resolved = [];
    const version = options.version ?? "v1";
    function visitService(service, prefix) {
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
                throw new TypeError(`Nested service "${service.name}" contains an unresolved promise. Resolve nested services before mounting.`);
            }
            visitService(child, nextPrefix);
        }
    }
    for (const service of services) {
        visitService(service, options.prefix);
    }
    return resolved;
}
function isPromiseLike(value) {
    return Boolean(value && typeof value.then === "function");
}
