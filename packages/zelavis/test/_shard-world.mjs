import assert from "node:assert/strict";
import { Effect, Exit, Scope } from "effect";
import { makeDatabase, partitionMapFor, TOPOLOGY_SHARD } from "../dist/db/index.js";
import { openShardOverKv } from "../dist/db/kv-store.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { ShardPlacementRefused, ShardPlacementUnavailable, StoreError } from "../dist/db/errors.js";

const decoder = new TextDecoder();
export const MAP = () => partitionMapFor(["shard-0", "shard-1"]);
export const RESOURCES = { cpuCores: 1, memoryBytes: 2 ** 30, diskBytes: 10 * 2 ** 30 };

export const prng = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** The Platform's side and every engine, kept across reopening the database: a crash loses processes, never these. */
export const makeWorld = () => ({
  revision: 1,
  callerNodeId: "node-a",
  placements: new Map(),
  remote: new Set(),
  remoteEngines: new Map(),
  localEngines: new Map(),
  replicas: new Map(),
  replicaEngines: new Map(),
  stores: new Map(),
  replicaDown: new Set(),
  replicaFailures: 0,
  calls: [],
  refuseRequest: undefined,
  refuseActivate: undefined,
  failReleases: 0,
  showState: undefined,
  listDown: false,
  failOpens: new Map(),
  crashAt: undefined,
  hit: undefined,
  cutBranch: undefined,
});

const engineFor = (map, shard) => {
  if (!map.has(shard)) map.set(shard, memoryKvEngine());
  return map.get(shard);
};

/** After a commit whose batch carries the operation record at `phase`, the process "dies": the writer blocks forever. */
const crashing = (world, engine) => ({
  ...engine,
  conditionalWrite: (writes, conditions) =>
    Effect.tap(engine.conditionalWrite(writes, conditions), () => {
      const target = world.crashAt;
      if (target === undefined) return Effect.void;
      const seen = writes.some((write) => {
        if (write.op !== "put") return false;
        const text = decoder.decode(write.value);
        return text.includes('"operationId"') && text.includes(`"phase":"${target}"`);
      });
      if (!seen) return Effect.void;
      world.crashAt = undefined;
      world.hit?.();
      return Effect.never;
    }),
});

const cutBranch = (world, engine) => ({
  ...engine,
  conditionalWrite: (writes, conditions) => {
    const cut = world.cutBranch;
    if (cut && writes.some((write) => Buffer.from(write.key).includes(cut.partition))) {
      cut.writes += 1;
      if (cut.writes === 2) return Effect.fail(new StoreError({ op: "test", cause: "branch cut off" }));
    }
    return engine.conditionalWrite(writes, conditions);
  },
});

const openShardFor = (world) => (shard, { origin }) => {
  if (shard === TOPOLOGY_SHARD) {
    return openShardOverKv(shard, crashing(world, engineFor(world.localEngines, shard)), { origin });
  }
  if (world.remote.has(shard)) {
    const left = world.failOpens.get(shard) ?? 0;
    if (left > 0) {
      world.failOpens.set(shard, left - 1);
      return Effect.fail(new StoreError({ op: "shard.open", cause: "the Agent is not answering" }));
    }
    return openShardOverKv(shard, engineFor(world.remoteEngines, shard), { origin });
  }
  return openShardOverKv(shard, cutBranch(world, engineFor(world.localEngines, shard)), { origin });
};

