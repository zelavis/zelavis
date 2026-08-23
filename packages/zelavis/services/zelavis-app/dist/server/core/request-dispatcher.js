const BODYLESS_RESPONSE_STATUSES = new Set([101, 103, 204, 205, 304]);
function splitPath(path) {
    return path.split("/").filter(Boolean);
}
function matchPath(pattern, pathname) {
    const patternParts = splitPath(pattern);
    const pathParts = splitPath(pathname);
    const wildcardIndex = patternParts.findIndex((part) => part.startsWith("*"));
    if (wildcardIndex >= 0) {
        if (wildcardIndex !== patternParts.length - 1) {
            return undefined;
        }
        if (pathParts.length < wildcardIndex) {
            return undefined;
        }
    }
    else if (patternParts.length !== pathParts.length) {
        return undefined;
    }
    const params = {};
    for (let index = 0; index < patternParts.length; index += 1) {
        const patternPart = patternParts[index];
        const pathPart = pathParts[index];
        if (patternPart.startsWith("*")) {
            const name = patternPart.slice(1) || "*";
            params[name] = pathParts.slice(index).map(decodeURIComponent).join("/");
            return params;
        }
        if (patternPart.startsWith(":")) {
            params[patternPart.slice(1)] = decodeURIComponent(pathPart);
            continue;
        }
        if (patternPart !== pathPart) {
            return undefined;
        }
    }
    return params;
}
function scoreMatchedPath(pattern) {
    const parts = splitPath(pattern);
    let score = 0;
    let wildcardCount = 0;
    for (const part of parts) {
        if (part.startsWith("*")) {
            wildcardCount += 1;
            score += 1;
            continue;
        }
        if (part.startsWith(":")) {
            score += 10;
            continue;
        }
        score += 100;
    }
    return score + parts.length - wildcardCount * 1000;
}
/**
 * Decide whether a route accepts the request's host.
 *
 * Returns `null` for "no match" (route is host-restricted and the request
 * host doesn't appear in its list). Returns a non-negative number used as a
 * tiebreaker in the dispatcher's scoring — host-specific matches get a small
 * bonus over host-agnostic ones, so `kanban.example.com/foo` beats a
 * wildcard host on `/foo` when both happen to match.
 *
 * Wildcard sentinel `"*"` (or omitted matcher) means host-agnostic and
 * returns 0. Exact hostname matches return 1000 (large enough to dominate
 * any path-score difference, since hosts are a stronger affinity signal
 * than path specificity).
 */
