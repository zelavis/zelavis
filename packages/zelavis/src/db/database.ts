import { Effect, type Scope } from "effect";
import type { DbError } from "./errors.js";
import { documentsFor, type DocumentsApi } from "./documents.js";
import { domainEventsFor, type DomainEventsApi } from "./domain-events.js";
import { projectionsFor, type ProjectionsApi } from "./projections.js";
import { schemasFor, type SchemasApi } from "./schemas.js";
import { timeSeriesFor, type TimeSeriesApi } from "./time-series.js";
import { backupsFor, type BackupsApi } from "./backup.js";
import { initPartitionMap, tenantsOn, topologyFor, type TopologyApi } from "./topology-store.js";
import { systemViewsFor, type SystemViewsApi } from "./system-views.js";
import { scatterOver, type ScatterApi } from "./scatter.js";
import { movementOver, type MovementApi } from "./movement.js";
import { migrationsFor, type MigrationsApi } from "./migrations.js";
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

  /**
   * Bring documents forward from one schema version to another.
   *
   * Separate from `schemas` because activating a version and rewriting what was
   * written under the old one are different decisions: the first changes what
   * is accepted next, the second changes what is already there.
   */
  readonly migrations: MigrationsApi;
  /** The dashboard read surface, built from the APIs above rather than storage. */
  readonly systemViews: SystemViewsApi;
}

/**
 * Storage upkeep, addressed per shard.
 *
 * Compaction is the operation that decides whether a tenant's storage tracks
 * its live objects or every write it has ever taken, so it belongs on the
 * database rather than only on the store an operator cannot reach.
 */
export interface MaintenanceApi {
  /** What each shard holds and how far its log has been cut. */
  readonly status: Effect.Effect<ReadonlyArray<ShardMaintenance>, DbError>;

  /** Cut every shard's log back to its most recent `keep` events. */
  readonly compact: (options?: {
    readonly keep?: number;
  }) => Effect.Effect<ReadonlyArray<ShardCompaction>, DbError>;

  /** Re-derive every shard's postings from its stored manifests. */
  readonly reindex: Effect.Effect<ReadonlyArray<ShardReindex>, DbError>;

  /**
   * Fold every shard's postings into immutable blobs.
   *
   * The read-side counterpart to compaction: compaction stops storage growing
   * with history, sealing stops a wide query costing one b-tree entry per
   * object it matches.
   */
  readonly seal: Effect.Effect<ReadonlyArray<ShardSeal>, DbError>;
}

export interface ShardMaintenance {
  readonly shard: ShardId;
  readonly records: number;
  readonly bytes: number;
  readonly compactedTo: number;
}

export interface ShardCompaction {
  readonly shard: ShardId;
  readonly removed: number;
  readonly compactedTo: number;
}

export interface ShardReindex {
  readonly shard: ShardId;
  readonly records: number;
}

export interface ShardSeal {
  readonly shard: ShardId;
  readonly segments: number;
  readonly postings: number;
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

  /**
   * The map in force now, not the one this database opened with.
   *
   * A relocation changes where tenants live, so a snapshot taken at open would
   * describe the layout as it used to be while reads went somewhere else.
   */
  readonly partitionMap: PartitionMap;

  /** Inspect and change where ranges are placed. */
  readonly topology: TopologyApi;

  /**
   * Relocate tenants so an occupied range can be re-placed.
   *
   * `topology.update` refuses to move a range tenants are standing on, because
   * a map carries routing and no data. This is what makes such a change
   * possible at all: it moves the records first, then the routing.
   */
  readonly movement: MovementApi;

  /** Compaction and reindexing, per shard. */
  readonly maintenance: MaintenanceApi;

  /**
   * Questions that span partitions.
   *
   * Separate from `forTenant` because it is a different bargain, not a wider
   * version of the same one: the cost is the widest predicate on every
   * partition touched, nothing can be intersected across them, and the answer
   * has no ordering that means anything. A caller reaching for this should be
   * choosing it.
   */
  readonly scatter: ScatterApi;
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
  /**
   * Opens one physical shard.
   *
   * Requires a `Scope`, because a shard is an acquired resource that has to be
   * released: the database's lifetime is the shards' lifetime, and saying so in
   * the type is what stops a caller opening one that nothing will close.
   */
  readonly openShard: (
    shard: ShardId,
  ) => Effect.Effect<ObjectStoreApi, DbError, Scope.Scope>;
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

  const topology = topologyFor(topologyStore, partitionMap, shards);

  /**
   * Where a tenant lives *now*.
   *
   * Read from the topology on every call rather than from the map this database
   * opened with. A relocation exists to change that answer, and a handle that
   * kept routing by the map it started with would go on reading the shard the
   * records were moved off.
   */
  const shardOf = (tenant: TenantId): ShardId => shardFor(topology.current(), tenant);

  const storeFor = (tenant: TenantId): ObjectStoreApi => {
    const shard = shardOf(tenant);
    const store = shards.get(shard);
    if (store === undefined) {
      // shardsOf covers every placement, so this is a corrupt map rather than
      // a tenant we simply have not seen.
      throw new Error(`Partition map version ${topology.current().version} places tenant on unopened shard "${shard}".`);
    }
    return store;
  };

  // The topology store is a store like any other: it takes writes, so it grows
  // like any other, and upkeep that skipped it would leave the one store an
  // operator never thinks about as the one that never gets compacted.
  const everyStore = (): ReadonlyArray<readonly [ShardId, ObjectStoreApi]> => [
    [TOPOLOGY_SHARD, topologyStore],
    ...shards,
  ];

  const acrossShards = <A>(
    run: (store: ObjectStoreApi) => Effect.Effect<A, DbError>,
  ): Effect.Effect<ReadonlyArray<readonly [ShardId, A]>, DbError> =>
    Effect.forEach(everyStore(), ([shard, store]) =>
      Effect.map(run(store), (result) => [shard, result] as const),
    );

  const maintenance: MaintenanceApi = {
    status: Effect.map(
      acrossShards((store) =>
        Effect.all({ records: store.liveRecords, compactedTo: store.compactedTo }),
      ),
      (results) =>
        results.map(([shard, { records, compactedTo }]) => ({
          shard,
          records: records.length,
          bytes: records.reduce((total, record) => total + record.bytes.byteLength, 0),
          compactedTo,
        })),
    ),
    compact: (options) =>
      Effect.map(
        acrossShards((store) => store.compact(options)),
        (results) => results.map(([shard, result]) => ({ shard, ...result })),
      ),
    reindex: Effect.map(
      acrossShards((store) => store.reindexLenses),
      (results) => results.map(([shard, records]) => ({ shard, records })),
    ),
    seal: Effect.map(
      acrossShards((store) => store.sealPostings),
      (results) => results.map(([shard, result]) => ({ shard, ...result })),
    ),
  };

  const documentsFor_ = (tenant: TenantId): DocumentsApi => {
    const store = storeFor(tenant);
    return documentsFor(store, tenant, schemasFor(store, tenant));
  };

  return {
    get partitionMap() {
      return topology.current();
    },
    maintenance,
    scatter: scatterOver({ shards, tenantsOn, shardOf, documentsFor: documentsFor_ }),
    movement: movementOver({ topologyStore, topology, shards }),
    topology,
    shardOf,
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
        migrations: migrationsFor(documents, schemas, tenant),
        systemViews: systemViewsFor({ documents, events, schemas, projections, timeSeries }),
      };
    },
  } satisfies DatabaseApi;
});
