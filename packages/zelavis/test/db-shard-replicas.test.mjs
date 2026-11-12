import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Fiber } from "effect";
import { isReservedTenantId, mapWithRanges, virtualRangeFor } from "../dist/db/index.js";
import {
  MAP, RESOURCES, prng, makeWorld, openDatabase, newScope, closeScope, run, seedTenants, readAll,
  waitFor, operationOf, finished,
} from "./_shard-world.mjs";

const PRIMARY = "shard-0";
const REPLICA = `${PRIMARY}.replica`;
const SEEDS = Number(process.env.SEEDS) || 20;
const input = (shardId = PRIMARY) => ({ shardId, resources: { diskBytes: 512 * 2 ** 20 } });
const tenantsFor = (seed) => {
  const random = prng(seed);
  return Array.from({ length: 16 }, (_, index) => `tenant-${Math.floor(random() * 1e6)}-${index}`);
};
const replicaOf = async (db) => (await run(db.shardPlacement.list)).find((shard) => shard.shardId === PRIMARY)?.replica;
const finish = async (db, what) => {
  const operation = await waitFor(operationOf(db), finished, what);
  assert.equal(operation.phase, "done", operation.error);
};
const replicate = async (db, shardId = PRIMARY) => {
  await run(db.shardPlacement.replicate(input(shardId)));
  await finish(db, "replicate");
};
const following = (db, after = -Infinity) =>
  waitFor(() => replicaOf(db), (replica) => replica?.status === "following" && Date.parse(replica.heldAsOf) > after, "a level replica");
const partitionsOn = (store) => run(store.partitions).then((partitions) => partitions.filter((id) => !isReservedTenantId(id)).sort());

const contents = (store, partition) => run(Effect.gen(function* () {
  const source = store.partition(partition);
  const { head, records } = yield* source.stats;
  const held = [];
  let after;
  for (;;) {
    const page = yield* source.scanRecords({ limit: 4, ...(after === undefined ? {} : { after }) });
    held.push(...page);
    if (page.length < 4) return { head, records, held };
    after = page.at(-1).seq;
  }
}));

const assertConverged = async (world) => {
  const primary = world.stores.get(PRIMARY);
  const replica = world.stores.get(REPLICA);
  const partitions = await partitionsOn(primary);
  assert.deepEqual(await partitionsOn(replica), partitions);
  for (const partition of partitions) {
    assert.deepEqual(await contents(replica, partition), await contents(primary, partition), partition);
  }
};

const write = (db, tenant, index) => run(db.forTenant(tenant).documents.insert({
  collection: "posts", id: `more-${index}`, data: { title: `more-${index}` },
}));

const crashCase = async (seed, kind, phase) => {
  const world = makeWorld();
  const tenants = tenantsFor(seed);
  let scope = await newScope();
  try {
    let db = await openDatabase(world, scope);
    await run(seedTenants(db, tenants));
    const before = await run(readAll(db, tenants));
    if (kind === "unreplicate") await replicate(db);

    world.crashAt = phase;
    const action = Effect.runFork(kind === "replicate"
      ? db.shardPlacement.replicate(input())
      : db.shardPlacement.unreplicate({ shardId: PRIMARY }));
    await waitFor(() => world.crashAt, (value) => value === undefined, `crash at ${phase}`);
    await closeScope(scope);
    await run(Fiber.interrupt(action));

    scope = await newScope();
    db = await openDatabase(world, scope);
    await finish(db, `${kind} after crash at ${phase}`);
    assert.deepEqual(await run(readAll(db, tenants)), before);
    if (kind === "replicate") {
      assert.equal(world.replicas.get(PRIMARY), REPLICA);
      await following(db);
      await assertConverged(world);
    } else {
      assert.equal(world.replicas.has(PRIMARY), false);
      assert.equal(world.replicaEngines.has(REPLICA), false);
      assert.equal(world.placements.get(REPLICA).state, "released");
    }
  } catch (cause) {
    throw new Error(`seed ${seed}, ${kind}@${phase}`, { cause });
  } finally {
    await closeScope(scope);
  }
};

test("a crash at every phase of replicate and unreplicate resumes to the same end (B5, 20 seeds)", async () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    for (const phase of ["requested", "reserved", "activated", "opened"]) await crashCase(seed, "replicate", phase);
    for (const phase of ["requested", "closed", "released"]) await crashCase(seed, "unreplicate", phase);
  }
});

const convergenceCase = async (seed) => {
  const world = makeWorld();
  const scope = await newScope();
  try {
    const db = await openDatabase(world, scope);
    const random = prng(seed);
    const tenants = tenantsFor(seed);
    await run(seedTenants(db, tenants));
    await replicate(db);
    await following(db);

    const here = tenants.find((tenant) => db.shardOf(tenant) === PRIMARY);
    const there = tenants.find((tenant) => db.shardOf(tenant) !== PRIMARY);
    assert.ok(here && there);
    const map = db.topology.current();
    const moved = mapWithRanges(mapWithRanges(map, [virtualRangeFor(map, here)], "shard-1"), [virtualRangeFor(map, there)], PRIMARY);
    await run(db.movement.rebalance(moved));
    await waitFor(() => partitionsOn(world.stores.get(REPLICA)),
      (partitions) => partitions.includes(there) && !partitions.includes(here), "the copy to follow both moves");

    world.replicaDown.add(REPLICA);
    await write(db, there, 0);
    for (let index = 1; index <= 12; index++) await write(db, tenants[Math.floor(random() * tenants.length)], index);
    await waitFor(() => world.replicaFailures, (failures) => failures > 0, "a replica write to fail");
    const copy = world.stores.get(REPLICA).partition(there);
    const primary = world.stores.get(PRIMARY).partition(there);
    await run(db.maintenance.compact({ keep: 0 }));
    assert.ok((await run(primary.stats)).compactedTo > (await run(copy.stats)).head);
    const written = Date.now();
    world.replicaDown.delete(REPLICA);
    await following(db, written);
    await assertConverged(world);
    assert.deepEqual(db.partitionMap, moved);
  } catch (cause) {
    throw new Error(`seed ${seed}`, { cause });
  } finally {
    await closeScope(scope);
  }
};

