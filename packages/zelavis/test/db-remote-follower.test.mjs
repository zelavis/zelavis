// A follower on another host: it reads its leader through the leader transport — the leader's follower routes,
// reached with the SDK — and is held to the same answers as a follower in the leader's process. These tests seed
// and carry a follower on over the routes, carry a compacted cursor back as the error a follower re-seeds on, take a
// hold on the leader's own placement and keep it across a move, wait on remote acknowledgments, read the change
// feed, wake a cross-Tenant index from it, and do the whole of it once more with the leader in a process of its own.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { Effect, Fiber, Queue, Stream } from "effect";
import {
  levelFollower, makeDatabase, partitionMapFor, remoteAcknowledgments, remoteChanges, remoteLeader, shardFor, writeAcknowledged,
} from "../dist/db/index.js";
import { makeMemoryStore, memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { openShardOverKv } from "../dist/db/kv-store.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { openTemporaryDatabase, temporaryDatabaseDirectory } from "./_database.mjs";
import { leaderFetch } from "./fixtures/leader-routes.mjs";

const run = (effect) => Effect.runPromise(Effect.scoped(effect));
const transportOf = (fetch, baseUrl = "http://zv.test") => createZelavisClient({ baseUrl, rootPath: "/zelavis", fetch }).followers("p1");
const allOn = (shard, version) => ({ version, virtualRanges: 256, placements: [{ from: 0, to: 256, shard }] });

const posts = async (api, tenant, from, to) => {
  const docs = api.forTenant(tenant).documents;
  if (!(await docs.collectionExists("posts"))) await docs.createCollection({ name: "posts", columns: ["rank"] });
  for (let at = from; at <= to; at++) await docs.insert({ collection: "posts", id: `p${at}`, data: { rank: at } });
};
const idsOf = async (api, tenant) => {
  const docs = api.forTenant(tenant).documents;
  if (!(await docs.collectionExists("posts"))) return [];
  return (await docs.findMany({ collection: "posts" })).map((doc) => `${doc.id}@${doc.version}`).sort();
};
const until = async (what, check, millis = 10_000) => {
  const deadline = Date.now() + millis;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
/** Every record as stored and the log's head: equal for a level follower. */
const recordsOf = (store) => Effect.gen(function* () {
  const rows = [];
  let after;
  for (;;) {
    const page = yield* store.scanRecords({ ...(after === undefined ? {} : { after }), limit: 100 });
    for (const { seq, record } of page) rows.push(`${seq}:${record.live}:${record.version}`);
    if (page.length < 100) break;
    after = page[page.length - 1].seq;
  }
  return { rows, head: (yield* store.stats).head };
});

test("a follower on another host seeds, carries on and acknowledges through the leader transport", async (t) => {
  const leader = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  const follower = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  await posts(leader.api, "acme", 1, 30);
  const transport = transportOf(leaderFetch(leader.api));

  const loop = Effect.runFork(follower.database.followers.follow(remoteLeader(transport, "acme"), {
    partition: "acme",
    interval: "20 millis",
    acknowledgments: { name: "replica-b", to: remoteAcknowledgments(transport, "acme") },
  }));
  t.after(() => Effect.runPromise(Fiber.interrupt(loop)));

  await until("the copy", async () => (await idsOf(follower.api, "acme")).length === 30);
  assert.deepEqual(await idsOf(follower.api, "acme"), await idsOf(leader.api, "acme"));

  // A write the leader runs waiting for one follower: it returns once the remote follower has applied it and said so.
  const source = await Effect.runPromise(leader.database.followers.source("acme"));
  const acknowledgments = await Effect.runPromise(leader.database.followers.acknowledgments("acme"));
  const written = await Effect.runPromise(writeAcknowledged(source, acknowledgments,
    leader.database.forTenant("acme").documents.insert({ collection: "posts", id: "p31", data: { rank: 31 } }),
    { followers: 1, timeout: "10 seconds" }));
  assert.deepEqual(written.acknowledgedBy, ["replica-b"]);
  assert.deepEqual(await idsOf(follower.api, "acme"), await idsOf(leader.api, "acme"));

  const reported = await transport.acknowledgments("acme");
  assert.equal(reported.followers[0].name, "replica-b");
  assert.ok(reported.followers[0].position >= written.position);

  // Bad requests are refused as requests, not failures of the leader.
  await assert.rejects(transport.stats("zv.global"), (error) => error.status === 400);
  await assert.rejects(transport.records("acme", { limit: 0 }), (error) => error.status === 400);
  await assert.rejects(transport.acknowledge("acme", { follower: "", position: 1 }), (error) => error.status === 400);
});

test("a follower the leader compacted past gets the compacted cursor back over the transport, and is copied again", async (t) => {
  const leader = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  await posts(leader.api, "acme", 1, 10);
  const remote = remoteLeader(transportOf(leaderFetch(leader.api)), "acme");
  await run(Effect.gen(function* () {
    const shard = yield* makeMemoryStore("replica");
    const copy = () => shard.partition("acme");
    const first = yield* levelFollower(remote, { shard, partition: "acme" });
    assert.equal(first.seed, "empty");

    const source = yield* leader.database.followers.source("acme");
    for (let at = 1; at <= 10; at++) {
      yield* leader.database.forTenant("acme").documents.update({ collection: "posts", id: `p${at}`, data: { rank: at * 10 } });
    }
    yield* source.compact({ keep: 0 });
    const second = yield* levelFollower(remote, { shard, partition: "acme" });
    assert.equal(second.seed, "compacted", "the leader's CursorCompacted reached the follower as itself");
    assert.deepEqual(yield* recordsOf(copy()), yield* recordsOf(source));

    // A leader that has not compacted carries the follower on.
    yield* leader.database.forTenant("acme").documents.insert({ collection: "posts", id: "p11", data: { rank: 11 } });
    const third = yield* levelFollower(remote, { shard, partition: "acme" });
    assert.equal(third.seed, undefined);
    assert.equal(third.applied, 1);
    assert.deepEqual(yield* recordsOf(copy()), yield* recordsOf(source));
  }));
});

test("a remote hold is taken on the leader's own placement and moves with the partition", async () => {
  await run(Effect.gen(function* () {
    const db = yield* makeDatabase({
      partitionMap: partitionMapFor(["s0", "s1"]),
      crossTenantRefresh: false,
      openShard: (shard) => openShardOverKv(shard, memoryKvEngine()),
    });
    const { runtimeApiFor } = yield* Effect.promise(() => import("../dist/db/runtime-api.js"));
    const api = runtimeApiFor(db);
    yield* Effect.promise(() => posts(api, "acme", 1, 20));
    const remote = remoteLeader(transportOf(leaderFetch(api)), "acme");
    const routed = yield* db.followers.source("acme");

    const held = yield* remote.holdLog({ id: "replica-b", position: 0, ttlMillis: 60_000 });
    assert.equal(held.position, 0);
    yield* Effect.promise(() => posts(api, "acme", 21, 30));
    assert.notEqual((yield* routed.compact({ keep: 0 })).heldAt, undefined, "the leader's compaction stops at the remote hold");

    const from = db.shardOf("acme");
    const to = from === "s0" ? "s1" : "s0";
    yield* db.movement.rebalance(allOn(to, 2));
    assert.equal(db.shardOf("acme"), to);
    assert.deepEqual((yield* routed.heldLogs).map((hold) => hold.id), ["replica-b"], "the move carried the hold to the target");
    yield* Effect.promise(() => posts(api, "acme", 31, 35));
    assert.notEqual((yield* routed.compact({ keep: 0 })).heldAt, undefined, "and the target's compaction stops at it");

    yield* remote.releaseLog("replica-b");
    assert.equal((yield* routed.compact({ keep: 0 })).heldAt, undefined, "released, nothing holds the log");
    // A hold below what was compacted is refused as the error a follower acts on.
    const refused = yield* Effect.flip(remote.holdLog({ id: "late", position: 0, ttlMillis: 1000 }));
    assert.equal(refused._tag, "LogCompacted");
  }));
});

test("the change feed names what moved, waits for a write, and is refused for a reserved partition", async (t) => {
  const leader = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  await posts(leader.api, "acme", 1, 3);
  await posts(leader.api, "beta", 1, 2);
  const transport = transportOf(leaderFetch(leader.api));

  const everything = await transport.changes({});
  assert.deepEqual(Object.keys(everything.heads).sort(), ["acme", "beta"]);
  assert.equal(everything.more, false);
  assert.deepEqual(Object.keys((await transport.changes({ partitions: ["acme"] })).heads), ["acme"]);

  const nothing = await transport.changes({ heads: everything.heads, timeoutMillis: 50 });
  assert.deepEqual(nothing.heads, {}, "nothing moved within the wait");

  const started = Date.now();
  const waiting = transport.changes({ heads: everything.heads, timeoutMillis: 10_000 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await posts(leader.api, "beta", 3, 3);
  const moved = await waiting;
  assert.deepEqual(Object.keys(moved.heads), ["beta"]);
  assert.ok(moved.heads.beta > everything.heads.beta);
  assert.ok(Date.now() - started < 5_000, "answered on the write, not at the end of the wait");

  await assert.rejects(transport.changes({ partitions: ["zv.global"] }), (error) => error.status === 400);
  await assert.rejects(transport.changes({ timeoutMillis: 120_000 }), (error) => error.status === 400);

  // As a stream: every partition first, then each that moves.
  const seen = await run(Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(remoteChanges(transport, { timeout: "5 seconds" }), 3)));
    yield* Effect.sleep("100 millis");
    yield* Effect.promise(() => posts(leader.api, "gamma", 1, 1));
    return yield* Fiber.join(fiber);
  }));
  assert.deepEqual([...seen].slice(0, 2).sort(), ["acme", "beta"]);
  assert.equal([...seen][2], "gamma");
});

