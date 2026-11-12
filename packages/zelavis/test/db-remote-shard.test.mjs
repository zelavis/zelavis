import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Deferred, Effect, Fiber } from "effect";
import { makeDatabase, partitionMapFor } from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";
import { remoteShardAccess } from "../dist/db/engines/remote-kv.js";
import { ReadBudgetExceeded } from "../dist/db/errors.js";
import { openShardOverKv } from "../dist/db/kv-store.js";
import { startRemoteShardAgent } from "./_remote-shard-fixture.mjs";

const remote = await startRemoteShardAgent();
let counter = 0;
/** A shard id on the Agent no earlier test has touched, committed at epoch 1. */
const freshShard = async () => {
  const id = `s1-${counter += 1}`;
  await remote.commit(id, { epoch: 1 });
  return id;
};

const allOn = (shard, version) => ({ version, virtualRanges: 256, placements: [{ from: 0, to: 256, shard }] });

/** A database whose shard `s1` is hosted by the Agent; every other shard (topology and global included) is local. */
const databaseOn = (dir, hosted, engineFor = () => remote.engine(hosted), reads) =>
  makeDatabase({
    partitionMap: partitionMapFor(["s0", "s1"]),
    ...(reads === undefined ? {} : { remoteReads: shard => shard === "s1" ? reads : undefined }),
    openShard: (shard) => shard === "s1"
      ? Effect.flatMap(engineFor(), (engine) => openShardOverKv("s1", engine))
      : makeNodeSqliteStore(shard, dir),
  });

const withDirectory = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-remote-db-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const tenantsNames = ["acme", "bravo", "cosmo", "delta", "echo", "foxtrot"];

const seed = (db, tenants) => Effect.gen(function* () {
  for (const tenant of tenants) {
    const docs = db.forTenant(tenant).documents;
    yield* docs.createCollection({ name: "posts" });
    for (let i = 1; i <= 3; i++) yield* docs.insert({ collection: "posts", id: `p${i}`, data: { title: `${tenant}-${i}` } });
  }
});

const titles = (db, tenant) => Effect.map(
  db.forTenant(tenant).documents.findMany({ collection: "posts" }),
  (found) => found.map((d) => `${d.id}:${d.data.title}`).sort(),
);

/** The Tenant API reports a storage failure as a defect carrying the engine's `StoreError`. */
const storeFailure = (effect) => Effect.map(Effect.exit(effect), (exit) => {
  assert.equal(exit._tag, "Failure", "the operation failed");
  const defect = exit.cause.reasons.find((reason) => reason._tag === "Die")?.defect;
  assert.equal(defect?._tag, "StoreError", JSON.stringify(exit.cause));
  return defect;
});

const expected = (tenant) => [1, 2, 3].map((i) => `p${i}:${tenant}-${i}`);

test("documents written through a database whose shard is remote read back", async (t) => {
  const dir = withDirectory(t);
  const hosted = await freshShard();
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const db = yield* databaseOn(dir, hosted);
    yield* seed(db, tenantsNames);
    assert.ok(tenantsNames.some((name) => db.shardOf(name) === "s1"), "some tenant lives on the remote shard");
    assert.ok(tenantsNames.some((name) => db.shardOf(name) === "s0"), "and some on the local one");
    for (const tenant of tenantsNames) assert.deepEqual(yield* titles(db, tenant), expected(tenant));
  })));
});

test("a rebalance moves tenants onto the remote shard and back", async (t) => {
  const dir = withDirectory(t);
  const hosted = await freshShard();
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const db = yield* databaseOn(dir, hosted);
    yield* seed(db, tenantsNames);
    yield* db.movement.rebalance(allOn("s1", 2));
    assert.deepEqual(yield* db.movement.pending, []);
    for (const tenant of tenantsNames) {
      assert.equal(db.shardOf(tenant), "s1");
      assert.deepEqual(yield* titles(db, tenant), expected(tenant));
    }
    yield* db.movement.rebalance(allOn("s0", 3));
    assert.deepEqual(yield* db.movement.pending, []);
    for (const tenant of tenantsNames) {
      assert.equal(db.shardOf(tenant), "s0");
      assert.deepEqual(yield* titles(db, tenant), expected(tenant));
    }
  })));
});

