import type {
  ZelavisSystemStore,
  ZelavisSystemStoreValue,
} from "../system-store.js";
import {
  DatabaseTopologyError,
  createOfficialLocalDatabaseTopology,
  validateDatabaseTopology,
  type CreateOfficialLocalDatabaseTopologyOptions,
  type DatabaseTopologySnapshot,
} from "../app/db/topology/index.js";

const APP_DATA_TOPOLOGY_NAMESPACE = "app-data-topology";
const PRIMARY_DATABASE_TOPOLOGY_KEY = "primary";

export interface ResolveLocalDatabaseTopologyOptions
  extends CreateOfficialLocalDatabaseTopologyOptions {
  readonly systemStore?: ZelavisSystemStore;
}

function topologyStoreValue(
  topology: DatabaseTopologySnapshot,
): ZelavisSystemStoreValue {
  return topology as unknown as ZelavisSystemStoreValue;
}

function storedTopology(value: ZelavisSystemStoreValue): DatabaseTopologySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DatabaseTopologyError(
      "Stored App Data Fabric topology must be a JSON object.",
    );
  }
  return validateDatabaseTopology(value as unknown as DatabaseTopologySnapshot);
}

function assertExplicitConfigurationMatches(
  topology: DatabaseTopologySnapshot,
  options: ResolveLocalDatabaseTopologyOptions,
): void {
  if (
    options.logicalDatabaseId !== undefined &&
    topology.desired.logicalDatabaseId !== options.logicalDatabaseId
  ) {
    throw new DatabaseTopologyError(
      "Configured logicalDatabaseId does not match the persisted App data topology.",
    );
  }
  if (
    options.virtualShardCount !== undefined &&
    topology.desired.virtualShards.length !== options.virtualShardCount
  ) {
    throw new DatabaseTopologyError(
      "Configured virtualShardCount does not match the persisted App data topology. Use a topology operation instead of remapping data during startup.",
    );
  }
  if (
    options.physicalShardCount !== undefined &&
    topology.desired.physicalShards.length !== options.physicalShardCount
  ) {
    throw new DatabaseTopologyError(
      "Configured physicalShardCount does not match the persisted App data topology. Use a split or merge operation instead of remapping data during startup.",
    );
  }
}

export async function resolveLocalDatabaseTopology(
  options: ResolveLocalDatabaseTopologyOptions,
): Promise<DatabaseTopologySnapshot> {
  const record = await options.systemStore?.get(
    APP_DATA_TOPOLOGY_NAMESPACE,
    PRIMARY_DATABASE_TOPOLOGY_KEY,
  );
  if (record) {
    const topology = storedTopology(record.value);
    assertExplicitConfigurationMatches(topology, options);
    return topology;
  }

  const topology = createOfficialLocalDatabaseTopology(options);
  await options.systemStore?.set(
    APP_DATA_TOPOLOGY_NAMESPACE,
    PRIMARY_DATABASE_TOPOLOGY_KEY,
    topologyStoreValue(topology),
  );
  return topology;
}
