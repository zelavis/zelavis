import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Exit, Fiber } from "effect";
import { shardsOf, virtualRangeFor, COLLECTION_NAMESPACE, equals } from "../dist/db/index.js";
import { partitionKeyFor } from "../dist/db/topology.js";
import { openShardOverKv } from "../dist/db/kv-store.js";

import { httpShardChannel } from "../dist/db/shard-authority-http.js";
import { ShardPlacementRefused, ShardPlacementUnavailable, StoreError } from "../dist/db/errors.js";

import {
  MAP, RESOURCES, prng, makeWorld, openDatabase, newScope, closeScope, run, seedTenants, readAll,
  sleep, waitFor, operationOf, finished,
} from "./_shard-world.mjs";

const cases = (seed) => {
  const random = prng(seed);
  const tenants = Array.from({ length: 6 }, (_, i) => `t${Math.floor(random() * 1e6).toString(36)}${i}`);
  const map = MAP();
  const chosen = [...new Set(tenants.slice(0, 2).map((tenant) => virtualRangeFor(map, tenant)))].sort((a, b) => a - b);
  return { tenants, ranges: chosen };
};

test("place moves two Tenants' ranges onto a remote shard; release gives them back", async () => {
  const world = makeWorld();
  const { tenants, ranges } = cases(1);
  const scope = await newScope();
  const db = await openDatabase(world, scope);
  await run(seedTenants(db, tenants));
  const before = await run(readAll(db, tenants));

  const started = await run(db.shardPlacement.place({ virtualRanges: ranges, resources: RESOURCES }));
  assert.equal(started.phase, "requested");
  assert.equal(started.shardId, "shard-2");
  const done = await waitFor(operationOf(db), finished, "place");
  assert.equal(done.phase, "done", done.error);
  assert.ok(shardsOf(db.topology.current()).includes("shard-2"));
  assert.ok(world.remote.has("shard-2"));
  assert.ok(world.remoteEngines.has("shard-2"));
  assert.deepEqual(await run(readAll(db, tenants)), before);
  const listed = await run(db.shardPlacement.list);
  assert.equal(listed.find((s) => s.shardId === "shard-2").location, "remote");

  const released = await run(db.shardPlacement.release({ shardId: "shard-2", into: "shard-0" }));
  assert.equal(released.kind, "release");
  const gone = await waitFor(operationOf(db), (o) => finished(o) && o.kind === "release", "release");
  assert.equal(gone.phase, "done", gone.error);
  assert.ok(!world.remote.has("shard-2"));
  assert.ok(!shardsOf(db.topology.current()).includes("shard-2"));
  assert.ok(!(await run(db.shards.list)).includes("shard-2"));
  assert.equal(world.placements.get("shard-2").state, "released");
  assert.deepEqual(await run(readAll(db, tenants)), before);
  await closeScope(scope);
});

test("upkeep visits a shard placed after the database opened, and stops visiting it once it is released", async () => {
  const world = makeWorld();
  const { tenants, ranges } = cases(2);
  const scope = await newScope();
  const db = await openDatabase(world, scope);
  await run(seedTenants(db, tenants));
  const shardsSeen = async () => new Set((await run(db.maintenance.status)).map((row) => row.shard));

  assert.ok(!(await shardsSeen()).has("shard-2"));
  await run(db.shardPlacement.place({ virtualRanges: ranges, resources: RESOURCES }));
  assert.equal((await waitFor(operationOf(db), finished, "place")).phase, "done");
  // A Tenant that moved is listed under its new shard: the status is not a list taken when the database opened.
  assert.ok((await shardsSeen()).has("shard-2"), "the shard placed at runtime is part of the upkeep");

  await run(db.shardPlacement.release({ shardId: "shard-2", into: "shard-0" }));
  assert.equal((await waitFor(operationOf(db), (o) => finished(o) && o.kind === "release", "release")).phase, "done");
  assert.ok(!(await shardsSeen()).has("shard-2"), "a released shard is no longer visited");
  await closeScope(scope);
});