test("a replica converges through writes, moves, compaction and outages (B3, 20 seeds)", async () => {
  const concurrency = 4;
  for (let seed = 1; seed <= SEEDS; seed += concurrency) {
    await Promise.all(Array.from({ length: Math.min(concurrency, SEEDS - seed + 1) }, (_, offset) => convergenceCase(seed + offset)));
  }
});

test("a replica is invisible to routing, listings, upkeep and scatter even when unavailable (B4)", async (t) => {
  const world = makeWorld();
  let scope = await newScope();
  t.after(() => closeScope(scope));
  let db = await openDatabase(world, scope);
  const tenants = tenantsFor(1);
  await run(seedTenants(db, tenants));
  await replicate(db);
  await following(db);
  assert.deepEqual(await run(db.shards.list), ["shard-0", "shard-1"]);
  await closeScope(scope);
  world.failOpens.set(REPLICA, 1);
  scope = await newScope();
  db = await openDatabase(world, scope);
  assert.equal((await replicaOf(db)).status, "unavailable");
  assert.deepEqual((await run(db.partitions)).sort(), tenants.sort());
  assert.ok(!JSON.stringify(await run(db.maintenance.status)).includes(REPLICA));
  const scatter = await run(db.scatter.findMany({ collection: "posts", tenants, limit: 100 }));
  assert.ok(!JSON.stringify(scatter).includes(REPLICA));
  assert.ok(JSON.stringify(scatter).includes("p1"));
  for (const tenant of tenants) await write(db, tenant, 0);
  assert.ok((await run(readAll(db, tenants))).every((titles) => titles.includes("more-0")));
  assert.ok(!(await run(db.shardPlacement.list)).some((shard) => shard.shardId === REPLICA));
});

test("release requires unreplicate first; second replicas and copies of replicas are refused", async (t) => {
  const world = makeWorld();
  const scope = await newScope();
  t.after(() => closeScope(scope));
  const db = await openDatabase(world, scope);
  await assert.rejects(run(db.shardPlacement.unreplicate({ shardId: PRIMARY })), (error) => error._tag === "ShardOperationInvalid" && /has no replica/.test(error.reason));
  await assert.rejects(run(db.shardPlacement.replicate(input("missing"))), (error) => error._tag === "ShardOperationInvalid" && /not part of this database/.test(error.reason));
  await assert.rejects(run(db.shardPlacement.replicate({ shardId: PRIMARY, resources: { diskBytes: 0 } })), (error) => error._tag === "ShardOperationInvalid" && /positive integer/.test(error.reason));
  await run(db.shardPlacement.place({ virtualRanges: [virtualRangeFor(MAP(), "t")], resources: RESOURCES }));
  await finish(db, "place");
  const shardId = "shard-2";
  await replicate(db, shardId);
  await assert.rejects(run(db.shardPlacement.replicate(input(shardId))), (error) => error._tag === "ShardOperationInvalid" && /already has a replica/.test(error.reason));
  await assert.rejects(run(db.shardPlacement.replicate(input(`${shardId}.replica`))), (error) => error._tag === "ShardOperationInvalid" && /a replica cannot have a replica/.test(error.reason));
  const release = () => run(db.shardPlacement.release({ shardId, into: PRIMARY }));
  await assert.rejects(release(), (error) => error._tag === "ShardOperationInvalid" && /unreplicate it first/.test(error.reason));
  await run(db.shardPlacement.unreplicate({ shardId }));
  await finish(db, "unreplicate");
  await release();
  await finish(db, "release");
});

test("a replica activation refusal retries transient cleanup and releases the reservation", async (t) => {
  const world = makeWorld();
  world.refuseActivate = "wrong-state";
  world.failReleases = 1;
  const scope = await newScope();
  t.after(() => closeScope(scope));
  const db = await openDatabase(world, scope);
  await run(db.shardPlacement.replicate(input()));
  const failed = await waitFor(operationOf(db), finished, "abandoning the replica");
  assert.equal(failed.phase, "failed");
  assert.equal(failed.error, "wrong-state");
  assert.equal(world.calls.filter((call) => call === "release").length, 2);
  assert.equal(world.placements.get(REPLICA).state, "released");
  assert.equal(world.replicas.has(PRIMARY), false);
});

test("replica colocation uses the authenticated caller's Node", async (t) => {
  const world = makeWorld();
  const scope = await newScope();
  t.after(() => closeScope(scope));
  const db = await openDatabase(world, scope);
  await replicate(db);
  const copy = await replicaOf(db);
  assert.equal(copy.colocated, undefined);
  world.callerNodeId = copy.nodeId;
  assert.equal((await replicaOf(db)).colocated, true);
});
