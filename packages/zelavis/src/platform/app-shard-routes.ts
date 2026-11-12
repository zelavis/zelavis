import { Effect } from "effect";
import type { ZelavisServerRoute } from "../core/index.js";
import { integration, present } from "../core/runtime/effect-boundary.js";
import type { ZelavisSystemStore } from "../system-store.js";
import type { AppShardPlacementAuthority } from "./app-data-placement.js";
import type { AppShardActivation, AppShardActivationRefusal } from "./app-shard-activation.js";
import type { AppShardAllocationStore } from "./app-shard-allocation.js";
import { verifyAppShardCapability } from "./app-shard-capability.js";
import { readLocalProjectPlacementLease } from "./project-placement-authority.js";

const noStore = { "cache-control": "no-store" } as const;
const unavailable = { status: 503, headers: noStore, body: { error: "System Store is unavailable." } };
const validProjectId = (value: string) => value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value);

/**
 * Operator HTTP for a Project's remote App shard placement: what it may use (`allocation`) and what the ledger
 * holds. Only the allocation is written here; ledger transitions belong to the Platform and the Project's channel.
 */
export function createAppShardOperatorRoutes(options: {
  readonly authority?: AppShardPlacementAuthority;
  readonly allocations?: AppShardAllocationStore;
  readonly projectExists: (projectId: string) => Promise<boolean>;
}): readonly ZelavisServerRoute<any>[] {
  const { authority, allocations } = options;
  const system = { type: "system" as const };
  return [
    {
      id: "runtime.shardPlacement.get", method: "GET", path: "/shard-placement/:projectId",
      access: { permissions: ["fabric.view"], scope: system },
      spec: {
        operationId: "getShardPlacement", summary: "Read a Project's shard allocation and shard placements", tags: ["fabric"],
        responses: { 200: { description: "The allocation (or null) and the ledger's placements" }, 400: { description: "Invalid Project id" } },
      },
      handler: ({ params }) => present(Effect.gen(function* () {
        if (!authority || !allocations) return unavailable;
        const projectId = params.projectId ?? "";
        if (!validProjectId(projectId)) return { status: 400, headers: noStore, body: { error: "Invalid Project id." } };
        const allocation = yield* integration(() => allocations.get(projectId));
        const view = yield* integration(() => authority.list(projectId));
        return {
          headers: noStore,
          body: { projectId, allocation: allocation ?? null, incarnation: view.incarnation ?? null, revision: view.revision, placements: view.placements },
        };
      })),
    },
    {
      id: "runtime.shardPlacement.setAllocation", method: "PUT", path: "/shard-placement/:projectId/allocation",
      access: { permissions: ["fabric.manage"], scope: system },
      spec: {
        operationId: "setShardAllocation", summary: "Set the Nodes and budget a Project's remote shards may use", tags: ["fabric"],
        responses: {
          200: { description: "The new allocation" }, 400: { description: "Invalid request" },
          404: { description: "No such Project" },
          409: { description: "The observed generation is stale, or live shards use what the allocation would remove" },
        },
      },
      handler: ({ params, body }) => present(Effect.gen(function* () {
        if (!authority || !allocations) return unavailable;
        const projectId = params.projectId ?? "";
        if (!validProjectId(projectId)) return { status: 400, headers: noStore, body: { error: "Invalid Project id." } };
        if (!(yield* integration(() => options.projectExists(projectId)))) {
          return { status: 404, headers: noStore, body: { error: "No such Project.", code: "unknown-project" } };
        }
        const result = yield* integration(() => allocations.set(projectId, body, () =>
          present(Effect.map(integration(() => authority.list(projectId)), (view) => view.placements.filter((placement) => placement.state !== "released")))));
        if (result.ok) return { headers: noStore, body: { allocation: result.allocation } };
        if (result.reason === "invalid-request") {
          return { status: 400, headers: noStore, body: { error: "Invalid allocation.", code: "invalid-request" } };
        }
        return {
          status: 409, headers: noStore,
          body: {
            error: result.reason === "generation-conflict" ? "The allocation changed since it was read." : "Live shards use what this allocation would remove.",
            code: result.reason, ...(result.current ? { current: result.current } : {}), ...(result.inUse ? { inUse: result.inUse } : {}),
          },
        };
      })),
    },
  ];
}

