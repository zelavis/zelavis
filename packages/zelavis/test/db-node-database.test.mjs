import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_LOCAL_SHARDS, openNodeDatabase, shardFilePath } from "../dist/db/node-host.js";

/**
 * A directory removed only after everything the test opened in it is closed: hooks run in the order they are added, and
 * removing a live database's files races the threads still using them (its checkpoint thread among them).
 */
const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-open-"));
  const closing = [];
  t.after(async () => {
    for (const close of closing.reverse()) await close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, closeLater: (close) => closing.push(close) };
};

test("opening a database gives a promise-facing api and closes its shards", async (t) => {
  const { dir, closeLater } = tempDir(t);
  const opened = await openNodeDatabase({ directory: dir, nodeId: "node-a" });

  // Sharded from creation, on one node, exactly as the App topology requires.
  assert.equal(opened.partitionMap.placements.length, DEFAULT_LOCAL_SHARDS.length);
  assert.equal(opened.api.context.nodeId, "node-a");
  for (const shard of DEFAULT_LOCAL_SHARDS) {
    assert.ok(existsSync(shardFilePath(dir, shard)), `${shard} exists on disk`);
  }

  const tenant = opened.api.forTenant("acme");
  await tenant.documents.createCollection({ name: "posts" });
  await tenant.documents.insert({ collection: "posts", id: "p1", data: { title: "Atlas" } });
  assert.equal(
    (await tenant.documents.findById({ collection: "posts", id: "p1" })).data.title,
    "Atlas",
  );

  await opened.close();

  // Reopening sees the same data and the same placements.
  const again = await openNodeDatabase({ directory: dir });
  closeLater(() => again.close());
  assert.equal(again.partitionMap.version, opened.partitionMap.version);
  assert.equal(again.api.shardOf("acme"), opened.api.shardOf("acme"));
  const found = await again.api.forTenant("acme").documents.findById({
    collection: "posts", id: "p1",
  });
  assert.equal(found.data.title, "Atlas", "data survives a close and reopen");
});

test("a caller cannot re-place ranges by opening with a different shard list", async (t) => {
  const { dir, closeLater } = tempDir(t);
  const first = await openNodeDatabase({ directory: dir, shards: ["a", "b"] });
  const home = first.api.shardOf("acme");
  await first.api.forTenant("acme").documents.createCollection({ name: "posts" });
  await first.close();

  const second = await openNodeDatabase({ directory: dir, shards: ["x", "y", "z"] });
  closeLater(() => second.close());
  assert.equal(second.api.shardOf("acme"), home, "the stored map still places the tenant");
  assert.deepEqual(
    (await second.api.forTenant("acme").documents.listCollections()).map((c) => c.name),
    ["posts"],
  );
});

test("closing releases the files so another process can open them", async (t) => {
  const { dir, closeLater } = tempDir(t);
  const opened = await openNodeDatabase({ directory: dir, shards: ["only"] });
  await opened.api.forTenant("acme").documents.createCollection({ name: "posts" });
  await opened.close();

  // A second close is harmless; shutdown paths run more than once.
  await opened.close();

  const reopened = await openNodeDatabase({ directory: dir, shards: ["only"] });
  closeLater(() => reopened.close());
  assert.deepEqual(
    (await reopened.api.forTenant("acme").documents.listCollections()).map((c) => c.name),
    ["posts"],
  );
});
