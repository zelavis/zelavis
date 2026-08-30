/**
 * Project Gateway: the Platform's proxy into a Project runtime.
 *
 * Extracted from the Platform composition so the trust boundary reads as one
 * unit — target validation, header policy, forwarded authority, and the routes
 * that apply them sit together rather than being spread through a 5,000-line
 * module.
 */
import {
  ZELAVIS_GATEWAY_AUTHORITY_HEADER,
} from "./gateway-authority.js";
import type { ZelavisPrincipal } from "../core/index.js";
import type { FabricApi } from "../core/fabric/index.js";
import type { ZelavisProjectManager } from "../project.js";
import { ZelavisProjectNotFoundError } from "../project.js";
import type {
  ZelavisRouteResponse,
  ZelavisServerRoute,
} from "../core/index.js";

/**
 * Builds the permission set forwarded into a Project runtime.
 *
 * The Gateway sends the caller's real authority instead of a wildcard, so the
 * child enforces its own route requirements against the actual caller. A global
 * `"*"` is not expanded into a downstream wildcard: concrete permissions are
 * listed, keeping the envelope bounded and auditable.
 *
 * Inside a Project runtime the Project *is* the system, so a Project-scoped
 * Platform permission maps onto the runtime's own `system.*` requirement.
 * `system.services.manage` is deliberately excluded from that mapping: it
 * installs and executes host code, so it is forwarded only when the caller
 * holds it at Platform level rather than inferred from Project scope.
 */
export function projectRuntimePermissions(
  principal: ZelavisPrincipal | undefined,
  projectId: string,
): readonly string[] {
  if (!principal) return [];

  const granted = new Set<string>();
  const global = principal.permissions ?? [];
  const hasGlobalWildcard = global.includes("*");

  const addProjectAuthority = (permission: string) => {
    granted.add(permission);
    const mapped = ZELAVIS_PROJECT_TO_RUNTIME_PERMISSION[permission];
    if (mapped) granted.add(mapped);
  };

  for (const permission of global) {
    if (permission === "*") continue;
    addProjectAuthority(permission);
  }

  for (const grant of principal.grants ?? []) {
    const scope = grant.scope;
    const appliesToProject =
      scope === undefined ||
      (scope.type === "project" && scope.projectId === projectId);
    if (!appliesToProject) continue;
    if (grant.permission === "*") {
      for (const permission of ZELAVIS_PROJECT_PERMISSIONS) {
        addProjectAuthority(permission);
      }
      continue;
    }
    addProjectAuthority(grant.permission);
  }

  if (hasGlobalWildcard) {
    for (const permission of ZELAVIS_PROJECT_PERMISSIONS) {
      addProjectAuthority(permission);
    }
    // A Platform-wide wildcard does include host-code authority.
    granted.add("system.services.manage");
  }

  return [...granted].sort();
}

/**
 * How a Project-scoped Platform permission appears inside the Project runtime,
 * where the Project is its own system.
 */
const ZELAVIS_PROJECT_TO_RUNTIME_PERMISSION: Readonly<Record<string, string>> =
  Object.freeze({
    "project.settings.manage": "system.settings.manage",
    "project.users.manage": "system.users.manage",
  });

/**
 * Project-scoped permissions a wildcard authority expands to.
 *
 * Listing them explicitly keeps a forwarded envelope bounded: a future
 * permission is not silently granted to every Project runtime because someone
 * held `"*"` on the Platform.
 */
const ZELAVIS_PROJECT_PERMISSIONS = Object.freeze([
  "project.delete",
  "project.logs.read",
  "project.runtime.manage",
  "project.settings.manage",
  "project.users.manage",
  "project.view",
  "project.website.manage",
]);

/**
 * Ceiling on a Gateway request or response body.
 *
 * Both directions are buffered in full today, so an unbounded body is a memory
 * exhaustion primitive against the Platform. Streaming with backpressure is the
 * real fix and is tracked in `TODO.md`; until then the budget is explicit.
 */
const ZELAVIS_GATEWAY_MAX_BODY_BYTES = 32 * 1024 * 1024;

/** How long the Platform waits on a Project runtime before giving up. */
const ZELAVIS_GATEWAY_TIMEOUT_MS = 30_000;

/**
 * Headers that must never be relayed in either direction.
 *
 * `connection` and friends are hop-by-hop and belong to the single connection
 * they arrived on. `host` and `content-length` are recomputed by the outbound
 * fetch.
 */
