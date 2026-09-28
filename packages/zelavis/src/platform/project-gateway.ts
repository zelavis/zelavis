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
import { tenantOfPrincipal } from "./shared.js";
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
  const global = [
    ...(principal.permissions ?? []),
    // System grants authorize runtime-wide routes, but are not blanket
    // Project grants. Only host-code installation is explicitly delegated
    // from this authority below; other Project authority requires a scope.
    ...(principal.grants ?? [])
      .filter((grant) => !grant.scope || grant.scope.type === "system")
      .filter((grant) => grant.permission === "system.services.manage" || grant.permission === "*")
      .map(() => "system.services.manage"),
  ];
  const hasGlobalWildcard = global.includes("*");

  const addProjectAuthority = (permission: string) => {
    granted.add(permission);
    for (const mapped of ZELAVIS_PROJECT_TO_RUNTIME_PERMISSION[permission] ?? []) {
      granted.add(mapped);
    }
  };

  for (const permission of global) {
    if (permission === "*") continue;
    addProjectAuthority(permission);
  }

  for (const grant of principal.grants ?? []) {
    const scope = grant.scope;
    const appliesToProject =
      scope?.type === "project" && scope.projectId === projectId;
    if (!appliesToProject) continue;
    if (grant.permission === "system.services.manage") continue;
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
 * What a Project-scoped Platform permission authorizes inside the Project
 * runtime, where the Project is its own system.
 *
 * A Project runs its own services — workloads, storage, database admin — and
 * they enforce their own permissions. Nothing was mapping to those, so an owner
 * holding full Platform authority reached a Project runtime with none of them
 * and the Project's own workloads, storage, and database screens returned 403.
 *
 * Each entry is an implication, not a convenience: viewing a Project implies
 * seeing what runs in it, and managing its runtime implies changing what runs
 * in it. Anything destructive stays behind runtime management rather than
 * riding along with view.
 */
const ZELAVIS_PROJECT_TO_RUNTIME_PERMISSION: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  "project.settings.manage": Object.freeze(["system.settings.manage"]),
  "project.users.manage": Object.freeze(["system.users.manage"]),
  "project.view": Object.freeze([
    "workloads.view",
    // `inspect` is the operator's cross-Tenant view of the database, which is
    // what the dashboard's table browser is; `read` is the ordinary read of
    // records. Viewing a Project carries both, because the dashboard does both.
    "database.inspect",
    "database.read",
    "storage.read",
  ]),
  // App data authority, deliberately separate from both of its neighbours.
  // Reading a Project is an operator's view of what runs in it; managing its
  // runtime is infrastructure authority. An App reading and writing its own
  // tenant's records is neither, and folding it into either one would mean an
  // App client could only be given data access by being given control-plane
  // authority over the Project it happens to live in.
  "project.data.read": Object.freeze(["database.read"]),
  "project.data.write": Object.freeze(["database.read", "database.write"]),
  "project.logs.read": Object.freeze(["workloads.logs.read"]),
  "project.runtime.manage": Object.freeze([
    "workloads.manage",
    "workloads.logs.read",
    "storage.write",
    "database.read",
    "database.write",
    "database.backup",
    "database.restore",
  ]),
});

/**
 * Project-scoped permissions a wildcard authority expands to.
 *
 * Listing them explicitly keeps a forwarded envelope bounded: a future
 * permission is not silently granted to every Project runtime because someone
 * held `"*"` on the Platform.
 */
const ZELAVIS_PROJECT_PERMISSIONS = Object.freeze([
  "project.data.read",
  "project.data.write",
  "project.delete",
  "project.logs.read",
  "project.runtime.manage",
  "project.settings.manage",
  "project.users.manage",
  "project.view",
  "project.website.manage",
]);

/**
 * Where the App database service is mounted inside a Project runtime.
 *
 * The App data route addresses that service rather than taking a free path, so
 * `project.data.*` cannot be spent on the rest of the Project's control plane.
 */
const PROJECT_DATABASE_PATH_PREFIX = "zelavis/api/v1/database";

/**
 * The data authority a principal holds for one Project, and nothing else.
 *
 * `projectRuntimePermissions` answers what the caller may do to a Project at
 * all; this answers what it may do to that Project's records. Keeping them
 * apart is what stops an App data request from carrying a caller's unrelated
 * workload or storage authority into the child runtime.
 */
export function projectDataPermissions(
  principal: ZelavisPrincipal | undefined,
  projectId: string,
): readonly string[] {
  const held = new Set(
    projectRuntimePermissions(principal, projectId).filter((permission) =>
      permission === "database.read" || permission === "database.write"
    ),
  );
  return [...held];
}

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

