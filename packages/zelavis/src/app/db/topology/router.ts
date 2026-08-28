import {
  DatabaseTopologyRouteError,
  type DatabaseReadConsistency,
  type DatabaseShardPlacement,
  type DatabaseTopologyRoute,
  type DatabaseTopologyRouteInput,
  type DatabaseTopologySnapshot,
  type DatabaseVirtualShardRange,
} from "./contracts.js";
import { hashDatabaseTenant } from "./hash.js";
import { validateDatabaseTopology } from "./validate.js";

export interface DatabaseTopologyRouter {
  readonly topology: DatabaseTopologySnapshot;
  route(input: DatabaseTopologyRouteInput): DatabaseTopologyRoute;
}

function findVirtualShard(
  ranges: readonly DatabaseVirtualShardRange[],
  hash: number,
): DatabaseVirtualShardRange {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const range = ranges[middle];
    if (!range) break;
    if (hash < range.startInclusive) {
      high = middle - 1;
    } else if (hash >= range.endExclusive) {
      low = middle + 1;
    } else {
      return range;
    }
  }
  throw new DatabaseTopologyRouteError(
    `No virtual shard owns partition hash ${hash}.`,
  );
}

function eligiblePlacements(
  topology: DatabaseTopologySnapshot,
  physicalShardId: string,
): readonly DatabaseShardPlacement[] {
  return topology.observed.placements
    .filter(
      (placement) =>
        placement.physicalShardId === physicalShardId &&
        placement.state === "active" &&
        placement.health !== "unavailable",
    )
    .sort((left, right) => {
      if (left.generation !== right.generation) {
        return right.generation - left.generation;
      }
      return left.id.localeCompare(right.id);
    });
}

function resolvePlacement(
  topology: DatabaseTopologySnapshot,
  physicalShardId: string,
  intent: "read" | "write",
  consistency: DatabaseReadConsistency,
): DatabaseShardPlacement {
  const placements = eligiblePlacements(topology, physicalShardId);
  const writer = placements.find((placement) => placement.role === "writer");
  if (!writer) {
    throw new DatabaseTopologyRouteError(
      `Physical shard ${physicalShardId} has no eligible active writer.`,
    );
  }

  if (intent === "write" || consistency !== "eventual") {
    return writer;
  }

  return (
    placements.find((placement) => placement.role === "replica") ?? writer
  );
}

export function createDatabaseTopologyRouter(
  input: DatabaseTopologySnapshot,
): DatabaseTopologyRouter {
  const topology = validateDatabaseTopology(input);
  const ranges = [...topology.desired.virtualShards].sort(
    (left, right) => left.startInclusive - right.startInclusive,
  );

  return Object.freeze({
    topology,
    route(routeInput: DatabaseTopologyRouteInput): DatabaseTopologyRoute {
      const tenantId = routeInput.tenantId;
      if (
        typeof tenantId !== "string" ||
        tenantId.length === 0 ||
        tenantId.trim() !== tenantId
      ) {
        throw new DatabaseTopologyRouteError(
          "Database routing requires a non-empty Tenant ID without surrounding whitespace.",
        );
      }

      const intent = routeInput.intent ?? "read";
      const consistency =
        routeInput.consistency ?? topology.desired.policy.readConsistency;
      const partitionHash = hashDatabaseTenant(
        topology.desired.logicalDatabaseId,
        tenantId,
      );
      const virtualShard = findVirtualShard(ranges, partitionHash);
      const placement = resolvePlacement(
        topology,
        virtualShard.physicalShardId,
        intent,
        consistency,
      );

      return {
        logicalDatabaseId: topology.desired.logicalDatabaseId,
        topologyGeneration: topology.desired.generation,
        tenantId,
        partitionHash,
        virtualShardId: virtualShard.id,
        physicalShardId: virtualShard.physicalShardId,
        placement,
        consistency,
      };
    },
  });
}

export function routeDatabaseTenant(
  topology: DatabaseTopologySnapshot,
  input: DatabaseTopologyRouteInput,
): DatabaseTopologyRoute {
  return createDatabaseTopologyRouter(topology).route(input);
}