const GATEWAY_HOP_BY_HOP_HEADERS = Object.freeze([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/**
 * Builds the outbound header set for a Project Gateway request.
 *
 * Two classes of header are stripped rather than forwarded:
 *
 * - **Platform credentials.** `cookie` and `authorization` authenticate the
 *   caller to the *Platform*. Relaying them hands the Project runtime — which
 *   is ordinary Project code, not a trusted peer — a usable Platform session.
 * - **Client-supplied authority headers.** Every `x-zelavis-*` header is
 *   removed before the Gateway sets its own, so a caller cannot smuggle in an
 *   authority claim and have it survive alongside the Gateway's.
 */
export function gatewayRequestHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const header of GATEWAY_HOP_BY_HOP_HEADERS) {
    headers.delete(header);
  }
  headers.delete("cookie");
  headers.delete("authorization");
  for (const [name] of [...source]) {
    if (name.toLowerCase().startsWith("x-zelavis-")) {
      headers.delete(name);
    }
  }
  return headers;
}

/**
 * Builds the response header set returned from a Project Gateway request.
 *
 * `set-cookie` is dropped: the response is served from the Platform origin, so
 * a Project runtime could otherwise overwrite the Platform session cookie or
 * plant cookies scoped to the Platform. Project-scoped cookies need their own
 * namespaced contract before they can be relayed.
 */
export function gatewayResponseHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const header of GATEWAY_HOP_BY_HOP_HEADERS) {
    headers.delete(header);
  }
  headers.delete("set-cookie");
  return headers;
}

/**
 * Resolves a Project Gateway wildcard path against a Project runtime URL.
 *
 * `new URL(reference, base)` performs URL *reference* resolution, so a
 * caller-supplied value such as `https:/example.com/pwn` or `\\example.com/pwn`
 * resolves to a different origin instead of a path beneath the runtime. The
 * Gateway would then act as a confused deputy and issue the request — with
 * whatever headers it attached — to a host the caller chose.
 *
 * The path is therefore treated as opaque path segments rather than a URL
 * reference, and the result is asserted to stay on the runtime's own origin and
 * beneath its base path.
 *
 * Returns `undefined` when the path cannot be represented safely.
 */
export function resolveProxyTarget(
  runtimeUrl: string,
  wildcardPath: string,
): URL | undefined {
  let base: URL;
  try {
    base = new URL(`${runtimeUrl.replace(/\/+$/, "")}/`);
  } catch {
    return undefined;
  }

  // Control characters (CR/LF included) must never reach the outbound request.
  if (/[\u0000-\u001f\u007f]/.test(wildcardPath)) {
    return undefined;
  }

  const segments = wildcardPath.split("/").filter((segment) => segment !== "");
  const safeSegments: string[] = [];
  for (const segment of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // Malformed percent-encoding.
      return undefined;
    }

    // Reject traversal and anything that could re-introduce a separator or a
    // scheme once the segment is re-encoded.
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(decoded)
    ) {
      return undefined;
    }

    safeSegments.push(encodeURIComponent(decoded));
  }

  const target = new URL(base.href);
  target.pathname = `${base.pathname.replace(/\/+$/, "")}/${safeSegments.join("/")}`;

  // Defence in depth: the construction above cannot change the origin, but
  // assert it rather than assume it.
  if (target.origin !== base.origin) {
    return undefined;
  }
  if (
    target.pathname !== base.pathname.replace(/\/+$/, "") &&
    !target.pathname.startsWith(base.pathname)
  ) {
    return undefined;
  }

  return target;
}

export interface ProjectGatewayDependencies {
  readonly projects: ZelavisProjectManager | undefined;
  readonly fabric: Pick<FabricApi, "getProjectPlacement" | "getNode"> | undefined;
  /** Response used when Project management is not configured on this host. */
  readonly unavailableProjectsResponse: () => ZelavisRouteResponse;
  /** Maps a Project error onto its response. */
  readonly projectErrorResponse: (error: unknown) => ZelavisRouteResponse;
}

/**
 * Builds the Project Gateway proxy routes.
 *
 * One factory rather than five near-identical route objects: method policy,
 * header filtering, target validation, timeouts, and response filtering are
 * defined once, so a change to any of them cannot apply to four verbs and miss
 * the fifth.
 */
