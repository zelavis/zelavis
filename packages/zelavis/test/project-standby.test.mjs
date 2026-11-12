// A Project's standby is a second process of the Project on another node: it follows the writer through the Platform with
// a credential that reads only that Project's followers, writes nothing before it holds the lease, and serves the Project
// once the writer's lease lapses. A real Platform runs the writer; a second driver, with its own directory and agent, runs
// the standby.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Zelavis } from "../dist/index.js";
import { nodeAdapter } from "../dist/adapters/node.js";
import { createLocalSqliteSystemStore } from "../dist/adapters/_sqlite-system-store.js";
import { createLocalAgentProcessRunner } from "../dist/adapters/_agent-process-runner.js";
import { createNodeProcessProjectRuntime } from "../dist/adapters/_node-project-runtime.js";
import { projectLeaseConfiguration, projectLeaseEnvironment } from "../dist/adapters/_project-lease-environment.js";
import { ZELAVIS_GATEWAY_AUTHORITY_HEADER } from "../dist/platform/gateway-authority.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";

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

test("a Project's standby follows its writer, answers 503 until promoted, then serves with everything the writer had", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zv-standby-"));
  const saved = Object.fromEntries(["URL", "NODE", "STANDBY", "TTL_MILLIS"].map((key) => [key, process.env[`ZELAVIS_PROJECT_LEASES_${key}`]]));
  let zv, driverB, agentB, systemStore;
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const answer = await zv.fetch(new Request(`http://127.0.0.1:${server.address().port}${request.url}`, {
        method: request.method, headers: request.headers, ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
      }));
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      response.end(Buffer.from(await answer.arrayBuffer()));
    } catch (error) {
      // A request still in flight when the test closes the Platform.
      response.writeHead(500).end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const platform = `http://127.0.0.1:${server.address().port}`;
  const asOwner = (method, path, body) => zv.fetch(new Request(`${API}${path}`, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), OWNER);
  const json = async (method, path, body) => {
    const answer = await asOwner(method, path, body);
    return { status: answer.status, body: await answer.json().catch(() => undefined) };
  };
  const lease = async () => (await json("GET", "/writer-leases/leased")).body?.lease;
  try {
    process.env.ZELAVIS_PROJECT_LEASES_URL = `${platform}/zelavis/api/v1`;
    process.env.ZELAVIS_PROJECT_LEASES_NODE = "node-a";
    process.env.ZELAVIS_PROJECT_LEASES_STANDBY = "node-b";
    process.env.ZELAVIS_PROJECT_LEASES_TTL_MILLIS = "3000";
    zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: join(root, "platform") }) });

    // The writer: a real App Project on the Platform, under its lease.
    assert.equal((await json("POST", "/projects", { id: "leased", name: "Leased", recipeName: "@zelavis/app", start: true })).status, 201);
    assert.equal((await json("POST", "/projects", { id: "other", name: "Other", recipeName: "@zelavis/app", start: false })).status, 201);
    await until(async () => (await json("GET", "/projects/leased")).body?.project?.runtime?.status, (status) => status === "running", "the writer to run");
    const first = await until(lease, (value) => value?.owner === "node-a", "the writer's lease");
    assert.equal(first.epoch, 1);

    // The standby: the same Project on a second node, with its own directory and agent.
    systemStore = createLocalSqliteSystemStore({ filename: join(root, "platform", "system", "zelavis.sqlite") });
    const configuration = projectLeaseConfiguration();
    agentB = createLocalAgentProcessRunner();
    driverB = createNodeProcessProjectRuntime({
      directory: join(root, "node-b"), agent: agentB,
      leaseEnvironment: (projectId, role) => projectLeaseEnvironment(configuration, systemStore, projectId, role),
    });
    const project = (await json("GET", "/projects/leased")).body.project;
    await driverB.prepare(project, project.recipe);

    // Its credential reads this Project's followers and nothing else.
    const standbyEnvironment = await projectLeaseEnvironment(configuration, systemStore, "leased", "standby");
    const bearer = { authorization: `Bearer ${standbyEnvironment.ZELAVIS_LEASE_TOKEN}` };
    const base = `${platform}/zelavis/api/v1/runtime/projects`;
    const followed = await fetch(`${base}/leased/followers/partitions`, { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: "{}" });
    assert.equal(followed.status, 200, await followed.clone().text());
    assert.equal((await fetch(`${base}/leased/stop`, { method: "POST", headers: bearer })).status >= 400, true, "it cannot stop the Project");
    const elsewhere = await fetch(`${base}/other/followers/partitions`, { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: "{}" });
    assert.equal([401, 403, 404].includes(elsewhere.status), true, `it cannot follow another Project (${elsewhere.status})`);
    const inventory = await fetch(`${base}`, { headers: bearer });
    assert.equal(inventory.status, 200);
    assert.deepEqual((await inventory.json()).projects, [], "it holds no Project view authority");

    const standing = await driverB.startStandby(project);
    assert.equal(standing.status, "standby");
    const claims = { projectId: "leased", scopeId: "platform", generation: 1, runtimeNodeId: "node-b", subject: "operator", subjectType: "user", tenantId: "tenant", permissions: ["database.replicate"] };
    const toB = async (path, init = {}) => fetch(`${standing.url}${path}`, { ...init, headers: { ...(init.headers ?? {}), [ZELAVIS_GATEWAY_AUTHORITY_HEADER]: await driverB.signGatewayAuthority("leased", claims) } });
    const unserved = await toB("/zelavis/api/v1/runtime/access");
    assert.equal(unserved.status, 503);
    assert.equal((await unserved.json()).error, "This Project is standing by for its writer.");

    // Data written on the writer reaches the standby, which acknowledges what it holds.
    const client = createZelavisClient({ baseUrl: "http://localhost", rootPath: "/zelavis", fetch: (input, init) => zv.fetch(new Request(input, init), OWNER) });
    const data = client.data("leased");
    await data.collections.create({ name: "notes" });
    await data.documents.insert("notes", { id: "n1", data: { text: "written on the writer" } });
    const followers = client.followers("leased");
    const level = async () => {
      const listing = await followers.partitions();
      const behind = [];
      for (const { partition, head } of listing.partitions) {
        const acknowledged = (await followers.acknowledgments(partition)).followers.find((entry) => entry.name === "node-b");
        if (head > 0 && (acknowledged === undefined || acknowledged.position < head)) behind.push(partition);
      }
      return { behind, listing: listing.partitions };
    };
    const levelled = await until(level, (state) => state.behind.length === 0 && state.listing.some((entry) => entry.head > 0), "the standby to hold everything the writer wrote");
    const heads = new Map(levelled.listing.map((entry) => [entry.partition, entry.head]));
    assert.ok(heads.has("zv.global"), "the App-scoped partition is followed too");
    assert.equal((await lease()).owner, "node-a", "and it is still only following");

    // The writer is stopped (its lease released): the standby takes over and serves.
    assert.equal((await json("POST", "/projects/leased/stop")).status, 200);
    await until(async () => (await toB("/zelavis/api/v1/runtime/access")).status, (status) => status === 200, "the promoted standby to serve", 90_000);
    const promoted = await lease();
    assert.deepEqual([promoted.owner, promoted.epoch > 1], ["node-b", true]);

    const after = await (await toB("/zelavis/api/v1/database/followers/partitions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    const now = new Map(after.partitions.map((entry) => [entry.partition, entry.head]));
    for (const [partition, head] of heads) assert.ok((now.get(partition) ?? 0) >= head, `${partition} holds at least what the writer had (${now.get(partition)} < ${head})`);
    // The owner's data is the Tenant named for the owner.
    const reader = { ...claims, permissions: ["database.read"], tenantId: "owner" };
    const note = await (await fetch(`${standing.url}/zelavis/api/v1/database/documents/notes/n1`, { headers: { [ZELAVIS_GATEWAY_AUTHORITY_HEADER]: await driverB.signGatewayAuthority("leased", reader) } })).text();
    assert.match(note, /written on the writer/);

    // A promoted standby is a writer like any other: superseded, it stops instead of only being refused.
    const taken = await lease();
    const version = (await json("GET", "/writer-leases/leased")).body.version;
    assert.equal((await json("PUT", "/writer-leases/leased", { lease: { ...taken, owner: "node-x", epoch: taken.epoch + 1, expiresAt: Date.now() + 60_000 }, expectedVersion: version })).status, 200);
    await until(async () => (await driverB.status("leased")).status, (value) => value === "failed" || value === "stopped", "the superseded standby's process to stop", 30_000);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[`ZELAVIS_PROJECT_LEASES_${key}`];
      else process.env[`ZELAVIS_PROJECT_LEASES_${key}`] = value;
    }
    await driverB?.close();
    await agentB?.close?.();
    await zv?.close();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
