import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  CLOUD_AUDIT_NAMESPACE,
  CLOUD_CONNECTION_NAMESPACE,
  createCloudCapacityController,
} from "../dist/platform/cloud-capacity.js";
import { createMemorySystemStore } from "../dist/system-store.js";

const TOKEN = "hcloud_token_0123456789abcdef";
const run = (effect) => Effect.runPromise(effect);
const codeOf = async (effect) => {
  try { await run(effect); } catch (error) { return error?.code ?? error?.error?.code ?? String(error); }
  return "no-error";
};

function fakeProvider(state) {
  return {
    list: async () => { state.listed++; if (state.rejectToken) throw new Error("401"); return [...state.nodes.values()]; },
    get: async (id) => state.nodes.get(id),
    provision: async (input) => {
      const node = { id: `node-${input.requestId}`, provider: "hetzner", state: "provisioning", labels: {} };
      state.nodes.set(node.id, node);
      state.provisioned.push(input);
      state.scripts.push(await state.firstBoot(node.id));
      return node;
    },
    release: async (id) => { state.nodes.delete(id); },
  };
}

function setup(overrides = {}) {
  const state = { nodes: new Map(), provisioned: [], scripts: [], listed: 0, rejectToken: false, tokensSeen: [] };
  const store = overrides.store ?? createMemorySystemStore();
  const controller = createCloudCapacityController({
    store, masterSecret: "master-secret-for-tests", platformId: "platform-1", now: () => 1_000_000,
    buildProvider: (config, firstBoot) => { state.tokensSeen.push(config.token); state.firstBoot = firstBoot; return fakeProvider(state); },
    firstBootFor: async (nodeId) => `#!/bin/sh\necho ${nodeId}\n`,
  });
  return { state, store, controller };
}

test("connecting seals the token: it is proved by use, never stored or returned in the clear", async () => {
  const { controller, store, state } = setup();
  const summary = await run(controller.connect({ provider: "hetzner", token: TOKEN, label: "prod", principalId: "owner" }));
  assert.deepEqual(Object.keys(summary).sort(), ["connectedAt", "connectedBy", "label", "provider", "tokenHint"]);
  assert.equal(summary.tokenHint, TOKEN.slice(-4));
  assert.equal(state.listed, 1, "the token was exercised before it was kept");
  const stored = JSON.stringify((await store.get(CLOUD_CONNECTION_NAMESPACE, "default")).value);
  assert.ok(!stored.includes(TOKEN) && !stored.includes(TOKEN.slice(0, 12)));
  assert.deepEqual(await run(controller.connection()), summary);
});

test("a token that cannot list is not kept, and malformed input is refused first", async () => {
  const { controller, state, store } = setup();
  state.rejectToken = true;
  assert.equal(await codeOf(controller.connect({ provider: "hetzner", token: TOKEN, principalId: "o" })), "provider-failed");
  assert.equal(await store.get(CLOUD_CONNECTION_NAMESPACE, "default"), undefined);
  for (const bad of [{ provider: "aws", token: TOKEN }, { provider: "hetzner", token: "short" },
    { provider: "hetzner", token: `${TOKEN} with space` }, { provider: "hetzner", token: TOKEN, label: "bad/label" }]) {
    assert.equal(await codeOf(controller.connect({ ...bad, principalId: "o" })), "invalid-request", JSON.stringify(bad));
  }
});

test("a second connection is refused", async () => {
  const { controller } = setup();
  await run(controller.connect({ provider: "hetzner", token: TOKEN, principalId: "o" }));
  assert.equal(await codeOf(controller.connect({ provider: "hetzner", token: TOKEN, principalId: "o" })), "already-connected");
});

test("requests use the decrypted token only for the call and mint first boot per machine", async () => {
  const { controller, state } = setup();
  assert.equal(await codeOf(controller.request({ requestId: "r1", principalId: "o" })), "not-connected");
  await run(controller.connect({ provider: "hetzner", token: TOKEN, principalId: "o" }));
  const node = await run(controller.request({ requestId: "r1", region: "fsn1", principalId: "o" }));
  assert.equal(node.id, "node-r1");
  assert.equal(state.provisioned[0].platformId, "platform-1");
  assert.equal(state.provisioned[0].region, "fsn1");
  assert.ok(state.tokensSeen.every((token) => token === TOKEN));
  assert.match(state.scripts[0], /echo node-r1/);
  assert.equal(await codeOf(controller.request({ requestId: "bad id/", principalId: "o" })), "invalid-request");
});

test("disconnecting is refused while machines exist, and allowed once released", async () => {
  const { controller, store } = setup();
  await run(controller.connect({ provider: "hetzner", token: TOKEN, principalId: "o" }));
  await run(controller.request({ requestId: "r1", principalId: "o" }));
  assert.equal(await codeOf(controller.disconnect("o")), "has-nodes");
  await run(controller.release({ nodeId: "node-r1", principalId: "o" }));
  await run(controller.disconnect("o"));
  assert.equal(await store.get(CLOUD_CONNECTION_NAMESPACE, "default"), undefined);
  assert.equal(await codeOf(controller.nodes()), "not-connected");
});

test("every use is audited with the principal and no secret; an unrecordable action does not run", async () => {
  const { controller, store, state } = setup();
  await run(controller.connect({ provider: "hetzner", token: TOKEN, principalId: "alice" }));
  await run(controller.request({ requestId: "r1", principalId: "alice" }));
  const records = (await store.page(CLOUD_AUDIT_NAMESPACE, { limit: 50 })).records.map((r) => r.value);
  assert.deepEqual(records.map((r) => r.action).sort(), ["connect", "provision"]);
  assert.ok(records.every((r) => r.principalId === "alice"));
  assert.ok(!JSON.stringify(records).includes(TOKEN));

  const blocked = createMemorySystemStore();
  const failing = { ...blocked, set: (ns, key, value) => { if (ns === CLOUD_AUDIT_NAMESPACE) throw new Error("disk full"); return blocked.set(ns, key, value); },
    get: blocked.get.bind(blocked), setIfAbsent: blocked.setIfAbsent.bind(blocked), page: blocked.page.bind(blocked), delete: blocked.delete.bind(blocked) };
  const second = setup({ store: failing });
  assert.equal(await codeOf(second.controller.connect({ provider: "hetzner", token: TOKEN, principalId: "o" })), "audit-unavailable");
  assert.equal(second.state.provisioned.length, 0);
  assert.equal(state.provisioned.length, 1);
});
