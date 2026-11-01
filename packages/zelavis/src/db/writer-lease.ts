import { Clock, Duration, Effect, Fiber, type Scope } from "effect";
import { isNonNegativeInteger, isString, objectFields, optional } from "../core/json-validation.js";
import { FollowerBehind, LeaseOwnedByAnother, LeaseStillHeld, NoWriterLease, StoreError, WriterFenced, type DbError } from "./errors.js";
import type { PartitionKey } from "./model.js";
import type { ObjectStoreApi } from "./store.js";

/**
 * Writer leases: who may write a partition, and how a follower takes over from a writer that is gone.
 *
 * A lease is one record per partition, `{ owner, epoch, expiresAt, acknowledgedHead }`, kept in an authority both
 * hosts can reach (the Platform's System Store in a real deployment) and changed only by compare-and-set, so of any
 * two changes made from the same observation exactly one lands.
 *
 * - The **writer** holds the lease and renews it well inside its time to live. Its renewals also carry the highest
 *   log position its followers have acknowledged (`acknowledgedHead`): the position every write promised to its
 *   caller under an acknowledgment policy is at or below.
 * - Every change to the partition passes the writer's **gate** first, under the partition's writer. The gate refuses
 *   once the lease is known to be superseded, and once the writer can no longer prove it still holds the lease
 *   (its last renewal is too old, less a margin for clock skew). A writer that was paused and wakes up after its
 *   lease expired is therefore refused at its first write, before any promotion has to reach it.
 * - A **follower** is promoted only when the lease has expired and the follower's own head has reached
 *   `acknowledgedHead`: it then holds every write that was promised. Promotion is one compare-and-set that raises the
 *   epoch, so two followers racing for it get one winner. Writes the old writer made past what its followers had
 *   acknowledged are the price of asynchronous replication; the promotion reports how many positions that may be.
 *
 * What this is not: it does not move data (`follow` does), it does not decide who should be promoted (the caller,
 * normally the Platform Fabric, does), and a lease is not a lock on a record: a gate check and a commit are two
 * steps, so the margin must exceed any pause between them.
 */

/** The lease record of one partition. */
export interface WriterLease {
  readonly partition: PartitionKey;
  readonly owner: string;
  /** Raised by every change of writer, and by an owner starting again; never reused. */
  readonly epoch: number;
  /** Epoch milliseconds; 0 once released. */
  readonly expiresAt: number;
  /** The highest log position known acknowledged by followers when the lease was last renewed. */
  readonly acknowledgedHead: number;
  /**
   * Where followers read this writer (its leader transport), so they find the new writer from the lease alone after a
   * promotion; opaque to the protocol.
   */
  readonly endpoint?: string;
  /** Set by a promotion that accepted data loss: the acknowledged positions the new writer's copy was missing. */
  readonly lostPositions?: number;
}

/** Whether a value is a lease record: what a store or a wire answer is checked against before it is trusted. */
export const isWriterLease = objectFields<WriterLease>({
  partition: isString, owner: isString, epoch: isNonNegativeInteger, expiresAt: isNonNegativeInteger, acknowledgedHead: isNonNegativeInteger,
  endpoint: optional((value): value is string => isString(value) && value.length <= 2048),
  lostPositions: optional(isNonNegativeInteger),
});

/** A lease as read, with what a compare-and-set needs to replace exactly it. */
export interface LeaseRead {
  readonly lease: WriterLease;
  readonly version: unknown;
}

/**
 * Where leases are kept. `create` and `replace` are conditional: they answer `false` rather than overwrite, so a
 * store that cannot enforce a condition must not implement them (see `probeFileStorageGuarantees` for object stores).
 */
export interface LeaseStore {
  readonly read: (partition: PartitionKey) => Effect.Effect<LeaseRead | undefined, StoreError>;
  readonly create: (lease: WriterLease) => Effect.Effect<boolean, StoreError>;
  readonly replace: (observed: LeaseRead, lease: WriterLease) => Effect.Effect<boolean, StoreError>;
}

