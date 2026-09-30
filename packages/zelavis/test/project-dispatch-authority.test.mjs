import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgentNonceTracker,
  createProjectDispatchNonceConsumer,
  receiveProjectDispatch,
  signProjectDispatchAuthority,
  verifyProjectDispatchAuthority,
} from "../dist/index.js";
import { createLocalSqliteSystemStore } from "../dist/adapters/_sqlite-system-store.js";

test("Project dispatch authority binds Agent, action and current placement", async () => {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"],
  );
  const now = Date.now();
  const key = {
    keyId: "platform-a",
    publicKey: Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64"),
    notBefore: new Date(now - 60_000).toISOString(),
    notAfter: new Date(now + 60_000).toISOString(),
  };
  const claims = {
    keyId: key.keyId,
    agentId: "agent-a",
    action: "start",
    projectId: "project-a",
    nodeId: "node-a",
    ownerSession: "session-a",
    epoch: 3,
    issuedAt: now,
    expiresAt: now + 30_000,
    nonce: "nonce-a",
  };
  const placement = {
    projectId: claims.projectId,
    nodeId: claims.nodeId,
    ownerSession: claims.ownerSession,
    epoch: claims.epoch,
    state: "active",
    leaseExpiresAt: now + 60_000,
  };
  const trust = { keys: [key] };
  const token = await signProjectDispatchAuthority(privateKey, claims);
  const consumeNonce = createAgentNonceTracker();
  const verify = (overrides = {}, authority = token, store = consumeNonce) =>
    verifyProjectDispatchAuthority(trust, authority, {
      agentId: claims.agentId, action: claims.action, placement,
      now: now + 1, consumeNonce: store, ...overrides,
    });

  assert.deepEqual(await verify(), claims);
  assert.equal(await verify(), undefined, "replay must be refused");
  for (const options of [
    { agentId: "agent-b" },
    { action: "stop" },
    { placement: { ...placement, nodeId: "node-b" } },
    { placement: { ...placement, epoch: 4 } },
    { placement: { ...placement, ownerSession: "session-b" } },
    { placement: { ...placement, state: "released" } },
    { placement: { ...placement, leaseExpiresAt: now } },
    { now: now + 30_000 },
  ]) {
    assert.equal(await verify(options, token, createAgentNonceTracker()), undefined);
  }
  const [payload, signature] = token.split(".");
  assert.equal(await verify({}, `${payload.slice(0, -1)}A.${signature}`, createAgentNonceTracker()), undefined);
  assert.equal(await verify({}, `${token}=`, createAgentNonceTracker()), undefined);
  assert.equal(await verify({ now: now + 1, placement: { ...placement, leaseExpiresAt: now } },
    token, createAgentNonceTracker()), undefined);
});

test("Project dispatch authority rejects oversized grants", async () => {
  const { privateKey } = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"],
  );
  const now = Date.now();
  await assert.rejects(signProjectDispatchAuthority(privateKey, {
    keyId: "platform-a", agentId: "agent-a", action: "start",
    projectId: "project-a", nodeId: "node-a", ownerSession: "session-a",
    epoch: 1, issuedAt: now, expiresAt: now + 60_001, nonce: "nonce-a",
  }), TypeError);
});

test("destination consumes signed authority durably before the operation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-dispatch-nonce-"));
  const filename = join(directory, "nonces.sqlite");
  const now = Date.now();
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"],
  );
  const claims = {
    keyId: "platform-a", agentId: "agent-a", action: "start",
    projectId: "project-a", nodeId: "node-a", ownerSession: "session-a",
    epoch: 2, issuedAt: now, expiresAt: now + 30_000, nonce: "nonce-a",
  };
  const trust = { keys: [{
    keyId: claims.keyId,
    publicKey: Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64"),
    notBefore: new Date(now - 60_000).toISOString(),
    notAfter: new Date(now + 60_000).toISOString(),
  }] };
  const token = await signProjectDispatchAuthority(privateKey, claims);
  const placement = {
    projectId: claims.projectId, nodeId: claims.nodeId,
    ownerSession: claims.ownerSession, epoch: claims.epoch,
    state: "active", leaseExpiresAt: now + 60_000,
  };
  const store = createLocalSqliteSystemStore({ filename });
  let executions = 0;
  const request = (consumer, overrides = {}) => receiveProjectDispatch({
    trust, token, agentId: claims.agentId, action: claims.action,
    projectId: claims.projectId, nodeId: claims.nodeId,
    readPlacement: async () => placement,
    consumeNonce: consumer.consume,
    execute: async () => { executions += 1; return "started"; },
    ...overrides,
  });
  try {
    const first = createProjectDispatchNonceConsumer(store, claims.agentId);
    assert.equal(await request(first), "started");
    await store.close?.();
    const reopened = createLocalSqliteSystemStore({ filename });
    try {
      const second = createProjectDispatchNonceConsumer(reopened, claims.agentId);
      await assert.rejects(request(second), /invalid or stale/);
      assert.equal(executions, 1);
      await assert.rejects(request(second, {
        readPlacement: async () => ({ ...placement, epoch: 3 }),
      }), /invalid or stale/);
      assert.equal(await second.sweepExpired(now + 30_001), 1);
    } finally {
      await reopened.close?.();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
