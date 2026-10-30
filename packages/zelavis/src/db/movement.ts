import { parseJson, objectFields, isString, isTimestamp, isBoolean, optional, literal } from "../core/json-validation.js";
import { partitionMapRecord } from "./topology-store.js";
import { Effect } from "effect";
import type { DbError, PlacementInUse } from "./errors.js";
import { PartitionMapInvalid, TenantMoveFailed } from "./errors.js";
import type { Seq } from "./model.js";
import type { ObjectStoreApi, ShardStoreApi } from "./store.js";
import type { RangeMove, TopologyApi } from "./topology-store.js";
import { catchUpFollower, levelFollower } from "./followers.js";
import { shardFor, type PartitionMap, type ShardId, type TenantId } from "./topology.js";

/**
 * Relocating a tenant's records so an occupied range can be re-placed.
 *
 * A partition map is routing and carries no data with it, which is why
 * `topology.update` refuses to move a range that tenants are standing on: the
 * records would stay where they were while every read went to the new shard and
 * found nothing. That refusal is correct and it is also a dead end — without a
 * way to move the records, a map can only ever be changed where it does not
 * matter.
 *
 * This is that way. It is deliberately not a transaction: there is no atomic
 * write across two shards, and pretending otherwise would be the kind of
 * mechanism that looks fine until the moment it is interrupted. Instead the
 * move is a sequence whose every intermediate state is one a reader can be in
 * safely, recorded as it goes so an interruption can be resumed rather than
 * repaired.
 *
 * The order is what carries it:
 *
 *   1. Copy the tenant's partition to the shard it is joining, and apply the
 *      source's log onto it at the positions it holds there. Nothing is
 *      fenced: the tenant is still written to, and the copy is behind by
 *      however much arrived during it. Routing has not moved, so the target is
 *      scratch space that no reader can reach.
 *   2. Catch the copy up from the source's log, repeatedly. Each round is
 *      shorter than the last, because each replays only what arrived during the
 *      round before it. Still nothing is fenced.
 *   3. Fence writes for the tenant on the shard it is leaving, and catch up one
 *      last time. This round is bounded, because nothing can be added to it:
 *      the fence is checked under the partition's writer, so every write either
 *      committed before it or is refused. Reads carry on at the source
 *      throughout.
 *   4. Move the routing. Reads and writes go to the target from here on. This
 *      is the only moment that is not reversible by doing nothing, and it is a
 *      single record.
 *   5. Drop the tenant from the source, fence included, leaving only the map
 *      version that moved it (`ShardStoreApi.relocate`). Cleanup: the records
 *      being removed are ones nothing routes to any more, and a router whose
 *      map is older than the move is refused there rather than answered empty.
 *      The fence is the source's alone and is never copied, so the target
 *      takes writes as soon as routing points at it.
 *
 * The window in which the tenant cannot be written is step 3 to step 4 — the
 * last catch-up, which is proportional to what was written during the round
 * before it rather than to how much the tenant holds. It is never unreadable.
 *
 * The copy is the tenant's partition as it is — the same identifiers and the
 * same log positions — so nothing is translated on the way across: an edge
 * names the same record on both shards, and a cursor or projection checkpoint
 * taken before the move continues after it.
 *
 * A resume carries on where the copy stopped. The target's positions are the
 * source's, so its head is a cursor the source understands, and catching up
 * from it is the same step an uninterrupted move takes. Only a copy that never
 * finished its seed — or whose source has since compacted past the target's
 * head — is thrown away and made again.
 */

/** How far a move has got, so an interrupted one can be picked up. */
export type MovePhase =
  /**
   * Copying, and catching up. Writes still land on the source and routing
   * still points at it; the target is a copy a resume carries on from its
   * head, or makes again if its seed never finished.
   */
  | "copying"
  /**
   * Fenced and caught up: on both shards and identical. Routing still points at
   * the source.
   */
  | "copied"
  /**
   * Routing points at the target. The source still holds the tenant, fenced,
   * until every call that reached it before routing moved has finished; then
   * it is cleared, fence and all.
   */
  | "routed";

export interface TenantMove {
  readonly tenant: TenantId;
  readonly from: ShardId;
  readonly to: ShardId;
  readonly phase: MovePhase;
  readonly startedAt: string;
  /**
   * This move has already been picked up once: set when a resume takes over,
   * which carries on the copy from the target's head rather than starting it.
   */
  readonly resumed?: boolean;
  /**
   * The map this move is heading for.
   *
   * Carried on the move rather than held by whoever started it, because the
   * process that started it may not be the one that finishes it. A resume with
   * no record of where a half-moved tenant was going could only guess.
   */
  readonly map: PartitionMap;
}