/** A lease store in this process, for tests and for one-process deployments. */
export const memoryLeaseStore = (): LeaseStore => {
  const held = new Map<PartitionKey, { lease: WriterLease; version: number }>();
  let counter = 0;
  return {
    read: (partition) => Effect.sync(() => {
      const entry = held.get(partition);
      return entry === undefined ? undefined : { lease: entry.lease, version: entry.version };
    }),
    create: (lease) => Effect.sync(() => {
      if (held.has(lease.partition)) return false;
      held.set(lease.partition, { lease, version: ++counter });
      return true;
    }),
    replace: (observed, lease) => Effect.sync(() => {
      const entry = held.get(lease.partition);
      if (entry === undefined || entry.version !== observed.version) return false;
      held.set(lease.partition, { lease, version: ++counter });
      return true;
    }),
  };
};

/** The failures of the lease protocol that are not the store's. */
export type LeaseFailure = LeaseStillHeld | FollowerBehind | LeaseOwnedByAnother | NoWriterLease | WriterFenced;

const TTL_MIN_MILLIS = 100;
const TTL_MAX_MILLIS = 10 * 60_000;

const checkedTtl = (ttlMillis: number) =>
  Number.isSafeInteger(ttlMillis) && ttlMillis >= TTL_MIN_MILLIS && ttlMillis <= TTL_MAX_MILLIS
    ? Effect.succeed(ttlMillis)
    : Effect.die(new RangeError(`a lease lives ${TTL_MIN_MILLIS} to ${TTL_MAX_MILLIS} milliseconds`));

/** The share of a lease's life a writer keeps in hand against clock skew and the pause between a gate check and a commit. */
export const leaseMargin = (ttlMillis: number) => Math.max(1, Math.floor(ttlMillis / 5));

const taken = (read: LeaseRead) =>
  new LeaseStillHeld({ partition: read.lease.partition, owner: read.lease.owner, epoch: read.lease.epoch, expiresAt: read.lease.expiresAt });

/**
 * Start (or start again) as the writer of a partition: the first lease it has, or the same owner's next epoch.
 * Another owner's lease is never taken here — it changes hands only by `promoteFollower`.
 */
export const acquireWriter = (leases: LeaseStore, input: {
  readonly partition: PartitionKey;
  readonly owner: string;
  readonly ttlMillis: number;
  readonly head?: number;
  readonly endpoint?: string;
}): Effect.Effect<WriterLease, StoreError | LeaseOwnedByAnother | LeaseStillHeld> =>
  Effect.gen(function* () {
    const ttl = yield* checkedTtl(input.ttlMillis);
    const now = yield* Clock.currentTimeMillis;
    const observed = yield* leases.read(input.partition);
    if (observed === undefined) {
      const lease: WriterLease = { partition: input.partition, owner: input.owner, epoch: 1, expiresAt: now + ttl, acknowledgedHead: input.head ?? 0, ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }) };
      if (yield* leases.create(lease)) return lease;
      const raced = yield* leases.read(input.partition);
      return yield* (raced === undefined ? Effect.die(new Error("a lease vanished while being created")) : Effect.fail(taken(raced)));
    }
    if (observed.lease.owner !== input.owner) {
      return yield* new LeaseOwnedByAnother({ partition: input.partition, owner: observed.lease.owner, epoch: observed.lease.epoch });
    }
    const lease: WriterLease = {
      ...observed.lease, epoch: observed.lease.epoch + 1, expiresAt: now + ttl,
      acknowledgedHead: Math.max(observed.lease.acknowledgedHead, input.head ?? 0),
      ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
    };
    if (yield* leases.replace(observed, lease)) return lease;
    const raced = yield* leases.read(input.partition);
    return yield* (raced === undefined ? Effect.die(new Error("a lease vanished while being replaced")) : Effect.fail(taken(raced)));
  });

/** Extend the lease the writer holds, raising its acknowledged head; fenced when it is no longer the one held. */
export const renewWriter = (leases: LeaseStore, held: WriterLease, input: {
  readonly ttlMillis: number;
  readonly acknowledgedHead?: number;
}): Effect.Effect<WriterLease, StoreError | WriterFenced> =>
  Effect.gen(function* () {
    const ttl = yield* checkedTtl(input.ttlMillis);
    const now = yield* Clock.currentTimeMillis;
    const observed = yield* leases.read(held.partition);
    const fenced = (current: number) => new WriterFenced({ partition: held.partition, claimed: held.epoch, current, reason: "superseded" });
    if (observed === undefined) return yield* fenced(0);
    if (observed.lease.owner !== held.owner || observed.lease.epoch !== held.epoch) return yield* fenced(observed.lease.epoch);
    const lease: WriterLease = { ...held, expiresAt: now + ttl, acknowledgedHead: Math.max(observed.lease.acknowledgedHead, input.acknowledgedHead ?? 0) };
    if (yield* leases.replace(observed, lease)) return lease;
    const raced = yield* leases.read(held.partition);
    return yield* fenced(raced?.lease.epoch ?? 0);
  });

