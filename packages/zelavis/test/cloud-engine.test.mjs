import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Effect } from "effect";
import { claimCloudAuthority, composeCloudCapacity } from "../dist/platform/cloud-engine.js";
import { parseCloudPolicy } from "../dist/platform/cloud-capacity.js";
import { createNodeEnrollmentAuthority } from "../dist/platform/node-enrollment.js";
import { createMemorySystemStore } from "../dist/system-store.js";
import { generateAgentCertificate } from "../dist/adapters/_agent-certificate.js";
import { startFakeHetzner } from "./_fake-hetzner.mjs";

const bundlePath = fileURLToPath(new URL("../dist/adapters/capacity/bundle.js", import.meta.url));
const GB = 1024 ** 3;
const POLICY = { location: "nbg1", image: "ubuntu-24.04", maxNodes: 2, machineClasses: [{ name: "cpx11", cpuCores: 2, memoryBytes: 2 * GB, diskBytes: 40 * GB }] };
const FINGERPRINT = "ab".repeat(32);
const run = (effect) => Effect.runPromise(effect);

test("a policy is validated, not guessed at", async () => {
  assert.deepEqual(await run(parseCloudPolicy(POLICY)), POLICY);
  assert.equal((await run(parseCloudPolicy({ ...POLICY, machineClasses: [{ ...POLICY.machineClasses[0], cpuCores: 0.5 }] }))).machineClasses[0].cpuCores, 0.5);
  for (const bad of [null, {}, { ...POLICY, maxNodes: 0 }, { ...POLICY, maxNodes: 101 }, { ...POLICY, machineClasses: [] },
    { ...POLICY, machineClasses: [{ name: "x", cpuCores: 0, memoryBytes: 1, diskBytes: 1 }] }, { ...POLICY, image: "" }]) {
    await assert.rejects(run(parseCloudPolicy(bad)), /cloud policy/);
  }
});

test("the composed controller connects, creates a machine whose first-boot data carries a real single-use token, and sees it enrol", async (t) => {
  const fake = await startFakeHetzner({ token: "hcloud_fake_token_0123456789" });
  t.after(() => fake.close());
  const store = createMemorySystemStore();
  const authority = createNodeEnrollmentAuthority({ store });
  const controller = await run(composeCloudCapacity({
    store, masterSecret: "master-secret", platformId: "platform-1", bundlePath,
    endpoint: { url: "https://203.0.113.5:8444", fingerprint: FINGERPRINT },
    workDir: await mkdtemp(join(tmpdir(), "zelavis-capacity-work-")), authority, apiEndpoint: fake.url,
  }));

  await run(controller.setPolicy(POLICY, "owner"));
  await run(controller.connect({ provider: "hetzner", token: fake.token, principalId: "owner" }));
  const node = await run(controller.request({ requestId: "r1", principalId: "owner" }));
  assert.equal(node.state, "provisioning");

  const [server] = [...fake.servers.values()];
  const script = server.user_data;
  assert.match(script, /--role worker/);
  assert.match(script, /--platform-url 'https:\/\/203\.0\.113\.5:8444\/zelavis'/);
  assert.match(script, new RegExp(`--platform-fingerprint 'sha256:${FINGERPRINT}'`));
  const token = /--enrollment-token '([^']+)'/.exec(script)[1];
  const nodeId = /--node-id '([^']+)'/.exec(script)[1];
  assert.equal(nodeId, node.id);
  assert.ok(!script.includes(fake.token), "the provider token is not in first-boot data");

  // The token in the script is the Platform's own, valid and single-use: the machine can enrol with it.
  assert.equal((await run(controller.nodes())).find((n) => n.id === node.id)?.state, "provisioning");
  const agent = generateAgentCertificate({ names: ["203.0.113.9"] });
  await run(authority.complete({ nodeId, token, certPem: agent.certPem, url: "https://203.0.113.9:8443" }));
  assert.equal((await run(controller.nodes())).find((n) => n.id === node.id)?.state, "ready", "ready only once enrolled");

  await run(controller.release({ nodeId: node.id, principalId: "owner" }));
  assert.equal(fake.servers.size, 0);
  await run(controller.disconnect("owner"));
});

test("a missing bundle fails only on first provider use", async () => {
  const controller = await run(composeCloudCapacity({
    store: createMemorySystemStore(), masterSecret: "s", platformId: "p", bundlePath: join(tmpdir(), "no-such-bundle.js"),
    endpoint: { url: "https://203.0.113.5:8444", fingerprint: FINGERPRINT }, workDir: tmpdir(),
  }));
  assert.equal(await run(controller.connection()), undefined);
  assert.deepEqual(await run(controller.policy()), { policy: null });
  await assert.rejects(run(controller.connect({ provider: "hetzner", token: "0123456789abcdef", principalId: "owner" })), error => error.code === "policy-missing");
  await run(controller.setPolicy(POLICY, "owner"));
  await assert.rejects(run(controller.connect({ provider: "hetzner", token: "0123456789abcdef", principalId: "owner" })), /could not be loaded/);
});

test("a later Platform process claims cloud authority and the earlier one stops being current", async () => {
  const store = createMemorySystemStore();
  const first = await run(claimCloudAuthority(store, "platform-1"));
  assert.equal(first.epoch, 1);
  assert.equal(await first.isCurrent(), true);
  const second = await run(claimCloudAuthority(store, "platform-1"));
  assert.equal(second.epoch, 2);
  assert.equal(await first.isCurrent(), false, "the deposed process is no longer current");
  assert.equal(await second.isCurrent(), true);
  assert.equal((await run(claimCloudAuthority(store, "platform-2"))).epoch, 1, "authority is per Platform id");
});


test("cloud authority refuses corrupt state and exhausted epochs", async () => {
  for (const epoch of [0, -1, "bad", Number.MAX_SAFE_INTEGER]) {
    const store = createMemorySystemStore();
    store.set("fabric.cloud-authority.v1", "p", { epoch });
    await assert.rejects(run(claimCloudAuthority(store, "p")), /malformed|exhausted/);
    assert.deepEqual(store.get("fabric.cloud-authority.v1", "p").value, { epoch });
  }
});
