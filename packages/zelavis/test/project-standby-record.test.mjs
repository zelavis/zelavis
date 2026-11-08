import assert from "node:assert/strict";
import test from "node:test";
import { createMemorySystemStore } from "../dist/system-store.js";
import { createProjectStandbyStore, deleteProjectStandby } from "../dist/platform/project-standby.js";

test("a Project's standby record is written by compare-and-set, read back decoded, and removed with the Project", async () => {
  const store = createMemorySystemStore();
  const standbys = createProjectStandbyStore(store);
  assert.equal(await standbys.read("p1"), undefined);

  const first = await standbys.write({ projectId: "p1", nodeId: "node-b", writerEpoch: 1, state: "dispatched" });
  assert.deepEqual(await standbys.read("p1"), first);
  const promoted = await standbys.write({ projectId: "p1", nodeId: "node-b", writerEpoch: 2, state: "promoted" });
  assert.equal((await standbys.read("p1")).state, "promoted");
  assert.equal(promoted.writerEpoch, 2);

  // A write built on a stale reading is refused rather than overwriting.
  const raced = createProjectStandbyStore({ ...store, get: async (...args) => { const found = await store.get(...args); await store.set(args[0], args[1], { ...found.value, state: "failed" }); return found; } });
  await assert.rejects(raced.write({ projectId: "p1", nodeId: "node-b", writerEpoch: 3, state: "stopped" }), /changed while/);

  await store.set("fabric.project-standby.v1", "bad", { schemaVersion: 1, projectId: "bad", nodeId: "n", writerEpoch: -1, state: "dispatched", updatedAt: "x" });
  await assert.rejects(standbys.read("bad"), /Malformed/);
  await assert.rejects(standbys.write({ projectId: "", nodeId: "n", writerEpoch: 1, state: "dispatched" }), /Invalid/);

  await deleteProjectStandby(store, "p1");
  await deleteProjectStandby(store, "p1");
  assert.equal(await standbys.read("p1"), undefined);
});