function matchRouteHost(matcher, requestHost) {
    if (matcher === undefined || matcher === "*") {
        return 0;
    }
    if (typeof matcher === "string") {
        return matcher.toLowerCase() === requestHost ? 1000 : null;
    }
    for (const candidate of matcher) {
        if (candidate === "*") {
            return 0;
        }
        if (candidate.toLowerCase() === requestHost) {
            return 1000;
        }
    }
    return null;
}
function toHeaderMap(headers) {
    const result = {};
    for (const [key, value] of headers.entries()) {
        result[key] = value;
    }
    return result;
}
function toHeaderRecord(headerEntries) {
    const result = {};
    for (const [key, value] of headerEntries) {
        if (result[key]) {
            result[key] = `${result[key]}, ${value}`;
            continue;
        }
        result[key] = value;
    }
    return result;
}
function defaultErrorResponse(error) {
    return {
        status: 500,
        body: {
            error: error instanceof Error ? error.message : "Unknown error",
        },
    };
}
function notFoundResponse() {
    return {
        status: 404,
        body: {
            error: "Not found",
        },
    };
}
function unauthorizedResponse() {
    return {
        status: 401,
        body: {
            error: "Unauthorized",
        },
    };
}
function forbiddenResponse(reason) {
    return {
        status: 403,
        body: {
            error: reason ?? "Forbidden",
        },
    };
}
function canHaveBody(method) {
    return method !== "GET" && method !== "HEAD";
}
function canResponseHaveBody(status) {
    return !BODYLESS_RESPONSE_STATUSES.has(status);
}
function isTextualContentType(contentType) {
    return (contentType.startsWith("text/") ||
        contentType.includes("application/json") ||
        contentType.includes("application/ld+json") ||
        contentType.includes("application/problem+json") ||
        contentType.includes("application/graphql-response+json") ||
        contentType.includes("application/x-www-form-urlencoded") ||
        contentType.includes("application/xml") ||
        contentType.includes("application/javascript") ||
        contentType.includes("application/typescript") ||
        contentType.includes("application/x-ndjson") ||
        contentType.includes("image/svg+xml"));
}
function appendFormValue(result, key, value) {
    const existing = result[key];
    if (existing === undefined) {
        result[key] = value;
        return;
    }
    if (Array.isArray(existing)) {
        existing.push(value);
        return;
    }
    result[key] = [existing, value];
}
async function parseFormDataBody(request) {
    const formData = await request.formData();
    const result = {};
    for (const [key, value] of formData.entries()) {
        appendFormValue(result, key, value);
    }
    return result;
}
async function parseFormDataResponse(response) {
    const formData = await response.formData();
    const result = {};
    for (const [key, value] of formData.entries()) {
        appendFormValue(result, key, value);
    }
    return result;
}
export function toResponseHeaderEntries(headers) {
    const entries = [];
    const getSetCookie = headers
        .getSetCookie;
    if (typeof getSetCookie === "function") {
        for (const [key, value] of headers.entries()) {
            if (key.toLowerCase() === "set-cookie") {
                continue;
            }
            entries.push([key, value]);
        }
        for (const value of getSetCookie.call(headers)) {
            entries.push(["set-cookie", value]);
        }
        return entries;
    }
    return Array.from(headers.entries());
}
async function parseRequestBody(request) {
    if (!canHaveBody(request.method.toUpperCase())) {
        return undefined;
    }
    const clone = request.clone();
    const contentType = clone.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("application/json")) {
        const text = await clone.text();
        return text ? JSON.parse(text) : undefined;
    }
    if (contentType.includes("application/x-www-form-urlencoded")) {
        return parseFormDataBody(clone);
    }
    if (contentType.includes("multipart/form-data")) {
        return parseFormDataBody(clone);
    }
    if (!contentType || isTextualContentType(contentType)) {
        const text = await clone.text();
        return text || undefined;
    }
    const body = await clone.arrayBuffer();
    return body.byteLength > 0 ? new Uint8Array(body) : undefined;
}
function toBodyInit(body, headers) {
    if (body === undefined || body === null) {
        return undefined;
    }
    if (typeof body === "string" ||
        body instanceof URLSearchParams ||
        body instanceof FormData ||
        body instanceof Blob ||
        body instanceof ArrayBuffer ||
        body instanceof ReadableStream ||
        body instanceof Uint8Array) {
        return body;
    }
    if (ArrayBuffer.isView(body)) {
        return body;
    }
    if (!headers.has("content-type")) {
        headers.set("content-type", "application/json; charset=utf-8");
    }
    return JSON.stringify(body);
}
export function toResponse(payload) {
    const headers = new Headers(payload.headers);
    const status = payload.status ?? 200;
    if (!canResponseHaveBody(status) || payload.body === undefined) {
        headers.delete("content-length");
        headers.delete("transfer-encoding");
        if (!canResponseHaveBody(status)) {
            headers.delete("content-type");
        }
        return new Response(null, { status, headers });
    }
    if (typeof payload.body === "string" ||
        payload.body instanceof URLSearchParams ||
        payload.body instanceof FormData ||
        payload.body instanceof Blob ||
        payload.body instanceof ArrayBuffer ||
        payload.body instanceof ReadableStream ||
        payload.body instanceof Uint8Array) {
        return new Response(payload.body, { status, headers });
    }
    if (ArrayBuffer.isView(payload.body)) {
        return new Response(payload.body, {
            status,
            headers,
        });
    }
    if (!headers.has("content-type")) {
        headers.set("content-type", "application/json; charset=utf-8");
    }
    return new Response(JSON.stringify(payload.body), { status, headers });
}
async function parseResponseBody(response) {
    if ([204, 205, 304].includes(response.status)) {
        return undefined;
    }
    const clone = response.clone();
    const contentType = clone.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("application/json")) {
        return clone.json();
    }
    if (contentType.includes("application/x-www-form-urlencoded")) {
        return parseFormDataResponse(clone);
    }
    if (contentType.includes("multipart/form-data")) {
        return parseFormDataResponse(clone);
    }
    if (!contentType || isTextualContentType(contentType)) {
        const text = await clone.text();
        return text || undefined;
    }
    const body = await clone.arrayBuffer();
    return body.byteLength > 0 ? new Uint8Array(body) : undefined;
}
function isAuthenticated(principal) {
    return principal !== undefined && principal.type !== "anonymous";
}
function hasRole(principal, role) {
    return principal?.roles?.includes(role) ?? false;
}
function matchScopeValue(required, granted) {
    return required === undefined || granted === undefined || required === granted;
}
function resolveAccessScope(scope, params) {
    if (!scope) {
        return undefined;
    }
    if (scope.type === "project") {
        return {
            type: "project",
            projectId: scope.projectId ?? params[scope.projectIdParam ?? ""],
            projectIdParam: scope.projectIdParam,
        };
    }
    if (scope.type === "service") {
        return {
            type: "service",
            serviceName: scope.serviceName ?? params[scope.serviceNameParam ?? ""],
            serviceNameParam: scope.serviceNameParam,
        };
    }
    return scope;
}
function scopesMatch(required, granted) {
    if (!required) {
        return true;
    }
    if (!granted) {
        return required.type === "system";
    }
    if (required.type !== granted.type) {
        return false;
    }
    if (required.type === "project" && granted.type === "project") {
        return matchScopeValue(required.projectId, granted.projectId);
    }
    if (required.type === "service" && granted.type === "service") {
        return matchScopeValue(required.serviceName, granted.serviceName);
    }
    return true;
}
function hasPermission(principal, permission, scope) {
    if (!principal) {
        return false;
    }
    if (principal.permissions?.includes(permission) ||
        principal.permissions?.includes("*")) {
        return true;
    }
    return (principal.grants?.some((grant) => (grant.permission === permission || grant.permission === "*") &&
        scopesMatch(scope, grant.scope)) ?? false);
}
function defaultAccessDecision(principal, requirement, params) {
    const requiresAuthentication = requirement.authenticated === true ||
        Boolean(requirement.roles?.length) ||
        Boolean(requirement.permissions?.length);
    if (requiresAuthentication && !isAuthenticated(principal)) {
        return {
            allowed: false,
            status: 401,
            reason: "Authentication required",
        };
    }
    if (requirement.roles?.length &&
        !requirement.roles.some((role) => hasRole(principal, role))) {
        return {
            allowed: false,
            status: 403,
            reason: "Missing required role",
        };
    }
    const scope = resolveAccessScope(requirement.scope, params);
    if (requirement.permissions?.length &&
        !requirement.permissions.every((permission) => hasPermission(principal, permission, scope))) {
        return {
            allowed: false,
            status: 403,
            reason: "Missing required permission",
        };
    }
    return {
        allowed: true,
    };
}
async function checkRouteAccess(resolvedRoute, request, params, options, context) {
    const requirements = resolvedRoute.route.access
        ? Array.isArray(resolvedRoute.route.access)
            ? resolvedRoute.route.access
            : [resolvedRoute.route.access]
        : [];
    const principal = context?.principal ??
        (await options.resolvePrincipal?.({
            request,
            platform: context?.platform,
            resolvedRoute,
            params,
        }));
    for (const requirement of requirements) {
        const rawDecision = (await options.authorize?.({
            request,
            platform: context?.platform,
            resolvedRoute,
            params,
            principal,
            requirement,
        })) ?? defaultAccessDecision(principal, requirement, params);
        const decision = typeof rawDecision === "boolean"
            ? { allowed: rawDecision }
            : rawDecision;
        if (!decision.allowed) {
            return {
                allowed: false,
                response: toResponse(decision.status === 401
                    ? unauthorizedResponse()
                    : forbiddenResponse(decision.reason)),
            };
        }
    }
    return {
        allowed: true,
        principal,
    };
}
async function executeResolvedRoute(resolvedRoute, request, params, options, context) {
    try {
        const access = await checkRouteAccess(resolvedRoute, request, params, options, context);
        if (!access.allowed) {
            return {
                matched: true,
                response: access.response,
                resolvedRoute,
            };
        }
        const result = await resolvedRoute.route.handler({
            service: resolvedRoute.service.service,
            params,
            query: new URL(request.url).searchParams,
            body: await parseRequestBody(request),
            headers: toHeaderMap(request.headers),
            requestHeaders: request.headers,
            request,
            principal: access.principal,
            platform: context?.platform,
        });
        return {
            matched: true,
            response: toResponse(result),
            resolvedRoute,
        };
    }
    catch (error) {
        const payload = options.onError?.({
            error,
            resolvedRoute,
        }) ?? defaultErrorResponse(error);
        return {
            matched: true,
            response: toResponse(payload),
            resolvedRoute,
        };
    }
}
export function createZelavisDispatcher(routes, options = {}) {
    return async (request, context) => {
        const url = new URL(request.url);
        const method = request.method.toUpperCase();
        const requestHost = url.host.toLowerCase();
        let matched;
        for (const resolvedRoute of routes) {
            const routeMethod = resolvedRoute.route.method;
            if (routeMethod !== method &&
                !(method === "HEAD" && routeMethod === "GET")) {
                continue;
            }
            const hostMatch = matchRouteHost(resolvedRoute.route.host, requestHost);
            if (hostMatch === null) {
                continue;
            }
            const params = matchPath(resolvedRoute.fullPath, url.pathname);
            if (!params) {
                continue;
            }
            // Host-specific routes outrank host-agnostic ones at the same path
            // score, so e.g. `kanban.example.com/foo` beats `*/foo` even when both
            // would otherwise match.
            const score = scoreMatchedPath(resolvedRoute.fullPath) + hostMatch;
            if (!matched || score > matched.score) {
                matched = {
                    resolvedRoute,
                    params,
                    score,
                };
            }
        }
        if (matched) {
            return executeResolvedRoute(matched.resolvedRoute, request, matched.params, options, context);
        }
        return {
            matched: false,
            response: toResponse(notFoundResponse()),
        };
    };
}
export function createZelavisFetchHandler(dispatch) {
    return async (request, context) => {
        const result = await dispatch(request, context);
        return result.response;
    };
}
export function createRequestFromPlainInput(input) {
    if (input.request) {
        return input.request;
    }
    const headers = new Headers(input.headers);
    const method = (input.method ?? "GET").toUpperCase();
    const body = canHaveBody(method)
        ? toBodyInit(input.body, headers)
        : undefined;
    const init = {
        method,
        headers,
        body,
    };
    if (body instanceof ReadableStream) {
        init.duplex = "half";
    }
    return new Request(new URL(input.url, input.baseUrl ?? "http://localhost"), init);
}
export function createZelavisPlainHandler(dispatch) {
    return async (input) => {
        const request = createRequestFromPlainInput(input);
        const result = await dispatch(request, {
            principal: input.principal,
            platform: input.platform,
        });
        return {
            matched: result.matched,
            status: result.response.status,
            headers: toHeaderRecord(toResponseHeaderEntries(result.response.headers)),
            headerEntries: toResponseHeaderEntries(result.response.headers),
            responseHeaders: result.response.headers,
            body: await parseResponseBody(result.response),
            response: result.response,
            resolvedRoute: result.resolvedRoute,
        };
    };
}
