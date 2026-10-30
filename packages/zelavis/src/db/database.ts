import { type Duration, Effect, Option, type Scope } from "effect";
import type { DbError, InvalidExport, StoreError } from "./errors.js";
import type { KvEngine } from "./kv.js";
import { InvalidConstraint, TenantDivided, TenantNotBranchable, TenantNotDroppable, UnknownPart, type PlacementInUse } from "./errors.js";
import { documentsFor, type DocumentsApi, type DocumentWritten } from "./documents.js";
import type { ObjectIdentity, PartitionKey } from "./model.js";
import { domainEventsFor, type DomainEventsApi } from "./domain-events.js";
import { projectionsFor, type ProjectionsApi } from "./projections.js";
import { schemasFor, type SchemasApi } from "./schemas.js";
import { timeSeriesFor, type TimeSeriesApi } from "./time-series.js";
import { backupsFor, type BackupsApi } from "./backup.js";
import { outboxFor, type OutboxApi } from "./outbox.js";
import {
  initPartitionMap,
  initPlacementCatalog,
  initSubdivisionCatalog,
  tenantsOn,
  topologyFor,
  type TopologyApi,
} from "./topology-store.js";
import { systemViewsFor, type SystemViewsApi } from "./system-views.js";
import { scatterOver, type ScatterApi } from "./scatter.js";
import {
  crossTenantIndexesOver, type CrossTenantIndexesApi, type CrossTenantRefreshOptions,
} from "./cross-tenant-index.js";
import { movementOver, type MovementApi } from "./movement.js";
import { migrationsFor, type MigrationsApi } from "./migrations.js";
import { replicationOver, type ReplicationApi } from "./replication.js";
import { partitionRouter } from "./routing.js";
import type { ObjectStoreApi, ShardStoreApi } from "./store.js";
import type { EventCursor } from "./events.js";
import { exportDividedPage, type ExportPage, type ExportPageInput } from "./export-stream.js";
import { keyValueFor, type KeyValueApi } from "./key-value.js";
import { isReservedTenantId, isValidCollectionName, SERVICE_TENANT_PREFIX } from "./naming.js";
import { OUTBOX_NAMESPACE } from "./tenancy.js";
import {
  GLOBAL_SHARD,
  GLOBAL_TENANT,
  PART_SEPARATOR,
  partitionKeyFor,
  tenantOfPartition,
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
  /** The same records addressed as key/value data: collection = namespace, document id = key. */
  readonly kv: KeyValueApi;
  readonly events: DomainEventsApi;
  readonly projections: ProjectionsApi;
  readonly schemas: SchemasApi;
  readonly timeSeries: TimeSeriesApi;
  readonly backups: BackupsApi;
  /** Messages emitted with this tenant's writes, read back in the order they were committed. */
  readonly outbox: OutboxApi;

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
   * Copy every shard — the topology and global shards with the rest — as it stands, into an empty engine each of `destination` opens: a physical
   * backup through the ordered key-value interface alone, so any engine images into any other and
   * the result is an ordinary shard directory that engine opens as a database. Each shard is copied
   * from one snapshot, so each partition in it is as of one moment; partitions are independent
   * writers, so there is no one moment across them (use the export stream for a Tenant as of one
   * log position per part without holding a snapshot). The snapshot is held for the copy, which is
   * raw bytes and quick; writers carry on. `destination` opens a shard's engine, closed when its copy ends.
   */
  readonly image: (
    destination: (shard: ShardId) => Effect.Effect<KvEngine, StoreError, Scope.Scope>,
  ) => Effect.Effect<ReadonlyArray<ShardImage>, DbError>;

  /**
   * Fold every shard's postings into immutable blobs.
   *
   * The read-side counterpart to compaction: compaction stops storage growing
   * with history, sealing stops a wide query costing one b-tree entry per
   * object it matches.
   */
  readonly seal: Effect.Effect<ReadonlyArray<ShardSeal>, DbError>;
}