export interface MoveResult {
  readonly tenant: TenantId;
  readonly from: ShardId;
  readonly to: ShardId;
  /** Records written to the target by the first, unfenced copy. */
  readonly copied: number;
  /** Events replayed afterwards to catch the copy up. */
  readonly caughtUp: number;
  /**
   * Events replayed while writes were fenced.
   *
   * The size of the write outage, in the only unit that means anything: what
   * had to be applied once nothing further could arrive.
   */
  readonly settled: number;
  /** Catch-up rounds run before fencing. */
  readonly rounds: number;
  /** Records removed from the source afterwards, once nothing was using it. */
  readonly removed: number;
  /** This move was already part-done and was picked up rather than started. */
  readonly resumed: boolean;
}

export interface RebalanceResult {
  readonly moves: ReadonlyArray<MoveResult>;
  /** The map now in force. Unchanged when there was nothing to move. */
  readonly map: PartitionMap;
}

export interface MovementApi {
  /** Which ranges a proposed map moves, and which tenants are standing on them. */
  readonly plan: (next: PartitionMap) => Effect.Effect<ReadonlyArray<RangeMove>>;

  /**
   * Moves that were started and have not finished.
   *
   * Non-empty means a process died partway through one. Every phase is safe to
   * be sitting in, but a tenant left in `copying` or `copied` cannot be written
   * to until the move is finished or abandoned.
   */
  readonly pending: Effect.Effect<ReadonlyArray<TenantMove>, DbError>;

  /**
   * Relocate every tenant a proposed map would move, then apply it.
   *
   * The map is applied once, after every tenant has been copied, because it is
   * one record: applying it per tenant would mean a map that routes half the
   * moved tenants to shards that do not hold them yet.
   */
  readonly rebalance: (
    next: PartitionMap,
  ) => Effect.Effect<RebalanceResult, DbError | PartitionMapInvalid | TenantMoveFailed | PlacementInUse>;

  /** Carry any interrupted move through to the end. */
  readonly resume: Effect.Effect<
    ReadonlyArray<MoveResult>,
    DbError | PartitionMapInvalid | TenantMoveFailed | PlacementInUse
  >;
}

/**
 * Batches of the source's log one unfenced catch-up round applies at most.
 * Bounded so a tenant written faster than it is copied ends a round rather
 * than holding it open; the rounds are bounded too, and the fence ends them.
 */
const ROUND_BATCHES = 64;

/**
 * Catch-up rounds run before writes are fenced.
 *
 * Each round replays only what arrived during the one before it, so the backlog
 * shrinks as long as the copy outpaces the writing. The cap is what stops a
 * tenant written to faster than it can be copied from being chased forever: at
 * that point the fence is the only thing that ends it, and taking it sooner is
 * kinder than taking it later.
 */
const CATCH_UP_ROUNDS = 8;

const MOVE_NAMESPACE = "zv.move";
const MOVE_COLUMN = "zv.move";
const MOVE_MARKER = " move";

const enc = new TextEncoder();
const dec = new TextDecoder();

