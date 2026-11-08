import assert from "node:assert/strict";
import test from "node:test";

import { createMemorySystemStore } from "../dist/index.js";
import {
  appShardKey, createAppShardHighWaterStore, signAppShardAccess, signAppShardGrant,
  verifyAppShardAccess, verifyAppShardGrant,
} from "../dist/core/agent/app-shard-grant.js";

async function setup() {
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const now = Date.now();
  const trust = { keys: [{ keyId: "k1", publicKey: Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64"),
    notBefore: new Date(now - 60_000).toISOString(), notAfter: new Date(now + 600_000).toISOString() }] };
  return { privateKey, trust, now };
}
const ids = { agentId: "agent-b", nodeId: "node-b", projectId: "p", incarnation: "inc", shardId: "shard-1", epoch: 1 };
const grantOf = (now, extra = {}) => ({ keyId: "k1", ...ids, state: "committed", durability: "crash", issuedAt: now, expiresAt: now + 30_000, ...extra });
const accessOf = (now, extra = {}) => ({ keyId: "k1", ...ids, issuedAt: now, expiresAt: now + 120_000, ...extra });
const flip = (token) => {
  const [body, sig] = token.split(".");
  const bytes = Buffer.from(body, "base64url");
  bytes[bytes.length - 3] ^= 1;
  return `${bytes.toString("base64url")}.${sig}`;
};

test("grants and access tokens round trip, and only for their own audience", async () => {
  const { privateKey, trust, now } = await setup();
  const grant = await signAppShardGrant(privateKey, grantOf(now));
  assert.deepEqual(await verifyAppShardGrant(trust, grant, "agent-b", "node-b", now), grantOf(now));
  assert.equal(await verifyAppShardGrant(trust, grant, "agent-c", "node-b", now), undefined);
  assert.equal(await verifyAppShardGrant(trust, grant, "agent-b", "node-c", now), undefined);
  const access = await signAppShardAccess(privateKey, accessOf(now));
  assert.deepEqual(await verifyAppShardAccess(trust, access, "agent-b", "node-b", now), accessOf(now));
  assert.equal(await verifyAppShardAccess(trust, access, "agent-c", "node-b", now), undefined);
  assert.equal(await verifyAppShardAccess(trust, access, "agent-b", "node-c", now), undefined);
});

test("expired, unbounded, tampered, cross-kind and unknown-key tokens are refused", async () => {
  const { privateKey, trust, now } = await setup();
  const grant = await signAppShardGrant(privateKey, grantOf(now));
  assert.equal(await verifyAppShardGrant(trust, grant, "agent-b", "node-b", now + 30_001), undefined);
  await assert.rejects(signAppShardGrant(privateKey, grantOf(now, { expiresAt: now + 30_001 })), TypeError);
  await assert.rejects(signAppShardAccess(privateKey, accessOf(now, { expiresAt: now + 120_001 })), TypeError);
  await assert.rejects(signAppShardGrant(privateKey, grantOf(now, { epoch: 0 })), TypeError);
  assert.equal(await verifyAppShardGrant(trust, flip(grant), "agent-b", "node-b", now), undefined);
  const access = await signAppShardAccess(privateKey, accessOf(now));
  assert.equal(await verifyAppShardAccess(trust, grant, "agent-b", "node-b", now), undefined);
  assert.equal(await verifyAppShardGrant(trust, access, "agent-b", "node-b", now), undefined);
  const other = await signAppShardGrant(privateKey, grantOf(now, { keyId: "unknown" }));
  assert.equal(await verifyAppShardGrant(trust, other, "agent-b", "node-b", now), undefined);
});