test("a lost Agent fails writes without applying them, and the data is intact after it restarts", async (t) => {
  const dir = withDirectory(t);
  const onS1 = (db) => tenantsNames.find((name) => db.shardOf(name) === "s1");
  const onS0 = (db) => tenantsNames.find((name) => db.shardOf(name) === "s0");
  const hosted = await freshShard();
  let remoteTenant, localTenant;
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const db = yield* databaseOn(dir, hosted);
    yield* seed(db, tenantsNames);
    remoteTenant = onS1(db);
    localTenant = onS0(db);
    yield* Effect.promise(() => remote.closeAgent());
    const failed = yield* storeFailure(db.forTenant(remoteTenant).documents.insert({ collection: "posts", id: "lost", data: { title: "lost" } }));
    assert.equal(failed._tag, "StoreError", JSON.stringify(failed));
    yield* db.forTenant(localTenant).documents.insert({ collection: "posts", id: "kept", data: { title: "kept" } });
  })));
  await remote.restart();
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const db = yield* databaseOn(dir, hosted);
    assert.deepEqual(yield* titles(db, remoteTenant), expected(remoteTenant), "everything written before the loss is there, the failed write is not");
    assert.deepEqual(yield* titles(db, localTenant), [...expected(localTenant), "kept:kept"].sort());
  })));
});

test("a newer shard epoch is picked up by one renewal, and a token that stays stale fails", async (t) => {
  const dir = withDirectory(t);
  const hosted = await freshShard();
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const db = yield* databaseOn(dir, hosted);
    yield* seed(db, tenantsNames);
    const tenant = tenantsNames.find((name) => db.shardOf(name) === "s1");
    yield* Effect.promise(() => remote.commit(hosted, { epoch: 2 }));
    yield* db.forTenant(tenant).documents.insert({ collection: "posts", id: "p4", data: { title: "after" } });
    assert.ok((yield* titles(db, tenant)).includes("p4:after"));
  })));

  const stuckDir = withDirectory(t);
  const stuck = await freshShard();
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const db = yield* databaseOn(stuckDir, stuck, () => remote.engine(stuck, { renewEpoch: 1 }));
    yield* seed(db, tenantsNames);
    const tenant = tenantsNames.find((name) => db.shardOf(name) === "s1");
    yield* Effect.promise(() => remote.commit(stuck, { epoch: 2 }));
    const failed = yield* storeFailure(db.forTenant(tenant).documents.insert({ collection: "posts", id: "p4", data: { title: "late" } }));
    assert.match(JSON.stringify(failed), /stale-epoch/);
  })));
});

test("the access provider reuses a token for half its life and shares one fetch", async () => {
  let clock = 1_000, fetches = 0;
  const fetchAccess = Effect.sync(() => { fetches += 1; return { token: `t${fetches}`, expiresAt: clock + 100 }; });
  await Effect.runPromise(Effect.gen(function* () {
    const access = yield* remoteShardAccess(fetchAccess, () => clock);
    assert.equal(yield* access.current, "t1");
    clock += 40;
    assert.equal(yield* access.current, "t1");
    assert.equal(fetches, 1);
    clock += 20; // 60 of 100 spent: past the half-life
    assert.equal(yield* access.current, "t2");
    assert.equal(yield* access.renew, "t3");

    const concurrent = yield* remoteShardAccess(fetchAccess, () => clock);
    const before = fetches;
    const tokens = yield* Effect.all(Array.from({ length: 10 }, () => concurrent.current), { concurrency: 10 });
    assert.equal(fetches, before + 1, "ten concurrent callers fetch once");
    assert.equal(new Set(tokens).size, 1);
  }));
});


test("listed reads run on the Agent and writes stay on the writer", async (t) => {
  const dir = withDirectory(t), hosted = await freshShard();
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    let calls = 0;
    const engineFor = () => Effect.map(remote.engine(hosted), engine => ({ ...engine,
      get: key => { calls++; return engine.get(key); }, scan: (prefix, options) => { calls++; return engine.scan(prefix, options); },
      snapshot: Effect.map(engine.snapshot, reader => ({
        get: key => { calls++; return reader.get(key); }, scan: (prefix, options) => { calls++; return reader.scan(prefix, options); },
      })) }));
    const reads = yield* remote.reads(hosted);
    const db = yield* databaseOn(dir, hosted, engineFor, reads);
    const tenant = tenantsNames.find(name => db.shardOf(name) === "s1");
    const api = db.forTenant(tenant);
    yield* api.documents.createCollection({ name: "posts" });
    const beforeWrite = remote.agent.shardReadsServed();
    yield* api.documents.insert({ collection: "posts", id: "a", data: { title: "hi" } });
    assert.equal(remote.agent.shardReadsServed(), beforeWrite);
    for (const effect of [api.documents.findMany({ collection: "posts" }), api.documents.findPage({ collection: "posts" }), api.events.read({}), api.outbox.read({})]) {
      const before = remote.agent.shardReadsServed(); calls = 0;
      yield* effect;
      assert.equal(remote.agent.shardReadsServed(), before + 1);
      assert.equal(calls, 0);
    }
    const before = remote.agent.shardReadsServed(); calls = 0;
    yield* api.kv.namespace("posts").get("a");
    assert.equal(remote.agent.shardReadsServed(), before);
    assert.ok(calls > 0);
  })));
});

