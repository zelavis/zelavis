import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { documentsFor } from "../dist/db/documents.js";
import { openShardOverKv } from "../dist/db/kv-store.js";
import { startRemoteShardAgent } from "./_remote-shard-fixture.mjs";

const fixture = await startRemoteShardAgent();
const path = "/v1/shards/reads";
const request = (access, op = "documents.findMany", input = { collection: "notes" }, routedBy = 1) =>
  ({ protocol: 1, access, partition: "t", routedBy, op, input });

const seed = (name) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const writer = yield* openShardOverKv(name, yield* fixture.engine(name));
  const docs = documentsFor(writer.partition("t"), "t");
  yield* docs.createCollection({ name: "notes" });
  yield* docs.insert({ collection: "notes", id: "a", data: { title: "hello" } });
  return { writer, expected: yield* docs.findMany({ collection: "notes" }) };
})));

test("a remote read answers from the shard under its grant", async () => {
  await fixture.commit("read");
  const { expected } = await seed("read");
  const access = (await fixture.access("read")).token;
  const before = fixture.agent.shardReadsServed();
  const answer = await fixture.post(path, request(access));
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.value, JSON.parse(JSON.stringify(expected)));
  assert.equal(fixture.agent.shardReadsServed(), before + 1);
  for (const op of ["documents.findMany", "documents.findPage", "shared.findMany", "shared.findPage"]) {
    assert.deepEqual(await fixture.post(path, request(access, op, { collection: "notes", similar: null })), { status: 400, body: { code: "invalid-request" } });
  }
  assert.equal(fixture.agent.shardReadsServed(), before + 1);
});

test("a remote read refuses stale, foreign and malformed requests", async () => {
  await fixture.commit("auth");
  await seed("auth");
  const old = (await fixture.access("auth")).token;
  await fixture.commit("auth", { epoch: 2 });
  assert.deepEqual(await fixture.post(path, request(old)), { status: 409, body: { code: "stale-epoch" } });
  assert.equal((await fixture.post(path, request("garbage"))).status, 401);
  const access = (await fixture.access("auth")).token;
  assert.equal((await fixture.post(path, request(access, "bad"))).status, 400);
  assert.equal((await fixture.post(path, { ...request(access), partition: "zv.topology" })).status, 400);
});

test("a remote read carries the routing version", async () => {
  await fixture.commit("move");
  const { writer } = await seed("move");
  await Effect.runPromise(writer.relocate("t", 5));
  const access = (await fixture.access("move")).token;
  const stale = await fixture.post(path, request(access, "documents.listCollections", null, 4));
  assert.equal(stale.status, 200);
  const carried = stale.body.failure ?? stale.body.defect;
  assert.equal(carried._tag, "TenantRelocated");
  assert.equal(carried.mapVersion, 5);
  assert.equal(carried.routedBy, 4);
  const current = await fixture.post(path, request(access, "documents.listCollections", null, 5));
  assert.equal(current.status, 200);
  assert.deepEqual(current.body.value, []);
});

test("remote read concurrency, deadlines and answers are bounded", async () => {
  for (const [limits, expected] of [
    [{ readsPerShard: 0, readPermitWaitMillis: 5 }, "busy"],
    [{ readDeadlineMillis: 0 }, "deadline"],
    [{ maxReadAnswerBytes: 10 }, "answer-too-large"],
  ]) {
    const other = await startRemoteShardAgent({ shards: limits });
    await other.commit("bounded");
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const writer = yield* openShardOverKv("bounded", yield* other.engine("bounded"));
      yield* documentsFor(writer.partition("t"), "t").createCollection({ name: "notes" });
    })));
    const access = (await other.access("bounded")).token;
    const result = await other.post(path, request(access, "documents.listCollections", null));
    assert.equal(result.body.code, expected);
  }
});

