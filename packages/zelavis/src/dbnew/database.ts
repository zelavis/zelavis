import { Effect } from "effect";
import type { DbError } from "./errors.js";
import { documentsFor, type DocumentsApi } from "./documents.js";
import { domainEventsFor, type DomainEventsApi } from "./domain-events.js";
import { projectionsFor, type ProjectionsApi } from "./projections.js";
import { schemasFor, type SchemasApi } from "./schemas.js";
import { timeSeriesFor, type TimeSeriesApi } from "./time-series.js";
import { backupsFor, type BackupsApi } from "./backup.js";
import { initPartitionMap, topologyFor, type TopologyApi } from "./topology-store.js";
import { systemViewsFor, type SystemViewsApi } from "./system-views.js";
import type { ObjectStoreApi } from "./store.js";
import { shardFor, shardsOf, type PartitionMap, type ShardId, type TenantId } from "./topology.js";

/** Everything scoped to one tenant, on the shard the map places it. */
/** Holds the partition map. Reserved, so it never collides with a placed shard. */
export const TOPOLOGY_SHARD = "zv.topology";

export interface TenantApi {
  readonly documents: DocumentsApi;
  readonly events: DomainEventsApi;
  readonly projections: ProjectionsApi;
  readonly schemas: SchemasApi;
  readonly timeSeries: TimeSeriesApi;
  readonly backups: BackupsApi;
  /** The dashboard read surface, built from the APIs above rather than storage. */
  readonly systemViews: SystemViewsApi;
}

export interface DatabaseApi {
  /**
   * The logical boundary applications work against.
   *
   * A tenant is the locality unit: everything belonging to one lives on one
   * shard, which is what keeps a cross-model query a local intersection. The
   * shard it lives on is a placement decision, not something the caller states.
   */
  readonly forTenant: (tenant: TenantId) => TenantApi;

  /** Which shard currently holds a tenant. Placement detail, exposed for operators. */
  readonly shardOf: (tenant: TenantId) => ShardId;

  readonly partitionMap: PartitionMap;

  /** Inspect and change where ranges are placed. */
  readonly topology: TopologyApi;
}

export interface MakeDatabaseOptions {
  /**
   * The map to adopt the first time an App opens.
   *
   * Ignored afterwards: the stored map is authoritative, so a caller passing a
   * different shard list on a later open cannot silently re-place ranges out
   * from under the data already sitting on them.
   */
  readonly partitionMap: PartitionMap;
  /** Recorded on every emitted event so a reader can tell writers apart. */
  readonly nodeId?: string;
  /** Opens one physical shard. Scoped, so shards close with the database. */
  readonly openShard: (shard: ShardId) => Effect.Effect<ObjectStoreApi, DbError, never>;
}

/**
 * Open a logical database over a partition map.
 *
 * Every shard the map places a range on is opened up front. The count is fixed
 * and small — an App is sharded from creation rather than gaining shards under
 * load — so routing a tenant is a map lookup rather than an open, and no
 * request pays for a cold file.
 */
export const makeDatabase = Effect.fn("makeDatabase")(function* (
  options: MakeDatabaseOptions,
) {
  const nodeId = options.nodeId ?? "local";

  // The topology lives in a store of its own rather than inside a shard: which
  // shard would hold it is exactly the question it answers. Keeping it in a
  // store means a map change is a logged, versioned, fenced write like any
  // other, rather than a file rewritten in place.
  const topologyStore = yield* options.openShard(TOPOLOGY_SHARD);
  const partitionMap = yield* initPartitionMap(topologyStore, options.partitionMap);

  const shards = new Map<ShardId, ObjectStoreApi>();
  for (const shard of shardsOf(partitionMap)) {
    shards.set(shard, yield* options.openShard(shard));
  }

  const storeFor = (tenant: TenantId): ObjectStoreApi => {
    const shard = shardFor(partitionMap, tenant);
    const store = shards.get(shard);
    if (store === undefined) {
      // shardsOf covers every placement, so this is a corrupt map rather than
      // a tenant we simply have not seen.
      throw new Error(`Partition map version ${partitionMap.version} places tenant on unopened shard "${shard}".`);
    }
    return store;
  };

  return {
    partitionMap,
    topology: topologyFor(topologyStore, partitionMap, shards),
    shardOf: (tenant) => shardFor(partitionMap, tenant),
    forTenant: (tenant) => {
      const store = storeFor(tenant);
      const events = domainEventsFor(store, tenant, nodeId);
      const schemas = schemasFor(store, tenant);
      const projections = projectionsFor(store, events, tenant);
      const documents = documentsFor(store, tenant, schemas);
      const timeSeries = timeSeriesFor(store, projections, tenant);
      return {
        documents,
        events,
        projections,
        schemas,
        timeSeries,
        backups: backupsFor(store, tenant),
        systemViews: systemViewsFor({ documents, events, schemas, projections, timeSeries }),
      };
    },
  } satisfies DatabaseApi;
});
