import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createProjectPlacementAuthority,
  deleteProjectPlacementAuthority,
} from "../dist/platform/project-placement-authority.js";
import { createMemorySystemStore } from "../dist/system-store.js";
import { createLocalSqliteSystemStore } from "../dist/adapters/_sqlite-system-store.js";

const acquire = (overrides = {}) => ({
  projectId: "project-a", nodeId: "node-a", ownerSession: "session-a",
  expectedEpoch: 0, leaseMs: 1000, ...overrides,
});
const token = (record) => ({
  projectId: record.projectId,
  nodeId: record.nodeId,
  ownerSession: record.ownerSession,
  epoch: record.epoch,
});

test("placement CAS preserves a high-water epoch across release and same-Node activation", async () => {
  const store = createMemorySystemStore();
  let now = 1000;
  const make = () => createProjectPlacementAuthority({
    store, now: () => now, mayPlace: (_, nodeId) => nodeId === "node-a",
    fencePrevious: () => true,
  });
  const authority = make();
  assert.equal((await authority.acquire(acquire({ nodeId: "node-b" }))).reason, "policy-refused");
  const first = await authority.acquire(acquire());
  assert.equal(first.granted, true);
  assert.equal(first.placement.epoch, 1);
  assert.equal(await make().validate(token(first.placement)), true);
  assert.equal((await make().acquire(acquire({ expectedEpoch: 1,
    ownerSession: "session-b" }))).reason, "owned");

  const renewed = await authority.renew(token(first.placement), 1500);
  assert.equal(renewed.granted, true);
  assert.equal(renewed.placement.epoch, 1);
  assert.ok(renewed.placement.leaseExpiresAt >= 2500);
  const released = await authority.release(token(first.placement));
  assert.equal(released.granted, true);
  assert.equal(await authority.validate(token(first.placement)), false);

  const second = await make().acquire(acquire({ expectedEpoch: 1,
    ownerSession: "session-b" }));
  assert.equal(second.granted, true);
  assert.equal(second.placement.epoch, 2);
  assert.equal((await authority.renew(token(first.placement), 1000)).reason, "stale");
  assert.equal((await authority.release(token(first.placement))).reason, "stale");
  assert.equal((await authority.acquire(acquire())).reason, "stale");
  now = 3000;
  assert.equal(await make().validate(token(second.placement)), false);
  assert.equal((await authority.renew(token(second.placement), 1000)).reason, "expired");
  const third = await authority.acquire(acquire({ expectedEpoch: 2,
    ownerSession: "session-c" }));
  assert.equal(third.granted, true);
  assert.equal(third.placement.epoch, 3);
});

test("concurrent activation of an absent record has exactly one owner", async () => {
  const store = createMemorySystemStore();
  let waiting = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const authority = createProjectPlacementAuthority({
    store, now: () => 1000,
    mayPlace: async () => {
      waiting += 1;
      if (waiting === 2) release();
      await gate;
      return true;
    },
  });
  const [left, right] = await Promise.all([
    authority.acquire(acquire()),
    authority.acquire(acquire({ nodeId: "node-b", ownerSession: "session-b" })),
  ]);
  assert.equal([left, right].filter((result) => result.granted).length, 1);
  assert.equal([left, right].find((result) => !result.granted).reason, "contended");
});

test("expired ownership refuses takeover without destination fencing", async () => {
  const store = createMemorySystemStore();
  let now = 1000;
  const authority = createProjectPlacementAuthority({
    store, now: () => now, mayPlace: () => true,
  });
  const first = await authority.acquire(acquire());
  assert.equal(first.granted, true);
  now = 3000;
  assert.equal((await authority.acquire(acquire({ expectedEpoch: 1,
    ownerSession: "session-b" }))).reason, "fencing-unavailable");
  assert.equal((await authority.current("project-a")).epoch, 1);
});

test("SQLite survives reopen and deletion cleanup removes only this Project", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-placement-"));
  try {
    const file = join(directory, "system.sqlite");
    const make = (store) => createProjectPlacementAuthority({
      store, now: () => 1000, mayPlace: () => true,
    });
    const firstStore = createLocalSqliteSystemStore({ filename: file });
    const first = await make(firstStore).acquire(acquire());
    assert.equal(first.granted, true);
    await firstStore.close();

    const reopened = createLocalSqliteSystemStore({ filename: file });
    assert.equal((await make(reopened).current("project-a")).epoch, 1);
    assert.equal((await make(reopened).acquire(acquire({ expectedEpoch: 1,
      ownerSession: "session-b" }))).reason, "owned");
    await deleteProjectPlacementAuthority(reopened, "project-a");
    await deleteProjectPlacementAuthority(reopened, "project-a");
    assert.equal(await make(reopened).current("project-a"), undefined);
    await reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
