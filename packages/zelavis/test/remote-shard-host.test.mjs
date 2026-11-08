import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createMemorySystemStore } from "../dist/index.js";
import { createRemoteProjectAgent } from "../dist/adapters/_remote-project-agent.js";
import { createRemoteShardHost } from "../dist/adapters/_remote-shard-host.js";
import { createHttpsProjectDispatcher } from "../dist/adapters/_project-dispatch-https.js";
import { appShardKey, signAppShardAccess, signAppShardGrant } from "../dist/core/agent/app-shard-grant.js";

const run = promisify(execFile);
const b64 = (text) => Buffer.from(text).toString("base64url");
const text = (value) => Buffer.from(value, "base64url").toString();

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zv-shard-"));
  const keyFile = join(root, "tls.key"), certFile = join(root, "tls.crt");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"]);
  const [keyPem, certPem] = await Promise.all([readFile(keyFile, "utf8"), readFile(certFile, "utf8")]);
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const now = Date.now();
  const trust = { keys: [{ keyId: "platform-test", publicKey: Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64"), notBefore: new Date(now - 60_000).toISOString(), notAfter: new Date(now + 600_000).toISOString() }] };
  const start = () => createRemoteProjectAgent({ dataDirectory: join(root, "agent"), host: "localhost", port: 0, keyPem, certPem, trust: () => trust, agentId: "agent-b", nodeId: "node-b" });
  const dispatcherFor = (agent) => createHttpsProjectDispatcher({ localNodeId: "node-a", projectsDirectory: join(root, "platform"), keyId: "platform-test", privateKey,
    destinations: { "node-b": { url: agent.address, agentId: "agent-b", caPem: certPem } } });
  return { root, certPem, privateKey, trust, start, dispatcherFor };
}

const shard = { nodeId: "node-b", projectId: "p", incarnation: "inc", shardId: "shard-1" };
const post = (agent, certPem, path, body) => new Promise((resolve, reject) => {
  const url = new URL(agent.address);
  const payload = JSON.stringify(body);
  const req = httpsRequest({ hostname: url.hostname, port: url.port, path, method: "POST", ca: certPem,
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (res) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") }));
  });
  req.on("error", reject);
  req.end(payload);
});
const kvOf = (agent, certPem) => (access, op, fields = {}) => post(agent, certPem, "/v1/shards/kv", { access, op, ...fields });

test("a remote Agent hosts a shard under grants, fenced by epoch, over TLS", { timeout: 60_000 }, async () => {
  const f = await fixture();
  let agent = await f.start();
  try {
    const dispatcher = f.dispatcherFor(agent);
    let kv = kvOf(agent, f.certPem);
    const grant = (epoch, state) => dispatcher.deliverAppShardGrant({ ...shard, epoch, state, durability: "crash" });
    const token = async (epoch, extra = {}) => (await dispatcher.authorizeAppShardAccess({ ...shard, epoch, ...extra })).token;
    const hash = createHash("sha256").update(appShardKey("p", "inc", "shard-1")).digest("hex");
    const file = join(f.root, "agent", "shards", hash, "shard-1.sqlite");

    // 1. preparing, then committed.
    assert.deepEqual(await grant(1, "preparing"), { state: "preparing", epoch: 1 });
    assert.deepEqual((await kv(await token(1), "get", { key: b64("k") })), { status: 409, body: { code: "not-committed" } });
    await grant(1, "committed");
    const t1 = await token(1);
    assert.equal((await kv(t1, "write", { writes: [{ op: "put", key: b64("k"), value: b64("v") }] })).status, 200);
    assert.equal(text((await kv(t1, "get", { key: b64("k") })).body.value), "v");
    assert.ok(existsSync(file));

    // 3. conditional writes are atomic.
    assert.deepEqual((await kv(t1, "conditionalWrite", { writes: [{ op: "put", key: b64("other"), value: b64("x") }], conditions: [{ key: b64("k"), value: b64("nope") }] })).body, { accepted: false });
    assert.equal((await kv(t1, "get", { key: b64("other") })).body.value, null);
    assert.deepEqual((await kv(t1, "conditionalWrite", { writes: [{ op: "put", key: b64("k"), value: b64("v2") }], conditions: [{ key: b64("k"), value: b64("v") }] })).body, { accepted: true });
    assert.equal(text((await kv(t1, "get", { key: b64("k") })).body.value), "v2");

    // 2. a newer epoch refuses the older token.
    await grant(2, "committed");
    assert.deepEqual(await kv(t1, "get", { key: b64("k") }), { status: 409, body: { code: "stale-epoch" } });
    const t2 = await token(2);
    assert.equal(text((await kv(t2, "get", { key: b64("k") })).body.value), "v2");
    assert.equal((await kv(await token(3), "get", { key: b64("k") })).body.code, "not-committed");

    // 4. scan paging with cursors.
    const writes = Array.from({ length: 1500 }, (_, i) => ({ op: "put", key: b64(`s/${String(i).padStart(5, "0")}`), value: b64(`v${i}`) }));
    await kv(t2, "write", { writes });
    const collect = async (fields) => {
      const keys = [];
      let answer = await kv(t2, "scan", fields);
      assert.equal(answer.status, 200);
      for (;;) {
        keys.push(...answer.body.entries.map(([key]) => text(key)));
        if (!answer.body.cursor) return keys;
        answer = await kv(t2, "next", { cursor: answer.body.cursor });
      }
    };
    const first = await kv(t2, "scan", { prefix: b64("s/") });
    assert.equal(first.body.entries.length, 512);
    assert.ok(first.body.cursor);
    await kv(t2, "closeCursor", { cursor: first.body.cursor });
    assert.equal((await kv(t2, "next", { cursor: first.body.cursor })).status, 404);
    const expected = Array.from({ length: 1500 }, (_, i) => `s/${String(i).padStart(5, "0")}`);
    assert.deepEqual(await collect({ prefix: b64("s/") }), expected);
    assert.deepEqual(await collect({ prefix: b64("s/"), reverse: true }), [...expected].reverse());
    assert.equal((await collect({ prefix: b64("s/"), limit: 700 })).length, 700);

    // 5. a snapshot is a consistent view.
    const snapshot = (await kv(t2, "snapshot")).body.snapshot;
    await kv(t2, "write", { writes: [{ op: "put", key: b64("late"), value: b64("1") }] });
    assert.equal((await kv(t2, "get", { key: b64("late"), snapshot })).body.value, null);
    assert.equal(text((await kv(t2, "get", { key: b64("late") })).body.value), "1");
    await kv(t2, "closeSnapshot", { snapshot });
    assert.equal((await kv(t2, "get", { key: b64("late"), snapshot })).status, 404);

    // 6. at most 64 snapshots per shard.
    const held = [];
    for (let i = 0; i < 64; i += 1) held.push((await kv(t2, "snapshot")).body.snapshot);
    assert.deepEqual(await kv(t2, "snapshot"), { status: 503, body: { code: "busy" } });
    // 7. a cursor id is bound to its shard.
    const otherShard = { ...shard, shardId: "shard-2" };
    await dispatcher.deliverAppShardGrant({ ...otherShard, epoch: 1, state: "committed", durability: "crash" });
    const other = (await dispatcher.authorizeAppShardAccess({ ...otherShard, epoch: 1 })).token;
    assert.equal((await kv(other, "get", { key: b64("k"), snapshot: held[0] })).status, 404);
    assert.equal((await kv(other, "get", { key: b64("k") })).body.value, null);
    // A token minted for another Agent or an unknown shard owner is unauthorized.
    const foreign = await signAppShardAccess(f.privateKey, { keyId: "platform-test", agentId: "agent-c", nodeId: "node-b", ...shard, epoch: 2, issuedAt: Date.now(), expiresAt: Date.now() + 60_000 });
    assert.deepEqual(await kv(foreign, "get", { key: b64("k") }), { status: 401, body: { code: "unauthorized" } });
    assert.equal((await kv("garbage", "get", { key: b64("k") })).status, 401);
    assert.equal((await post(agent, f.certPem, "/v1/shards/kv", { op: "nonsense", access: t2 })).status, 400);

    // 8. a restart keeps the data and the high-water.
    await agent.close();
    agent = await f.start();
    kv = kvOf(agent, f.certPem);
    assert.equal(text((await kv(t2, "get", { key: b64("k") })).body.value), "v2");
    assert.equal((await kv(t1, "get", { key: b64("k") })).body.code, "stale-epoch");

    // 9. release removes the storage; stale grants are refused; a newer epoch starts empty.
    const again = f.dispatcherFor(agent);
    await again.deliverAppShardGrant({ ...shard, epoch: 2, state: "released", durability: "crash" });
    assert.equal(existsSync(file), false);
    assert.equal((await kv(t2, "get", { key: b64("k") })).body.code, "not-committed");
    await assert.rejects(again.deliverAppShardGrant({ ...shard, epoch: 2, state: "committed", durability: "crash" }), /403/);
    await again.deliverAppShardGrant({ ...shard, epoch: 3, state: "preparing", durability: "crash" });
    await again.deliverAppShardGrant({ ...shard, epoch: 3, state: "committed", durability: "crash" });
    const t3 = (await again.authorizeAppShardAccess({ ...shard, epoch: 3 })).token;
    assert.equal((await kv(t3, "get", { key: b64("k") })).body.value, null);

    // 10. health reports capacity.
    const url = new URL(agent.address);
    const health = await new Promise((resolve, reject) => httpsRequest({ hostname: url.hostname, port: url.port, path: "/v1/health", ca: f.certPem }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    }).on("error", reject).end());
    for (const field of ["cpuCores", "memoryBytes", "diskBytes"]) assert.ok(health.capacity[field] > 0, field);
  } finally {
    await agent.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a shard host closes idle snapshots and refuses grants no Platform key signed", { timeout: 30_000 }, async () => {
  const f = await fixture();
  const store = createMemorySystemStore();
  const host = createRemoteShardHost({ dataDirectory: join(f.root, "host"), store, trust: () => f.trust, agentId: "agent-b", nodeId: "node-b", sweepEveryMillis: 50, idleMillis: 100 });
  try {
    const sign = (epoch, state, key = f.privateKey) => signAppShardGrant(key, { keyId: "platform-test", agentId: "agent-b", nodeId: "node-b", ...shard, epoch, state, durability: "crash", issuedAt: Date.now(), expiresAt: Date.now() + 30_000 });
    const access = await signAppShardAccess(f.privateKey, { keyId: "platform-test", agentId: "agent-b", nodeId: "node-b", ...shard, epoch: 1, issuedAt: Date.now(), expiresAt: Date.now() + 60_000 });
    const stranger = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])).privateKey;
    await assert.rejects(host.applyGrant(await sign(1, "committed", stranger)), /invalid/);
    await host.applyGrant(await sign(1, "preparing"));
    await host.applyGrant(await sign(1, "committed"));
    const { body } = await host.kv({ access, op: "snapshot" });
    assert.ok(body.snapshot);
    assert.equal((await host.kv({ access, op: "get", key: b64("k"), snapshot: body.snapshot })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(await host.kv({ access, op: "get", key: b64("k"), snapshot: body.snapshot }), { status: 404, body: { code: "unknown-cursor" } });
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