/**
 * True when a proxied path addresses the Project runtime's own control plane.
 *
 * Control-plane paths belong to the Zelavis runtime and carry Platform
 * authority. Everything else is the Project's public surface, which a server
 * frontend serves once one is installed.
 */
export function isRuntimeControlPlanePath(wildcardPath: string): boolean {
  const normalized = wildcardPath.replace(/^\/+/, "");
  return normalized === "zelavis" || normalized.startsWith("zelavis/");
}

/**
 * Finds a running server frontend owned by this Project.
 *
 * A Project owns at most one frontend today; the first running one wins rather
 * than failing, so a half-finished replacement cannot take the site down.
 */
export async function findRunningFrontend(
  projects: ZelavisProjectManager,
  projectId: string,
): Promise<{ readonly url: string } | undefined> {
  const owned = await projects.listOwned(projectId).catch(() => []);
  for (const candidate of owned) {
    if (
      candidate.kind === "frontend" &&
      candidate.runtime.status === "running" &&
      candidate.runtime.url
    ) {
      return { url: candidate.runtime.url };
    }
  }
  return undefined;
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

  /**
   * Forwards one request into a Project runtime.
   *
   * Both gateway surfaces share it: placement checks, the signed authority
   * envelope, body limits, timeouts and response filtering are written once,
   * so the App data path cannot quietly drift from the proxy it sits beside.
   */
  const forwardToProject = async (options: {
    readonly projectId: string;
    /** Path inside the Project runtime, already resolved by the caller. */
    readonly wildcardPath: string;
    readonly query: URLSearchParams;
    readonly request: Request;
    readonly principal?: ZelavisPrincipal;
    /** Permissions to sign into the envelope for this request. */
    readonly permissions: readonly string[];
    /**
     * Whether a running server frontend may answer instead of the runtime.
     * Only the public proxy allows it; App data is a control-plane surface.
     */
    readonly allowFrontend: boolean;
  }): Promise<ZelavisRouteResponse> => {
    if (!projects) {
      return unavailableProjectsResponse();
    }
    const project = await projects.get(options.projectId);
    if (!project) {
      throw new ZelavisProjectNotFoundError(
        `Project "${options.projectId}" was not found.`,
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
    const placementNode = await fabric?.getNode(placement.runtimeNodeId);
    if (!placementNode || placementNode.status === "unavailable") {
      return {
        status: 503,
        body: {
          error: `Project "${project.id}" is placed on an unavailable Fabric node.`,
        },
      };
    }

    // A Project's public surface is served by its frontend once one is
    // installed; its control plane always stays with the Zelavis runtime.
    const frontend =
      options.allowFrontend && !isRuntimeControlPlanePath(options.wildcardPath)
        ? await findRunningFrontend(projects, project.id)
        : undefined;

    const target = resolveProxyTarget(
      frontend?.url ?? project.runtime.url,
      options.wildcardPath,
    );
    if (!target) {
      return { status: 400, body: { error: "Invalid Project proxy path." } };
    }
    target.search = options.query.toString();
    const headers = gatewayRequestHeaders(options.request.headers);
    // A frontend is third-party application code, not a Zelavis runtime. It
    // must never receive a Platform authority envelope: the envelope exists so
    // a Zelavis runtime can enforce the caller's permissions, and handing it to
    // arbitrary code would give that code a signed claim about a Platform
    // principal.
    //
    // The runtime, by contrast, listens on loopback where plain headers cannot
    // establish who the caller is. Its authority is a short-lived envelope
    // signed with a per-runtime secret, carrying the caller's own Project
    // permissions rather than a wildcard, so proxying never amplifies
    // authority.
    const authority = frontend
      ? undefined
      : await projects.signGatewayAuthority(project.id, {
          projectId: project.id,
          scopeId: placement.identity.scopeId,
          generation: placement.generation,
          runtimeNodeId: placement.runtimeNodeId,
          subject: options.principal?.id ?? "anonymous",
          subjectType: options.principal?.type ?? "anonymous",
          tenantId: options.principal
            ? tenantOfPrincipal(options.principal)
            : "anonymous",
          permissions: options.permissions,
        });
    if (authority) {
      headers.set(ZELAVIS_GATEWAY_AUTHORITY_HEADER, authority);
    }
    const body =
      options.request.method === "GET" || options.request.method === "HEAD"
        ? undefined
        : await options.request.clone().arrayBuffer();
    if (body && body.byteLength > ZELAVIS_GATEWAY_MAX_BODY_BYTES) {
      return {
        status: 413,
        body: {
          error: `Project Gateway bodies are limited to ${ZELAVIS_GATEWAY_MAX_BODY_BYTES} bytes.`,
        },
      };
    }

    // A child that never answers must not pin a Platform request open
    // indefinitely, and a caller that goes away should release the downstream
    // request with it.
    const timeout = AbortSignal.timeout(ZELAVIS_GATEWAY_TIMEOUT_MS);
    const abort = options.request.signal
      ? AbortSignal.any([options.request.signal, timeout])
      : timeout;

    let response: Response;
    try {
      response = await fetch(target, {
        method: options.request.method,
        headers,
        redirect: "manual",
        signal: abort,
        ...(body && body.byteLength > 0 ? { body } : {}),
      });
    } catch (cause) {
      if (
        cause instanceof Error &&
        (cause.name === "TimeoutError" || cause.name === "AbortError")
      ) {
        // Only the Gateway's own deadline is a gateway timeout. A caller that
        // went away must not be reported as a slow Project: that reads as a
        // runtime fault and sends debugging in the wrong direction entirely.
        if (!timeout.aborted) {
          return {
            status: 499,
            body: {
              error: "The client closed the request before the Project responded.",
            },
          };
        }
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
  };

  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

  const proxyRoutes = methods.map((method) => ({
    id: `runtime.projects.proxy.${method.toLowerCase()}`,
    spec: {
      operationId: `proxyToProject${method[0]}${method.slice(1).toLowerCase()}`,
      summary: "Forward a request to a Project's own runtime",
      description:
        "Everything after `proxy/` is passed through to the Project runtime the Fabric currently places, with the caller's authority carried along.",
      tags: ["runtime"],
      pathParams: {
        projectId: {
          type: "string" as const,
          required: true,
          description: "The Project to forward to.",
        },
        path: {
          type: "string" as const,
          required: true,
          description: "The path within the Project runtime.",
        },
      },
      responses: {
        200: { description: "The Project runtime's response" },
        404: { description: "No such Project" },
        503: { description: "The Project runtime is not reachable" },
      },
    },
    method,
    path: "/projects/:projectId/proxy/*path",
    access: {
      // A read of the Project runtime is `project.view`; anything that can
      // change it requires runtime-management authority. Using `project.view`
      // for every verb made read access a blanket mutation capability against
      // the child.
      permissions:
        method === "GET" ? ["project.view"] : ["project.runtime.manage"],
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
      try {
        return await forwardToProject({
          projectId: params.projectId ?? "",
          wildcardPath: params.path ?? "",
          query,
          request,
          principal,
          permissions: projectRuntimePermissions(
            principal,
            params.projectId ?? "",
          ),
          allowFrontend: true,
        });
      } catch (error) {
        return projectErrorResponse(error);
      }
    },
  }));

  /**
   * The App data surface of a Project.
   *
   * An App reaching its own records must not have to come through the proxy
   * above, because that proxy is gated on Platform authority: every write
   * would require `project.runtime.manage`, which is permission to manage the
   * Project's runtime. Data access is its own authority here, and the tenant is
   * resolved from the caller and signed into the envelope rather than read from
   * the request, so an App client can address only its own records.
   */
  const dataRoutes = methods.map((method) => ({
    id: `runtime.projects.data.${method.toLowerCase()}`,
    spec: {
      operationId: `projectData${method[0]}${method.slice(1).toLowerCase()}`,
      summary: "Read or write a Project's App data",
      description:
        "Forwards to the Project's database service as the caller's own App Tenant. Reads require `project.data.read` and writes `project.data.write`; neither grants any Platform authority over the Project.",
      tags: ["data"],
      pathParams: {
        projectId: {
          type: "string" as const,
          required: true,
          description: "The App Project holding the data.",
        },
        path: {
          type: "string" as const,
          required: true,
          description:
            "The path within the Project's database service, such as `documents/collections`.",
        },
      },
      responses: {
        200: { description: "The database service's response" },
        403: { description: "The caller holds no App data authority here" },
        404: { description: "No such Project" },
        503: { description: "The Project runtime is not reachable" },
      },
    },
    method,
    path: "/projects/:projectId/data/*path",
    access: {
      permissions:
        method === "GET" ? ["project.data.read"] : ["project.data.write"],
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
      try {
        const path = (params.path ?? "").replace(/^\/+/, "");
        if (!path) {
          return {
            status: 400,
            body: { error: "A database path is required." },
          };
        }
        return await forwardToProject({
          projectId: params.projectId ?? "",
          wildcardPath: `${PROJECT_DATABASE_PATH_PREFIX}/${path}`,
          query,
          request,
          principal,
          // Only the data implications travel with an App data request. The
          // caller's other Project authority, if it happens to hold any, is
          // not this request's business and must not ride along into the
          // child where it would widen what the request can reach.
          permissions: projectDataPermissions(
            principal,
            params.projectId ?? "",
          ),
          allowFrontend: false,
        });
      } catch (error) {
        return projectErrorResponse(error);
      }
    },
  }));

  return [...proxyRoutes, ...dataRoutes];
}
