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
import type { ZelavisRouteResponse } from "../core/index.js";

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
export async function resolveVerifiedBinding(
  bindings: DomainBindingStore,
  host: string,
): Promise<DomainBinding | undefined> {
  const normalized = host.toLowerCase().split(":")[0] ?? "";
  if (!normalized) return undefined;

  const binding = await bindings.get(normalized).catch(() => undefined);
  if (!binding || !binding.verifiedAt || !binding.projectId) return undefined;
  return binding;
}

function publicResponseHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const header of PUBLIC_RESPONSE_HOP_BY_HOP) headers.delete(header);
  return headers;
}

/**
 * Forwards one public request, or returns `undefined` when the host is not a
 * verified binding and the caller should serve its own response.
 */
export async function forwardPublicRequest(
  options: PublicDomainForwarderOptions,
  request: Request,
): Promise<ZelavisRouteResponse | undefined> {
  const { domainBindings } = options;
  const projects = options.projects?.();
  if (!domainBindings || !projects) return undefined;

  const url = new URL(request.url);
  const binding = await resolveVerifiedBinding(domainBindings, url.host);
  if (!binding?.projectId) return undefined;

  const project = await projects.get(binding.projectId).catch(() => undefined);
  if (!project) return undefined;

  if (project.runtime.status !== "running" || !project.runtime.url) {
    return {
      status: 503,
      headers: { "cache-control": "no-store" },
      body: { error: "This site is not running." },
    };
  }

  // A visitor reaches the Project's public surface. Its control plane is not
  // published on a bound domain: it is reached through the dashboard, where the
  // caller has a Platform identity.
  const path = url.pathname.replace(/^\/+/, "");
  if (path === "zelavis" || path.startsWith("zelavis/")) {
    return { status: 404, body: { error: "Not found" } };
  }

  const frontend = await findRunningFrontend(projects, project.id);
  const target = resolveProxyTarget(
    frontend?.url ?? project.runtime.url,
    path,
  );
  if (!target) return { status: 400, body: { error: "Invalid path." } };
  target.search = url.search.replace(/^\?/, "");

  // No authority envelope: a visitor has no Platform identity, and the target
  // may be third-party frontend code.
  const headers = gatewayRequestHeaders(request.headers);

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.clone().arrayBuffer();
  if (body && body.byteLength > MAX_PUBLIC_BODY_BYTES) {
    return { status: 413, body: { error: "Request body is too large." } };
  }

  const timeout = AbortSignal.timeout(PUBLIC_FORWARD_TIMEOUT_MS);
  const signal = request.signal
    ? AbortSignal.any([request.signal, timeout])
    : timeout;

  let response: Response;
  try {
    response = await fetch(target, {
      method: request.method,
      headers,
      redirect: "manual",
      signal,
      ...(body && body.byteLength > 0 ? { body } : {}),
    });
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
    throw cause;
  }

  const responseBody = await response.arrayBuffer();
  if (responseBody.byteLength > MAX_PUBLIC_BODY_BYTES) {
    return { status: 502, body: { error: "This site returned too much data." } };
  }

  return {
    status: response.status,
    // `set-cookie` is deliberately preserved: this response is served from the
    // Project's own domain, so its cookies are its own.
    headers: publicResponseHeaders(response.headers),
    body: new Uint8Array(responseBody),
  };
}
