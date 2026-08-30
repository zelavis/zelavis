import {
  createErrorCorrelationId,
  genericErrorBody,
  publicErrorMessage,
} from "./error-policy.js";
import type {
  ZelavisAccessDecision,
  ZelavisAccessRequirement,
  ZelavisAccessScope,
  ZelavisPrincipal,
  ZelavisPlainRequest,
  ZelavisPlainResponse,
  ZelavisResolvedRoute,
  ZelavisRouteResponse,
  ZelavisServerDispatchHandler,
  ZelavisServerDispatchResult,
  ZelavisServerExecutionContext,
  ZelavisServerFetchHandler,
  ZelavisServerMountOptions,
  ZelavisServerPlainHandler,
} from "./contracts.js";
import {
  formatAuthenticationChallenge,
  ZelavisAuthenticationError,
} from "./authentication.js";

const BODYLESS_RESPONSE_STATUSES = new Set([101, 103, 204, 205, 304]);

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function matchPath(
  pattern: string,
  pathname: string,
): Record<string, string> | undefined {
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
  } else if (patternParts.length !== pathParts.length) {
    return undefined;
  }

  const params: Record<string, string> = {};

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

function scoreMatchedPath(pattern: string): number {
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
function matchRouteHost(
  matcher: string | readonly string[] | undefined,
  requestHost: string,
): number | null {
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

function toHeaderMap(headers: Headers): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};

  for (const [key, value] of headers.entries()) {
    result[key] = value;
  }

  return result;
}

function toHeaderRecord(
  headerEntries: Iterable<readonly [string, string]>,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of headerEntries) {
    if (result[key]) {
      result[key] = `${result[key]}, ${value}`;
      continue;
    }

    result[key] = value;
  }

  return result;
}

/**
 * Single mapping from a thrown value to a response.
 *
 * Exported so runtime composition reuses it instead of repeating a parallel
 * fallback that silently diverges — an oversized body was reported as `500`
 * from one path and `413` from the other.
 */
export function toDefaultErrorResponse(
  error: unknown,
  correlationId?: string,
): ZelavisRouteResponse {
  return defaultErrorResponse(error, correlationId);
}

function defaultErrorResponse(
  error: unknown,
  correlationId?: string,
): ZelavisRouteResponse {
  // An oversized body is a client error with a safe, useful message, not an
  // internal failure.
  if (error instanceof ZelavisRequestBodyTooLargeError) {
    return {
      status: 413,
      body: { error: error.message },
    };
  }

  const message = publicErrorMessage(error);
  if (message !== undefined) {
    return { status: 500, body: { error: message } };
  }

  // An unexpected failure: its message was written for whoever debugs it and
  // routinely names filesystem paths, module specifiers, or SQL. The cause
  // reaches structured logs through the error lifecycle event; the client gets
  // the correlation id that joins them.
  return {
    status: 500,
    body: genericErrorBody(correlationId ?? createErrorCorrelationId()),
  };
}

function notFoundResponse(): ZelavisRouteResponse {
  return {
    status: 404,
    body: {
      error: "Not found",
    },
  };
}

function unauthorizedResponse(
  challenge?: ZelavisAuthenticationError["challenge"],
): ZelavisRouteResponse {
  return {
    status: 401,
    headers: challenge
      ? { "www-authenticate": formatAuthenticationChallenge(challenge) }
      : undefined,
    body: {
      error: "Unauthorized",
    },
  };
}

function forbiddenResponse(reason?: string): ZelavisRouteResponse {
  return {
    status: 403,
    body: {
      error: reason ?? "Forbidden",
    },
  };
}

const SAFE_REQUEST_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function cookieMutationIsSameOrigin(
  request: Request,
  principal: ZelavisPrincipal | undefined,
): boolean {
  if (
    SAFE_REQUEST_METHODS.has(request.method.toUpperCase()) ||
    principal?.metadata?.authenticationTransport !== "cookie"
  ) {
    return true;
  }
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function canHaveBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

function canResponseHaveBody(status: number): boolean {
  return !BODYLESS_RESPONSE_STATUSES.has(status);
}

function isTextualContentType(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType.includes("application/json") ||
    contentType.includes("application/ld+json") ||
    contentType.includes("application/problem+json") ||
    contentType.includes("application/graphql-response+json") ||
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("application/xml") ||
    contentType.includes("application/javascript") ||
    contentType.includes("application/typescript") ||
    contentType.includes("application/x-ndjson") ||
    contentType.includes("image/svg+xml")
  );
}

