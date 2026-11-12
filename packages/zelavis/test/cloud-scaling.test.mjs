import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  CLOUD_AUDIT_NAMESPACE,
  SCALE_OUT_SUSTAIN_MS,
  createCloudCapacityController,
} from "../dist/platform/cloud-capacity.js";
import { createMemorySystemStore } from "../dist/system-store.js";

const TOKEN = "hcloud_token_0123456789abcdef";
const run = (effect) => Effect.runPromise(effect);
const codeOf = async (effect) => {
  try { await run(effect); } catch (error) { return error?.code ?? String(error); }
  return "no-error";
};

function setup() {
  const clock = { at: 10_000_000 };
  const nodes = new Map();
  const provisioned = [];
  const store = createMemorySystemStore();
  const controller = createCloudCapacityController({
    store, masterSecret: "master-secret-for-tests", platformId: "platform-1", now: () => clock.at,
    buildProvider: () => ({
      list: async () => [...nodes.values()],
      get: async (id) => nodes.get(id),
      provision: async (input) => {
        provisioned.push(input);
        const node = { id: `node-${input.requestId}`, provider: "hetzner", state: "provisioning", labels: {} };
        nodes.set(node.id, node);
        return node;
      },
      release: async (id) => { nodes.delete(id); },
    }),
    firstBootFor: async () => "#!/bin/sh\n",
  });
  return { clock, nodes, provisioned, store, controller };
}

const connect = (controller) => run(controller.connect({ provider: "hetzner", token: TOKEN, principalId: "owner" }));
const enable = (controller, over = {}) =>
  run(controller.setScaling({ consent: true, maxMachines: 2, cooldownMinutes: 10, principalId: "owner", ...over }));

test("without consent a shortfall never costs money", async () => {
  const { controller, provisioned, clock } = setup();
  assert.equal(await run(controller.observeShortfall(3)), "no-provider");
  await connect(controller);
  assert.equal((await run(controller.scaling())).settings.consent, false);
  assert.equal(await run(controller.observeShortfall(3)), "no-consent");
  clock.at += SCALE_OUT_SUSTAIN_MS * 10;
  assert.equal(await run(controller.observeShortfall(3)), "no-consent");
  assert.equal(provisioned.length, 0);
});

test("a shortfall must be sustained, then requests exactly one machine, audited as the autoscaler", async () => {
  const { controller, provisioned, clock, store } = setup();
  await connect(controller);
  await enable(controller);
  assert.equal(await run(controller.observeShortfall(1)), "waiting");
  clock.at += SCALE_OUT_SUSTAIN_MS - 1;
  assert.equal(await run(controller.observeShortfall(1)), "waiting");
  clock.at += 1;
  assert.equal(await run(controller.observeShortfall(1)), "requested");
  assert.equal(provisioned.length, 1);
  const audit = (await store.page(CLOUD_AUDIT_NAMESPACE, { limit: 50 })).records.map((record) => record.value);
  assert.ok(audit.some((entry) => entry.principalId === "autoscaler" && entry.action === "provision"));
  assert.equal((await run(controller.scaling())).last.outcome, "requested");
});

test("a shortfall that clears resets the clock", async () => {
  const { controller, provisioned, clock } = setup();
  await connect(controller);
  await enable(controller);
  await run(controller.observeShortfall(1));
  clock.at += SCALE_OUT_SUSTAIN_MS - 1;
  assert.equal(await run(controller.observeShortfall(0)), "idle");
  clock.at += 2;
  assert.equal(await run(controller.observeShortfall(1)), "waiting");
  assert.equal(provisioned.length, 0);
});

test("never while a machine is booting, never past the limit, never inside the cooldown", async () => {
  const { controller, provisioned, clock, nodes } = setup();
  await connect(controller);
  await enable(controller, { maxMachines: 2, cooldownMinutes: 10 });
  await run(controller.observeShortfall(1));
  clock.at += SCALE_OUT_SUSTAIN_MS;
  assert.equal(await run(controller.observeShortfall(1)), "requested");
  assert.equal(await run(controller.observeShortfall(1)), "booting", "the booting machine already answers the demand");
  for (const node of nodes.values()) node.state = "ready";
  assert.equal(await run(controller.observeShortfall(1)), "cooling-down");
  clock.at += 10 * 60_000;
  assert.equal(await run(controller.observeShortfall(1)), "requested");
  for (const node of nodes.values()) node.state = "ready";
  clock.at += 10 * 60_000;
  assert.equal(await run(controller.observeShortfall(1)), "at-limit");
  assert.equal(provisioned.length, 2);
});

test("an unrecordable automatic request does not run and is reported as failed", async () => {
  const { controller, clock, store } = setup();
  await connect(controller);
  await enable(controller);
  await run(controller.observeShortfall(1));
  clock.at += SCALE_OUT_SUSTAIN_MS;
  // Break the provider for the request: the cooldown record was written first.
  const original = store.set.bind(store);
  store.set = async (namespace, key, value) => {
    if (namespace === CLOUD_AUDIT_NAMESPACE) throw new Error("audit down");
    return original(namespace, key, value);
  };
  assert.equal(await run(controller.observeShortfall(1)), "failed", "an unrecordable request does not run");
  assert.equal((await run(controller.scaling())).last.outcome, "failed");
});

test("settings are validated, need a connection, and die with it", async () => {
  const { controller, nodes } = setup();
  assert.equal(await codeOf(controller.setScaling({ consent: true, maxMachines: 1, cooldownMinutes: 5, principalId: "o" })), "not-connected");
  await connect(controller);
  for (const bad of [{ maxMachines: 0 }, { maxMachines: 21 }, { maxMachines: 1.5 }, { cooldownMinutes: 0 }, { cooldownMinutes: 1441 }]) {
    assert.equal(await codeOf(controller.setScaling({ consent: true, maxMachines: 1, cooldownMinutes: 5, principalId: "o", ...bad })), "invalid-request");
  }
  assert.equal(await codeOf(controller.setScaling({ consent: "yes", maxMachines: 1, cooldownMinutes: 5, principalId: "o" })), "invalid-request");
  await enable(controller);
  assert.equal((await run(controller.scaling())).settings.consent, true);
  nodes.clear();
  await run(controller.disconnect("owner"));
  await connect(controller);
  assert.equal((await run(controller.scaling())).settings.consent, false, "a new connection starts without consent");
});
