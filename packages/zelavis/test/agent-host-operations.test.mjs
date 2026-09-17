import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runAgentCommand } from "../dist/cli/agent.js";
import { createAgentProcessClient } from "../dist/adapters/_agent-ipc.js";
import { readHostOperationTrustStore } from "../dist/adapters/_agent-host-operations.js";
import { hostOperationArgumentsDigest, signAgentAuthority } from "../dist/index.js";
import { createReleaseSigner } from "./fixtures/host-operation-signing.mjs";

const sha = (body) => createHash("sha256").update(body).digest("hex");
const BODY = "printf '%s' \"$4\" > \"$2\"\n"; // argv: --output <path> --value <v>

async function installation(t) {
  const root = await mkdtemp(join(tmpdir(), "zelavis-agent-ops-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = await createReleaseSigner();
  const operations = join(root, "operations");
  const installed = join(operations, "native.mark", "v1");
  await mkdir(installed, { recursive: true, mode: 0o700 });
  await writeFile(join(installed, "artifact"), BODY, { mode: 0o700 });
  const manifest = {
    id: "native.mark", version: "v1", sha256: sha(BODY), interpreter: "/bin/sh",
    arguments: {
      value: { required: true, pattern: "^[a-z]+$", maxLength: 32 },
      output: { required: true, maxLength: 1024 },
    },
  };
  await writeFile(join(installed, "manifest.json"), JSON.stringify(await release.sign(manifest)));
  const trust = join(root, "operation-trust.json");
  await writeFile(trust, JSON.stringify(release.trust), { mode: 0o644 });
  // The Platform's authority key: private half stays in the test, public half
  // is the trust file the Agent reads.
  const platform = await createReleaseSigner({ keyId: "platform-test" });
  const platformAuthority = join(root, "platform-authority.json");
  await writeFile(platformAuthority, JSON.stringify(platform.trust), { mode: 0o644 });
  return { root, operations, trust, manifest, platform, platformAuthority };
}

async function startAgent(t, options) {
  const controller = new AbortController();
  let ready;
  const readyPromise = new Promise((resolve) => { ready = resolve; });
  const running = runAgentCommand({ ...options, signal: controller.signal, onReady: ready });
  running.catch(() => undefined);
  const agent = await Promise.race([readyPromise, running.then(() => { throw new Error("agent exited"); })]);
  t.after(async () => { controller.abort(); await running.catch(() => undefined); });
  return agent;
}

async function waitForStatus(client, operationId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const summary = await client.getHostOperation(operationId);
    if (summary && (summary.status === "succeeded" || summary.status === "failed")) return summary;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`operation ${operationId} did not finish`);
}

test("the Agent executes an installed signed operation only with authority bound to its exact request", async (t) => {
  const { root, operations, trust, manifest, platform, platformAuthority } = await installation(t);
  const agent = await startAgent(t, { dataDirectory: join(root, "data"), operationsRoot: operations, operationTrust: trust, platformAuthority });
  assert.deepEqual(agent.operations.registered, ["native.mark@v1"]);
  const client = await createAgentProcessClient({ directory: join(root, "data", "agent") });
  t.after(() => client.close());
  const stranger = await createReleaseSigner({ keyId: "platform-test" });

  const request = async (value, { signWith = platform.privateKey, signedArguments } = {}) => {
    const output = join(root, `out-${value}`);
    const base = {
      operationId: `operation_${randomUUID().replaceAll("-", "")}`,
      operation: manifest.id, version: manifest.version, artifactDigest: manifest.sha256,
      arguments: { value, output }, deadline: new Date(Date.now() + 30_000).toISOString(),
    };
    const now = Date.now();
    const authority = await signAgentAuthority(signWith, {
      keyId: "platform-test",
      agentId: agent.operations.agentId, operationId: base.operationId, operation: base.operation,
      version: base.version, artifactDigest: base.artifactDigest,
      argumentsDigest: await hostOperationArgumentsDigest(signedArguments ?? base.arguments),
      actorId: "owner", issuedAt: now, expiresAt: now + 60_000, nonce: randomUUID(),
    });
    return { request: { ...base, authority }, output };
  };

  const good = await request("hello");
  assert.equal((await client.submitHostOperation(good.request)).status, "queued");
  assert.equal((await waitForStatus(client, good.request.operationId)).status, "succeeded");
  assert.equal(await readFile(good.output, "utf8"), "hello");

  // Wrong secret, and a valid envelope for different arguments: both fail
  // without running the artifact.
  // Same key id, different private key: not the Platform.
  const forged = await request("forged", { signWith: stranger.privateKey });
  await client.submitHostOperation(forged.request);
  assert.equal((await waitForStatus(client, forged.request.operationId)).status, "failed");
  const swapped = await request("swapped", { signedArguments: { value: "other", output: join(root, "out-other") } });
  await client.submitHostOperation(swapped.request);
  assert.equal((await waitForStatus(client, swapped.request.operationId)).status, "failed");
  for (const path of [forged.output, swapped.output, join(root, "out-other")]) {
    await assert.rejects(readFile(path), { code: "ENOENT" });
  }
});

test("an Agent without installed operations refuses operation requests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-agent-noops-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await startAgent(t, { dataDirectory: join(root, "data") });
  const client = await createAgentProcessClient({ directory: join(root, "data", "agent") });
  t.after(() => client.close());
  await assert.rejects(client.getHostOperation("operation_0000000000000000"), /does not execute host operations/);
});

