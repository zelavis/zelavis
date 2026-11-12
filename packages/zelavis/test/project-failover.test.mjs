// A lease-guarded Project fails over to its standby node. A real Platform runs the writer on node-a; a real remote Agent on
// node-b runs the standby, which follows the writer through the Platform. The writer's process is killed; the standby takes
// the lease over once it lapses, and the Platform, which only reacts to the lease record, moves the Project's placement to
// node-b, where the Project starts under it.
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Zelavis } from "../dist/index.js";
import { nodeAdapter } from "../dist/adapters/node.js";
import { createLocalSqliteSystemStore } from "../dist/adapters/_sqlite-system-store.js";
import { createRemoteProjectAgent } from "../dist/adapters/_remote-project-agent.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { openNodeDatabase } from "../dist/db/node-host.js";

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

for (const [what, victims, mode] of [
  ["a writer's host and engine are killed", (hosts, engines) => [...hosts, ...engines]],
  // The engine ends with its host: it cannot go on renewing the lease, however long a follower's request is held open on it.
  ["only a writer's host is killed", (hosts) => hosts],
  // The Platform starts the dead writer again before the standby has promoted: node-a takes the lease at its next epoch and
  // the standby, dispatched again, goes on following it. One writer, and the standby still standing by.
  ["a writer is killed and started again at once", (hosts, engines) => [...hosts, ...engines], "race"],
  // A lease that names a node which is not the Project's standby is nothing the Platform acts on.
  ["a lease naming a node that is not the standby", undefined, "unknown"],
  // After the first failover the node the writer left runs a new standby, and the Project fails over again, back onto the
  // Platform's own node, keeping every write.
  ["the writer is killed twice", (hosts, engines) => [...hosts, ...engines], "twice"],
  // A change of writer the lease routes never reported (written straight into the store) is settled by reconciliation.
  ["a change of writer the lease routes never reported", undefined, "backstop"],
]) test(mode !== undefined ? `${what}: ${{ race: "one writer, and the standby still stands by", unknown: "the placement stays where it is", backstop: "reconciliation moves the placement", twice: "it fails over, gets a new standby, and fails over again with every write" }[mode]}` : `${what} and its Project fails over to the standby node, with its data`, { timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zv-failover-"));
  const saved = Object.fromEntries(["URL", "NODE", "STANDBY", "TTL_MILLIS"].map((key) => [key, process.env[`ZELAVIS_PROJECT_LEASES_${key}`]]));
  let zv, agent, systemStore;
  let trust = { keys: [] };
  const log = (message) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
  const started = Date.now();
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
      response.writeHead(500).end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const asOwner = (method, path, body) => zv.fetch(new Request(`${API}${path}`, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), OWNER);
  const json = async (method, path, body) => {
    const answer = await asOwner(method, path, body);
    return { status: answer.status, body: await answer.json().catch(() => undefined) };
  };
  const lease = async () => (await json("GET", "/writer-leases/leased")).body?.lease;
  try {
    // The standby node's Agent, trusting the Platform's keys once the Platform has published them.
    const keyFile = join(root, "tls.key"), certFile = join(root, "tls.crt");
    await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"]);
    agent = await createRemoteProjectAgent({
      dataDirectory: join(root, "node-b"), host: "localhost", port: 0, keyPem: await readFile(keyFile, "utf8"), certPem: await readFile(certFile, "utf8"),
      trust: () => trust, agentId: "agent-b", nodeId: "node-b",
    });

    process.env.ZELAVIS_PROJECT_LEASES_URL = `http://127.0.0.1:${server.address().port}/zelavis/api/v1`;
    process.env.ZELAVIS_PROJECT_LEASES_NODE = "node-a";
    process.env.ZELAVIS_PROJECT_LEASES_STANDBY = "node-b";
    // "Started again at once" means before the lease could lapse: its lease outlasts a Project start on a slow machine
    // (several seconds on two shared CPUs), so the restart is what wins, never the machine's speed.
    process.env.ZELAVIS_PROJECT_LEASES_TTL_MILLIS = mode === "race" ? "20000" : "3000";
    const platform = () => new Zelavis({ adapter: nodeAdapter({
      dataDirectory: join(root, "platform"),
      projects: { remoteDispatch: { localNodeId: "node-a", nodes: { "node-b": { url: agent.address, agentId: "agent-b", caFile: certFile } } } },
    }) });
    zv = platform();
    assert.equal((await asOwner("GET", "/config")).status, 200);
    systemStore = createLocalSqliteSystemStore({ filename: join(root, "platform", "system", "zelavis.sqlite") });
    trust = (await systemStore.get("fabric.agent-trust.v1", "platform")).value;

    // The writer runs on node-a, and a standby is started on node-b.
    const created = await json("POST", "/projects", { id: "leased", name: "Leased", recipeName: "@zelavis/app", start: true });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const writing = await until(async () => (await json("GET", "/projects/leased")).body?.project, (project) => project?.runtime?.status === "running" && project.standby !== undefined, "the writer to run with a standby");
    log(`writer running; standby ${JSON.stringify(writing.standby)}`);
    assert.deepEqual([writing.standby.nodeId, writing.standby.status], ["node-b", "dispatched"], JSON.stringify(writing.standby));
    const first = await until(lease, (value) => value?.owner === "node-a", "the writer's lease");
    assert.equal(first.epoch, 1);

    // The Platform restarts while the standby stays up on its node: it comes back with the Project, its standby and its lease.
    // As a Platform process that exits would: connections held open to it (the standby's long poll) end with it.
    const restartedAt = Date.now();
    server.closeAllConnections();
    await zv.close();
    zv = platform();
    assert.equal((await asOwner("GET", "/config")).status, 200);
    const restarted = await until(async () => (await json("GET", "/projects/leased")).body?.project, (project) => project?.runtime?.status === "running" && project.standby?.status === "dispatched", "the Project to run again with its standby", 90_000);
    log(`Platform restarted; standby ${JSON.stringify(restarted.standby)}`);
    await until(lease, (value) => value?.owner === "node-a" && value.expiresAt > Date.now(), "the writer's lease after the restart");

    if (mode === "unknown") {
      const before = (await systemStore.get("fabric.project-ownership.v1", "leased")).value;
      const read = (await json("GET", "/writer-leases/leased")).body;
      assert.equal((await json("PUT", "/writer-leases/leased", { lease: { ...read.lease, owner: "node-x", epoch: read.lease.epoch + 1, expiresAt: Date.now() + 60_000 }, expectedVersion: read.version })).status, 200);
      await sleep(3000);
      const placed = (await systemStore.get("fabric.project-ownership.v1", "leased")).value;
      assert.deepEqual([placed.nodeId, placed.state, placed.epoch], ["node-a", "active", before.epoch], "nothing moved");
      assert.equal((await json("GET", "/projects/leased")).body.project.standby.status, "dispatched");
      return;
    }
    if (mode === "backstop") {
      // Written behind the routes' back: nothing tells the Platform. Its next reconciliation (a start) settles it.
      const stored = (await systemStore.get("zelavis.db.writer-leases", "leased")).value;
      await systemStore.set("zelavis.db.writer-leases", "leased", { ...stored, owner: "node-b", epoch: stored.epoch + 1, expiresAt: Date.now() + 60_000 });
      assert.equal((await systemStore.get("fabric.project-ownership.v1", "leased")).value.nodeId, "node-a", "the Platform has not been told");
      server.closeAllConnections();
      await zv.close();
      zv = platform();
      assert.equal((await asOwner("GET", "/config")).status, 200);
      const settled = await until(async () => (await json("GET", "/projects/leased")).body?.project, (project) => project?.placement?.nodeId === "node-b", "reconciliation to follow the lease", 60_000);
      assert.equal(settled.placement?.nodeId, "node-b");
      assert.equal((await systemStore.get("fabric.project-ownership.v1", "leased")).value.nodeId, "node-b");
      return;
    }

    // Data on the writer, followed by the standby.
    const client = createZelavisClient({ baseUrl: "http://localhost", rootPath: "/zelavis", fetch: (input, init) => zv.fetch(new Request(input, init), OWNER) });
    await client.data("leased").collections.create({ name: "notes" });
    await client.data("leased").documents.insert("notes", { id: "n1", data: { text: "written on the writer" } });
    const followers = client.followers("leased");
    await until(async () => {
      const listing = (await followers.partitions()).partitions;
      const behind = [];
      for (const { partition, head } of listing) {
        const held = (await followers.acknowledgments(partition)).followers.find((entry) => entry.name === "node-b");
        if (head > 0 && (held === undefined || held.position < head)) behind.push(partition);
      }
      return { behind, heads: listing.length };
    }, (state) => state.behind.length === 0 && state.heads > 1, "the standby to hold everything the writer wrote");
    log("standby level");
    // The restarted writer knows nothing of what the standby holds until the standby tells it: that takes a resync, not a write.
    assert.ok(Date.now() - restartedAt < 15_000, `the standby was level ${Date.now() - restartedAt} ms after the Platform restarted`);

    // The writer's process dies.
    const processes = (await json("GET", "/debug/processes")).body;
    const hosts = processes.processes.filter((entry) => entry.command.includes(join(root, "platform", "projects", "leased")));
    const engines = processes.processes.filter((entry) => hosts.some((host) => host.pid === entry.parentPid));
    const pids = victims(hosts, engines).map((entry) => entry.pid);
    const killedAt = Date.now();
    for (const each of pids) process.kill(each, "SIGKILL");
    log(`killed ${pids.join(",")}`);

    if (mode === "race") {
      assert.equal((await json("POST", "/projects/leased/start")).status, 200);
      const again = await until(lease, (value) => value?.owner === "node-a" && value.epoch > first.epoch, "node-a to take its lease again");
      await sleep(9000);
      const later = await lease();
      assert.deepEqual([later.owner, later.epoch], ["node-a", again.epoch], "no second writer: the standby did not promote");
      assert.ok(later.expiresAt > Date.now(), "and the writer is renewing");
      const project = (await json("GET", "/projects/leased")).body.project;
      assert.deepEqual([project.runtime.status, project.standby.status], ["running", "dispatched"]);
      return;
    }

    const promoted = await until(lease, (value) => value?.owner === "node-b" && value.epoch > 1, "the standby to take the lease over", 60_000);
    log(`standby holds the lease at epoch ${promoted.epoch}, ${((Date.now() - killedAt) / 1000).toFixed(1)}s after the kill`);
    const moved = await until(async () => (await json("GET", "/projects/leased")).body?.project, (project) => project?.placement?.nodeId === "node-b", "the Platform to follow the lease", 60_000);
    log(`placement followed ${((Date.now() - killedAt) / 1000).toFixed(1)}s after the kill`);
    assert.equal(moved.placement?.nodeId, "node-b");
    const placement = (await systemStore.get("fabric.project-ownership.v1", "leased")).value;
    assert.deepEqual([placement.nodeId, placement.state, placement.epoch > 1], ["node-b", "active", true]);

    // The Project runs on node-b under its placement: its lease is renewed there, by a writer that holds what the old one had.
    const renewed = await until(lease, (value) => value?.owner === "node-b" && value.epoch === promoted.epoch + 1 || value?.epoch > promoted.epoch, "the writer started under the new placement", 60_000).catch(() => lease());
    log(`writer on node-b holds the lease at epoch ${(await lease()).epoch}`);
    const before = (await lease()).expiresAt;
    await until(async () => (await lease()).expiresAt, (value) => value > before, "node-b's writer to renew its lease", 10_000);

    // The Platform reaches the Project on node-b: its Gateway sends the request, signed, to node-b's Agent.
    const through = await until(async () => { try { return await client.data("leased").documents.get("notes", "n1"); } catch (error) { return { error: String(error) }; } },
      (document) => document?.data?.text === "written on the writer", "the document to be read through the Gateway after the failover", 60_000);
    assert.equal(through.data.text, "written on the writer");
    log("read through the Gateway");

    if (mode === "twice") {
      // The node the writer left follows the new one...
      const standing = await until(async () => (await json("GET", "/projects/leased")).body?.project?.standby, (standby) => standby?.nodeId === "node-a" && standby.status === "dispatched", "a new standby on the node the writer left", 60_000);
      log(`new standby ${JSON.stringify(standing)}`);
      await until(async () => {
        const listing = (await followers.partitions()).partitions;
        const behind = [];
        for (const { partition, head } of listing) {
          const held = (await followers.acknowledgments(partition)).followers.find((entry) => entry.name === "node-a");
          if (head > 0 && (held === undefined || held.position < head)) behind.push(partition);
        }
        return behind.length;
      }, (behind) => behind === 0, "the new standby to hold everything the new writer holds", 90_000);
      await client.data("leased").documents.insert("notes", { id: "n2", data: { text: "written on node-b" } });
      await sleep(1500);

      // ...and when the new writer is lost, the Project fails over again, onto the Platform's own node.
      const before = await lease();
      const nodeB = (await json("GET", "/debug/processes")).body.processes;
      const hostsB = nodeB.filter((entry) => entry.command.includes(join(root, "node-b", "projects", "leased")));
      for (const entry of [...hostsB, ...nodeB.filter((entry) => hostsB.some((host) => host.pid === entry.parentPid))]) process.kill(entry.pid, "SIGKILL");
      const again = await until(lease, (value) => value?.owner === "node-a" && value.epoch > before.epoch, "the new standby to take the lease over", 60_000);
      log(`second failover: node-a holds the lease at epoch ${again.epoch}`);
      await until(async () => (await systemStore.get("fabric.project-ownership.v1", "leased")).value.nodeId, (node) => node === "node-a", "the placement to come back to node-a", 60_000);
      await until(async () => (await json("GET", "/projects/leased")).body?.project?.runtime?.status, (status) => status === "running", "the Project to run on node-a", 60_000);
      for (const [id, text] of [["n1", "written on the writer"], ["n2", "written on node-b"]]) {
        const found = await until(async () => { try { return await client.data("leased").documents.get("notes", id); } catch (error) { return { error: String(error) }; } }, (document) => document?.data?.text === text, `${id} to be read after the second failover`, 60_000);
        assert.equal(found.data.text, text);
      }
      return;
    }

    // Stopping it stops it where it runs, and what it holds is the data the old writer had.
    assert.equal((await json("POST", "/projects/leased/stop")).status, 200);
    await until(async () => (await lease()).expiresAt, (value) => value === 0, "the lease to be released", 30_000);
    const copy = await openNodeDatabase({ directory: join(root, "node-b", "projects", "leased", ".zelavis", "data", "primary", "shards"), crossTenantRefresh: false });
    try {
      const note = await copy.api.forTenant("owner").documents.findById({ collection: "notes", id: "n1" });
      assert.equal(note.data.text, "written on the writer");
    } finally {
      await copy.close();
    }
    log("done");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[`ZELAVIS_PROJECT_LEASES_${key}`];
      else process.env[`ZELAVIS_PROJECT_LEASES_${key}`] = value;
    }
    await agent?.close();
    await zv?.close();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