test("grant changes drain active snapshots and queued reads recheck their epoch", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { Deferred } = await import("effect");
  const { createMemorySystemStore } = await import("../dist/index.js");
  const { createRemoteShardHost } = await import("../dist/adapters/_remote-shard-host.js");
  const { appShardKey, signAppShardGrant, signAppShardAccess } = await import("../dist/core/agent/app-shard-grant.js");
  const { memoryKvEngine } = await import("../dist/db/engines/memory-kv.js");
  const root = await mkdtemp(join(tmpdir(), "zv-read-gate-"));
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const now = Date.now();
  const trust = { keys: [{ keyId: "platform-test", publicKey: Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64"),
    notBefore: new Date(now - 60_000).toISOString(), notAfter: new Date(now + 600_000).toISOString() }] };
  const engines = new Map([["a", memoryKvEngine()], ["b", memoryKvEngine()]]);
  const ready = Deferred.makeUnsafe(), release = Deferred.makeUnsafe();
  let gateSnapshots = false, watching = false;
  const observed = Deferred.makeUnsafe();
  const underlying = createMemorySystemStore();
  const store = { ...underlying, get(namespace, key) {
    const value = underlying.get(namespace, key);
    if (watching && key === appShardKey("p", "i", "b")) Effect.runSync(Deferred.succeed(observed, undefined));
    return value;
  } };
  const host = createRemoteShardHost({ dataDirectory: root, store, trust: () => trust, agentId: "agent-b", nodeId: "node-b",
    readsPerAgent: 1, readsPerShard: 1, readPermitWaitMillis: 10_000,
    openEngine: shard => {
      const engine = engines.get(shard);
      return Effect.succeed({ ...engine, snapshot: Effect.suspend(() => gateSnapshots && shard === "a"
        ? Effect.andThen(Deferred.succeed(ready, undefined), Effect.andThen(Deferred.await(release), engine.snapshot)) : engine.snapshot) });
    },
  });
  t.after(async () => { Effect.runSync(Deferred.succeed(release, undefined)); await host.close(); await rm(root, { recursive: true, force: true }); });
  const identity = shardId => ({ keyId: "platform-test", agentId: "agent-b", nodeId: "node-b", projectId: "p", incarnation: "i", shardId });
  const grant = (shardId, epoch, state) => signAppShardGrant(privateKey, { ...identity(shardId), epoch, state, durability: "crash", issuedAt: Date.now(), expiresAt: Date.now() + 30_000 });
  const access = (shardId, epoch) => signAppShardAccess(privateKey, { ...identity(shardId), epoch, issuedAt: Date.now(), expiresAt: Date.now() + 60_000 });
  for (const shardId of ["a", "b"]) {
    await host.applyGrant(await grant(shardId, 1, "preparing"));
    await host.applyGrant(await grant(shardId, 1, "committed"));
    await Effect.runPromise(openShardOverKv(shardId, engines.get(shardId)));
  }
  const a = await access("a", 1), b = await access("b", 1);
  gateSnapshots = true;
  const active = host.reads(request(a, "documents.listCollections", null));
  await Effect.runPromise(Deferred.await(ready));
  watching = true;
  const queued = host.reads(request(b, "documents.listCollections", null));
  await Effect.runPromise(Deferred.await(observed));
  watching = false;
  await host.applyGrant(await grant("b", 2, "committed"));
  const releaseGrant = host.applyGrant(await grant("a", 1, "released"));
  await Effect.runPromise(Deferred.succeed(release, undefined));
  assert.equal((await active).status, 200);
  assert.deepEqual(await queued, { status: 409, body: { code: "stale-epoch" } });
  assert.equal((await releaseGrant).state, "released");

  // A grant needing both shard slots gets a turn before later one-slot reads.
  const raw = memoryKvEngine();
  const entered = [Deferred.makeUnsafe(), Deferred.makeUnsafe()];
  const gates = [Deferred.makeUnsafe(), Deferred.makeUnsafe()];
  let snapshots = 0;
  const host2 = createRemoteShardHost({ dataDirectory: join(root, "priority"), store: createMemorySystemStore(), trust: () => trust,
    agentId: "agent-b", nodeId: "node-b", readsPerAgent: 3, readsPerShard: 2, readPermitWaitMillis: 50,
    openEngine: () => Effect.succeed({ ...raw, snapshot: Effect.suspend(() => {
      const index = snapshots++;
      return index < 2 ? Effect.andThen(Deferred.succeed(entered[index], undefined), Effect.andThen(Deferred.await(gates[index]), raw.snapshot)) : raw.snapshot;
    }) }),
  });
  t.after(async () => {
    for (const gate of gates) Effect.runSync(Deferred.succeed(gate, undefined));
    await host2.close();
  });
  await host2.applyGrant(await grant("c", 1, "preparing"));
  await host2.applyGrant(await grant("c", 1, "committed"));
  await Effect.runPromise(openShardOverKv("c", raw));
  const c = await access("c", 1), revoke = await grant("c", 1, "released");
  const first = host2.reads(request(c, "documents.listCollections", null));
  await Effect.runPromise(Deferred.await(entered[0]));
  const second = host2.reads(request(c, "documents.listCollections", null));
  await Effect.runPromise(Deferred.await(entered[1]));
  const changing = host2.applyGrant(revoke);
  await Effect.runPromise(Deferred.succeed(gates[0], undefined));
  assert.equal((await first).status, 200);
  // One slot is free while the second snapshot is held. Once the grant has reached the turnstile,
  // an otherwise admissible read is refused as busy: the observable condition, not a fixed wait.
  let probe;
  for (let attempt = 0; attempt < 512; attempt++) {
    probe = await host2.reads(request(c, "documents.listCollections", null));
    if (probe.body.code === "busy") break;
    assert.equal(probe.status, 200, "the grant cannot release while the second snapshot is held");
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(probe.body.code, "busy", "the pending grant blocks later readers");
  const atBusy = snapshots;
  assert.equal((await host2.reads(request(c, "documents.listCollections", null))).body.code, "busy");
  assert.equal(snapshots, atBusy, "no later reader takes a snapshot after the grant is pending");
  const stillCommitted = await host2.kv({ access: c, op: "get", key: Buffer.from("probe").toString("base64url") });
  assert.equal(stillCommitted.status, 200, "the grant has not closed the shard with a snapshot in flight");
  await Effect.runPromise(Deferred.succeed(gates[1], undefined));
  assert.equal((await second).status, 200);
  assert.equal((await changing).state, "released");
  assert.deepEqual(await host2.reads(request(c, "documents.listCollections", null)), { status: 409, body: { code: "not-committed" } });

  // A token that expires while queued is refused before the shard is opened for its read.
  let clock = Date.now(), watchExpiry = false;
  const expiryObserved = Deferred.makeUnsafe(), expiryEntered = Deferred.makeUnsafe(), expiryRelease = Deferred.makeUnsafe();
  const expiryEngines = new Map([["d", memoryKvEngine()], ["e", memoryKvEngine()]]);
  const expiryBase = createMemorySystemStore();
  const expiryStore = { ...expiryBase, get(namespace, key) {
    const value = expiryBase.get(namespace, key);
    if (watchExpiry && key === appShardKey("p", "i", "e")) Effect.runSync(Deferred.succeed(expiryObserved, undefined));
    return value;
  } };
  const host3 = createRemoteShardHost({ dataDirectory: join(root, "expiry"), store: expiryStore, trust: () => trust,
    agentId: "agent-b", nodeId: "node-b", now: () => clock, readsPerAgent: 1, readPermitWaitMillis: 10_000,
    openEngine: shardId => {
      const engine = expiryEngines.get(shardId);
      return Effect.succeed({ ...engine, snapshot: shardId === "d" ? Effect.andThen(Deferred.succeed(expiryEntered, undefined),
        Effect.andThen(Deferred.await(expiryRelease), engine.snapshot)) : engine.snapshot });
    },
  });
  t.after(async () => { Effect.runSync(Deferred.succeed(expiryRelease, undefined)); await host3.close(); });
  for (const shardId of ["d", "e"]) {
    await host3.applyGrant(await grant(shardId, 1, "preparing"));
    await host3.applyGrant(await grant(shardId, 1, "committed"));
    await Effect.runPromise(openShardOverKv(shardId, expiryEngines.get(shardId)));
  }
  const d = await access("d", 1);
  const expiring = await signAppShardAccess(privateKey, { ...identity("e"), epoch: 1, issuedAt: clock, expiresAt: clock + 1000 });
  const blocked = host3.reads(request(d, "documents.listCollections", null));
  await Effect.runPromise(Deferred.await(expiryEntered));
  watchExpiry = true;
  const expiredRead = host3.reads(request(expiring, "documents.listCollections", null));
  await Effect.runPromise(Deferred.await(expiryObserved));
  watchExpiry = false;
  clock += 1001;
  await Effect.runPromise(Deferred.succeed(expiryRelease, undefined));
  assert.equal((await blocked).status, 200);
  assert.deepEqual(await expiredRead, { status: 401, body: { code: "unauthorized" } });
});