test("operation options are validated before the Agent listens", async (t) => {
  const { root, operations, trust, platformAuthority } = await installation(t);
  const data = join(root, "data");
  await assert.rejects(runAgentCommand({ dataDirectory: data, operationsRoot: operations }), /requires --operation-trust/);
  await assert.rejects(runAgentCommand({ dataDirectory: data, operationsRoot: operations, operationTrust: trust }), /requires --platform-authority/);
  await assert.rejects(runAgentCommand({ dataDirectory: data, operationCgroup: "delegated" }), /require --operations-root/);
  if (process.platform !== "linux") {
    await assert.rejects(
      runAgentCommand({ dataDirectory: data, operationsRoot: operations, operationTrust: trust, platformAuthority, operationCgroup: "delegated" }),
      /requires Linux/,
    );
  }
  await chmod(trust, 0o666);
  await assert.rejects(
    runAgentCommand({ dataDirectory: data, operationsRoot: operations, operationTrust: trust, platformAuthority }),
    /must not be group- or world-writable/,
  );
});

test("the trust store file is structurally validated", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-trust-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "trust.json");
  const write = (value) => writeFile(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o644 });
  const key = { keyId: "k1", publicKey: "AAAA", notBefore: "2026-01-01T00:00:00Z", notAfter: "2027-01-01T00:00:00Z" };
  await write({ keys: [key], revokedKeyIds: ["k0"] });
  assert.deepEqual(await readHostOperationTrustStore(path), { keys: [key], revokedKeyIds: ["k0"] });
  for (const bad of [
    "not json",
    { keys: [key, key] },
    { keys: [{ ...key, notAfter: key.notBefore }] },
    { keys: [{ ...key, extra: true }] },
    { keys: [key], extra: [] },
    { keys: "k1" },
  ]) {
    await write(bad);
    await assert.rejects(readHostOperationTrustStore(path), /trust store/);
  }
  if (process.getuid?.() !== 0) {
    await write({ keys: [key] });
    await assert.rejects(readHostOperationTrustStore(path, { requireRootOwned: true }), /owned by root/);
  }
});

test("a missing Platform authority file refuses every request until it appears", async (t) => {
  const { root, operations, trust, manifest, platform, platformAuthority } = await installation(t);
  const { rename } = await import("node:fs/promises");
  const hidden = `${platformAuthority}.hidden`;
  await rename(platformAuthority, hidden);
  const agent = await startAgent(t, { dataDirectory: join(root, "data"), operationsRoot: operations, operationTrust: trust, platformAuthority });
  const client = await createAgentProcessClient({ directory: join(root, "data", "agent") });
  t.after(() => client.close());
  const submit = async (value) => {
    const output = join(root, `late-${value}`);
    const base = {
      operationId: `operation_${randomUUID().replaceAll("-", "")}`, operation: manifest.id, version: manifest.version,
      artifactDigest: manifest.sha256, arguments: { value, output }, deadline: new Date(Date.now() + 30_000).toISOString(),
    };
    const now = Date.now();
    const authority = await signAgentAuthority(platform.privateKey, {
      keyId: "platform-test", agentId: agent.operations.agentId, operationId: base.operationId, operation: base.operation,
      version: base.version, artifactDigest: base.artifactDigest, argumentsDigest: await hostOperationArgumentsDigest(base.arguments),
      actorId: "owner", issuedAt: now, expiresAt: now + 60_000, nonce: randomUUID(),
    });
    await client.submitHostOperation({ ...base, authority });
    return { status: (await waitForStatus(client, base.operationId)).status, output };
  };
  const before = await submit("before");
  assert.equal(before.status, "failed");
  await assert.rejects(readFile(before.output), { code: "ENOENT" });
  // Created later (the Platform started after the Agent): honoured without restart.
  await rename(hidden, platformAuthority);
  const after = await submit("after");
  assert.equal(after.status, "succeeded");
  assert.equal(await readFile(after.output, "utf8"), "after");
});