export const movementOver = (options: {
  readonly topologyStore: ObjectStoreApi;
  readonly topology: TopologyApi;
  readonly shards: ReadonlyMap<ShardId, ShardStoreApi>;
  /**
   * Waits until no call still uses the tenant's partition on a shard routing
   * has moved it off (see `PartitionRouter.drained`).
   */
  readonly drained: (shard: ShardId, tenant: TenantId) => Effect.Effect<void, PlacementInUse>;
}): MovementApi => {
  const { topologyStore, topology, shards, drained } = options;

  /**
   * A shard the move names. The database opens every shard the map and any
   * recorded move name before movement runs, so one missing here is a broken
   * invariant, not something a caller can act on.
   */
  const shardNamed = (shard: ShardId): Effect.Effect<ShardStoreApi> => {
    const store = shards.get(shard);
    return store === undefined
      ? Effect.die(new Error(`Relocation names shard "${shard}", which is not open here.`))
      : Effect.succeed(store);
  };

  /** The tenant's own partition on a shard. */
  const storeFor = (shard: ShardId, tenant: TenantId): Effect.Effect<ObjectStoreApi> =>
    Effect.map(shardNamed(shard), (store) => store.partition(tenant));

  const put = (store: ObjectStoreApi, seq: Seq, body: unknown, columns: [string, string][],
    namespace: string, key: string) =>
    store.transact((txn) =>
      txn.put(seq, enc.encode(JSON.stringify(body)), {
        terms: [], columns, measures: [], edges: [],
      }, { namespace, key }));

  const upsert = (store: ObjectStoreApi, namespace: string, key: string, body: unknown,
    columns: [string, string][]) =>
    Effect.gen(function* () {
      const existing = yield* store.lookup(namespace, key);
      const seq = existing ?? (yield* store.nextSeq);
      yield* put(store, seq, body, columns, namespace, key);
    });

  const drop = (store: ObjectStoreApi, namespace: string, key: string) =>
    Effect.gen(function* () {
      const seq = yield* store.lookup(namespace, key);
      if (seq !== undefined) yield* store.transact((txn) => txn.retract(seq));
    });

  /** Every move on record, whatever phase it is in. */
  const pending: Effect.Effect<ReadonlyArray<TenantMove>, DbError> = Effect.gen(function* () {
    const out: TenantMove[] = [];
    for (const record of yield* topologyStore.liveRecords) {
      if (record.identity.namespace !== MOVE_NAMESPACE) continue;
      out.push(parseJson(dec.decode(record.bytes), objectFields<TenantMove>({ tenant: isString, from: isString, to: isString, phase: literal("copying", "copied", "routed"), startedAt: isTimestamp, resumed: optional(isBoolean), map: partitionMapRecord })));
    }
    return out.sort((a, b) => (a.tenant < b.tenant ? -1 : a.tenant > b.tenant ? 1 : 0));
  });

  const recordMove = (move: TenantMove) =>
    upsert(topologyStore, MOVE_NAMESPACE, move.tenant, move, [[MOVE_COLUMN, MOVE_MARKER]]);

  /**
   * Copy a tenant onto the target shard, as a follower of the source: its
   * whole partition — records, identifiers, log positions, occupancy marker,
   * projection checkpoints — as the source holds them.
   *
   * Nothing is fenced, so the source keeps taking writes while its records are
   * read; the source's log, applied from its compaction point by version, is
   * what makes the copy exact (see `ObjectStoreApi.seed`). Because identifiers
   * and positions are the source's own, an edge names the same record on both
   * shards and a cursor taken on one continues on the other.
   *
   * A move starting afresh copies from the start: anything already on the
   * target is the wreckage of an earlier attempt, and routing still points at
   * the source, so clearing it discards nothing anybody reads. A resumed one
   * carries the copy on from the target's head where that can be exact (see
   * `levelFollower`).
   */
  const copy = (tenant: TenantId, from: ShardId, to: ShardId, fresh: boolean) =>
    Effect.gen(function* () {
      const source = yield* storeFor(from, tenant);
      const pass = yield* levelFollower(source, { shard: yield* shardNamed(to), partition: tenant },
        { fresh, maxBatches: ROUND_BATCHES });
      return { copied: pass.seeded, caughtUp: pass.applied };
    });

  /**
   * Whether the two sides agree: the same log head, and the same records.
   *
   * Afterwards the source is cleared and there is nothing left to compare
   * against, so a copy that came up short would be discovered later as missing
   * documents with no way back.
   */
  const agree = (tenant: TenantId, from: ShardId, to: ShardId) =>
    Effect.gen(function* () {
      const here = yield* (yield* storeFor(from, tenant)).stats;
      const there = yield* (yield* storeFor(to, tenant)).stats;
      return { agreed: here.head === there.head && here.records === there.records, here, there };
    });

  const assertSameSize = (tenant: TenantId, from: ShardId, to: ShardId) =>
    Effect.gen(function* () {
      const { agreed, here, there } = yield* agree(tenant, from, to);
      if (!agreed) {
        return yield* new TenantMoveFailed({
          tenant, from, to,
          reason: `the copy holds ${there.records} records at position ${there.head} where the source holds ` +
            `${here.records} at ${here.head}`,
        });
      }
    });

  /**
   * Apply what the source has logged past the target's head, at the positions
   * it holds there: one bounded round while writes carry on, or — once the
   * source is fenced and its log has stopped — until there is nothing more.
   *
   * The two partitions share a name and their positions, so the target's head
   * is a cursor the source understands. The copy is the move's own, never
   * written any other way, so a log that does not continue the source's is a
   * broken invariant.
   */
  const catchUp = (tenant: TenantId, from: ShardId, to: ShardId, untilDone: boolean) =>
    Effect.gen(function* () {
      const source = yield* storeFor(from, tenant);
      const target = yield* storeFor(to, tenant);
      let applied = 0;
      for (;;) {
        const round = yield* catchUpFollower(source, target, { maxBatches: ROUND_BATCHES }).pipe(
          Effect.catchTags({ EventGap: Effect.die, ReplicaDiverged: Effect.die }),
        );
        applied += round.applied;
        if (!untilDone || !round.more) return applied;
      }
    });

  /**
   * Remove a tenant from a shard: its whole partition, as a range — records,
   * log, lenses, occupancy marker and fence — so the shard holds and claims
   * nothing of it. On the shard a tenant left, only once nothing is using it:
   * every call reaches the shard routing names as it starts and leases it, so
   * when the leases taken there before routing moved are gone, nothing in this
   * process can arrive there again and the fence has nothing left to refuse.
   *
   * What the shard keeps is the version of the map that moved the tenant, so a
   * router holding an older map — one outside this process, or one restarted
   * from a stale copy — is told the tenant moved rather than shown an empty
   * one (`TenantRelocated`).
   */
  const clear = (tenant: TenantId, from: ShardId, mapVersion: number) =>
    Effect.flatMap(shardNamed(from), (shard) => shard.relocate(tenant, mapVersion));

  /**
   * Carry one move from wherever it is to the end.
   *
   * Each phase reads its own precondition rather than trusting the caller to
   * have run the previous one, which is what makes resuming and starting the
   * same code path instead of two that have to agree.
   */
  /**
   * Put the move's map in force, once.
   *
   * A map change is one record however many tenants a rebalance moves, and the
   * version check is what makes calling this per tenant safe: the first call
   * applies it and the rest find it already applied. The same check is what
   * lets a resume tell "routing has not moved yet" from "routing moved and the
   * cleanup did not finish".
   */
  const applyRoute = (move: TenantMove) =>
    Effect.gen(function* () {
      const map = topology.current();
      if (map.version < move.map.version) return yield* topology.applyAfterMove(move.map);
      if (shardFor(map, move.tenant) === move.to) return map;
      return yield* new PartitionMapInvalid({
        version: map.version,
        reason:
          `the map in force puts "${move.tenant}" on "${shardFor(map, move.tenant)}", but an ` +
          `unfinished relocation was moving it to "${move.to}"`,
      });
    });

  /**
   * Carry a set of moves through to the end, together.
   *
   * Together rather than one at a time, because routing is one record for all
   * of them. Applying it while a later tenant was still uncopied would route
   * that tenant to a shard which does not hold it yet — reads finding nothing
   * and writes landing in a shard with no collections, for as long as the rest
   * of the copying took.
   *
   * The stages are also interleaved rather than run per tenant, so that a
   * tenant fenced early does not stay fenced through everyone else's copy: the
   * unfenced copying happens for all of them, then the fences go on, then the
   * final catch-ups.
   */
  const runMoves = (moves: ReadonlyArray<TenantMove>) =>
    Effect.gen(function* () {
      const state = new Map<TenantId, {
        copied: number;
        caughtUp: number;
        settled: number;
        rounds: number;
      }>();

      const unsettled = moves.filter((move) => move.phase === "copying");

      for (const move of unsettled) {
        const first = yield* copy(move.tenant, move.from, move.to, move.resumed !== true);
        state.set(move.tenant, { copied: first.copied, caughtUp: first.caughtUp, settled: 0, rounds: 0 });

        // Unfenced rounds. Each replays what arrived during the one before it,
        // so the backlog shrinks while the copy outpaces the writing.
        const stats = state.get(move.tenant)!;
        for (; stats.rounds < CATCH_UP_ROUNDS; stats.rounds++) {
          const applied = yield* catchUp(move.tenant, move.from, move.to, false);
          stats.caughtUp += applied;
          if (applied === 0) break;
        }
      }

      const chasing = unsettled;
      for (const move of chasing) yield* fence(move.tenant, move.from, move.to);

      // The fence is checked under the source partition's writer, so once it
      // is set nothing more lands there: one last catch-up takes the rest.
      for (const move of chasing) {
        const stats = state.get(move.tenant)!;
        stats.settled = yield* settle(move);
      }

      for (const move of unsettled) {
        yield* assertSameSize(move.tenant, move.from, move.to);
        yield* recordMove({ ...move, phase: "copied" });
      }

      // One record, once, now that every tenant is on its target.
      for (const move of moves) {
        if (move.phase === "routed") continue;
        yield* applyRoute(move);
      }
      for (const move of moves) {
        if (move.phase === "routed") continue;
        yield* recordMove({ ...move, phase: "routed" });
      }

      const results: MoveResult[] = [];
      for (const move of moves) {
        // A call that reached the source before routing moved still reads
        // whole data there, and any write it makes is refused by the fence;
        // the source goes only once all of them are done. A deadline passed
        // leaves the move routed, for a resume to clear.
        yield* drained(move.from, move.tenant);
        const removed = yield* clear(move.tenant, move.from, move.map.version);
        yield* drop(topologyStore, MOVE_NAMESPACE, move.tenant);
        const stats = state.get(move.tenant);
        results.push({
          tenant: move.tenant,
          from: move.from,
          to: move.to,
          copied: stats?.copied ?? 0,
          caughtUp: stats?.caughtUp ?? 0,
          settled: stats?.settled ?? 0,
          rounds: stats?.rounds ?? 0,
          removed,
          resumed: move.resumed === true,
        });
      }
      return results;
    });

  /**
   * Replay what is left now that the source is fenced, and check the two sides
   * agree.
   *
   * Nothing can land on the source any more, so the log stops where it is and
   * one catch-up reaches its end. Disagreeing afterwards means something other
   * than a late write is wrong, and the right move is to stop with routing
   * unmoved and the source intact rather than to route to a copy that does not
   * match.
   */
  const settle = (move: TenantMove) =>
    Effect.gen(function* () {
      const applied = yield* catchUp(move.tenant, move.from, move.to, true);
      const { agreed, here, there } = yield* agree(move.tenant, move.from, move.to);
      if (agreed) return applied;
      return yield* new TenantMoveFailed({
        tenant: move.tenant, from: move.from, to: move.to,
        reason: `with writes fenced, the copy holds ${there.records} records at position ${there.head} ` +
          `where the source holds ${here.records} at ${here.head}`,
      });
    });

  /** Stop writes to the tenant on the shard it is leaving. */
  const fence = (tenant: TenantId, from: ShardId, to: ShardId) =>
    Effect.flatMap(storeFor(from, tenant), (store) => store.fence({ from, to }));

  const begin = (tenant: TenantId, from: ShardId, to: ShardId, map: PartitionMap) =>
    Effect.gen(function* () {
      const move: TenantMove = {
        tenant, from, to, map, phase: "copying", startedAt: new Date().toISOString(),
      };
      // Recorded before anything is copied, and nothing is fenced yet. An
      // interruption here leaves a writable tenant, a stale copy on the target
      // that nothing routes to, and a record saying a move was in progress —
      // which is what a resume needs to know to throw that copy away.
      yield* recordMove(move);
      return move;
    });

  const movesFor = (next: PartitionMap) =>
    Effect.map(topology.plan(next), (ranges) =>
      ranges.flatMap((range) =>
        range.tenants.map((tenant) => ({ tenant, from: range.from, to: range.to }))));

  return {
    plan: topology.plan,
    pending,

    rebalance: (next) =>
      Effect.gen(function* () {
        const outstanding = yield* pending;
        if (outstanding.length > 0) {
          // Starting a second move over an unfinished one would fence a tenant
          // twice and route it once, and the record of where it was going would
          // be the newer of two answers.
          return yield* new PartitionMapInvalid({
            version: next.version,
            reason:
              `${outstanding.length} relocation(s) have not finished (${
                outstanding.map((move) => `${move.tenant}: ${move.phase}`).join(", ")
              }); resume or finish them before changing the map`,
          });
        }

        const planned = yield* movesFor(next);
        if (planned.length === 0) {
          // Nothing is standing on a moving range, so the ordinary checked path
          // applies: no relocation happened, and none was needed.
          return { moves: [], map: yield* topology.update(next).pipe(Effect.orDie) };
        }

        const started: TenantMove[] = [];
        for (const { tenant, from, to } of planned) {
          started.push(yield* begin(tenant, from, to, next));
        }

        return { moves: yield* runMoves(started), map: topology.current() };
      }),

    resume: Effect.gen(function* () {
      const outstanding = yield* pending;
      return yield* runMoves(outstanding.map((move) => ({ ...move, resumed: true })));
    }),
  };
};