const MiB = 1024 * 1024;

/** One shard with `count` small notes on a fresh Agent whose reads are held to `shards`. */
const budgeted = async (shards, { count = 400, huge } = {}) => {
  const agent = await startRemoteShardAgent({ shards });
  await agent.commit("budget");
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const writer = yield* openShardOverKv("budget", yield* agent.engine("budget"));
    const docs = documentsFor(writer.partition("t"), "t");
    // Only the title is indexed, so a large body is stored twice (record and event) and nowhere else.
    yield* docs.createCollection({ name: "notes", columns: ["title"] });
    yield* docs.insert({ collection: "notes", id: "a", data: { title: "hello" } });
    for (let from = 0; from < count; from += 200) {
      yield* docs.write({ operations: Array.from({ length: Math.min(200, count - from) }, (_, i) => ({ _tag: "Insert", collection: "notes", id: `n${from + i}`, data: { title: `note ${from + i}` } })) });
    }
    if (huge !== undefined) yield* docs.insert({ collection: "notes", id: "huge", data: { body: "z".repeat(huge) } });
  })));
  return agent;
};

test("a remote read past its work budget is refused whole, as itself, and leaves the Agent usable", async () => {
  const agent = await budgeted({ readLimits: { entries: 300 }, readsPerShard: 2, readsPerAgent: 2, readPermitWaitMillis: 30_000 });
  const token = async () => (await agent.access("budget")).token;
  const refused = await agent.post(path, request(await token(), "documents.findMany", { collection: "notes" }));
  assert.equal(refused.status, 200);
  assert.deepEqual(refused.body, { defect: { _tag: "ReadBudgetExceeded", limit: "entries", max: 300 } });
  const small = await agent.post(path, request(await token(), "documents.findById", { collection: "notes", id: "a" }));
  assert.equal(small.body.value.id, "a", "a read that fits is answered, after one that did not");
  // Reads running together each spend their own budget.
  const access = await token();
  const together = await Promise.all(Array.from({ length: 12 }, (_, at) => agent.post(path, at % 2 === 0
    ? request(access, "documents.findMany", { collection: "notes" }) : request(access, "documents.findById", { collection: "notes", id: "a" }))));
  together.forEach((answer, at) => {
    assert.equal(answer.status, 200);
    if (at % 2 === 0) assert.equal(answer.body.defect?._tag, "ReadBudgetExceeded", `read ${at}`);
    else assert.equal(answer.body.value?.id, "a", `read ${at}`);
  });
  // Every permit and snapshot of the refused reads was released: a grant needing all of them goes through, and the shard serves again.
  await agent.commit("budget", { epoch: 2 });
  assert.equal((await agent.post(path, request(await token(), "documents.findById", { collection: "notes", id: "a" }))).body.value.id, "a");
});

