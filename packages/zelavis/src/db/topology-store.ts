import { Effect, Stream } from "effect";
import { PartitionMapInvalid, RangeNotEmpty } from "./errors.js";
import { equals } from "./query.js";
import type { ObjectStoreApi } from "./store.js";
import { TENANT_COLUMN, TENANT_MARKER } from "./tenancy.js";
import {
  shardFor,
  shardsOf,
  virtualRangeFor,
  type PartitionMap,
  type ShardId,
  type TenantId,
} from "./topology.js";

const TOPOLOGY_NS = "zv.topology";
const TOPOLOGY_KEY = "partition-map";

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

export interface RangeMove {
  readonly range: number;
  readonly from: ShardId;
  readonly to: ShardId;
  readonly tenants: ReadonlyArray<TenantId>;
}

export interface TopologyApi {
  readonly current: () => PartitionMap;
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
): TopologyApi => {
  let map = initial;

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
