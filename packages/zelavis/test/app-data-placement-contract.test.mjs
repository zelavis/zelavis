import assert from "node:assert/strict";
import test from "node:test";

import {
  createAppShardPlacementAuthority,
  deleteAppShardPlacementReservations,
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
  operationId: "operation-a",
  projectId: "project-a",
  shardId: "shard-a",
  virtualRanges: [0, 1],
  mapVersion: 1,
  expectedRevision: 0,
  resources: { cpuCores: 1, memoryBytes: 100, diskBytes: 100 },
  ...overrides,
});
const authority = (store = createMemorySystemStore(), options = {}) =>
  createAppShardPlacementAuthority({
    store,
    allocation: options.allocation ?? (() => allocation),
    nodes: options.nodes ?? (() => nodes),
  });

test("Project request creates a durable reservation but no writer authority", async () => {
  const store = createMemorySystemStore();
  const first = authority(store);
  const granted = await first.request("project-a", request());
  assert.equal(granted.granted, true);
  assert.equal(granted.reservation.nodeId, "node-a");
  assert.equal(granted.reservation.state, "reserved");
  assert.equal(granted.reservation.revision, 1);
  assert.equal("epoch" in granted.reservation, false);
  assert.equal("runtimeUrl" in granted.reservation, false);
  assert.deepEqual(await authority(store).current("project-a", "shard-a"), granted.reservation);
  assert.deepEqual(await first.request("project-a", request()), granted);
});

test("caller identity, requested fields, allocation and node policy are enforced", async () => {
  const service = authority();
  assert.deepEqual(await service.request("project-b", request()),
    { granted: false, reason: "foreign-project", currentRevision: 0 });
  assert.equal((await service.request("project-a", request({ nodeId: "node-b" }))).reason,
    "invalid-request");
  assert.equal((await service.request("project-a", request({ protocolVersion: 2 }))).reason,
    "invalid-request");
  assert.equal((await service.request("project-a", request({ virtualRanges: [0, 0] }))).reason,
    "invalid-request");
  assert.equal((await service.request("project-a", request({ resources: {
    cpuCores: 3, memoryBytes: 100, diskBytes: 100,
  } }))).reason, "out-of-envelope");
  assert.equal((await authority(undefined, { nodes: () => [nodes[1]] }).request("project-a", request())).reason,
    "no-eligible-node");
  assert.equal((await authority(undefined, { allocation: () => undefined }).request("project-a", request())).reason,
    "allocation-unavailable");
});

test("the Project ledger atomically bounds aggregate reservations and rejects stale revisions", async () => {
  const store = createMemorySystemStore();
  const service = authority(store);
  assert.equal((await service.request("project-a", request())).granted, true);
  const second = request({ operationId: "operation-b", shardId: "shard-b", expectedRevision: 1,
    virtualRanges: [2, 3] });
  assert.equal((await service.request("project-a", second)).granted, true);
  assert.equal((await service.request("project-a", request({ operationId: "operation-c", shardId: "shard-c",
    expectedRevision: 2, virtualRanges: [4] }))).reason, "out-of-envelope");
  assert.equal((await service.request("project-a", request({ operationId: "operation-c", shardId: "shard-c",
    expectedRevision: 1, virtualRanges: [4] }))).reason, "revision-conflict");
  assert.equal((await service.request("project-a", request({ operationId: "operation-c", shardId: "shard-c",
    expectedRevision: 2, virtualRanges: [1] }))).reason, "range-conflict");
  assert.equal((await service.request("project-a", request({ shardId: "shard-b", expectedRevision: 2 }))).reason,
    "operation-conflict");
  assert.equal((await service.request("project-a", request({ virtualRanges: [3] }))).reason,
    "operation-conflict");
  const replacement = request({ operationId: "operation-d", expectedRevision: 2, virtualRanges: [0] });
  assert.equal((await service.request("project-a", replacement)).granted, true);
  assert.equal((await service.request("project-a", request({ expectedRevision: 3 }))).reason,
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
    service.request("project-a", request()),
    service.request("project-a", request({ operationId: "operation-b", shardId: "shard-b",
      virtualRanges: [2] })),
  ]);
  assert.equal([left, right].filter((entry) => entry.granted).length, 1);
  assert.equal([left, right].find((entry) => !entry.granted).reason, "revision-conflict");
});

test("a reservation from an older parent allocation is not replayed", async () => {
  const store = createMemorySystemStore();
  let generation = 3;
  const service = authority(store, { allocation: () => ({ ...allocation, generation }) });
  assert.equal((await service.request("project-a", request())).granted, true);
  generation = 4;
  assert.equal((await service.request("project-a", request())).reason, "allocation-changed");
});

test("request fields are snapshotted before asynchronous admission", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = authority(createMemorySystemStore(), { allocation: async () => {
    await gate;
    return allocation;
  } });
  const mutable = request();
  const pending = service.request("project-a", mutable);
  mutable.projectId = "project-b";
  mutable.virtualRanges[0] = 99;
  mutable.resources.cpuCores = 100;
  release();
  const result = await pending;
  assert.equal(result.granted, true);
  assert.equal(result.reservation.projectId, "project-a");
  assert.deepEqual(result.reservation.virtualRanges, [0, 1]);
  assert.equal(result.reservation.resources.cpuCores, 1);
});

test("Project deletion cleanup removes reservations and is idempotent", async () => {
  const store = createMemorySystemStore();
  const service = authority(store);
  assert.equal((await service.request("project-a", request())).granted, true);
  await deleteAppShardPlacementReservations(store, "project-a");
  await deleteAppShardPlacementReservations(store, "project-a");
  assert.equal(await service.current("project-a", "shard-a"), undefined);
});
