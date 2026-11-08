import assert from "node:assert/strict";
import test from "node:test";

import {
  createAppShardPlacementAuthority,
  deleteAppShardPlacementLedger,
} from "../dist/platform/app-data-placement.js";
import { createMemorySystemStore } from "../dist/system-store.js";

const allocation = {
  projectId: "project-a",
  generation: 3,
  allowedNodeIds: ["node-a"],
  cpuCores: 2,
  memoryBytes: 200,
  diskBytes: 200,
};
const nodes = [
  { id: "node-a", ready: true, cpuCores: 8, memoryBytes: 1000, diskBytes: 1000 },
  { id: "node-b", ready: true, cpuCores: 8, memoryBytes: 1000, diskBytes: 1000 },
];
const request = (overrides = {}) => ({
  protocolVersion: 1,
  intent: "allocate",
  operationId: "operation-a",
  projectId: "project-a",
  shardId: "shard-a",
  virtualRanges: [0, 1],
  mapVersion: 1,
  expectedRevision: 0,
  resources: { cpuCores: 1, memoryBytes: 100, diskBytes: 100 },
  durability: "crash",
  ...overrides,
});
const authority = (store = createMemorySystemStore(), options = {}) =>
  createAppShardPlacementAuthority({
    store,
    allocation: options.allocation ?? (() => allocation),
    nodes: options.nodes ?? (() => nodes),
  });

const requestFrom = (service, projectId, input, nodeId = "node-a") => service.request(projectId, input, { nodeId });

test("Project request creates a durable reservation but no writer authority", async () => {
  const store = createMemorySystemStore();
  const first = authority(store);
  const granted = await requestFrom(first, "project-a", request());
  assert.equal(granted.granted, true);
  assert.equal(granted.placement.nodeId, "node-a");
  assert.equal(granted.placement.state, "reserved");
  assert.equal(granted.placement.revision, 1);
  assert.equal(granted.placement.epoch, 0);
  assert.equal(granted.placement.projectEpoch, 0);
  assert.equal(typeof granted.placement.incarnation, "string");
  assert.equal("runtimeUrl" in granted.placement, false);
  assert.deepEqual(await authority(store).current("project-a", "shard-a"), granted.placement);
  assert.deepEqual(await requestFrom(first, "project-a", request()), granted);
});

test("caller identity, requested fields, allocation and node policy are enforced", async () => {
  const service = authority();
  assert.deepEqual(await requestFrom(service, "project-b", request()),
    { granted: false, reason: "foreign-project", currentRevision: 0 });
  assert.equal((await requestFrom(service, "project-a", request({ nodeId: "node-b" }))).reason,
    "invalid-request");
  assert.equal((await requestFrom(service, "project-a", request({ protocolVersion: 2 }))).reason,
    "invalid-request");
  assert.equal((await requestFrom(service, "project-a", request({ virtualRanges: [0, 0] }))).reason,
    "invalid-request");
  assert.equal((await requestFrom(service, "project-a", request({ resources: {
    cpuCores: 3, memoryBytes: 100, diskBytes: 100,
  } }))).reason, "out-of-envelope");
  assert.equal((await requestFrom(authority(undefined, { nodes: () => [nodes[1]] }), "project-a", request())).reason,
    "no-eligible-node");
  assert.equal((await requestFrom(authority(undefined, { allocation: () => undefined }), "project-a", request())).reason,
    "allocation-unavailable");
});

test("the Project ledger atomically bounds aggregate reservations and rejects stale revisions", async () => {
  const store = createMemorySystemStore();
  const service = authority(store);
  assert.equal((await requestFrom(service, "project-a", request())).granted, true);
  const second = request({ operationId: "operation-b", shardId: "shard-b", expectedRevision: 1,
    virtualRanges: [2, 3] });
  assert.equal((await requestFrom(service, "project-a", second)).granted, true);
  assert.equal((await requestFrom(service, "project-a", request({ operationId: "operation-c", shardId: "shard-c",
    expectedRevision: 2, virtualRanges: [4] }))).reason, "out-of-envelope");
  assert.equal((await requestFrom(service, "project-a", request({ operationId: "operation-c", shardId: "shard-c",
    expectedRevision: 1, virtualRanges: [4] }))).reason, "revision-conflict");
  assert.equal((await requestFrom(service, "project-a", request({ operationId: "operation-c", shardId: "shard-c",
    expectedRevision: 2, virtualRanges: [1] }))).reason, "range-conflict");
  assert.equal((await requestFrom(service, "project-a", request({ shardId: "shard-b", expectedRevision: 2 }))).reason,
    "operation-conflict");
  assert.equal((await requestFrom(service, "project-a", request({ virtualRanges: [3] }))).reason,
    "operation-conflict");
  const replacement = request({ operationId: "operation-d", expectedRevision: 2, virtualRanges: [0] });
  const refused = await requestFrom(service, "project-a", replacement);
  assert.equal(refused.reason, "shard-in-use");
  assert.equal(refused.current.operationId, "operation-a");
  assert.equal((await requestFrom(service, "project-a", request({ expectedRevision: 3 }))).reason,
    "operation-conflict");
});

