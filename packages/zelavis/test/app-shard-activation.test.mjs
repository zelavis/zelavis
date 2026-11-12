import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspect } from "node:util";
import { Effect } from "effect";

import { createHttpsProjectDispatcher } from "../dist/adapters/_project-dispatch-https.js";
import { makeRemoteKvEngine } from "../dist/db/engines/remote-kv.js";
import { createAppShardPlacementAuthority } from "../dist/platform/app-data-placement.js";
import { createAppShardActivation } from "../dist/platform/app-shard-activation.js";
import { createMemorySystemStore } from "../dist/system-store.js";
import { startRemoteShardAgent } from "./_remote-shard-fixture.mjs";

const fixture = await startRemoteShardAgent();
const projectsDirectory = await mkdtemp(join(tmpdir(), "zv-activation-"));

const plain = () => createHttpsProjectDispatcher({
  localNodeId: "node-a", projectsDirectory, keyId: fixture.signer.keyId, privateKey: fixture.signer.privateKey,
  destinations: { "node-b": { url: fixture.agent.address, agentId: "agent-b", caPem: fixture.certPem } },
});
/** A dispatcher whose `n`-th grant delivery rejects once. */
const failing = (n) => {
  const real = plain();
  let calls = 0;
  return { ...real, deliverAppShardGrant: async (request) => {
    calls += 1;
    if (calls === n) throw new Error("delivery lost");
    return real.deliverAppShardGrant(request);
  } };
};
const allocation = { projectId: "p", generation: 1, allowedNodeIds: ["node-b"], cpuCores: 4, memoryBytes: 1e9, diskBytes: 1e10 };
const nodes = [{ id: "node-b", ready: true, cpuCores: 8, memoryBytes: 1e10, diskBytes: 1e11 }];
const setup = (dispatcher = plain(), leaseGuarded = false) => {
  const authority = createAppShardPlacementAuthority({ store: createMemorySystemStore(), allocation: () => allocation, nodes: () => nodes });
  return { authority, make: (use = dispatcher, guarded = leaseGuarded) => createAppShardActivation({ authority, dispatcher: () => use, leaseGuarded: guarded }) };
};
let counter = 0;
const reserve = async (authority, shardId = `s${counter += 1}`, projectId = "p") => {
  const view = await authority.list(projectId);
  const decision = await authority.request(projectId, {
    protocolVersion: 1, intent: "allocate", operationId: `op-${shardId}`, projectId, shardId, virtualRanges: [counter * 10, counter * 10 + 1],
    mapVersion: 1, expectedRevision: view.revision, resources: { cpuCores: 1, memoryBytes: 1e6, diskBytes: 1e6 }, durability: "crash",
  }, { nodeId: "node-a" });
  assert.equal(decision.granted, true, JSON.stringify(decision));
  return { shardId, operationId: `op-${shardId}` };
};
const engineFor = (grant) => makeRemoteKvEngine({
  destination: { url: grant.destination.url, caPem: grant.destination.caPem },
  access: { current: Effect.succeed(grant.token), renew: Effect.succeed(grant.token) },
});
const readFailure = async (grant, key) => {
  const exit = await Effect.runPromiseExit(Effect.scoped(Effect.flatMap(engineFor(grant), (engine) => engine.get(key))));
  return exit._tag === "Failure" ? inspect(exit.cause, { depth: 8 }) : "no failure";
};
const read = (grant, key) => Effect.runPromise(Effect.scoped(Effect.flatMap(engineFor(grant), (engine) => engine.get(key))));
/** How many shards the Agent keeps on disk (their directories are named by a hash of the shard's identity). */
const storedShards = () => readdir(join(fixture.root, "agent", "shards")).then((entries) => entries.length, () => 0);

test("activation commits a reserved shard and the token reads through the Agent", async () => {
  const { authority, make } = setup();
  const { shardId, operationId } = await reserve(authority);
  const result = await make().activate({ projectId: "p", shardId, operationId, projectEpoch: 1 });
  assert.equal(result.granted, true, JSON.stringify(result));
  assert.equal(result.placement.state, "committed");
  assert.equal(result.placement.epoch, 1);
  assert.equal(result.access.destination.url, fixture.agent.address);
  assert.equal(await read(result.access, new Uint8Array([1])), undefined);
  assert.ok(await storedShards() >= 1);
});

for (const n of [1, 2]) {
  test(`a delivery lost at grant ${n} converges on retry at the same epoch`, async () => {
    const { authority, make } = setup();
    const { shardId, operationId } = await reserve(authority);
    const lost = await make(failing(n)).activate({ projectId: "p", shardId, operationId, projectEpoch: 1 });
    assert.equal(lost.granted, false);
    assert.equal(lost.reason, "agent-unavailable");
    assert.equal((await authority.current("p", shardId)).state, n === 1 ? "preparing" : "committed");
    const again = await make().activate({ projectId: "p", shardId, operationId, projectEpoch: 1 });
    assert.equal(again.granted, true, JSON.stringify(again));
    assert.equal(again.placement.epoch, 1);
  });
}

