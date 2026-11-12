import { respondToAcmeChallenge, type AcmeChallengeStore } from "../edge/certificates.js";
import { normalizeProjectDomainHostname, PROJECT_DOMAIN_PROBE_PATH } from "../edge/project-domains.js";
import type { ZelavisEdgeRouteStore } from "../edge/routes.js";
import { integrationValue, unwrapIntegrationResult, presentProtocol, present, integration, IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { Effect } from "effect";
/**
 * Forwards public traffic on a verified domain to the Project that owns it.
 *
 * This is the visitor path, and it differs from the Gateway proxy in three ways
 * that matter:
 *
 * - **Anonymous.** A visitor has no Platform identity, so no authority envelope
 *   is signed or sent, and no Platform credentials are relayed.
 * - **Verified only.** An unverified binding is not routable. Anyone can point
 *   DNS at a host; verification is what proves the operator controls it, and
 *   forwarding before that would let a stranger claim a Project's traffic.
 * - **Cookies belong to the site.** The Gateway strips `set-cookie` because it
 *   proxies onto the *Platform* origin, where a Project must not be able to set
 *   cookies. Here the origin is the Project's own domain, so its cookies are
 *   its own and pass through.
 */
import {
  findRunningFrontend,
  gatewayRequestHeaders,
  resolveProxyTarget,
} from "./project-gateway.js";
import type { DomainBinding, DomainBindingStore } from "../domain-binding.js";
import type { ZelavisProjectManager } from "../project.js";
import { readAuthorizationCredential, type ZelavisRouteResponse } from "../core/index.js";
import { toResponse } from "../core/runtime/request-dispatcher.js";
import { projectSessionAudience, projectSessionCookieName, projectSessionTokenPrefix } from "../app/identity/core/project-session-audience.js";
import { classifyProjectPublicAuthRequest, isSiteControlPlanePath, privateProjectAuthPath, PROJECT_AUTH_API, PROJECT_AUTH_BODY_BYTES, PROJECT_AUTH_ROOT } from "./project-public-auth.js";

/** Ceiling on a forwarded body, matching the Gateway's. */
const MAX_PUBLIC_BODY_BYTES = 32 * 1024 * 1024;
const PUBLIC_FORWARD_TIMEOUT_MS = 30_000;

/** Headers a Project must not be able to set on a response it did not originate. */
const PUBLIC_RESPONSE_HOP_BY_HOP = Object.freeze([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

export interface PublicDomainForwarderOptions {
  readonly domainBindings?: DomainBindingStore;
  readonly protectedCookieNames?: readonly string[];
  readonly fetchSite?: (url: URL, init: RequestInit) => Promise<Response>;
  readonly rootPath?: string;
  readonly acmeChallengeMounted?: boolean;
  /**
   * Resolved per request rather than captured.
   *
   * The service that owns the public root is composed before the Project
   * manager exists, and a Project manager can also be absent entirely on a host
   * that does not manage Projects. A getter keeps that ordering explicit
   * instead of forcing the composition to be reordered around it.
   */
  readonly projects?: () => ZelavisProjectManager | undefined;
}

/**
 * Resolves the Project a request's `Host` belongs to.
 *
 * Returns `undefined` when the host is unbound or the binding is unverified, so
 * the caller falls through to whatever it would otherwise serve.
 */
export function resolveVerifiedBinding(
  bindings: DomainBindingStore,
  host: string,
): Promise<DomainBinding | undefined> {
    return present(Effect.gen(function* (): Effect.fn.Return<DomainBinding | undefined, IntegrationFailure> {
  // A trailing dot is the same DNS name; the store normalizes it away, so a
  // lookup that kept it would let `example.com.` reach the dashboard.
  const normalized = (host.toLowerCase().split(":")[0] ?? "").replace(/\.+$/, "");
  if (!normalized) return undefined;

  const binding = (yield* integrationValue(bindings.get(normalized).catch(() => undefined)));
  if (!binding || !binding.verifiedAt || !binding.projectId) return undefined;
  return binding;
}));
  }

function boundedBody(body: ReadableStream<Uint8Array> | null, limit = MAX_PUBLIC_BODY_BYTES): Promise<Uint8Array> {
  return present(Effect.gen(function* (): Effect.fn.Return<Uint8Array, IntegrationFailure> {
    if (!body) return new Uint8Array();
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    yield* Effect.gen(function* () {
      for (;;) {
        const item = yield* integration(() => reader.read());
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > limit) {
          yield* integration(() => reader.cancel());
          return yield* Effect.fail(new IntegrationFailure(new RangeError("Site body exceeds its ingress limit.")));
        }
        if (item.value.byteLength) chunks.push(item.value);
      }
    }).pipe(Effect.ensuring(Effect.sync(() => reader.releaseLock())));
    const result = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }));
}

function publicResponseHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const header of PUBLIC_RESPONSE_HOP_BY_HOP) headers.delete(header);
  return headers;
}