test("a cross-Tenant index on a follower's database reads a leader's write when the follow loop wakes, not at its sweep", async (t) => {
  const leader = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  const follower = await openTemporaryDatabase(t, { crossTenantRefresh: { sweepInterval: "1 hour", debounce: "10 millis" } });
  await posts(leader.api, "acme", 1, 5);
  await follower.api.crossTenantIndexes.define({ name: "posts", collection: "posts", columns: ["rank"] });
  const transport = transportOf(leaderFetch(leader.api));

  // No polling interval to speak of: only the leader's change feed wakes the loop.
  const loop = Effect.runFork(follower.database.followers.follow(remoteLeader(transport, "acme"), {
    partition: "acme",
    interval: "1 hour",
    wakeups: remoteChanges(transport, { partitions: ["acme"], timeout: "5 seconds" }),
  }));
  t.after(() => Effect.runPromise(Fiber.interrupt(loop)));

  const indexed = async () => (await follower.api.crossTenantIndexes.query({ index: "posts", limit: 100 })).matches.map((match) => match.id).sort();
  await until("the index to hold the copy", async () => (await indexed()).length === 5);
  await posts(leader.api, "acme", 6, 6);
  await until("the index to hold the leader's new post", async () => (await indexed()).includes("p6"), 5_000);
});