test("a remote shard that is not answering at open leaves the other shards serving, and opens when it answers", async () => {
  const world = makeWorld();
  const { tenants, ranges } = cases(3);
  let scope = await newScope();
  let db = await openDatabase(world, scope);
  await run(seedTenants(db, tenants));
  await run(db.shardPlacement.place({ virtualRanges: ranges, resources: RESOURCES }));
  assert.equal((await waitFor(operationOf(db), finished, "place")).phase, "done");
  const map = db.topology.current();
  const away = tenants.filter((tenant) => virtualRangeFor(map, tenant) === ranges[0] || ranges.includes(virtualRangeFor(map, tenant)));
  const here = tenants.filter((tenant) => !away.includes(tenant));
  assert.ok(away.length > 0 && here.length > 0, "some Tenants moved and some did not");
  await closeScope(scope);

  // The Agent does not answer: the database opens anyway.
  world.failOpens.set("shard-2", 1_000_000);
  scope = await newScope();
  db = await openDatabase(world, scope);
  assert.deepEqual(await run(readAll(db, here)), here, "Tenants on the shards that are open are served");
  const refused = await Effect.runPromise(Effect.exit(db.forTenant(away[0]).documents.findMany({ collection: "posts" })));
  assert.ok(Exit.isFailure(refused) && JSON.stringify(refused.cause).includes("not answering"), "a Tenant on the missing shard is refused with the reason");
  for (const question of [db.maintenance.status, db.tenants, db.partitions]) {
    const exit = await Effect.runPromise(Effect.exit(question));
    assert.ok(Exit.isFailure(exit) && JSON.stringify(exit.cause).includes("PartitionUnavailable"), "a question about every shard is refused, not answered for some");
  }
  const listed = await run(db.shardPlacement.list);
  assert.equal(listed.find((shard) => shard.shardId === "shard-2").available, false);
  assert.equal(listed.find((shard) => shard.shardId === "shard-0").available, undefined);

  // It answers again: the loop opens it, and everything is whole.
  world.failOpens.set("shard-2", 0);
  await waitFor(() => run(db.shardPlacement.list), (rows) => rows.find((shard) => shard.shardId === "shard-2").available === true, "the shard to open", 20_000);
  assert.deepEqual(await run(readAll(db, tenants)), tenants);
  assert.ok((await run(db.maintenance.status)).some((row) => row.shard === "shard-2"));
  await closeScope(scope);
});

test("a shard that holds a cross-Tenant index's entries cannot be released until the index is dropped", async () => {
  const world = makeWorld();
  const { tenants, ranges } = cases(4);
  const scope = await newScope();
  const db = await openDatabase(world, scope);
  await run(seedTenants(db, tenants));
  await run(db.shardPlacement.place({ virtualRanges: ranges, resources: RESOURCES }));
  assert.equal((await waitFor(operationOf(db), finished, "place")).phase, "done");

  await run(db.crossTenantIndexes.define({ name: "byTitle", collection: "posts", columns: ["title"], shards: ["shard-2"] }));
  await run(db.crossTenantIndexes.refresh("byTitle"));
  const refused = await Effect.runPromise(Effect.exit(db.shardPlacement.release({ shardId: "shard-2", into: "shard-0" })));
  assert.ok(Exit.isFailure(refused), "the release is refused before anything moves");
  assert.match(JSON.stringify(refused.cause), /cross-Tenant index/);
  assert.ok(shardsOf(db.topology.current()).includes("shard-2"), "routing was not touched");
  assert.ok(world.remote.has("shard-2"));
  assert.ok(await run(readAll(db, tenants)).then((rows) => rows.length === tenants.length));

  await run(db.crossTenantIndexes.drop("byTitle"));
  await run(db.shardPlacement.release({ shardId: "shard-2", into: "shard-0" }));
  assert.equal((await waitFor(operationOf(db), (o) => finished(o) && o.kind === "release", "release")).phase, "done");
  await closeScope(scope);
});