const siteNotFound = { status: 404, headers: { "cache-control": "no-store" }, body: { error: "Not found" } };
const siteUnavailable = { status: 503, headers: { "cache-control": "no-store" }, body: { error: "This site is unavailable." } };

function forwardBoundProject(options: PublicDomainForwarderOptions, projectId: string, request: Request) {
  return Effect.gen(function* () {
    const projects = options.projects?.();
    if (!projects) return siteNotFound;
    // The view follows ingress admission so it can see the placement that won the handover.
    const selected = yield* Effect.result(Effect.gen(function* () {
      yield* integration(() => projects.ingressReady?.(projectId));
      return yield* integration(() => projects.view(projectId));
    }));
    if (selected._tag === "Failure") return siteUnavailable;
    const project = selected.success;
    if (!project || project.deletion) return siteNotFound;
    return yield* integration(() => forwardProjectSiteRequest({
      projects, project, protectedCookieNames: options.protectedCookieNames,
      rootPath: options.rootPath, fetchSite: options.fetchSite,
    }, request));
  });
}

/** Canonical Project hostname ownership precedes every Platform route. */
export function guardProjectDomainHost(
  routes: ZelavisEdgeRouteStore, options: PublicDomainForwarderOptions, request: Request, canonicalPath: boolean,
  challenges?: AcmeChallengeStore,
): Promise<Response | undefined> {
  return present(Effect.gen(function* () {
    const url = new URL(request.url);
    const hostname = normalizeProjectDomainHostname(url.hostname.replace(/\.+$/, ""));
    const validHostSpelling = !url.hostname.endsWith("..");
    if (!hostname) return undefined;
    const row = yield* integration(() => routes.getHostname(hostname));
    if (!row?.projectDomain || !row.projectId) return undefined;
    if (!validHostSpelling) return toResponse(siteNotFound);

    if (canonicalPath && request.method === "GET") {
      if (url.pathname === PROJECT_DOMAIN_PROBE_PATH) return new Response(null, {
        status: 204, headers: { "cache-control": "no-store", "x-zelavis-project-domain": "ready" },
      });
      const challenge = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]{1,256})$/.exec(url.pathname)?.[1];
      if (challenges && challenge && row.tlsMode !== "external") {
        return toResponse(yield* integration(() => respondToAcmeChallenge(challenges, challenge, hostname)));
      }
    }
    if (row.projectDomain.routing !== "active") return toResponse(siteUnavailable);
    if (!canonicalPath) return toResponse(siteNotFound);
    return toResponse(yield* forwardBoundProject(options, row.projectId, request));
  }));
}

/**
 * Forwards one public request, or returns `undefined` when the host is not a
 * verified binding and the caller should serve its own response.
 */
export function forwardPublicRequest(
  options: PublicDomainForwarderOptions,
  request: Request,
): Promise<ZelavisRouteResponse | undefined> {
    return present(Effect.gen(function* (): Effect.fn.Return<ZelavisRouteResponse | undefined, IntegrationFailure> {
  const { domainBindings } = options;
  if (!domainBindings) return undefined;

  const url = new URL(request.url);
  const binding = (yield* integrationValue(resolveVerifiedBinding(domainBindings, url.host)));
  if (!binding?.projectId) return undefined;

  return yield* forwardBoundProject(options, binding.projectId, request);
}));
  }