test("a move waits for a remote read holding its route lease", async (t) => {
  const dir = withDirectory(t), hosted = await freshShard();
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const actual = yield* remote.reads(hosted);
    const entered = Deferred.makeUnsafe(), release = Deferred.makeUnsafe();
    let pause = false;
    const reads = { run: request => pause ? Effect.gen(function* () {
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(release);
      return yield* actual.run(request);
    }) : actual.run(request) };
    const db = yield* databaseOn(dir, hosted, undefined, reads);
    const tenant = tenantsNames.find(name => db.shardOf(name) === "s1");
    yield* seed(db, [tenant]);
    pause = true;
    const reading = yield* Effect.forkChild(db.forTenant(tenant).documents.findMany({ collection: "posts" }));
    yield* Deferred.await(entered);
    const moving = yield* Effect.forkChild(db.movement.rebalance(allOn("s0", 2)));
    yield* Effect.repeat(Effect.sync(() => db.shardOf(tenant) === "s0"), { while: done => !done, schedule: undefined }).pipe(Effect.timeout("15 seconds"));
    assert.equal(moving.pollUnsafe(), undefined);
    yield* Deferred.succeed(release, undefined);
    assert.equal((yield* Fiber.join(reading)).length, 3);
    yield* Fiber.join(moving);
  })));
});

test("an unreachable Agent fails remote reads without local fallback and recovers", async (t) => {
  const dir = withDirectory(t), hosted = await freshShard();
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const reads = yield* remote.reads(hosted, { timeoutMillis: 1000 });
      const db = yield* databaseOn(dir, hosted, undefined, reads);
      yield* seed(db, tenantsNames);
      const away = tenantsNames.find(name => db.shardOf(name) === "s1");
      const local = tenantsNames.find(name => db.shardOf(name) === "s0");
      yield* Effect.promise(() => remote.closeAgent());
      const failure = yield* storeFailure(db.forTenant(away).documents.findMany({ collection: "posts" }));
      assert.match(failure.op, /^remote-read\./);
      assert.match(String(failure.cause), /s1/);
      assert.equal((yield* db.forTenant(local).documents.findMany({ collection: "posts" })).length, 3);
      yield* Effect.promise(() => remote.restart());
      assert.equal((yield* db.forTenant(away).documents.findMany({ collection: "posts" })).length, 3);
    })));
  } finally { await remote.restart(); }
});

test("scatter query and page legs on the remote shard run on the Agent", async (t) => {
  const dir = withDirectory(t), hosted = await freshShard();
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const reads = yield* remote.reads(hosted);
    const db = yield* databaseOn(dir, hosted, undefined, reads);
    const tenants = [tenantsNames.find(name => db.shardOf(name) === "s0"), tenantsNames.find(name => db.shardOf(name) === "s1")];
    yield* seed(db, tenants);
    let before = remote.agent.shardReadsServed();
    const found = yield* db.scatter.findMany({ collection: "posts", tenants });
    assert.equal(found.rows.length, 6);
    assert.ok(remote.agent.shardReadsServed() > before);
    before = remote.agent.shardReadsServed();
    const page = yield* db.scatter.findPage({ collection: "posts", tenants, limit: 6 });
    assert.equal(page.rows.length, 6);
    assert.ok(remote.agent.shardReadsServed() > before);
  })));
});

