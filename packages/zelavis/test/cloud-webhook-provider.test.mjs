import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { Effect, Semaphore } from "effect";
import { createWebhookCapacityProvider, CLOUD_WEBHOOK_NODES_NAMESPACE } from "../dist/platform/cloud-webhook-provider.js";
import { composeCloudCapacity } from "../dist/platform/cloud-engine.js";
import { createMemorySystemStore } from "../dist/system-store.js";
import { capacityNodeName } from "../.capacity-build/index.js";
const secret = "webhook_signing_secret_01234567890123456789";
const policy = { location: "rack-a", image: "worker-image", maxNodes: 2, machineClasses: [{ name: "small", cpuCores: 2, memoryBytes: 2 * 1024 ** 3, diskBytes: 40 * 1024 ** 3 }] };
async function setup(t, overrides = {}) {
  const state = { nodes: new Map(), requests: [], fault: "", enrolled: false, current: true, active: 0, maxActive: 0 };
  const server = createServer(async (req, res) => {
    state.active++; state.maxActive = Math.max(state.maxActive, state.active);
    res.on("close", () => state.active--);
    let raw = ""; for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw);
    const timestamp = /t=([0-9]+)/.exec(req.headers["zelavis-signature"])[1];
    assert.equal(req.headers["zelavis-signature"], `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex")}`);
    state.requests.push(payload);
    const reply = body => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
    if (state.fault === "stall-body") { res.writeHead(200, { "content-type": "application/json" }); res.write("{"); return; }
    if (state.fault === "malformed-node") { res.statusCode = 201; return reply({ node: { id: payload.nodeId, state: secret } }); }
    if (state.fault === "redirect") { res.writeHead(302, { location: "/other" }); return res.end(); }
    if (state.fault === "500") { res.statusCode = 500; return res.end(secret); }
    if (state.fault === "large") return res.end('"' + "x".repeat(256 * 1024) + '"');
    if (state.fault === "malformed") return res.end(secret);
    if (payload.action === "provision") { const node = { id: payload.nodeId, state: "ready", region: payload.region }; state.nodes.set(node.id, node); return reply({ node }); }
    if (payload.action === "list") return reply({ nodes: [...state.nodes.values()] });
    if (payload.action === "get") return reply({ node: state.nodes.get(payload.nodeId) ?? null });
    if (payload.action === "release") { state.nodes.delete(payload.nodeId); return reply({}); }
    throw new Error("unexpected action");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const store = createMemorySystemStore();
  const options = { endpoint: "https://webhook.test/capacity", secret, platformId: "p", policy, store, now: () => 1_700_000_000_000,
    firstBoot: async id => `first-boot ${id}`, isEnrolled: async () => state.enrolled, authority: async () => state.current,
    fetch: (url, init) => { assert.equal(String(url), "https://webhook.test/capacity"); assert.equal(init.redirect, "manual"); return fetch(endpoint, init); }, ...overrides };
  return { state, store, options, provider: createWebhookCapacityProvider(options) };
}
const input = { requestId: "r1", platformId: "p" };

test("signed provisioning is deterministic, policy-bound, idempotent and ready only after enrollment", async t => {
  const { provider, state } = await setup(t);
  const first = await provider.provision(input);
  assert.equal(first.id, capacityNodeName("r1")); assert.equal(first.state, "provisioning");
  const payload = state.requests[0];
  assert.deepEqual([payload.version, payload.action, payload.platformId, payload.machineClass, payload.image, payload.location, payload.firstBoot], [1, "provision", "p", policy.machineClasses[0], policy.image, policy.location, `first-boot ${first.id}`]);
  assert.equal(JSON.stringify(payload).includes(secret), false);
  assert.deepEqual(await provider.provision(input), first); assert.equal(state.nodes.size, 1);
  state.nodes.set("foreign", { id: "foreign", state: "ready" });
  assert.equal((await provider.list()).length, 1);
  state.enrolled = true;
  assert.equal((await provider.get(first.id)).state, "ready");
  await provider.release(first.id); assert.deepEqual(await provider.list(), []);
});

test("unknown machines cannot be released, and missing machines repair an interrupted provision record", async t => {
  const { provider, state, store } = await setup(t);
  await assert.rejects(provider.release("foreign"), /not provisioned/); assert.equal(state.requests.length, 0);
  await provider.provision(input); state.nodes.clear();
  assert.equal((await store.list(CLOUD_WEBHOOK_NODES_NAMESPACE)).length, 1);
  assert.deepEqual(await provider.list(), []);
  assert.equal((await store.list(CLOUD_WEBHOOK_NODES_NAMESPACE)).length, 0);
  assert.equal(state.requests.at(-1).action, "get");
});

for (const fault of ["redirect", "500", "large", "malformed"]) test(`${fault} responses fail without revealing the signing secret`, async t => {
  const { provider, state } = await setup(t); state.fault = fault;
  await assert.rejects(provider.list(), error => error.code === "provider-failed" && !error.message.includes(secret));
  assert.equal(state.requests.length, 1, "no redirect followed and no automatic retry");
});

test("policy limits and superseded authority refuse side effects", async t => {
  const { provider, state } = await setup(t);
  await assert.rejects(provider.provision({ ...input, region: "foreign" }), /not allowed/);
  await assert.rejects(provider.provision({ ...input, resources: { cpuCores: 3 } }), /No approved/);
  await provider.provision(input); await provider.provision({ ...input, requestId: "r2" });
  await assert.rejects(provider.provision({ ...input, requestId: "r3" }), /maximum nodes/);
  state.current = false; const before = state.requests.length;
  await assert.rejects(provider.release(capacityNodeName("r1")), /superseded/); assert.equal(state.requests.length, before);
});

test("parallel requests across short-lived providers share the machine ceiling", async t => {
  const { options, state } = await setup(t);
  const shared = { ...options, calls: Semaphore.makeUnsafe(2), mutations: Semaphore.makeUnsafe(1), policy: { ...policy, maxNodes: 1 } };
  const providers = [createWebhookCapacityProvider(shared), createWebhookCapacityProvider(shared)];
  const results = await Promise.allSettled(providers.map((provider, i) => provider.provision({ ...input, requestId: `r${i}` })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1); assert.equal(state.nodes.size, 1); assert.ok(state.maxActive <= 2);
});

test("a webhook connection and first boot work without an Alchemy bundle", async t => {
  const { options } = await setup(t);
  const original = globalThis.fetch;
  // Only the named HTTPS fake is redirected; the fixture's loopback fetch uses the original implementation.
  globalThis.fetch = (url, init) => String(url).startsWith("https://webhook.test/") ? options.fetch(url, init) : original(url, init);
  t.after(() => { globalThis.fetch = original; });
  const controller = await Effect.runPromise(composeCloudCapacity({ store: options.store, masterSecret: "secret", platformId: "p", bundlePath: "/missing.js", endpoint: { url: "https://platform.test:8444", fingerprint: "ab".repeat(32) }, workDir: "/unused" }));
  await Effect.runPromise(controller.setPolicy(policy, "owner"));
  const summary = await Effect.runPromise(controller.connect({ provider: "webhook", token: secret, endpoint: options.endpoint, principalId: "owner" }));
  assert.equal(summary.endpoint, options.endpoint);
  const node = await Effect.runPromise(controller.request({ requestId: "boot", principalId: "owner" }));
  assert.equal(node.state, "provisioning");
});


test("invalid success receipts retain the actual HTTP status and conceal the body", async t => {
  const { provider, state } = await setup(t); state.fault = "malformed-node";
  await assert.rejects(provider.provision(input), error => error.code === "provider-failed" && /HTTP 201/.test(error.message) && !error.message.includes(secret));
});

test("a stalled response body times out and the provider remains usable", { timeout: 40_000 }, async t => {
  const { provider, state } = await setup(t); state.fault = "stall-body";
  await assert.rejects(provider.list(), error => error.code === "provider-failed" && /timed out/.test(error.message));
  state.fault = "";
  assert.deepEqual(await provider.list(), []);
});
