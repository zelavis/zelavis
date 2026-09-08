import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openNodeDatabase, shardFilePath, DEFAULT_LOCAL_SHARDS } from "../dist/db/node-host.js";

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-engine-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
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
  const dir = tempDir(t);
  const opened = await openNodeDatabase({ directory: dir });
  t.after(() => opened.close());

  assert.equal(opened.engine, "sqlite", "chosen by omission, not by configuration");
  await exercise(opened);
  // The default engine writes the files the host reports.
  assert.ok(existsSync(shardFilePath(dir, DEFAULT_LOCAL_SHARDS[0])));
});

for (const name of ["sqlite", "libsql", "rocksdb", "lmdb"]) {
  test(`the host opens on ${name}`, async (t) => {
    const dir = tempDir(t);
    const opened = await openNodeDatabase({ directory: dir, engine: { name } });
    t.after(() => opened.close());
    assert.equal(opened.engine, name);
    await exercise(opened);
  });
}

test("an engine choice survives a close and reopen", async (t) => {
  const dir = tempDir(t);
  const first = await openNodeDatabase({ directory: dir, engine: { name: "lmdb" } });
  const home = first.api.shardOf("acme");
  await exercise(first);
  await first.close();

  const again = await openNodeDatabase({ directory: dir, engine: { name: "lmdb" } });
  t.after(() => again.close());
  assert.equal(again.api.shardOf("acme"), home, "the stored map still places the tenant");
  const found = await again.api.forTenant("acme").documents.findById({
    collection: "posts", id: "p1",
  });
  assert.equal(found.data.title, "Atlas", "data written under this engine is still there");
});
