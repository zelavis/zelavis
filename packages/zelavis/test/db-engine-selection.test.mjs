import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openNodeDatabase, shardFilePath, DEFAULT_LOCAL_SHARDS } from "../dist/db/node-host.js";
import { engineAvailable } from "./_engine-available.mjs";

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-engine-"));
  const databases = [];
  // Node runs after hooks in registration order. Close/flush every database
  // before removing the directory; RocksDB 2.10 reports a failed flush.
  t.after(async () => {
    for (const database of databases) await database.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, track: (database) => databases.push(database) };
};

// The same work through the host, whichever engine is underneath. A failure
// here is the host wiring, since each engine already passes the store contract.
const exercise = async (opened) => {
  const tenant = opened.api.forTenant("acme");
  await tenant.documents.createCollection({ name: "posts" });
  await tenant.documents.insert({
    collection: "posts", id: "p1", data: { title: "Atlas", region: "eu-west" },
  });
  const found = await tenant.documents.findMany({
    collection: "posts", where: [{ path: "region", value: "eu-west" }],
  });
  assert.deepEqual(found.map((d) => d.id), ["p1"]);
  const events = await tenant.events.read();
  assert.deepEqual(events.map((e) => e.type), ["collection.created", "document.upserted"]);
  assert.equal(opened.partitionMap.placements.length, DEFAULT_LOCAL_SHARDS.length);
};

test("the default engine is sqlite, and needs nothing installed", async (t) => {
  const { dir, track } = tempDir(t);
  const opened = await openNodeDatabase({ directory: dir });
  track(opened);

  assert.equal(opened.engine, "sqlite", "chosen by omission, not by configuration");
  await exercise(opened);
  // The default engine writes the files the host reports.
  assert.ok(existsSync(shardFilePath(dir, DEFAULT_LOCAL_SHARDS[0])));
});

// A native engine that is not installed, or installed and not built, is an
// ordinary state here: the engines are optional peers.
const specifiers = { rocksdb: "@harperfast/rocksdb-js" };
const engines = ["sqlite", "libsql", "rocksdb", "lmdb"].map((name) => [
  name,
  name === "sqlite" || engineAvailable(specifiers[name] ?? name),
]);

for (const [name, installed] of engines) {
  test(`the host opens on ${name}`, { skip: installed ? false : `${name} is not installed` }, async (t) => {
    const { dir, track } = tempDir(t);
    const opened = await openNodeDatabase({ directory: dir, engine: { name } });
    track(opened);
    assert.equal(opened.engine, name);
    await exercise(opened);
  });
}

test("an engine choice survives a close and reopen", async (t) => {
  const { dir, track } = tempDir(t);
  const first = await openNodeDatabase({ directory: dir, engine: { name: "lmdb" } });
  track(first);
  const home = first.api.shardOf("acme");
  await exercise(first);
  await first.close();

  const again = await openNodeDatabase({ directory: dir, engine: { name: "lmdb" } });
  track(again);
  assert.equal(again.api.shardOf("acme"), home, "the stored map still places the tenant");
  const found = await again.api.forTenant("acme").documents.findById({
    collection: "posts", id: "p1",
  });
  assert.equal(found.data.title, "Atlas", "data written under this engine is still there");
});
