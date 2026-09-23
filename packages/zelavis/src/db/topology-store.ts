import { Effect, Stream } from "effect";
import {
  PartitionMapInvalid,
  PlacementCatalogInvalid,
  PlacementImmutable,
  RangeNotEmpty,
} from "./errors.js";
import { isReservedCollectionName, isValidCollectionName } from "./naming.js";
import { equals } from "./query.js";
import type { ObjectStoreApi } from "./store.js";
import { TENANT_COLUMN, TENANT_MARKER } from "./tenancy.js";
import {
  GLOBAL_SHARD,
  PLACEMENT_CLASSES,
  shardFor,
  shardsOf,
  TOPOLOGY_SHARD,
  virtualRangeFor,
  type PartitionMap,
  type PlacementClass,
  type ShardId,
  type TenantId,
} from "./topology.js";

const TOPOLOGY_NS = TOPOLOGY_SHARD;
const TOPOLOGY_KEY = "partition-map";
const PLACEMENT_KEY = "placement-catalog";

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * A map must place every virtual range exactly once.
 *
 * A gap silently strands the tenants that hash into it; an overlap gives two
 * shards a claim on the same data. Both are caught before a map is stored,
 * rather than when a tenant next tries to route.
 */
export const validatePartitionMap = (map: PartitionMap): PartitionMapInvalid | undefined => {
  if (map.virtualRanges <= 0) {
    return new PartitionMapInvalid({
      version: map.version,
      reason: "virtualRanges must be positive",
    });
  }
  const ordered = [...map.placements].sort((a, b) => a.from - b.from);
  let cursor = 0;
  for (const placement of ordered) {
    if (placement.to <= placement.from) {
      return new PartitionMapInvalid({
        version: map.version,
        reason: `placement ${placement.from}..${placement.to} is empty or inverted`,
      });
    }
    if (placement.from !== cursor) {
      return new PartitionMapInvalid({
        version: map.version,
        reason:
          placement.from < cursor
            ? `ranges ${placement.from}..${placement.to} overlap an earlier placement`
            : `ranges ${cursor}..${placement.from} are unplaced`,
      });
    }
    cursor = placement.to;
  }
  if (cursor !== map.virtualRanges) {
    return new PartitionMapInvalid({
      version: map.version,
      reason: `ranges ${cursor}..${map.virtualRanges} are unplaced`,
    });
  }
  return undefined;
};

/** Tenants known to hold data on this shard. */
export const tenantsOn = (store: ObjectStoreApi): Effect.Effect<ReadonlyArray<TenantId>> =>
  Effect.gen(function* () {
    const seqs = yield* Stream.runCollect(store.resolve(equals(TENANT_COLUMN, TENANT_MARKER)));
    const out: TenantId[] = [];
    for (const seq of seqs) {
      const object = yield* store.read(seq);
      if (object !== undefined) {
        out.push((JSON.parse(dec.decode(object.bytes)) as { tenant: string }).tenant);
      }
    }
    return out.sort();
  }).pipe(Effect.orDie);

export const loadPartitionMap = (
  store: ObjectStoreApi,
): Effect.Effect<PartitionMap | undefined> =>
  Effect.gen(function* () {
    const seq = yield* store.lookup(TOPOLOGY_NS, TOPOLOGY_KEY);
    if (seq === undefined) return undefined;
    const object = yield* store.read(seq);
    return object === undefined
      ? undefined
      : (JSON.parse(dec.decode(object.bytes)) as PartitionMap);
  }).pipe(Effect.orDie);

const writePartitionMap = (store: ObjectStoreApi, map: PartitionMap) =>
  Effect.gen(function* () {
    const existing = yield* store.lookup(TOPOLOGY_NS, TOPOLOGY_KEY);
    const seq = existing ?? (yield* store.nextSeq);
    yield* store.transact((txn) =>
      txn.put(
        seq,
        enc.encode(JSON.stringify(map)),
        { terms: [], columns: [], measures: [], edges: [] },
        { namespace: TOPOLOGY_NS, key: TOPOLOGY_KEY },
      ),
    );
  }).pipe(Effect.orDie);

/**
 * Which collections are placed other than by the partition map.
 *
 * Only deviations are recorded. A collection absent from the catalog is
 * `partitioned`, which is both the default and the overwhelming majority, so
 * the catalog stays the size of the exceptions rather than growing with every
 * collection an App creates.
 */
export interface PlacementCatalog {
  readonly version: number;
  readonly collections: Readonly<Record<string, PlacementClass>>;
}

/**
 * What the database places without an App asking.
 *
 * Placement is declared rather than inferred, so the only entries that appear
 * undeclared are the internals the database itself owns. `zv.topology` holds
 * the partition map, and which shard would hold it is exactly the question it
 * answers; naming it here is what makes that a class rather than a special case
 * buried in `makeDatabase`.
 */