function appendFormValue(
  result: Record<string, FormDataEntryValue | FormDataEntryValue[]>,
  key: string,
  value: FormDataEntryValue,
): void {
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

async function parseFormDataBody(
  request: Request,
): Promise<Record<string, FormDataEntryValue | FormDataEntryValue[]>> {
  const formData = await request.formData();
  const result: Record<string, FormDataEntryValue | FormDataEntryValue[]> = {};

  for (const [key, value] of formData.entries()) {
    appendFormValue(result, key, value);
  }

  return result;
}

async function parseFormDataResponse(
  response: Response,
): Promise<Record<string, FormDataEntryValue | FormDataEntryValue[]>> {
  const formData = await response.formData();
  const result: Record<string, FormDataEntryValue | FormDataEntryValue[]> = {};

  for (const [key, value] of formData.entries()) {
    appendFormValue(result, key, value);
  }

  return result;
}

export function toResponseHeaderEntries(
  headers: Headers,
): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] })
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

/**
 * Default ceiling on a buffered request body.
 *
 * Every body shape below is read fully into memory before a handler sees it, so
 * without a ceiling a single request can exhaust the process. 8 MiB comfortably
 * covers control-plane JSON and form posts; routes that legitimately need more
 * should stream rather than raise this.
 */
export const ZELAVIS_DEFAULT_MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

/** Thrown when a request body exceeds the configured budget. */
export class ZelavisRequestBodyTooLargeError extends Error {
  readonly limitBytes: number;
  constructor(limitBytes: number) {
    super(`Request body exceeds the ${limitBytes} byte limit.`);
    this.name = "ZelavisRequestBodyTooLargeError";
    this.limitBytes = limitBytes;
  }
}

/**
 * Reads a request body with an explicit byte ceiling.
 *
 * `Content-Length` is checked first as a cheap rejection, but it is only a
 * claim: the stream is also measured as it is consumed so a lying or absent
 * header cannot bypass the budget.
 */
async function readBoundedBody(
  request: Request,
  limitBytes: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limitBytes) {
    throw new ZelavisRequestBodyTooLargeError(limitBytes);
  }

  const body = request.body;
  if (!body) {
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > limitBytes) {
      throw new ZelavisRequestBodyTooLargeError(limitBytes);
    }
    return buffer.byteLength > 0
      ? new Uint8Array(buffer as ArrayBuffer)
      : undefined;
  }

  const chunks: Uint8Array<ArrayBufferLike>[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limitBytes) {
        throw new ZelavisRequestBodyTooLargeError(limitBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) return undefined;
  const merged = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function parseRequestBody(
  request: Request,
  limitBytes: number = ZELAVIS_DEFAULT_MAX_REQUEST_BODY_BYTES,
): Promise<unknown> {
  if (!canHaveBody(request.method.toUpperCase())) {
    return undefined;
  }

  // Measure the body once, then re-present it to the shape-specific parsers.
  const raw = await readBoundedBody(request.clone(), limitBytes);
  const clone = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    ...(raw ? { body: raw } : {}),
  });
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

function toBodyInit(body: unknown, headers: Headers): BodyInit | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }

  if (
    typeof body === "string" ||
    body instanceof URLSearchParams ||
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    body instanceof ReadableStream ||
    body instanceof Uint8Array
  ) {
    return body as BodyInit;
  }

  if (ArrayBuffer.isView(body)) {
    return body as unknown as BodyInit;
  }

  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }

  return JSON.stringify(body);
}