test("a part of a divided Tenant moves onto a remote shard and back, and the other part stays", async () => {
  const world = makeWorld();
  const scope = await newScope();
  const db = await openDatabase(world, scope);
  await run(db.topology.subdivision.subdivide("whale", ["a", "b"]));
  for (const part of ["a", "b"]) {
    const docs = db.forPart("whale", part).documents;
    await run(docs.createCollection({ name: "posts" }));
    await run(docs.insert({ collection: "posts", id: "p1", data: { title: `part ${part}` } }));
  }
  const map = db.topology.current();
  const rangeOf = (part) => virtualRangeFor(map, partitionKeyFor("whale", part));
  assert.notEqual(rangeOf("a"), rangeOf("b"), "the two parts sit on different ranges");
  const titles = (part) => run(db.forPart("whale", part).documents.findMany({ collection: "posts" })).then((rows) => rows.map((row) => row.data.title));

  await run(db.shardPlacement.place({ virtualRanges: [rangeOf("a")], resources: RESOURCES }));
  assert.equal((await waitFor(operationOf(db), finished, "place")).phase, "done");
  assert.deepEqual(await titles("a"), ["part a"]);
  assert.deepEqual(await titles("b"), ["part b"]);
  assert.equal(db.shardOf(partitionKeyFor("whale", "a")), "shard-2", "the part is on the remote shard");
  assert.notEqual(db.shardOf(partitionKeyFor("whale", "b")), "shard-2", "the other part is not");
  await run(db.forPart("whale", "a").documents.insert({ collection: "posts", id: "p2", data: { title: "later" } }));

  await run(db.shardPlacement.release({ shardId: "shard-2", into: "shard-0" }));
  assert.equal((await waitFor(operationOf(db), (o) => finished(o) && o.kind === "release", "release")).phase, "done");
  assert.deepEqual((await titles("a")).sort(), ["later", "part a"]);
  assert.deepEqual(await titles("b"), ["part b"]);
  await closeScope(scope);
});

const PLACE_PHASES = ["requested", "reserved", "activated", "opened", "moving"];
const RELEASE_PHASES = ["moving", "moved", "closed", "released"];

const crashCase = async (seed, kind, phase) => {
  const world = makeWorld();
  const { tenants, ranges } = cases(seed);
  let scope = await newScope();
  let db = await openDatabase(world, scope);
  await run(seedTenants(db, tenants));
  const before = await run(readAll(db, tenants));
  if (kind === "release") {
    await run(db.shardPlacement.place({ virtualRanges: ranges, resources: RESOURCES }));
    await waitFor(operationOf(db), finished, "setup place");
  }
  const hit = new Promise((resolve) => { world.hit = resolve; });
  world.crashAt = phase;
  const action = Effect.runFork(kind === "place"
    ? db.shardPlacement.place({ virtualRanges: ranges, resources: RESOURCES })
    : db.shardPlacement.release({ shardId: "shard-2", into: "shard-0" }));
  await Promise.race([hit, sleep(10_000).then(() => assert.fail(`${kind} never reached ${phase} (seed ${seed})`))]);
  await closeScope(scope);
  await run(Fiber.interrupt(action));

  scope = await newScope();
  db = await openDatabase(world, scope);
  const end = await waitFor(operationOf(db), finished, `${kind} to finish after a crash at ${phase} (seed ${seed})`);
  assert.equal(end.phase, "done", `seed ${seed} ${kind}@${phase}: ${end.error}`);
  assert.deepEqual(await run(readAll(db, tenants)), before, `seed ${seed} ${kind}@${phase}`);
  if (kind === "place") {
    assert.ok(shardsOf(db.topology.current()).includes("shard-2"), `seed ${seed} ${phase}: routed`);
    assert.ok(world.remote.has("shard-2"));
  } else {
    assert.ok(!shardsOf(db.topology.current()).includes("shard-2"), `seed ${seed} ${phase}: back`);
    assert.ok(!world.remote.has("shard-2"));
    assert.equal(world.placements.get("shard-2").state, "released");
  }
  for (const tenant of tenants) {
    await run(db.forTenant(tenant).documents.insert({ collection: "posts", id: "after", data: { title: "after" } }));
  }
  await closeScope(scope);
};

test("a crash at every phase of place and release resumes to the same end (20 seeds)", async () => {
  for (let seed = 1; seed <= (Number(process.env.SEEDS) || 20); seed++) {
    for (const phase of PLACE_PHASES) await crashCase(seed, "place", phase);
    for (const phase of RELEASE_PHASES) await crashCase(seed, "release", phase);
  }
});

