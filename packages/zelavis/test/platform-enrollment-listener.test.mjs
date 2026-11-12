import assert from "node:assert/strict";
import test from "node:test";
import { ZELAVIS_VERSION } from "../dist/version.js";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Exit, Scope } from "effect";
import { createNodePlatformHost } from "../dist/adapters/_node-platform-host.js";
import { createPinnedFetch } from "../dist/adapters/_pinned-fetch.js";
import { generateAgentCertificate } from "../dist/adapters/_agent-certificate.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";

const release = { version: "1.0.0", digest: `sha256:${"a".repeat(64)}` };
const bootstrapToken = "platform-host-ownership-first-owner-token";
const worker = fileURLToPath(new URL("../dist/adapters/_node-runtime-worker.js", import.meta.url));
const module = fileURLToPath(new URL("../dist/adapters/_node-platform-engine.js", import.meta.url));

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

test("the persistent host serves the enrollment listener: machines pin its certificate and join, nothing else is reachable", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "zv-enroll-host-"));
  const scope = Scope.makeUnsafe(), logs = [];
  try {
    const enrollmentPort = await freePort();
    const host = await Effect.runPromise(createNodePlatformHost({
      dataDirectory: directory, host: "127.0.0.1", initial: release,
      environment: { ZELAVIS_BOOTSTRAP_TOKEN: bootstrapToken }, startupTimeoutMs: 20_000,
      configuration: { enrollment: { port: enrollmentPort, addresses: ["127.0.0.1"] } },
      output: (stream, line) => logs.push({ stream, line }),
      resolve: (_release, configuration, environment) => Effect.succeed({ executable: process.execPath, worker, module, cwd: directory, configuration, environment }),
    }).pipe(Effect.provideService(Scope.Scope, scope)));
    const port = await Effect.runPromise(host.listen({ host: "127.0.0.1", port: 0 }));
    const url = `http://127.0.0.1:${port}`;
    const anonymous = createZelavisClient({ baseUrl: url });
    await anonymous.json("/auth/bootstrap", { method: "POST", body: { bootstrapToken, provider: "password",
      account: { email: "owner@example.com" }, credential: { identifier: "owner@example.com", password: "correct horse battery staple" } } });
    const { session } = await anonymous.auth.signInWithPassword({ identifier: "owner@example.com", password: "correct horse battery staple" });
    const owner = createZelavisClient({ baseUrl: url, headers: { authorization: `Bearer ${session.token}` } });

    const endpoint = await owner.nodes.platform();
    assert.ok(endpoint, JSON.stringify(logs));
    assert.equal(endpoint.url, `https://127.0.0.1:${enrollmentPort}`);
    assert.match(endpoint.fingerprint, /^[0-9a-f]{64}$/);

    const issued = await owner.nodes.createEnrollment({ nodeId: "node-a" });
    const pinned = createPinnedFetch({ fingerprint: endpoint.fingerprint });
    const agent = generateAgentCertificate({ names: ["203.0.113.9"] });
    const joined = await pinned(`${endpoint.url}/zelavis/api/v1/runtime/nodes/enroll`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: "node-a", token: issued.token, certPem: agent.certPem, url: "https://203.0.113.9:8443", version: ZELAVIS_VERSION }),
    });
    assert.equal(joined.status, 200, await joined.clone().text());
    assert.equal((await joined.json()).agentId, "agent-node-a");
    assert.equal((await owner.nodes.list()).nodes[0].nodeId, "node-a");

    const refreshed = await pinned(`${endpoint.url}/zelavis/api/v1/runtime/nodes/trust`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    assert.equal(refreshed.status, 200, "a joined machine can refresh the Platform's keys on the same ingress");
    assert.ok(Array.isArray((await refreshed.json()).trust.keys));
    for (const path of ["/zelavis/", "/zelavis/api/v1/runtime/nodes", "/zelavis/api/v1/runtime/nodes/audit", "/auth/bootstrap"]) {
      assert.equal((await pinned(`${endpoint.url}${path}`)).status, 404, path);
    }
    await assert.rejects(createPinnedFetch({ fingerprint: "ab".repeat(32) })(`${endpoint.url}/zelavis/api/v1/runtime/nodes/enroll`, { method: "POST", body: "{}" }), /pinned fingerprint/);
  } catch (error) { console.error(JSON.stringify(logs)); throw error; }
  finally { await Effect.runPromise(Scope.close(scope, Exit.void)); await rm(directory, { recursive: true, force: true }); }
});

test("a bad enrollment port is refused before anything listens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zv-enroll-bad-"));
  const scope = Scope.makeUnsafe();
  try {
    await assert.rejects(Effect.runPromise(createNodePlatformHost({
      dataDirectory: directory, host: "127.0.0.1", initial: release, environment: {},
      configuration: { enrollment: { port: 80, addresses: [] } },
      resolve: () => Effect.succeed({ executable: process.execPath, worker, module, cwd: directory, configuration: {}, environment: {} }),
    }).pipe(Effect.provideService(Scope.Scope, scope))), /enrollment port/);
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)); await rm(directory, { recursive: true, force: true }); }
});
