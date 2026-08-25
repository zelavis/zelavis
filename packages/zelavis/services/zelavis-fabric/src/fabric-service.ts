import type {
  ZelavisRuntimeService,
  ZelavisRuntimeServiceMenuDefinition,
  ZelavisServerRoute,
} from "@zelavis/server";
import { Context, Data, Effect, Layer, ManagedRuntime } from "effect";

export type FabricMode = "single-node" | "cluster";

export type FabricNodeStatus =
  | "ready"
  | "degraded"
  | "draining"
  | "unavailable";

export type FabricNodeRole = "gateway" | "control" | "worker";

export type FabricPlacementState =
  | "active"
  | "preparing"
  | "moving"
  | "recovering"
  | "unavailable";

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

export interface FabricProjectPlacement {
  readonly projectId: string;
  readonly projectKind: string;
  readonly nodeId: string;
  readonly generation: number;
  readonly state: FabricPlacementState;
  readonly runtimeStatus?: string;
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
  readonly migrations?: () => Awaitable<readonly FabricMigration[]>;
}

export interface FabricServiceOptions {
  readonly mode?: FabricMode;
  readonly localNode?: FabricNode;
  readonly inventory?: FabricInventorySource;
  readonly features?: Partial<FabricFeatures>;
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
>()("@zelavis/fabric/Fabric") {}

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
    left.projectId.localeCompare(right.projectId),
  );
}

function sortMigrations(
  migrations: readonly FabricMigration[],
): readonly FabricMigration[] {
  return [...migrations].sort((left, right) => left.id.localeCompare(right.id));
}

function fabricStatus(
  localNodeId: string,
  nodes: readonly FabricNode[],
): FabricSnapshot["status"] {
  const localNode = nodes.find((node) => node.id === localNodeId);
  if (!localNode || localNode.status === "unavailable") {
    return "unavailable";
  }

  return nodes.some(
    (node) => node.status === "degraded" || node.status === "unavailable",
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
      return (await snapshot()).projectPlacements.find(
        (placement) => placement.projectId === projectId,
      );
    },
    async listMigrations() {
      return (await snapshot()).migrations;
    },
  };
}

const fabricMenu: ZelavisRuntimeServiceMenuDefinition = {
  title: "Fabric",
  path: "/server/fabric",
  pageLabel: "Fabric",
  panelLabel: "Fabric",
  sectionLabel: "Manage",
  order: 65,
  surface: "platform",
  access: {
    permissions: ["fabric.view"],
    scope: { type: "system" },
  },
  items: [
    {
      title: "Overview",
      path: "/server/fabric",
      pageLabel: "Fabric",
    },
    {
      title: "Nodes",
      path: "/server/fabric/nodes",
      pageLabel: "Nodes",
    },
    {
      title: "Placements",
      path: "/server/fabric/placements",
      pageLabel: "Placements",
    },
    {
      title: "Migrations",
      path: "/server/fabric/migrations",
      pageLabel: "Migrations",
    },
    {
      title: "Balancing",
      path: "/server/fabric/balancing",
      pageLabel: "Balancing",
    },
    {
      title: "Replication & Failover",
      path: "/server/fabric/replication",
      pageLabel: "Replication & Failover",
    },
    {
      title: "Backups & Recovery",
      path: "/server/fabric/backups",
      pageLabel: "Backups & Recovery",
    },
    {
      title: "Observability",
      path: "/server/fabric/observability",
      pageLabel: "Observability",
    },
    {
      title: "Data Fabric",
      path: "/server/fabric/data",
      pageLabel: "Data Fabric",
      panelLabel: "Data Fabric",
      items: [
        {
          title: "Overview",
          path: "/server/fabric/data",
          pageLabel: "Data Fabric",
        },
        {
          title: "Shards",
          path: "/server/fabric/data/shards",
          pageLabel: "Shards",
        },
        {
          title: "Replicas",
          path: "/server/fabric/data/replicas",
          pageLabel: "Replicas",
        },
        {
          title: "Schema Rollouts",
          path: "/server/fabric/data/schema-rollouts",
          pageLabel: "Schema Rollouts",
        },
      ],
    },
    {
      title: "Infrastructure",
      path: "/server/fabric/infrastructure",
      pageLabel: "Infrastructure",
      panelLabel: "Infrastructure",
      items: [
        {
          title: "Overview",
          path: "/server/fabric/infrastructure",
          pageLabel: "Infrastructure",
        },
        {
          title: "Providers",
          path: "/server/fabric/infrastructure/providers",
          pageLabel: "Infrastructure Providers",
        },
        {
          title: "Autoscaling",
          path: "/server/fabric/infrastructure/autoscaling",
          pageLabel: "Infrastructure Autoscaling",
        },
      ],
    },
    {
      title: "Settings",
      path: "/server/fabric/settings",
      pageLabel: "Fabric Settings",
      panelLabel: "Fabric Settings",
      items: [
        {
          title: "Overview",
          path: "/server/fabric/settings",
          pageLabel: "Fabric Settings",
        },
        {
          title: "Placement Policies",
          path: "/server/fabric/settings/placement-policies",
          pageLabel: "Placement Policies",
        },
        {
          title: "Networking",
          path: "/server/fabric/settings/networking",
          pageLabel: "Fabric Networking",
        },
        {
          title: "Limits & Safety",
          path: "/server/fabric/settings/limits",
          pageLabel: "Limits & Safety",
        },
      ],
    },
  ],
};

function createFabricRoutes(): readonly ZelavisServerRoute<FabricApi>[] {
  return [
    {
      id: "fabric.snapshot",
      method: "GET",
      path: "/snapshot",
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
      handler: async ({ service }) => ({
        status: 200,
        body: { nodes: await service.listNodes() },
      }),
    },
    {
      id: "fabric.nodes.get",
      method: "GET",
      path: "/nodes/:nodeId",
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
      handler: async ({ service }) => ({
        status: 200,
        body: { placements: await service.listProjectPlacements() },
      }),
    },
    {
      id: "fabric.project-placements.get",
      method: "GET",
      path: "/placements/projects/:projectId",
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
      id: "fabric.migrations.list",
      method: "GET",
      path: "/migrations",
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
    name: "@zelavis/fabric",
    kind: "core",
    basePath: "/fabric",
    service: createFabricApi(options),
    menu: fabricMenu,
    api: {
      v1: createFabricRoutes(),
    },
  };
}

export const fabricService = createFabricService();

export default fabricService;
