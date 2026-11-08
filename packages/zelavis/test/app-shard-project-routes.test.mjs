// A Project's own channel to the Platform for its remote App shards, through a composed Platform and a real remote Agent:
// who may call it, when a capability stops being honoured, reissue after a restart, and what a deletion removes.
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Zelavis } from "../dist/index.js";
import { nodeAdapter } from "../dist/adapters/node.js";
import { createLocalSqliteSystemStore } from "../dist/adapters/_sqlite-system-store.js";
import { createRemoteProjectAgent } from "../dist/adapters/_remote-project-agent.js";
import { mintAppShardCapability } from "../dist/platform/app-shard-capability.js";
import { loadPlatformMasterSecret } from "../dist/platform/master-secret.js";

const run = promisify(execFile);
const OWNER = { principal: { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] } };
const API = "http://127.0.0.1/zelavis/api/v1/runtime";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (read, accept, what, deadline = 60_000) => {
  const end = Date.now() + deadline;
  let last;
  while (Date.now() < end) {
    last = await read();
    if (accept(last)) return last;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${what}; last: ${JSON.stringify(last)}`);
};

test("a Project's shard channel honours only its current writer, reissues after a restart and is cleaned up with the Project", { timeout: 240_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zv-shard-routes-"));
  const saved = process.env.ZELAVIS_APP_SHARDS_URL;
  let zv, agent, store;
  t.after(async () => {
    if (saved === undefined) delete process.env.ZELAVIS_APP_SHARDS_URL; else process.env.ZELAVIS_APP_SHARDS_URL = saved;
    await zv?.close();
    await agent?.close();
    await rm(root, { recursive: true, force: true });
  });
  const keyFile = join(root, "tls.key"), certFile = join(root, "tls.crt");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"]);
  let trust = { keys: [] };
  agent = await createRemoteProjectAgent({
    dataDirectory: join(root, "node-b"), host: "localhost", port: 0, keyPem: await readFile(keyFile, "utf8"), certPem: await readFile(certFile, "utf8"),
    trust: () => trust, agentId: "agent-b", nodeId: "node-b",
  });
  process.env.ZELAVIS_APP_SHARDS_URL = "http://127.0.0.1:3000/zelavis/api/v1";
  zv = new Zelavis({ adapter: nodeAdapter({
    dataDirectory: join(root, "platform"),
    projects: { remoteDispatch: { localNodeId: "node-a", nodes: { "node-b": { url: agent.address, agentId: "agent-b", caFile: certFile } } } },
  }) });
  const asOwner = async (method, path, body) => {
    const answer = await zv.fetch(new Request(`${API}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), OWNER);
    return { status: answer.status, body: await answer.json().catch(() => undefined) };
  };
  assert.equal((await asOwner("GET", "/config")).status, 200);
  store = createLocalSqliteSystemStore({ filename: join(root, "platform", "system", "zelavis.sqlite") });
  trust = (await store.get("fabric.agent-trust.v1", "platform")).value;
  const secret = await loadPlatformMasterSecret(store);

  const created = await asOwner("POST", "/projects", { id: "shardp", name: "Shard Project", recipeName: "@zelavis/app", start: true });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const running = () => until(async () => (await asOwner("GET", "/projects/shardp")).body?.project, (project) => project?.runtime?.status === "running", "the Project to run");
  await running();
  const placementNow = async () => (await store.get("fabric.project-ownership.v1", "shardp")).value;
  const capability = async (overrides = {}) => {
    const placement = await placementNow();
    return mintAppShardCapability(secret, { scope: "shardp", node: placement.nodeId, epoch: placement.epoch, ...overrides });
  };
  const channel = async (method, path, token, body) => {
    const answer = await zv.fetch(new Request(`${API}/project-shards/${path}`, {
      method, headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    return { status: answer.status, body: await answer.json().catch(() => undefined) };
  };

  // Nothing is allowed until the operator allows it.
  const token = await capability();
  const reserve = (shardId, operationId, ranges, revision) => ({
    protocolVersion: 1, intent: "allocate", operationId, projectId: "shardp", shardId, virtualRanges: ranges, mapVersion: 1, expectedRevision: revision,
    resources: { cpuCores: 1, memoryBytes: 1_000_000, diskBytes: 1_000_000 }, durability: "crash",
  });
  assert.equal((await channel("POST", "shardp/requests", token, reserve("s1", "op-1", [0, 1], 0))).body.code, "allocation-unavailable");
  const allocated = await asOwner("PUT", "/shard-placement/shardp/allocation", { allowedNodeIds: ["node-b"], cpuCores: 4, memoryBytes: 1e9, diskBytes: 1e10, expectedGeneration: 0 });
  assert.equal(allocated.status, 200, JSON.stringify(allocated.body));

  const requested = await channel("POST", "shardp/requests", token, reserve("s1", "op-1", [0, 1], 0));
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  assert.equal(requested.body.placement.nodeId, "node-b");

  // Who may call: the Project's own capability, at its current placement epoch, and nobody else.
  assert.equal((await channel("GET", "shardp", undefined)).status, 401, "no capability");
  assert.equal((await channel("GET", "shardp", await capability({ scope: "other" }))).status, 401, "another Project's capability");
  assert.equal((await channel("GET", "shardp", "garbage")).status, 401);
  const placement = await placementNow();
  const ahead = await channel("GET", "shardp", await capability({ epoch: placement.epoch + 1 }));
  assert.deepEqual([ahead.status, ahead.body.code], [409, "stale-project-epoch"]);
  const elsewhere = await channel("GET", "shardp", await capability({ node: "node-x" }));
  assert.deepEqual([elsewhere.status, elsewhere.body.code], [409, "stale-project-epoch"]);
  const currentView = (await channel("GET", "shardp", token)).body;
  assert.equal(currentView.placements.length, 1);
  assert.equal(currentView.callerNodeId, placement.nodeId);

  const activated = await channel("POST", "shardp/s1/activate", token, { operationId: "op-1" });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  assert.equal(activated.body.access.destination.url, agent.address);
  assert.equal(activated.body.placement.state, "committed");
  const again = await channel("POST", "shardp/s1/access", token, {});
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.placement.epoch, activated.body.placement.epoch);
  assert.equal((await channel("POST", "shardp/s1/activate", token, {})).status, 400, "an activation names its operation");

  // A Node that holds a live shard cannot be removed.
  const removal = await asOwner("DELETE", "/nodes/node-b");
  assert.deepEqual([removal.status, removal.body.code, removal.body.shards], [409, "node-in-use", ["shardp/s1"]]);

  // A restart is a new Project epoch: the old process's capability is refused, the new one reissues the grant.
  const restarted = await asOwner("POST", "/projects/shardp/restart");
  assert.ok(restarted.status < 300, JSON.stringify(restarted));
  const fresh = await until(placementNow, (value) => value.epoch > placement.epoch && value.state === "active", "a new placement epoch");
  await running();
  const old = await channel("POST", "shardp/s1/access", token, {});
  assert.deepEqual([old.status, old.body.code], [409, "stale-project-epoch"]);
  const reissued = await channel("POST", "shardp/s1/access", await capability({ epoch: fresh.epoch }), {});
  assert.equal(reissued.status, 200, JSON.stringify(reissued.body));
  assert.ok(reissued.body.placement.epoch > activated.body.placement.epoch, "the shard epoch rose");

  // Releasing removes the Agent's storage; a second shard stays until the Project is deleted.
  const shardsOnAgent = () => readdir(join(root, "node-b", "shards")).then((entries) => entries.length, () => 0);
  const current = await capability({ epoch: fresh.epoch });
  assert.ok(await shardsOnAgent() >= 1);
  const released = await channel("POST", "shardp/s1/release", current, { operationId: "op-1" });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.equal(released.body.placement.state, "released");
  assert.equal(await shardsOnAgent(), 0);
  const view = (await channel("GET", "shardp", current)).body;
  const second = await channel("POST", "shardp/requests", current, reserve("s2", "op-2", [2, 3], view.revision));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal((await channel("POST", "shardp/s2/activate", current, { operationId: "op-2" })).status, 200);
  assert.equal(await shardsOnAgent(), 1);

  const removed = await asOwner("DELETE", "/projects/shardp");
  assert.ok(removed.status < 300, JSON.stringify(removed));
  await until(async () => store.get("fabric.app-data-placement.v1", "shardp"), (value) => value === undefined, "the ledger to be deleted", 60_000);
  assert.equal(await shardsOnAgent(), 0);
});