test("a remote read of a value larger than its budget is refused without allocating it", async () => {
  const agent = await budgeted({ readLimits: { bytes: MiB } }, { count: 1, huge: 5 * MiB });
  const access = (await agent.access("budget")).token;
  const before = process.memoryUsage().arrayBuffers / MiB;
  const answer = await agent.post(path, request(access, "documents.findById", { collection: "notes", id: "huge" }));
  assert.deepEqual(answer.body, { defect: { _tag: "ReadBudgetExceeded", limit: "bytes", max: MiB } });
  assert.ok(process.memoryUsage().arrayBuffers / MiB - before < 4, "the 5 MiB value was never read into memory");
  assert.equal((await agent.post(path, request(access, "documents.findById", { collection: "notes", id: "a" }))).body.value.id, "a");
});

test("an answer over the limit is counted, not built", async () => {
  const agent = await budgeted({ maxReadAnswerBytes: MiB }, { count: 1, huge: 3 * MiB });
  const access = (await agent.access("budget")).token;
  const real = JSON.stringify;
  let largest = 0;
  JSON.stringify = (...args) => { const text = real(...args); largest = Math.max(largest, text.length); return text; };
  let answer;
  try { answer = await agent.post(path, request(access, "documents.findById", { collection: "notes", id: "huge" })); } finally { JSON.stringify = real; }
  assert.deepEqual(answer, { status: 413, body: { code: "answer-too-large" } });
  assert.ok(largest < MiB, `nothing the size of the answer was serialized (largest ${largest})`);
});

