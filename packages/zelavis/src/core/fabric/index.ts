import type {
  ZelavisAccessRequirement,
  ZelavisRuntimeService,
  ZelavisServerRoute,
} from "../runtime/contracts.js";
import type {
  ZelavisNodeRole,
  ZelavisProjectWorkloadCapabilities,
  ZelavisProjectWorkloadIdentity,
  ZelavisRuntimeAuthority,
  ZelavisWorkloadPlacement,
  ZelavisWorkloadPlacementState,
} from "../workload/index.js";
import { Context, Data, Effect, Layer, ManagedRuntime } from "effect";

export type FabricMode = "single-node" | "cluster";

export type FabricNodeStatus =
  | "ready"
  | "degraded"
  | "draining"
  | "unavailable";

export type FabricNodeRole = ZelavisNodeRole;

export type FabricPlacementState = ZelavisWorkloadPlacementState;

export type FabricMigrationState =
  | "planned"
  | "preparing"
  | "copying"
  | "catching-up"
  | "quiescing"
  | "committing"
  | "cleaning-up"
  | "completed"
  | "failed";

export type FabricFeatureState = "available" | "planned";

export interface FabricNodeCapacity {
  readonly cpuCores?: number;
  readonly memoryBytes?: number;
  readonly diskBytes?: number;
}

/** Normalized pressure values use the inclusive range 0..1. */
export interface FabricNodeLoad {
  readonly cpu?: number;
  readonly memory?: number;
  readonly disk?: number;
  readonly diskIo?: number;
  readonly network?: number;
  readonly activeRequests?: number;
  readonly sqliteWritePressure?: number;
  readonly jobPressure?: number;
}

