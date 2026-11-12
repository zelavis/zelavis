import { Clock, Deferred, Duration, Effect, Exit, Scope, SubscriptionRef } from "effect";
import { StoreError } from "./errors.js";
import { followPartitions, type DatabaseLeader, type FollowerSide } from "./leader.js";
import type { ShardReplicaDescription, ShardReplicaLocation } from "./shard-placement.js";
import type { ShardStoreApi } from "./store.js";
import { isReservedTenantId } from "./naming.js";
import type { ShardId } from "./topology.js";

const RETRY_INTERVAL = Duration.seconds(5);
const FOLLOW_TIMEOUT_MILLIS = 5000;
const BEHIND_MILLIS = 60_000;

export const replicaSide = (store: ShardStoreApi): Effect.Effect<FollowerSide> => Effect.gen(function* () {
  const writes = yield* SubscriptionRef.make(0);
  return {
    routed: store.partition,
    shardFor: () => store,
    partitionsPage: (after, limit) => Effect.map(store.partitionsPage(after, limit), (raw) => ({
      partitions: raw.filter((partition) => !isReservedTenantId(partition)),
      ...(raw.length === limit ? { next: raw.at(-1) } : {}),
    })),
    changed: () => Effect.void,
    remove: (partition) => Effect.asVoid(store.drop(partition)),
    writes,
    declare: () => Effect.void,
  };
});

interface Replica {
  readonly shard: ShardId;
  readonly scope: Scope.Closeable;
  readonly firstOpen: Deferred.Deferred<void, StoreError>;
  opened: boolean;
  heldAsOf?: number;
}

export const shardReplicasOver = (input: {
  readonly scope: Scope.Scope;
  readonly openReplica?: (shard: ShardId) => Effect.Effect<ShardStoreApi, StoreError, Scope.Scope>;
  readonly leaderFor: (of: ShardId) => DatabaseLeader;
}) => {
  // Replica stores have their own lifetimes and never join the database's routed shard map.
  const replicas = new Map<ShardId, Replica>();

  const register = (of: ShardId, shard: ShardId) => Effect.gen(function* () {
    const existing = replicas.get(of);
    if (existing !== undefined) return existing;
    const scope = yield* Scope.fork(input.scope);
    const firstOpen = yield* Deferred.make<void, StoreError>();
    const replica: Replica = { shard, scope, firstOpen, opened: false };
    replicas.set(of, replica);
    const opening = input.openReplica?.(shard) ??
      Effect.fail(new StoreError({ op: "shard.replica", cause: `No opener for replica ${shard}` }));
    const follow = Effect.scoped(Effect.gen(function* () {
      const store = yield* opening.pipe(Effect.tapError((error) => Deferred.fail(firstOpen, error)));
      const side = yield* replicaSide(store);
      replica.opened = true;
      delete replica.heldAsOf;
      yield* Deferred.succeed(firstOpen, undefined);
      return yield* followPartitions(input.leaderFor(of), side, {
        name: `replica:${shard}`,
        concurrency: 8,
        timeoutMillis: FOLLOW_TIMEOUT_MILLIS,
        turns: ({ asked, level }) => Effect.sync(() => {
          // An initial resync can still leave work in the retry set.
          if (level) replica.heldAsOf = asked;
        }),
      });
    })).pipe(Effect.catchCause((cause) => {
      replica.opened = false;
      return Effect.andThen(
        Deferred.fail(firstOpen, new StoreError({ op: "shard.replica", cause: `Replica ${shard} could not open` })),
        Effect.logWarning(`Replica ${shard} is unavailable; retrying`, cause),
      );
    }));
    yield* Effect.forkIn(Effect.forever(follow.pipe(Effect.andThen(Effect.sleep(RETRY_INTERVAL)))).pipe(Effect.interruptible), scope);
    return replica;
  }).pipe(Effect.uninterruptible);

  return {
    open: (of: ShardId, shard: ShardId) => Effect.gen(function* () {
      const replica = yield* register(of, shard);
      if (!replica.opened) yield* Deferred.await(replica.firstOpen);
    }),
    close: (of: ShardId) => Effect.gen(function* () {
      const replica = replicas.get(of);
      if (replica === undefined) return;
      yield* Scope.close(replica.scope, Exit.void);
      replicas.delete(of);
    }).pipe(Effect.uninterruptible),
    list: Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const out = new Map<ShardId, ShardReplicaDescription>();
      for (const [of, { shard, opened, heldAsOf }] of replicas) {
        const lagMillis = heldAsOf === undefined ? undefined : Math.max(0, now - heldAsOf);
        out.set(of, {
          shardId: shard,
          status: !opened ? "unavailable" : lagMillis === undefined ? "seeding" : lagMillis > BEHIND_MILLIS ? "behind" : "following",
          ...(heldAsOf === undefined ? {} : { heldAsOf: new Date(heldAsOf).toISOString(), lagMillis }),
        });
      }
      return out;
    }),
    has: (of: ShardId) => replicas.has(of),
    resume: (listed: ReadonlyArray<ShardReplicaLocation>) =>
      Effect.forEach(listed, ({ of, shard }) => register(of, shard), { discard: true }),
  };
};

export type ShardReplicas = ReturnType<typeof shardReplicasOver>;