test("a notification refreshes a cross-Tenant index for a write it did not see itself", async () => {
  await run(Effect.gen(function* () {
    const map = partitionMapFor(["s0", "s1"]);
    const stores = new Map();
    const notifications = yield* Queue.unbounded();
    const replica = yield* makeDatabase({
      partitionMap: map,
      crossTenantRefresh: { sweepInterval: "1 hour", debounce: "10 millis", notifications: Stream.fromQueue(notifications) },
      openShard: (shard) => Effect.tap(openShardOverKv(shard, memoryKvEngine()), (store) => Effect.sync(() => stores.set(shard, store))),
    });
    yield* replica.crossTenantIndexes.define({ name: "posts", collection: "posts", columns: ["rank"] });
    // Defining it runs a full pass; let that finish before anything is copied.
    yield* Effect.sleep("150 millis");

    // The leader's partition, copied into the replica's shard under the replica's database: nothing in the
    // replica's process wrote it, so nothing there tells its index.
    const source = yield* makeDatabase({
      partitionMap: map,
      crossTenantRefresh: false,
      openShard: (shard) => openShardOverKv(shard, memoryKvEngine()),
    });
    const { runtimeApiFor } = yield* Effect.promise(() => import("../dist/db/runtime-api.js"));
    yield* Effect.promise(() => posts(runtimeApiFor(source), "acme", 1, 4));
    yield* levelFollower(yield* source.followers.source("acme"), { shard: stores.get(shardFor(map, "acme")), partition: "acme" });

    const indexed = Effect.map(replica.crossTenantIndexes.query({ index: "posts", limit: 100 }), (page) => page.matches.length);
    yield* Effect.sleep("150 millis");
    assert.equal(yield* indexed, 0, "without a notification the index waits for its sweep");
    yield* Queue.offer(notifications, "acme");
    for (let tries = 0; (yield* indexed) < 4; tries++) {
      assert.ok(tries < 200, "the notification refreshed the index");
      yield* Effect.sleep("25 millis");
    }
  }));
});

test("a follower in one process follows a leader in another over HTTP", async (t) => {
  const child = spawn(process.execPath, [new URL("./fixtures/leader-server.mjs", import.meta.url).pathname, temporaryDatabaseDirectory(t)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => child.kill("SIGTERM"));
  let output = "";
  child.stdout.setEncoding("utf8");
  while (!/listening (\d+)/.test(output)) {
    const [chunk] = await once(child.stdout, "data");
    output += chunk;
  }
  const base = `http://127.0.0.1:${/listening (\d+)/.exec(output)[1]}`;
  const transport = transportOf(globalThis.fetch, base);
  const write = (id, rank) => fetch(`${base}/write`, { method: "POST", body: JSON.stringify({ tenant: "acme", id, rank }) }).then((response) => response.json());

  const follower = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  const loop = Effect.runFork(follower.database.followers.follow(remoteLeader(transport, "acme"), {
    partition: "acme",
    interval: "1 hour",
    wakeups: remoteChanges(transport, { partitions: ["acme"], timeout: "5 seconds" }),
    acknowledgments: { name: "other-process", to: remoteAcknowledgments(transport, "acme") },
  }));
  t.after(() => Effect.runPromise(Fiber.interrupt(loop)));

  await until("the copy across processes", async () => (await idsOf(follower.api, "acme")).length === 40);
  await write("p41", 41);
  await until("the leader's write to arrive", async () => (await idsOf(follower.api, "acme")).includes("p41@1"), 5_000);
  const stats = await transport.stats("acme");
  await until("the follower's acknowledgment", async () => {
    const reported = await transport.acknowledgments("acme");
    return reported.followers.some((entry) => entry.name === "other-process" && entry.position === stats.head);
  });
});