test("racing requests for the same remaining budget produce one reservation", async () => {
  const store = createMemorySystemStore();
  let waiting = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = authority(store, { nodes: async () => {
    waiting += 1;
    if (waiting === 2) release();
    await gate;
    return nodes;
  } });
  const [left, right] = await Promise.all([
    requestFrom(service, "project-a", request()),
    requestFrom(service, "project-a", request({ operationId: "operation-b", shardId: "shard-b",
      virtualRanges: [2] })),
  ]);
  assert.equal([left, right].filter((entry) => entry.granted).length, 1);
  assert.equal([left, right].find((entry) => !entry.granted).reason, "revision-conflict");
});

test("a reservation from an older parent allocation is not replayed", async () => {
  const store = createMemorySystemStore();
  let generation = 3;
  const service = authority(store, { allocation: () => ({ ...allocation, generation }) });
  assert.equal((await requestFrom(service, "project-a", request())).granted, true);
  generation = 4;
  assert.equal((await requestFrom(service, "project-a", request())).reason, "allocation-changed");
});

test("request fields are snapshotted before asynchronous admission", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = authority(createMemorySystemStore(), { allocation: async () => {
    await gate;
    return allocation;
  } });
  const mutable = request();
  const pending = requestFrom(service, "project-a", mutable);
  mutable.projectId = "project-b";
  mutable.virtualRanges[0] = 99;
  mutable.resources.cpuCores = 100;
  release();
  const result = await pending;
  assert.equal(result.granted, true);
  assert.equal(result.placement.projectId, "project-a");
  assert.deepEqual(result.placement.virtualRanges, [0, 1]);
  assert.equal(result.placement.resources.cpuCores, 1);
});

test("Project deletion cleanup removes reservations and is idempotent", async () => {
  const store = createMemorySystemStore();
  const service = authority(store);
  assert.equal((await requestFrom(service, "project-a", request())).granted, true);
  await deleteAppShardPlacementLedger(store, "project-a");
  await deleteAppShardPlacementLedger(store, "project-a");
  assert.equal(await service.current("project-a", "shard-a"), undefined);
});

test("shards of one Project spread over the eligible Nodes within the load cap, and a repeated request keeps its Node", async () => {
  const wide = { ...allocation, allowedNodeIds: ["node-a", "node-b", "node-c"], cpuCores: 30, memoryBytes: 3000, diskBytes: 3000 };
  const three = ["node-a", "node-b", "node-c"].map((id) => ({ id, ready: true, cpuCores: 8, memoryBytes: 1000, diskBytes: 1000 }));
  const service = authority(createMemorySystemStore(), { allocation: () => wide, nodes: () => three });
  const placed = new Map();
  let revision = 0;
  const first = [];
  for (let at = 0; at < 30; at += 1) {
    const answer = await requestFrom(service, "project-a", request({ operationId: `operation-${at}`, shardId: `shard-${at}`, virtualRanges: [at], expectedRevision: revision }));
    assert.equal(answer.granted, true, JSON.stringify(answer));
    revision = answer.placement.revision;
    first.push(answer.placement);
    placed.set(answer.placement.nodeId, (placed.get(answer.placement.nodeId) ?? 0) + 1);
  }
  console.log(`30 shards over 3 Nodes: ${[...placed].map(([id, count]) => `${id} ${count}`).join(", ")}`);
  assert.equal(placed.size, 3, "every Node holds some");
  for (const [id, count] of placed) assert.ok(count >= 5 && count <= 13, `${id} holds ${count}`);
  const again = await requestFrom(service, "project-a", request({ operationId: "operation-0", shardId: "shard-0", virtualRanges: [0], expectedRevision: 0 }));
  assert.equal(again.granted, true);
  assert.equal(again.placement.nodeId, first[0].nodeId, "asking again does not move a recorded reservation");
});

const reserved = async (service, overrides = {}) => {
  const answer = await requestFrom(service, "project-a", request(overrides));
  assert.equal(answer.granted, true, JSON.stringify(answer));
  return answer.placement;
};
const ids = (shardId = "shard-a", operationId = "operation-a") => ({ projectId: "project-a", shardId, operationId });

