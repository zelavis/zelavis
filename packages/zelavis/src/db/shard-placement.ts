import { Duration, Effect, Schema, Semaphore, type Scope } from "effect";
import {
  arrayOf, isFiniteNumber, isPositiveInteger, isString, isTimestamp, literal, objectFields, optional, parseJson,
} from "../core/json-validation.js";
import {
  ShardOperationInProgress, ShardOperationInvalid, ShardPlacementRefused, ShardPlacementUnavailable,
  type DbError, type PartitionMapInvalid, type PlacementInUse, type ShardPlacementError, type StoreError, type TenantMoveFailed,
} from "./errors.js";
import { upsert, type MovementApi } from "./movement.js";
import type { ObjectStoreApi } from "./store.js";
import type { TopologyApi } from "./topology-store.js";
import { mapWithRanges, shardsOf, type ShardId } from "./topology.js";
import type { ShardReplicas } from "./shard-replicas.js";
import type { ShardsApi } from "./database.js";

/**
 * Placing an App's virtual ranges on a shard hosted by another Node, and giving that shard back.
 *
 * The App proposes, the Platform decides the Node and commits, and the App routes. A shard's bytes
 * never move between Nodes in place: a shard is placed empty and Tenants move into it through
 * `db.movement`, which copies, fences, catches up and moves routing last. Each operation is one
 * record in the topology store, written before the effect of its successor phase, so an interrupted
 * one resumes at the recorded phase. Only the Platform answers where a shard lives and whether it is
 * committed; this module never invents either.
 */

export interface ShardResources {
  readonly cpuCores: number;
  readonly memoryBytes: number;
  readonly diskBytes: number;
}

export type ShardOperationPhase =
  | "requested" | "reserved" | "activated" | "opened" | "moving"
  | "moved" | "closed" | "released"
  | "done" | "failed";

export interface ShardOperation {
  readonly kind: "place" | "release" | "replicate" | "unreplicate";
  readonly of?: ShardId;
  readonly operationId: string;
  readonly shardId: ShardId;
  readonly virtualRanges: ReadonlyArray<number>;
  readonly into?: ShardId;
  readonly resources?: ShardResources;
  readonly phase: ShardOperationPhase;
  readonly nodeId?: string;
  readonly epoch?: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly error?: string;
}

export interface ShardPlacementView {
  readonly revision: number;
  readonly callerNodeId: string;
  readonly placements: ReadonlyArray<{
    readonly shardId: string;
    readonly role: "primary" | "replica";
    readonly of?: string;
    readonly operationId: string;
    readonly state: string;
    readonly nodeId: string;
    readonly epoch: number;
    readonly virtualRanges: ReadonlyArray<number>;
  }>;
}

export interface ShardReplicaLocation {
  readonly of: ShardId;
  readonly shard: ShardId;
}

/** What `openNodeDatabase` gives the database so the operation can reach the Platform and record locations. */
export interface ShardPlacementHost {
  readonly list: Effect.Effect<ShardPlacementView, ShardPlacementUnavailable>;
  readonly request: (input: {
    readonly intent: "allocate" | "replica";
    readonly of?: string;
    readonly operationId: string;
    readonly shardId: string;
    readonly virtualRanges: ReadonlyArray<number>;
    readonly mapVersion: number;
    readonly expectedRevision: number;
    readonly resources: ShardResources;
  }) => Effect.Effect<{ readonly nodeId: string }, ShardPlacementRefused | ShardPlacementUnavailable>;
  readonly activate: (input: { readonly shardId: string; readonly operationId: string }) =>
    Effect.Effect<{ readonly epoch: number; readonly nodeId: string }, ShardPlacementRefused | ShardPlacementUnavailable>;
  readonly release: (input: { readonly shardId: string; readonly operationId: string }) =>
    Effect.Effect<void, ShardPlacementRefused | ShardPlacementUnavailable>;
  readonly remote: Effect.Effect<ReadonlyArray<ShardId>, StoreError>;
  readonly markRemote: (shard: ShardId) => Effect.Effect<void, StoreError>;
  readonly forgetRemote: (shard: ShardId) => Effect.Effect<void, StoreError>;
  readonly replicas: Effect.Effect<ReadonlyArray<ShardReplicaLocation>, StoreError>;
  readonly markReplica: (of: ShardId, shard: ShardId) => Effect.Effect<void, StoreError>;
  readonly forgetReplica: (of: ShardId) => Effect.Effect<void, StoreError>;
  /** Backoff for transient failures; `{ initialMillis: 1000, maxMillis: 60_000 }` unless given. */
  readonly retry?: { readonly initialMillis: number; readonly maxMillis: number };
}