export const SYSTEM_PLACEMENTS: Readonly<Record<string, PlacementClass>> = Object.freeze({
  [TOPOLOGY_SHARD]: "global",
  [GLOBAL_SHARD]: "global",
});

/**
 * A catalog must be whole, and must still place the internals.
 *
 * The system entries are checked on the way in rather than trusted: a catalog
 * that had dropped or reclassified `zv.topology` would be one where the map
 * itself had been given somewhere else to live, which is not a state to route
 * on and discover later.
 */
export const validatePlacementCatalog = (
  catalog: PlacementCatalog,
): PlacementCatalogInvalid | undefined => {
  if (!Number.isFinite(catalog.version) || catalog.version <= 0) {
    return new PlacementCatalogInvalid({
      version: catalog.version,
      reason: "version must be positive",
    });
  }
  for (const [collection, placement] of Object.entries(catalog.collections)) {
    if (!PLACEMENT_CLASSES.includes(placement)) {
      return new PlacementCatalogInvalid({
        version: catalog.version,
        reason: `collection "${collection}" has unknown placement "${placement}"`,
      });
    }
  }
  for (const [collection, placement] of Object.entries(SYSTEM_PLACEMENTS)) {
    const stored = catalog.collections[collection];
    if (stored !== placement) {
      return new PlacementCatalogInvalid({
        version: catalog.version,
        reason:
          stored === undefined
            ? `system collection "${collection}" is unplaced`
            : `system collection "${collection}" is placed "${stored}" rather than "${placement}"`,
      });
    }
  }
  return undefined;
};

export const loadPlacementCatalog = (
  store: ObjectStoreApi,
): Effect.Effect<PlacementCatalog | undefined> =>
  Effect.gen(function* () {
    const seq = yield* store.lookup(TOPOLOGY_NS, PLACEMENT_KEY);
    if (seq === undefined) return undefined;
    const object = yield* store.read(seq);
    return object === undefined
      ? undefined
      : (JSON.parse(dec.decode(object.bytes)) as PlacementCatalog);
  }).pipe(Effect.orDie);

const writePlacementCatalog = (store: ObjectStoreApi, catalog: PlacementCatalog) =>
  Effect.gen(function* () {
    const existing = yield* store.lookup(TOPOLOGY_NS, PLACEMENT_KEY);
    const seq = existing ?? (yield* store.nextSeq);
    yield* store.transact((txn) =>
      txn.put(
        seq,
        enc.encode(JSON.stringify(catalog)),
        { terms: [], columns: [], measures: [], edges: [] },
        { namespace: TOPOLOGY_NS, key: PLACEMENT_KEY },
      ),
    );
  }).pipe(Effect.orDie);

/** Load the stored catalog, or seed it with the system placements on first open. */
export const initPlacementCatalog = Effect.fn("initPlacementCatalog")(function* (
  store: ObjectStoreApi,
) {
  const stored = yield* loadPlacementCatalog(store);
  if (stored !== undefined) {
    const invalid = validatePlacementCatalog(stored);
    if (invalid !== undefined) return yield* invalid;
    return stored;
  }
  const seeded: PlacementCatalog = { version: 1, collections: { ...SYSTEM_PLACEMENTS } };
  yield* writePlacementCatalog(store, seeded);
  return seeded;
});

export interface PlacementApi {
  readonly current: () => PlacementCatalog;

  /**
   * How a collection is placed.
   *
   * Answers `partitioned` for anything the catalog does not mention, which is
   * the default rather than a guess about an unknown name.
   */
  readonly classOf: (collection: string) => PlacementClass;

  /**
   * Record a collection's class.
   *
   * Idempotent for a collection already declared the same way, and refused when
   * it is declared differently: a class change moves data, so it belongs to
   * relocation rather than to a catalog write.
   */
  readonly declare: (
    collection: string,
    placement: PlacementClass,
  ) => Effect.Effect<PlacementCatalog, PlacementCatalogInvalid | PlacementImmutable>;
}

export const placementFor = (
  topologyStore: ObjectStoreApi,
  initial: PlacementCatalog,
): PlacementApi => {
  let catalog = initial;

  return {
    current: () => catalog,
    classOf: (collection) => catalog.collections[collection] ?? "partitioned",
    declare: (collection, placement) =>
      Effect.gen(function* () {
        const current = catalog.collections[collection];
        if (current === placement) return catalog;
        if (current !== undefined) {
          return yield* new PlacementImmutable({ collection, current, requested: placement });
        }
        // Reserved names are the database's own, and the system seeds those
        // itself; an App reaching one here is naming something it does not own.
        if (isReservedCollectionName(collection) || !isValidCollectionName(collection)) {
          return yield* new PlacementCatalogInvalid({
            version: catalog.version,
            reason: `"${collection}" is not a name an App may place`,
          });
        }
        const next: PlacementCatalog = {
          version: catalog.version + 1,
          collections: { ...catalog.collections, [collection]: placement },
        };
        const invalid = validatePlacementCatalog(next);
        if (invalid !== undefined) return yield* invalid;
        yield* writePlacementCatalog(topologyStore, next);
        catalog = next;
        return next;
      }),
  } satisfies PlacementApi;
};