test("refusals: no eligible node, activation refused, a second operation, bad input", async () => {
  const world = makeWorld();
  const { tenants, ranges } = cases(3);
  const scope = await newScope();
  const db = await openDatabase(world, scope);
  await run(seedTenants(db, tenants));
  const version = db.topology.current().version;

  world.refuseRequest = "no-eligible-node";
  await run(db.shardPlacement.place({ virtualRanges: ranges, resources: RESOURCES }));
  let end = await waitFor(operationOf(db), finished, "refused request");
  assert.equal(end.phase, "failed");
  assert.match(end.error, /no-eligible-node/);
  assert.equal(db.topology.current().version, version);
  assert.equal(world.remote.size, 0);
  world.refuseRequest = undefined;

  world.refuseActivate = "capacity-exhausted";
  world.calls.length = 0;
  await run(db.shardPlacement.place({ virtualRanges: ranges, resources: RESOURCES }));
  end = await waitFor(operationOf(db), (o) => finished(o) && o.error?.includes("capacity-exhausted"), "refused activation");
  assert.equal(end.phase, "failed");
  assert.ok(world.calls.includes("release"));
  world.refuseActivate = undefined;

  const second = Effect.runPromise(Effect.flip(db.shardPlacement.release({ shardId: "shard-0", into: "shard-1" })));
  assert.equal((await second)._tag, "ShardOperationInvalid");
  const outOfBounds = await run(Effect.flip(db.shardPlacement.place({ virtualRanges: [999], resources: RESOURCES })));
  assert.equal(outOfBounds._tag, "ShardOperationInvalid");

  // One at a time: an operation waiting out an unreachable Platform is still unfinished.
  world.listDown = true;
  const first = await run(db.shardPlacement.place({ virtualRanges: ranges, resources: RESOURCES }));
  await waitFor(operationOf(db), (o) => o?.operationId === first.operationId && o.error !== undefined, "a recorded transient error");
  const busy = await run(Effect.flip(db.shardPlacement.place({ virtualRanges: ranges, resources: RESOURCES })));
  assert.equal(busy._tag, "ShardOperationInProgress");
  world.listDown = false;
  await waitFor(operationOf(db), finished, "the first to finish");
  await closeScope(scope);
});

test("a Platform that no longer shows the shard committed abandons the move and keeps the source", async () => {
  const world = makeWorld();
  const { tenants, ranges } = cases(4);
  const scope = await newScope();
  const db = await openDatabase(world, scope);
  await run(seedTenants(db, tenants));
  const before = await run(readAll(db, tenants));
  const version = db.topology.current().version;
  world.showState = "releasing";

  await run(db.shardPlacement.place({ virtualRanges: ranges, resources: RESOURCES }));
  const end = await waitFor(operationOf(db), finished, "abandon");
  assert.equal(end.phase, "failed");
  assert.match(end.error, /committed/);
  assert.equal(db.topology.current().version, version);
  assert.deepEqual(await run(readAll(db, tenants)), before);
  for (const tenant of tenants) {
    await run(db.forTenant(tenant).documents.insert({ collection: "posts", id: "w", data: { title: "w" } }));
  }
  assert.ok(world.calls.includes("release"));
  assert.equal(world.remote.size, 0);
  assert.ok(!(await run(db.shards.list)).includes("shard-2"));
  await closeScope(scope);
});

test("a shard that fails to open a few times is retried until it opens", async () => {
  const world = makeWorld();
  const { tenants, ranges } = cases(5);
  const scope = await newScope();
  const db = await openDatabase(world, scope);
  await run(seedTenants(db, tenants));
  world.failOpens.set("shard-2", 3);
  await run(db.shardPlacement.place({ virtualRanges: ranges, resources: RESOURCES }));
  let sawError = false;
  const end = await waitFor(operationOf(db), (o) => {
    if (o !== undefined && o.error !== undefined && !finished(o)) sawError = true;
    return finished(o);
  }, "retry");
  assert.equal(end.phase, "done", end.error);
  assert.ok(sawError, "the transient failure was recorded while retrying");
  await closeScope(scope);
});

const entry = (over = {}) => ({
  shardId: "shard-2", role: "primary", operationId: "op-1", state: "committed", nodeId: "node-b", epoch: 1, virtualRanges: [1, 2], ...over,
});

const channelWith = (respond) => {
  const seen = [];
  const channel = httpShardChannel({
    apiRoot: "https://platform.test/zelavis/api/v1/", token: "cap", projectId: "p 1",
    fetch: async (url, init) => {
      seen.push({ url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body), auth: init.headers.authorization });
      const answer = respond(seen.length);
      return new Response(answer.text ?? JSON.stringify(answer.body ?? {}), { status: answer.status });
    },
  });
  return { channel, seen };
};