/**
 * Give the lease up on purpose, so a follower can be promoted at once instead of after the time to live. Only the
 * lease actually held is released; a lease another epoch holds is left as it is.
 */
export const releaseWriter = (leases: LeaseStore, held: WriterLease): Effect.Effect<boolean, StoreError> =>
  Effect.gen(function* () {
    const observed = yield* leases.read(held.partition);
    if (observed === undefined || observed.lease.owner !== held.owner || observed.lease.epoch !== held.epoch) return false;
    return yield* leases.replace(observed, { ...observed.lease, expiresAt: 0 });
  });

/** What a promotion came to: the new lease and the positions the old writer may have committed past its followers. */
export interface Promotion {
  readonly lease: WriterLease;
  /** How far the follower is behind the highest acknowledged position; 0 unless `allowDataLoss` was given. */
  readonly lostPositions: number;
}

/**
 * Take over a partition's lease for the follower that holds it, `followerHead` being the follower's own log head.
 * Refused while the lease is unexpired (`LeaseStillHeld`), and while the follower is behind the highest position
 * acknowledged to the writer's callers (`FollowerBehind`) unless the operator accepts that loss. One
 * compare-and-set raises the epoch, so two followers promoting at once get one winner and one `LeaseStillHeld`.
 */
export const promoteFollower = (leases: LeaseStore, input: {
  readonly partition: PartitionKey;
  readonly owner: string;
  readonly ttlMillis: number;
  readonly followerHead: number;
  readonly allowDataLoss?: boolean;
  /** Where followers read the new writer. */
  readonly endpoint?: string;
}): Effect.Effect<Promotion, StoreError | LeaseStillHeld | FollowerBehind | NoWriterLease> =>
  Effect.gen(function* () {
    const ttl = yield* checkedTtl(input.ttlMillis);
    const now = yield* Clock.currentTimeMillis;
    const observed = yield* leases.read(input.partition);
    if (observed === undefined) return yield* new NoWriterLease({ partition: input.partition });
    if (observed.lease.expiresAt > now) return yield* taken(observed);
    const required = observed.lease.acknowledgedHead;
    if (input.followerHead < required && input.allowDataLoss !== true) {
      return yield* new FollowerBehind({ partition: input.partition, head: input.followerHead, required });
    }
    const lease: WriterLease = {
      partition: input.partition, owner: input.owner, epoch: observed.lease.epoch + 1, expiresAt: now + ttl,
      acknowledgedHead: input.followerHead,
      ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
      ...(required > input.followerHead ? { lostPositions: required - input.followerHead } : {}),
    };
    if (yield* leases.replace(observed, lease)) return { lease, lostPositions: Math.max(0, required - input.followerHead) };
    const raced = yield* leases.read(input.partition);
    return yield* (raced === undefined ? Effect.fail(new NoWriterLease({ partition: input.partition })) : Effect.fail(taken(raced)));
  });

/** A writer that holds a lease and guards its partition with it. */
export interface WriterHandle {
  /** The lease as last renewed. */
  readonly lease: Effect.Effect<WriterLease>;
  /** Whether this writer is still entitled to write: false once superseded or when its lease cannot be proved. */
  readonly writable: Effect.Effect<boolean>;
}

export interface HoldWriterInput {
  readonly leases: LeaseStore;
  /** The partition's store, routed: its gate is what refuses a stale writer's changes. */
  readonly store: Pick<ObjectStoreApi, "guard" | "partition">;
  readonly owner: string;
  readonly ttlMillis: number;
  /** A lease already won, by `promoteFollower`; otherwise the owner's lease is acquired. */
  readonly lease?: WriterLease;
  /** Where followers read this writer, carried by the lease it acquires. */
  readonly endpoint?: string;
  /** The highest log position acknowledged by followers now: carried in every renewal. */
  readonly acknowledged?: Effect.Effect<number>;
}