export function toResponse(payload: ZelavisRouteResponse): Response {
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

  if (
    typeof payload.body === "string" ||
    payload.body instanceof URLSearchParams ||
    payload.body instanceof FormData ||
    payload.body instanceof Blob ||
    payload.body instanceof ArrayBuffer ||
    payload.body instanceof ReadableStream ||
    payload.body instanceof Uint8Array
  ) {
    return new Response(payload.body as BodyInit, { status, headers });
  }

  if (ArrayBuffer.isView(payload.body)) {
    return new Response(payload.body as unknown as BodyInit, {
      status,
      headers,
    });
  }

  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }

  return new Response(JSON.stringify(payload.body), { status, headers });
}

async function parseResponseBody(response: Response): Promise<unknown> {
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

function isAuthenticated(principal: ZelavisPrincipal | undefined): boolean {
  return principal !== undefined && principal.type !== "anonymous";
}

function hasRole(
  principal: ZelavisPrincipal | undefined,
  role: string,
): boolean {
  return principal?.roles?.includes(role) ?? false;
}

/**
 * Compares a required scope identifier with a granted one.
 *
 * Fails closed on either side. An unresolved route parameter must not weaken
 * the requirement, and a stored grant that omits its identifier must not match
 * every Project or service of that type. An authority that legitimately spans
 * all Projects is expressed as a top-level permission (or `"*"`), which is
 * checked before grants are consulted.
 */
function matchScopeValue(
  required: string | undefined,
  granted: string | undefined,
): boolean {
  return (
    required !== undefined && granted !== undefined && required === granted
  );
}

function resolveAccessScope(
  scope: ZelavisAccessScope | undefined,
  params: Record<string, string>,
): ZelavisAccessScope | undefined {
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

function scopesMatch(
  required: ZelavisAccessScope | undefined,
  granted: ZelavisAccessScope | undefined,
): boolean {
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

function hasPermission(
  principal: ZelavisPrincipal | undefined,
  permission: string,
  scope: ZelavisAccessScope | undefined,
): boolean {
  if (!principal) {
    return false;
  }

  if (
    principal.permissions?.includes(permission) ||
    principal.permissions?.includes("*")
  ) {
    return true;
  }

  return (
    principal.grants?.some(
      (grant) =>
        (grant.permission === permission || grant.permission === "*") &&
        scopesMatch(scope, grant.scope),
    ) ?? false
  );
}

function defaultAccessDecision(
  principal: ZelavisPrincipal | undefined,
  requirement: ZelavisAccessRequirement,
  params: Record<string, string>,
): ZelavisAccessDecision {
  const requiresAuthentication =
    requirement.authenticated === true ||
    Boolean(requirement.roles?.length) ||
    Boolean(requirement.permissions?.length);

  if (requiresAuthentication && !isAuthenticated(principal)) {
    return {
      allowed: false,
      status: 401,
      reason: "Authentication required",
    };
  }

  if (
    requirement.roles?.length &&
    !requirement.roles.some((role) => hasRole(principal, role))
  ) {
    return {
      allowed: false,
      status: 403,
      reason: "Missing required role",
    };
  }

  const scope = resolveAccessScope(requirement.scope, params);
  if (
    requirement.permissions?.length &&
    !requirement.permissions.every((permission) =>
      hasPermission(principal, permission, scope),
    )
  ) {
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

async function checkRouteAccess<TService = unknown>(
  resolvedRoute: ZelavisResolvedRoute<TService>,
  request: Request,
  params: Record<string, string>,
  options: Pick<
    ZelavisServerMountOptions<TService>,
    "authorize" | "resolvePrincipal"
  >,
  context?: ZelavisServerExecutionContext,
): Promise<
  | {
      allowed: true;
      principal?: ZelavisPrincipal;
    }
  | {
      allowed: false;
      response: Response;
    }
> {
  const requirements = resolvedRoute.route.access
    ? Array.isArray(resolvedRoute.route.access)
      ? resolvedRoute.route.access
      : [resolvedRoute.route.access]
    : [];

  let principal = context?.principal;
  if (!principal) {
    try {
      principal = await options.resolvePrincipal?.({
        request,
        platform: context?.platform,
        resolvedRoute,
        params,
      });
    } catch (error) {
      if (error instanceof ZelavisAuthenticationError) {
        return {
          allowed: false,
          response: toResponse(unauthorizedResponse(error.challenge)),
        };
      }
      throw error;
    }
  }

  if (!cookieMutationIsSameOrigin(request, principal)) {
    return {
      allowed: false,
      response: toResponse(
        forbiddenResponse(
          "Cookie-authenticated mutations require a matching Origin header.",
        ),
      ),
    };
  }

  for (const requirement of requirements) {
    const rawDecision =
      (await options.authorize?.({
        request,
        platform: context?.platform,
        resolvedRoute,
        params,
        principal,
        requirement,
      })) ?? defaultAccessDecision(principal, requirement, params);
    const decision =
      typeof rawDecision === "boolean"
        ? ({ allowed: rawDecision } satisfies ZelavisAccessDecision)
        : rawDecision;

    if (!decision.allowed) {
      return {
        allowed: false,
        response: toResponse(
          decision.status === 401
            ? unauthorizedResponse()
            : forbiddenResponse(decision.reason),
        ),
      };
    }
  }

  return {
    allowed: true,
    principal,
  };
}

async function executeResolvedRoute<TService = unknown>(
  resolvedRoute: ZelavisResolvedRoute<TService>,
  request: Request,
  params: Record<string, string>,
  options: Pick<
    ZelavisServerMountOptions<TService>,
    "authorize" | "onError" | "resolvePrincipal"
  >,
  context?: ZelavisServerExecutionContext,
): Promise<ZelavisServerDispatchResult<TService>> {
  try {
    const access = await checkRouteAccess(
      resolvedRoute,
      request,
      params,
      options,
      context,
    );
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
  } catch (error) {
    const payload =
      (await options.onError?.({
        error,
        request,
        executionContext: context,
        resolvedRoute,
      })) ?? defaultErrorResponse(error);

    return {
      matched: true,
      response: toResponse(payload),
      resolvedRoute,
    };
  }
}

export function createZelavisDispatcher<TService = unknown>(
  routes: readonly ZelavisResolvedRoute<TService>[],
  options: Pick<
    ZelavisServerMountOptions<TService>,
    "authorize" | "onError" | "resolvePrincipal"
  > = {},
): ZelavisServerDispatchHandler<TService> {
  return async (request, context) => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const requestHost = url.host.toLowerCase();
    let matched:
      | {
          resolvedRoute: ZelavisResolvedRoute<TService>;
          params: Record<string, string>;
          score: number;
        }
      | undefined;

    for (const resolvedRoute of routes) {
      const routeMethod = resolvedRoute.route.method;

      if (
        routeMethod !== method &&
        !(method === "HEAD" && routeMethod === "GET")
      ) {
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
      return executeResolvedRoute(
        matched.resolvedRoute,
        request,
        matched.params,
        options,
        context,
      );
    }

    return {
      matched: false,
      response: toResponse(notFoundResponse()),
    };
  };
}

export function createZelavisFetchHandler<TService = unknown>(
  dispatch: ZelavisServerDispatchHandler<TService>,
): ZelavisServerFetchHandler<TService> {
  return async (request, context) => {
    const result = await dispatch(request, context);
    return result.response;
  };
}

export function createRequestFromPlainInput(
  input: ZelavisPlainRequest,
): Request {
  if (input.request) {
    return input.request;
  }

  const headers = new Headers(input.headers);
  const method = (input.method ?? "GET").toUpperCase();
  const body = canHaveBody(method)
    ? toBodyInit(input.body, headers)
    : undefined;
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    body,
    ...(input.signal ? { signal: input.signal } : {}),
  };

  if (body instanceof ReadableStream) {
    init.duplex = "half";
  }

  return new Request(
    new URL(input.url, input.baseUrl ?? "http://localhost"),
    init,
  );
}

export function createZelavisPlainHandler<TService = unknown>(
  dispatch: ZelavisServerDispatchHandler<TService>,
): ZelavisServerPlainHandler<TService> {
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
    } as ZelavisPlainResponse<TService>;
  };
}
