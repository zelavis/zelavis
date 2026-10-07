import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Effect } from "effect";
import { composeCloudCapacity, readCloudPolicy } from "../dist/platform/cloud-engine.js";
import { createNodeEnrollmentAuthority } from "../dist/platform/node-enrollment.js";
import { createMemorySystemStore } from "../dist/system-store.js";
import { generateAgentCertificate } from "../dist/adapters/_agent-certificate.js";
import { startFakeHetzner } from "../services/zelavis-cloud/test/fake-hetzner.mjs";

const bundlePath = fileURLToPath(new URL("../services/zelavis-cloud/bundle/index.js", import.meta.url));
const GB = 1024 ** 3;
const POLICY = { location: "nbg1", image: "ubuntu-24.04", maxNodes: 2, machineClasses: [{ name: "cpx11", cpuCores: 2, memoryBytes: 2 * GB, diskBytes: 40 * GB }] };
const FINGERPRINT = "ab".repeat(32);
const run = (effect) => Effect.runPromise(effect);

test("a policy file is validated, not guessed at", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-cloud-policy-"));
  const write = async (name, value) => { const file = join(directory, name); await writeFile(file, typeof value === "string" ? value : JSON.stringify(value)); return file; };
  assert.deepEqual(await run(readCloudPolicy(await write("ok.json", POLICY))), POLICY);
  for (const bad of ["{", {}, { ...POLICY, maxNodes: 0 }, { ...POLICY, maxNodes: 1000 }, { ...POLICY, machineClasses: [] },
    { ...POLICY, machineClasses: [{ name: "x", cpuCores: 0, memoryBytes: 1, diskBytes: 1 }] }, { ...POLICY, image: "" }]) {
    await assert.rejects(run(readCloudPolicy(await write("bad.json", bad))), /cloud policy/, JSON.stringify(bad));
  }
  await assert.rejects(run(readCloudPolicy(join(directory, "missing.json"))), /could not be read/);
});

test("the composed controller connects, creates a machine whose first-boot data carries a real single-use token, and sees it enrol", async (t) => {
  const fake = await startFakeHetzner({ token: "hcloud_fake_token_0123456789" });
  t.after(() => fake.close());
  const store = createMemorySystemStore();
  const authority = createNodeEnrollmentAuthority({ store });
  const controller = await run(composeCloudCapacity({
    store, masterSecret: "master-secret", platformId: "platform-1", bundlePath, policy: POLICY,
    endpoint: { url: "https://203.0.113.5:8444", fingerprint: FINGERPRINT },
    workDir: await mkdtemp(join(tmpdir(), "zelavis-cloud-work-")), authority, apiEndpoint: fake.url,
  }));

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

test("an installation without the bundle says so instead of starting", async () => {
  await assert.rejects(run(composeCloudCapacity({
    store: createMemorySystemStore(), masterSecret: "s", platformId: "p", bundlePath: join(tmpdir(), "no-such-bundle.js"), policy: POLICY,
    endpoint: { url: "https://203.0.113.5:8444", fingerprint: FINGERPRINT }, workDir: tmpdir(),
  })), /could not be loaded/);
});
