import { Effect, type Scope } from "effect";
import type { DbError } from "./errors.js";
import { documentsFor, type DocumentsApi, type DocumentWritten } from "./documents.js";
import type { ObjectIdentity } from "./model.js";
import { domainEventsFor, type DomainEventsApi } from "./domain-events.js";
import { projectionsFor, type ProjectionsApi } from "./projections.js";
import { schemasFor, type SchemasApi } from "./schemas.js";
import { timeSeriesFor, type TimeSeriesApi } from "./time-series.js";
import { backupsFor, type BackupsApi } from "./backup.js";
import {
  initPartitionMap,
  initPlacementCatalog,
  tenantsOn,
  topologyFor,
  type TopologyApi,
} from "./topology-store.js";
import { systemViewsFor, type SystemViewsApi } from "./system-views.js";
import { scatterOver, type ScatterApi } from "./scatter.js";
import { movementOver, type MovementApi } from "./movement.js";
import { migrationsFor, type MigrationsApi } from "./migrations.js";
import { replicationOver, type ReplicationApi } from "./replication.js";
import type { ObjectStoreApi } from "./store.js";
import { isValidCollectionName } from "./naming.js";
import {
  GLOBAL_SHARD,
  GLOBAL_TENANT,
  shardFor,
  shardsOf,
  TOPOLOGY_SHARD,
  type PartitionMap,
  type ShardId,
  type TenantId,
} from "./topology.js";

/** Everything scoped to one tenant, on the shard the map places it. */
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

  /**
   * App-scoped collections replicated onto this tenant's shard.
   *
   * Read-only, and physically local: that is the whole point of paying to
   * replicate. It is a separate handle rather than part of `documents` because
   * the two are different data — a query cannot intersect across them, since
   * they are different tenants and so address different lens keys.
   *
   * What it shows is as fresh as the last `db.replication.refresh`, not as
   * fresh as the last write to the global store.
   */
  readonly shared: SharedDocumentsApi;
}

/**
 * The read half of `DocumentsApi`.
 *
 * A replica has no writer: writing here would make a shard's copy disagree with
 * the store it is a copy of, and the next refresh would silently discard it.
 */
export type SharedDocumentsApi = Pick<
  DocumentsApi,
  "listCollections" | "collectionExists" | "findById" | "findMany" | "findPage"
>;

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
   * Write every shard's live records down as of its current position.
   *
   * What keeps a rebuild from history possible after compaction has cut it.
   */
  readonly snapshot: Effect.Effect<ReadonlyArray<ShardSnapshot>, DbError>;

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

export interface ShardSnapshot {
  readonly shard: ShardId;
  readonly records: number;
  readonly position: number;
}

export interface ShardSeal {
  readonly shard: ShardId;
  readonly segments: number;
  readonly postings: number;
  readonly examined: number;
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

  /**
   * Data belonging to the App rather than to any one tenant.
   *
   * The same surface a tenant gets, because that is what it structurally is:
   * one reserved tenant in one reserved store that no partition map places.
   * Plan definitions, feature flags and shared lookup tables live here instead
   * of being copied into every tenant or kept outside the database entirely.
   *
   * It is not a partition, so `scatter` never reads it, and a write here is not
   * atomic with a write to any tenant: the two are different stores, and this
   * database has no cross-store transaction.
   */
  readonly global: TenantApi;

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
   * Materializing App-scoped data onto every shard.
   *
   * Explicit rather than automatic, and it runs when a database opens. A write
   * to a `replicated` collection reaches `tenant.shared` at the next refresh,
   * not at the moment it commits.
   */
  readonly replication: ReplicationApi;

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
  // Placed beside the map, in the same store, because both answer where
  // something lives and a reader that had one without the other could route.
  const placementCatalog = yield* initPlacementCatalog(topologyStore);
  const globalStore = yield* options.openShard(GLOBAL_SHARD);

  const shards = new Map<ShardId, ObjectStoreApi>();
  for (const shard of shardsOf(partitionMap)) {
    shards.set(shard, yield* options.openShard(shard));
  }

