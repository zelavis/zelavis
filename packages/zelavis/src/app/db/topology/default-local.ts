import {
  DATABASE_PARTITION_HASH_ALGORITHM,
  DATABASE_PARTITION_SPACE_SIZE,
  DATABASE_TOPOLOGY_VERSION,
  databasePlacementId,
  databaseReplicaId,
  logicalDatabaseId,
  physicalShardId,
  virtualShardId,
  type DatabaseDesiredTopology,
  type DatabaseObservedTopology,
  type DatabasePhysicalShard,
  type DatabaseTopologyPolicy,
  type DatabaseTopologySnapshot,
  type DatabaseVirtualShardRange,
  type LogicalDatabaseId,
} from "./contracts.js";
import { validateDatabaseTopology } from "./validate.js";

export const OFFICIAL_LOCAL_VIRTUAL_SHARD_COUNT = 1024;
export const OFFICIAL_LOCAL_PHYSICAL_SHARD_COUNT = 4;

export const OFFICIAL_LOCAL_DATABASE_TOPOLOGY_POLICY = Object.freeze({
  sharding: "automatic",
  virtualShardCount: OFFICIAL_LOCAL_VIRTUAL_SHARD_COUNT,
  minPhysicalShards: OFFICIAL_LOCAL_PHYSICAL_SHARD_COUNT,
  replicas: 0,
  writeConsistency: "single-writer",
  readConsistency: "strong",
} satisfies DatabaseTopologyPolicy);

export interface CreateOfficialLocalDatabaseTopologyOptions {
  readonly logicalDatabaseId?: string | LogicalDatabaseId;
  readonly nodeId?: string;
  readonly engine?: string;
  readonly virtualShardCount?: number;
  readonly physicalShardCount?: number;
}

function paddedId(prefix: string, index: number, width: number): string {
  return `${prefix}-${String(index).padStart(width, "0")}`;
}

export function createOfficialLocalDatabaseTopology(
  options: CreateOfficialLocalDatabaseTopologyOptions = {},
): DatabaseTopologySnapshot {
  const databaseId = logicalDatabaseId(
    options.logicalDatabaseId ?? "primary",
  );
  const nodeId = options.nodeId ?? "local";
  const engine = options.engine ?? "sqlite";
  const virtualShardCount =
    options.virtualShardCount ?? OFFICIAL_LOCAL_VIRTUAL_SHARD_COUNT;
  const physicalShardCount =
    options.physicalShardCount ?? OFFICIAL_LOCAL_PHYSICAL_SHARD_COUNT;

  if (
    !Number.isSafeInteger(virtualShardCount) ||
    virtualShardCount < 1 ||
    DATABASE_PARTITION_SPACE_SIZE % virtualShardCount !== 0
  ) {
    throw new TypeError(
      "virtualShardCount must be a positive divisor of the 32-bit partition space.",
    );
  }
  if (
    !Number.isSafeInteger(physicalShardCount) ||
    physicalShardCount < OFFICIAL_LOCAL_PHYSICAL_SHARD_COUNT ||
    physicalShardCount > virtualShardCount
  ) {
    throw new TypeError(
      `Official local physicalShardCount must be an integer from ${OFFICIAL_LOCAL_PHYSICAL_SHARD_COUNT} through virtualShardCount.`,
    );
  }
  if (nodeId.length === 0 || engine.length === 0) {
    throw new TypeError("Local topology requires non-empty Node and engine IDs.");
  }

  const physicalWidth = Math.max(4, String(physicalShardCount).length);
  const virtualWidth = Math.max(4, String(virtualShardCount - 1).length);
  const physicalShards: DatabasePhysicalShard[] = Array.from(
    { length: physicalShardCount },
    (_, index) => ({
      id: physicalShardId(paddedId("pshard", index + 1, physicalWidth)),
      engine,
    }),
  );
  const rangeSize = DATABASE_PARTITION_SPACE_SIZE / virtualShardCount;
  const virtualShards: DatabaseVirtualShardRange[] = Array.from(
    { length: virtualShardCount },
    (_, index) => {
      const physicalIndex = Math.floor(
        (index * physicalShardCount) / virtualShardCount,
      );
      const target = physicalShards[physicalIndex];
      if (!target) {
        throw new TypeError("Unable to assign a physical shard.");
      }
      return {
        id: virtualShardId(paddedId("vshard", index, virtualWidth)),
        startInclusive: index * rangeSize,
        endExclusive: (index + 1) * rangeSize,
        physicalShardId: target.id,
      };
    },
  );

  const policy: DatabaseTopologyPolicy = {
    ...OFFICIAL_LOCAL_DATABASE_TOPOLOGY_POLICY,
    virtualShardCount,
    minPhysicalShards: physicalShardCount,
  };
  const desired: DatabaseDesiredTopology = {
    version: DATABASE_TOPOLOGY_VERSION,
    logicalDatabaseId: databaseId,
    generation: 1,
    partitionHash: DATABASE_PARTITION_HASH_ALGORITHM,
    partitionKey: "tenant",
    policy,
    virtualShards,
    physicalShards,
  };
  const observed: DatabaseObservedTopology = {
    generation: 1,
    placements: physicalShards.map((shard) => ({
      id: databasePlacementId(`placement-${shard.id}-writer`),
      replicaId: databaseReplicaId(`replica-${shard.id}-writer`),
      physicalShardId: shard.id,
      nodeId,
      role: "writer",
      generation: 1,
      state: "active",
      health: "ready",
      target: `local://${shard.id}`,
    })),
  };

  return validateDatabaseTopology({ desired, observed });
}