export interface ShardReplicaDescription {
  readonly shardId: ShardId;
  readonly nodeId?: string;
  readonly epoch?: number;
  readonly state?: string;
  readonly status: "seeding" | "following" | "behind" | "unavailable";
  readonly heldAsOf?: string;
  readonly lagMillis?: number;
  readonly colocated?: true;
}

export interface ShardDescription {
  readonly shardId: ShardId;
  readonly location: "local" | "remote";
  /** How many virtual ranges the map places on it. */
  readonly virtualRanges: number;
  readonly nodeId?: string;
  readonly epoch?: number;
  readonly state?: string;
  /** False for a remote shard this database could not open (its Node is not answering); tried again in the background. */
  readonly available?: boolean;
  readonly replica?: ShardReplicaDescription;
}

export interface ShardPlacementApi {
  readonly operation: Effect.Effect<ShardOperation | undefined, DbError>;
  readonly place: (input: {
    readonly virtualRanges: ReadonlyArray<number>;
    readonly resources: ShardResources;
    readonly shardId?: ShardId;
  }) => Effect.Effect<ShardOperation, DbError | ShardPlacementError>;
  readonly release: (input: { readonly shardId: ShardId; readonly into: ShardId }) =>
    Effect.Effect<ShardOperation, DbError | ShardPlacementError>;
  readonly replicate: (input: { readonly shardId: ShardId; readonly resources: { readonly diskBytes: number } }) =>
    Effect.Effect<ShardOperation, DbError | ShardPlacementError>;
  readonly unreplicate: (input: { readonly shardId: ShardId }) =>
    Effect.Effect<ShardOperation, DbError | ShardPlacementError>;
  /** Shards with their location and the Platform's view where reachable. */
  readonly list: Effect.Effect<ReadonlyArray<ShardDescription>, DbError>;
}

const OPERATION_NAMESPACE = "zv.shard-op";
const OPERATION_KEY = "current";
const OPERATION_COLUMN = "zv.shard-op";
const OPERATION_MARKER = " operation";
const MAX_RANGES = 4096;
const REQUEST_RETRIES = 4;
/** The most a single shard-id search looks through. */
const SHARD_NUMBER = /^shard-(\d+)$/;

const dec = new TextDecoder();

const isResources = objectFields<ShardResources>({
  cpuCores: isFiniteNumber, memoryBytes: isFiniteNumber, diskBytes: isFiniteNumber,
});

const hasOperationFields = objectFields<ShardOperation>({
  kind: literal("place", "release", "replicate", "unreplicate"),
  of: optional(isString),
  operationId: isString,
  shardId: isString,
  virtualRanges: arrayOf(isFiniteNumber),
  into: optional(isString),
  resources: optional(isResources),
  phase: literal("requested", "reserved", "activated", "opened", "moving", "moved", "closed", "released", "done", "failed"),
  nodeId: optional(isString),
  epoch: optional(isFiniteNumber),
  startedAt: isTimestamp,
  updatedAt: isTimestamp,
  error: optional(isString),
});

const replicaId = (of: ShardId): ShardId => `${of}.replica`;
const isReplicaId = (shard: ShardId): boolean => shard.endsWith(".replica");

const isOperation = (value: unknown): value is ShardOperation => hasOperationFields(value) &&
  (value.kind === "replicate" || value.kind === "unreplicate"
    ? value.of !== undefined && value.shardId === replicaId(value.of) && value.virtualRanges.length === 0
    : value.of === undefined);

const finished = (operation: ShardOperation): boolean => operation.phase === "done" || operation.phase === "failed";

const messageOf = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const tagged = error as { readonly _tag?: unknown; readonly reason?: unknown; readonly message?: unknown; readonly cause?: unknown };
    if (typeof tagged.reason === "string") return `${String(tagged._tag ?? "error")}: ${tagged.reason}`;
    if (typeof tagged.cause === "string") return `${String(tagged._tag ?? "error")}: ${tagged.cause}`;
    if (typeof tagged.message === "string" && tagged.message !== "") return tagged.message;
    if (typeof tagged._tag === "string") return tagged._tag;
  }
  return "unknown failure";
};