test("similarity and hybrid queries stay on the writer", async (t) => {
  const dir = withDirectory(t), hosted = await freshShard();
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    let calls = 0;
    const engineFor = () => Effect.map(remote.engine(hosted), engine => ({ ...engine,
      get: key => { calls++; return engine.get(key); }, scan: (prefix, options) => { calls++; return engine.scan(prefix, options); },
      snapshot: Effect.map(engine.snapshot, reader => ({ get: key => { calls++; return reader.get(key); },
        scan: (prefix, options) => { calls++; return reader.scan(prefix, options); } })) }));
    const reads = yield* remote.reads(hosted);
    const db = yield* databaseOn(dir, hosted, engineFor, reads);
    const tenant = tenantsNames.find(name => db.shardOf(name) === "s1");
    const api = db.forTenant(tenant);
    const embedding = { field: "vec", dimension: 2, metric: "cosine", version: 1 };
    yield* api.documents.createCollection({ name: "vectors", embedding, analyzer: { fields: ["title"], version: 1 } });
    yield* api.documents.insert({ collection: "vectors", id: "a", data: { title: "alpha", vec: [1, 0] } });
    yield* api.documents.insert({ collection: "vectors", id: "b", data: { title: "alpha", vec: [0, 1] } });
    yield* api.documents.rebuildVectorIndex({ collection: "vectors" });
    const index = yield* api.documents.getVectorIndex({ collection: "vectors" });
    index.remove(index.search([1, 0], 1)[0].seq);
    yield* db.topology.placement.declare("plans", "replicated");
    yield* db.global.documents.createCollection({ name: "plans", embedding });
    yield* db.global.documents.insert({ collection: "plans", id: "pro", data: { vec: [1, 0] } });
    yield* db.replication.refresh;
    const vector = { field: "vec", vector: [1, 0], k: 1 };
    const operations = [
      api.documents.findMany({ collection: "vectors", similar: vector }),
      api.documents.findMany({ collection: "vectors", search: "alpha", similar: vector }),
      api.documents.findPage({ collection: "vectors", similar: { ...vector, approximate: false }, limit: 1 }),
      api.shared.findMany({ collection: "plans", similar: vector }),
      api.shared.findPage({ collection: "plans", similar: { ...vector, approximate: false }, limit: 1 }),
    ];
    for (const [i, operation] of operations.entries()) {
      const before = remote.agent.shardReadsServed(); calls = 0;
      const result = yield* operation;
      if (i === 0) assert.deepEqual(result.map(doc => doc.id), ["b"], "the writer-owned index decides the result");
      assert.equal(remote.agent.shardReadsServed(), before);
      assert.ok(calls > 0);
    }
    const before = remote.agent.shardReadsServed();
    yield* api.shared.findMany({ collection: "plans" });
    yield* api.shared.findPage({ collection: "plans" });
    assert.equal(remote.agent.shardReadsServed(), before + 2);
  })));
});

test("a read past the Agent's work budget dies as itself, is not an unavailable shard, and is never retried on the writer", async (t) => {
  const dir = withDirectory(t);
  const limited = await startRemoteShardAgent({ shards: { readLimits: { entries: 150 } } });
  const id = "s1-budget";
  await limited.commit(id, { epoch: 1 });
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    let calls = 0;
    const engineFor = () => Effect.map(limited.engine(id), engine => ({ ...engine,
      get: key => { calls++; return engine.get(key); }, scan: (prefix, options) => { calls++; return engine.scan(prefix, options); },
      snapshot: Effect.map(engine.snapshot, reader => ({ get: key => { calls++; return reader.get(key); },
        scan: (prefix, options) => { calls++; return reader.scan(prefix, options); } })) }));
    const reads = yield* limited.reads(id);
    const db = yield* databaseOn(dir, id, engineFor, reads);
    const tenant = tenantsNames.find(name => db.shardOf(name) === "s1");
    const local = tenantsNames.find(name => db.shardOf(name) === "s0");
    const api = db.forTenant(tenant);
    yield* api.documents.createCollection({ name: "posts" });
    for (let from = 0; from < 300; from += 100) {
      yield* api.documents.write({ operations: Array.from({ length: 100 }, (_, i) => ({ _tag: "Insert", collection: "posts", id: `p${from + i}`, data: { title: `post ${from + i}` } })) });
    }
    const before = limited.agent.shardReadsServed(); calls = 0;
    const exit = yield* Effect.exit(api.documents.findMany({ collection: "posts" }));
    assert.equal(exit._tag, "Failure");
    const defect = exit.cause.reasons.find(reason => reason._tag === "Die")?.defect;
    assert.ok(defect instanceof ReadBudgetExceeded, `a defect naming the budget, not a store failure: ${String(defect)}`);
    assert.equal(defect.limit, "entries");
    assert.equal(defect.max, 150);
    assert.equal(limited.agent.shardReadsServed(), before + 1, "the Agent answered it");
    assert.equal(calls, 0, "nothing was read on the writer instead");
    // The Agent is fine: a read that fits is answered there, and a Tenant on the writer's own shard is untouched.
    assert.equal((yield* api.documents.findById({ collection: "posts", id: "p7" })).id, "p7");
    assert.equal(calls, 0);
    yield* seed(db, [local]);
    assert.equal((yield* db.forTenant(local).documents.findMany({ collection: "posts" })).length, 3);
  })));
});
