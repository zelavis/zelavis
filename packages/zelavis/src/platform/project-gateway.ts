import {
  REGISTRATION_SETTINGS_BODY_BYTES,
  registrationSettingsInputJsonSchema,
  registrationSettingsJsonSchema,
} from "../auth/registration/policy.js";
import {
  ACCOUNT_ACCESS_BODY_BYTES,
  accountAccessInputJsonSchema,
  accountAccessResultJsonSchema,
  decodeProjectAccountAuthority,
  decodeSetAccountAccessInput,
  projectAccountAccessDigest,
  projectAccountAccessPermissions,
} from "../auth/access/access.js";
import { accessInputFits } from "../auth/access/delegation.js";
import { invitationGatewayDigest } from "../auth/invitations/invitations.js";
import { INVITATION_ID } from "../auth/invitations/tables.js";
import { decodeInvitationInput, invitationError, invitationOperations, invitationOperationSpec } from "../auth/routes/invitations.js";
import { type RoleDefinition, decodeRoleCatalogueView } from "../auth/roles/catalogue.js";
import { roleContentPermissions } from "../auth/roles/roles.js";
import { decodeRoleInput, revisionOf, roleGatewayDigest, roleOperationSpec, roleOperations, roleRefused } from "../auth/routes/roles.js";
import { RoleIdSchema } from "../auth/access/access.js";
import { parseJsonObject } from "../core/json-validation.js";
/**
 * Project Gateway: the Platform's proxy into a Project runtime.
 *
 * Extracted from the Platform composition so the trust boundary reads as one
 * unit — target validation, header policy, forwarded authority, and the routes
 * that apply them sit together rather than being spread through a 5,000-line
 * module.
 */
