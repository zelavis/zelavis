// The operator surface of a Project's remote shard placement: the allocation and the ledger view, over HTTP, the SDK and
// the CLI, with the access each needs and the cleanup a Project's deletion owes.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Zelavis } from "../dist/index.js";
import { nodeAdapter } from "../dist/adapters/node.js";
import { createLocalSqliteSystemStore } from "../dist/adapters/_sqlite-system-store.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runShardPlacementCommand } from "../dist/cli/shard-placement.js";

const OWNER = { principal: { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] } };
const VIEWER = { principal: { id: "viewer", type: "user", roles: [], permissions: ["fabric.view"] } };
const API = "http://127.0.0.1/zelavis/api/v1/runtime";

test("shard allocation and placements are readable and settable through HTTP, SDK and CLI", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zv-shard-operator-"));
  const zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: root }) });
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    await zv.close();
    await rm(root, { recursive: true, force: true });
  });
  const call = async (method, path, body, who = OWNER) => {
    const answer = await zv.fetch(new Request(`${API}${path}`, {
      method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), who);
    return { status: answer.status, body: await answer.json().catch(() => undefined) };
  };
  const created = await call("POST", "/projects", { id: "shards", name: "Shards", recipeName: "@zelavis/app", start: false });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const empty = await call("GET", "/shard-placement/shards");
  assert.deepEqual(empty.body, { projectId: "shards", allocation: null, incarnation: null, revision: 0, placements: [] });

  const input = { allowedNodeIds: ["node-b"], cpuCores: 2, memoryBytes: 1000, diskBytes: 1000, expectedGeneration: 0 };
  const set = await call("PUT", "/shard-placement/shards/allocation", input);
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.allocation.generation, 1);
  const conflict = await call("PUT", "/shard-placement/shards/allocation", input);
  assert.deepEqual([conflict.status, conflict.body.code, conflict.body.current.generation], [409, "generation-conflict", 1]);
  assert.equal((await call("PUT", "/shard-placement/shards/allocation", { ...input, cpuCores: 0, expectedGeneration: 1 })).status, 400);
  assert.equal((await call("PUT", "/shard-placement/nobody/allocation", input)).status, 404);
  assert.equal((await call("PUT", "/shard-placement/nobody/allocation", input)).body.code, "unknown-project");

  assert.equal((await call("GET", "/shard-placement/shards", undefined, VIEWER)).status, 200);
  assert.equal((await call("PUT", "/shard-placement/shards/allocation", { ...input, expectedGeneration: 1 }, VIEWER)).status, 403);

  const client = createZelavisClient({ baseUrl: "http://localhost", rootPath: "/zelavis", fetch: (request, init) => zv.fetch(new Request(request, init), OWNER) });
  const viaHttp = (await call("GET", "/shard-placement/shards")).body;
  assert.deepEqual(await client.shardPlacement.get("shards"), viaHttp);
  const next = await client.shardPlacement.setAllocation("shards", { ...input, expectedGeneration: 1, cpuCores: 3 });
  assert.equal(next.generation, 2);
  await assert.rejects(client.shardPlacement.setAllocation("shards", { ...input, expectedGeneration: 1 }), (error) => error.code === "generation-conflict");

  globalThis.fetch = (request, init) => zv.fetch(new Request(request, init), OWNER);
  const lines = [];
  console.log = (line) => lines.push(String(line));
  await runShardPlacementCommand(["get", "shards", "--url", "http://zv.test/zelavis", "--json"]);
  assert.deepEqual(JSON.parse(lines.at(-1)), (await call("GET", "/shard-placement/shards")).body);
  await runShardPlacementCommand(["set-allocation", "shards", "--nodes", "node-b,node-c", "--cpu", "4", "--memory", "2000", "--disk", "2000", "--expected-generation", "2", "--url", "http://zv.test/zelavis", "--json"]);
  assert.equal(JSON.parse(lines.at(-1)).allocation.generation, 3);
  await assert.rejects(runShardPlacementCommand(["set-allocation", "shards", "--nodes", "node-b", "--cpu", "4", "--memory", "2000", "--disk", "2000", "--expected-generation", "2", "--url", "http://zv.test/zelavis", "--json"]), /changed since/);
  assert.deepEqual(JSON.parse(lines.at(-1)), { error: "The allocation changed since it was read.", code: "generation-conflict" });
  await assert.rejects(runShardPlacementCommand(["set-allocation", "shards", "--url", "http://zv.test/zelavis"]), /--nodes is required/);

  // Deleting the Project removes its allocation.
  const store = createLocalSqliteSystemStore({ filename: join(root, "system", "zelavis.sqlite") });
  assert.notEqual(await store.get("fabric.app-data-allocation.v1", "shards"), undefined);
  const removed = await call("DELETE", "/projects/shards");
  assert.ok(removed.status < 300, JSON.stringify(removed));
  const end = Date.now() + 30_000;
  while (Date.now() < end && await store.get("fabric.app-data-allocation.v1", "shards") !== undefined) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await store.get("fabric.app-data-allocation.v1", "shards"), undefined);
});
