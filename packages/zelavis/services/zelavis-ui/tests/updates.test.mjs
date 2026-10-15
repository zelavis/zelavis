import assert from "node:assert/strict";
import test from "node:test";
import { ago, describeUpdate, updatePollDelay } from "../app/updates.ts";
import { describeScaleOutOutcome, isValidNodeId, joinCommand } from "../app/capacity.ts";

const base = { current: "2.0.0-alpha.36", managed: true, available: false, state: "idle" };

test("an available update is announced with both versions", () => {
  assert.deepEqual(describeUpdate({ ...base, available: true, latest: "2.0.0-alpha.37" }), { kind: "available", latest: "2.0.0-alpha.37", current: "2.0.0-alpha.36" });
});

test("a running update is a working state and a failed one keeps its log", () => {
  assert.equal(describeUpdate({ ...base, state: "running", run: { message: "Switching engines" } }).kind, "working");
  const problem = describeUpdate({ ...base, state: "rolled-back", run: { message: "Rolled back", log: ["a", "b"] } });
  assert.deepEqual(problem, { kind: "problem", headline: "Rolled back", log: ["a", "b"] });
});

test("losing the connection while nothing is known reads as an update in progress", () => {
  assert.equal(describeUpdate(undefined, true).kind, "working");
  assert.equal(describeUpdate(undefined, false).kind, "hidden");
});

test("something newer than what just finished replaces the done notice", () => {
  const done = { ...base, current: "2.0.0-alpha.37", state: "succeeded", run: { to: "2.0.0-alpha.37" } };
  assert.equal(describeUpdate(done).kind, "done");
  assert.equal(describeUpdate({ ...done, available: true, latest: "2.0.0-alpha.38" }).kind, "available");
});

test("polling is fast while something happens and slow otherwise", () => {
  assert.equal(updatePollDelay({ ...base, state: "running" }, false), 2000);
  assert.equal(updatePollDelay(undefined, true), 2000);
  assert.equal(updatePollDelay(base, false), 15 * 60_000);
});

test("ago reads in minutes and hours", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  assert.equal(ago(undefined, now), "not yet");
  assert.equal(ago("2026-10-15T11:59:40Z", now), "just now");
  assert.equal(ago("2026-10-15T11:30:00Z", now), "30 min ago");
  assert.equal(ago("2026-10-15T09:00:00Z", now), "3 h ago");
});

test("the join command names the platform, the node and the pinned fingerprint", () => {
  const command = joinCommand({ platform: { url: "https://p.example/", fingerprint: "abc" }, nodeId: "worker-1", token: "t0k" });
  assert.equal(command, "zelavis worker join --platform-url https://p.example/zelavis --node-id worker-1 --enrollment-token t0k --platform-fingerprint sha256:abc");
  assert.ok(isValidNodeId("worker-1") && !isValidNodeId("Worker_1"));
  assert.match(describeScaleOutOutcome("at-limit"), /machine limit/);
});