/** A failure that ends an operation: the Platform refused, or something proved the shard cannot be used. */
class Definitive extends Schema.TaggedError<Definitive>()("Definitive", { reason: Schema.String }) {}

export const shardPlacementOver = (options: {
  readonly topologyStore: ObjectStoreApi;
  readonly topology: TopologyApi;
  readonly movement: MovementApi;
  readonly shards: ShardsApi;
  readonly host: ShardPlacementHost | undefined;
  readonly scope: Scope.Scope;
  readonly replicas: ShardReplicas;
  /** Reads a shard's own partitions, for the reachability probe and the in-use check. */
  readonly probe: (shard: ShardId) => Effect.Effect<void, DbError>;
}): { readonly api: ShardPlacementApi; readonly resume: Effect.Effect<void> } => {
  const { topologyStore, topology, movement, shards, host, probe, replicas } = options;
  const permit = Semaphore.makeUnsafe(1);
  const retry = host?.retry ?? { initialMillis: 1000, maxMillis: 60_000 };

  const unavailable = new ShardPlacementUnavailable({ reason: "this database has no shard placement channel" });

  const read: Effect.Effect<ShardOperation | undefined, DbError> = Effect.gen(function* () {
    for (const record of yield* topologyStore.liveRecords) {
      if (record.identity.namespace !== OPERATION_NAMESPACE) continue;
      return parseJson(dec.decode(record.bytes), isOperation, "shard operation");
    }
    return undefined;
  });

  const write = (operation: ShardOperation): Effect.Effect<ShardOperation, DbError> => {
    const next = { ...operation, updatedAt: new Date().toISOString() };
    return Effect.as(
      upsert(topologyStore, OPERATION_NAMESPACE, OPERATION_KEY, next, [[OPERATION_COLUMN, OPERATION_MARKER]]),
      next,
    );
  };

  const advance = (operation: ShardOperation, phase: ShardOperationPhase, extra?: Partial<ShardOperation>) =>
    write({ ...operation, ...extra, phase });

  const fail = (operation: ShardOperation, reason: string) =>
    write({ ...operation, phase: "failed", error: reason });

  const recordError = (operation: ShardOperation, reason: string) => write({ ...operation, error: reason });

  /** The next shard id: one more than the highest `shard-<n>` the map, a pending move or the locations name. */
  const nextShardId: Effect.Effect<ShardId, DbError | StoreError> = Effect.gen(function* () {
    const names = new Set<string>(shardsOf(topology.current()));
    for (const move of yield* movement.pending) { names.add(move.from); names.add(move.to); }
    for (const name of yield* (host?.remote ?? Effect.succeed([] as ReadonlyArray<ShardId>))) names.add(name);
    let highest = -1;
    for (const name of names) {
      const match = SHARD_NUMBER.exec(name);
      if (match !== null) highest = Math.max(highest, Number(match[1]));
    }
    return `shard-${highest + 1}`;
  });

  const rangesOn = (shard: ShardId): ReadonlyArray<number> => {
    const map = topology.current();
    const out: number[] = [];
    for (const placement of map.placements) {
      if (placement.shard !== shard) continue;
      for (let slot = placement.from; slot < placement.to; slot++) out.push(slot);
    }
    return out;
  };

  /** `beforeRouting`: the Platform shows the shard committed on its Node, and the shard answered a call. */
  const beforeRouting = (shard: ShardId, nodeId: string | undefined): Effect.Effect<void, DbError | ShardPlacementError | Definitive> =>
    Effect.gen(function* () {
      if (host === undefined) return yield* unavailable;
      const view = yield* host.list;
      const entry = view.placements.find((placement) => placement.shardId === shard);
      if (entry === undefined || entry.state !== "committed" || (nodeId !== undefined && entry.nodeId !== nodeId)) {
        return yield* new Definitive({ reason: `the Platform does not show shard ${shard} committed${nodeId === undefined ? "" : ` on ${nodeId}`}` });
      }
      yield* probe(shard);
    });

  const isTransient = (error: unknown): boolean => {
    const tag = typeof error === "object" && error !== null ? (error as { _tag?: unknown })._tag : undefined;
    return tag === "StoreError" || tag === "PlacementInUse" || tag === "ShardPlacementUnavailable" ||
      tag === "WriterFenced" || tag === "PartitionUnavailable" || tag === "PartitionLeased";
  };

  /** Undo a place that cannot finish: abandon pending moves onto the shard, give the shard back, forget it. */
  const abandonPlace = (operation: ShardOperation, reason: string) =>
    Effect.gen(function* () {
      yield* movement.abandon(operation.shardId);
      const open = yield* shards.list;
      if (open.includes(operation.shardId)) {
        yield* shards.close(operation.shardId).pipe(
          Effect.catchTag("ShardInUse", () => Effect.void),
        );
      }
      if (host !== undefined) {
        yield* host.release({ shardId: operation.shardId, operationId: operation.operationId }).pipe(
          Effect.catchTag("ShardPlacementRefused", () => Effect.void),
        );
        if (!(yield* shards.list).includes(operation.shardId)) yield* host.forgetRemote(operation.shardId);
      }
      return yield* fail(operation, reason);
    });

  const abandonReplicate = (operation: ShardOperation, reason: string) => Effect.gen(function* () {
    if (host !== undefined && operation.of !== undefined) {
      yield* replicas.close(operation.of);
      yield* host.release({ shardId: operation.shardId, operationId: operation.operationId }).pipe(
        Effect.catchTag("ShardPlacementRefused", () => Effect.void),
      );
      yield* host.forgetReplica(operation.of);
    }
    return yield* fail(operation, reason);
  });

  const rangesPlacedOn = (ranges: ReadonlyArray<number>, shard: ShardId): boolean => {
    const owned = new Set(rangesOn(shard));
    return ranges.every((range) => owned.has(range));
  };

  /** One attempt at the phase an unfinished operation is in; answers the operation as it now stands. */
  const step = (operation: ShardOperation): Effect.Effect<ShardOperation, DbError | ShardPlacementError | Definitive | PartitionMapInvalid | PlacementInUse | TenantMoveFailed> =>
    Effect.gen(function* () {
      if (host === undefined) return yield* unavailable;
      const map = topology.current();
      switch (operation.phase) {
        case "requested": {
          if (operation.kind === "release") return yield* advance(operation, "moving");
          if (operation.kind === "unreplicate") {
            yield* replicas.close(operation.of!);
            yield* host.forgetReplica(operation.of!);
            return yield* advance(operation, "closed");
          }
          let attempts = 0;
          for (;;) {
            const view = yield* host.list;
            const requested = yield* Effect.result(host.request({
              intent: operation.kind === "replicate" ? "replica" : "allocate",
              ...(operation.of === undefined ? {} : { of: operation.of }),
              operationId: operation.operationId,
              shardId: operation.shardId,
              virtualRanges: operation.virtualRanges,
              mapVersion: map.version,
              expectedRevision: view.revision,
              resources: operation.resources!,
            }));
            if (requested._tag === "Success") {
              return yield* advance(operation, "reserved", { nodeId: requested.success.nodeId });
            }
            const error = requested.failure;
            if (error._tag === "ShardPlacementRefused") {
              if (error.reason === "revision-conflict" && ++attempts <= REQUEST_RETRIES) continue;
              return yield* new Definitive({ reason: error.reason });
            }
            return yield* error;
          }
        }
        case "reserved": {
          const activated = yield* Effect.result(
            host.activate({ shardId: operation.shardId, operationId: operation.operationId }),
          );
          if (activated._tag === "Failure") {
            if (activated.failure._tag === "ShardPlacementRefused") {
              if (operation.kind === "replicate") return yield* new Definitive({ reason: activated.failure.reason });
              // Frees the reservation's ranges and budget.
              yield* host.release({ shardId: operation.shardId, operationId: operation.operationId }).pipe(
                Effect.catchTag("ShardPlacementRefused", () => Effect.void),
              );
              return yield* new Definitive({ reason: activated.failure.reason });
            }
            return yield* activated.failure;
          }
          return yield* advance(operation, "activated", { epoch: activated.success.epoch, nodeId: activated.success.nodeId });
        }
        case "activated": {
          if (operation.kind === "replicate") {
            yield* host.markReplica(operation.of!, operation.shardId);
            yield* replicas.open(operation.of!, operation.shardId);
            return yield* advance(operation, "opened");
          }
          // Listed before anything opens or names it, so a crash can never reopen it as a new local shard.
          yield* host.markRemote(operation.shardId);
          yield* shards.open(operation.shardId);
          return yield* advance(operation, "opened");
        }
        case "opened":
          return yield* advance(operation, operation.kind === "replicate" ? "done" : "moving");
        case "moving": {
          if (operation.kind === "place") {
            // Marked remote but not open: a restart that resumed here.
            if (!(yield* shards.list).includes(operation.shardId)) yield* shards.open(operation.shardId);
            if ((yield* movement.pending).length > 0) {
              yield* beforeRouting(operation.shardId, operation.nodeId);
              yield* movement.resume;
            } else if (!rangesPlacedOn(operation.virtualRanges, operation.shardId)) {
              yield* movement.rebalance(
                mapWithRanges(map, operation.virtualRanges, operation.shardId),
                { beforeRouting: beforeRouting(operation.shardId, operation.nodeId) },
              );
            }
            return yield* advance(operation, "done");
          }
          const into = operation.into!;
          const remoteTarget = (yield* host.remote).includes(into);
          if ((yield* movement.pending).length > 0) {
            if (remoteTarget) yield* beforeRouting(into, undefined);
            yield* movement.resume;
          } else if (!rangesPlacedOn(operation.virtualRanges, into)) {
            yield* movement.rebalance(
              mapWithRanges(map, operation.virtualRanges, into),
              remoteTarget ? { beforeRouting: beforeRouting(into, undefined) } : undefined,
            );
          }
          return yield* advance(operation, "moved");
        }
        case "moved": {
          // Closing refuses while the map, a pending move or a partition still names the shard.
          const closed = yield* Effect.result(shards.close(operation.shardId));
          if (closed._tag === "Failure") {
            if (closed.failure._tag === "ShardInUse") return yield* fail(operation, `ShardInUse: ${closed.failure.reason}`);
            return yield* closed.failure;
          }
          yield* host.forgetRemote(operation.shardId);
          return yield* advance(operation, "closed");
        }
        case "closed": {
          const view = yield* host.list;
          const entry = view.placements.find((placement) => placement.shardId === operation.shardId);
          yield* host.release({ shardId: operation.shardId, operationId: entry?.operationId ?? operation.operationId });
          return yield* advance(operation, "released");
        }
        case "released":
          return yield* advance(operation, "done");
        default:
          return operation;
      }
    });

  const settle = (operation: ShardOperation, reason: string): Effect.Effect<ShardOperation, DbError | ShardPlacementError> =>
    Effect.suspend(() => {
      if (operation.kind === "replicate" && operation.phase !== "requested") return abandonReplicate(operation, reason);
      if (operation.kind === "place" && (operation.phase === "activated" || operation.phase === "opened" || operation.phase === "moving")) {
        return abandonPlace(operation, reason);
      }
      return fail(operation, reason);
    });

  /** Run an operation to its end, retrying transient failures with backoff for as long as the database is open. */
  const drive = (start: ShardOperation): Effect.Effect<void> =>
    Effect.gen(function* () {
      let current = start;
      let delay = retry.initialMillis;
      let settling: string | undefined;
      while (!finished(current)) {
        const next = settling === undefined ? step(current) : settle(current, settling);
        const attempt = yield* Effect.result(permit.withPermits(1)(next));
        if (attempt._tag === "Success") {
          current = attempt.success;
          delay = retry.initialMillis;
          continue;
        }
        const error = attempt.failure;
        if (!isTransient(error)) {
          if (settling !== undefined) return yield* Effect.fail(error);
          settling = error instanceof Definitive || error._tag === "ShardPlacementRefused" ? error.reason : messageOf(error);
          continue;
        }
        current = yield* recordError(current, messageOf(error));
        yield* Effect.sleep(Duration.millis(delay));
        delay = Math.min(delay * 2, retry.maxMillis);
      }
    }).pipe(Effect.orDie);

  const start = (operation: ShardOperation) =>
    Effect.gen(function* () {
      const written = yield* write(operation);
      yield* Effect.forkIn(drive(written), options.scope);
      return written;
    });

  const guardFree = Effect.gen(function* () {
    const current = yield* read;
    if (current !== undefined && !finished(current)) {
      return yield* new ShardOperationInProgress({
        operationId: current.operationId, kind: current.kind, phase: current.phase,
      });
    }
  });

  const replicaIn = (view: ShardPlacementView | undefined, of: ShardId) =>
    view?.placements.find((entry) => entry.role === "replica" && entry.of === of && entry.state !== "released");

  const startReplicaOperation = (kind: "replicate" | "unreplicate", of: ShardId, resources?: ShardResources) => {
    const now = new Date().toISOString();
    return start({
      kind, of, shardId: replicaId(of), operationId: crypto.randomUUID(), virtualRanges: [],
      ...(resources === undefined ? {} : { resources }),
      phase: "requested", startedAt: now, updatedAt: now,
    });
  };

  const api: ShardPlacementApi = {
    operation: read,

    place: (input) =>
      permit.withPermits(1)(Effect.gen(function* () {
        if (host === undefined) return yield* unavailable;
        yield* guardFree;
        const map = topology.current();
        const ranges = [...input.virtualRanges];
        if (ranges.length < 1 || ranges.length > MAX_RANGES) {
          return yield* new ShardOperationInvalid({ reason: `place takes between 1 and ${MAX_RANGES} virtual ranges` });
        }
        if (new Set(ranges).size !== ranges.length) {
          return yield* new ShardOperationInvalid({ reason: "virtual ranges must be distinct" });
        }
        for (const range of ranges) {
          if (!Number.isInteger(range) || range < 0 || range >= map.virtualRanges) {
            return yield* new ShardOperationInvalid({ reason: `virtual range ${range} is outside [0, ${map.virtualRanges})` });
          }
        }
        const { cpuCores, memoryBytes, diskBytes } = input.resources;
        if (![cpuCores, memoryBytes, diskBytes].every((value) => Number.isFinite(value) && value > 0)) {
          return yield* new ShardOperationInvalid({ reason: "resources must be positive numbers" });
        }
        const shardId = input.shardId ?? (yield* nextShardId);
        if (input.shardId !== undefined) {
          if (isReplicaId(shardId)) return yield* new ShardOperationInvalid({ reason: "the .replica suffix is reserved for replicas" });
          const taken = new Set<string>(shardsOf(map));
          for (const move of yield* movement.pending) { taken.add(move.from); taken.add(move.to); }
          for (const name of yield* host.remote) taken.add(name);
          if (taken.has(shardId)) return yield* new ShardOperationInvalid({ reason: `shard ${shardId} already exists` });
        }
        const now = new Date().toISOString();
        return yield* start({
          kind: "place",
          operationId: crypto.randomUUID(),
          shardId,
          virtualRanges: ranges.sort((a, b) => a - b),
          resources: { cpuCores, memoryBytes, diskBytes },
          phase: "requested",
          startedAt: now,
          updatedAt: now,
        });
      })),

    release: (input) =>
      permit.withPermits(1)(Effect.gen(function* () {
        if (host === undefined) return yield* unavailable;
        yield* guardFree;
        const map = topology.current();
        if (input.into === input.shardId) {
          return yield* new ShardOperationInvalid({ reason: "a shard cannot be released into itself" });
        }
        if (!shardsOf(map).includes(input.into) && !(yield* shards.list).includes(input.into)) {
          return yield* new ShardOperationInvalid({ reason: `shard ${input.into} is not part of this database` });
        }
        if (!(yield* host.remote).includes(input.shardId)) {
          return yield* new ShardOperationInvalid({ reason: `shard ${input.shardId} is not on another Node` });
        }
        const view = yield* host.list;
        if (replicas.has(input.shardId) || replicaIn(view, input.shardId) !== undefined) {
          return yield* new ShardOperationInvalid({ reason: `shard ${input.shardId} has a replica: unreplicate it first` });
        }
        if (!view.placements.some((placement) => placement.shardId === input.shardId && placement.state !== "released")) {
          return yield* new ShardOperationInvalid({ reason: `the Platform holds no live placement for shard ${input.shardId}` });
        }
        // Moving ranges carries Tenants away, not the database's own partitions: a cross-Tenant index placed here would
        // keep the shard from closing after everything had already moved.
        const own = yield* shards.reserved(input.shardId);
        if (own.length > 0) {
          const indexes = own.filter((partition) => partition.startsWith("zv.cti.")).map((partition) => partition.slice("zv.cti.".length));
          return yield* new ShardOperationInvalid({
            reason: indexes.length > 0
              ? `shard ${input.shardId} holds the entries of cross-Tenant index ${indexes.join(", ")}: drop or redefine it on other shards first`
              : `shard ${input.shardId} holds the database's own partitions (${own.join(", ")})`,
          });
        }
        const now = new Date().toISOString();
        return yield* start({
          kind: "release",
          operationId: crypto.randomUUID(),
          shardId: input.shardId,
          virtualRanges: rangesOn(input.shardId),
          into: input.into,
          phase: "requested",
          startedAt: now,
          updatedAt: now,
        });
      })),

    replicate: ({ shardId, resources: { diskBytes } }) =>
      permit.withPermits(1)(Effect.gen(function* () {
        if (host === undefined) return yield* unavailable;
        yield* guardFree;
        if (isReplicaId(shardId)) return yield* new ShardOperationInvalid({ reason: "a replica cannot have a replica" });
        if (!shardsOf(topology.current()).includes(shardId) && !(yield* shards.list).includes(shardId) &&
            !(yield* host.remote).includes(shardId)) {
          return yield* new ShardOperationInvalid({ reason: `shard ${shardId} is not part of this database` });
        }
        if (!isPositiveInteger(diskBytes)) return yield* new ShardOperationInvalid({ reason: "diskBytes must be a positive integer" });
        if (replicas.has(shardId) || replicaIn(yield* host.list, shardId) !== undefined) {
          return yield* new ShardOperationInvalid({ reason: `shard ${shardId} already has a replica` });
        }
        return yield* startReplicaOperation("replicate", shardId, { cpuCores: 0, memoryBytes: 0, diskBytes });
      })),

    unreplicate: ({ shardId }) =>
      permit.withPermits(1)(Effect.gen(function* () {
        if (host === undefined) return yield* unavailable;
        yield* guardFree;
        if (!replicas.has(shardId) && replicaIn(yield* host.list, shardId) === undefined) {
          return yield* new ShardOperationInvalid({ reason: `shard ${shardId} has no replica` });
        }
        return yield* startReplicaOperation("unreplicate", shardId);
      })),

    list: Effect.gen(function* () {
      const map = topology.current();
      const remote = new Set(host === undefined ? [] : yield* host.remote);
      const copies = yield* replicas.list;
      const view = host === undefined || (remote.size === 0 && copies.size === 0) ? undefined : yield* Effect.result(host.list);
      const ledger = view?._tag === "Success" ? view.success : undefined;
      const open = new Set(yield* shards.list);
      const names = new Set<ShardId>([...shardsOf(map), ...open, ...remote]);
      const out: ShardDescription[] = [];
      for (const shardId of [...names].sort()) {
        const count = rangesOn(shardId).length;
        const copy = copies.get(shardId);
        const replicaEntry = replicaIn(ledger, shardId);
        const replica = copy === undefined && replicaEntry === undefined ? undefined : {
          ...(copy ?? { shardId: replicaEntry!.shardId, status: "unavailable" as const }),
          ...(replicaEntry === undefined ? {} : { nodeId: replicaEntry.nodeId, epoch: replicaEntry.epoch, state: replicaEntry.state }),
          ...(replicaEntry !== undefined && replicaEntry.nodeId === ledger?.callerNodeId ? { colocated: true as const } : {}),
        };
        if (!remote.has(shardId)) {
          out.push({ shardId, location: "local", virtualRanges: count, ...(replica === undefined ? {} : { replica }) });
          continue;
        }
        const entry = ledger?.placements.find((placement) => placement.role === "primary" && placement.shardId === shardId);
        out.push({
          shardId, location: "remote", virtualRanges: count, available: open.has(shardId),
          ...(replica === undefined ? {} : { replica }),
          ...(entry === undefined ? {} : { nodeId: entry.nodeId, epoch: entry.epoch, state: entry.state }),
        });
      }
      return out;
    }),
  };

  /** At open: carry an unfinished operation on in the background. */
  const resume = Effect.gen(function* () {
    const current = yield* read;
    if (current !== undefined && !finished(current)) yield* Effect.forkIn(drive(current), options.scope);
  }).pipe(Effect.orDie);

  return { api, resume };
};