const statusOf = (reason: AppShardActivationRefusal): number =>
  reason === "invalid-request" ? 400
    : reason === "agent-unavailable" || reason === "dispatch-unavailable" ? 503
      : 409;

const refusal = (reason: AppShardActivationRefusal, currentRevision: number) => ({
  status: statusOf(reason), headers: noStore,
  body: { error: `The shard request was refused: ${reason}.`, code: reason, currentRevision },
});

/**
 * A Project's own channel for its remote App shards, authorized by the capability the Platform started it with. The
 * capability names the Project, its node and its placement epoch, and is honoured only while that is the Project's
 * current active placement: a writer of an older epoch, or one the Platform has fenced, gets nothing.
 */
export function createAppShardProjectRoutes(options: {
  readonly authority?: AppShardPlacementAuthority;
  readonly activation?: AppShardActivation;
  readonly store?: ZelavisSystemStore;
  readonly secret: () => Promise<string>;
  readonly projectExists: (projectId: string) => Promise<boolean>;
}): readonly ZelavisServerRoute<any>[] {
  const { authority, activation, store } = options;
  const unauthorized = { status: 401, headers: noStore, body: { error: "Not authorized for this Project's shards." } };
  const stale = { status: 409, headers: noStore, body: { error: "The Project's placement has moved past this process.", code: "stale-project-epoch" } };

  /** The caller's claims when authentic for `projectId` and current; otherwise the answer to give. */
  const authorize = (request: Request | undefined, projectId: string | undefined) => Effect.gen(function* () {
    const header = request?.headers.get("authorization") ?? "";
    const token = /^Bearer (\S+)$/.exec(header)?.[1];
    if (token === undefined || projectId === undefined || !validProjectId(projectId) || store === undefined) return { refused: unauthorized };
    const secret = yield* integration(() => options.secret());
    const claims = yield* integration(() => verifyAppShardCapability(secret, token));
    if (claims === undefined || claims.scope !== projectId) return { refused: unauthorized };
    if (!(yield* integration(() => options.projectExists(projectId)))) return { refused: unauthorized };
    const placement = yield* integration(() => readLocalProjectPlacementLease(store, projectId));
    if (placement === undefined || placement.state !== "active" || placement.leaseExpiresAt <= placement.authorityNow ||
        placement.nodeId !== claims.node || placement.epoch !== claims.epoch) return { refused: stale };
    return { claims };
  }).pipe(Effect.catchCause(() => Effect.succeed({ refused: unavailable })));

  const operationIdOf = (body: unknown): string | undefined => {
    const value = typeof body === "object" && body !== null ? (body as { operationId?: unknown }).operationId : undefined;
    return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
  };
  const invalid = { status: 400, headers: noStore, body: { error: "The body is { operationId }.", code: "invalid-request" } };
  type Params = { params: Record<string, string | undefined>; body?: unknown; request?: Request };
  const spec = (operationId: string, summary: string, responses: Record<number, { description: string }>) => ({
    operationId, summary, tags: ["runtime"],
    description: "For a Project runtime's own shard placement: authorized by the capability the Platform gave it at start (`Authorization: Bearer`), which names this Project, its node and its placement epoch, and by nothing else.",
    responses: { 401: { description: "No valid capability for this Project" }, 409: { description: "Refused, or the capability's epoch is no longer the Project's" }, ...responses },
  });

  return [
    {
      id: "runtime.projectShards.list", method: "GET" as const, path: "/project-shards/:projectId",
      spec: spec("listProjectShards", "A Project's shard ledger", { 200: { description: "The ledger's placements and the authenticated writer Node" } }),
      handler: ({ params, request }: Params) => present(Effect.gen(function* () {
        const checked = yield* authorize(request, params.projectId);
        if (checked.refused) return checked.refused;
        if (!authority) return unavailable;
        const view = yield* integration(() => authority.list(params.projectId!));
        return { headers: noStore, body: { ...view, callerNodeId: checked.claims.node } };
      })),
    },
    {
      id: "runtime.projectShards.request", method: "POST" as const, path: "/project-shards/:projectId/requests",
      spec: spec("requestProjectShard", "Reserve a remote shard for a Project", { 200: { description: "{ placement }" }, 400: { description: "Invalid request" } }),
      handler: ({ params, body, request }: Params) => present(Effect.gen(function* () {
        const checked = yield* authorize(request, params.projectId);
        if (checked.refused) return checked.refused;
        if (!authority) return unavailable;
        const decision = yield* integration(() => authority.request(checked.claims.scope, body, { nodeId: checked.claims.node }));
        return decision.granted
          ? { headers: noStore, body: { placement: decision.placement } }
          : refusal(decision.reason, decision.currentRevision);
      })),
    },
    {
      id: "runtime.projectShards.activate", method: "POST" as const, path: "/project-shards/:projectId/:shardId/activate",
      spec: spec("activateProjectShard", "Activate a reserved shard and get access to it", { 200: { description: "{ placement, access }" }, 503: { description: "The Agent is unreachable" } }),
      handler: ({ params, body, request }: Params) => present(Effect.gen(function* () {
        const checked = yield* authorize(request, params.projectId);
        if (checked.refused) return checked.refused;
        const operationId = operationIdOf(body);
        if (!activation || !params.shardId) return unavailable;
        if (operationId === undefined) return invalid;
        const result = yield* integration(() => activation.activate({
          projectId: checked.claims.scope, shardId: params.shardId!, operationId, projectEpoch: checked.claims.epoch,
        }));
        return result.granted ? { headers: noStore, body: { placement: result.placement, access: result.access } } : refusal(result.reason, result.currentRevision);
      })),
    },
    {
      id: "runtime.projectShards.access", method: "POST" as const, path: "/project-shards/:projectId/:shardId/access",
      spec: spec("accessProjectShard", "A fresh access token for a committed shard", { 200: { description: "{ placement, access }" }, 503: { description: "The Agent is unreachable" } }),
      handler: ({ params, request }: Params) => present(Effect.gen(function* () {
        const checked = yield* authorize(request, params.projectId);
        if (checked.refused) return checked.refused;
        if (!activation || !params.shardId) return unavailable;
        const result = yield* integration(() => activation.access({
          projectId: checked.claims.scope, shardId: params.shardId!, projectEpoch: checked.claims.epoch,
        }));
        return result.granted ? { headers: noStore, body: { placement: result.placement, access: result.access } } : refusal(result.reason, result.currentRevision);
      })),
    },
    {
      id: "runtime.projectShards.release", method: "POST" as const, path: "/project-shards/:projectId/:shardId/release",
      spec: spec("releaseProjectShard", "Release a shard; the Agent removes its storage", { 200: { description: "{ placement }" }, 503: { description: "The Agent is unreachable" } }),
      handler: ({ params, body, request }: Params) => present(Effect.gen(function* () {
        const checked = yield* authorize(request, params.projectId);
        if (checked.refused) return checked.refused;
        const operationId = operationIdOf(body);
        if (!activation || !params.shardId) return unavailable;
        if (operationId === undefined) return invalid;
        const result = yield* integration(() => activation.release({ projectId: checked.claims.scope, shardId: params.shardId!, operationId }));
        return result.granted ? { headers: noStore, body: { placement: result.placement } } : refusal(result.reason, result.currentRevision);
      })),
    },
  ];
}
