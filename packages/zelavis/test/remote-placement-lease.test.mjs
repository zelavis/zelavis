import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRemotePlacementLeaseStore,
  signRemotePlacementGrant,
} from "../dist/index.js";
import { createLocalSqliteSystemStore } from "../dist/adapters/_sqlite-system-store.js";

test("remote Agent persists lease high-water and fences before a newer epoch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-remote-lease-"));
  const filename = join(directory, "agent.sqlite");
  const now = Date.now();
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"],
  );
  const trust = { keys: [{
    keyId: "platform-a",
    publicKey: Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64"),
    notBefore: new Date(now - 60_000).toISOString(),
    notAfter: new Date(now + 60_000).toISOString(),
  }] };
  const first = {
    schemaVersion: 1, authority: "platform", projectId: "project-a",
    nodeId: "node-b", ownerSession: "session-a", epoch: 1, revision: 1,
    leaseExpiresAt: now + 30_000, state: "active",
  };
  const grant = (placement) => signRemotePlacementGrant(privateKey, {
    keyId: "platform-a", agentId: "agent-b", placement,
    issuedAt: now, expiresAt: now + 20_000,
  });
  let fenced = false;
  let calls = 0;
  const make = (store) => createRemotePlacementLeaseStore({
    store, trust, agentId: "agent-b", nodeId: "node-b",
    fencePrevious: async (placement) => {
      calls += 1;
      assert.equal(placement.epoch, 1);
      return fenced;
    },
  });
  const store = createLocalSqliteSystemStore({ filename });
  try {
    const leases = make(store);
    assert.equal((await leases.accept(await grant(first))).epoch, 1);
    assert.equal((await leases.read("project-a")).leaseExpiresAt, first.leaseExpiresAt);
    await store.close?.();
    const reopened = createLocalSqliteSystemStore({ filename });
    try {
      const afterRestart = make(reopened);
      const second = { ...first, ownerSession: "session-b", epoch: 2, revision: 2,
        leaseExpiresAt: now + 40_000 };
      await assert.rejects(afterRestart.accept(await grant(second)), /not been fenced/);
      fenced = true;
      assert.equal((await afterRestart.accept(await grant(second))).epoch, 2);
      assert.equal(calls, 2);
      await assert.rejects(afterRestart.accept(await grant(first)), /stale/);
      assert.equal(await afterRestart.release(first), false);
      assert.equal(await afterRestart.release(second), true);
      assert.equal((await afterRestart.read("project-a")).state, "released");
    } finally {
      await reopened.close?.();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