/**
 * Upkeep reports, one row per partition: a partition is what owns a log, a
 * compaction point and a seal, and a shard holds as many as it holds tenants.
 */
export interface ShardMaintenance {
  readonly shard: ShardId;
  readonly partition: PartitionKey;
  readonly records: number;
  readonly bytes: number;
  readonly compactedTo: number;
}

export interface ShardImage {
  readonly shard: ShardId;
  /** Keys copied, and the bytes of their keys and values. */
  readonly keys: number;
  readonly bytes: number;
}

export interface ShardCompaction {
  readonly shard: ShardId;
  readonly partition: PartitionKey;
  readonly removed: number;
  readonly compactedTo: number;
  /** Set when a reader's hold kept the pass from going as far as it was asked: where it was held. */
  readonly heldAt?: number;
}

export interface ShardReindex {
  readonly shard: ShardId;
  readonly partition: PartitionKey;
  readonly records: number;
}

export interface ShardSnapshot {
  readonly shard: ShardId;
  readonly partition: PartitionKey;
  readonly records: number;
  readonly position: number;
}

export interface ShardSeal {
  readonly shard: ShardId;
  readonly partition: PartitionKey;
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
   *
   * Refuses a tenant that has been divided, because there is no one shard to
   * answer for: see `forPart`. That refusal is the point — handing back one
   * part would answer a question about a fraction of the tenant as though it
   * were about all of it.
   */
  readonly forTenant: (tenant: TenantId) => TenantApi;

  /**
   * One part of a tenant that is divided across shards.
   *
   * A tenant too large for one shard is the one case the locality bargain
   * cannot be kept: everything belonging to one tenant living on one shard is
   * what makes a cross-model query a local intersection, and a tenant that does
   * not fit has to give that up. Dividing makes the loss explicit rather than
   * letting the shard fill — each part is a partition of its own, no write
   * spans two, and a question about the whole tenant is a `scatter` over
   * `topology.subdivision.keysOf`.
   *
   * Below routing a part is simply a tenant, so it gets the same isolation and
   * the same local intersection *within itself* that an undivided tenant gets.
   */
  readonly forPart: (tenant: TenantId, part: string) => TenantApi;

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
   * Every tenant holding data, across every shard.
   *
   * The database is the only honest answer to this. A list built from whoever
   * has an account would name tenants that hold nothing and miss tenants whose
   * account is gone, because holding data and having a credential are
   * different facts. Each shard already records its own occupants; this is
   * that reading, deduplicated, for an operator looking at the whole database. A divided Tenant is
   * one entry, named once however many of its parts hold data (see `partitions` for the parts' keys,
   * and `topology.subdivision.partsOf` for the parts it is divided into).
   */
  readonly tenants: Effect.Effect<ReadonlyArray<TenantId>, DbError>;

  /**
   * Every partition holding data: a Tenant, or one part of a divided Tenant under its part key
   * (`whale#a`). `tenants` is these with the parts folded back into the Tenant they belong to.
   */
  readonly partitions: Effect.Effect<ReadonlyArray<TenantId>, DbError>;

  /**
   * Remove a Tenant: its records, event log, lenses and meta, in bounded batches, and with them its
   * history. There is no undo and no archive; back it up first.
   *
   * From the moment it starts every change to the Tenant is refused (`TenantMoving`, the same fence a
   * relocation uses), it waits up to the drain timeout for calls still using it (`PlacementInUse` when
   * they do not finish, with the Tenant fenced and nothing yet removed, so the call can simply be repeated),
   * and only then removes it. A Tenant written to afterwards starts again from nothing, with identifiers
   * and log positions beginning over, so a cursor handed out before the removal means nothing to it.
   * Refused for a reserved Tenant, one divided into parts, one holding nothing, and while any relocation
   * is pending. Global data is not the Tenant's and stays.
   */
  readonly dropTenant: (
    tenant: TenantId,
  ) => Effect.Effect<{ readonly tenant: TenantId; readonly shard: ShardId; readonly records: number }, DbError | TenantNotDroppable | PlacementInUse>;

