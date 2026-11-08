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

test("a standby dispatch carries a signed lease environment, needs no placement, and is bound to its Node", async () => {
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const now = Date.now();
  const key = {
    keyId: "platform-a",
    publicKey: Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64"),
    notBefore: new Date(now - 60_000).toISOString(),
    notAfter: new Date(now + 60_000).toISOString(),
  };
  const trust = { keys: [key] };
  const lease = { ZELAVIS_LEASE_ROLE: "standby", ZELAVIS_LEASE_NODE: "node-b", ZELAVIS_LEASE_TOKEN: "t" };
  const claims = (overrides = {}) => ({ keyId: key.keyId, agentId: "agent-b", action: "standby", projectId: "project-a", nodeId: "node-b",
    ownerSession: "session-a", epoch: 1, issuedAt: now, expiresAt: now + 30_000, nonce: `nonce-${Math.random()}`, lease, ...overrides });
  const verify = (token, overrides = {}) => verifyProjectDispatchAuthority(trust, token, {
    agentId: "agent-b", action: "standby", nodeId: "node-b", now: now + 1, consumeNonce: createAgentNonceTracker(), ...overrides,
  });

  const signed = claims();
  const accepted = await verify(await signProjectDispatchAuthority(privateKey, signed));
  assert.deepEqual(accepted.lease, lease, "the lease environment arrives as signed");
  assert.equal(accepted.action, "standby");
  assert.equal((await verify(await signProjectDispatchAuthority(privateKey, signed), { nodeId: "node-c" })), undefined, "another Node's Agent refuses it");
  assert.equal((await verify(await signProjectDispatchAuthority(privateKey, signed), { action: "start" })), undefined, "and it is no start");

  // Altering any value breaks the signature.
  const token = await signProjectDispatchAuthority(privateKey, signed);
  const [payload, signature] = token.split(".");
  const altered = Buffer.from(Buffer.from(payload, "base64url").toString("utf8").replace('"standby"],["ZELAVIS_LEASE_TOKEN"', '"writer"],["ZELAVIS_LEASE_TOKEN"')).toString("base64url");
  assert.notEqual(altered, payload, "the test altered a value");
  assert.equal(await verify(`${altered}.${signature}`), undefined);

  // No lease at all still verifies; the bounds are enforced at signing.
  assert.equal((await verify(await signProjectDispatchAuthority(privateKey, claims({ lease: undefined })))).lease, undefined);
  await assert.rejects(signProjectDispatchAuthority(privateKey, claims({ lease: { NOT_A_LEASE_KEY: "x" } })), /invalid or unbounded/);
  await assert.rejects(signProjectDispatchAuthority(privateKey, claims({ lease: Object.fromEntries(Array.from({ length: 9 }, (_, at) => [`ZELAVIS_LEASE_K${String.fromCharCode(65 + at)}`, "x"])) })), /invalid or unbounded/);
  await assert.rejects(signProjectDispatchAuthority(privateKey, claims({ lease: { ZELAVIS_LEASE_TOKEN: "x".repeat(2049) } })), /invalid or unbounded/);
});