/** Shared anonymous site ingress for verified hostnames and per-Project previews. */
export function forwardProjectSiteRequest(
  options: {
    readonly projects: Pick<ZelavisProjectManager, "listOwned">;
    readonly project: {
      readonly id: string;
      readonly recipe?: { readonly name: string; readonly managed?: unknown };
      readonly runtime: { readonly status: string; readonly url?: string };
    };
    readonly protectedCookieNames?: readonly string[];
  readonly fetchSite?: (url: URL, init: RequestInit) => Promise<Response>;
    readonly rootPath?: string;
    readonly canonicalPath?: boolean;
  },
  request: Request,
): Promise<ZelavisRouteResponse> { return presentProtocol(Effect.gen(function* () {
  const { projects, project } = options;
  const url = new URL(request.url);
  const protectedCookies = new Set(["zelavis_session", ...(options.protectedCookieNames ?? [])]);
  const isProtectedCookie = (name: string) => protectedCookies.has(name) || name.toLowerCase().startsWith("zelavis_app_");
  const auth = options.canonicalPath !== false && project.recipe?.name === "@zelavis/app" && !project.recipe.managed
    ? classifyProjectPublicAuthRequest(request.method, url.pathname, PROJECT_AUTH_ROOT, PROJECT_AUTH_API)
    : undefined;

  // Reserve the child and parent control-plane mounts even if a separate frontend serves the site.
  let path: string;
  try { path = decodeURIComponent(url.pathname); }
  catch { return { status: 400, body: { error: "Invalid path." } }; }
  if (!auth && (isSiteControlPlanePath(path, PROJECT_AUTH_ROOT) ||
      (options.rootPath && options.rootPath !== "/" && isSiteControlPlanePath(path, options.rootPath)))) return siteNotFound;

  if (project.runtime.status !== "running" || !project.runtime.url) {
    return {
      status: 503,
      headers: { "cache-control": "no-store" },
      body: { error: "This site is not running." },
    };
  }

  const frontend = auth ? undefined : yield* integrationValue(findRunningFrontend(projects, project.id));
  const pathToForward = auth ? privateProjectAuthPath(request.method, url.pathname) : url.pathname;
  const target = resolveProxyTarget(
    new URL(frontend?.url ?? project.runtime.url).origin,
    pathToForward.replace(/^\/+/, ""),
  );
  if (!target) return { status: 400, body: { error: "Invalid path." } };
  // Directory URLs must retain their slash: Nginx redirects /wp-admin to
  // /wp-admin/, and removing it on every hop creates an endless redirect.
  if (url.pathname.endsWith("/") && !target.pathname.endsWith("/")) target.pathname += "/";
  target.search = url.search.replace(/^\?/, "");

  // No authority envelope: a visitor has no Platform identity, and the target
  // may be third-party frontend code.
  const headers = gatewayRequestHeaders(request.headers);
  const audience = auth ? yield* integration(() => projectSessionAudience(project.id)) : undefined;
  const audienceCookie = audience === undefined ? undefined : projectSessionCookieName(audience);
  const appCookie = audienceCookie && !protectedCookies.has(audienceCookie) ? audienceCookie : undefined;
  const tokenPrefix = audience === undefined ? undefined : projectSessionTokenPrefix(audience);
  const matchesToken = (token: string) => tokenPrefix !== undefined && token.startsWith(tokenPrefix) &&
    /^[A-Za-z0-9_-]{43}$/u.test(token.slice(tokenPrefix.length));
  // Site cookies must return to the site for login to work. Platform cookies
  // never travel into Project code, even when previews share its IP address.
  const cookies = (request.headers.get("cookie") ?? "").split(";")
    .map((cookie) => cookie.trim()).filter((cookie) => {
      const separator = cookie.indexOf("=");
      if (separator <= 0) return false;
      const name = cookie.slice(0, separator).trim();
      return auth ? name === appCookie && matchesToken(cookie.slice(separator + 1).trim()) : !isProtectedCookie(name);
    }).join("; ");
  if (cookies) headers.set("cookie", cookies);
  if (auth === "api") {
    const bearer = readAuthorizationCredential(request, "Bearer");
    if (bearer && matchesToken(bearer)) headers.set("authorization", `Bearer ${bearer}`);
  }
  for (const name of [...headers.keys()]) {
    if (name.startsWith("x-forwarded-") || name === "forwarded") headers.delete(name);
  }
  headers.set("host", url.host);
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.slice(0, -1));

  let body: Uint8Array | undefined;
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      body = unwrapIntegrationResult(yield* Effect.result(integrationValue(boundedBody(request.body, auth ? PROJECT_AUTH_BODY_BYTES : MAX_PUBLIC_BODY_BYTES))));
    }
  } catch (error) {
    if (error instanceof RangeError) return { status: 413, headers: { "cache-control": "no-store" }, body: { error: "Request body is too large." } };
    if (auth) return siteUnavailable;
    throw error;
  }

  const timeout = AbortSignal.timeout(PUBLIC_FORWARD_TIMEOUT_MS);
  const signal = request.signal
    ? AbortSignal.any([request.signal, timeout])
    : timeout;

  let response: Response;
  try {
    response = unwrapIntegrationResult(yield* Effect.result(integrationValue((options.fetchSite ?? fetch)(target, {
      method: auth ? "POST" : request.method,
      headers,
      redirect: "manual",
      signal,
      ...(body && body.byteLength > 0 ? { body: body as BodyInit } : {}),
    }))));
  } catch (cause) {
    if (
      cause instanceof Error &&
      (cause.name === "TimeoutError" || cause.name === "AbortError")
    ) {
      return {
        status: 504,
        headers: { "cache-control": "no-store" },
        body: { error: "This site did not respond in time." },
      };
    }
    if (auth) return siteUnavailable;
    throw cause;
  }

  let responseBody: Uint8Array;
  try { responseBody = unwrapIntegrationResult(yield* Effect.result(integrationValue(boundedBody(response.body)))); }
  catch (error) {
    if (error instanceof RangeError) return { status: 502, headers: { "cache-control": "no-store" }, body: { error: "This site returned too much data." } };
    if (auth) return siteUnavailable;
    throw error;
  }

  const responseHeaders = publicResponseHeaders(response.headers);
  if (auth) responseHeaders.set("cache-control", "no-store");
  responseHeaders.delete("set-cookie");
  for (const cookie of response.headers.getSetCookie()) {
    const name = cookie.split("=", 1)[0]?.trim();
    if (name && (auth ? auth === "api" && name === appCookie : !isProtectedCookie(name))) responseHeaders.append("set-cookie", cookie);
  }
  const location = responseHeaders.get("location");
  if (location) {
    try {
      const redirect = new URL(location, target);
      if (redirect.origin === target.origin) {
        responseHeaders.set("location", `${url.origin}${redirect.pathname}${redirect.search}${redirect.hash}`);
      }
    } catch {
      // Preserve the site's original header when URL normalization is impossible.
      responseHeaders.set("location", location);
    }
  }
  return {
    status: response.status,
    headers: responseHeaders,
    body: new Uint8Array(responseBody),
  };
}).pipe(Effect.withSpan("forwardProjectSiteRequest"))); }