test("an Agent refuses to read from an engine that cannot bound its reads", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { createMemorySystemStore } = await import("../dist/index.js");
  const { createRemoteShardHost } = await import("../dist/adapters/_remote-shard-host.js");
  const { signAppShardGrant, signAppShardAccess } = await import("../dist/core/agent/app-shard-grant.js");
  const { memoryKvEngine } = await import("../dist/db/engines/memory-kv.js");
  const root = await mkdtemp(join(tmpdir(), "zv-unbounded-"));
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const now = Date.now();
  const trust = { keys: [{ keyId: "platform-test", publicKey: Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64"),
    notBefore: new Date(now - 60_000).toISOString(), notAfter: new Date(now + 600_000).toISOString() }] };
  const raw = memoryKvEngine();
  const host = createRemoteShardHost({ dataDirectory: root, store: createMemorySystemStore(), trust: () => trust, agentId: "agent-b", nodeId: "node-b",
    openEngine: () => Effect.succeed({ ...raw, bounded: undefined }) });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const identity = { keyId: "platform-test", agentId: "agent-b", nodeId: "node-b", projectId: "p", incarnation: "i", shardId: "u" };
  for (const state of ["preparing", "committed"]) {
    await host.applyGrant(await signAppShardGrant(privateKey, { ...identity, epoch: 1, state, durability: "crash", issuedAt: Date.now(), expiresAt: Date.now() + 30_000 }));
  }
  await Effect.runPromise(openShardOverKv("u", raw));
  const access = await signAppShardAccess(privateKey, { ...identity, epoch: 1, issuedAt: Date.now(), expiresAt: Date.now() + 60_000 });
  const answer = await host.reads(request(access, "documents.listCollections", null));
  assert.deepEqual(answer, { status: 500, body: { code: "unbounded-engine" } });
  assert.equal(host.readsServed(), 0);
});

test("read limits are checked when the Agent starts", async () => {
  const { createMemorySystemStore } = await import("../dist/index.js");
  const { createRemoteShardHost } = await import("../dist/adapters/_remote-shard-host.js");
  assert.throws(() => createRemoteShardHost({ dataDirectory: "/nonexistent", store: createMemorySystemStore(), trust: () => ({ keys: [] }), agentId: "a", nodeId: "n",
    readLimits: { entries: -1 } }), /non-negative safe integer/);
});
