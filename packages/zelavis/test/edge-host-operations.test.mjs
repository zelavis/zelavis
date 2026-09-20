import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runAgentCommand } from "../dist/cli/agent.js";
import { createAgentProcessClient } from "../dist/adapters/_agent-ipc.js";
import { hostOperationArgumentsDigest, signAgentAuthority } from "../dist/index.js";
import { createReleaseSigner } from "./fixtures/host-operation-signing.mjs";

const sha = (body) => createHash("sha256").update(body).digest("hex");

const DISTRIBUTION_OPERATIONS = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "distribution",
  "operations",
);

async function setupEdgeOperationsInstallation(t) {
  const root = await mkdtemp(join(tmpdir(), "zelavis-edge-ops-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const release = await createReleaseSigner();
  const operationsRoot = join(root, "operations");
  await mkdir(operationsRoot, { recursive: true, mode: 0o700 });

  // Read and sign all zelavis.edge-* operations from distribution/operations
  const operationIds = [
    "zelavis.edge-stage",
    "zelavis.edge-validate",
    "zelavis.edge-unit-control",
    "zelavis.edge-probe",
    "zelavis.edge-activate",
    "zelavis.edge-drain",
    "zelavis.edge-rollback",
  ];

  const manifests = new Map();

  for (const opId of operationIds) {
    const srcDir = join(DISTRIBUTION_OPERATIONS, opId, "v1");
    const targetDir = join(operationsRoot, opId, "v1");
    await mkdir(targetDir, { recursive: true, mode: 0o700 });

    const rawTemplate = JSON.parse(await readFile(join(srcDir, "operation.json"), "utf8"));
    const artifact = await readFile(join(srcDir, "artifact"));
    const artifactSha = sha(artifact);

    const manifest = {
      ...rawTemplate,
      sha256: artifactSha,
    };

    const signedEnvelope = await release.sign(manifest);

    await writeFile(join(targetDir, "artifact"), artifact, { mode: 0o700 });
    await writeFile(
      join(targetDir, "manifest.json"),
      JSON.stringify(signedEnvelope, null, 2),
    );

    manifests.set(opId, manifest);
  }

  const trustFile = join(root, "operation-trust.json");
  await writeFile(trustFile, JSON.stringify(release.trust), { mode: 0o644 });

  const platform = await createReleaseSigner({ keyId: "platform-edge-test" });
  const platformAuthority = join(root, "platform-authority.json");
  await writeFile(platformAuthority, JSON.stringify(platform.trust), { mode: 0o644 });

  const edgeBaseDir = join(root, "traefik");
  await mkdir(edgeBaseDir, { recursive: true });

  return {
    root,
    operationsRoot,
    trustFile,
    manifests,
    platform,
    platformAuthority,
    edgeBaseDir,
  };
}

async function startTestAgent(t, options) {
  const controller = new AbortController();
  let ready;
  const readyPromise = new Promise((resolve) => {
    ready = resolve;
  });
  const running = runAgentCommand({
    ...options,
    signal: controller.signal,
    onReady: ready,
  });
  running.catch(() => undefined);
  const agent = await Promise.race([
    readyPromise,
    running.then(() => {
      throw new Error("agent exited unexpectedly");
    }),
  ]);
  t.after(async () => {
    controller.abort();
    await running.catch(() => undefined);
  });
  return agent;
}

async function waitForOperation(client, operationId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const summary = await client.getHostOperation(operationId);
    if (summary && (summary.status === "succeeded" || summary.status === "failed")) {
      return summary;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`operation ${operationId} did not finish in time`);
}

test("Signed Edge Host Operations: lifecycle, envelope authorization, and execution", async (t) => {
  const {
    root,
    operationsRoot,
    trustFile,
    manifests,
    platform,
    platformAuthority,
    edgeBaseDir,
  } = await setupEdgeOperationsInstallation(t);

  const agent = await startTestAgent(t, {
    dataDirectory: join(root, "data"),
    operationsRoot,
    operationTrust: trustFile,
    platformAuthority,
  });

  // Verify all 7 operations are registered
  const expectedRegistered = [
    "zelavis.edge-activate@v1",
    "zelavis.edge-drain@v1",
    "zelavis.edge-probe@v1",
    "zelavis.edge-rollback@v1",
    "zelavis.edge-stage@v1",
    "zelavis.edge-unit-control@v1",
    "zelavis.edge-validate@v1",
  ];
  assert.deepEqual(agent.operations.registered.slice().sort(), expectedRegistered);

  const client = await createAgentProcessClient({
    directory: join(root, "data", "agent"),
  });
  t.after(() => client.close());

  // Helper to submit signed request
  const submitOperation = async (opId, args, { signWith = platform.privateKey } = {}) => {
    const manifest = manifests.get(opId);
    const operationId = `op_${randomUUID().replaceAll("-", "")}`;
    const base = {
      operationId,
      operation: manifest.id,
      version: manifest.version,
      artifactDigest: manifest.sha256,
      arguments: args,
      deadline: new Date(Date.now() + 30_000).toISOString(),
    };
    const now = Date.now();
    const authority = await signAgentAuthority(signWith, {
      keyId: "platform-edge-test",
      agentId: agent.operations.agentId,
      operationId: base.operationId,
      operation: base.operation,
      version: base.version,
      artifactDigest: base.artifactDigest,
      argumentsDigest: await hostOperationArgumentsDigest(base.arguments),
      actorId: "owner",
      issuedAt: now,
      expiresAt: now + 60_000,
      nonce: randomUUID(),
    });

    const submitResult = await client.submitHostOperation({ ...base, authority });
    assert.equal(submitResult.status, "queued");
    return waitForOperation(client, operationId);
  };

  // 1. Test zelavis.edge-stage: stage dynamic config and certificate
  const configContent = JSON.stringify({
    http: {
      routers: {
        router_platform_http: {
          entryPoints: ["web"],
          rule: "Host(`app.test`)",
          service: "svc_platform",
        },
      },
      services: {
        svc_platform: {
          loadBalancer: {
            servers: [{ url: "http://127.0.0.1:8080" }],
          },
        },
      },
    },
  });
  const manifestContent = JSON.stringify({
    schemaVersion: 1,
    generation: "rev-1",
    revision: 1,
    compiledAt: "2026-09-20T00:00:00.000Z",
    routerCount: 1,
    serviceCount: 1,
    contentHash: sha(configContent),
  });

  const stageResult = await submitOperation("zelavis.edge-stage", {
    generation: "rev-1",
    "base-dir": edgeBaseDir,
    "config-json": configContent,
    "manifest-json": manifestContent,
    "cert-name": "app.test",
    "cert-pem": "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
    "key-pem": "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----",
  });

  assert.equal(stageResult.status, "succeeded");
  assert.equal(stageResult.result.status, "staged");
  assert.equal(stageResult.result.generation, "rev-1");

  // Verify files on disk
  const stagedConfig = await readFile(
    join(edgeBaseDir, "generations", "rev-1", "traefik-dynamic.json"),
    "utf8",
  );
  assert.equal(stagedConfig.trim(), configContent.trim());
  const stagedCert = await readFile(join(edgeBaseDir, "certs", "app.test.crt"), "utf8");
  assert.ok(stagedCert.includes("BEGIN CERTIFICATE"));

  // 2. Test zelavis.edge-validate: validate the staged generation
  const validateResult = await submitOperation("zelavis.edge-validate", {
    generation: "rev-1",
    "base-dir": edgeBaseDir,
  });
  assert.equal(validateResult.status, "succeeded");
  assert.equal(validateResult.result.valid, true);
  assert.equal(validateResult.result.generation, "rev-1");

  // 3. Test zelavis.edge-probe: probe a local HTTP endpoint
  const testServer = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => testServer.listen(0, "127.0.0.1", resolve));
  t.after(() => testServer.close());
  const serverPort = testServer.address().port;

  const probeResult = await submitOperation("zelavis.edge-probe", {
    url: `http://127.0.0.1:${serverPort}/healthz`,
    "expected-status": "200",
  });
  assert.equal(probeResult.status, "succeeded");
  assert.equal(probeResult.result.healthy, true);
  assert.equal(probeResult.result.statusCode, 200);

  // 4. Test zelavis.edge-activate: atomically make rev-1 active
  const activateResult = await submitOperation("zelavis.edge-activate", {
    generation: "rev-1",
    "base-dir": edgeBaseDir,
  });
  assert.equal(activateResult.status, "succeeded");
  assert.equal(activateResult.result.status, "activated");
  assert.equal(activateResult.result.generation, "rev-1");

  // Verify active dynamic configuration is in place
  const activeConfig = await readFile(
    join(edgeBaseDir, "active", "traefik-dynamic.json"),
    "utf8",
  );
  assert.equal(activeConfig.trim(), configContent.trim());

  // 5. Test zelavis.edge-drain
  const drainResult = await submitOperation("zelavis.edge-drain", {
    "duration-ms": "50",
  });
  assert.equal(drainResult.status, "succeeded");
  assert.equal(drainResult.result.status, "drained");

  // 6. Test second generation rev-2 + zelavis.edge-rollback
  const config2Content = JSON.stringify({
    http: {
      routers: {
        router_platform_v2: {
          entryPoints: ["web"],
          rule: "Host(`v2.test`)",
          service: "svc_v2",
        },
      },
      services: {},
    },
  });

  await submitOperation("zelavis.edge-stage", {
    generation: "rev-2",
    "base-dir": edgeBaseDir,
    "config-json": config2Content,
  });

  const activate2Result = await submitOperation("zelavis.edge-activate", {
    generation: "rev-2",
    "base-dir": edgeBaseDir,
  });
  assert.equal(activate2Result.result.generation, "rev-2");
  assert.equal(activate2Result.result.previousGeneration, "rev-1");

  // Verify active is now rev-2
  const activeV2 = await readFile(
    join(edgeBaseDir, "active", "traefik-dynamic.json"),
    "utf8",
  );
  assert.equal(activeV2.trim(), config2Content.trim());

  // Rollback to previous generation (rev-1)
  const rollbackResult = await submitOperation("zelavis.edge-rollback", {
    "base-dir": edgeBaseDir,
  });
  assert.equal(rollbackResult.status, "succeeded");
  assert.equal(rollbackResult.result.status, "rolled_back");
  assert.equal(rollbackResult.result.restoredGeneration, "rev-1");

  // Verify active is restored to rev-1
  const activeRestored = await readFile(
    join(edgeBaseDir, "active", "traefik-dynamic.json"),
    "utf8",
  );
  assert.equal(activeRestored.trim(), configContent.trim());

  // 7. Test zelavis.edge-unit-control
  const unitResult = await submitOperation("zelavis.edge-unit-control", {
    action: "status",
    unit: "zelavis-traefik.service",
  });
  assert.equal(unitResult.status, "succeeded");
  assert.equal(unitResult.result.unit, "zelavis-traefik.service");
  assert.equal(unitResult.result.action, "status");

  // 8. Test forged / untrusted envelope is rejected
  const stranger = await createReleaseSigner({ keyId: "stranger" });
  const forgedResult = await submitOperation(
    "zelavis.edge-stage",
    { generation: "rev-forged", "base-dir": edgeBaseDir },
    { signWith: stranger.privateKey },
  );
  assert.equal(forgedResult.status, "failed");
});
