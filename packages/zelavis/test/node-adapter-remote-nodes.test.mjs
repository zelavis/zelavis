// The Node host's remote dispatch wiring: configured nodes plus nodes that
// enrolled at runtime, through the real adapter and System Store.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";
import { promisify } from "node:util";
import { Effect } from "effect";

import { nodeAdapter } from "../dist/adapters/node.js";
import { createNodeEnrollmentAuthority } from "../dist/platform/node-enrollment.js";
import { createNodeInstallHost } from "../dist/adapters/_install-host.js";

const run = promisify(execFile);
let certPem;
let directory;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "zelavis-remote-nodes-"));
  const keyFile = join(directory, "agent.key");
  const certFile = join(directory, "agent.crt");
  await run("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", "/CN=agent"]);
  certPem = await readFile(certFile, "utf8");
});

async function host(t, { localNodeId = "local", nodes } = {}) {
  const data = await mkdtemp(join(tmpdir(), "zelavis-host-"));
  const caFile = join(data, "fixed-ca.pem");
  await writeFile(caFile, certPem);
  const adapter = nodeAdapter({
    dataDirectory: data,
    services: false,
    projects: {
      directory: join(data, "projects"),
      remoteDispatch: {
        localNodeId,
        nodes: nodes ?? { fixed: { url: "https://127.0.0.1:9", agentId: "static-agent", caFile } },
      },
    },
  });
  const constructorOptions = {};
  t.after(async () => {
    await adapter.close(constructorOptions);
    await rm(data, { recursive: true, force: true });
  });
  const resolved = await adapter.resolve(constructorOptions);
  const registry = createNodeEnrollmentAuthority({ store: resolved.resources.systemStore });
  const enroll = async (nodeId) => {
    const minted = await Effect.runPromise(registry.mint({ nodeId, origin: "cloud" }));
    return Effect.runPromise(registry.complete({ nodeId, token: minted.token, certPem, url: "https://127.0.0.1:9" }));
  };
  const inventory = async () => (await resolved.subsystems.fabric.inventory.nodes()).map((node) => node.id).sort();
  const claimsOf = (token) => {
    const [, agentId, action, , nodeId] = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
    return { agentId, action, nodeId };
  };
  const stop = (nodeId) => resolved.projectDispatcher.authorizeDispatch({
    action: "stop",
    placement: { projectId: "project-a", nodeId, ownerSession: "session-a", epoch: 2 },
  });
  return { resolved, registry, enroll, inventory, claimsOf, stop };
}

test("a node that enrolls after startup appears in the inventory and can be dispatched to, without a restart", async (t) => {
  const { enroll, inventory, claimsOf, stop, registry } = await host(t);
  assert.deepEqual(await inventory(), ["fixed", "local"]);
  await assert.rejects(() => stop("late"), /No Agent endpoint is configured for Node "late"\./);

  await enroll("late");
  assert.deepEqual(await inventory(), ["fixed", "late", "local"]);
  assert.deepEqual(claimsOf(await stop("late")), { agentId: "agent-late", action: "stop", nodeId: "late" });

  await Effect.runPromise(registry.revoke("late"));
  assert.deepEqual(await inventory(), ["fixed", "local"]);
  await assert.rejects(() => stop("late"), /No Agent endpoint is configured for Node "late"\./);
});

test("a configured node keeps its pinned Agent even if a registry node claims the same id", async (t) => {
  const { enroll, inventory, claimsOf, stop } = await host(t);
  await enroll("fixed");
  assert.deepEqual(await inventory(), ["fixed", "local"], "listed once");
  assert.equal(claimsOf(await stop("fixed")).agentId, "static-agent", "the operator's pin wins");
});

test("the local node id cannot be taken over through the registry", async (t) => {
  const { enroll, inventory, stop } = await host(t);
  await enroll("local");
  assert.deepEqual(await inventory(), ["fixed", "local"], "listed once, as the local node");
  await assert.rejects(() => stop("local"), /No Agent endpoint is configured for Node "local"\./);
});

test("the unreachable nodes are reported unavailable, not omitted", async (t) => {
  const { enroll, resolved } = await host(t);
  await enroll("late");
  const nodes = await resolved.subsystems.fabric.inventory.nodes();
  const byId = Object.fromEntries(nodes.map((node) => [node.id, node.status]));
  assert.equal(byId.local, "ready");
  assert.equal(byId.fixed, "unavailable");
  assert.equal(byId.late, "unavailable");
});

test("a local node id that collides with a configured node is refused, with the original error, and ownership is released", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "zelavis-host-"));
  const caFile = join(data, "ca.pem");
  await writeFile(caFile, certPem);
  const adapter = nodeAdapter({
    dataDirectory: data, services: false,
    projects: { directory: join(data, "projects"), remoteDispatch: {
      localNodeId: "same", nodes: { same: { url: "https://127.0.0.1:9", agentId: "a", caFile } } } },
  });
  const constructorOptions = {};
  t.after(() => rm(data, { recursive: true, force: true }));
  await assert.rejects(() => adapter.resolve(constructorOptions), /Remote dispatch needs a distinct local Fabric Node id\./);
  await adapter.close(constructorOptions);
  assert.deepEqual(await createNodeInstallHost().dataOwnership(data), { active: false });
});

test("an enrolled node becomes ready only when a real Agent answers as that node", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-live-agent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keyFile = join(root, "tls.key");
  const certFile = join(root, "tls.crt");
  await run("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"]);
  const [keyPem, liveCertPem] = await Promise.all([readFile(keyFile, "utf8"), readFile(certFile, "utf8")]);
  const { publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const now = Date.now();
  const trust = { keys: [{
    keyId: "platform-a",
    publicKey: Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64"),
    notBefore: new Date(now - 60_000).toISOString(),
    notAfter: new Date(now + 60_000).toISOString(),
  }] };

  const { createRemoteProjectAgent } = await import("../dist/adapters/_remote-project-agent.js");
  const agent = await createRemoteProjectAgent({
    dataDirectory: join(root, "agent"), host: "localhost", port: 0,
    keyPem, certPem: liveCertPem, trust, agentId: "agent-late", nodeId: "late",
  });
  t.after(() => agent.close());

  const { registry, inventory, resolved } = await host(t);
  const enrollAt = async (nodeId) => {
    const minted = await Effect.runPromise(registry.mint({ nodeId, origin: "cloud" }));
    return Effect.runPromise(registry.complete({ nodeId, token: minted.token, certPem: liveCertPem, url: agent.address }));
  };
  await enrollAt("late");
  await enrollAt("imposter");

  const status = Object.fromEntries((await resolved.subsystems.fabric.inventory.nodes()).map((node) => [node.id, node.status]));
  assert.equal(status.late, "ready", "the Agent answered as the node it enrolled as");
  assert.equal(status.imposter, "unavailable", "the same endpoint, registered under another node id, is not trusted");
  assert.deepEqual(await inventory(), ["fixed", "imposter", "late", "local"]);
});