export interface FabricNode {
  readonly id: string;
  readonly status: FabricNodeStatus;
  readonly roles: readonly FabricNodeRole[];
  readonly runtimeEngine?: string;
  readonly runtimeDriver?: string;
  readonly capacity?: FabricNodeCapacity;
  readonly load?: FabricNodeLoad;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface FabricProjectPlacement
  extends ZelavisWorkloadPlacement<ZelavisProjectWorkloadIdentity> {
  readonly projectKind: string;
  readonly runtimeStatus?: string;
}

export type FabricReplicaMode = "single" | "fixed" | "automatic";

/**
 * Project replica intent. Automatic mode reacts only to Project-level demand;
 * Node capacity decides where a requested replica may run, not whether demand
 * exists.
 */
export interface FabricProjectReplicaPolicy {
  readonly mode: FabricReplicaMode;
  readonly replicas?: number;
  readonly minReplicas?: number;
  readonly maxReplicas?: number;
  readonly scaleOutCpuThreshold?: number;
  readonly scaleInCpuThreshold?: number;
  readonly scaleOutRequestThreshold?: number;
  readonly scaleInRequestThreshold?: number;
}

export interface FabricProjectScaleSignal {
  readonly currentReplicas: number;
  /** Normalized inclusive range 0..1. */
  readonly cpu?: number;
  /** Normalized inclusive range 0..1. */
  readonly requests?: number;
}

export interface FabricProjectReplicaResources {
  readonly cpuCores?: number;
  readonly memoryBytes?: number;
  readonly diskBytes?: number;
}

export interface FabricProjectPlacementRequest {
  readonly identity: ZelavisProjectWorkloadIdentity;
  readonly projectKind: string;
  readonly runtimeDriver?: string;
  readonly capabilities: Pick<
    ZelavisProjectWorkloadCapabilities,
    "statelessRuntimeReplicas"
  >;
  readonly replicaPolicy?: FabricProjectReplicaPolicy;
  readonly scaleSignal?: FabricProjectScaleSignal;
  readonly resources?: FabricProjectReplicaResources;
  readonly allowedNodeIds?: readonly string[];
  readonly requiredLabels?: Readonly<Record<string, string>>;
}

export interface FabricPlannedProjectReplica {
  readonly identity: ZelavisProjectWorkloadIdentity;
  readonly projectKind: string;
  readonly replicaId: string;
  readonly replicaIndex: number;
  readonly runtimeNodeId: string;
}

export type FabricUnplacedReplicaReason =
  | "no-eligible-node"
  | "insufficient-capacity";

export interface FabricUnplacedProjectReplica {
  readonly identity: ZelavisProjectWorkloadIdentity;
  readonly projectKind: string;
  readonly replicaId: string;
  readonly replicaIndex: number;
  readonly reason: FabricUnplacedReplicaReason;
}

export interface FabricPlacementPlan {
  readonly replicas: readonly FabricPlannedProjectReplica[];
  readonly unplaced: readonly FabricUnplacedProjectReplica[];
}

export interface FabricMigration {
  readonly id: string;
  readonly scope: "project" | "tenant-data";
  readonly projectId: string;
  readonly tenantId?: string;
  readonly sourceNodeId: string;
  readonly destinationNodeId: string;
  readonly expectedGeneration: number;
  readonly state: FabricMigrationState;
}

export interface FabricFeatures {
  readonly projectPlacement: FabricFeatureState;
  readonly multiNode: FabricFeatureState;
  readonly automaticBalancing: FabricFeatureState;
  readonly projectMigration: FabricFeatureState;
  readonly zelavisAppDataPlacement: FabricFeatureState;
  readonly replication: FabricFeatureState;
  readonly infrastructureAutoscaling: FabricFeatureState;
}

export interface FabricSnapshot {
  readonly authority: ZelavisRuntimeAuthority;
  readonly mode: FabricMode;
  readonly status: "ready" | "degraded" | "unavailable";
  readonly localNodeId: string;
  readonly nodes: readonly FabricNode[];
  readonly projectPlacements: readonly FabricProjectPlacement[];
  readonly migrations: readonly FabricMigration[];
  readonly features: FabricFeatures;
}

type Awaitable<T> = T | Promise<T>;

export interface FabricInventorySource {
  readonly nodes?: () => Awaitable<readonly FabricNode[]>;
  readonly projectPlacements?: () =>
    Awaitable<readonly FabricProjectPlacement[]>;
  readonly projectPlacement?: (
    projectId: string,
  ) => Awaitable<FabricProjectPlacement | undefined>;
  readonly migrations?: () => Awaitable<readonly FabricMigration[]>;
}

export interface FabricServiceOptions {
  readonly authority?: ZelavisRuntimeAuthority;
  readonly mode?: FabricMode;
  readonly localNode?: FabricNode;
  readonly inventory?: FabricInventorySource;
  readonly features?: Partial<FabricFeatures>;
  readonly access?: {
    /** Set to false only for an intentionally public embedded inventory. */
    readonly view?: ZelavisAccessRequirement | false;
    /** Set to false only for an intentionally public embedded planner. */
    readonly manage?: ZelavisAccessRequirement | false;
  };
}

export interface FabricApi {
  readonly snapshot: () => Promise<FabricSnapshot>;
  readonly listNodes: () => Promise<readonly FabricNode[]>;
  readonly getNode: (nodeId: string) => Promise<FabricNode | undefined>;
  readonly listProjectPlacements: () =>
    Promise<readonly FabricProjectPlacement[]>;
  readonly getProjectPlacement: (
    projectId: string,
  ) => Promise<FabricProjectPlacement | undefined>;
  readonly planProjectPlacements: (
    requests: readonly FabricProjectPlacementRequest[],
  ) => Promise<FabricPlacementPlan>;
  readonly listMigrations: () => Promise<readonly FabricMigration[]>;
}

export class FabricInventoryError extends Data.TaggedError(
  "FabricInventoryError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class Fabric extends Context.Service<
  Fabric,
  {
    readonly snapshot: Effect.Effect<FabricSnapshot, FabricInventoryError>;
  }
>()("zelavis/Fabric") {}

const defaultFeatures: FabricFeatures = {
  projectPlacement: "available",
  multiNode: "planned",
  automaticBalancing: "planned",
  projectMigration: "planned",
  zelavisAppDataPlacement: "planned",
  replication: "planned",
  infrastructureAutoscaling: "planned",
};

const defaultLocalNode: FabricNode = {
  id: "local",
  status: "ready",
  roles: ["gateway", "control", "worker"],
  runtimeDriver: "local",
};

const defaultAuthority: ZelavisRuntimeAuthority = {
  scope: "platform",
  scopeId: "local-platform",
  capabilities: ["hosting:projects", "hosting:fabric"],
};

function readInventory<A>(
  operation: string,
  source: (() => Awaitable<readonly A[]>) | undefined,
  fallback: readonly A[],
): Effect.Effect<readonly A[], FabricInventoryError> {
  if (!source) {
    return Effect.succeed(fallback);
  }

  return Effect.tryPromise({
    try: async () => source(),
    catch: (cause) => new FabricInventoryError({ operation, cause }),
  });
}

function sortNodes(nodes: readonly FabricNode[]): readonly FabricNode[] {
  return [...nodes].sort((left, right) => left.id.localeCompare(right.id));
}

function sortPlacements(
  placements: readonly FabricProjectPlacement[],
): readonly FabricProjectPlacement[] {
  return [...placements].sort((left, right) =>
    left.identity.workloadId.localeCompare(right.identity.workloadId),
  );
}

function sortMigrations(
  migrations: readonly FabricMigration[],
): readonly FabricMigration[] {
  return [...migrations].sort((left, right) => left.id.localeCompare(right.id));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function normalizedPressure(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(1, Math.max(0, value));
}

function desiredReplicaCount(request: FabricProjectPlacementRequest): number {
  const policy = request.replicaPolicy ?? { mode: "single" };
  if (!request.capabilities.statelessRuntimeReplicas || policy.mode === "single") {
    return 1;
  }

  const min = positiveInteger(policy.minReplicas, 1);
  if (policy.mode === "fixed") {
    // In fixed mode `replicas` *is* the target, so it is also the default
    // ceiling. Defaulting `max` to `min` silently resolved
    // `{ mode: "fixed", replicas: 3 }` to a single replica whenever
    // `maxReplicas` was omitted.
    const fixed = Math.max(min, positiveInteger(policy.replicas, min));
    // `maxReplicas` still caps the fixed target when it is supplied; it just
    // defaults to the target instead of to `min`.
    const ceiling = positiveInteger(policy.maxReplicas, fixed);
    return Math.max(min, Math.min(fixed, ceiling));
  }

  const max = Math.max(min, positiveInteger(policy.maxReplicas, min));

  const current = Math.min(
    max,
    Math.max(min, positiveInteger(request.scaleSignal?.currentReplicas, min)),
  );
  const cpu = normalizedPressure(request.scaleSignal?.cpu);
  const requests = normalizedPressure(request.scaleSignal?.requests);
  const scaleOut =
    (cpu !== undefined &&
      cpu >= (normalizedPressure(policy.scaleOutCpuThreshold) ?? 0.75)) ||
    (requests !== undefined &&
      requests >=
        (normalizedPressure(policy.scaleOutRequestThreshold) ?? 0.75));
  if (scaleOut) {
    return Math.min(max, current + 1);
  }

  const hasSignal = cpu !== undefined || requests !== undefined;
  const scaleIn =
    hasSignal &&
    (cpu === undefined ||
      cpu <= (normalizedPressure(policy.scaleInCpuThreshold) ?? 0.25)) &&
    (requests === undefined ||
      requests <=
        (normalizedPressure(policy.scaleInRequestThreshold) ?? 0.25));
  return scaleIn ? Math.max(min, current - 1) : current;
}

interface FabricPlannedNodeUsage {
  replicas: number;
  cpuCores: number;
  memoryBytes: number;
  diskBytes: number;
  projects: Map<string, number>;
}

function eligibleNode(
  node: FabricNode,
  request: FabricProjectPlacementRequest,
): boolean {
  if (node.status !== "ready" || !node.roles.includes("worker")) {
    return false;
  }
  if (request.runtimeDriver && node.runtimeDriver !== request.runtimeDriver) {
    return false;
  }
  if (request.allowedNodeIds && !request.allowedNodeIds.includes(node.id)) {
    return false;
  }
  return Object.entries(request.requiredLabels ?? {}).every(
    ([name, value]) => node.labels?.[name] === value,
  );
}

function hasCapacity(
  node: FabricNode,
  usage: FabricPlannedNodeUsage,
  resources: FabricProjectReplicaResources,
): boolean {
  const cpuCores = Math.max(0, resources.cpuCores ?? 0);
  const memoryBytes = Math.max(0, resources.memoryBytes ?? 0);
  const diskBytes = Math.max(0, resources.diskBytes ?? 0);
  return (
    (node.capacity?.cpuCores === undefined ||
      usage.cpuCores + cpuCores <= node.capacity.cpuCores) &&
    (node.capacity?.memoryBytes === undefined ||
      usage.memoryBytes + memoryBytes <= node.capacity.memoryBytes) &&
    (node.capacity?.diskBytes === undefined ||
      usage.diskBytes + diskBytes <= node.capacity.diskBytes)
  );
}

function nodeScore(
  node: FabricNode,
  usage: FabricPlannedNodeUsage,
  projectId: string,
): number {
  const sameProjectReplicas = usage.projects.get(projectId) ?? 0;
  const capacityShare = node.capacity?.cpuCores
    ? usage.cpuCores / node.capacity.cpuCores
    : usage.replicas * 0.01;
  const pressure =
    (normalizedPressure(node.load?.cpu) ?? 0) +
    (normalizedPressure(node.load?.memory) ?? 0) +
    (normalizedPressure(node.load?.activeRequests) ?? 0);
  return sameProjectReplicas * 1_000 + pressure * 100 + capacityShare * 10;
}

/**
 * Produces a deterministic desired placement plan. It does not start runtimes:
 * Fabric persists/fences decisions and Agents execute them in a later stage.
 */
export function planFabricProjectPlacements(
  nodes: readonly FabricNode[],
  requests: readonly FabricProjectPlacementRequest[],
): FabricPlacementPlan {
  const sortedNodes = [...nodes].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const usage = new Map<string, FabricPlannedNodeUsage>(
    sortedNodes.map((node) => [
      node.id,
      {
        replicas: 0,
        cpuCores: 0,
        memoryBytes: 0,
        diskBytes: 0,
        projects: new Map(),
      },
    ]),
  );
  const replicas: FabricPlannedProjectReplica[] = [];
  const unplaced: FabricUnplacedProjectReplica[] = [];

  for (const request of [...requests].sort((left, right) =>
    left.identity.workloadId.localeCompare(right.identity.workloadId),
  )) {
    const projectId = request.identity.workloadId;
    const eligible = sortedNodes.filter((node) => eligibleNode(node, request));
    const resources = request.resources ?? {};
    const count = desiredReplicaCount(request);

    for (let replicaIndex = 0; replicaIndex < count; replicaIndex += 1) {
      const replicaId = `${projectId}:runtime:${replicaIndex + 1}`;
      const candidates = eligible
        .filter((node) => hasCapacity(node, usage.get(node.id)!, resources))
        .sort((left, right) => {
          const score =
            nodeScore(left, usage.get(left.id)!, projectId) -
            nodeScore(right, usage.get(right.id)!, projectId);
          return score || left.id.localeCompare(right.id);
        });
      const selected = candidates[0];
      if (!selected) {
        unplaced.push({
          identity: request.identity,
          projectKind: request.projectKind,
          replicaId,
          replicaIndex,
          reason: eligible.length === 0 ? "no-eligible-node" : "insufficient-capacity",
        });
        continue;
      }

      const selectedUsage = usage.get(selected.id)!;
      selectedUsage.replicas += 1;
      selectedUsage.cpuCores += Math.max(0, resources.cpuCores ?? 0);
      selectedUsage.memoryBytes += Math.max(0, resources.memoryBytes ?? 0);
      selectedUsage.diskBytes += Math.max(0, resources.diskBytes ?? 0);
      selectedUsage.projects.set(
        projectId,
        (selectedUsage.projects.get(projectId) ?? 0) + 1,
      );
      replicas.push({
        identity: request.identity,
        projectKind: request.projectKind,
        replicaId,
        replicaIndex,
        runtimeNodeId: selected.id,
      });
    }
  }

  return { replicas, unplaced };
}

function fabricStatus(
  localNodeId: string,
  nodes: readonly FabricNode[],
): FabricSnapshot["status"] {
  const localNode = nodes.find((node) => node.id === localNodeId);
  if (!localNode || localNode.status === "unavailable") {
    return "unavailable";
  }

  // A draining node is not accepting work, so the fleet is not fully ready.
  // Reporting `ready` while the only local node drains overstates readiness to
  // anything that routes on this summary.
  return nodes.some(
    (node) =>
      node.status === "degraded" ||
      node.status === "unavailable" ||
      node.status === "draining",
  )
    ? "degraded"
    : "ready";
}

export function createFabricLayer(
  options: FabricServiceOptions = {},
): Layer.Layer<Fabric> {
  const localNode = options.localNode ?? defaultLocalNode;
  const features: FabricFeatures = {
    ...defaultFeatures,
    ...options.features,
  };

  return Layer.effect(
    Fabric,
    Effect.gen(function* () {
      const readSnapshot = Effect.fn("Fabric.snapshot")(function* () {
        const inventory = yield* Effect.all({
          nodes: readInventory(
            "nodes",
            options.inventory?.nodes,
            [localNode],
          ),
          projectPlacements: readInventory(
            "projectPlacements",
            options.inventory?.projectPlacements,
            [],
          ),
          migrations: readInventory(
            "migrations",
            options.inventory?.migrations,
            [],
          ),
        });
        const nodes = sortNodes(inventory.nodes);

        return {
          authority: options.authority ?? defaultAuthority,
          mode: options.mode ?? (nodes.length > 1 ? "cluster" : "single-node"),
          status: fabricStatus(localNode.id, nodes),
          localNodeId: localNode.id,
          nodes,
          projectPlacements: sortPlacements(inventory.projectPlacements),
          migrations: sortMigrations(inventory.migrations),
          features,
        } satisfies FabricSnapshot;
      });

      return Fabric.of({ snapshot: readSnapshot() });
    }),
  );
}

function createFabricApi(options: FabricServiceOptions): FabricApi {
  const runtime = ManagedRuntime.make(createFabricLayer(options));
  const snapshot = () =>
    runtime.runPromise(Fabric.use((fabric) => fabric.snapshot));

  return {
    snapshot,
    async listNodes() {
      return (await snapshot()).nodes;
    },
    async getNode(nodeId) {
      return (await snapshot()).nodes.find((node) => node.id === nodeId);
    },
    async listProjectPlacements() {
      return (await snapshot()).projectPlacements;
    },
    async getProjectPlacement(projectId) {
      if (options.inventory?.projectPlacement) {
        return options.inventory.projectPlacement(projectId);
      }
      return (await snapshot()).projectPlacements.find(
        (placement) => placement.identity.workloadId === projectId,
      );
    },
    async planProjectPlacements(requests) {
      return planFabricProjectPlacements((await snapshot()).nodes, requests);
    },
    async listMigrations() {
      return (await snapshot()).migrations;
    },
  };
}

function isOptionalNormalizedNumber(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1)
  );
}

function isOptionalNonNegativeNumber(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}


function isStringRecord(
  value: unknown,
): value is Readonly<Record<string, string>> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value).every((entry) => typeof entry === "string"),
  );
}

