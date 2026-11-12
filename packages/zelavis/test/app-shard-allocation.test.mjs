import assert from "node:assert/strict";
import test from "node:test";

import { createAppShardAllocationStore, deleteAppShardAllocation } from "../dist/platform/app-shard-allocation.js";
import { createMemorySystemStore } from "../dist/system-store.js";

const input = (overrides = {}) => ({
  allowedNodeIds: ["node-a", "node-b"], cpuCores: 4, memoryBytes: 400, diskBytes: 400, expectedGeneration: 0, ...overrides,
});
const placement = (shardId, nodeId, state = "committed", cpuCores = 1) => ({
  shardId, nodeId, state, resources: { cpuCores, memoryBytes: 100, diskBytes: 100 },
});
const none = async () => [];

test("the first set creates generation 1 and a repeat of the same observation conflicts", async () => {
  const allocations = createAppShardAllocationStore(createMemorySystemStore());
  const first = await allocations.set("p", input(), none);
  assert.equal(first.ok, true);
  assert.equal(first.allocation.generation, 1);
  assert.deepEqual(await allocations.get("p"), first.allocation);
  const again = await allocations.set("p", input(), none);
  assert.deepEqual([again.ok, again.reason, again.current.generation], [false, "generation-conflict", 1]);
  const second = await allocations.set("p", input({ expectedGeneration: 1, cpuCores: 8 }), none);
  assert.equal(second.allocation.generation, 2);
});

test("an allocation cannot exclude a Node or shrink below live placements", async () => {
  const allocations = createAppShardAllocationStore(createMemorySystemStore());
  await allocations.set("p", input(), none);
  const live = async () => [placement("s1", "node-b"), placement("s2", "node-a", "released", 3)];
  const excluded = await allocations.set("p", input({ expectedGeneration: 1, allowedNodeIds: ["node-a"] }), live);
  assert.deepEqual([excluded.ok, excluded.reason, excluded.inUse], [false, "allocation-in-use", ["s1"]]);
  const shrunk = await allocations.set("p", input({ expectedGeneration: 1, cpuCores: 1, memoryBytes: 50 }), live);
  assert.equal(shrunk.reason, "allocation-in-use");
  const fine = await allocations.set("p", input({ expectedGeneration: 1, cpuCores: 1 }), live);
  assert.equal(fine.ok, true, "a released placement does not block");
});

test("invalid allocations are refused", async () => {
  const allocations = createAppShardAllocationStore(createMemorySystemStore());
  const many = Array.from({ length: 65 }, (_, at) => `n${at}`);
  for (const bad of [
    input({ allowedNodeIds: [] }), input({ allowedNodeIds: many }), input({ cpuCores: 0 }),
    input({ allowedNodeIds: ["a", "a"] }), { ...input(), extra: 1 }, input({ expectedGeneration: -1 }), "nope",
  ]) assert.equal((await allocations.set("p", bad, none)).reason, "invalid-request");
});

test("deleting an allocation is idempotent", async () => {
  const store = createMemorySystemStore();
  const allocations = createAppShardAllocationStore(store);
  await allocations.set("p", input(), none);
  await deleteAppShardAllocation(store, "p");
  await deleteAppShardAllocation(store, "p");
  assert.equal(await allocations.get("p"), undefined);
});
