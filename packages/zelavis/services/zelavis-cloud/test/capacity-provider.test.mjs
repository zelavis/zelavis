// The CapacityProvider over the Hetzner port, against the fake Hetzner API.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMemorySystemStore } from "zelavis";
import { startFakeHetzner } from "./fake-hetzner.mjs";
import {
  PROVISIONING_STATE_NAMESPACE,
  aesGcmSecretCodec,
  capacityNodeName,
  createCapacityProvider,
  createHetznerCloud,
} from "../dist/index.js";

const GB = 1024 ** 3;
const MACHINE_CLASSES = [
  { name: "cpx31", cpuCores: 4, memoryBytes: 8 * GB, diskBytes: 160 * GB },
  { name: "cpx11", cpuCores: 2, memoryBytes: 2 * GB, diskBytes: 40 * GB },
  { name: "cpx21", cpuCores: 3, memoryBytes: 4 * GB, diskBytes: 80 * GB },
];
const PLATFORM = "platform-1";

async function harness(t, { maxNodes = 2, platformId = PLATFORM, fault } = {}) {
  const fake = await startFakeHetzner();
  t.after(() => fake.close());
  const store = createMemorySystemStore();
  const guarded = Object.create(store);
  guarded.compareAndSet = (namespace, key, updatedAt, value, expected) => {
    if (fault?.failNextCreatedWrite > 0 && JSON.stringify(value).includes('"status":"created"')) {
      fault.failNextCreatedWrite--;
      throw new Error("injected store failure");
    }
    return store.compareAndSet(namespace, key, updatedAt, value, expected);
  };
  const enrolled = new Set();
  const cloud = createHetznerCloud({
    token: fake.token,
    endpoint: fake.url,
    workDir: mkdtempSync(join(tmpdir(), "zelavis-cloud-")),
  });
  const provider = createCapacityProvider({
    platformId,
    workerId: "worker-1",
    cloud,
    store: guarded,
    secrets: aesGcmSecretCodec(randomBytes(32)),
    defaults: { location: "nbg1", image: "ubuntu-24.04", machineClasses: MACHINE_CLASSES, maxNodes },
    enrollment: { isEnrolled: (nodeId) => enrolled.has(nodeId) },
  });
  const creates = () => fake.log.filter((line) => line.startsWith("POST /servers")).length;
  return { fake, store, provider, enrolled, creates };
}

const request = (requestId, extra = {}) => ({ requestId, platformId: PLATFORM, ...extra });
const rejectsWith = (code) => (error) => error?.name === "CapacityError" && error.code === code;

test("provision returns a provisioning node named from the request, sized and labeled", async (t) => {
  const { provider, fake } = await harness(t);
  const node = await provider.provision(request("req-1", { resources: { cpuCores: 2 } }));
  assert.equal(node.id, capacityNodeName("req-1"));
  assert.equal(node.provider, "hetzner");
  assert.equal(node.state, "provisioning", "a running machine is not a Node until it enrolls");
  assert.equal(node.region, "nbg1");
  assert.deepEqual(node.resources, { cpuCores: 2, memoryBytes: 2 * GB, diskBytes: 40 * GB });
  const [server] = [...fake.servers.values()];
  assert.equal(server.name, node.id);
  assert.equal(server.server_type, "cpx11");
  assert.equal(server.labels["zelavis.io/managed"], "true");
  assert.equal(server.labels["zelavis.io/class"], "cpx11");
});

test("the smallest approved class that fits is chosen, and an impossible request is refused", async (t) => {
  const { provider, fake } = await harness(t, { maxNodes: 5 });
  await provider.provision(request("small"));
  await provider.provision(request("mid", { resources: { cpuCores: 3 } }));
  await provider.provision(request("big", { resources: { memoryBytes: 6 * GB } }));
  assert.deepEqual([...fake.servers.values()].map((s) => s.server_type).sort(), ["cpx11", "cpx21", "cpx31"]);
  await assert.rejects(() => provider.provision(request("huge", { resources: { cpuCores: 64 } })), rejectsWith("no-machine-class"));
});

test("provisioning the same request again, or concurrently, yields one machine", async (t) => {
  const { provider, fake, creates } = await harness(t);
  const [a, b] = await Promise.all([provider.provision(request("req-1")), provider.provision(request("req-1"))]);
  const again = await provider.provision(request("req-1"));
  assert.equal(a.id, b.id);
  assert.equal(a.id, again.id);
  assert.equal(fake.servers.size, 1);
  assert.equal(creates(), 1);
});

