import assert from "node:assert/strict";
import test from "node:test";

import { createAgentPlacementLeaseSupervisor } from "../dist/core/agent/placement-lease.js";

const identity = {
  projectId: "project-a", nodeId: "node-a", ownerSession: "session-a", epoch: 3,
};

function clock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
  };
}

test("Agent fences immediately on foreign or missing authority", async () => {
  const time = clock();
  let placement = { ...identity, state: "active", leaseExpiresAt: 1000, authorityNow: 0 };
  let stops = 0;
  const supervisor = createAgentPlacementLeaseSupervisor({
    identity,
    read: async () => placement,
    onFence: () => { stops += 1; },
    monotonicNow: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  });
  assert.equal(await supervisor.start(), true);
  placement = { ...placement, ownerSession: "session-b" };
  assert.equal(await supervisor.check(), false);
  assert.equal(supervisor.fenced, true);
  assert.equal(stops, 1);
  assert.equal(await supervisor.check(), false);
  assert.equal(stops, 1);
});

test("Agent uses a conservative monotonic expiry even while renewal hangs", async () => {
  const time = clock();
  let pending;
  let reads = 0;
  let stops = 0;
  const supervisor = createAgentPlacementLeaseSupervisor({
    identity,
    read: async () => {
      reads += 1;
      if (reads === 1) return { ...identity, state: "active", leaseExpiresAt: 100, authorityNow: 0 };
      return new Promise((resolve) => { pending = resolve; });
    },
    onFence: () => { stops += 1; },
    monotonicNow: time.now,
    checkIntervalMs: 10,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  });
  assert.equal(await supervisor.start(), true);
  time.advance(10);
  await Promise.resolve();
  assert.equal(reads, 2);
  time.advance(90);
  assert.equal(supervisor.fenced, true);
  assert.equal(stops, 1);
  pending({ ...identity, state: "active", leaseExpiresAt: 1000, authorityNow: 0 });
  await Promise.resolve();
  assert.equal(supervisor.fenced, true);
});

test("transport delay consumes lease time and cannot extend it", async () => {
  const time = clock();
  let release;
  const supervisor = createAgentPlacementLeaseSupervisor({
    identity,
    read: () => new Promise((resolve) => { release = resolve; }),
    onFence: () => {},
    monotonicNow: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  });
  const starting = supervisor.start();
  time.advance(150);
  release({ ...identity, state: "active", leaseExpiresAt: 100, authorityNow: 0 });
  assert.equal(await starting, false);
  assert.equal(supervisor.fenced, true);
});

test("a failed stop is retried while authority stays fenced", async () => {
  const time = clock();
  let attempts = 0;
  const supervisor = createAgentPlacementLeaseSupervisor({
    identity,
    read: async () => ({ ...identity, state: "active", leaseExpiresAt: 10, authorityNow: 0 }),
    onFence: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary stop failure");
    },
    monotonicNow: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  });
  assert.equal(await supervisor.start(), true);
  time.advance(10);
  await Promise.resolve();
  assert.equal(supervisor.fenced, true);
  time.advance(1000);
  await Promise.resolve();
  assert.equal(attempts, 2);
});

test("a wall-clock step backward cannot extend an unchanged published expiry", async () => {
  const time = clock();
  let authorityNow = 0;
  const supervisor = createAgentPlacementLeaseSupervisor({
    identity,
    read: async () => ({ ...identity, state: "active", leaseExpiresAt: 100,
      authorityNow }),
    onFence: () => {},
    monotonicNow: time.now,
    checkIntervalMs: 200,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  });
  assert.equal(await supervisor.start(), true);
  time.advance(50);
  authorityNow = -100;
  assert.equal(await supervisor.check(), true);
  time.advance(50);
  assert.equal(supervisor.fenced, true);
});