function isPlacementRequest(
  value: unknown,
): value is FabricProjectPlacementRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const request = value as Record<string, unknown>;
  const identity = request.identity as Record<string, unknown> | undefined;
  const capabilities = request.capabilities as
    | Record<string, unknown>
    | undefined;
  if (
    !identity ||
    identity.type !== "project" ||
    !isBoundedIdentifier(identity.scopeId) ||
    !isBoundedIdentifier(identity.workloadId) ||
    !isBoundedIdentifier(request.projectKind) ||
    !capabilities ||
    typeof capabilities.statelessRuntimeReplicas !== "boolean"
  ) {
    return false;
  }

  const policy = request.replicaPolicy as Record<string, unknown> | undefined;
  if (
    policy &&
    (!(["single", "fixed", "automatic"] as const).includes(
      policy.mode as FabricReplicaMode,
    ) ||
      !isBoundedReplicaCount(policy.replicas) ||
      !isBoundedReplicaCount(policy.minReplicas) ||
      !isBoundedReplicaCount(policy.maxReplicas) ||
      !isOptionalNormalizedNumber(policy.scaleOutCpuThreshold) ||
      !isOptionalNormalizedNumber(policy.scaleInCpuThreshold) ||
      !isOptionalNormalizedNumber(policy.scaleOutRequestThreshold) ||
      !isOptionalNormalizedNumber(policy.scaleInRequestThreshold))
  ) {
    return false;
  }

  const signal = request.scaleSignal as Record<string, unknown> | undefined;
  if (
    signal &&
    (!isOptionalNonNegativeNumber(signal.currentReplicas) ||
      typeof signal.currentReplicas !== "number" ||
      !Number.isInteger(signal.currentReplicas) ||
      !isOptionalNormalizedNumber(signal.cpu) ||
      !isOptionalNormalizedNumber(signal.requests))
  ) {
    return false;
  }

  const resources = request.resources as Record<string, unknown> | undefined;
  if (
    resources &&
    (!isOptionalNonNegativeNumber(resources.cpuCores) ||
      !isOptionalNonNegativeNumber(resources.memoryBytes) ||
      !isOptionalNonNegativeNumber(resources.diskBytes))
  ) {
    return false;
  }

  return (
    (request.runtimeDriver === undefined ||
      isBoundedIdentifier(request.runtimeDriver)) &&
    (request.allowedNodeIds === undefined ||
      (Array.isArray(request.allowedNodeIds) &&
        request.allowedNodeIds.length <= FABRIC_MAX_CONSTRAINT_ENTRIES &&
        request.allowedNodeIds.every(isBoundedIdentifier))) &&
    (request.requiredLabels === undefined ||
      (isStringRecord(request.requiredLabels) &&
        isBoundedLabelRecord(request.requiredLabels)))
  );
}