import {
  setGatewayDispatchHeaders,
} from "./gateway-authority.js";
import { Cause, Effect, Schema } from "effect";
import { requestClientAddress, setRequestClientAddress } from "../core/runtime/client-address.js";
import {
  EMAIL_SETTINGS_BODY_BYTES,
  EMAIL_TEST_BODY_BYTES,
  emailDeliveryPageJsonSchema,
  emailSettingsInputJsonSchema,
  emailSettingsJsonSchema,
  emailTestInputJsonSchema,
} from "../app/email/contracts.js";
import { evaluate, integration, present, unwrapFailure, integrationValue, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
import type { ZelavisPrincipal } from "../core/index.js";
import { principalHasPermission } from "../core/runtime/request-dispatcher.js";
import { tenantOfPrincipal } from "./shared.js";
import type { FabricApi } from "../core/fabric/index.js";
import type { ZelavisProjectManager, ZelavisProjectRemoteRoute } from "../project.js";
import { isCanonicalProjectId, ZelavisProjectNotFoundError } from "../project.js";
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
  "project.data.define": Object.freeze(["database.define"]),
  "project.logs.read": Object.freeze(["workloads.logs.read"]),
  "project.runtime.manage": Object.freeze([
    "workloads.manage",
    "workloads.logs.read",
    "storage.write",
    "storage.manage",
    "database.read",
    "database.write",
    "database.define",
    "database.backup",
    "database.restore",
    "database.drop",
    // Cross-Tenant indexes read every Tenant, so defining one is the
    // Project's infrastructure authority, not an App client's data authority.
    "database.indexes.manage",
    // A follower on another host reads every record and log entry of the
    // partitions it follows, holds their logs and reports what it holds.
    "database.replicate",
    // Placing shards on other Nodes is the Project's infrastructure authority.
    "database.shards.manage",
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
  "project.data.define",
  "project.delete",
  "project.logs.read",
  "project.runtime.manage",
  "project.settings.manage",
  "project.setup.reveal",
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
      permission === "database.read" || permission === "database.write" || permission === "database.define"
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
  for (const [index, segment] of segments.entries()) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // Malformed percent-encoding.
      return undefined;
    }

    // The asset API carries a scoped npm name as one encoded parameter.
    // Keep that slash encoded; no other path may introduce a separator.
    const packageAsset = index === 5 && segments.slice(0, 5).join("/") === "zelavis/api/v1/runtime/service-page-assets" &&
      /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(decoded);
    // Reject traversal and anything that could re-introduce a separator or a
    // scheme once the segment is re-encoded.
    if (
      decoded === "." ||
      decoded === ".." ||
      (decoded.includes("/") && !packageAsset) ||
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
export function findRunningFrontend(
  projects: Pick<ZelavisProjectManager, "listOwned">,
  projectId: string,
): Promise<{ readonly url: string } | undefined> {
    return present(Effect.gen(function* (): Effect.fn.Return<{ readonly url: string } | undefined, IntegrationFailure> {
  const owned = (yield* integrationValue(projects.listOwned(projectId).catch(() => [])));
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
}));
  }

export interface ProjectGatewayDependencies {
  readonly projects: ZelavisProjectManager | undefined;
  readonly fabric: Pick<FabricApi, "getProjectPlacement" | "getNode"> | undefined;
  /** Response used when Project management is not configured on this host. */
  readonly unavailableProjectsResponse: () => ZelavisRouteResponse;
  /** Maps a Project error onto its response. */
  readonly projectErrorResponse: (error: unknown) => ZelavisRouteResponse;
}

/** The caller's address, as a signed claim, when this request has a trusted one. */
const clientAddressClaim = (request: Request): { readonly clientAddress?: string } => {
  const clientAddress = requestClientAddress(request);
  return clientAddress === undefined ? {} : { clientAddress };
};
/** A request rebuilt from another keeps that request's caller address. */
const sameClient = (from: Request, to: Request): Request => {
  setRequestClientAddress(to, requestClientAddress(from));
  return to;
};

export type ProjectForwardOptions = {
  readonly projectId: string;
  /** Path inside the Project runtime, already resolved by the caller. */
  readonly wildcardPath: string;
  readonly query: URLSearchParams;
  readonly request: Request;
  readonly principal?: ZelavisPrincipal;
  /** Permissions to sign into the envelope for this request. */
  readonly permissions: readonly string[];
  readonly accountAccessDigest?: string;
  /**
   * Whether a running server frontend may answer instead of the runtime.
   * Only the public proxy allows it; App data is a control-plane surface.
   */
  readonly allowFrontend: boolean;
};

/**
 * The one way the Platform reaches into a Project runtime.
 *
 * Shared by the Gateway routes and by anything else that acts for a caller
 * (the Assistant's tools), so placement checks, the signed authority envelope,
 * body limits, timeouts and response filtering are written once.
 */
export function createProjectForwarder(
  dependencies: ProjectGatewayDependencies,
): (options: ProjectForwardOptions) => Promise<ZelavisRouteResponse> {
  const { projects, fabric, unavailableProjectsResponse } = dependencies;

  const forwardRemote = Effect.fn("ProjectGateway.forwardRemote")(function* (projectId: string, remote: ZelavisProjectRemoteRoute, options: ProjectForwardOptions) {
    const target = resolveProxyTarget("http://project.invalid", options.wildcardPath);
    if (!target) return { status: 400, body: { error: "Invalid Project proxy path." } };
    target.search = options.query.toString();
    const body = options.request.method === "GET" || options.request.method === "HEAD"
      ? undefined
      : yield* integration(() => options.request.clone().arrayBuffer());
    if (body && body.byteLength > ZELAVIS_GATEWAY_MAX_BODY_BYTES) {
      return { status: 413, body: { error: `Project Gateway bodies are limited to ${ZELAVIS_GATEWAY_MAX_BODY_BYTES} bytes.` } };
    }
    const placement = yield* integration(() => fabric?.getProjectPlacement(projectId));
    const answer = yield* Effect.result(integration(() => remote.send({
      method: options.request.method,
      path: `${target.pathname}${target.search}`,
      gateway: {
        projectId,
        scopeId: placement?.identity.scopeId ?? "platform",
        generation: remote.placement.epoch,
        runtimeNodeId: remote.nodeId,
        subject: options.principal?.id ?? "anonymous",
        subjectType: options.principal?.type ?? "anonymous",
        tenantId: options.principal ? tenantOfPrincipal(options.principal) : "anonymous",
        permissions: options.permissions,
        ...(options.accountAccessDigest === undefined ? {} : { accountAccessDigest: options.accountAccessDigest }),
        ...clientAddressClaim(options.request),
      },
      headers: [...gatewayRequestHeaders(options.request.headers)],
      ...(body && body.byteLength > 0 ? { body: new Uint8Array(body) } : {}),
    }), { interruptible: true }));
    if (answer._tag === "Failure") {
      return { status: 502, body: { error: `Project "${projectId}" on node "${remote.nodeId}" could not be reached.` } };
    }
    return { status: answer.success.status, headers: gatewayResponseHeaders(new Headers(answer.success.headers as [string, string][])), body: answer.success.body };
  });

  const forward = Effect.fn("ProjectGateway.forward")(function* (options: ProjectForwardOptions) {
    if (!projects) {
      return unavailableProjectsResponse();
    }
    // A view, not a locked read: a live update holds the Project's lifecycle for its whole length,
    // and requests must keep reaching the serving runtime, waiting only at its own handover.
    const project = yield* integration(() => projects.view(options.projectId));
    if (!project) {
      return yield* Effect.fail(new ZelavisProjectNotFoundError(
        `Project "${options.projectId}" was not found.`,
      ));
    }
    // A Project placed on another node has no runtime URL here: its Agent verifies a signed request and forwards it.
    const remote = yield* integration(() => projects.remoteRoute?.(project.id));
    if (remote) return yield* forwardRemote(project.id, remote, options);
    if (project.runtime.status !== "running" || !project.runtime.url) {
      return {
        status: 409,
        body: { error: `Project "${project.id}" is not running.` },
      };
    }

    const placement = yield* integration(() => fabric?.getProjectPlacement(project.id));
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
    const placementNode = yield* integration(() => fabric?.getNode(placement.runtimeNodeId));
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
        ? yield* integration(() => findRunningFrontend(projects, project.id))
        : undefined;

    const controlPlane = isRuntimeControlPlanePath(options.wildcardPath);
    // While the Project's serving processes are being replaced the request waits instead of failing.
    if (!frontend) yield* integration(() => projects.ingressReady?.(project.id));
    const runtimeUrl = controlPlane && projects.gatewayTarget
      ? yield* integration(() => projects.gatewayTarget!(project.id)) : project.runtime.url;
    if (controlPlane && !runtimeUrl) return { status: 503, body: { error: "Project integration runtime is unavailable." } };
    const target = resolveProxyTarget(
      frontend?.url ?? runtimeUrl!,
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
    const authority = frontend || (project.recipe.managed && !controlPlane)
      ? undefined
      : yield* integration(() => projects.signGatewayAuthority(project.id, {
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
          ...(options.accountAccessDigest === undefined ? {} : { accountAccessDigest: options.accountAccessDigest }),
          ...clientAddressClaim(options.request),
        }));
    if (authority) {
      setGatewayDispatchHeaders(headers, authority);
    }
    const body =
      options.request.method === "GET" || options.request.method === "HEAD"
        ? undefined
        : yield* integration(() => options.request.clone().arrayBuffer());
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

    const result = yield* Effect.result(integration(() => fetch(target, {
        method: options.request.method,
        headers,
        redirect: "manual",
        signal: abort,
        ...(body && body.byteLength > 0 ? { body } : {}),
      }), { interruptible: true }));
    if (result._tag === "Failure") {
      const cause = unwrapFailure(result.failure);
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
      return yield* result.failure;
    }
    const response = result.success;
    const responseHeaders = gatewayResponseHeaders(response.headers);
    const responseBody = yield* integration(() => response.arrayBuffer());
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
  });
  return options => present(forward(options));
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
  const { projectErrorResponse } = dependencies;
  const forwardToProject = createProjectForwarder(dependencies);

  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

  const registrationSettingsRoutes: readonly ZelavisServerRoute[] = (["GET", "PUT"] as const).map<ZelavisServerRoute>((method) => {
    const write = method === "PUT";
    const writeResponses: Record<number, { description: string }> = write ? {
      400: { description: "Invalid registration settings" },
      413: { description: "Request exceeds 1024 bytes" },
    } : {};
    return {
      id: `runtime.projects.auth.registration.settings.${write ? "set" : "get"}`,
      method,
      path: "/projects/:projectId/auth/registration/settings",
      access: {
        permissions: ["project.settings.manage"],
        scope: { type: "project", projectIdParam: "projectId" },
      },
      ...(write ? {
        maxRequestBodyBytes: REGISTRATION_SETTINGS_BODY_BYTES,
        invalidJsonBodyCode: "invalid_registration",
      } : {}),
      spec: {
        operationId: write ? "setProjectRegistrationSettings" : "projectRegistrationSettings",
        summary: write ? "Update a Project's registration settings" : "Read a Project's registration settings",
        tags: ["runtime", "auth"],
        pathParams: { projectId: { type: "string", required: true } },
        ...(write ? { requestBody: { required: true, schema: registrationSettingsInputJsonSchema } } : {}),
        responses: {
          200: { description: "Project registration setting and revision", schema: registrationSettingsJsonSchema },
          ...writeResponses,
          403: { description: "Project settings permission required" },
          404: { description: "No such Project" },
          409: { description: "Project unavailable or settings revision has changed" },
          503: { description: "Project registration settings unavailable" },
        },
      },
      handler: ({ params, request, principal }) => present(Effect.gen(function* () {
        return yield* integration(() => forwardToProject({
          projectId: params.projectId,
          wildcardPath: "zelavis/api/v1/auth/registration/settings",
          query: new URLSearchParams(),
          request,
          principal,
          permissions: ["project.settings.manage"],
          allowFrontend: false,
        }));
      }).pipe(Effect.catchCause((cause) => Effect.succeed(projectErrorResponse(unwrapFailure(Cause.squash(cause))))))),
    };
  });

  // An App's own Auth settings, forwarded to exactly the child's `/auth/...` route: sign-in methods, passkeys, OAuth
  // connections, the MFA policy and signing-key rotation.
  const authSettingsRoutes: readonly ZelavisServerRoute[] = ([
    { action: "methods.settings.get", method: "GET", path: "methods/settings", operationId: "projectAuthMethodSettings", summary: "Read a Project's enabled sign-in methods" },
    { action: "methods.settings.set", method: "PUT", path: "methods/settings", operationId: "setProjectAuthMethodSettings", summary: "Choose a Project's enabled sign-in methods", bodyBytes: 4096 },
    { action: "passkeys.settings.get", method: "GET", path: "passkeys/settings", operationId: "projectPasskeySettings", summary: "Read a Project's passkey relying party" },
    { action: "passkeys.settings.set", method: "PUT", path: "passkeys/settings", operationId: "setProjectPasskeySettings", summary: "Set a Project's passkey relying party", bodyBytes: 4096 },
    { action: "oauth.connections.list", method: "GET", path: "oauth/connections", operationId: "projectOAuthConnections", summary: "List a Project's OAuth connections" },
    { action: "oauth.connections.configure", method: "PUT", path: "oauth/connections/:provider", operationId: "configureProjectOAuthConnection", summary: "Configure one of a Project's OAuth connections", bodyBytes: 16384 },
    { action: "oauth.connections.remove", method: "DELETE", path: "oauth/connections/:provider", operationId: "removeProjectOAuthConnection", summary: "Remove one of a Project's OAuth connections" },
    { action: "mfa.policy.get", method: "GET", path: "mfa/policy", operationId: "projectMfaPolicy", summary: "Read a Project's MFA policy" },
    { action: "mfa.policy.set", method: "PUT", path: "mfa/policy", operationId: "setProjectMfaPolicy", summary: "Set a Project's MFA policy", bodyBytes: 1024 },
    { action: "keys.rotate", method: "POST", path: "keys/rotate", operationId: "rotateProjectAuthKeys", summary: "Rotate a Project's access-token signing key" },
  ] as const).map<ZelavisServerRoute>((route) => ({
    id: `runtime.projects.auth.${route.action}`,
    method: route.method,
    path: `/projects/:projectId/auth/${route.path}`,
    access: { permissions: ["project.settings.manage"], scope: { type: "project", projectIdParam: "projectId" } },
    ...("bodyBytes" in route ? { maxRequestBodyBytes: route.bodyBytes, invalidJsonBodyCode: "invalid_request" } : {}),
    spec: {
      operationId: route.operationId,
      summary: route.summary,
      tags: ["runtime", "auth"],
      pathParams: {
        projectId: { type: "string", required: true },
        ...(route.path.includes(":provider") ? { provider: { type: "string", required: true } } : {}),
      },
      ...("bodyBytes" in route ? { requestBody: { required: true, schema: { type: "object", additionalProperties: true } } } : {}),
      responses: {
        200: { description: "The child's answer" },
        403: { description: "Project settings permission required" },
        404: { description: "No such Project" },
        409: { description: "Project unavailable or the settings revision has changed" },
        503: { description: "Project Auth unavailable" },
      },
    },
    handler: ({ params, request, principal }) => present(Effect.gen(function* () {
      const provider = params.provider;
      if (route.path.includes(":provider") && (!provider || !/^[A-Za-z0-9_-]{1,64}$/u.test(provider))) {
        return { status: 400, body: { error: "Invalid provider.", code: "invalid_request" } };
      }
      return yield* integration(() => forwardToProject({
        projectId: params.projectId,
        wildcardPath: `zelavis/api/v1/auth/${route.path.replace(":provider", provider ?? "")}`,
        query: new URLSearchParams(),
        request,
        principal,
        permissions: ["project.settings.manage"],
        allowFrontend: false,
      }));
    }).pipe(Effect.catchCause((cause) => Effect.succeed(projectErrorResponse(unwrapFailure(Cause.squash(cause))))))),
  }));

  // An App's own email settings, test send and deliveries, forwarded to exactly its `/email` routes.
  const emailRoutes: readonly ZelavisServerRoute[] = ([
    { action: "settings.get", method: "GET", path: "settings", operationId: "projectEmailSettings", summary: "Read a Project's email delivery settings",
      ok: { 200: { description: "Project email settings and revision", schema: emailSettingsJsonSchema } } },
    { action: "settings.set", method: "PUT", path: "settings", operationId: "setProjectEmailSettings", summary: "Update a Project's email delivery settings",
      bodyBytes: EMAIL_SETTINGS_BODY_BYTES, requestSchema: emailSettingsInputJsonSchema,
      ok: { 200: { description: "Updated Project email settings", schema: emailSettingsJsonSchema }, 400: { description: "Invalid email settings" } } },
    { action: "test.send", method: "POST", path: "test", operationId: "sendProjectTestEmail", summary: "Queue a test message from a Project",
      bodyBytes: EMAIL_TEST_BODY_BYTES, requestSchema: emailTestInputJsonSchema,
      ok: { 202: { description: "Queued delivery id" }, 400: { description: "Invalid address" }, 429: { description: "Too many deliveries waiting" } } },
    { action: "deliveries.list", method: "GET", path: "deliveries", operationId: "listProjectEmailDeliveries", summary: "List a Project's email deliveries, oldest first",
      query: true, ok: { 200: { description: "A page of deliveries", schema: emailDeliveryPageJsonSchema }, 400: { description: "Invalid limit or cursor" } } },
  ] as const).map<ZelavisServerRoute>((route) => ({
    id: `runtime.projects.email.${route.action}`,
    method: route.method,
    path: `/projects/:projectId/email/${route.path}`,
    access: { permissions: ["project.settings.manage"], scope: { type: "project", projectIdParam: "projectId" } },
    ...("bodyBytes" in route ? { maxRequestBodyBytes: route.bodyBytes, invalidJsonBodyCode: "invalid_email_settings" } : {}),
    spec: {
      operationId: route.operationId,
      summary: route.summary,
      tags: ["runtime", "email"],
      pathParams: { projectId: { type: "string", required: true } },
      ...("requestSchema" in route ? { requestBody: { required: true, schema: route.requestSchema } } : {}),
      ...("query" in route ? { queryParams: {
        limit: { type: "integer", description: "Page size, 1-100 (default 50)." },
        after: { type: "string", description: "The `next` cursor of the previous page." },
      } } : {}),
      responses: {
        ...route.ok,
        403: { description: "Project settings permission required" },
        404: { description: "No such Project" },
        409: { description: "Project unavailable, email disabled or settings revision has changed" },
        503: { description: "Project email unavailable" },
      },
    },
    handler: ({ params, request, principal, query }) => present(Effect.gen(function* () {
      // Only the listing's own parameters reach the child.
      const forwarded = new URLSearchParams();
      if ("query" in route) for (const name of ["limit", "after"]) {
        const value = query.get(name);
        if (value !== null) forwarded.set(name, value);
      }
      return yield* integration(() => forwardToProject({
        projectId: params.projectId,
        wildcardPath: `zelavis/api/v1/email/${route.path}`,
        query: forwarded,
        request,
        principal,
        permissions: ["project.settings.manage"],
        allowFrontend: false,
      }));
    }).pipe(Effect.catchCause((cause) => Effect.succeed(projectErrorResponse(unwrapFailure(Cause.squash(cause))))))),
  }));

  const mayDelegateProjectPermission = (principal: ZelavisPrincipal | undefined, projectId: string, permission: string) =>
    principalHasPermission(principal, permission, { type: "project", projectId }) &&
    (permission !== "system.services.manage" || principal?.permissions?.includes(permission) === true ||
      principal?.permissions?.includes("*") === true);

  /**
   * An App's role catalogue as its own `GET /auth/roles` answers it, read by
   * the caller's authority: what the Gateway checks a role change or an
   * assignment against before it signs. The App compares the signed names
   * with its catalogue again, so a role changed in between is refused there.
   */
  type ProjectRoles = { readonly response: ZelavisRouteResponse } | { readonly roles: ReadonlyMap<string, RoleDefinition> };
  const readProjectRoles = (projectId: string, request: Request, principal: ZelavisPrincipal | undefined): Effect.Effect<ProjectRoles, IntegrationFailure> => Effect.gen(function* () {
    const read = yield* integration(() => forwardToProject({
      projectId, principal, permissions: ["project.users.manage"], allowFrontend: false,
      wildcardPath: "zelavis/api/v1/auth/roles",
      query: new URLSearchParams(),
      request: sameClient(request, new Request(request.url, { headers: request.headers, signal: request.signal })),
    }));
    if (read.status !== 200) return { response: read };
    const invalid: ProjectRoles = { response: { status: 502, body: { error: "Invalid Project role response." } } };
    if (!(read.body instanceof Uint8Array)) return invalid;
    const bytes = read.body;
    const view = yield* Effect.result(evaluate(() => decodeRoleCatalogueView(parseJsonObject(new TextDecoder().decode(bytes)))));
    if (view._tag === "Failure") return invalid;
    return { roles: new Map(view.success.roles.map((role) => [role.id, role])) };
  });

  const isRoleId = Schema.is(RoleIdSchema);
  const roleRoutes = roleOperations.map<ZelavisServerRoute>((operation) => ({
    ...roleOperationSpec(operation, true),
    id: `runtime.projects.auth.roles.${operation.action}`,
    method: operation.method,
    path: `/projects/:projectId/auth${operation.path}`,
    access: { permissions: ["project.users.manage"], scope: { type: "project", projectIdParam: "projectId" } },
    handler: ({ params: { projectId, roleId }, request, principal, body, query }) => present(Effect.gen(function* () {
      if (!isCanonicalProjectId(projectId) || ("hasId" in operation && !isRoleId(roleId ?? ""))) return roleRefused({ code: "invalid_role" });
      const path = operation.path.replace(":roleId", roleId ?? "");
      const forwarded = new URLSearchParams();
      let accountAccessDigest: string | undefined;
      if (operation.action === "delete") {
        // Deleting takes authority away: the digest binds the exact deletion, and no delegation is checked.
        const revision = revisionOf(query.get("revision"));
        if (revision === undefined) return roleRefused({ code: "invalid_role", message: "Name the catalogue revision: ?revision=N." });
        forwarded.set("revision", String(revision));
        accountAccessDigest = yield* roleGatewayDigest("DELETE", path, revision, []);
      } else if (operation.action !== "list") {
        const input = decodeRoleInput(body);
        if (input === undefined || (operation.action === "update" && input.id !== roleId)) return roleRefused({ code: "invalid_role" });
        // A change must be delegable as it was and as it will be.
        const current = operation.action === "update" ? yield* readProjectRoles(projectId, request, principal) : undefined;
        if (current !== undefined && "response" in current) return current.response;
        const names = roleContentPermissions(input, current?.roles.get(input.id));
        if (names.some((permission) => !mayDelegateProjectPermission(principal, projectId, permission))) return roleRefused({ code: "account_access_forbidden" });
        accountAccessDigest = yield* roleGatewayDigest(operation.method, path, input, names);
      }
      return yield* integration(() => forwardToProject({
        projectId, wildcardPath: `zelavis/api/v1/auth${path}`, query: forwarded, request, principal,
        permissions: ["project.users.manage"], ...(accountAccessDigest === undefined ? {} : { accountAccessDigest }), allowFrontend: false,
      }));
    }).pipe(Effect.catchCause((cause) => Effect.succeed(projectErrorResponse(unwrapFailure(Cause.squash(cause))))))),
  }));

  const invitationRoutes = invitationOperations.map<ZelavisServerRoute>((operation) => ({
    ...invitationOperationSpec(operation, true),
    id: `runtime.projects.auth.invitations.${operation.action}`,
    method: operation.method,
    path: `/projects/:projectId/auth${operation.path}`,
    access: { permissions: ["project.users.manage"], scope: { type: "project", projectIdParam: "projectId" } },
    handler: ({ params: { projectId, id }, request, principal, body, query }) => present(Effect.gen(function* () {
      if (!isCanonicalProjectId(projectId) || ("hasId" in operation && !INVITATION_ID.test(id ?? ""))) {
        return invitationError("invalid_invitation");
      }
      const input = operation.action === "create" ? decodeInvitationInput(body) : undefined;
      if (operation.action === "create" && input === undefined) return invitationError("invalid_invitation_input");
      if (input !== undefined && (!accessInputFits({ authority: "project", projectId }, input.access) ||
          input.access.grants.some((grant) => !mayDelegateProjectPermission(principal, projectId, grant.permission)))) {
        return invitationError("account_access_forbidden");
      }
      if (input !== undefined && input.access.roleAssignments.length > 0) {
        // The App accepts a Gateway invitation as the Gateway vouched for it, so the roles it assigns are checked here.
        const read = yield* readProjectRoles(projectId, request, principal);
        if ("response" in read) return read.response;
        if (input.access.roleAssignments.some(({ roleId }) => !read.roles.has(roleId))) return invitationError("role_not_found");
        const names = roleContentPermissions(...input.access.roleAssignments.map(({ roleId }) => read.roles.get(roleId)));
        if (names.some((permission) => !mayDelegateProjectPermission(principal, projectId, permission))) return invitationError("account_access_forbidden");
      }

      const path = operation.path.replace(":id", id ?? "");
      const forwarded = new URLSearchParams();
      if (operation.action === "list") for (const name of ["limit", "after"]) {
        const value = query.get(name);
        if (value !== null) forwarded.set(name, value);
      }
      const accountAccessDigest = yield* invitationGatewayDigest(operation.method, path, input);
      return yield* integration(() => forwardToProject({
        projectId, wildcardPath: `zelavis/api/v1/auth${path}`, query: forwarded, request, principal,
        permissions: ["project.users.manage"], accountAccessDigest, allowFrontend: false,
      }));
    }).pipe(Effect.catchCause((cause) => Effect.succeed(projectErrorResponse(unwrapFailure(Cause.squash(cause))))))),
  }));

  const accountAccessRoute: ZelavisServerRoute = {
    id: "runtime.projects.auth.accounts.access.set",
    method: "PUT",
    path: "/projects/:projectId/auth/accounts/:accountId/access",
    access: { permissions: ["project.users.manage"], scope: { type: "project", projectIdParam: "projectId" } },
    maxRequestBodyBytes: ACCOUNT_ACCESS_BODY_BYTES,
    invalidJsonBodyCode: "invalid_account_access",
    spec: {
      operationId: "setProjectAccountAccess",
      summary: "Replace a human account's access in one Project",
      tags: ["runtime", "auth"],
      pathParams: { projectId: { type: "string", required: true }, accountId: { type: "string", required: true } },
      requestBody: { required: true, schema: accountAccessInputJsonSchema },
      responses: {
        200: { description: "Current account access and revision", schema: accountAccessResultJsonSchema },
        400: { description: "Invalid account access" },
        403: { description: "Delegation or account modification forbidden" },
        404: { description: "Project or account not found" },
        409: { description: "Project unavailable or account access revision changed" },
        503: { description: "Project unavailable or access changed but its security event could not be recorded" },
      },
    },
    handler: ({ params: { projectId, accountId }, request, principal, body }) => present(Effect.gen(function* () {
      const invalid = { status: 400, body: { error: "Invalid account access.", code: "invalid_account_access" } };
      const forbidden = { status: 403, body: { error: "The caller cannot delegate this account access.", code: "account_access_forbidden" } };
      const decoded = yield* Effect.result(evaluate(() => decodeSetAccountAccessInput(body)));
      if (decoded._tag === "Failure" || !isCanonicalProjectId(projectId) ||
          !accountId || accountId === "." || accountId === "..") return invalid;
      const input = decoded.success;
      const canDelegate = (permission: string) => mayDelegateProjectPermission(principal, projectId, permission);
      if (!accessInputFits({ authority: "project", projectId }, input) ||
          input.grants.some((grant) => !canDelegate(grant.permission))) return forbidden;

      const forwarding = { projectId, principal, permissions: ["project.users.manage"], allowFrontend: false };
      // The exact read supplies old authority that must be delegable even when
      // the replacement removes it. No child wildcard is needed for this check.
      const read = yield* integration(() => forwardToProject({
        ...forwarding,
        wildcardPath: "zelavis/api/v1/auth/accounts",
        query: new URLSearchParams({ accountId }),
        request: sameClient(request, new Request(request.url, { headers: request.headers, signal: request.signal })),
      }));
      if (read.status !== 200) return read;
      if (!(read.body instanceof Uint8Array)) return { status: 502, body: { error: "Invalid Project account response." } };
      const bytes = read.body;
      const snapshot = yield* Effect.result(evaluate(() => decodeProjectAccountAuthority(
        parseJsonObject(new TextDecoder().decode(bytes)).accounts)));
      if (snapshot._tag === "Failure") return { status: 502, body: { error: "Invalid Project account response." } };
      const [current] = snapshot.success;
      if (!current) return { status: 404, body: { error: "Account not found.", code: "account_not_found" } };
      if (current.id !== accountId) return { status: 502, body: { error: "Invalid Project account response." } };
      if (current.accessRevision !== input.expectedRevision) {
        return { status: 409, body: { error: "The account access revision has changed.", code: "account_access_conflict" } };
      }
      let roles: ReadonlyMap<string, { readonly permissions: readonly string[] }> | undefined;
      if ((current.roleAssignments?.length ?? 0) > 0 || input.roleAssignments.length > 0) {
        const read = yield* readProjectRoles(projectId, request, principal);
        if ("response" in read) return read.response;
        roles = read.roles;
      }
      const names = projectAccountAccessPermissions(projectId, current, input, roles);
      if (!names || names.some((permission) => !canDelegate(permission))) return forbidden;
      const accountAccessDigest = yield* projectAccountAccessDigest(accountId, input, names);
      return yield* integration(() => forwardToProject({
        ...forwarding,
        wildcardPath: `zelavis/api/v1/auth/accounts/${encodeURIComponent(accountId)}/access`,
        query: new URLSearchParams(),
        request,
        accountAccessDigest,
      }));
    }).pipe(Effect.catchCause((cause) => Effect.succeed(projectErrorResponse(unwrapFailure(Cause.squash(cause))))))),
  };

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
    handler: ({
      params,
      query,
      request,
      principal,
    }: {
      params: Record<string, string>;
      query: URLSearchParams;
      request: Request;
      principal?: ZelavisPrincipal;
    }) => present(Effect.gen(function* () {
      return yield* integration(() => forwardToProject({
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
      }));
    }).pipe(Effect.catchCause((cause) => Effect.succeed(projectErrorResponse(unwrapFailure(Cause.squash(cause))))))),
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
        "Forwards only the caller's Project data grants. The database operation enforces read, write or define authority independently of its HTTP method; POST queries are reads. No Platform authority travels with it.",
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
      authenticated: true,
      scope: { type: "project" as const, projectIdParam: "projectId" },
    },
    handler: ({
      params,
      query,
      request,
      principal,
    }: {
      params: Record<string, string>;
      query: URLSearchParams;
      request: Request;
      principal?: ZelavisPrincipal;
    }) => present(Effect.gen(function* () {
      const path = (params.path ?? "").replace(/^\/+/, "");
      if (!path) {
        return {
          status: 400,
          body: { error: "A database path is required." },
        };
      }
      const permissions = projectDataPermissions(principal, params.projectId ?? "");
      if (permissions.length === 0) return { status: 403, body: { error: "No App data authority for this Project." } };
      return yield* integration(() => forwardToProject({
        projectId: params.projectId ?? "",
        wildcardPath: `${PROJECT_DATABASE_PATH_PREFIX}/${path}`,
        query,
        request,
        principal,
        // Only the data implications travel with an App data request. The
        // caller's other Project authority, if it happens to hold any, is
        // not this request's business and must not ride along into the
        // child where it would widen what the request can reach.
        permissions,
        allowFrontend: false,
      }));
    }).pipe(Effect.catchCause((cause) => Effect.succeed(projectErrorResponse(unwrapFailure(Cause.squash(cause))))))),
  }));

  /**
   * A signed upload's bytes, from a browser holding only the link. The token is the authority: no principal and no
   * permission travel with it, and only the upload-receive route of the Project's storage is reachable here.
   */
  const uploadRoute = {
    id: "runtime.projects.uploads.receive",
    spec: {
      operationId: "receiveProjectUpload",
      summary: "Send a signed upload's bytes to a Project",
      description: "Needs no credentials: the token minted by `storage/uploads` binds the path, size, type and expiry, and is single use. Forwards nothing else.",
      tags: ["storage"],
      pathParams: {
        projectId: { type: "string" as const, required: true, description: "The Project." },
        token: { type: "string" as const, required: true, description: "The upload token." },
      },
      responses: { 200: { description: "{ id, size, sha256 }" }, 400: { description: "Refused, with the reason" }, 404: { description: "No such Project" } },
    },
    method: "PUT" as const,
    path: "/projects/:projectId/uploads/:token",
    handler: ({ params, query, request }: { params: Record<string, string>; query: URLSearchParams; request: Request }) => present(Effect.gen(function* () {
      const token = params.token ?? "";
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return { status: 400, body: { error: "This upload link is not valid." } };
      return yield* integration(() => forwardToProject({
        projectId: params.projectId ?? "",
        wildcardPath: `zelavis/api/v1/storage/uploads/${token}`,
        query,
        request,
        principal: undefined,
        permissions: [],
        allowFrontend: false,
      }));
    }).pipe(Effect.catchCause((cause) => Effect.succeed(projectErrorResponse(unwrapFailure(Cause.squash(cause))))))),
  };

  /**
   * The leader side of following a Project's database, for a follower on another node.
   *
   * A standby holds only `database.replicate` on its Project, which is not enough for the proxy above (a POST there
   * needs `project.runtime.manage`, which also stops the Project). This route forwards only the followers service of the
   * Project's database, with only that permission, to wherever the Project is placed now.
   */
  const followerRoutes = (["GET", "POST"] as const).map((method) => ({
    id: `runtime.projects.followers.${method.toLowerCase()}`,
    spec: {
      operationId: `projectFollowers${method[0]}${method.slice(1).toLowerCase()}`,
      summary: "Follow a Project's database",
      description: "The leader side of following a Project's database (`database/followers/*`): stats, records, log, holds, acknowledgments, the change feed, the partition listing and the declarations. Needs only `database.replicate` on the Project, and carries nothing else to it.",
      tags: ["database"],
      pathParams: {
        projectId: { type: "string" as const, required: true, description: "The Project whose database is followed." },
        path: { type: "string" as const, required: true, description: "The path within the followers service, such as `feed`." },
      },
      responses: {
        200: { description: "The followers service's response" },
        400: { description: "The path is not a followers path" },
        404: { description: "No such Project" },
        503: { description: "The Project runtime is not reachable" },
      },
    },
    method,
    path: "/projects/:projectId/followers/*path",
    access: {
      permissions: ["database.replicate"],
      scope: { type: "project" as const, projectIdParam: "projectId" },
    },
    handler: ({ params, query, request, principal }: {
      params: Record<string, string>;
      query: URLSearchParams;
      request: Request;
      principal?: ZelavisPrincipal;
    }) => present(Effect.gen(function* () {
      const path = (params.path ?? "").replace(/^\/+/, "");
      if (path === "" || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
        return { status: 400, body: { error: "A followers path is required, such as feed." } };
      }
      return yield* integration(() => forwardToProject({
        projectId: params.projectId ?? "",
        wildcardPath: `${PROJECT_DATABASE_PATH_PREFIX}/followers/${path}`,
        query,
        request,
        principal,
        permissions: projectRuntimePermissions(principal, params.projectId ?? "").filter((permission) => permission === "database.replicate"),
        allowFrontend: false,
      }));
    }).pipe(Effect.catchCause((cause) => Effect.succeed(projectErrorResponse(unwrapFailure(Cause.squash(cause))))))),
  }));

  return [...registrationSettingsRoutes, ...authSettingsRoutes, ...emailRoutes, ...invitationRoutes, ...roleRoutes, accountAccessRoute, ...proxyRoutes, ...dataRoutes, ...followerRoutes, uploadRoute];
}