test("a start dispatch carries a signed App shard environment, and altering or widening it is refused", async () => {
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const now = Date.now();
  const key = { keyId: "platform-a", publicKey: Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64"), notBefore: new Date(now - 60_000).toISOString(), notAfter: new Date(now + 60_000).toISOString() };
  const trust = { keys: [key] };
  const appShards = { ZELAVIS_APP_SHARDS_AUTHORITY: "http://x/api/v1", ZELAVIS_APP_SHARDS_TOKEN: "token" };
  const claims = (overrides = {}) => ({ keyId: key.keyId, agentId: "agent-b", action: "start", projectId: "p1", nodeId: "node-b", ownerSession: "session-a", epoch: 2,
    issuedAt: now, expiresAt: now + 30_000, nonce: `nonce-${Math.random()}`, appShards, ...overrides });
  const placement = { projectId: "p1", nodeId: "node-b", ownerSession: "session-a", epoch: 2, state: "active", leaseExpiresAt: now + 60_000 };
  const verify = (token) => verifyProjectDispatchAuthority(trust, token, { agentId: "agent-b", action: "start", placement, now: now + 1, consumeNonce: createAgentNonceTracker() });

  const token = await signProjectDispatchAuthority(privateKey, claims());
  assert.deepEqual((await verify(token)).appShards, appShards, "the shard environment arrives as signed");
  const [payload, signature] = token.split(".");
  const altered = Buffer.from(Buffer.from(payload, "base64url").toString("utf8").replace('"token"', '"other"')).toString("base64url");
  assert.notEqual(altered, payload, "the test altered a value");
  assert.equal(await verify(`${altered}.${signature}`), undefined);
  assert.equal((await verify(await signProjectDispatchAuthority(privateKey, claims({ appShards: undefined })))).appShards, undefined);
  await assert.rejects(signProjectDispatchAuthority(privateKey, claims({ appShards: { ZELAVIS_LEASE_TOKEN: "x" } })), /invalid or unbounded/);
  await assert.rejects(signProjectDispatchAuthority(privateKey, claims({ appShards: Object.fromEntries(Array.from({ length: 5 }, (_, at) => [`ZELAVIS_APP_SHARDS_K${String.fromCharCode(65 + at)}`, "x"])) })), /invalid or unbounded/);
});

test("a route authority binds the one request the Agent forwards, and is fenced by the committed placement", async () => {
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const now = Date.now();
  const key = { keyId: "platform-a", publicKey: Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64"), notBefore: new Date(now - 60_000).toISOString(), notAfter: new Date(now + 60_000).toISOString() };
  const trust = { keys: [key] };
  const gateway = { projectId: "p1", scopeId: "platform", generation: 2, runtimeNodeId: "node-b", subject: "owner", subjectType: "user", tenantId: "owner", permissions: ["database.read"] };
  const claims = (overrides = {}) => ({ keyId: key.keyId, agentId: "agent-b", action: "route", projectId: "p1", nodeId: "node-b", ownerSession: "session-a", epoch: 2,
    issuedAt: now, expiresAt: now + 30_000, nonce: `nonce-${Math.random()}`, route: { method: "POST", path: "/zelavis/api/v1/database/documents?x=1", gateway }, ...overrides });
  const placement = { projectId: "p1", nodeId: "node-b", ownerSession: "session-a", epoch: 2, state: "active", leaseExpiresAt: now + 60_000 };
  const verify = (token, overrides = {}) => verifyProjectDispatchAuthority(trust, token, { agentId: "agent-b", action: "route", placement, now: now + 1, consumeNonce: createAgentNonceTracker(), ...overrides });

  const token = await signProjectDispatchAuthority(privateKey, claims());
  const accepted = await verify(token);
  assert.deepEqual([accepted.route.method, accepted.route.path, accepted.route.gateway.subject], ["POST", "/zelavis/api/v1/database/documents?x=1", "owner"]);
  assert.equal(await verify(token, { placement: { ...placement, epoch: 3 } }), undefined, "a stale placement epoch is refused");
  assert.equal(await verify(token, { placement: { ...placement, ownerSession: "session-b" } }), undefined, "and another Platform session");
  assert.equal(await verify(token, { action: "start" }), undefined, "it is no start");

  const [payload, signature] = token.split(".");
  const altered = Buffer.from(Buffer.from(payload, "base64url").toString("utf8").replace("documents?x=1", "documents?x=2")).toString("base64url");
  assert.equal(await verify(`${altered}.${signature}`), undefined, "the path is signed");

  await assert.rejects(signProjectDispatchAuthority(privateKey, claims({ route: undefined })), /invalid or unbounded/);
  await assert.rejects(signProjectDispatchAuthority(privateKey, claims({ route: { method: "POST", path: "//elsewhere/x", gateway } })), /invalid or unbounded/);
  await assert.rejects(signProjectDispatchAuthority(privateKey, claims({ route: { method: "TRACE", path: "/x", gateway } })), /invalid or unbounded/);
  await assert.rejects(signProjectDispatchAuthority(privateKey, claims({ action: "start" })), /invalid or unbounded/, "a start carries no route");
});