/**
 * Be the writer of a partition until the scope closes: hold the lease, renew it every third of its life, and gate
 * every change to the partition on it. Closing the scope removes the gate and releases the lease, so a graceful
 * stop hands over at once and a crash hands over when the lease expires.
 */
export const holdWriter = (input: HoldWriterInput): Effect.Effect<WriterHandle, StoreError | LeaseOwnedByAnother | LeaseStillHeld, Scope.Scope> =>
  Effect.gen(function* () {
    const ttl = yield* checkedTtl(input.ttlMillis);
    const margin = leaseMargin(ttl);
    const partition = input.store.partition;
    let held = input.lease ?? (yield* acquireWriter(input.leases, { partition, owner: input.owner, ttlMillis: ttl, ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }) }));
    let superseded = false;

    const gate: Effect.Effect<void, DbError> = Effect.gen(function* () {
      if (superseded) return yield* new WriterFenced({ partition, claimed: held.epoch, current: held.epoch + 1, reason: "superseded" });
      const now = yield* Clock.currentTimeMillis;
      if (now >= held.expiresAt - margin) {
        return yield* new WriterFenced({ partition, claimed: held.epoch, current: held.epoch, reason: "lease-expired" });
      }
    });
    yield* Effect.acquireRelease(input.store.guard(gate), () => input.store.guard(undefined));

    const renewing = yield* Effect.forkScoped(Effect.gen(function* () {
      for (;;) {
        yield* Effect.sleep(Duration.millis(Math.max(1, Math.floor(ttl / 3))));
        const acknowledgedHead = input.acknowledged === undefined ? 0 : yield* input.acknowledged;
        const renewed = yield* Effect.exit(renewWriter(input.leases, held, { ttlMillis: ttl, acknowledgedHead }));
        if (renewed._tag === "Success") { held = renewed.value; continue; }
        const failure = renewed.cause.reasons.map((reason) => (reason as { error?: unknown }).error).find((error) => error instanceof WriterFenced);
        if (failure !== undefined) { superseded = true; return; }
        // The lease store could not be reached: keep trying; the gate refuses writes once the lease cannot be proved.
        yield* Effect.logWarning(`The writer lease of ${partition} could not be renewed; trying again`, renewed.cause);
      }
    }));
    yield* Effect.addFinalizer(() => Effect.andThen(
      Fiber.interrupt(renewing),
      Effect.suspend(() => superseded ? Effect.void : releaseWriter(input.leases, held)).pipe(
        Effect.catchCause((cause) => Effect.logWarning(`The writer lease of ${partition} could not be released; it expires on its own`, cause)),
      ),
    ));

    return {
      lease: Effect.sync(() => held),
      writable: Effect.map(Effect.exit(gate), (exit) => exit._tag === "Success"),
    };
  });

export interface StandbyInput {
  readonly leases: LeaseStore;
  /** The follower partition's store here. */
  readonly store: Pick<ObjectStoreApi, "guard" | "partition" | "stats">;
  readonly owner: string;
  readonly ttlMillis: number;
  /** Keeps the partition level with the writer until interrupted: normally `database.followers.follow(...)`. */
  readonly follow: Effect.Effect<never, unknown>;
  readonly acknowledged?: Effect.Effect<number>;
  /** Where followers read this node once it is the writer. */
  readonly endpoint?: string;
  /** Promote even if followers' acknowledged writes would be lost; the promotion says how many. */
  readonly allowDataLoss?: boolean;
}

const STANDBY_RETRY_MILLIS = 1000;

/**
 * Follow the writer until its lease expires, then take over: stop following, promote this follower (one
 * compare-and-set), and become the writer, held until the scope closes. A promotion refused because the follower is
 * behind, or because another follower won, goes back to following and looks again when the lease next could expire.
 * Waits for the lease's expiry time, not on a timer.
 */