  /**
   * Make `into` a new Tenant holding a copy of `tenant`: its records, its log up to one position, and
   * everything defined in it — collections, schemas, projections, time series and idempotency
   * receipts — as of that position. `tenant` keeps taking writes while it is copied; the branch is the
   * source as of the position it read when its records were copied, and nothing written after that
   * reaches it. Only the branch is leased for the whole copy: the source is read a page per call, so it
   * can be moved while it is branched.
   *
   * Outbox messages the source has not yet had removed are its to deliver, so by default the branch
   * leaves them behind (`outbox: "leave"`): they are retracted in the branch's own log, after the
   * branch point, before anything can read them. `outbox: "copy"` keeps them, for a branch whose
   * consumer is to deliver them again. Receipts stay either way: the writes they guard are in the
   * branch too.
   *
   * The branch keeps the source's identifiers, versions and log positions, so its edges hold, and a
   * cursor or checkpoint from the source up to the branch point carries on in it. It is a Tenant of its
   * own from then on: writes to either never reach the other, and there is no merging back. A divided
   * source makes `into` divided into the same parts and branches each part into its counterpart, each
   * as of a position of its own. Until a copy is whole every read and write of its target fails with
   * `TenantBranching`; a branch cut off is started over by the same call, or when the database next
   * opens. Refused for a reserved or plugin Tenant on either side, a name holding the part separator,
   * a source holding nothing, a target already holding data or divided otherwise, the same name twice,
   * and while any relocation is pending.
   */
  readonly branchTenant: (
    tenant: TenantId,
    into: TenantId,
    options?: BranchTenantOptions,
  ) => Effect.Effect<TenantBranch, DbError | TenantNotBranchable>;

  /**
   * One page of a Tenant read out as a stream: its records, then every change since, from the cursor
   * the last page gave (none starts an export). See `ExportPage`: pages are applied by version, and
   * `consistent` says when what has been received is one position's state. A divided Tenant is one
   * export whose pages advance every part and tag each entry with its part; it is consistent once every
   * part is, each as of its own position. Needs no snapshot held between calls, only the log held until
   * the export is consistent. Refused for a reserved name; a cursor from another Tenant, or from before
   * the Tenant was removed and written again, is a `StoreError`.
   */
  readonly exportPage: (tenant: TenantId, input?: ExportPageInput) => Effect.Effect<ExportPage, DbError | InvalidExport>;

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

  /**
   * One collection's documents from every Tenant, kept current from each
   * Tenant's log, so a live question across Tenants reads one partition
   * instead of asking every Tenant. Eventually consistent; see
   * `cross-tenant-index.ts`.
   */
  readonly crossTenantIndexes: CrossTenantIndexesApi;
}

/** How `branchTenant` treats what is not simply state. */
export interface BranchTenantOptions {
  /** Leave the source's undelivered outbox messages with it (the default), or copy them too. */
  readonly outbox?: "leave" | "copy";
}

/** One partition a branch copied: the whole Tenant, or one part of a divided one. */
export interface PartitionBranch {
  /** The shard the copy lives on. */
  readonly shard: ShardId;
  /** Records copied, retired ones included. */
  readonly records: number;
  /** Events of the source's log copied after its records. */
  readonly events: number;
  /** The end of the copy's log, as a cursor of the branch. */
  readonly cursor?: EventCursor;
}

/**
 * What `branchTenant` made. An undivided Tenant's branch carries its one copy's shard and cursor; a
 * divided one's lists the parts this call copied (`parts`), which leave out any a call cut off had
 * already finished. `records` and `events` are their sums.
 */