test("the high-water only moves forward, through epochs and states", async () => {
  const { now } = await setup();
  const store = createAppShardHighWaterStore(createMemorySystemStore());
  const key = appShardKey("p", "inc", "shard-1");
  const grant = (epoch, state) => grantOf(now, { epoch, state });
  assert.equal(await store.read(key), undefined);
  assert.equal((await store.accept(grant(1, "preparing"))).state, "preparing");
  assert.equal((await store.accept(grant(1, "committed"))).state, "committed");
  assert.equal((await store.accept(grant(1, "committed"))).state, "committed");
  assert.equal((await store.accept(grant(1, "released"))).state, "released");
  await assert.rejects(store.accept(grant(1, "committed")), /stale/);
  assert.equal((await store.accept(grant(2, "preparing"))).epoch, 2);
  await assert.rejects(store.accept(grant(1, "preparing")), /stale/);
  await store.accept(grant(2, "committed"));
  await assert.rejects(store.accept(grant(1, "committed")), /stale/);
  assert.deepEqual(await store.read(key), { schemaVersion: 1, projectId: "p", incarnation: "inc", shardId: "shard-1", epoch: 2, state: "committed", durability: "crash" });
});

test("concurrent grants end at the highest epoch", async () => {
  const { now } = await setup();
  const store = createAppShardHighWaterStore(createMemorySystemStore());
  const results = await Promise.allSettled([
    store.accept(grantOf(now, { epoch: 1 })), store.accept(grantOf(now, { epoch: 2 })),
  ]);
  assert.ok(results.some((r) => r.status === "fulfilled"));
  await store.accept(grantOf(now, { epoch: 2 })).catch(() => undefined);
  assert.equal((await store.read(appShardKey("p", "inc", "shard-1"))).epoch, 2);
});

test("pruning forgets only shards released long ago, and never one still in use", async () => {
  const { now } = await setup();
  const store = createAppShardHighWaterStore(createMemorySystemStore());
  const grant = (shardId, state, epoch = 1) => ({ ...grantOf(now, { state, epoch }), shardId });
  await store.accept(grant("old", "released"));
  await store.accept(grant("live", "committed"));
  await store.accept(grant("opening", "preparing"));
  const day = 24 * 3_600_000;
  const prune = (at, limit = 100) => store.prune({ now: at, olderThanMillis: day, limit });
  assert.equal(await prune(Date.now() + 3_600_000), 0, "a record released an hour ago is kept");
  assert.equal(await prune(Date.now() + 2 * day, 0), 0, "the limit bounds a call");
  assert.equal(await prune(Date.now() + 2 * day), 1, "a record released two days ago goes");
  assert.equal(await store.read(appShardKey("p", "inc", "old")), undefined);
  assert.equal((await store.read(appShardKey("p", "inc", "live"))).state, "committed", "a committed shard is never pruned");
  assert.equal((await store.read(appShardKey("p", "inc", "opening"))).state, "preparing");
  assert.equal(await prune(Date.now() + 2 * day), 0);
});

test("an Agent host forgets a released shard's record once the retention has passed", async (t) => {
  const { privateKey, trust, now } = await setup();
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createRemoteShardHost } = await import("../dist/adapters/_remote-shard-host.js");
  const directory = await mkdtemp(join(tmpdir(), "zv-prune-"));
  const store = createMemorySystemStore();
  const host = createRemoteShardHost({ dataDirectory: directory, store, trust: () => trust, agentId: "agent-b", nodeId: "node-b", sweepEveryMillis: 20, retainReleasedMillis: 150 });
  t.after(async () => { await host.close(); await rm(directory, { recursive: true, force: true }); });
  for (const state of ["preparing", "committed", "released"]) await host.applyGrant(await signAppShardGrant(privateKey, grantOf(now, { state })));
  const key = appShardKey("p", "inc", "shard-1");
  const records = createAppShardHighWaterStore(store);
  assert.equal((await records.read(key)).state, "released", "kept while it is recent");
  const end = Date.now() + 10_000;
  while (Date.now() < end && await records.read(key) !== undefined) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(await records.read(key), undefined, "forgotten after the retention");
});
