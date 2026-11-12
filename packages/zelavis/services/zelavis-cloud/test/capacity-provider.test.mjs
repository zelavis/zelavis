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
  deployKeyName,
  platformLabelValue,
} from "../dist/index.js";

const GB = 1024 ** 3;
const MACHINE_CLASSES = [
  { name: "cpx31", cpuCores: 4, memoryBytes: 8 * GB, diskBytes: 160 * GB },
  { name: "cpx11", cpuCores: 2, memoryBytes: 2 * GB, diskBytes: 40 * GB },
  { name: "cpx21", cpuCores: 3, memoryBytes: 4 * GB, diskBytes: 80 * GB },
];
const PLATFORM = "platform-1";

async function harness(t, { maxNodes = 2, platformId = PLATFORM, fault, now, authority } = {}) {
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
    ...(now ? { now } : {}),
    ...(authority ? { authority } : {}),
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

const OLD = "2020-01-01T00:00:00.000Z";
const ownLabels = () => ({ "zelavis.io/managed": "true", "zelavis.io/platform": platformLabelValue(PLATFORM) });
const addKey = (fake, id, name, labels, created) => fake.sshKeys.set(id, { id, name, public_key: "ssh-ed25519 AAAA", fingerprint: `aa:${id}`, labels, created });

test("the deploy key is named the way the cloud service expects (pinned to what Alchemy creates)", async (t) => {
  const { provider, fake } = await harness(t);
  const node = await provider.provision(request("req-1"));
  assert.deepEqual([...fake.sshKeys.values()].map((key) => key.name), [deployKeyName(node.id)]);
});

test("releasing a machine whose provisioning state was lost also removes its deploy key", async (t) => {
  const { provider, fake, store } = await harness(t);
  const node = await provider.provision(request("req-1"));
  assert.equal(fake.sshKeys.size, 1);
  await store.delete(PROVISIONING_STATE_NAMESPACE, `${node.id}/capacity`);
  await provider.release(node.id);
  assert.equal(fake.servers.size, 0);
  assert.equal(fake.sshKeys.size, 0, "no key is left behind for a machine that no longer exists");
});

test("a foreign key with the machine's key name is never removed", async (t) => {
  const { provider, fake, store } = await harness(t);
  const node = await provider.provision(request("req-1"));
  await store.delete(PROVISIONING_STATE_NAMESPACE, `${node.id}/capacity`);
  const ours = [...fake.sshKeys.values()][0];
  ours.labels = { team: "someone-else" };
  await provider.release(node.id);
  assert.equal(fake.sshKeys.size, 1, "the key did not carry this Platform's labels, so it was left alone");
});

test("sweeping removes an old orphaned key and keeps young, live and foreign ones", async (t) => {
  const clock = { at: Date.parse("2026-10-17T12:00:00Z") };
  const { provider, fake } = await harness(t, { now: () => clock.at });
  const node = await provider.provision(request("req-1"));
  const live = [...fake.sshKeys.values()][0];
  live.created = OLD;
  addKey(fake, 9001, "zelavis-gone-aaaaaaaaaaaa-d", ownLabels(), OLD);
  addKey(fake, 9002, "zelavis-young-bbbbbbbbbbbb-d", ownLabels(), new Date(clock.at - 60_000).toISOString());
  addKey(fake, 9003, "zelavis-other-cccccccccccc-d", { team: "someone-else" }, OLD);
  addKey(fake, 9004, "zelavis-other-platform-d", { "zelavis.io/managed": "true", "zelavis.io/platform": "0000" }, OLD);
  assert.equal(await provider.sweepOrphanKeys(), 1);
  assert.deepEqual([...fake.sshKeys.keys()].sort(), [live.id, 9002, 9003, 9004].sort());
  assert.equal(fake.servers.size, 1, "the machine is untouched");
  assert.equal(node.id, capacityNodeName("req-1"));
});

test("a new request sweeps orphans first, and a sweep that fails never fails the request", async (t) => {
  const { provider, fake } = await harness(t, { now: () => Date.parse("2026-10-17T12:00:00Z") });
  addKey(fake, 9001, "zelavis-gone-aaaaaaaaaaaa-d", ownLabels(), OLD);
  await provider.provision(request("req-1"));
  assert.equal(fake.sshKeys.has(9001), false, "the orphan was removed on the way");
  fake.faults.failListKeys = true;
  const second = await provider.provision(request("req-2"));
  assert.equal(second.id, capacityNodeName("req-2"));
});

test("a superseded Platform creates, releases and sweeps nothing", async (t) => {
  let current = true;
  const { provider, fake, creates } = await harness(t, { authority: () => current });
  const node = await provider.provision(request("held"));
  assert.equal(creates(), 1);
  current = false;
  await assert.rejects(provider.provision(request("late")), rejectsWith("superseded"));
  await assert.rejects(provider.release(node.id), rejectsWith("superseded"));
  await assert.rejects(provider.sweepOrphanKeys(), rejectsWith("superseded"));
  assert.equal(creates(), 1, "no machine was created after authority moved");
  assert.equal(fake.servers.size, 1, "and the existing one was not deleted");
  current = true;
  await provider.release(node.id);
  assert.equal(fake.servers.size, 0, "authority regained: it works again");
});

test("authority lost while a request runs fences it at the state, before any machine call", async (t) => {
  let calls = 0;
  const { provider, fake } = await harness(t, { authority: () => ++calls <= 1 });
  await assert.rejects(provider.provision(request("mid")), rejectsWith("superseded"));
  assert.equal(fake.servers.size, 0);
});