export interface TenantBranch {
  readonly tenant: TenantId;
  readonly into: TenantId;
  readonly records: number;
  readonly events: number;
  readonly shard?: ShardId;
  readonly cursor?: EventCursor;
  readonly parts?: ReadonlyArray<PartitionBranch & { readonly part: string }>;
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
   * How long a move waits, once routing points at a tenant's new shard, for
   * calls that reached the old one before it moved to finish. Defaults to 30
   * seconds. Past it the move answers `PlacementInUse`, with routing moved and
   * the old shard still holding the tenant, fenced, until a resume clears it.
   */
  readonly drainTimeout?: Duration.Input;
  /**
   * How cross-Tenant indexes are kept current in the background while the
   * database is open, or `false` to refresh them only when asked.
   */
  readonly crossTenantRefresh?: CrossTenantRefreshOptions | false;
  /**
   * Opens one physical shard.
   *
   * Requires a `Scope`, because a shard is an acquired resource that has to be
   * released: the database's lifetime is the shards' lifetime, and saying so in
   * the type is what stops a caller opening one that nothing will close.
   * `origin` is the node every event the shard accepts is recorded as written
   * by; an opener that ignores it records `"local"`.
   */
  readonly openShard: (
    shard: ShardId,
    context: { readonly origin: string },
  ) => Effect.Effect<ShardStoreApi, DbError, Scope.Scope>;
}