export function createProjectGatewayRoutes(
  dependencies: ProjectGatewayDependencies,
): readonly ZelavisServerRoute<any>[] {
  const {
    projects,
    fabric,
    unavailableProjectsResponse,
    projectErrorResponse,
  } = dependencies;

  return (["GET", "POST", "PUT", "PATCH", "DELETE"] as const).map(
    (method) => ({
          id: `runtime.projects.proxy.${method.toLowerCase()}`,
          method,
          path: "/projects/:projectId/proxy/*path",
          access: {
            // A read of the Project runtime is `project.view`; anything that
            // can change it requires runtime-management authority. Using
            // `project.view` for every verb made read access a blanket
            // mutation capability against the child.
            permissions:
              method === "GET"
                ? ["project.view"]
                : ["project.runtime.manage"],
            scope: { type: "project" as const, projectIdParam: "projectId" },
          },
          handler: async ({
            params,
            query,
            request,
            principal,
          }: {
            params: Record<string, string>;
            query: URLSearchParams;
            request: Request;
            principal?: ZelavisPrincipal;
          }) => {
            if (!projects) {
              return unavailableProjectsResponse();
            }
            try {
              const project = await projects.get(params.projectId ?? "");
              if (!project) {
                throw new ZelavisProjectNotFoundError(
                  `Project "${params.projectId ?? ""}" was not found.`,
                );
              }
              if (project.runtime.status !== "running" || !project.runtime.url) {
                return {
                  status: 409,
                  body: { error: `Project "${project.id}" is not running.` },
                };
              }

              const placement = await fabric?.getProjectPlacement(project.id);
              if (
                !placement ||
                placement.identity.type !== "project" ||
                placement.identity.workloadId !== project.id ||
                placement.state !== "active"
              ) {
                return {
                  status: 409,
                  body: {
                    error: `Project "${project.id}" has no active Fabric placement.`,
                  },
                };
              }
              const placementNode = await fabric?.getNode(
                placement.runtimeNodeId,
              );
              if (!placementNode || placementNode.status === "unavailable") {
                return {
                  status: 503,
                  body: {
                    error: `Project "${project.id}" is placed on an unavailable Fabric node.`,
                  },
                };
              }

              const target = resolveProxyTarget(
                project.runtime.url,
                params.path ?? "",
              );
              if (!target) {
                return {
                  status: 400,
                  body: { error: "Invalid Project proxy path." },
                };
              }
              target.search = query.toString();
              const headers = gatewayRequestHeaders(request.headers);
              // The runtime listens on loopback, so plain headers cannot
              // establish who the caller is. Authority is carried in a
              // short-lived envelope signed with a per-runtime secret, and
              // it carries the caller's own Project permissions rather than
              // a wildcard, so proxying never amplifies authority.
              const authority = await projects.signGatewayAuthority(
                project.id,
                {
                  projectId: project.id,
                  scopeId: placement.identity.scopeId,
                  generation: placement.generation,
                  runtimeNodeId: placement.runtimeNodeId,
                  subject: principal?.id ?? "anonymous",
                  subjectType: principal?.type ?? "anonymous",
                  permissions: projectRuntimePermissions(
                    principal,
                    project.id,
                  ),
                },
              );
              if (authority) {
                headers.set(ZELAVIS_GATEWAY_AUTHORITY_HEADER, authority);
              }
              const body =
                request.method === "GET" || request.method === "HEAD"
                  ? undefined
                  : await request.clone().arrayBuffer();
              if (body && body.byteLength > ZELAVIS_GATEWAY_MAX_BODY_BYTES) {
                return {
                  status: 413,
                  body: {
                    error: `Project Gateway bodies are limited to ${ZELAVIS_GATEWAY_MAX_BODY_BYTES} bytes.`,
                  },
                };
              }

              // A child that never answers must not pin a Platform request
              // open indefinitely, and a caller that goes away should release
              // the downstream request with it.
              const timeout = AbortSignal.timeout(
                ZELAVIS_GATEWAY_TIMEOUT_MS,
              );
              const abort = request.signal
                ? AbortSignal.any([request.signal, timeout])
                : timeout;

              let response: Response;
              try {
                response = await fetch(target, {
                  method: request.method,
                  headers,
                  redirect: "manual",
                  signal: abort,
                  ...(body && body.byteLength > 0 ? { body } : {}),
                });
              } catch (cause) {
                if (
                  cause instanceof Error &&
                  (cause.name === "TimeoutError" ||
                    cause.name === "AbortError")
                ) {
                  return {
                    status: 504,
                    body: {
                      error: `Project "${project.id}" did not respond within ${ZELAVIS_GATEWAY_TIMEOUT_MS}ms.`,
                    },
                  };
                }
                throw cause;
              }
              const responseHeaders = gatewayResponseHeaders(response.headers);
              const responseBody = await response.arrayBuffer();
              if (responseBody.byteLength > ZELAVIS_GATEWAY_MAX_BODY_BYTES) {
                return {
                  status: 502,
                  body: {
                    error: `Project "${project.id}" returned a response larger than ${ZELAVIS_GATEWAY_MAX_BODY_BYTES} bytes.`,
                  },
                };
              }
              return {
                status: response.status,
                headers: responseHeaders,
                body: new Uint8Array(responseBody),
              };
            } catch (error) {
              return projectErrorResponse(error);
            }
          },
    }),
  );
}
