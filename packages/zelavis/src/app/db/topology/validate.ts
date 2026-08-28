import {
  DATABASE_PARTITION_HASH_ALGORITHM,
  DATABASE_PARTITION_SPACE_SIZE,
  DATABASE_TOPOLOGY_VERSION,
  DatabaseTopologyValidationError,
  type DatabaseShardPlacement,
  type DatabaseTopologySnapshot,
} from "./contracts.js";

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DatabaseTopologyValidationError(
      `${name} must be a positive safe integer.`,
    );
  }
}

function nonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DatabaseTopologyValidationError(
      `${name} must be a non-negative safe integer.`,
    );
  }
}

function uniqueStrings(name: string, values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw new DatabaseTopologyValidationError(`${name} must be unique.`);
  }
}

function activeWriters(
  placements: readonly DatabaseShardPlacement[],
  physicalShardId: string,
): readonly DatabaseShardPlacement[] {
  return placements.filter(
    (placement) =>
      placement.physicalShardId === physicalShardId &&
      placement.role === "writer" &&
      placement.state === "active",
  );
}

export function validateDatabaseTopology(
  topology: DatabaseTopologySnapshot,
): DatabaseTopologySnapshot {
  const { desired, observed } = topology;

  if (desired.version !== DATABASE_TOPOLOGY_VERSION) {
    throw new DatabaseTopologyValidationError(
      `Unsupported database topology version: ${desired.version}.`,
    );
  }
  if (desired.partitionHash !== DATABASE_PARTITION_HASH_ALGORITHM) {
    throw new DatabaseTopologyValidationError(
      `Unsupported database partition hash: ${desired.partitionHash}.`,
    );
  }

  positiveInteger("Desired topology generation", desired.generation);
  nonNegativeInteger("Observed topology generation", observed.generation);
  positiveInteger(
    "Topology policy virtualShardCount",
    desired.policy.virtualShardCount,
  );
  positiveInteger(
    "Topology policy minPhysicalShards",
    desired.policy.minPhysicalShards,
  );
  nonNegativeInteger("Topology policy replicas", desired.policy.replicas);
  if (desired.policy.maxPhysicalShards !== undefined) {
    positiveInteger(
      "Topology policy maxPhysicalShards",
      desired.policy.maxPhysicalShards,
    );
    if (
      desired.policy.maxPhysicalShards < desired.policy.minPhysicalShards
    ) {
      throw new DatabaseTopologyValidationError(
        "Topology policy maxPhysicalShards must not be below minPhysicalShards.",
      );
    }
  }

  if (desired.virtualShards.length !== desired.policy.virtualShardCount) {
    throw new DatabaseTopologyValidationError(
      "Topology policy virtualShardCount must match the partition map.",
    );
  }
  if (desired.physicalShards.length < desired.policy.minPhysicalShards) {
    throw new DatabaseTopologyValidationError(
      "Desired topology contains fewer physical shards than policy permits.",
    );
  }
  if (
    desired.policy.maxPhysicalShards !== undefined &&
    desired.physicalShards.length > desired.policy.maxPhysicalShards
  ) {
    throw new DatabaseTopologyValidationError(
      "Desired topology contains more physical shards than policy permits.",
    );
  }

  uniqueStrings(
    "Virtual shard IDs",
    desired.virtualShards.map((shard) => shard.id),
  );
  uniqueStrings(
    "Physical shard IDs",
    desired.physicalShards.map((shard) => shard.id),
  );
  uniqueStrings(
    "Database placement IDs",
    observed.placements.map((placement) => placement.id),
  );
  uniqueStrings(
    "Database replica IDs",
    observed.placements.map((placement) => placement.replicaId),
  );

  const physicalShardIds = new Set(
    desired.physicalShards.map((shard) => shard.id),
  );
  const ranges = [...desired.virtualShards].sort(
    (left, right) => left.startInclusive - right.startInclusive,
  );
  let expectedStart = 0;
  for (const range of ranges) {
    if (
      !Number.isSafeInteger(range.startInclusive) ||
      !Number.isSafeInteger(range.endExclusive) ||
      range.startInclusive !== expectedStart ||
      range.endExclusive <= range.startInclusive ||
      range.endExclusive > DATABASE_PARTITION_SPACE_SIZE
    ) {
      throw new DatabaseTopologyValidationError(
        "Virtual shard ranges must cover the partition space exactly once without gaps or overlaps.",
      );
    }
    if (!physicalShardIds.has(range.physicalShardId)) {
      throw new DatabaseTopologyValidationError(
        `Virtual shard ${range.id} references unknown physical shard ${range.physicalShardId}.`,
      );
    }
    expectedStart = range.endExclusive;
  }
  if (expectedStart !== DATABASE_PARTITION_SPACE_SIZE) {
    throw new DatabaseTopologyValidationError(
      "Virtual shard ranges must cover the complete partition space.",
    );
  }

  for (const placement of observed.placements) {
    if (!physicalShardIds.has(placement.physicalShardId)) {
      throw new DatabaseTopologyValidationError(
        `Placement ${placement.id} references unknown physical shard ${placement.physicalShardId}.`,
      );
    }
    positiveInteger(`Placement ${placement.id} generation`, placement.generation);
    if (placement.nodeId.length === 0) {
      throw new DatabaseTopologyValidationError(
        `Placement ${placement.id} requires a Node ID.`,
      );
    }
  }

  for (const shard of desired.physicalShards) {
    const writers = activeWriters(observed.placements, shard.id);
    if (writers.length > 1) {
      throw new DatabaseTopologyValidationError(
        `Physical shard ${shard.id} has multiple active writers.`,
      );
    }
  }

  return topology;
}