  const topology = topologyFor(topologyStore, partitionMap, shards, placementCatalog);
  const movement = movementOver({ topologyStore, topology, shards });
  // Routing may already have left a source shard whose cleanup is unfinished.
  // Earlier phases also need target shards not yet named by the current map.
  for (const move of yield* movement.pending) {
    for (const shard of new Set([move.from, move.to, ...shardsOf(move.map)])) {
      if (!shards.has(shard)) shards.set(shard, yield* options.openShard(shard));
    }
  }

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
    [GLOBAL_SHARD, globalStore],
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
    snapshot: Effect.map(
      acrossShards((store) => store.snapshot),
      (results) => results.map(([shard, result]) => ({ shard, ...result })),
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

  const tenantApiOver = (store: ObjectStoreApi, tenant: TenantId): TenantApi => {
    const events = domainEventsFor(store, tenant, nodeId);
    const schemas = schemasFor(store, tenant);
    const projections = projectionsFor(store, events, tenant);
    const documents = documentsFor(store, tenant, schemas);
    const timeSeries = timeSeriesFor(store, projections, tenant);
    // The App's replicated collections as they sit on *this* store, read under
    // the tenant that owns them. Same shard, so no second store is opened and
    // no partition is crossed.
    const shared = documentsFor(store, GLOBAL_TENANT, schemasFor(store, GLOBAL_TENANT));
    return {
      documents,
      events,
      projections,
      schemas,
      timeSeries,
      backups: backupsFor(store, tenant),
      migrations: migrationsFor(documents, schemas, tenant),
      systemViews: systemViewsFor({ documents, events, schemas, projections, timeSeries }),
      shared,
    };
  };

  const replication = replicationOver({
    globalStore,
    shards,
    placement: topology.placement,
  });

  /**
   * Carry what a write changed to the replicas, by identity.
   *
   * A refresh has to compare whole states because nothing tells it what moved.
   * A write knows, so it pays one record per shard rather than the collection
   * per shard — which is what makes doing this on every write affordable at
   * all. Dies rather than reports: `DocumentsApi` has no channel for a
   * replication failure, and a copy silently left behind would be worse.
   */
  const propagating = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    changed: (result: A) => ReadonlyArray<ObjectIdentity>,
  ): Effect.Effect<A, E, R> =>
    Effect.tap(effect, (result) =>
      Effect.forEach(
        changed(result),
        (identity) => Effect.orDie(replication.propagate(identity)),
        { discard: true },
      ));

  /**
   * Re-level every replica after a change that is not one record's.
   *
   * An index, an analyzer or an embedding rewrites the manifest of every
   * document in the collection, so there is no single identity to carry. These
   * are rare next to writing a document, which is why the expensive answer is
   * the right one here and the wrong one there.
   */
  const relevelling = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.tap(effect, () => Effect.orDie(replication.refresh));

  const writtenIdentities = (
    written: ReadonlyArray<DocumentWritten>,
  ): ReadonlyArray<ObjectIdentity> =>
    written.map((entry) =>
      entry._tag === "Deleted"
        ? replication.documentIdentity(entry.collection, entry.id)
        : replication.documentIdentity(entry.document.collection, entry.document.id));

  const globalBase = tenantApiOver(globalStore, GLOBAL_TENANT);
  const globalDocuments: DocumentsApi = {
    ...globalBase.documents,

    // One document changed: carry that document.
    insert: (input) =>
      propagating(globalBase.documents.insert(input), (document) => [
        replication.documentIdentity(document.collection, document.id),
      ]),
    update: (input) =>
      propagating(globalBase.documents.update(input), (document) => [
        replication.documentIdentity(document.collection, document.id),
      ]),
    delete: (input) =>
      propagating(globalBase.documents.delete(input), () => [
        replication.documentIdentity(input.collection, input.id),
      ]),
    write: (input) =>
      propagating(globalBase.documents.write(input), writtenIdentities),

    // The collection itself changed, or every document in it did.
    rewrite: (input) => relevelling(globalBase.documents.rewrite(input)),
    createIndex: (input) => relevelling(globalBase.documents.createIndex(input)),
    dropIndex: (input) => relevelling(globalBase.documents.dropIndex(input)),
    addCheck: (input) => relevelling(globalBase.documents.addCheck(input)),
    dropCheck: (input) => relevelling(globalBase.documents.dropCheck(input)),
    addReference: (input) => relevelling(globalBase.documents.addReference(input)),
    dropReference: (input) => relevelling(globalBase.documents.dropReference(input)),
    analyze: (input) => relevelling(globalBase.documents.analyze(input)),
    embed: (input) => relevelling(globalBase.documents.embed(input)),
    rebuildVectorIndex: (input) => relevelling(globalBase.documents.rebuildVectorIndex(input)),
    dropVectorIndex: (input) => relevelling(globalBase.documents.dropVectorIndex(input)),

    // Catalogued before it is written. A catalog entry naming a collection that
    // does not exist yet routes nothing, while a collection missing from the
    // catalog would be App-scoped data the operator index never names — and the
    // two stores cannot commit together. A name the collection API would reject
    // never reaches the catalog, so the only failures left here are a corrupt
    // one.
    //
    // Only an undeclared name is claimed as `global`. Declaring a class first
    // and creating the collection second is how a `replicated` one is made, and
    // a create that insisted on `global` would refuse it.
    createCollection: (input) =>
      propagating(
        isValidCollectionName(input.name)
          && topology.placement.classOf(input.name) === "partitioned"
          ? Effect.flatMap(
              Effect.orDie(topology.placement.declare(input.name, "global")),
              () => globalBase.documents.createCollection(input),
            )
          : globalBase.documents.createCollection(input),
        (collection) => [replication.collectionIdentity(collection.name)],
      ),
  };

  const globalApi: TenantApi = { ...globalBase, documents: globalDocuments };

  // A shard that joined while the database was closed, or one left behind by an
  // interrupted pass, holds a stale copy until something levels it. Opening is
  // the one moment every shard is known to be reachable.
  yield* replication.refresh;

  return {
    get partitionMap() {
      return topology.current();
    },
    maintenance,
    replication,
    scatter: scatterOver({ shards, tenantsOn, shardOf, documentsFor: documentsFor_ }),
    movement,
    topology,
    shardOf,
    global: globalApi,
    forTenant: (tenant) => tenantApiOver(storeFor(tenant), tenant),
  } satisfies DatabaseApi;
});
