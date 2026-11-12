import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openNodeDatabase, readShardLocations, writeShardLocations } from "../dist/db/node-host.js";

const project = (t) => {
  const root = mkdtempSync(join(tmpdir(), "zv-nodehost-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "data");
  mkdirSync(directory);
  return { root, directory };
};

test("a locations file naming a shard with no channel refuses the open, naming the shard", async (t) => {
  const { directory } = project(t);
  writeShardLocations(directory, { remote: ["shard-9"], replicas: [] });
  // The map must name it for the open to reach it: a database that placed it had routed ranges there.
  await assert.rejects(
    openNodeDatabase({ directory, shards: ["shard-9"] }),
    (error) => /shard-9/.test(String(error.cause ?? error.message ?? error)),
  );
});

test("a lease-guarded Project cannot hold shards on other Nodes", async (t) => {
  const { directory } = project(t);
  writeShardLocations(directory, { remote: ["shard-9"], replicas: [] });
  await assert.rejects(
    openNodeDatabase({ directory, lease: { role: "writer" } }),
    (error) => error instanceof TypeError && /lease-guarded/.test(error.message),
  );
});

test("an unreachable Agent does not stop the open: the shard is reported not answering and its Tenants are refused, naming it", async (t) => {
  const { directory } = project(t);
  writeShardLocations(directory, { remote: ["shard-9"], replicas: [] });
  const started = Date.now();
  const opened = await openNodeDatabase({
    directory, shards: ["shard-9"],
    appShards: { apiRoot: "http://127.0.0.1:1/zelavis/api/v1", token: "x", projectId: "p" },
  });
  t.after(() => opened.close());
  assert.ok(Date.now() - started < 35_000, "the open is bounded");
  const listed = (await opened.api.shards.list()).shards;
  assert.deepEqual(listed.map((shard) => [shard.shardId, shard.location, shard.available]), [["shard-9", "remote", false]]);
  await assert.rejects(opened.api.forTenant("someone").documents.listCollections(), (error) => /shard-9/.test(JSON.stringify(error) + String(error.message)));
});

test("without a locations file the open is unchanged", async (t) => {
  const { directory } = project(t);
  const opened = await openNodeDatabase({ directory, shards: ["shard-0", "shard-1"] });
  assert.deepEqual(opened.partitionMap.placements.map((p) => p.shard), ["shard-0", "shard-1"]);
  assert.deepEqual(readShardLocations(directory), { remote: [], replicas: [] });
  await opened.close();
});

test("a malformed locations file is refused, naming the file", async (t) => {
  const { root, directory } = project(t);
  writeFileSync(join(root, "shard-locations.json"), "{ nope");
  assert.throws(() => readShardLocations(directory), /shard-locations\.json/);
});

test("a locations file with a replica lists it and a lease-guarded open refuses it", async (t) => {
  const { directory } = project(t);
  const locations = { remote: [], replicas: [{ of: "shard-0", shard: "shard-0.replica" }] };
  writeShardLocations(directory, locations);
  assert.deepEqual(readShardLocations(directory), locations);
  await assert.rejects(openNodeDatabase({ directory, lease: { role: "writer" } }), /lease-guarded/);
});

test("a locations file without the replicas key is malformed", (t) => {
  const { root, directory } = project(t);
  writeFileSync(join(root, "shard-locations.json"), JSON.stringify({ remote: [] }));
  assert.throws(() => readShardLocations(directory), /malformed/);
});
