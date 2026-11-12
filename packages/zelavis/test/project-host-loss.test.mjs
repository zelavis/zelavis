// When a Project's host process dies, its engine ends with it: the engine cannot go on renewing the Project's writer lease
// for a host that is gone, because the lease is what keeps a standby from taking over.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Zelavis } from "../dist/index.js";
import { nodeAdapter } from "../dist/adapters/node.js";

const OWNER = { principal: { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] } };
const API = "http://127.0.0.1/zelavis/api/v1/runtime";
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

test("a Project's engine ends with its host, so its lease lapses within one TTL", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "zv-host-loss-"));
  const saved = Object.fromEntries(["URL", "NODE", "STANDBY", "TTL_MILLIS"].map((key) => [key, process.env[`ZELAVIS_PROJECT_LEASES_${key}`]]));
  let zv;
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const answer = await zv.fetch(new Request(`http://127.0.0.1:${server.address().port}${request.url}`, { method: request.method, headers: request.headers, ...(hasBody ? { body: Buffer.concat(chunks) } : {}) }));
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      response.end(Buffer.from(await answer.arrayBuffer()));
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const json = async (method, path, body) => {
    const answer = await zv.fetch(new Request(`${API}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), OWNER);
    return { status: answer.status, body: await answer.json().catch(() => undefined) };
  };
  try {
    process.env.ZELAVIS_PROJECT_LEASES_URL = `http://127.0.0.1:${server.address().port}/zelavis/api/v1`;
    process.env.ZELAVIS_PROJECT_LEASES_NODE = "node-a";
    process.env.ZELAVIS_PROJECT_LEASES_STANDBY = "node-b";
    process.env.ZELAVIS_PROJECT_LEASES_TTL_MILLIS = "3000";
    zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: directory }) });
    assert.equal((await json("POST", "/projects", { id: "leased", name: "Leased", recipeName: "@zelavis/app", start: true })).status, 201);
    await until(async () => (await json("GET", "/projects/leased")).body?.project?.runtime?.status, (status) => status === "running", "the Project to run");
    const lease = async () => (await json("GET", "/writer-leases/leased")).body?.lease;
    await until(lease, (value) => value?.owner === "node-a", "the lease");

    // A follower is holding a request open on the engine: its feed waits up to 25 s for a write.
    const waiting = json("POST", "/projects/leased/followers/feed", { timeoutMillis: 25_000 }).catch(() => undefined);
    await sleep(500);

    // Only the host dies; its engine worker is still there, renewing.
    const processes = (await json("GET", "/debug/processes")).body.processes;
    // This test's own host: the diagnostics list every Project process on the machine, other test runs' included.
    const host = processes.find((entry) => entry.command.includes(join(directory, "projects", "leased")));
    const worker = processes.find((entry) => entry.parentPid === host.pid);
    assert.ok(host && worker, "the diagnostics name the host and its engine");
    process.kill(host.pid, "SIGKILL");
    const killedAt = Date.now();

    // The engine ends with its host: its process is gone, and the lease stops being renewed and lapses.
    await until(async () => { try { process.kill(worker.pid, 0); return true; } catch { return false; } }, (alive) => !alive, "the engine to end with its host", 40_000);
    await waiting;
    console.log(`engine ended ${((Date.now() - killedAt) / 1000).toFixed(1)}s after its host was killed`);
    // Not renewed by the engine that ended: the lease lapses, or the Platform, which restarts a dead writer, took it at a
    // higher epoch. Either way no one goes on renewing epoch 1.
    const seen = await lease();
    await until(lease, (value) => value.epoch > seen.epoch || value.expiresAt <= Date.now(), "the old engine's lease to lapse or be taken again", 15_000);
    const after = await lease();
    if (after.epoch === seen.epoch) assert.equal(after.expiresAt, seen.expiresAt, "and it was not renewed after the engine ended");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[`ZELAVIS_PROJECT_LEASES_${key}`];
      else process.env[`ZELAVIS_PROJECT_LEASES_${key}`] = value;
    }
    await zv?.close();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
