import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createNodeHostOperationExecutor } from "../dist/adapters/_node-host-operation-executor.js";
import { createAgentProcessClient } from "../dist/adapters/_agent-ipc.js";
import { readOrCreatePlatformAuthorityKey } from "../dist/adapters/_platform-authority-key.js";
import { runAgentCommand } from "../dist/cli/agent.js";
import { createHostOperationBroker, createMemorySystemStore } from "../dist/index.js";
import { createReleaseSigner } from "./fixtures/host-operation-signing.mjs";

const sha = (body) => createHash("sha256").update(body).digest("hex");
const signer = await createReleaseSigner();
let sequence = 0;

async function run(t, body, result) {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-op-result-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "ops");
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, "op"), body, { mode: 0o700 });
  const manifest = { id: "native.result", version: "v1", sha256: sha(body), interpreter: "/bin/sh", arguments: {}, ...(result ? { result } : {}) };
  const executor = await createNodeHostOperationExecutor({
    rootDirectory: root, stagingDirectory: directory, trust: signer.trust, authorize: async () => true,
    operations: [{ file: "op", signed: await signer.sign(manifest) }],
  });
  return executor.execute({
    operationId: `operation_result_${String(sequence += 1).padStart(8, "0")}`, operation: manifest.id, version: "v1",
    artifactDigest: manifest.sha256, authority: "x", arguments: {}, deadline: new Date(Date.now() + 10_000).toISOString(),
  });
}

test("only a declared, bounded JSON object becomes a result", async (t) => {
  const declared = { format: "json", maxBytes: 64 };
  const ok = await run(t, `printf '{"ready":true}\\n'`, declared);
  assert.equal(ok.status, "succeeded");
  assert.deepEqual(ok.result, { ready: true });

  for (const [body, reason] of [
    ["printf 'not json'", /not valid JSON/],
    ["printf '[1,2]'", /not a JSON object/],
    [`printf '{"pad":"${"x".repeat(80)}"}'`, /exceeds 64 bytes/],
  ]) {
    const failed = await run(t, body, declared);
    assert.equal(failed.status, "failed", body);
    assert.equal(failed.result, undefined);
    assert.match(failed.resultError, reason);
  }
  // Undeclared: stdout is never a result.
  const undeclared = await run(t, `printf '{"ready":true}'`);
  assert.equal(undeclared.result, undefined);
  assert.equal(undeclared.status, "succeeded");
  await assert.rejects(signer.sign({ id: "x.y", version: "v1", sha256: "a".repeat(64), arguments: {}, result: { format: "json", maxBytes: 70_000 } }), /result must be/);
});

test("the shipped host report runs through Platform broker and Agent and returns its result", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-host-report-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shipped = fileURLToPath(new URL("../../../distribution/operations/zelavis.host-report/v1/", import.meta.url));
  const template = JSON.parse(await readFile(join(shipped, "operation.json"), "utf8"));
  const installed = join(root, "operations", template.id, template.version);
  await mkdir(installed, { recursive: true, mode: 0o700 });
  await copyFile(join(shipped, "artifact"), join(installed, "artifact"));
  const artifact = await readFile(join(installed, "artifact"));
  await writeFile(join(installed, "manifest.json"), JSON.stringify(await signer.sign({ ...template, sha256: sha(artifact) })));
  const trust = join(root, "operation-trust.json");
  await writeFile(trust, JSON.stringify(signer.trust), { mode: 0o644 });
  const authority = await readOrCreatePlatformAuthorityKey(join(root, "platform", "agent-authority"));

  const controller = new AbortController();
  let ready;
  const readyPromise = new Promise((resolve) => { ready = resolve; });
  const running = runAgentCommand({
    dataDirectory: join(root, "agent"), operationsRoot: join(root, "operations"), operationTrust: trust,
    platformAuthority: authority.trustFile, signal: controller.signal, onReady: ready,
  });
  t.after(async () => { controller.abort(); await running.catch(() => undefined); });
  await readyPromise;
  const client = await createAgentProcessClient({ directory: join(root, "agent", "agent") });
  t.after(() => client.close());
  const broker = createHostOperationBroker({ agent: client, signer: authority.signer, store: createMemorySystemStore() });

  const operator = { id: "ops", type: "user", permissions: ["server.host.report"] };
  const [entry] = await broker.catalog(operator);
  assert.deepEqual(entry.result, { format: "json", maxBytes: 4096 });
  const submitted = await broker.submit({ operation: "zelavis.host-report" }, operator);
  let record;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    record = await broker.get(submitted.operationId, operator);
    if (["succeeded", "failed"].includes(record.agent?.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(record.agent.status, "succeeded", JSON.stringify(record));
  const report = record.agent.result;
  assert.equal(report.schema, 1);
  assert.equal(typeof report.cpus, "number");
  assert.equal(report.architecture.length > 0, true);
  if (process.platform === "linux") {
    assert.equal(typeof report.memoryTotalKiB, "number");
    assert.ok(["v1", "v2", null].includes(report.cgroup));
  }
  // Permission for a different operation does not reach this one.
  await assert.rejects(broker.submit({ operation: "zelavis.host-report" }, { id: "x", type: "user", permissions: ["project.hosting.reload"] }), /Missing permission/);
});
