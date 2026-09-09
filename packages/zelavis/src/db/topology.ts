import { Schema } from "effect";

export type TenantId = string;
export type ShardId = string;

/**
 * The number of virtual ranges a logical database is divided into.
 *
 * Tenants hash to a virtual range, and ranges are placed on physical shards.
 * The indirection is the point: moving a tenant means moving a range placement,
 * not rehashing every tenant, so growing from one shard to many never
 * reassigns data that did not move.
 */
export const DEFAULT_VIRTUAL_RANGES = 256;

/**
 * The physical shards an App is created with.
 *
 * Four on one Node, because sharding is the topology from creation rather than
 * something added under load: scaling out later moves placements instead of
 * introducing partitioning for the first time.
 */
export const DEFAULT_LOCAL_SHARDS: ReadonlyArray<ShardId> = Object.freeze([
  "shard-0",
  "shard-1",
  "shard-2",
  "shard-3",
]);

export interface RangePlacement {
  /** Inclusive. */
  readonly from: number;
  /** Exclusive. */
  readonly to: number;
  readonly shard: ShardId;
}

export interface PartitionMap {
  readonly version: number;
  readonly virtualRanges: number;
  readonly placements: ReadonlyArray<RangePlacement>;
}

export const PartitionMapWire = Schema.Struct({
  version: Schema.Finite,
  virtualRanges: Schema.Finite,
  placements: Schema.Array(
    Schema.Struct({ from: Schema.Finite, to: Schema.Finite, shard: Schema.String }),
  ),
});

/** FNV-1a, 32-bit. Stable across processes and runtimes, which a tenant's placement must be. */
const hash = (value: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

export const virtualRangeFor = (map: PartitionMap, tenant: TenantId): number =>
  hash(tenant) % map.virtualRanges;

export const shardFor = (map: PartitionMap, tenant: TenantId): ShardId => {
  const slot = virtualRangeFor(map, tenant);
  for (const placement of map.placements) {
    if (slot >= placement.from && slot < placement.to) return placement.shard;
  }
  // A map that does not cover every range is a corrupt map, not a missing case.
  throw new Error(`Partition map version ${map.version} does not place range ${slot}.`);
};

/**
 * An even placement of every virtual range across the given shards.
 *
 * A single-node App uses this too, with several shards that happen to share one
 * Node, so scaling out later moves placements rather than introducing sharding
 * for the first time.
 */
export const partitionMapFor = (
  shards: ReadonlyArray<ShardId>,
  options?: { readonly version?: number; readonly virtualRanges?: number },
): PartitionMap => {
  if (shards.length === 0) throw new Error("A partition map needs at least one shard.");
  const virtualRanges = options?.virtualRanges ?? DEFAULT_VIRTUAL_RANGES;
  if (virtualRanges < shards.length) {
    throw new Error(
      `A partition map needs at least one virtual range per shard (${virtualRanges} < ${shards.length}).`,
    );
  }
  const placements: RangePlacement[] = [];
  let cursor = 0;
  for (let i = 0; i < shards.length; i++) {
    const remaining = shards.length - i;
    const width = Math.ceil((virtualRanges - cursor) / remaining);
    placements.push({ from: cursor, to: cursor + width, shard: shards[i]! });
    cursor += width;
  }
  return { version: options?.version ?? 1, virtualRanges, placements };
};

/** Every shard a map places a range on, in placement order. */
export const shardsOf = (map: PartitionMap): ReadonlyArray<ShardId> => [
  ...new Set(map.placements.map((p) => p.shard)),
];