export interface RangeMove {
  readonly range: number;
  readonly from: ShardId;
  readonly to: ShardId;
  readonly tenants: ReadonlyArray<TenantId>;
}

export interface TopologyApi {
  readonly current: () => PartitionMap;

  /**
   * Which collections are placed other than by the map.
   *
   * On the topology because it answers the same question the map does — where
   * something lives — for the collections the map does not route.
   */
  readonly placement: PlacementApi;
  /** Which ranges a proposed map moves, and which tenants are standing on them. */
  readonly plan: (next: PartitionMap) => Effect.Effect<ReadonlyArray<RangeMove>>;
  /**
   * Store a new map.
   *
   * Refused when it would move a range tenants occupy. A map change is a
   * routing change and carries no data with it, so the records would stay where
   * they were while every read went to the new shard and found nothing.
   */
  readonly update: (
    next: PartitionMap,
  ) => Effect.Effect<PartitionMap, PartitionMapInvalid | RangeNotEmpty>;

  /**
   * Store a new map whose moved ranges have already been relocated.
   *
   * The occupancy check `update` makes is skipped here, and only relocation may
   * call this: at the moment routing moves, the source still holds the records
   * — that is the point of the ordering, since the copy has to be complete and
   * verifiable before anything reads from the target. The check would see those
   * records and refuse the very change the copy was made for.
   *
   * Everything else `update` checks still applies: the map has to be whole and
   * its version has to advance.
   */
  readonly applyAfterMove: (
    next: PartitionMap,
  ) => Effect.Effect<PartitionMap, PartitionMapInvalid>;
}

export const topologyFor = (
  topologyStore: ObjectStoreApi,
  initial: PartitionMap,
  shards: ReadonlyMap<ShardId, ObjectStoreApi>,
  catalog: PlacementCatalog,
): TopologyApi => {
  let map = initial;
  const placement = placementFor(topologyStore, catalog);

  const plan = (next: PartitionMap) =>
    Effect.gen(function* () {
      const byRange = new Map<number, TenantId[]>();
      for (const shard of shardsOf(map)) {
        const store = shards.get(shard);
        if (store === undefined) continue;
        for (const tenant of yield* tenantsOn(store)) {
          if (shardFor(map, tenant) !== shard) continue;
          const range = virtualRangeFor(map, tenant);
          byRange.set(range, [...(byRange.get(range) ?? []), tenant]);
        }
      }
      const moves: RangeMove[] = [];
      for (let range = 0; range < map.virtualRanges; range++) {
        const from = map.placements.find((p) => range >= p.from && range < p.to)?.shard;
        const to = next.placements.find((p) => range >= p.from && range < p.to)?.shard;
        if (from === undefined || to === undefined || from === to) continue;
        moves.push({ range, from, to, tenants: byRange.get(range) ?? [] });
      }
      return moves;
    });

  const store = (next: PartitionMap) =>
    Effect.gen(function* () {
      const invalid = validatePartitionMap(next);
      if (invalid !== undefined) return yield* invalid;
      if (next.version <= map.version) {
        return yield* new PartitionMapInvalid({
          version: next.version,
          reason: `version must advance past ${map.version}`,
        });
      }
      yield* writePartitionMap(topologyStore, next);
      map = next;
      return next;
    });

  return {
    current: () => map,
    placement,
    plan,
    applyAfterMove: store,
    update: (next) =>
      Effect.gen(function* () {
        const occupied = (yield* plan(next)).filter((move) => move.tenants.length > 0);
        if (occupied.length > 0) {
          const first = occupied[0]!;
          return yield* new RangeNotEmpty({
            range: first.range,
            from: first.from,
            to: first.to,
            tenants: occupied.flatMap((move) => move.tenants),
          });
        }
        return yield* store(next);
      }),
  } satisfies TopologyApi;
};

/** Load the stored map, or store the given one the first time an App opens. */
export const initPartitionMap = Effect.fn("initPartitionMap")(function* (
  store: ObjectStoreApi,
  fallback: PartitionMap,
) {
  const stored = yield* loadPartitionMap(store);
  if (stored !== undefined) return stored;
  const invalid = validatePartitionMap(fallback);
  if (invalid !== undefined) return yield* invalid;
  yield* writePartitionMap(store, fallback);
  return fallback;
});
