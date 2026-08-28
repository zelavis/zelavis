declare const logicalDatabaseIdBrand: unique symbol;
declare const virtualShardIdBrand: unique symbol;
declare const physicalShardIdBrand: unique symbol;
declare const databaseReplicaIdBrand: unique symbol;
declare const databasePlacementIdBrand: unique symbol;

export type LogicalDatabaseId = string & {
  readonly [logicalDatabaseIdBrand]: "LogicalDatabaseId";
};

export type VirtualShardId = string & {
  readonly [virtualShardIdBrand]: "VirtualShardId";
};

export type PhysicalShardId = string & {
  readonly [physicalShardIdBrand]: "PhysicalShardId";
};

export type DatabaseReplicaId = string & {
  readonly [databaseReplicaIdBrand]: "DatabaseReplicaId";
};

export type DatabasePlacementId = string & {
  readonly [databasePlacementIdBrand]: "DatabasePlacementId";
};

function brandedId<T extends string>(kind: string, value: string): T {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${kind} must be a non-empty string without surrounding whitespace.`);
  }
  return value as T;
}

export function logicalDatabaseId(value: string): LogicalDatabaseId {
  return brandedId<LogicalDatabaseId>("Logical database ID", value);
}

export function virtualShardId(value: string): VirtualShardId {
  return brandedId<VirtualShardId>("Virtual shard ID", value);
}

export function physicalShardId(value: string): PhysicalShardId {
  return brandedId<PhysicalShardId>("Physical shard ID", value);
}

export function databaseReplicaId(value: string): DatabaseReplicaId {
  return brandedId<DatabaseReplicaId>("Database replica ID", value);
}

export function databasePlacementId(value: string): DatabasePlacementId {
  return brandedId<DatabasePlacementId>("Database placement ID", value);
}

export const DATABASE_TOPOLOGY_VERSION = 1 as const;
export const DATABASE_PARTITION_HASH_ALGORITHM = "fnv1a-32-v1" as const;
export const DATABASE_PARTITION_SPACE_SIZE = 0x1_0000_0000;

export type DatabaseTopologyVersion = typeof DATABASE_TOPOLOGY_VERSION;
export type DatabasePartitionHashAlgorithm =
  typeof DATABASE_PARTITION_HASH_ALGORITHM;

export type DatabaseReadConsistency =
  | "strong"
  | "read-your-writes"
  | "eventual";

export interface DatabaseTopologyPolicy {
  readonly sharding: "manual" | "automatic";
  readonly virtualShardCount: number;
  readonly minPhysicalShards: number;
  readonly maxPhysicalShards?: number;
  readonly replicas: number;
  readonly writeConsistency: "single-writer";
  readonly readConsistency: DatabaseReadConsistency;
  readonly placementClass?: string;
}

export interface DatabaseVirtualShardRange {
  readonly id: VirtualShardId;
  readonly startInclusive: number;
  readonly endExclusive: number;
  readonly physicalShardId: PhysicalShardId;
}

export interface DatabasePhysicalShard {
  readonly id: PhysicalShardId;
  readonly engine: string;
}

export interface DatabaseDesiredTopology {
  readonly version: DatabaseTopologyVersion;
  readonly logicalDatabaseId: LogicalDatabaseId;
  readonly generation: number;
  readonly partitionHash: DatabasePartitionHashAlgorithm;
  readonly partitionKey: "tenant";
  readonly policy: DatabaseTopologyPolicy;
  readonly virtualShards: readonly DatabaseVirtualShardRange[];
  readonly physicalShards: readonly DatabasePhysicalShard[];
}

export type DatabasePlacementRole = "writer" | "replica";

export type DatabasePlacementState =
  | "preparing"
  | "active"
  | "draining"
  | "inactive"
  | "failed";

export type DatabasePlacementHealth =
  | "ready"
  | "degraded"
  | "unavailable";

export interface DatabaseShardPlacement {
  readonly id: DatabasePlacementId;
  readonly replicaId: DatabaseReplicaId;
  readonly physicalShardId: PhysicalShardId;
  readonly nodeId: string;
  readonly role: DatabasePlacementRole;
  readonly generation: number;
  readonly state: DatabasePlacementState;
  readonly health: DatabasePlacementHealth;
  readonly target?: string;
}

export interface DatabaseObservedTopology {
  readonly generation: number;
  readonly placements: readonly DatabaseShardPlacement[];
}

export interface DatabaseTopologySnapshot {
  readonly desired: DatabaseDesiredTopology;
  readonly observed: DatabaseObservedTopology;
}

export interface DatabaseTopologyRouteInput {
  readonly tenantId: string;
  readonly intent?: "read" | "write";
  readonly consistency?: DatabaseReadConsistency;
}

export interface DatabaseTopologyRoute {
  readonly logicalDatabaseId: LogicalDatabaseId;
  readonly topologyGeneration: number;
  readonly tenantId: string;
  readonly partitionHash: number;
  readonly virtualShardId: VirtualShardId;
  readonly physicalShardId: PhysicalShardId;
  readonly placement: DatabaseShardPlacement;
  readonly consistency: DatabaseReadConsistency;
}

export class DatabaseTopologyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseTopologyError";
  }
}

export class DatabaseTopologyValidationError extends DatabaseTopologyError {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseTopologyValidationError";
  }
}

export class DatabaseTopologyRouteError extends DatabaseTopologyError {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseTopologyRouteError";
  }
}