test("the channel client calls the Project's routes and maps the Platform's answers", async () => {
  const { channel, seen } = channelWith((n) => ({
    status: 200,
    body: [
      { revision: 3, callerNodeId: "node-a", placements: [entry()] },
      { placement: entry({ epoch: 0, state: "reserved" }) },
      { placement: entry() },
      { placement: entry({ state: "released" }) },
      { access: { token: "t", expiresAt: 5, destination: { url: "https://agent", caPem: "pem" } } },
    ][n - 1],
  }));
  const view = await run(channel.list);
  assert.equal(view.revision, 3);
  assert.equal(view.callerNodeId, "node-a");
  assert.deepEqual(view.placements[0].virtualRanges, [1, 2]);
  const request = await run(channel.request({
    intent: "allocate", operationId: "op-1", shardId: "shard-2", virtualRanges: [1, 2], mapVersion: 1, expectedRevision: 3,
    resources: RESOURCES, durability: "crash",
  }));
  assert.equal(request.nodeId, "node-b");
  assert.deepEqual(await run(channel.activate({ shardId: "shard-2", operationId: "op-1" })), { epoch: 1, nodeId: "node-b" });
  await run(channel.release({ shardId: "shard-2", operationId: "op-1" }));
  assert.equal((await run(channel.access("shard-2"))).destination.url, "https://agent");
  assert.deepEqual(seen.map((c) => [c.method, c.url.replace("https://platform.test/zelavis/api/v1/runtime/project-shards/p%201", "")]), [
    ["GET", ""], ["POST", "/requests"], ["POST", "/shard-2/activate"], ["POST", "/shard-2/release"], ["POST", "/shard-2/access"],
  ]);
  assert.ok(seen.every((c) => c.auth === "Bearer cap"));
  assert.equal(seen[1].body.protocolVersion, 1);
  assert.equal(seen[1].body.projectId, "p 1");
  assert.equal(seen[1].body.durability, "crash");
  assert.deepEqual(seen[2].body, { operationId: "op-1" });
});

test("the channel client maps refusals and unreachable answers", async () => {
  const refused = channelWith(() => ({ status: 409, body: { code: "range-conflict" } })).channel;
  const flipped = await run(Effect.flip(refused.activate({ shardId: "s", operationId: "o" })));
  assert.equal(flipped._tag, "ShardPlacementRefused");
  assert.equal(flipped.reason, "range-conflict");
  const down = channelWith(() => ({ status: 503, body: { error: "x" } })).channel;
  assert.equal((await run(Effect.flip(down.activate({ shardId: "s", operationId: "o" }))))._tag, "ShardPlacementUnavailable");
  assert.equal((await run(Effect.flip(down.list)))._tag, "ShardPlacementUnavailable");
  const malformed = channelWith(() => ({ status: 200, text: "not json" })).channel;
  assert.equal((await run(Effect.flip(malformed.list)))._tag, "ShardPlacementUnavailable");
  assert.equal((await run(Effect.flip(malformed.access("s"))))._tag, "StoreError");
});

test("the channel carries replica intent and rejects a ledger entry without a role", async () => {
  const replica = entry({ shardId: "shard-2.replica", role: "replica", of: "shard-2", virtualRanges: [] });
  const { channel, seen } = channelWith((n) => ({
    status: 200,
    body: [{ placement: replica }, { revision: 1, callerNodeId: "node-a", placements: [replica] },
      { revision: 2, callerNodeId: "node-a", placements: [entry({ role: undefined })] }][n - 1],
  }));
  const proposal = {
    intent: "replica", of: replica.of, shardId: replica.shardId, virtualRanges: [], operationId: "op-1",
    mapVersion: 1, expectedRevision: 0, resources: { cpuCores: 0, memoryBytes: 0, diskBytes: 10 }, durability: "crash",
  };
  assert.deepEqual(await run(channel.request(proposal)), { nodeId: replica.nodeId });
  assert.deepEqual(seen[0].body, { ...proposal, protocolVersion: 1, projectId: "p 1" });
  assert.deepEqual((await run(channel.list)).placements, [replica]);
  assert.match((await run(Effect.flip(channel.list))).reason, /malformed ledger/);
});