/**
 * Guards the Platform control plane against being served on a Project's domain.
 *
 * A hostname bound to a Project is that Project's, not the Platform's. Serving
 * `/zelavis` there puts a Platform login page on every customer domain: the
 * control-plane API stays authenticated, so this is exposure rather than a
 * breach, but it is still the wrong surface in the wrong place.
 *
 * This is a wrapper rather than a route restriction because route `host` fields
 * are an allow-list resolved at composition time, while bindings are added and
 * verified while the Platform runs. It is a wrapper rather than a request hook
 * because hooks observe requests and cannot answer them.
 *
 * Returns `undefined` when the request should proceed normally.
 */
export function guardControlPlaneHost(
  options: PublicDomainForwarderOptions,
  request: Request,
  rootPath: string,
  canonicalPath = true,
): Promise<Response | undefined> {
    return present(Effect.gen(function* (): Effect.fn.Return<Response | undefined, IntegrationFailure> {
  const { domainBindings } = options;
  if (!domainBindings) return undefined;

  const url = new URL(request.url);
  const path = url.pathname;
  let decoded: string;
  try { decoded = decodeURIComponent(path); }
  catch { decoded = path; }
  const withinControlPlane = rootPath === "/" || isSiteControlPlanePath(decoded, rootPath) ||
    isSiteControlPlanePath(decoded, PROJECT_AUTH_ROOT);
  if (!withinControlPlane) return undefined;

  const binding = (yield* integrationValue(resolveVerifiedBinding(domainBindings, url.host)));
  if (!binding?.projectId) return undefined;

  if (canonicalPath && classifyProjectPublicAuthRequest(request.method, path, PROJECT_AUTH_ROOT, PROJECT_AUTH_API)) {
    return toResponse(yield* forwardBoundProject(options, binding.projectId, request));
  }
  if (rootPath === "/" && !isSiteControlPlanePath(decoded, PROJECT_AUTH_ROOT)) {
    const challengeRead = canonicalPath && (request.method === "GET" || request.method === "HEAD");
    if (challengeRead && (path.startsWith("/.well-known/zelavis-challenge/") ||
        (options.acmeChallengeMounted && path.startsWith("/.well-known/acme-challenge/")))) return undefined;
    return toResponse(yield* forwardBoundProject(options, binding.projectId, request));
  }

  // 404 rather than 403: on this host the control plane does not exist, and
  // saying so would confirm which Platform serves the domain.
  return toResponse(siteNotFound);
}));
  }
