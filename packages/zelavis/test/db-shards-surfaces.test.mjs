// Shard placement through the SDK and the CLI: the same requests the HTTP routes take, so the three cannot drift.
import assert from "node:assert/strict";
import test from "node:test";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { defineDatabaseService } from "../dist/db/index.js";
import { runShardsCommand, parseRanges } from "../dist/cli/shards.js";

const OPERATION = { kind: "place", operationId: "op-1", shardId: "shard-4", virtualRanges: [0, 1, 2, 3, 9], phase: "requested", startedAt: "2026-11-08T00:00:00.000Z", updatedAt: "2026-11-08T00:00:00.000Z" };

const recordingFetch = (requests) => async (input, init) => {
  const url = String(input);
  requests.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
  const body = url.endsWith("/shards") ? { shards: [{ shardId: "shard-0", location: "local", virtualRanges: 64 }], operation: null }
    : url.endsWith("/shards/operation") ? { operation: null }
    : { operation: {
      ...OPERATION,
      ...(url.endsWith("/replicate") || url.endsWith("/unreplicate") ? { kind: url.split("/").at(-1), of: "shard-4", shardId: "shard-4.replica", virtualRanges: [] } : {}),
    } };
  return new Response(JSON.stringify(body), { status: init?.method === "POST" ? 202 : 200, headers: { "content-type": "application/json" } });
};

test("the SDK reaches the six routes under the Project's database", async () => {
  const requests = [];
  const client = createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch: recordingFetch(requests) });
  const shards = client.shards("p1");
  assert.equal((await shards.list()).shards[0].shardId, "shard-0");
  const resources = { cpuCores: 1, memoryBytes: 2 ** 30, diskBytes: 10 * 2 ** 30 };
  assert.equal((await shards.place({ virtualRanges: [0, 1], resources })).operationId, "op-1");
  assert.equal((await shards.release("shard-4", { into: "shard-0" })).kind, "place");
  assert.equal((await shards.replicate("shard-4", { diskBytes: 512 })).kind, "replicate");
  assert.equal((await shards.unreplicate("shard-4")).kind, "unreplicate");
  assert.equal(await shards.operation(), null);
  assert.deepEqual(requests.map((r) => [r.method, r.url.replace("http://zv.test/zelavis/api/v1/runtime/projects/p1/proxy/zelavis/api/v1/database", "")]), [
    ["GET", "/shards"], ["POST", "/shards/place"], ["POST", "/shards/shard-4/release"],
    ["POST", "/shards/shard-4/replicate"], ["POST", "/shards/shard-4/unreplicate"], ["GET", "/shards/operation"],
  ]);
  assert.deepEqual(requests[1].body, { virtualRanges: [0, 1], resources });
  assert.deepEqual(requests[2].body, { into: "shard-0" });
  assert.deepEqual(requests[3].body, { resources: { diskBytes: 512 } });
  assert.equal(requests[4].body, undefined);
});

test("the CLI sends what the SDK sends", async (t) => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  t.after(() => { globalThis.fetch = originalFetch; console.log = originalLog; });
  globalThis.fetch = recordingFetch(requests);
  const lines = [];
  console.log = (line) => lines.push(String(line));
  const common = ["--project", "p1", "--url", "http://zv.test/zelavis"];

  await runShardsCommand(["place", "--ranges", "0-3,9", "--cpu", "1", "--memory", "1073741824", "--disk", "10737418240", ...common, "--json"]);
  assert.deepEqual(requests.at(-1).body, { virtualRanges: [0, 1, 2, 3, 9], resources: { cpuCores: 1, memoryBytes: 1073741824, diskBytes: 10737418240 } });
  assert.equal(JSON.parse(lines.at(-1)).operationId, "op-1");

  await runShardsCommand(["release", "shard-4", "--into", "shard-0", ...common]);
  assert.match(requests.at(-1).url, /\/shards\/shard-4\/release$/);
  assert.deepEqual(requests.at(-1).body, { into: "shard-0" });

  await runShardsCommand(["replicate", "shard-4", "--disk", "512", ...common, "--json"]);
  assert.match(requests.at(-1).url, /\/shards\/shard-4\/replicate$/);
  assert.deepEqual(requests.at(-1).body, { resources: { diskBytes: 512 } });
  assert.equal(JSON.parse(lines.at(-1)).kind, "replicate");
  await runShardsCommand(["unreplicate", "shard-4", ...common]);
  assert.match(requests.at(-1).url, /\/shards\/shard-4\/unreplicate$/);
  assert.match(lines.at(-1), /^unreplicate shard-4.replica: requested/);
  await assert.rejects(runShardsCommand(["replicate", "shard-4", ...common]), /--disk is required/);

  await runShardsCommand(["list", ...common]);
  assert.match(lines.at(-1), /No shard operation/);
  await runShardsCommand(["operation", ...common]);

  await assert.rejects(runShardsCommand(["place", "--ranges", "9-3", "--cpu", "1", "--memory", "1", "--disk", "1", ...common]), /backwards/);
  await assert.rejects(runShardsCommand(["place", "--cpu", "1", "--memory", "1", "--disk", "1", ...common]), /--ranges is required/);
  assert.deepEqual(parseRanges("5,0-2"), [5, 0, 1, 2]);
});

test("the replica route rejects a missing, fractional or nonpositive disk reservation", async () => {
  const route = defineDatabaseService({}).api.v1.find((entry) => entry.id === "database.shards.replicate");
  assert.deepEqual(route.access.permissions, ["database.shards.manage"]);
  for (const resources of [undefined, {}, { diskBytes: 0 }, { diskBytes: 1.5 }]) {
    const answer = await route.handler({ params: { shardId: "shard-4" }, body: { resources } });
    assert.equal(answer.status, 400);
    assert.equal(answer.body.code, "invalid-request");
  }
});