export const standby = (input: StandbyInput): Effect.Effect<WriterHandle & { readonly promotion: Promotion }, DbError, Scope.Scope> =>
  Effect.gen(function* () {
    const ttl = yield* checkedTtl(input.ttlMillis);
    const margin = leaseMargin(ttl);
    const partition = input.store.partition;
    let following = yield* Effect.forkScoped(input.follow.pipe(Effect.catchCause((cause) => Effect.logWarning(`Following ${partition} stopped`, cause))));
    for (;;) {
      const now = yield* Clock.currentTimeMillis;
      const observed = yield* input.leases.read(partition);
      // The writer's lease is owed its margin again: its clock and ours may differ.
      const due = observed === undefined ? now + STANDBY_RETRY_MILLIS : observed.lease.expiresAt + margin;
      if (due > now) {
        yield* Effect.sleep(Duration.millis(Math.min(due - now, Math.ceil(ttl / 3))));
        continue;
      }
      yield* Fiber.interrupt(following);
      const head = (yield* input.store.stats).head;
      const promoted = yield* Effect.exit(promoteFollower(input.leases, {
        partition, owner: input.owner, ttlMillis: ttl, followerHead: head,
        ...(input.allowDataLoss === undefined ? {} : { allowDataLoss: input.allowDataLoss }),
        ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
      }));
      if (promoted._tag === "Success") {
        const handle = yield* holdWriter({
          leases: input.leases, store: input.store, owner: input.owner, ttlMillis: ttl, lease: promoted.value.lease,
          ...(input.acknowledged === undefined ? {} : { acknowledged: input.acknowledged }),
        }).pipe(Effect.catchTags({
          LeaseOwnedByAnother: (error) => Effect.die(error),
          LeaseStillHeld: (error) => Effect.die(error),
        }));
        return { ...handle, promotion: promoted.value };
      }
      const error = promoted.cause.reasons.map((reason) => (reason as { error?: unknown }).error).find((value) => value !== undefined);
      if (error instanceof StoreError) return yield* error;
      yield* Effect.logWarning(`${partition} was not promoted on ${input.owner}; following again`, promoted.cause);
      following = yield* Effect.forkScoped(input.follow.pipe(Effect.catchCause((cause) => Effect.logWarning(`Following ${partition} stopped`, cause))));
      yield* Effect.sleep(Duration.millis(STANDBY_RETRY_MILLIS));
    }
  });

export interface FollowWriterInput<L> {
  readonly leases: LeaseStore;
  readonly partition: PartitionKey;
  /** This node: a lease it holds itself is not followed. */
  readonly owner: string;
  /** The leader to read for a lease's endpoint. */
  readonly leaderFor: (endpoint: string) => L;
  /** Keeps this node level with `leader` until interrupted; a failure ends it and it is started again shortly. */
  readonly follow: (leader: L) => Effect.Effect<never, unknown>;
  /** How often the lease is read for a change of writer; 1000 unless given. */
  readonly pollMillis?: number;
}

const FOLLOW_RESTART_MILLIS = 500;

/**
 * Follow whoever holds the partition's writer lease, and follow the new one after a promotion: the leader to read is
 * found from the lease's `endpoint`, so no node has to be told where the writer went, and a follower that was not the
 * one promoted (a third node, or the old writer returning) points itself at the new writer from the lease alone. The
 * lease is read on a timer because that is how a change of writer is seen; following itself is not polled.
 */
export const followWriter = <L>(input: FollowWriterInput<L>): Effect.Effect<never> =>
  Effect.gen(function* () {
    const partition = input.partition;
    const poll = Math.max(50, input.pollMillis ?? 1000);
    let following: { readonly key: string; readonly fiber: Fiber.Fiber<unknown, unknown> } | undefined;
    const restarting = (leader: L) => Effect.forever(input.follow(leader).pipe(
      Effect.catchCause((cause) => Effect.logWarning(`Following the writer of ${partition} stopped; trying again`, cause)),
      Effect.andThen(Effect.sleep(Duration.millis(FOLLOW_RESTART_MILLIS))),
    ));
    for (;;) {
      const read = yield* Effect.exit(input.leases.read(partition));
      if (read._tag === "Success") {
        const lease = read.value?.lease;
        const key = lease === undefined || lease.owner === input.owner || lease.endpoint === undefined ? undefined : `${lease.epoch}\u0000${lease.endpoint}`;
        if (key !== following?.key) {
          if (following !== undefined) yield* Fiber.interrupt(following.fiber);
          following = key === undefined || lease?.endpoint === undefined ? undefined : { key, fiber: yield* Effect.forkChild(restarting(input.leaderFor(lease.endpoint))) };
        }
      } else {
        yield* Effect.logWarning(`The writer lease of ${partition} could not be read; keeping the writer already followed`, read.cause);
      }
      yield* Effect.sleep(Duration.millis(poll));
    }
  });
