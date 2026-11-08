import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Zelavis, createMemorySystemStore } from "../dist/index.js";
import { nodeAdapter } from "../dist/adapters/node.js";
import { createRemoteProjectAgent } from "../dist/adapters/_remote-project-agent.js";
import { createHttpsProjectDispatcher } from "../dist/adapters/_project-dispatch-https.js";
import { createProjectPlacementAuthority } from "../dist/platform/project-placement-authority.js";
import { createServer } from "node:http";
import { createWriterLeaseRoutes } from "../dist/platform/writer-lease-routes.js";
import { mintLeaseCapability } from "../dist/platform/lease-capability.js";
import { acquireWriter, memoryLeaseStore } from "../dist/db/writer-lease.js";

const run = promisify(execFile);
const OWNER = { principal: { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] } };

test("a remote Agent installs and runs a real locked Zelavis App Project", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zv-ra-"));
  const platformData = join(root, "platform");
  const agentData = join(root, "agent");
  const keyFile = join(root, "tls.key");
  const certFile = join(root, "tls.crt");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyFile, "-out", certFile, "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"]);
  const [keyPem, certPem] = await Promise.all([
    readFile(keyFile, "utf8"), readFile(certFile, "utf8"),
  ]);
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"],
  );
  const now = Date.now();
  const trust = { keys: [{
    keyId: "platform-test",
    publicKey: Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64"),
    notBefore: new Date(now - 60_000).toISOString(),
    notAfter: new Date(now + 60_000).toISOString(),
  }] };
  const zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: platformData }) });
  let agent;
  try {
    const created = await zv.fetch(new Request("http://localhost/zelavis/api/v1/runtime/projects", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "remote-app", name: "Remote App",
        recipeName: "@zelavis/app", start: false }),
    }), OWNER);
    assert.equal(created.status, 201, await created.clone().text());
    agent = await createRemoteProjectAgent({
      dataDirectory: agentData, host: "localhost", port: 0,
      keyPem, certPem, trust: () => trust, agentId: "agent-b", nodeId: "node-b",
    });
    const dispatcher = createHttpsProjectDispatcher({
      localNodeId: "node-a", projectsDirectory: join(platformData, "projects"),
      keyId: "platform-test", privateKey,
      destinations: { "node-b": { url: agent.address, caPem: certPem,
        agentId: "agent-b" } },
    });
    const authority = createProjectPlacementAuthority({
      store: createMemorySystemStore(), mayPlace: () => true,
    });
    const acquired = await authority.acquire({
      projectId: "remote-app", nodeId: "node-b", ownerSession: "session-a",
      expectedEpoch: 0, leaseMs: 8_000,
    });
    assert.equal(acquired.granted, true);
    const placement = acquired.placement;
    const token = { projectId: placement.projectId, nodeId: placement.nodeId,
      ownerSession: placement.ownerSession, epoch: placement.epoch };
    await dispatcher.dispatchLeaseFenced(placement);
    const startAuthority = await dispatcher.authorizeDispatch({ action: "start", placement: token });
    await dispatcher.dispatchStartFenced({ projectId: token.projectId,
      nodeId: token.nodeId, placement: token, authority: startAuthority });
    const remoteProject = JSON.parse(await readFile(join(agentData, "projects",
      "remote-app", "project.json"), "utf8"));
    assert.equal(remoteProject.recipe.artifact.digest, JSON.parse(await readFile(
      join(platformData, "projects", "remote-app", "project.json"), "utf8",
    )).recipe.artifact.digest);
    const stopAuthority = await dispatcher.authorizeDispatch({ action: "stop", placement: token });
    await dispatcher.dispatchStopFenced({ projectId: token.projectId,
      nodeId: token.nodeId, placement: token, authority: stopAuthority });
  } finally {
    await agent?.close();
    await zv.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a remote Agent runs a Project as its writer's standby from a signed, placement-free dispatch, and stops only that standby", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zv-ra-standby-"));
  const keyFile = join(root, "tls.key"), certFile = join(root, "tls.crt");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"]);
  const [keyPem, certPem] = await Promise.all([readFile(keyFile, "utf8"), readFile(certFile, "utf8")]);
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const now = Date.now();
  const trust = { keys: [{ keyId: "platform-test", publicKey: Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64"), notBefore: new Date(now - 60_000).toISOString(), notAfter: new Date(now + 60_000).toISOString() }] };
  const zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: join(root, "platform") }) });
  // A lease authority where another node holds a live lease: the standby follows and waits.
  const leases = memoryLeaseStore();
  await Effect.runPromise(acquireWriter(leases, { partition: "standby-app", owner: "node-a", ttlMillis: 60_000, standby: "node-b" }));
  const routes = createWriterLeaseRoutes(leases, undefined, { secret: async () => "secret", projectExists: async () => true });
  const authority = createServer(async (request, response) => {
    const route = routes.find((entry) => entry.id === (request.method === "GET" ? "runtime.projectLeases.read" : "runtime.projectLeases.write"));
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const answer = await route.handler({ params: { scope: "standby-app" }, request: new Request("http://authority/", { headers: request.headers }), body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined });
    response.writeHead(answer.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
  });
  await new Promise((resolve) => authority.listen(0, "127.0.0.1", resolve));
  let agent;
  try {
    assert.equal((await zv.fetch(new Request("http://localhost/zelavis/api/v1/runtime/projects", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "standby-app", name: "Standby App", recipeName: "@zelavis/app", start: false }),
    }), OWNER)).status, 201);
    agent = await createRemoteProjectAgent({ dataDirectory: join(root, "agent"), host: "localhost", port: 0, keyPem, certPem, trust: () => trust, agentId: "agent-b", nodeId: "node-b" });
    const dispatcher = createHttpsProjectDispatcher({ localNodeId: "node-a", projectsDirectory: join(root, "platform", "projects"), keyId: "platform-test", privateKey,
      destinations: { "node-b": { url: agent.address, caPem: certPem, agentId: "agent-b" } } });
    const lease = {
      ZELAVIS_LEASE_AUTHORITY: `http://127.0.0.1:${authority.address().port}/zelavis/api/v1`, ZELAVIS_LEASE_TOKEN: await mintLeaseCapability("secret", { scope: "standby-app", node: "node-b" }),
      ZELAVIS_LEASE_NODE: "node-b", ZELAVIS_LEASE_STANDBY: "node-a", ZELAVIS_LEASE_ROLE: "standby", ZELAVIS_LEASE_TTL_MILLIS: "3000",
      ZELAVIS_LEASE_ENDPOINT: "http://127.0.0.1:1/zelavis",
    };
    // No placement was ever committed on node-b, and none is asked for.
    await dispatcher.dispatchStandbyFenced({ projectId: "standby-app", nodeId: "node-b", ownerSession: "session-a", epoch: 1, lease });
    assert.equal((await agent.status("standby-app")).status, "standby", "the Agent runs the Project as a standby");
    assert.equal(JSON.parse(await readFile(join(root, "agent", "projects", "standby-app", "project.json"), "utf8")).id, "standby-app", "from the descriptor it was sent");

    // Asking it again is not a second process.
    await dispatcher.dispatchStandbyFenced({ projectId: "standby-app", nodeId: "node-b", ownerSession: "session-a", epoch: 1, lease });
    assert.equal((await agent.status("standby-app")).status, "standby");

    await dispatcher.dispatchStandbyStopFenced({ projectId: "standby-app", nodeId: "node-b", ownerSession: "session-a", epoch: 1 });
    assert.equal((await agent.status("standby-app")).status, "stopped");
    assert.equal((await Effect.runPromise(leases.read("standby-app"))).lease.owner, "node-a", "stopping a standby never promotes it");
  } finally {
    await agent?.close();
    authority.close();
    await zv.close();
    await rm(root, { recursive: true, force: true });
  }
});