test("every shard-list consumer sees a shard opened after the database was built", async () => {
  const world = makeWorld();
  const { tenants, ranges } = cases(7);
  const scope = await newScope();
  try {
    const db = await openDatabase(world, scope);
    await run(seedTenants(db, tenants));
    await run(db.topology.placement.declare("plans", "replicated"));
    await run(db.global.documents.createCollection({ name: "plans" }));
    await run(db.global.documents.insert({ collection: "plans", id: "pro", data: { seats: 25 } }));
    const scatter = db.scatter.resolve({ query: equals(COLLECTION_NAMESPACE, "\u0000collection") });
    const refresh = db.replication.refresh;
    await run(db.shardPlacement.place({ virtualRanges: ranges, resources: RESOURCES }));
    assert.equal((await waitFor(operationOf(db), finished, "place")).phase, "done");
    const moved = tenants.find((tenant) => db.shardOf(tenant) === "shard-2");
    assert.ok(moved);
    assert.ok((await run(db.partitions)).includes(moved));
    assert.ok((await run(scatter)).legs.some((leg) => leg.shard === "shard-2"));
    assert.ok((await run(db.maintenance.status)).some((row) => row.shard === "shard-2"));
    assert.ok((await run(refresh)).some((row) => row.shard === "shard-2"));
    assert.equal((await run(db.forTenant(moved).shared.findById({ collection: "plans", id: "pro" }))).data.seats, 25);
  } finally {
    await closeScope(scope);
  }
});

test("a shard that opens late finishes a Tenant removal that was cut off on it", async () => {
  const world = makeWorld();
  const { tenants, ranges } = cases(8);
  let scope = await newScope();
  let db = await openDatabase(world, scope);
  await run(seedTenants(db, tenants));
  await run(db.shardPlacement.place({ virtualRanges: ranges, resources: RESOURCES }));
  assert.equal((await waitFor(operationOf(db), finished, "place")).phase, "done");
  const tenant = tenants.find((name) => db.shardOf(name) === "shard-2");
  assert.ok(tenant);
  await closeScope(scope);

  // Leave the same durable fence that dropTenant writes before removing the partition.
  await run(Effect.scoped(Effect.gen(function* () {
    const shard = yield* openShardOverKv("shard-2", world.remoteEngines.get("shard-2"));
    yield* shard.partition(tenant).fence({ from: "shard-2", to: "removed" });
  })));
  world.failOpens.set("shard-2", 1_000_000);
  scope = await newScope();
  try {
    db = await openDatabase(world, scope);
    const refused = await run(Effect.exit(db.forTenant(tenant).documents.findMany({ collection: "posts" })));
    assert.ok(Exit.isFailure(refused));
    world.failOpens.set("shard-2", 0);
    await waitFor(() => run(db.shardPlacement.list), (rows) => rows.find((row) => row.shardId === "shard-2").available === true, "shard recovery", 20_000);
    await closeScope(scope);
    scope = undefined;
    const partitions = await run(Effect.scoped(Effect.gen(function* () {
      const shard = yield* openShardOverKv("shard-2", world.remoteEngines.get("shard-2"));
      return yield* shard.partitions;
    })));
    assert.ok(!partitions.includes(tenant));
  } finally {
    if (scope !== undefined) await closeScope(scope);
  }
});


test("an unfinished branch waits while its source shard is unavailable", async () => {
  const world = makeWorld();
  const { tenants, ranges } = cases(9);
  let scope = await newScope();
  let db = await openDatabase(world, scope);
  await run(seedTenants(db, tenants));
  await run(db.shardPlacement.place({ virtualRanges: ranges, resources: RESOURCES }));
  assert.equal((await waitFor(operationOf(db), finished, "place")).phase, "done");
  const source = tenants.find((name) => db.shardOf(name) === "shard-2");
  const target = Array.from({ length: 100 }, (_, i) => `branch-target-${i}`).find((name) => db.shardOf(name) !== "shard-2");
  assert.ok(source && target);
  world.cutBranch = { partition: target, writes: 0 };
  assert.ok(Exit.isFailure(await run(Effect.exit(db.branchTenant(source, target)))));
  world.cutBranch = undefined;
  await closeScope(scope);
  world.failOpens.set("shard-2", 1_000_000);
  scope = await newScope();
  try {
    db = await openDatabase(world, scope);
    assert.ok(Exit.isFailure(await run(Effect.exit(db.forTenant(target).documents.findMany({ collection: "posts" })))));
    world.failOpens.set("shard-2", 0);
    await waitFor(() => run(db.shardPlacement.list), (rows) => rows.find((row) => row.shardId === "shard-2").available === true, "source shard recovery", 20_000);
    await waitFor(async () => run(Effect.exit(db.forTenant(target).documents.findMany({ collection: "posts" }))), Exit.isSuccess, "branch recovery", 20_000);
    assert.deepEqual(await run(readAll(db, [target])), [source]);
  } finally {
    await closeScope(scope);
  }
});
