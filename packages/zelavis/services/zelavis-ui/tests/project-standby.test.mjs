import assert from "node:assert/strict";
import test from "node:test";
import { runtimeStatusText, standbyFact } from "../app/project-standby.ts";

test("a Project without a standby shows no standby line", () => {
  assert.equal(standbyFact({ id: "p" }), undefined);
});

test("each standby status reads as what it is, and a failure carries its reason", () => {
  assert.deepEqual(standbyFact({ standby: { nodeId: "node-b", status: "dispatched" } }), ["Standby", "node-b — standing by"]);
  assert.deepEqual(standbyFact({ standby: { nodeId: "node-b", status: "promoted" } }), ["Standby", "node-b — took over as the writer"]);
  assert.deepEqual(standbyFact({ standby: { nodeId: "node-b", status: "stopped" } }), ["Standby", "node-b — stopped"]);
  assert.deepEqual(standbyFact({ standby: { nodeId: "node-b", status: "failed", error: "No Agent endpoint." } }), ["Standby", "node-b — failed: No Agent endpoint."]);
  assert.deepEqual(standbyFact({ standby: { nodeId: "node-b", status: "failed" } }), ["Standby", "node-b — failed"]);
});

test("a standby process is standing by, never running", () => {
  assert.equal(runtimeStatusText("standby"), "standing by");
  assert.equal(runtimeStatusText("running"), "running");
});