const hostFor = (world) => ({
  retry: { initialMillis: 5, maxMillis: 20 },
  list: Effect.suspend(() => world.listDown ? Effect.fail(new ShardPlacementUnavailable({ reason: "platform down" })) : Effect.succeed(null)).pipe(Effect.map(() => ({
    revision: world.revision,
    callerNodeId: world.callerNodeId,
    placements: [...world.placements.values()].map((entry) => ({
      ...entry, state: world.showState !== undefined && entry.state === "committed" ? world.showState : entry.state,
    })),
  }))),
  request: (input) =>
    Effect.gen(function* () {
      world.calls.push("request");
      if (world.refuseRequest !== undefined) return yield* new ShardPlacementRefused({ reason: world.refuseRequest });
      const held = world.placements.get(input.shardId);
      if (held !== undefined && held.operationId === input.operationId && held.state !== "released") {
        return { nodeId: held.nodeId };
      }
      if (input.expectedRevision !== world.revision) return yield* new ShardPlacementRefused({ reason: "revision-conflict" });
      const replica = input.intent === "replica";
      const nodeId = replica ? "node-c" : "node-b";
      world.placements.set(input.shardId, {
        shardId: input.shardId, role: replica ? "replica" : "primary", ...(replica ? { of: input.of } : {}),
        operationId: input.operationId, state: "reserved", nodeId, epoch: 0,
        virtualRanges: input.virtualRanges,
      });
      world.revision += 1;
      return { nodeId };
    }),
  activate: (input) =>
    Effect.gen(function* () {
      world.calls.push("activate");
      if (world.refuseActivate !== undefined) return yield* new ShardPlacementRefused({ reason: world.refuseActivate });
      const held = world.placements.get(input.shardId);
      if (held === undefined || held.operationId !== input.operationId) {
        return yield* new ShardPlacementRefused({ reason: "unknown-operation" });
      }
      if (held.state === "reserved") {
        world.placements.set(input.shardId, { ...held, state: "committed", epoch: 1 });
        world.revision += 1;
      }
      const now = world.placements.get(input.shardId);
      return { epoch: now.epoch, nodeId: now.nodeId };
    }),
  release: (input) =>
    Effect.gen(function* () {
      world.calls.push("release");
      if (world.failReleases > 0) {
        world.failReleases -= 1;
        return yield* new ShardPlacementUnavailable({ reason: "Agent unavailable during release" });
      }
      const held = world.placements.get(input.shardId);
      if (held !== undefined && held.state !== "released") {
        world.placements.set(input.shardId, { ...held, state: "released" });
        world.revision += 1;
        world.replicaEngines.delete(input.shardId);
        if (held.role === "replica") world.stores.delete(input.shardId);
      }
    }),
  replicas: Effect.sync(() => [...world.replicas].map(([of, shard]) => ({ of, shard }))),
  markReplica: (of, shard) => Effect.sync(() => { world.replicas.set(of, shard); }),
  forgetReplica: (of) => Effect.sync(() => { world.replicas.delete(of); }),
  remote: Effect.sync(() => [...world.remote].sort()),
  markRemote: (shard) => Effect.sync(() => { world.remote.add(shard); }),
  forgetRemote: (shard) => Effect.sync(() => { world.remote.delete(shard); }),
});

const openReplicaFor = (world) => (shard) => Effect.suspend(() => {
  if (world.failOpens.has(shard)) return Effect.fail(new StoreError({ op: "shard.open", cause: "the replica Agent is not answering" }));
  const engine = engineFor(world.replicaEngines, shard);
  return openShardOverKv(shard, {
    ...engine,
    conditionalWrite: (writes, conditions) => Effect.suspend(() => {
      if (!world.replicaDown.has(shard)) return engine.conditionalWrite(writes, conditions);
      world.replicaFailures += 1;
      return Effect.fail(new StoreError({ op: "replica.write", cause: "the replica Agent is not answering" }));
    }),
  });
});

const track = (world, shard, opening) =>
  Effect.tap(opening, (store) => Effect.sync(() => { world.stores.set(shard, store); }));

export const openDatabase = (world, scope) =>
  Effect.runPromise(
    makeDatabase({
      partitionMap: MAP(),
      openShard: (shard, context) => track(world, shard, openShardFor(world)(shard, context)),
      openReplica: (shard) => track(world, shard, openReplicaFor(world)(shard)),
      shardPlacement: hostFor(world),
    }).pipe(Scope.provide(scope)),
  );

export const newScope = () => Effect.runPromise(Scope.make());
export const closeScope = (scope) => Effect.runPromise(Scope.close(scope, Exit.void));
export const run = (effect) => Effect.runPromise(effect);

export const seedTenants = (db, tenants) =>
  Effect.gen(function* () {
    for (const tenant of tenants) {
      const docs = db.forTenant(tenant).documents;
      yield* docs.createCollection({ name: "posts" });
      yield* docs.insert({ collection: "posts", id: "p1", data: { title: tenant } });
    }
  });

export const readAll = (db, tenants) =>
  Effect.gen(function* () {
    const out = [];
    for (const tenant of tenants) {
      const found = yield* db.forTenant(tenant).documents.findMany({ collection: "posts" });
      out.push(found.map((d) => d.data.title).sort().join(","));
    }
    return out;
  });

export const sleep = (millis) => new Promise((resolve) => setTimeout(resolve, millis));

export const waitFor = async (read, done, what, limit = 10_000) => {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - started > limit) assert.fail(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await sleep(2);
  }
};

export const operationOf = (db) => () => run(db.shardPlacement.operation);
export const finished = (operation) => operation !== undefined && (operation.phase === "done" || operation.phase === "failed");