test("a new Project epoch reissues the grant and fences the older token", async () => {
  const { authority, make } = setup();
  const { shardId, operationId } = await reserve(authority);
  const activation = make();
  const first = await activation.activate({ projectId: "p", shardId, operationId, projectEpoch: 1 });
  const second = await activation.access({ projectId: "p", shardId, projectEpoch: 2 });
  assert.equal(second.granted, true, JSON.stringify(second));
  assert.equal(second.placement.epoch, 2);
  assert.match(await readFailure(first.access, new Uint8Array([1])), /stale-epoch/);
  assert.equal(await read(second.access, new Uint8Array([1])), undefined);
  const older = await activation.access({ projectId: "p", shardId, projectEpoch: 1 });
  assert.equal(older.granted, false);
  assert.equal(older.reason, "stale");
});

test("a lease-guarded Platform never activates a shard", async () => {
  const { authority, make } = setup();
  const { shardId, operationId } = await reserve(authority);
  const result = await make(plain(), true).activate({ projectId: "p", shardId, operationId, projectEpoch: 1 });
  assert.equal(result.granted, false);
  assert.equal(result.reason, "lease-guarded");
  assert.equal((await authority.current("p", shardId)).state, "reserved");
});

test("release removes the Agent's storage and the shard's epoch only rises", async () => {
  const { authority, make } = setup();
  const { shardId, operationId } = await reserve(authority);
  const activation = make();
  assert.equal((await activation.activate({ projectId: "p", shardId, operationId, projectEpoch: 1 })).granted, true);
  const stored = await storedShards();
  const released = await activation.release({ projectId: "p", shardId, operationId });
  assert.equal(released.granted, true, JSON.stringify(released));
  assert.equal(released.placement.state, "released");
  assert.equal(await storedShards(), stored - 1);
  const view = await authority.list("p");
  const again = await authority.request("p", {
    protocolVersion: 1, intent: "allocate", operationId: "op-again", projectId: "p", shardId, virtualRanges: [900, 901], mapVersion: 2,
    expectedRevision: view.revision, resources: { cpuCores: 1, memoryBytes: 1e6, diskBytes: 1e6 }, durability: "crash",
  }, { nodeId: "node-a" });
  assert.equal(again.granted, true, JSON.stringify(again));
  const reactivated = await activation.activate({ projectId: "p", shardId, operationId: "op-again", projectEpoch: 1 });
  assert.equal(reactivated.granted, true, JSON.stringify(reactivated));
  assert.equal(reactivated.placement.epoch, 2);
});

test("revokeAll fails retryably while an Agent is unreachable, then releases every shard", async () => {
  const { authority, make } = setup();
  const activation = make();
  const ids = [];
  const before = await storedShards();
  for (let index = 0; index < 2; index += 1) {
    const { shardId, operationId } = await reserve(authority);
    assert.equal((await activation.activate({ projectId: "p", shardId, operationId, projectEpoch: 1 })).granted, true);
    ids.push(shardId);
  }
  await fixture.closeAgent();
  await assert.rejects(activation.revokeAll("p"), /could not be released/);
  const mid = (await authority.list("p")).placements.filter((entry) => ids.includes(entry.shardId));
  assert.ok(mid.every((entry) => entry.state === "releasing" || entry.state === "committed"));
  await fixture.restart();
  await activation.revokeAll("p");
  const done = (await authority.list("p")).placements.filter((entry) => ids.includes(entry.shardId));
  assert.ok(done.every((entry) => entry.state === "released"));
  assert.equal(await storedShards(), before);
});

test("revokeAll releases replicas first", async () => {
  const authority = createAppShardPlacementAuthority({
    store: createMemorySystemStore(),
    allocation: () => ({ ...allocation, allowedNodeIds: ["node-a", "node-b"] }),
    nodes: () => [...nodes, { ...nodes[0], id: "node-a" }],
  });
  const primary = await reserve(authority, "s1");
  const replica = { shardId: "s1.replica", operationId: "op-replica" };
  const reserved = await authority.request("p", {
    protocolVersion: 1, intent: "replica", ...replica, projectId: "p", of: primary.shardId, virtualRanges: [],
    mapVersion: 1, expectedRevision: 1, resources: { cpuCores: 0, memoryBytes: 0, diskBytes: 1e6 }, durability: "crash",
  }, { nodeId: "node-a" });
  assert.equal(reserved.granted, true, JSON.stringify(reserved));
  for (const entry of [primary, replica]) {
    assert.equal((await authority.beginActivation({ ...entry, projectId: "p", projectEpoch: 1 })).granted, true);
    assert.equal((await authority.commitActivation({ ...entry, projectId: "p", epoch: 1 })).granted, true);
  }
  const released = [];
  const activation = createAppShardActivation({
    authority, leaseGuarded: false,
    dispatcher: () => ({ deliverAppShardGrant: async ({ shardId, state }) => {
      assert.equal(state, "released");
      released.push(shardId);
    } }),
  });
  await activation.revokeAll("p");
  assert.deepEqual(released, [replica.shardId, primary.shardId]);
  assert.ok((await authority.list("p")).placements.every((entry) => entry.state === "released"));
});