/** How long a move waits for calls still using a tenant's old shard, unless told otherwise. */
const DRAIN_TIMEOUT: Duration.Input = "30 seconds";

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
  const opening = { origin: nodeId };

  // The topology lives in a store of its own rather than inside a shard: which
  // shard would hold it is exactly the question it answers. Keeping it in a
  // store means a map change is a logged, versioned, fenced write like any
  // other, rather than a file rewritten in place. It is the one partition of
  // its shard, named after it.
  const topologyShard = yield* options.openShard(TOPOLOGY_SHARD, opening);
  const topologyStore = topologyShard.partition(TOPOLOGY_SHARD);
  const partitionMap = yield* initPartitionMap(topologyStore, options.partitionMap);
  // Placed beside the map, in the same store, because both answer where
  // something lives and a reader that had one without the other could route.
  const placementCatalog = yield* initPlacementCatalog(topologyStore);
  const subdivisionCatalog = yield* initSubdivisionCatalog(topologyStore);
  const globalShard = yield* options.openShard(GLOBAL_SHARD, opening);
  const globalStore = globalShard.partition(GLOBAL_TENANT);

  const shards = new Map<ShardId, ShardStoreApi>();
  for (const shard of shardsOf(partitionMap)) {
    shards.set(shard, yield* options.openShard(shard, opening));
  }

  const topology = topologyFor(topologyStore, partitionMap, shards, placementCatalog, subdivisionCatalog);

  /**
   * Where a tenant lives *now*.
   *
   * Read from the topology on every call rather than from the map this database
   * opened with. A relocation exists to change that answer, and a handle that
   * kept routing by the map it started with would go on reading the shard the
   * records were moved off.
   */
  const shardOf = (tenant: TenantId): ShardId => shardFor(topology.current(), tenant);
  const router = partitionRouter({
    route: (partition) => {
      const map = topology.current();
      return { shard: shardFor(map, partition), version: map.version };
    },
    shards,
  });
  const drainTimeout = options.drainTimeout ?? DRAIN_TIMEOUT;
  const movement = movementOver({
    topologyStore,
    topology,
    shards,
    drained: (shard, tenant) => router.drained(shard, tenant, drainTimeout),
  });
  // Routing may already have left a source shard whose cleanup is unfinished.
  // Earlier phases also need target shards not yet named by the current map.
  for (const move of yield* movement.pending) {
    for (const shard of new Set([move.from, move.to, ...shardsOf(move.map)])) {
      if (!shards.has(shard)) shards.set(shard, yield* options.openShard(shard, opening));
    }
  }

  /**
   * A tenant's store, never bound to a shard: each operation of the API built
   * over it runs against where the tenant is routed when it starts (see
   * `partitionRouter`), so no handle keeps using a shard a move took it off.
   */
  const crossTenant = yield* crossTenantIndexesOver({
    globalShard,
    shards,
    tenantsOn,
    routed: (partition) => router.routed(partition),
  });

  /**
   * A partition's store whose changes tell the cross-Tenant indexes to read it
   * soon. Only a hint: their sweep finds what this misses.
   */
  const watched = (store: ObjectStoreApi, partition: PartitionKey): ObjectStoreApi => ({
    ...store,
    get generation() {
      return store.generation;
    },
    transact: (f) => Effect.tap(store.transact(f), () => crossTenant.touched(partition)),
    events: {
      ...store.events,
      apply: (event) => Effect.tap(store.events.apply(event), () => crossTenant.touched(partition)),
    },
  });

  const storeFor = (tenant: TenantId): ObjectStoreApi => watched(router.routed(tenant), tenant);

  /** Whether a partition holds anything where routing places it now. */
  const holds = (partition: PartitionKey) =>
    Effect.gen(function* () {
      const store = shards.get(shardOf(partition));
      return store !== undefined && (yield* tenantsOn(store)).includes(partition);
    });

  /**
   * Branch one partition into another, both already checked. Only the target is leased for the whole
   * copy; the source is read a page per call, each routed to wherever it lives then (`seed`), so a move
   * of the source is never held up by its branch.
   */
  const branchPartition = (from: PartitionKey, to: PartitionKey, leave: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const target = storeFor(to);
      const seeded = yield* target.seed(storeFor(from), { branch: true, leave });
      yield* crossTenant.touched(to);
      const cursor = yield* target.events.head;
      return {
        shard: shardOf(to),
        records: seeded.records,
        events: seeded.applied ?? 0,
        ...(cursor === undefined ? {} : { cursor }),
      } satisfies PartitionBranch;
    });

  // The topology store is a store like any other: it takes writes, so it grows
  // like any other, and upkeep that skipped it would leave the one store an
  // operator never thinks about as the one that never gets compacted.
  const everyShard = (): ReadonlyArray<readonly [ShardId, ShardStoreApi]> => [
    [TOPOLOGY_SHARD, topologyShard],
    [GLOBAL_SHARD, globalShard],
    ...shards,
  ];

  /**
   * Run one piece of upkeep on every partition of every shard, one at a time.
   *
   * A tenant's partition is visited only on the shard routing places it on,
   * and under a lease there, so a move never clears a partition upkeep is
   * still working on, and upkeep never writes into one a move has routed away.
   * The topology, the App's own records and their replicas never move.
   */
  const acrossPartitions = <A>(
    run: (store: ObjectStoreApi) => Effect.Effect<A, DbError>,
  ): Effect.Effect<ReadonlyArray<{ readonly shard: ShardId; readonly partition: PartitionKey; readonly result: A }>, DbError> =>
    Effect.map(
      Effect.forEach(everyShard(), ([shard, store]) =>
        Effect.flatMap(store.partitions, (partitions) =>
          Effect.forEach(partitions, (partition) =>
            Effect.map(
              shards.has(shard) && partition !== GLOBAL_TENANT
                ? router.placed(shard, partition, run)
                : Effect.map(run(store.partition(partition)), Option.some),
              (result) => Option.map(result, (value) => ({ shard, partition, result: value })),
            )))),
      (rows) => rows.flat().flatMap((row) => (Option.isSome(row) ? [row.value] : [])),
    );

  const maintenance: MaintenanceApi = {
    status: Effect.map(
      acrossPartitions((store) => store.stats),
      (rows) => rows.map(({ shard, partition, result }) => ({
        shard, partition, records: result.records, bytes: result.bytes, compactedTo: result.compactedTo,
      })),
    ),
    compact: (options) =>
      Effect.map(
        acrossPartitions((store) => store.compact(options)),
        (rows) => rows.map(({ shard, partition, result }) => ({ shard, partition, ...result })),
      ),
    reindex: Effect.map(
      acrossPartitions((store) => store.reindexLenses),
      (rows) => rows.map(({ shard, partition, result }) => ({ shard, partition, records: result })),
    ),
    snapshot: Effect.map(
      acrossPartitions((store) => store.snapshot),
      (rows) => rows.map(({ shard, partition, result }) => ({ shard, partition, ...result })),
    ),
    image: (destination) =>
      Effect.forEach(everyShard(), ([shard, store]) =>
        Effect.scoped(Effect.flatMap(destination(shard), (engine) =>
          Effect.map(store.image(engine), (copied) => ({ shard, ...copied }) satisfies ShardImage)))),
    seal: Effect.map(
      acrossPartitions((store) => store.sealPostings),
      (rows) => rows.map(({ shard, partition, result }) => ({ shard, partition, ...result })),
    ),
  };

  const documentsFor_ = (tenant: TenantId): DocumentsApi => {
    const store = storeFor(tenant);
    return router.operations(documentsFor(store, tenant, schemasFor(store, tenant)), tenant);
  };

  const tenantApiOver = (store: ObjectStoreApi, tenant: TenantId, sharedStore: ObjectStoreApi): TenantApi => {
    const events = domainEventsFor(store, tenant);
    const schemas = schemasFor(store, tenant);
    const projections = projectionsFor(store, events, tenant);
    const documents = documentsFor(store, tenant, schemas);
    const timeSeries = timeSeriesFor(store, events, tenant);
    // The App's replicated collections as they sit on *this* shard, in the
    // partition of the tenant that owns them. Same shard, so no second store is
    // opened.
    const shared = documentsFor(sharedStore, GLOBAL_TENANT, schemasFor(sharedStore, GLOBAL_TENANT));
    return {
      documents,
      kv: keyValueFor(store, tenant, documents, events),
      events,
      projections,
      schemas,
      timeSeries,
      backups: backupsFor(store, tenant),
      outbox: outboxFor(store, documents),
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

  const globalBase = tenantApiOver(globalStore, GLOBAL_TENANT, globalStore);
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
        // A replica holds the App's records under the App's own identifiers,
        // so an edge between two replicated collections names the same record
        // on every shard. An edge to anything else would name nothing on a
        // shard, so a replicated collection may only declare edges to
        // replicated collections — its own included. Refused where the edge is
        // declared rather than where it is first written: this is the only way
        // a collection ever gains edges, and a class does not change once it is
        // claimed, which is what leaves the checks in `replication` as
        // assertions.
        (input.edges ?? []).some((edge) =>
          edge.collection !== input.name && topology.placement.classOf(edge.collection) !== "replicated")
          && topology.placement.classOf(input.name) === "replicated"
          ? new InvalidConstraint({
              collection: input.name,
              name: (input.edges ?? []).find((edge) =>
                edge.collection !== input.name && topology.placement.classOf(edge.collection) !== "replicated")!.name,
              reason:
                "a replicated collection's edges must name replicated collections: a replica holds no other records",
            })
          : isValidCollectionName(input.name)
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

  // A rebuild or reindex cut off by a crash leaves its partition refusing reads
  // and writes until it is finished. Opening is the one moment every shard is
  // open and nothing else writes, so it finishes them before anything reads.
  for (const [, shard] of everyShard()) {
    for (const partition of yield* shard.partitions) {
      yield* shard.partition(partition).resumeMaintenance;
    }
  }

  // A branch cut off by a crash leaves its target refusing every read and write.
  // It is started over here, from the source its lineage names and leaving
  // behind what it was leaving. One that cannot be finished now — its source
  // gone, or a relocation pending — stays as it was, still refusing, for
  // `branchTenant` or `dropTenant` to settle, and the database opens regardless.
  for (const [shardId, shard] of shards) {
    for (const partition of yield* shard.partitions) {
      if (shardOf(partition) !== shardId) continue;
      const stats = yield* shard.partition(partition).stats;
      const from = stats.lineage?.[0]?.partition;
      if (!stats.seeding || from === undefined) continue;
      yield* Effect.gen(function* () {
        if ((yield* movement.pending).length > 0) {
          return yield* Effect.logWarning(`Branch of "${from}" into "${partition}" not resumed: a relocation is pending`);
        }
        if (!(yield* holds(from))) {
          return yield* Effect.logWarning(`Branch of "${from}" into "${partition}" not resumed: "${from}" holds nothing`);
        }
        yield* branchPartition(from, partition, stats.leaving ?? []);
      }).pipe(Effect.catchCause((cause) =>
        Effect.logWarning(`Branch of "${from}" into "${partition}" not resumed`, cause)));
    }
  }

  // A shard that joined while the database was closed, or one left behind by an
  // interrupted pass, holds a stale copy until something levels it. Opening is
  // the one moment every shard is known to be reachable.
  yield* replication.refresh;

  // Last, so its first pass reads shards nothing is still finishing.
  if (options.crossTenantRefresh !== false) {
    yield* Effect.forkScoped(crossTenant.background(options.crossTenantRefresh));
  }

  /** A partition's handle, routed like any operation: the Tenant itself, or one part under its part key. */
  const handleOf = (key: TenantId) =>
    router.operations(tenantApiOver(storeFor(key), key, router.routed(GLOBAL_TENANT, key)), key);

  const partitions = Effect.gen(function* () {
    const found = new Set<TenantId>();
    for (const store of shards.values()) {
      for (const partition of yield* tenantsOn(store)) found.add(partition);
    }
    return [...found].sort();
  });

  return {
    get partitionMap() {
      return topology.current();
    },
    maintenance,
    replication,
    scatter: scatterOver({ shards, tenantsOn, shardOf, documentsFor: documentsFor_ }),
    crossTenantIndexes: crossTenant.api,
    movement,
    topology,
    shardOf,
    partitions,
    tenants: Effect.map(partitions, (keys) => [...new Set(keys.map(tenantOfPartition))].sort()),
    exportPage: (tenant, input) =>
      Effect.suspend(() => {
        const parts = topology.subdivision.partsOf(tenant);
        if (parts === undefined) return handleOf(tenant).backups.exportPage(input);
        return exportDividedPage(tenant, parts, input ?? {}, (part, cursor, limit) =>
          Effect.suspend(() => handleOf(partitionKeyFor(tenant, part)).backups.exportPage({ ...(cursor === undefined ? {} : { cursor }), limit })));
      }),
    branchTenant: (tenant, into, branchOptions) =>
      Effect.gen(function* () {
        const refuse = (reason: string) => new TenantNotBranchable({ tenant, into, reason });
        for (const name of [tenant, into]) {
          if (isReservedTenantId(name) || name === GLOBAL_TENANT) return yield* refuse(`"${name}" is reserved`);
          if (name.startsWith(SERVICE_TENANT_PREFIX)) return yield* refuse(`"${name}" belongs to a plugin`);
          // A name with the separator would be some divided Tenant's part.
          if (name.includes(PART_SEPARATOR)) return yield* refuse(`"${name}" names a part; branch the Tenant it belongs to`);
        }
        if (tenant === into) return yield* refuse("a Tenant cannot be branched into itself");
        const outbox = branchOptions?.outbox ?? "leave";
        if (outbox !== "leave" && outbox !== "copy") return yield* refuse(`outbox must be "leave" or "copy", not "${String(outbox)}"`);
        const leave = outbox === "leave" ? [OUTBOX_NAMESPACE] : [];
        if ((yield* movement.pending).length > 0) return yield* refuse("a relocation is pending");
        const occupied = () => refuse(`"${into}" already holds data`);
        const parts = topology.subdivision.partsOf(tenant);
        const intoParts = topology.subdivision.partsOf(into);

        if (parts === undefined) {
          if (intoParts !== undefined) return yield* refuse(`"${into}" is divided into parts and "${tenant}" is not`);
          if (!(yield* holds(tenant))) return yield* refuse(`"${tenant}" holds nothing`);
          const made = yield* branchPartition(tenant, into, leave).pipe(
            Effect.catchTag("TenantNotEmpty", () => Effect.fail(occupied())),
          );
          return { tenant, into, ...made } satisfies TenantBranch;
        }

        // Divided: `into` is divided the same way, and each part is branched into its counterpart.
        const held: string[] = [];
        for (const part of parts) if (yield* holds(partitionKeyFor(tenant, part))) held.push(part);
        if (held.length === 0) return yield* refuse(`"${tenant}" holds nothing`);
        if (intoParts === undefined) {
          if (yield* holds(into)) return yield* occupied();
          yield* topology.subdivision.subdivide(into, parts).pipe(
            Effect.catchTag("SubdivisionInvalid", (invalid) => Effect.fail(refuse(invalid.reason))),
          );
        } else if (intoParts.length !== parts.length || intoParts.some((part, at) => part !== parts[at])) {
          return yield* refuse(`"${into}" is divided into ${intoParts.join(", ")}, not ${parts.join(", ")}`);
        }
        const made: Array<PartitionBranch & { readonly part: string }> = [];
        for (const part of held) {
          const from = partitionKeyFor(tenant, part);
          const to = partitionKeyFor(into, part);
          // Finished by an earlier call cut off before every part was: not copied again.
          const stats = yield* storeFor(to).stats;
          if (!stats.seeding && stats.lineage?.[0]?.partition === from) continue;
          made.push({
            part,
            ...(yield* branchPartition(from, to, leave).pipe(
              Effect.catchTag("TenantNotEmpty", () => Effect.fail(refuse(`part "${part}" of "${into}" already holds data`))),
            )),
          });
        }
        if (made.length === 0) return yield* occupied();
        return {
          tenant,
          into,
          records: made.reduce((sum, entry) => sum + entry.records, 0),
          events: made.reduce((sum, entry) => sum + entry.events, 0),
          parts: made,
        } satisfies TenantBranch;
      }),
    dropTenant: (tenant) =>
      Effect.gen(function* () {
        if (isReservedTenantId(tenant) || tenant === GLOBAL_TENANT) return yield* new TenantNotDroppable({ tenant, reason: "it is reserved" });
        if (topology.subdivision.partsOf(tenant) !== undefined) return yield* new TenantNotDroppable({ tenant, reason: "it is divided into parts" });
        if ((yield* movement.pending).length > 0) return yield* new TenantNotDroppable({ tenant, reason: "a relocation is pending" });
        const shard = shardOf(tenant);
        const held = shards.get(shard);
        if (held === undefined || !(yield* tenantsOn(held)).includes(tenant)) return yield* new TenantNotDroppable({ tenant, reason: "it holds nothing" });
        // Refuse every change first, then wait out what is running, then remove: nothing can land after the removal began.
        yield* storeFor(tenant).fence({ from: shard, to: "removed" });
        yield* router.drained(shard, tenant, drainTimeout);
        return { tenant, shard, records: yield* held.drop(tenant) };
      }),
    global: globalApi,
    forTenant: (tenant) => {
      // Returning one part's handle would answer questions about a fraction of
      // the tenant as though they were about all of it — the quiet wrong answer
      // this whole design exists to avoid. Naming a part is the only honest way
      // in, so it is required rather than defaulted.
      const parts = topology.subdivision.partsOf(tenant);
      // Synchronous, so refused by throwing — a typed error, which the HTTP
      // routes answer as a bad request naming the parts.
      if (parts !== undefined) throw new TenantDivided({ tenant, parts });
      return router.operations(tenantApiOver(storeFor(tenant), tenant, router.routed(GLOBAL_TENANT, tenant)), tenant);
    },
    forPart: (tenant, part) => {
      const parts = topology.subdivision.partsOf(tenant);
      if (parts === undefined || !parts.includes(part)) throw new UnknownPart({ tenant, part, parts: parts ?? [] });
      const key = partitionKeyFor(tenant, part);
      return router.operations(tenantApiOver(storeFor(key), key, router.routed(GLOBAL_TENANT, key)), key);
    },
  } satisfies DatabaseApi;
});