function isBoundedLabelRecord(value: Record<string, string>): boolean {
  const entries = Object.entries(value);
  return (
    entries.length <= FABRIC_MAX_CONSTRAINT_ENTRIES &&
    entries.every(
      ([key, entry]) =>
        key.length <= FABRIC_MAX_IDENTIFIER_LENGTH &&
        entry.length <= FABRIC_MAX_IDENTIFIER_LENGTH,
    )
  );
}

function readPlacementRequests(
  body: unknown,
): readonly FabricProjectPlacementRequest[] | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const requests = (body as Record<string, unknown>).requests;
  if (!Array.isArray(requests)) return undefined;
  // Planning is permission-gated, but a compromised operator credential or an
  // accidental request must not be able to allocate an effectively unbounded
  // amount of work.
  if (requests.length > FABRIC_MAX_PLACEMENT_REQUESTS) return undefined;
  return requests.every(isPlacementRequest) ? requests : undefined;
}

/** Largest batch the placement planner will accept in one request. */
export const FABRIC_MAX_PLACEMENT_REQUESTS = 1_000;

/** Largest replica count any policy may ask for. */
export const FABRIC_MAX_REPLICAS = 1_000;

/** Largest identifier or label string accepted in planning input. */
export const FABRIC_MAX_IDENTIFIER_LENGTH = 512;

