import { Context, Deferred, Duration, Effect, Option, Stream } from "effect";
import { PartitionUnavailable, PlacementInUse } from "./errors.js";
import type { PartitionKey } from "./model.js";
import { RoutedBy, type ObjectStoreApi, type ShardStoreApi } from "./store.js";
import type { ShardId } from "./topology.js";

/**
 * Where each operation on a partition goes, and when a placement it has left
 * stops being used.
 *
 * A tenant's handle is not bound to a shard. Each operation it runs asks the
 * topology where the tenant lives as the operation starts, and every store
 * call inside it — nested operations included — goes to that one placement, so
 * a handle taken before a move works after it and an operation never sees half
 * of one placement and half of another. That matters beyond reads: an
 * operation may take an identifier in one call and write it in the next, and
 * an identifier taken on a shard the tenant then leaves was never copied.
 *
 * For as long as the operation runs — a stream until it ends — it holds a
 * lease on that placement, which is what lets a move know when the shard it
 * routed a tenant off is no longer used: once every lease taken there before
 * routing moved is released, nothing can arrive there again, and the
 * partition can go, fence and all.
 *
 * Leases are in-process because the writer is: a shard admits one writer
 * process, so only calls in this process can reach its partitions. A restart
 * holds none.
 *
 * Every call carries the map version it was routed by (`RoutedBy`), read in
 * the same step as the shard, so a shard a move has since cleared refuses a
 * router whose map predates the move (`TenantRelocated`) rather than answering
 * from an empty partition.
 */
export interface PartitionRouter {
  /**
   * A store whose every call goes to where `by` is routed when the call
   * starts, reaching the partition `partition` there. `by` defaults to the
   * partition itself; the replicated collections on a tenant's shard are
   * reached by the tenant's routing.
   */
  readonly routed: (partition: PartitionKey, by?: PartitionKey) => ObjectStoreApi;

  /**
   * `api` with every operation it offers — each effect, stream, and function
   * returning one, through nested objects and the objects its functions hand
   * back — run against the one placement `by` is routed to when the operation
   * starts, under one lease. An operation run inside another for the same
   * routing joins it rather than routing again.
   */
  readonly operations: <T>(api: T, by: PartitionKey) => T;

