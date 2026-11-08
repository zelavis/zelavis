// An App Project places a shard on another Node, end to end: a real Platform, a real remote Agent behind a TCP proxy that
// can be cut, and a real `@zelavis/app` Project process. Each scenario names the contract invariant it proves
// (`.agents/references/two-fabrics-placement-contract.md`, "Invariants").
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import net from "node:net";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Zelavis } from "../dist/index.js";
import { nodeAdapter } from "../dist/adapters/node.js";
import { createLocalSqliteSystemStore } from "../dist/adapters/_sqlite-system-store.js";
import { createRemoteProjectAgent } from "../dist/adapters/_remote-project-agent.js";
import { createHttpsProjectDispatcher } from "../dist/adapters/_project-dispatch-https.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runShardsCommand } from "../dist/cli/shards.js";
import { virtualRangeFor } from "../dist/db/topology.js";
import { mintAppShardCapability } from "../dist/platform/app-shard-capability.js";
import { loadPlatformMasterSecret } from "../dist/platform/master-secret.js";

const run = promisify(execFile);
const OWNER = { principal: { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] } };
const API = "http://127.0.0.1/zelavis/api/v1/runtime";
const MAP = { virtualRanges: 256 };
const RESOURCES = { cpuCores: 1, memoryBytes: 2 ** 30, diskBytes: 8 * 2 ** 30 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (read, accept, what, deadline = 60_000) => {
  const end = Date.now() + deadline;
  let last;
  while (Date.now() < end) {
    last = await read();
    if (accept(last)) return last;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}; last: ${JSON.stringify(last)}`);
};
const scoped = (id, ...grants) => ({ principal: { id, type: "service", grants: grants.map(([permission, projectId]) => ({ permission, scope: { type: "project", projectId } })) } });

/** A TCP forwarder in front of the Agent: TLS stays end to end, so the certificate and its pinning are unchanged. */
const startProxy = async (target) => {
  const sockets = new Set();
  let cut = false;
  const server = net.createServer((client) => {
    if (cut) { client.destroy(); return; }
    const upstream = net.connect(target.port, "localhost");
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => socket.destroy());
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise((resolve) => server.listen(0, "localhost", resolve));
  return {
    port: server.address().port,
    cut() { cut = true; for (const socket of sockets) socket.destroy(); },
    heal() { cut = false; },
    close: () => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve); }),
  };
};

/** A real Platform, a remote Agent on "node-b" behind a cuttable proxy, and a running App Project `sharded` allowed to use node-b. */
async function setup(t, { allocate = true, projects = ["sharded"], readLimits, agents = ["node-b"] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zv-shard-remote-"));
  const saved = process.env.ZELAVIS_APP_SHARDS_URL;
  const self = { root };
  const closers = [];
  t.after(async () => {
    if (saved === undefined) delete process.env.ZELAVIS_APP_SHARDS_URL; else process.env.ZELAVIS_APP_SHARDS_URL = saved;
    for (const close of closers.reverse()) await close().catch((error) => console.error("cleanup:", error));
    await rm(root, { recursive: true, force: true });
  });

  const keyFile = join(root, "tls.key"), certFile = join(root, "tls.crt");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"]);
  const [keyPem, certPem] = await Promise.all([readFile(keyFile, "utf8"), readFile(certFile, "utf8")]);
  let trust = { keys: [] };
  self.agents = {};
  self.proxies = {};
  self.certPem = certPem;
  self.agentShardsOn = async (id) => {
    const entries = await readdir(join(root, id, "shards"), { recursive: true }).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return [];
    });
    return entries.filter((entry) => entry.endsWith(".sqlite"));
  };
  const nodes = {};
  for (const nodeId of agents) {
    const target = { port: 0 };
    const agentId = nodeId.replace("node-", "agent-");
    const startAgent = async () => {
      const agent = await createRemoteProjectAgent({
        dataDirectory: join(root, nodeId), host: "localhost", port: target.port, keyPem, certPem, trust: () => trust, agentId, nodeId,
        ...(readLimits === undefined ? {} : { shards: { readLimits } }),
      });
      target.port = Number(new URL(agent.address).port);
      self.agents[nodeId] = agent;
    };
    await startAgent();
    closers.push(() => self.agents[nodeId].close());
    const proxy = await startProxy(target);
    self.proxies[nodeId] = proxy;
    closers.push(() => proxy.close());
    nodes[nodeId] = { url: `https://localhost:${proxy.port}`, agentId, caFile: certFile };
    if (nodeId === "node-b") {
      self.restartAgent = async () => { await self.agents[nodeId].close(); await startAgent(); };
    }
  }
  Object.defineProperty(self, "agent", { get: () => self.agents["node-b"] });
  self.proxy = self.proxies["node-b"];
  self.agentUrl = nodes["node-b"].url;
  self.agentShards = () => self.agentShardsOn("node-b");

  // The Platform's API as a Project process sees it.
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const answer = await self.zv.fetch(new Request(`http://127.0.0.1:${server.address().port}${request.url}`, {
        method: request.method, headers: request.headers, ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
      }));
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      response.end(Buffer.from(await answer.arrayBuffer()));
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  process.env.ZELAVIS_APP_SHARDS_URL = `http://127.0.0.1:${server.address().port}/zelavis/api/v1`;

  const platform = () => new Zelavis({ adapter: nodeAdapter({
    dataDirectory: join(root, "platform"),
    projects: { remoteDispatch: { localNodeId: "node-a", nodes } },
  }) });
  self.zv = platform();
  closers.push(() => self.zv.close());
  self.restartPlatform = async () => {
    server.closeAllConnections();
    await self.zv.close();
    self.zv = platform();
    assert.equal((await self.call("GET", "/config")).status, 200);
  };
  self.call = async (method, path, body, who = OWNER) => {
    const answer = await self.zv.fetch(new Request(`${API}${path}`, {
      method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), who);
    return { status: answer.status, body: await answer.json().catch(() => undefined) };
  };
  self.clientAs = (who = OWNER) => createZelavisClient({ baseUrl: "http://localhost", rootPath: "/zelavis", fetch: (input, init) => self.zv.fetch(new Request(input, init), who) });
  self.client = self.clientAs();
  assert.equal((await self.call("GET", "/config")).status, 200);
  self.systemStore = createLocalSqliteSystemStore({ filename: join(root, "platform", "system", "zelavis.sqlite") });
  closers.push(async () => self.systemStore.close?.());
  trust = (await self.systemStore.get("fabric.agent-trust.v1", "platform")).value;
  self.secret = await loadPlatformMasterSecret(self.systemStore);

  self.running = (id) => until(async () => (await self.call("GET", `/projects/${id}`)).body?.project, (project) => project?.runtime?.status === "running", `${id} to run`, 90_000);
  self.allocate = (id) => self.client.shardPlacement.setAllocation(id, { allowedNodeIds: agents, cpuCores: 4, memoryBytes: 8 * 2 ** 30, diskBytes: 64 * 2 ** 30, expectedGeneration: 0 });
  for (const id of projects) {
    const created = await self.call("POST", "/projects", { id, name: id, recipeName: "@zelavis/app", start: true });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    await self.running(id);
    if (allocate) await self.allocate(id);
  }
  return self;
}

const notes = (client, id = "sharded") => client.data(id);
const insertMany = async (client, id, from, count) => {
  const data = notes(client, id);
  for (let at = from; at < from + count; at += 250) {
    await data.documents.write({ operations: Array.from({ length: Math.min(250, from + count - at) }, (_, offset) => ({ _tag: "Insert", collection: "notes", id: `d${at + offset}`, data: { n: at + offset } })) });
  }
};
const readsBack = async (client, id, ids) => {
  for (const each of ids) {
    const found = await notes(client, id).documents.get("notes", each);
    assert.equal(found?.id, each, `${each} reads`);
  }
};

/** Everything a scenario needs, with the Project's data in the caller's Tenant and a few more Tenants. */
async function prepared(t, { documents = 20, tenants = ["t1", "t2", "t3", "t4", "t5"], ...options } = {}) {
  const self = await setup(t, options);
  await notes(self.client).collections.create({ name: "notes" });
  await insertMany(self.client, "sharded", 0, documents);
  for (const tenantId of tenants) await self.client.projects.createTenant("sharded", { tenantId, table: "t" });
  const listed = await self.client.projects.tenants("sharded");
  const caller = listed.find((entry) => !tenants.includes(entry.tenantId) && entry.documents >= documents)?.tenantId;
  assert.ok(caller, `the caller's Tenant is among ${JSON.stringify(listed.map((entry) => entry.tenantId))}`);
  self.caller = caller;
  self.rangeOf = (tenant) => virtualRangeFor(MAP, tenant);
  self.shardOf = async (tenant) => (await self.client.projects.tenants("sharded")).find((entry) => entry.tenantId === tenant)?.shard;
  self.remoteShard = async () => (await self.client.shards("sharded").list()).shards.find((shard) => shard.location === "remote");
  self.finished = (id = "sharded") => until(() => self.client.shards(id).operation(), (operation) => operation?.phase === "done" || operation?.phase === "failed", "the shard operation to finish", 120_000);
  return self;
}

test("an App places a shard on another Node, serves its Tenants from it, keeps them across a restart, and releases it", { timeout: 300_000 }, async (t) => {
  const self = await prepared(t);
  const { client } = self;
  const tenants = ["t1", "t2"];
  const ranges = [...new Set([self.caller, ...tenants].map(self.rangeOf))];
  const placed = await client.shards("sharded").place({ virtualRanges: ranges, resources: RESOURCES });
  assert.equal(placed.kind, "place");
  const done = await self.finished();
  assert.equal(done.phase, "done", JSON.stringify(done));

  const remote = await self.remoteShard();
  assert.deepEqual([remote.location, remote.nodeId, remote.state], ["remote", "node-b", "committed"]);
  assert.equal((await self.agentShards()).length, 1, "the Agent holds one SQLite file");
  assert.equal(await self.shardOf(self.caller), remote.shardId);
  await readsBack(client, "sharded", Array.from({ length: 20 }, (_, index) => `d${index}`));
  await notes(client).documents.insert("notes", { id: "after", data: { n: -1 } });
  await readsBack(client, "sharded", ["after"]);
  const entry = (await client.shardPlacement.get("sharded")).placements.find((each) => each.shardId === remote.shardId);
  assert.deepEqual([entry.state, entry.epoch], ["committed", 1]);

  // A restart is a new Project epoch: the shard is reopened and its grant reissued on access.
  assert.ok((await self.call("POST", "/projects/sharded/restart")).status < 300);
  await self.running("sharded");
  await until(async () => (await client.shardPlacement.get("sharded")).placements.find((each) => each.shardId === remote.shardId)?.epoch, (epoch) => epoch === 2, "the shard epoch to be reissued");
  await readsBack(client, "sharded", ["d0", "d19", "after"]);
  await notes(client).documents.insert("notes", { id: "afterRestart", data: { n: -2 } });
  assert.equal(await self.shardOf(self.caller), remote.shardId, "routing survived the restart");

  const released = await client.shards("sharded").release(remote.shardId, { into: "shard-0" });
  assert.equal(released.kind, "release");
  assert.equal((await self.finished()).phase, "done");
  assert.equal((await self.agentShards()).length, 0, "the Agent's storage is gone");
  assert.equal((await client.shardPlacement.get("sharded")).placements.find((each) => each.shardId === remote.shardId).state, "released");
  assert.equal(await self.shardOf(self.caller), "shard-0");
  await readsBack(client, "sharded", [...Array.from({ length: 20 }, (_, index) => `d${index}`), "after", "afterRestart"]);
});

const killProject = async (self, id) => {
  const processes = (await self.call("GET", "/debug/processes")).body;
  const hosts = processes.processes.filter((entry) => entry.command.includes(join(self.root, "platform", "projects", id)));
  const engines = processes.processes.filter((entry) => hosts.some((host) => host.pid === entry.parentPid));
  const pids = [...hosts, ...engines].map((entry) => entry.pid);
  assert.ok(pids.length > 0, "the Project has processes to kill");
  for (const pid of pids) process.kill(pid, "SIGKILL");
  return pids;
};

test("a Project killed while its Tenants move finishes the move after it restarts, with every write", { timeout: 360_000 }, async (t) => {
  const self = await prepared(t, { documents: 3000 });
  const { client } = self;
  await client.shards("sharded").place({ virtualRanges: [self.rangeOf(self.caller)], resources: RESOURCES });
  const moving = await until(() => client.shards("sharded").operation(), (operation) => operation?.phase === "moving" || operation?.phase === "done" || operation?.phase === "failed", "the move to begin", 120_000);
  assert.equal(moving.phase, "moving", `killed while moving, not after: ${JSON.stringify(moving)}`);
  await killProject(self, "sharded");

  const finished = await until(async () => {
    const operation = await client.shards("sharded").operation().catch(() => undefined);
    return operation;
  }, (operation) => operation?.phase === "done" || operation?.phase === "failed", "the operation to finish after the Project runs again", 180_000);
  assert.equal(finished.phase, "done", JSON.stringify(finished));
  assert.equal(await notes(client).collections.count("notes"), 3000);
  await readsBack(client, "sharded", Array.from({ length: 31 }, (_, index) => `d${index * 97}`).concat(["d2999"]));
  assert.equal(await self.shardOf(self.caller), (await self.remoteShard()).shardId);
  // Nothing is left pending: another placement is accepted.
  const other = await client.shards("sharded").place({ virtualRanges: [self.rangeOf("t4")], resources: RESOURCES });
  assert.equal(other.kind, "place");
  assert.equal((await self.finished()).phase, "done");
});

test("an Agent restart and a network partition refuse writes to the remote shard and lose no acknowledged write", { timeout: 360_000 }, async (t) => {
  const self = await prepared(t);
  const { client } = self;
  const callerRange = self.rangeOf(self.caller);
  const local = ["local1", "local2", "local3"].find((id) => self.rangeOf(id) !== callerRange);
  await client.projects.createTenant("sharded", { tenantId: local, table: "t" });
  await client.shards("sharded").place({ virtualRanges: [callerRange], resources: RESOURCES });
  assert.equal((await self.finished()).phase, "done");
  assert.notEqual(await self.shardOf(local), (await self.remoteShard()).shardId);

  const acknowledged = Array.from({ length: 20 }, (_, index) => `d${index}`);
  const write = async (id) => {
    try {
      await notes(client).documents.insert("notes", { id, data: { n: 0 } });
      acknowledged.push(id);
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(await write("before"), true);

  self.proxy.cut();
  const cutAt = Date.now();
  assert.equal(await write("during"), false, "a write to the remote shard is refused while partitioned");
  assert.ok(Date.now() - cutAt < 45_000, `refused within ${Date.now() - cutAt} ms`);
  // A Tenant on a shard this Node holds still takes writes.
  const duringCut = ["cut1", "cut2", "cut3", "cut4"].find((id) => self.rangeOf(id) !== callerRange);
  await client.projects.createTenant("sharded", { tenantId: duringCut, table: "t" });
  self.proxy.heal();
  await until(() => write(`healed${Date.now()}`), Boolean, "a write after the partition heals", 60_000);

  await self.restartAgent();
  await until(async () => (await notes(client).documents.get("notes", "before").catch(() => undefined))?.id, (id) => id === "before", "reads after the Agent restarted", 60_000);
  await until(() => write(`restarted${Date.now()}`), Boolean, "a write after the Agent restarted", 60_000);
  await readsBack(client, "sharded", acknowledged);
});

const rawAgentGet = (self, token) => new Promise((resolve, reject) => {
  const body = JSON.stringify({ access: token, op: "get", key: Buffer.from("x").toString("base64url") });
  const request = httpsRequest({
    hostname: "localhost", port: new URL(self.agentUrl).port, path: "/v1/shards/kv", method: "POST", ca: self.certPem,
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
  }, (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => resolve({ status: response.statusCode, body: (() => { try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return undefined; } })() }));
  });
  request.on("error", reject);
  request.end(body);
});

const channel = async (self, path, token, body, method = body === undefined ? "GET" : "POST") => {
  const answer = await self.zv.fetch(new Request(`${API}/project-shards/${path}`, {
    method, headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: answer.status, body: await answer.json().catch(() => undefined) };
};
const capabilityFor = async (self, projectId, overrides = {}) => {
  const placement = (await self.systemStore.get("fabric.project-ownership.v1", projectId)).value;
  return mintAppShardCapability(self.secret, { scope: projectId, node: placement.nodeId, epoch: placement.epoch, ...overrides });
};

test("a Project's previous process cannot use its shard after a restart (invariant 2)", { timeout: 360_000 }, async (t) => {
  const self = await prepared(t);
  const { client } = self;
  await client.shards("sharded").place({ virtualRanges: [self.rangeOf(self.caller)], resources: RESOURCES });
  assert.equal((await self.finished()).phase, "done");
  const shard = await self.remoteShard();

  const oldCapability = await capabilityFor(self, "sharded");
  const oldAccess = await channel(self, `sharded/${shard.shardId}/access`, oldCapability, {});
  assert.equal(oldAccess.status, 200, JSON.stringify(oldAccess.body));
  const oldToken = oldAccess.body.access.token;
  assert.equal((await rawAgentGet(self, oldToken)).status, 200, "the token works until the epoch rises");

  assert.ok((await self.call("POST", "/projects/sharded/restart")).status < 300);
  await self.running("sharded");
  await until(async () => (await client.shardPlacement.get("sharded")).placements.find((each) => each.shardId === shard.shardId)?.epoch, (epoch) => epoch >= 2, "the shard epoch to rise");
  await notes(client).documents.insert("notes", { id: "new-process", data: { n: 1 } });

  const stale = await rawAgentGet(self, oldToken);
  assert.deepEqual([stale.status, stale.body?.code], [409, "stale-epoch"]);
  const old = await channel(self, `sharded/${shard.shardId}/access`, oldCapability, {});
  assert.deepEqual([old.status, old.body?.code], [409, "stale-project-epoch"]);
});

test("a Project cannot choose a Node, exceed its envelope or touch another Project's shards (invariant 1)", { timeout: 360_000 }, async (t) => {
  const self = await prepared(t, { projects: ["sharded", "other"] });
  const { client } = self;
  await client.shardPlacement.get("other");

  // The Project's channel: only its own capability, and a request names no Node.
  const foreign = await capabilityFor(self, "other");
  assert.equal((await channel(self, "sharded", foreign)).status, 401, "another Project's capability");
  assert.equal((await channel(self, "sharded", undefined)).status, 401);
  const view = (await channel(self, "sharded", await capabilityFor(self, "sharded"))).body;
  const reserve = { protocolVersion: 1, intent: "allocate", operationId: "op-x", projectId: "sharded", shardId: "shard-x", virtualRanges: [1], mapVersion: 1, expectedRevision: view.revision, resources: RESOURCES, durability: "crash" };
  const chosen = await channel(self, "sharded/requests", await capabilityFor(self, "sharded"), { ...reserve, nodeId: "node-x" });
  assert.deepEqual([chosen.status, chosen.body?.code], [400, "invalid-request"]);

  // Over the allocation: refused, and the operation ends failed with its reason.
  const big = await client.shards("sharded").place({ virtualRanges: [self.rangeOf(self.caller)], resources: { ...RESOURCES, cpuCores: 5 } });
  assert.equal(big.kind, "place");
  const failed = await self.finished();
  assert.equal(failed.phase, "failed");
  assert.match(failed.error ?? "", /out-of-envelope|envelope/);
  assert.equal((await self.agentShards()).length, 0);

  // The Gateway: a grant on another Project, or data authority alone, is not authority to place.
  const onOther = self.clientAs(scoped("manager-of-other", ["project.runtime.manage", "other"], ["project.view", "sharded"]));
  const dataOnly = self.clientAs(scoped("data-writer", ["project.data.write", "sharded"], ["project.view", "sharded"]));
  const place = { virtualRanges: [self.rangeOf(self.caller)], resources: RESOURCES };
  for (const who of [onOther, dataOnly]) {
    await assert.rejects(who.shards("sharded").place(place), (error) => error.status === 403 || /403|forbidden|permission/i.test(String(error.message)), "place is refused");
  }
  // The operator route.
  const projectOnly = scoped("sharded-manager", ["project.runtime.manage", "sharded"], ["project.view", "sharded"]);
  const allocation = (await client.shardPlacement.get("sharded")).allocation;
  const operator = await self.call("PUT", "/shard-placement/sharded/allocation", { allowedNodeIds: ["node-b"], cpuCores: 64, memoryBytes: 2 ** 40, diskBytes: 2 ** 45, expectedGeneration: allocation.generation }, projectOnly);
  assert.equal(operator.status, 403, JSON.stringify(operator.body));
  assert.equal((await client.shardPlacement.get("sharded")).allocation.generation, allocation.generation, "the allocation did not change");
  // The CLI, with that principal.
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = (input, init) => self.zv.fetch(new Request(input, init), dataOnly.principal ?? scoped("data-writer", ["project.data.write", "sharded"]));
  console.log = () => undefined;
  try {
    await assert.rejects(runShardsCommand(["place", "--ranges", String(self.rangeOf(self.caller)), "--cpu", "1", "--memory", "1073741824", "--disk", "8589934592", "--project", "sharded", "--url", "http://zv.test/zelavis"]), /403|forbidden|permission/i);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }

  // The Agent: a grant signed by a key it does not trust, and a token it did not receive from the Platform.
  const stranger = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const untrusted = createHttpsProjectDispatcher({
    localNodeId: "node-a", projectsDirectory: join(self.root, "platform"), keyId: "stranger", privateKey: stranger.privateKey,
    destinations: { "node-b": { url: self.agentUrl, agentId: "agent-b", caPem: self.certPem } },
  });
  await assert.rejects(untrusted.deliverAppShardGrant({ nodeId: "node-b", projectId: "sharded", incarnation: "i", shardId: "shard-9", epoch: 1, state: "preparing", durability: "crash" }));
  assert.equal((await self.agentShards()).length, 0, "nothing was created");
  const garbage = await rawAgentGet(self, "not-a-token");
  assert.equal(garbage.status, 401);
});

test("deleting a Project revokes its shards before its data goes, and retries while an Agent is unreachable (invariant 5)", { timeout: 360_000 }, async (t) => {
  const self = await prepared(t);
  const { client } = self;
  await client.shards("sharded").place({ virtualRanges: [self.rangeOf(self.caller)], resources: RESOURCES });
  assert.equal((await self.finished()).phase, "done");
  const shard = await self.remoteShard();
  assert.equal((await self.agentShards()).length, 1);

  self.proxy.cut();
  assert.ok((await self.call("DELETE", "/projects/sharded")).status < 600);
  const stuck = await until(async () => (await self.call("GET", "/projects/sharded")).body, (body) => body?.project !== undefined && JSON.stringify(body).includes(shard.shardId), "the deletion to report the unreachable shard", 120_000);
  assert.ok(stuck.project, "the Project is still there, with its deletion visible");
  assert.equal((await self.agentShards()).length, 1, "the Agent still holds it");
  assert.notEqual(await self.systemStore.get("fabric.app-data-placement.v1", "sharded"), undefined, "the ledger is kept until the shard is revoked");

  self.proxy.heal();
  // What the dashboard's Retry deletion sends.
  await until(async () => (await self.call("DELETE", "/projects/sharded")).status, (status) => status < 300 || status === 404, "the retried deletion to be accepted", 60_000);
  await until(async () => (await self.call("GET", "/projects/sharded")).status, (status) => status === 404, "the Project to be gone", 180_000);
  assert.equal((await self.agentShards()).length, 0, "the Agent's storage is gone");
  assert.equal(await self.systemStore.get("fabric.app-data-placement.v1", "sharded"), undefined);
  assert.equal(await self.systemStore.get("fabric.app-data-allocation.v1", "sharded"), undefined);
});

test("a Project starts with its remote shard's Agent unreachable, serves its other shards, and takes the shard back when the Agent answers", { timeout: 360_000 }, async (t) => {
  const self = await prepared(t);
  const { client } = self;
  const callerRange = self.rangeOf(self.caller);
  const stay = ["stay1", "stay2", "stay3", "stay4"].find((id) => self.rangeOf(id) !== callerRange);
  await client.projects.createTenant("sharded", { tenantId: stay, table: "t" });
  await client.shards("sharded").place({ virtualRanges: [callerRange], resources: RESOURCES });
  assert.equal((await self.finished()).phase, "done");
  const shard = await self.remoteShard();

  self.proxy.cut();
  assert.ok((await self.call("POST", "/projects/sharded/restart")).status < 300);
  await self.running("sharded");
  // The shard is reported as not answering; a Tenant on a shard this Node holds is still written.
  const listed = await until(() => client.shards("sharded").list(), (view) => view.shards.find((each) => each.shardId === shard.shardId)?.available === false, "the shard to be reported as not answering", 120_000);
  assert.equal(listed.shards.find((each) => each.shardId === shard.shardId).available, false);
  const whileAway = ["away1", "away2", "away3", "away4"].find((id) => self.rangeOf(id) !== callerRange);
  await client.projects.createTenant("sharded", { tenantId: whileAway, table: "t" });
  await assert.rejects(notes(client).documents.get("notes", "d0"), "a Tenant on the missing shard is refused, not answered empty");

  self.proxy.heal();
  await until(async () => (await client.shards("sharded").list()).shards.find((each) => each.shardId === shard.shardId)?.available, (value) => value === true, "the shard to open again", 120_000);
  await readsBack(client, "sharded", Array.from({ length: 20 }, (_, index) => `d${index}`));
});

test("a remote shard's Tenant reads run on its Node and its writes stay on the writer", { timeout: 300_000 }, async (t) => {
  const self = await prepared(t);
  const { client } = self;
  await client.shards("sharded").place({ virtualRanges: [self.rangeOf(self.caller)], resources: RESOURCES });
  const done = await self.finished();
  assert.equal(done.phase, "done", JSON.stringify(done));
  const remote = await self.remoteShard();
  const before = self.agent.shardReadsServed();
  await readsBack(client, "sharded", Array.from({ length: 20 }, (_, index) => `d${index}`));
  assert.ok(self.agent.shardReadsServed() >= before + 20);
  const beforeWrite = self.agent.shardReadsServed();
  await notes(client).documents.insert("notes", { id: "written", data: { n: -1 } });
  assert.equal(self.agent.shardReadsServed(), beforeWrite);
  self.proxy.cut();
  await assert.rejects(() => notes(client).documents.get("notes", "d0"), error => {
    assert.match(error.message, /remote shard/i);
    assert.ok(error.message.includes(remote.shardId));
    assert.equal(error.code, "shard-unavailable");
    assert.doesNotMatch(error.message, /ECONN|localhost|127\.0\.0\.1/);
    return true;
  });
  self.proxy.heal();
  await until(async () => {
    try { return await notes(client).documents.get("notes", "d0"); } catch (error) { return error; }
  }, value => value?.id === "d0", "remote read to recover");
  await readsBack(client, "sharded", ["d0", "d19", "written"]);
});

test("a remote read past the Agent's work budget is refused through the API as its own error, and the next read answers", { timeout: 300_000 }, async (t) => {
  const self = await prepared(t, { documents: 60, readLimits: { entries: 200 } });
  const { client } = self;
  await client.shards("sharded").place({ virtualRanges: [self.rangeOf(self.caller)], resources: RESOURCES });
  const done = await self.finished();
  assert.equal(done.phase, "done", JSON.stringify(done));
  assert.equal((await notes(client).documents.get("notes", "d0"))?.id, "d0", "a read that fits is answered on the Agent");
  const served = self.agent.shardReadsServed();
  await assert.rejects(() => notes(client).documents.query("notes"), error => {
    assert.equal(error.status, 422);
    assert.equal(error.code, "read-budget-exceeded");
    assert.match(error.message, /entries/);
    assert.match(error.message, /narrow it/);
    assert.doesNotMatch(error.message, /unavailable|ECONN|localhost|127\.0\.0\.1/);
    return true;
  });
  assert.equal(self.agent.shardReadsServed(), served + 1, "the Agent answered the refusal itself");
  assert.equal((await notes(client).documents.get("notes", "d1"))?.id, "d1", "the shard serves after a refusal");
  assert.equal((await notes(client).documents.query("notes", { limit: 2 })).length, 2, "a narrower read of the same collection fits");
});

const REPLICA_DISK = { diskBytes: 512 * 2 ** 20 };
const replicaOn = async (shards, id) => (await shards.list()).shards.find((shard) => shard.shardId === id)?.replica;
const waitForReplica = (shards, id, after = -Infinity) => until(
  () => replicaOn(shards, id),
  (replica) => replica?.status === "following" && Date.parse(replica.heldAsOf) > after,
  `replica of ${id} to hold writes through ${after}`,
);

test("a local shard's replica converges, survives its Agent's outage and is removed (B3, B4)", { timeout: 300_000 }, async (t) => {
  const self = await prepared(t, { agents: ["node-b", "node-c"] });
  const shards = self.client.shards("sharded");
  const id = await self.shardOf(self.caller);
  assert.equal((await shards.list()).shards.find((shard) => shard.shardId === id).location, "local");

  assert.equal((await shards.replicate(id, REPLICA_DISK)).kind, "replicate");
  assert.equal((await self.finished()).phase, "done");
  const replica = await waitForReplica(shards, id);
  assert.notEqual(replica.nodeId, "node-a");
  assert.equal((await self.agentShardsOn(replica.nodeId)).length, 1);
  await insertMany(self.client, "sharded", 20, 50);
  await waitForReplica(shards, id, Date.now());

  const proxy = self.proxies[replica.nodeId];
  proxy.cut();
  await insertMany(self.client, "sharded", 70, 20);
  await readsBack(self.client, "sharded", ["d0", "d69", "d89"]);
  const afterCutWrites = Date.now();
  proxy.heal();
  await waitForReplica(shards, id, afterCutWrites);
  assert.equal((await shards.unreplicate(id)).kind, "unreplicate");
  assert.equal((await self.finished()).phase, "done");
  assert.equal((await self.agentShardsOn(replica.nodeId)).length, 0);
  assert.equal(await replicaOn(shards, id), undefined);
});

const withRemoteReplica = async (t) => {
  const self = await prepared(t, { agents: ["node-b", "node-c"] });
  const shards = self.client.shards("sharded");
  await shards.place({ virtualRanges: [self.rangeOf(self.caller)], resources: RESOURCES });
  assert.equal((await self.finished()).phase, "done");
  const primary = await self.remoteShard();
  await shards.replicate(primary.shardId, REPLICA_DISK);
  assert.equal((await self.finished()).phase, "done");
  const replica = await waitForReplica(shards, primary.shardId);
  return { self, primary, replica };
};

test("a remote shard's replica lives on a different Agent (B1)", { timeout: 300_000 }, async (t) => {
  const { self, primary, replica } = await withRemoteReplica(t);
  assert.notEqual(replica.nodeId, primary.nodeId);
  assert.equal((await self.agentShardsOn(primary.nodeId)).length, 1);
  assert.equal((await self.agentShardsOn(replica.nodeId)).length, 1);
  await readsBack(self.client, "sharded", ["d0", "d19"]);
});

test("deleting a Project releases its replicas at their Agents (invariant 5)", { timeout: 300_000 }, async (t) => {
  const { self, primary, replica } = await withRemoteReplica(t);
  const deleted = await self.call("DELETE", "/projects/sharded");
  assert.ok(deleted.status < 300, JSON.stringify(deleted));
  await until(async () => (await self.agentShardsOn(primary.nodeId)).length + (await self.agentShardsOn(replica.nodeId)).length,
    (remaining) => remaining === 0, "both Agents to release the Project's storage");
});