test("activation moves reserved to preparing to committed and raises the epoch", async () => {
  const service = authority();
  await reserved(service);
  const preparing = await service.beginActivation({ ...ids(), projectEpoch: 4 });
  assert.equal(preparing.granted, true);
  assert.deepEqual([preparing.placement.state, preparing.placement.epoch, preparing.placement.projectEpoch], ["preparing", 1, 4]);
  assert.equal(preparing.placement.revision, 2);
  assert.deepEqual(await service.beginActivation({ ...ids(), projectEpoch: 4 }), preparing);
  assert.equal((await service.commitActivation({ ...ids(), epoch: 2 })).reason, "stale");
  const committed = await service.commitActivation({ ...ids(), epoch: 1 });
  assert.equal(committed.placement.state, "committed");
  assert.deepEqual(await service.commitActivation({ ...ids(), epoch: 1 }), committed);
  assert.equal((await service.list("project-a")).placements[0].state, "committed");
});

test("transitions refuse unknown shards, foreign operations and wrong states", async () => {
  const service = authority();
  assert.equal((await service.beginActivation({ ...ids(), projectEpoch: 1 })).reason, "unknown-shard");
  await reserved(service);
  assert.equal((await service.beginActivation({ ...ids("shard-a", "operation-x"), projectEpoch: 1 })).reason, "operation-conflict");
  assert.equal((await service.beginActivation({ ...ids(), projectEpoch: 0 })).reason, "invalid-request");
  assert.equal((await service.commitActivation({ ...ids(), epoch: 0 })).reason, "wrong-state");
  assert.equal((await service.reissue({ projectId: "project-a", shardId: "shard-a", projectEpoch: 2 })).reason, "wrong-state");
  assert.equal((await service.completeRelease({ projectId: "project-a", shardId: "shard-a", epoch: 0 })).reason, "wrong-state");
});

test("reissue raises the epoch for a newer Project epoch only", async () => {
  const service = authority();
  await reserved(service);
  await service.beginActivation({ ...ids(), projectEpoch: 4 });
  await service.commitActivation({ ...ids(), epoch: 1 });
  const same = await service.reissue({ projectId: "project-a", shardId: "shard-a", projectEpoch: 4 });
  assert.equal(same.placement.epoch, 1);
  const next = await service.reissue({ projectId: "project-a", shardId: "shard-a", projectEpoch: 5 });
  assert.deepEqual([next.placement.epoch, next.placement.projectEpoch], [2, 5]);
  assert.equal((await service.reissue({ projectId: "project-a", shardId: "shard-a", projectEpoch: 4 })).reason, "stale");
});

test("release goes through releasing, keeps the epoch, and the shard can be requested again from it", async () => {
  const service = authority();
  await reserved(service);
  await service.beginActivation({ ...ids(), projectEpoch: 1 });
  await service.commitActivation({ ...ids(), epoch: 1 });
  const releasing = await service.beginRelease(ids());
  assert.equal(releasing.placement.state, "releasing");
  assert.deepEqual(await service.beginRelease(ids()), releasing);
  assert.equal((await service.completeRelease({ projectId: "project-a", shardId: "shard-a", epoch: 9 })).reason, "stale");
  const released = await service.completeRelease({ projectId: "project-a", shardId: "shard-a", epoch: 1 });
  assert.equal(released.placement.state, "released");
  assert.deepEqual(await service.completeRelease({ projectId: "project-a", shardId: "shard-a", epoch: 1 }), released);
  const again = await reserved(service, { operationId: "operation-b", expectedRevision: released.placement.revision });
  assert.deepEqual([again.state, again.epoch], ["reserved", 1]);
  const preparing = await service.beginActivation({ ...ids("shard-a", "operation-b"), projectEpoch: 2 });
  assert.equal(preparing.placement.epoch, 2);
});

test("a never-activated reservation is released directly and released ranges and budget are free again", async () => {
  const service = authority();
  const first = await reserved(service);
  await reserved(service, { operationId: "operation-b", shardId: "shard-b", virtualRanges: [2], expectedRevision: 1 });
  assert.equal((await service.beginRelease(ids())).placement.state, "released");
  const reuse = await requestFrom(service, "project-a", request({ operationId: "operation-c", shardId: "shard-c", virtualRanges: [0, 1], expectedRevision: first.revision + 2 }));
  assert.equal(reuse.granted, true);
});