/** Largest number of node ids or labels accepted on one request. */
export const FABRIC_MAX_CONSTRAINT_ENTRIES = 256;

function isBoundedIdentifier(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= FABRIC_MAX_IDENTIFIER_LENGTH
  );
}

function isBoundedReplicaCount(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" &&
      Number.isInteger(value) &&
      value > 0 &&
      value <= FABRIC_MAX_REPLICAS)
  );
}

function createFabricRoutes(
  options: FabricServiceOptions,
): readonly ZelavisServerRoute<FabricApi>[] {
  const viewAccess = options.access?.view === false
    ? undefined
    : options.access?.view ?? { permissions: ["fabric.view"] };
  const manageAccess = options.access?.manage === false
    ? undefined
    : options.access?.manage ?? { permissions: ["fabric.manage"] };
  return [
    {
      id: "fabric.snapshot",
      method: "GET",
      path: "/snapshot",
      access: viewAccess,
      handler: async ({ service }) => ({
        status: 200,
        body: await service.snapshot(),
      }),
    },
    {
      id: "fabric.health",
      method: "GET",
      path: "/health",
      handler: async ({ service }) => {
        const snapshot = await service.snapshot();
        return {
          status: snapshot.status === "unavailable" ? 503 : 200,
          body: {
            status: snapshot.status,
            mode: snapshot.mode,
            localNodeId: snapshot.localNodeId,
            nodes: snapshot.nodes.length,
          },
        };
      },
    },
    {
      id: "fabric.nodes.list",
      method: "GET",
      path: "/nodes",
      access: viewAccess,
      handler: async ({ service }) => ({
        status: 200,
        body: { nodes: await service.listNodes() },
      }),
    },
    {
      id: "fabric.nodes.get",
      method: "GET",
      path: "/nodes/:nodeId",
      access: viewAccess,
      handler: async ({ service, params }) => {
        const node = await service.getNode(params.nodeId ?? "");
        return node
          ? { status: 200, body: { node } }
          : { status: 404, body: { error: "Fabric node was not found." } };
      },
    },
    {
      id: "fabric.project-placements.list",
      method: "GET",
      path: "/placements/projects",
      access: viewAccess,
      handler: async ({ service }) => ({
        status: 200,
        body: { placements: await service.listProjectPlacements() },
      }),
    },
    {
      id: "fabric.project-placements.get",
      method: "GET",
      path: "/placements/projects/:projectId",
      access: viewAccess,
      handler: async ({ service, params }) => {
        const placement = await service.getProjectPlacement(
          params.projectId ?? "",
        );
        return placement
          ? { status: 200, body: { placement } }
          : {
              status: 404,
              body: { error: "Project placement was not found." },
            };
      },
    },
    {
      id: "fabric.project-placements.plan",
      method: "POST",
      path: "/placements/projects/plan",
      access: manageAccess,
      handler: async ({ service, body }) => {
        const requests = readPlacementRequests(body);
        return requests
          ? {
              status: 200,
              body: { plan: await service.planProjectPlacements(requests) },
            }
          : {
              status: 400,
              body: {
                error: "Expected a valid Fabric Project placement request list.",
              },
            };
      },
    },
    {
      id: "fabric.migrations.list",
      method: "GET",
      path: "/migrations",
      access: viewAccess,
      handler: async ({ service }) => ({
        status: 200,
        body: { migrations: await service.listMigrations() },
      }),
    },
  ];
}

export function createFabricService(
  options: FabricServiceOptions = {},
): ZelavisRuntimeService<FabricApi> {
  return {
    name: "zelavis/fabric",
    kind: "core",
    basePath: "/fabric",
    service: createFabricApi(options),
    api: {
      v1: createFabricRoutes(options),
    },
  };
}

export const fabricService = createFabricService();

export default fabricService;
