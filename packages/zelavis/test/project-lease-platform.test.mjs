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

const until = async (read, accept, what, deadline = 30_000) => {
  const end = Date.now() + deadline;
  let last;
  while (Date.now() < end) {
    last = await read();
    if (accept(last)) return last;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}; last: ${JSON.stringify(last)}`);
};

test("a real Platform runs a real App Project under its writer lease", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "zv-lease-platform-"));
  const saved = Object.fromEntries(["URL", "NODE", "STANDBY", "TTL_MILLIS"].map((key) => [key, process.env[`ZELAVIS_PROJECT_LEASES_${key}`]]));
  let zv;
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
  const call = (method, path, body) => zv.fetch(new Request(`${API}${path}`, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), OWNER);
  const json = async (method, path, body) => {
    const answer = await call(method, path, body);
    return { status: answer.status, body: await answer.json().catch(() => undefined) };
  };
  const lease = async () => (await json("GET", "/writer-leases/leased")).body;
  const status = async () => (await json("GET", "/projects/leased")).body?.runtime?.status ?? (await json("GET", "/projects/leased")).body?.project?.runtime?.status;
  try {
    process.env.ZELAVIS_PROJECT_LEASES_URL = `http://127.0.0.1:${server.address().port}/zelavis/api/v1`;
    process.env.ZELAVIS_PROJECT_LEASES_NODE = "node-a";
    process.env.ZELAVIS_PROJECT_LEASES_STANDBY = "node-b";
    process.env.ZELAVIS_PROJECT_LEASES_TTL_MILLIS = "3000";
    zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: directory }) });

    const created = await json("POST", "/projects", { id: "leased", name: "Leased", recipeName: "@zelavis/app", start: true });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    await until(status, (value) => value === "running", "the Project to run");

    const first = (await until(lease, (value) => value?.lease !== undefined, "the lease")).lease;
    assert.equal(first.owner, "node-a");
    assert.equal(first.epoch, 1);
    assert.equal(first.standby, "node-b");
    assert.ok(first.expiresAt > Date.now());

    await until(async () => (await lease()).lease.expiresAt, (value) => value > first.expiresAt, "a renewal", 5_000);

    const audit = (await json("GET", "/writer-lease-audit")).body.entries;
    assert.ok(audit.some((entry) => entry.partition === "leased" && entry.principal === "project:leased@node-a" && entry.to.owner === "node-a" && entry.to.epoch === 1), JSON.stringify(audit));

    assert.equal((await json("POST", "/projects/leased/stop")).status, 200);
    await until(async () => (await lease()).lease.expiresAt, (value) => value === 0, "the lease to be released", 10_000);

    assert.equal((await json("POST", "/projects/leased/start")).status, 200);
    await until(status, (value) => value === "running", "the Project to run again");
    const second = (await lease()).lease;
    assert.equal(second.epoch, 2);
    assert.equal(second.owner, "node-a");

    await json("POST", "/projects/leased/stop");
    const released = await until(lease, (value) => value?.lease?.expiresAt === 0, "the second release", 10_000);
    const taken = await json("PUT", "/writer-leases/leased", {
      lease: { ...released.lease, owner: "node-x", epoch: released.lease.epoch + 1, expiresAt: Date.now() + 60_000 },
      expectedVersion: released.version,
    });
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    await json("POST", "/projects/leased/start");
    await until(status, (value) => value === "failed", "the start to fail under another node's lease");
    const logs = (await json("GET", "/projects/leased/logs")).body.logs;
    assert.ok(JSON.stringify(logs).includes("LeaseStillHeld"), JSON.stringify(logs).slice(-2000));

    assert.equal((await json("DELETE", "/projects/leased")).status < 300, true);
    await until(async () => (await json("GET", "/projects/leased")).status, (value) => value === 404, "the Project to be deleted", 30_000);
    assert.equal((await json("GET", "/writer-leases/leased")).status, 404);
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