test("the ledger refuses to grow past its entry cap", async () => {
  const wide = { ...allocation, cpuCores: 1000, memoryBytes: 1e6, diskBytes: 1e6 };
  const service = authority(createMemorySystemStore(), { allocation: () => wide });
  let revision = 0;
  for (let at = 0; at < 256; at += 1) {
    const answer = await requestFrom(service, "project-a", request({ operationId: `operation-${at}`, shardId: `shard-${at}`, virtualRanges: [at], expectedRevision: revision }));
    assert.equal(answer.granted, true, JSON.stringify(answer));
    revision = answer.placement.revision;
    assert.equal((await service.beginRelease({ projectId: "project-a", shardId: `shard-${at}`, operationId: `operation-${at}` })).granted, true);
    revision += 1;
  }
  const over = await requestFrom(service, "project-a", request({ operationId: "operation-over", shardId: "shard-over", virtualRanges: [999], expectedRevision: revision }));
  assert.equal(over.reason, "ledger-full");
});

const replicaRequest = (of, expectedRevision, overrides = {}) => request({
  intent: "replica", operationId: `replicate-${of}`, shardId: `${of}.replica`, of,
  expectedRevision, virtualRanges: [], resources: { cpuCores: 0, memoryBytes: 0, diskBytes: 100 },
  ...overrides,
});

test("replica admission: anti-affinity, one per shard, no ranges, envelope", async () => {
  const nodeC = { ...nodes[1], id: "node-c" };
  let allowedNodeIds = ["node-b"];
  const service = authority(createMemorySystemStore(), {
    allocation: () => ({ ...allocation, allowedNodeIds }),
    nodes: () => [...nodes, nodeC],
  });
  const primary = ids("shard-2");
  assert.equal((await reserved(service, { shardId: primary.shardId })).nodeId, "node-b");
  await service.beginActivation({ ...primary, projectEpoch: 1 });
  await service.commitActivation({ ...primary, epoch: 1 });

  const propose = (input) => requestFrom(service, "project-a", input);
  assert.equal((await propose(replicaRequest("shard-2", 3))).reason, "no-eligible-node");
  allowedNodeIds = ["node-b", "node-c"];
  const proposal = replicaRequest("shard-2", 3);
  const result = await propose(proposal);
  assert.equal(result.granted, true, JSON.stringify(result));
  const { role, of, nodeId, virtualRanges } = result.placement;
  assert.deepEqual({ role, of, nodeId, virtualRanges }, { role: "replica", of: "shard-2", nodeId: "node-c", virtualRanges: [] });
  assert.deepEqual(await propose(proposal), result);
  assert.equal((await propose(replicaRequest("shard-2", 4, { operationId: "duplicate" }))).reason, "replica-exists");
  assert.equal((await propose(replicaRequest("shard-0", 4))).reason, "out-of-envelope");

  for (const invalid of [
    { virtualRanges: [5] },
    { shardId: "different" },
    { shardId: "x.replica.replica", of: "x.replica" },
    { resources: { ...proposal.resources, diskBytes: 0 } },
    { intent: undefined },
  ]) {
    assert.equal((await propose(replicaRequest("shard-0", 4, invalid))).reason, "invalid-request");
  }

  const local = authority(createMemorySystemStore(), { allocation: () => ({ ...allocation, allowedNodeIds: ["node-a", "node-b"] }) });
  const localReplica = await requestFrom(local, "project-a", replicaRequest("shard-0", 0));
  assert.equal(localReplica.placement?.nodeId, "node-b");
  const movedPrimary = await reserved(local, { shardId: "shard-0", expectedRevision: 1 });
  assert.equal(movedPrimary.nodeId, "node-a", "a later primary allocation preserves anti-affinity");
});

test("a primary with a live replica is not released", async () => {
  const service = authority(createMemorySystemStore(), { allocation: () => ({ ...allocation, allowedNodeIds: ["node-a", "node-b"] }) });
  const primary = await reserved(service);
  await service.beginActivation({ ...ids(), projectEpoch: 1 });
  await service.commitActivation({ ...ids(), epoch: 1 });
  const requested = await requestFrom(service, "project-a", replicaRequest(primary.shardId, 3));
  assert.equal(requested.granted, true);
  assert.equal((await service.beginRelease(ids())).reason, "replica-live");
  const replica = requested.placement;
  assert.equal((await service.beginRelease(ids(replica.shardId, replica.operationId))).placement?.state, "released");
  const releasing = await service.beginRelease(ids());
  assert.equal(releasing.placement?.state, "releasing");
  const lateReplica = await requestFrom(service, "project-a", replicaRequest(primary.shardId, releasing.placement.revision, { operationId: "late" }));
  assert.equal(lateReplica.reason, "wrong-state");
});