test("the node ceiling refuses new machines, but never an existing request", async (t) => {
  const { provider, fake } = await harness(t, { maxNodes: 2 });
  await provider.provision(request("a"));
  await provider.provision(request("b"));
  await assert.rejects(() => provider.provision(request("c")), rejectsWith("node-cap-reached"));
  assert.equal(fake.servers.size, 2);
  const again = await provider.provision(request("a"));
  assert.equal(again.id, capacityNodeName("a"), "an idempotent retry succeeds at the ceiling");
});

test("a node becomes ready only once the Platform has enrolled it", async (t) => {
  const { provider, enrolled } = await harness(t);
  const node = await provider.provision(request("req-1"));
  assert.equal((await provider.get(node.id)).state, "provisioning");
  enrolled.add(node.id);
  assert.equal((await provider.get(node.id)).state, "ready");
});

test("get and list report only machines this Platform created", async (t) => {
  const { provider, fake } = await harness(t, { maxNodes: 5 });
  const mine = await provider.provision(request("req-1"));
  const now = new Date().toISOString();
  const foreign = (id, name, labels) =>
    fake.servers.set(id, { id, name, server_type: "cpx11", image: "x", location: "nbg1", labels, created: now });
  foreign(901, "unrelated", {});
  foreign(902, "other-platform", { "zelavis.io/managed": "true", "zelavis.io/platform": "someoneelse" });
  assert.deepEqual((await provider.list()).map((n) => n.id), [mine.id]);
  assert.equal(await provider.get("unrelated"), undefined);
  assert.equal(await provider.get("other-platform"), undefined);
  assert.equal(await provider.get("missing"), undefined);
});

test("operator labels round-trip and cannot collide with reserved ones", async (t) => {
  const { provider } = await harness(t);
  const node = await provider.provision(request("req-1", { labels: { role: "worker", pool: "a-1" } }));
  assert.deepEqual(node.labels, { role: "worker", pool: "a-1" });
  assert.deepEqual((await provider.get(node.id)).labels, { role: "worker", pool: "a-1" });
  for (const labels of [{ managed: "x" }, { "bad key": "x" }, { role: "has space" }]) {
    await assert.rejects(() => provider.provision(request(`r-${JSON.stringify(labels)}`, { labels })), rejectsWith("invalid-request"));
  }
});

test("a request for another Platform, a bad region or an empty id is refused before any cloud call", async (t) => {
  const { provider, fake } = await harness(t);
  await assert.rejects(() => provider.provision({ requestId: "r", platformId: "other" }), rejectsWith("invalid-request"));
  await assert.rejects(() => provider.provision(request("r", { region: "hel1" })), rejectsWith("invalid-request"));
  await assert.rejects(() => provider.provision(request("")), rejectsWith("invalid-request"));
  assert.equal(fake.servers.size, 0);
});

test("release removes the machine and its key, and is idempotent", async (t) => {
  const { provider, fake } = await harness(t);
  const node = await provider.provision(request("req-1"));
  assert.equal(fake.sshKeys.size, 1);
  await provider.release(node.id);
  assert.equal(fake.servers.size, 0);
  assert.equal(fake.sshKeys.size, 0);
  await provider.release(node.id);
});

test("release refuses a machine this Platform did not create, and leaves it alone", async (t) => {
  const { provider, fake } = await harness(t);
  fake.servers.set(777, { id: 777, name: "precious", server_type: "cpx11", image: "x", location: "nbg1", labels: {}, created: new Date().toISOString() });
  await assert.rejects(() => provider.release("precious"), rejectsWith("not-managed"));
  assert.equal(fake.servers.size, 1);
});

test("release still removes a machine when its provisioning state was lost", async (t) => {
  const { provider, fake, store } = await harness(t);
  const node = await provider.provision(request("req-1"));
  await store.delete(PROVISIONING_STATE_NAMESPACE, `${node.id}/capacity`);
  await provider.release(node.id);
  assert.equal(fake.servers.size, 0, "the labels proved ownership, so it was removed directly");
});

test("a crash after the cloud create is recovered by provisioning again", async (t) => {
  const fault = { failNextCreatedWrite: 1 };
  const { provider, fake, creates } = await harness(t, { fault });
  await assert.rejects(() => provider.provision(request("req-1")));
  assert.equal(fake.servers.size, 1, "the cloud made the machine before the crash");
  const node = await provider.provision(request("req-1"));
  assert.equal(node.id, capacityNodeName("req-1"));
  assert.equal(fake.servers.size, 1);
  assert.equal(creates(), 1, "the retry created nothing");
});