  /**
   * Run `use` on the partition at `shard` under a lease, provided routing
   * places it there now; `Option.none` when it does not. For upkeep that walks
   * every partition a shard holds, which must leave alone one a move has
   * routed away and is about to clear.
   */
  readonly placed: <A, E, R>(
    shard: ShardId,
    partition: PartitionKey,
    use: (store: ObjectStoreApi) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;

  /**
   * Wait until no call holds a lease on the partition at `shard`, for at most
   * `timeout`; then `PlacementInUse` with how many still do.
   *
   * Only meaningful once routing no longer places the partition there, so no
   * new lease can be taken while this waits.
   */
  readonly drained: (
    shard: ShardId,
    partition: PartitionKey,
    timeout: Duration.Input,
  ) => Effect.Effect<void, PlacementInUse>;
}

interface Lease {
  readonly shard: ShardId;
  readonly partition: PartitionKey;
  readonly store: ObjectStoreApi;
  /** The map version that placed the partition on `shard`. */
  readonly version: number;
}

/** Where routing places a partition, and the version of the map that says so. */
export interface Route {
  readonly shard: ShardId;
  readonly version: number;
}

interface Held {
  count: number;
  readonly idle: Array<Deferred.Deferred<void>>;
}

/**
 * The placements the running operation is pinned to, per router and routing
 * key. Keyed by router as well, so two databases in one process with a tenant
 * of the same name never share a pin.
 */
const PlacementPins = Context.Reference<ReadonlyMap<object, ReadonlyMap<PartitionKey, Lease>>>(
  "zelavis/db/PlacementPins",
  { defaultValue: () => new Map() },
);

/** A plain object literal: walked by `operations`, unlike values with a class or a role of their own. */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;

export const partitionRouter = (options: {
  /** Read once per call, so the shard and the version always come from one map. */
  readonly route: (partition: PartitionKey) => Route;
  readonly shards: ReadonlyMap<ShardId, ShardStoreApi>;
}): PartitionRouter => {
  const { route, shards } = options;
  // Nested rather than keyed by a joined string: a partition name may hold any
  // character, so no separator is safe.
  const held = new Map<ShardId, Map<PartitionKey, Held>>();
  /** This router's own key into `PlacementPins`. */
  const token = {};

  const take = (shard: ShardId, partition: PartitionKey, store: ObjectStoreApi, version: number): Lease => {
    let onShard = held.get(shard);
    if (onShard === undefined) {
      onShard = new Map();
      held.set(shard, onShard);
    }
    const entry = onShard.get(partition);
    if (entry === undefined) onShard.set(partition, { count: 1, idle: [] });
    else entry.count += 1;
    return { shard, partition, store, version };
  };

  const release = (lease: Lease) =>
    Effect.sync(() => {
      const onShard = held.get(lease.shard);
      const entry = onShard?.get(lease.partition);
      if (onShard === undefined || entry === undefined) return;
      entry.count -= 1;
      if (entry.count > 0) return;
      onShard.delete(lease.partition);
      if (onShard.size === 0) held.delete(lease.shard);
      for (const waiter of entry.idle) Deferred.doneUnsafe(waiter, Effect.void);
    });

  /**
   * Resolve and lease in one synchronous step, so no routing change can fall
   * between reading where the partition lives and being counted there: a call
   * either holds its lease before routing moves, and is waited for, or reads
   * the new routing.
   */
  const acquire = (partition: PartitionKey, by: PartitionKey) =>
    Effect.flatMap(
      Effect.sync(() => {
        const { shard, version } = route(by);
        const holder = shards.get(shard);
        return holder === undefined ? { shard } : take(shard, partition, holder.partition(partition), version);
      }),
      (lease) =>
        "store" in lease
          ? Effect.succeed(lease)
          // Every shard the map names is opened up front, so this is a corrupt
          // map rather than a request anybody can correct.
          : Effect.die(new PartitionUnavailable({
              partition,
              reason: `routing places it on shard "${lease.shard}", which is not open`,
            })),
    );

  /** The placement the running operation is pinned to for `by`, if any. */
  const pinOf = (by: PartitionKey) =>
    Effect.map(Effect.service(PlacementPins), (pins) => pins.get(token)?.get(by));

  const withPin = (pins: ReadonlyMap<object, ReadonlyMap<PartitionKey, Lease>>, by: PartitionKey, lease: Lease) =>
    new Map(pins).set(token, new Map(pins.get(token) ?? []).set(by, lease));

  /** The partition on the shard a pin names: open, since routing resolved to it. */
  const atPin = (pin: Lease, partition: PartitionKey) =>
    partition === pin.partition ? pin.store : shards.get(pin.shard)!.partition(partition);

  /** Run a call on a leased placement, carrying the map version that routed it there. */
  const onLease = <A, E, R>(lease: Lease, partition: PartitionKey, use: (store: ObjectStoreApi) => Effect.Effect<A, E, R>) =>
    Effect.provideService(use(atPin(lease, partition)), RoutedBy, lease.version);
  const flowingOnLease = <A, E, R>(lease: Lease, partition: PartitionKey, use: (store: ObjectStoreApi) => Stream.Stream<A, E, R>) =>
    Stream.provideService(use(atPin(lease, partition)), RoutedBy, lease.version);

  /** Run an operation pinned to where `by` is routed now, or to the pin it already runs under. */
  const pinned = <A, E, R>(by: PartitionKey, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(Effect.service(PlacementPins), (pins) =>
      pins.get(token)?.has(by) === true
        ? effect
        : Effect.acquireUseRelease(
            acquire(by, by),
            (lease) => Effect.provideService(effect, PlacementPins, withPin(pins, by, lease)),
            release,
          ));

  const pinnedStream = <A, E, R>(by: PartitionKey, stream: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
    Stream.unwrap(Effect.flatMap(Effect.service(PlacementPins), (pins) =>
      pins.get(token)?.has(by) === true
        ? Effect.succeed(stream)
        : Effect.map(Effect.acquireRelease(acquire(by, by), release), (lease) =>
            Stream.provideService(stream, PlacementPins, withPin(pins, by, lease)))));

  const operations = <T>(api: T, by: PartitionKey): T => {
    const wrap = (value: unknown): unknown => {
      if (Stream.isStream(value)) return pinnedStream(by, value);
      if (Effect.isEffect(value)) return pinned(by, value);
      if (typeof value === "function") {
        return (...args: ReadonlyArray<unknown>) => wrap((value as (...input: ReadonlyArray<unknown>) => unknown)(...args));
      }
      if (isPlainObject(value)) {
        return Object.fromEntries(Object.entries(value).map(([name, member]) => [name, wrap(member)]));
      }
      return value;
    };
    return wrap(api) as T;
  };

  const routed = (partition: PartitionKey, by: PartitionKey = partition): ObjectStoreApi => {
    // Inside a pinned operation every call goes to its placement, under its
    // lease; outside one, each call routes and leases on its own.
    const on = <A, E, R>(use: (store: ObjectStoreApi) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.flatMap(pinOf(by), (pin) =>
        pin !== undefined
          ? onLease(pin, partition, use)
          : Effect.acquireUseRelease(acquire(partition, by), (lease) => onLease(lease, partition, use), release));
    const flowing = <A, E, R>(use: (store: ObjectStoreApi) => Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
      Stream.unwrap(Effect.flatMap(pinOf(by), (pin) =>
        pin !== undefined
          ? Effect.succeed(flowingOnLease(pin, partition, use))
          : Effect.map(Effect.acquireRelease(acquire(partition, by), release), (lease) => flowingOnLease(lease, partition, use))));

    return {
      partition,
      // Stamped on events a caller applies; the store it lands in records its
      // own writer when it commits them.
      get generation() {
        const holder = shards.get(route(by).shard);
        return holder === undefined ? 0 : holder.generation;
      },
      stats: on((store) => store.stats),
      records: flowing((store) => store.records),
      scanRecords: (input) => on((store) => store.scanRecords(input)),
      seed: (source, seedOptions) => on((store) => store.seed(source, seedOptions)),
      reading: (effect) => on((store) => store.reading(effect)),
      events: {
        read: (readOptions) => flowing((store) => store.events.read(readOptions)),
        head: on((store) => store.events.head),
        apply: (event) => on((store) => store.events.apply(event)),
        follow: (event) => on((store) => store.events.follow(event)),
        followAll: (batch) => on((store) => store.events.followAll(batch)),
      },
      rebuildLenses: on((store) => store.rebuildLenses),
      resumeMaintenance: on((store) => store.resumeMaintenance),
      reindexLenses: on((store) => store.reindexLenses),
      sealPostings: on((store) => store.sealPostings),
      compact: (compactOptions) => on((store) => store.compact(compactOptions)),
      compactedTo: on((store) => store.compactedTo),
      holdLog: (input) => on((store) => store.holdLog(input)),
      releaseLog: (id) => on((store) => store.releaseLog(id)),
      snapshot: on((store) => store.snapshot),
      snapshotAt: on((store) => store.snapshotAt),
      liveRecords: on((store) => store.liveRecords),
      nextSeq: on((store) => store.nextSeq),
      reserve: (upTo) => on((store) => store.reserve(upTo)),
      transact: (f) => on((store) => store.transact(f)),
      fence: (move) => on((store) => store.fence(move)),
      writable: on((store) => store.writable),
      read: (seq) => on((store) => store.read(seq)),
      manifestOf: (seq) => on((store) => store.manifestOf(seq)),
      lookup: (namespace, key) => on((store) => store.lookup(namespace, key)),
      identityOf: (seq) => on((store) => store.identityOf(seq)),
      scanIdentities: (input) => on((store) => store.scanIdentities(input)),
      resolve: (query, resolveOptions) => flowing((store) => store.resolve(query, resolveOptions)),
      ordered: (input) => on((store) => store.ordered(input)),
      extent: (column, where) => on((store) => store.extent(column, where)),
      measure: (column) => on((store) => store.measure(column)),
      terms: (field, prefix) => on((store) => store.terms(field, prefix)),
    };
  };

  const placed: PartitionRouter["placed"] = (shard, partition, use) =>
    Effect.flatMap(
      Effect.sync(() => {
        const holder = shards.get(shard);
        const placedBy = route(partition);
        return holder === undefined || placedBy.shard !== shard
          ? undefined
          : take(shard, partition, holder.partition(partition), placedBy.version);
      }),
      (lease) =>
        lease === undefined
          ? Effect.succeed(Option.none())
          : Effect.acquireUseRelease(
              Effect.succeed(lease),
              (taken) => Effect.map(onLease(taken, partition, use), Option.some),
              release,
            ),
    );

  const drained: PartitionRouter["drained"] = (shard, partition, timeout) =>
    Effect.suspend(() => {
      const entry = held.get(shard)?.get(partition);
      if (entry === undefined) return Effect.void;
      const idle = Deferred.makeUnsafe<void>();
      entry.idle.push(idle);
      return Deferred.await(idle).pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            Effect.suspend(() => {
              const at = entry.idle.indexOf(idle);
              if (at !== -1) entry.idle.splice(at, 1);
              return Effect.fail(new PlacementInUse({ partition, shard, calls: entry.count }));
            }),
        }),
      );
    });

  return { routed, operations, placed, drained };
};
