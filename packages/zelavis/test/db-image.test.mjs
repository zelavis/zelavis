// A physical backup through the ordered key-value interface alone: every shard copied, byte for byte, from one
// engine's snapshot into another engine of any kind, and the result opens as an ordinary database. These tests copy
// across engines in both directions, open the copy and hold it to the source, refuse a destination that holds data,
// and check that the Node host writes images that finish whole, list, and open with the engine they were written in.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Exit, Cause } from "effect";
import { makeDatabase, partitionMapFor } from "../dist/db/index.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { makeNodeSqliteEngine } from "../dist/db/engines/node-sqlite.js";
import { makeLmdbEngine } from "../dist/db/engines/lmdb.js";
import { makeRocksdbJsEngine } from "../dist/db/engines/rocksdb-js.js";
import { openShardOverKv } from "../dist/db/kv-store.js";
import { openNodeDatabase } from "../dist/db/node-host.js";

const map = partitionMapFor(["s0", "s1"]);
const scratch = (t) => {
  const directory = mkdtempSync(join(tmpdir(), "zv-image-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};

/** Engine factories: `open(shard)` gives a scoped engine in that kind, over its own directory or memory. */
const kinds = (t) => {
  const memories = new Map();
  const sqlite = scratch(t), lmdb = scratch(t), rocks = scratch(t);
  return {
    memory: { open: (shard) => Effect.sync(() => memories.get(shard) ?? (memories.set(shard, memoryKvEngine()), memories.get(shard))) },
    sqlite: { open: (shard) => makeNodeSqliteEngine(shard, sqlite) },
    lmdb: { open: (shard) => makeLmdbEngine(shard, lmdb) },
    rocksdb: { open: (shard) => makeRocksdbJsEngine(shard, rocks) },
  };
};

const database = (kind) => makeDatabase({
  partitionMap: map,
  crossTenantRefresh: false,
  openShard: (shard) => Effect.flatMap(kind.open(shard), (engine) => openShardOverKv(shard, engine)),
});

const seed = (db) => Effect.gen(function* () {
  for (const tenant of ["acme", "globex", "initech"]) {
    const handle = db.forTenant(tenant);
    yield* handle.documents.createCollection({ name: "posts", columns: ["title", "rank"] });
    for (const id of ["a", "b", "c"]) yield* handle.documents.insert({ collection: "posts", id, data: { title: `${tenant}-${id}`, rank: 1 } });
    yield* handle.documents.update({ collection: "posts", id: "a", data: { title: `${tenant}-changed`, rank: 2 } });
  }
  yield* db.topology.subdivision.subdivide("whale", ["a", "b"]);
  for (const part of ["a", "b"]) {
    const handle = db.forPart("whale", part);
    yield* handle.documents.createCollection({ name: "posts" });
    yield* handle.documents.insert({ collection: "posts", id: `${part}1`, data: { title: part } });
  }
});

const everything = (db) => Effect.gen(function* () {
  const found = {};
  for (const tenant of ["acme", "globex", "initech"]) {
    const docs = yield* db.forTenant(tenant).documents.findMany({ collection: "posts" });
    found[tenant] = docs.map((doc) => `${doc.id}:${doc.data.title}:${doc.version}`).sort();
    found[`${tenant}:ranked`] = (yield* db.forTenant(tenant).documents.findMany({ collection: "posts", where: [{ path: "rank", op: "gte", value: 2 }], orderBy: [{ path: "rank" }] })).map((doc) => doc.id);
  }
  for (const part of ["a", "b"]) {
    found[`whale#${part}`] = (yield* db.forPart("whale", part).documents.findMany({ collection: "posts" })).map((doc) => doc.id).sort();
  }
  return found;
});

const available = async (name, factory) => {
  try {
    await Effect.runPromise(Effect.scoped(Effect.asVoid(factory.open("probe"))));
    return true;
  } catch { return false; }
};

for (const [from, to] of [["memory", "sqlite"], ["sqlite", "memory"], ["sqlite", "sqlite"], ["memory", "lmdb"], ["lmdb", "sqlite"], ["rocksdb", "lmdb"], ["sqlite", "rocksdb"]]) {
  test(`an image from ${from} into ${to} opens as the same database`, async (t) => {
    const set = kinds(t);
    for (const kind of new Set([from, to])) {
      if (!(await available(kind, set[kind]))) return t.skip(`${kind} is not installed`);
    }
    const source = kinds(t)[from];
    const destination = set[to];
    const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const db = yield* database(source);
      yield* seed(db);
      const before = yield* everything(db);
      const shards = yield* db.maintenance.image((shard) => destination.open(shard));
      // Writes after the image are not in it.
      yield* db.forTenant("acme").documents.insert({ collection: "posts", id: "late", data: { title: "late", rank: 9 } });
      return { before, shards };
    })));
    assert.ok(outcome.shards.length >= 2 && outcome.shards.every((entry) => entry.keys > 0 && entry.bytes > 0), "every shard was copied");
    const reopened = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const copy = yield* database(destination);
      return yield* everything(copy);
    })));
    assert.deepEqual(reopened, outcome.before, "the image is the database as it was when the copy began");
  });
}

test("an image goes only into an empty engine, and a copy of a copy is the same again", async (t) => {
  const set = kinds(t);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const db = yield* database(set.memory);
    yield* seed(db);
    yield* db.maintenance.image((shard) => set.sqlite.open(shard));
    const again = yield* Effect.exit(db.maintenance.image((shard) => set.sqlite.open(shard)));
    assert.ok(Exit.isFailure(again));
    assert.match(String(Cause.squash(again.cause).cause), /already holds data/);
  })));
});

test("the Node host writes an image that finishes whole, lists, refuses a taken or bad name, and opens in its own engine", async (t) => {
  const root = scratch(t);
  const directory = join(root, "primary", "shards");
  const opened = await openNodeDatabase({ directory, crossTenantRefresh: false });
  t.after(() => opened.close());
  const handle = opened.api.forTenant("acme");
  await handle.documents.createCollection({ name: "posts" });
  for (const id of ["a", "b"]) await handle.documents.insert({ collection: "posts", id, data: { title: id } });

  assert.deepEqual(await opened.api.images.list(), []);
  const image = await opened.api.images.create("nightly");
  assert.equal(image.name, "nightly");
  assert.equal(image.engine, "sqlite");
  assert.ok(image.keys > 0 && image.shards.length >= 2);
  assert.deepEqual((await opened.api.images.list()).map((entry) => entry.name), ["nightly"]);
  assert.deepEqual(readdirSync(join(root, "primary", "images")).filter((entry) => entry.startsWith(".partial")), [], "nothing unfinished is left behind");
  for (const bad of ["", ".hidden", "has space", "a/b", "x".repeat(65)]) await assert.rejects(() => opened.api.images.create(bad), /image name is 1 to 64/);
  await assert.rejects(() => opened.api.images.create("nightly"), /already exists/);
  await assert.rejects(() => opened.api.images.create("other", { engine: "libsql-remote" }), /local engine/);

  // Opened where it lies, with the engine it was written in: the database as it was.
  const copy = await openNodeDatabase({ directory: join(root, "primary", "images", "nightly"), crossTenantRefresh: false });
  t.after(() => copy.close());
  const docs = await copy.api.forTenant("acme").documents.findMany({ collection: "posts" });
  assert.deepEqual(docs.map((doc) => doc.id).sort(), ["a", "b"]);
  assert.ok(existsSync(join(root, "primary", "images", "nightly", "image.json")));
});

test("an image verifies against the digest recorded when it was written, names a changed shard, and is removed or pruned", async (t) => {
  const root = scratch(t);
  const opened = await openNodeDatabase({ directory: join(root, "primary", "shards"), crossTenantRefresh: false });
  t.after(() => opened.close());
  await opened.api.forTenant("acme").documents.createCollection({ name: "posts" });
  await opened.api.forTenant("acme").documents.insert({ collection: "posts", id: "a", data: { title: "a" } });

  const image = await opened.api.images.create("first");
  assert.ok(image.shards.every((shard) => /^[0-9a-f]{64}$/.test(shard.digest)), "each shard records its digest");
  const clean = await opened.api.images.verify("first");
  assert.equal(clean.ok, true);
  assert.ok(clean.shards.every((shard) => shard.ok));

  // One value changed on disk: the shard holding it fails, by name, and the others still pass.
  const shard = opened.api.shardOf("acme");
  const { DatabaseSync } = await import("node:sqlite");
  const file = new DatabaseSync(join(root, "primary", "images", "first", `${shard}.sqlite`));
  file.prepare("UPDATE kv SET value = X'00' WHERE rowid = (SELECT max(rowid) FROM kv)").run();
  file.close();
  const changed = await opened.api.images.verify("first");
  assert.equal(changed.ok, false);
  assert.deepEqual(changed.shards.filter((entry) => !entry.ok).map((entry) => [entry.shard, entry.problem]), [[shard, "its keys or values differ from what was written"]]);

  await assert.rejects(() => opened.api.images.verify("missing"), /No image is named "missing"/);
  for (const name of ["second", "third", "fourth"]) await opened.api.images.create(name);
  await assert.rejects(() => opened.api.images.prune(0), /never removes every image/);
  const pruned = await opened.api.images.prune(2);
  assert.deepEqual(pruned, { removed: ["first", "second"], kept: ["third", "fourth"] });
  assert.deepEqual((await opened.api.images.list()).map((entry) => entry.name).sort(), ["fourth", "third"]);
  const third = (await opened.api.images.list()).find((entry) => entry.name === "third");
  assert.deepEqual(await opened.api.images.remove("third"), { name: "third", bytes: third.bytes });
  assert.deepEqual((await opened.api.images.list()).map((entry) => entry.name), ["fourth"]);
  await assert.rejects(() => opened.api.images.remove("third"), /No image is named "third"/);
  assert.deepEqual(readdirSync(join(root, "primary", "images")).filter((entry) => entry.startsWith(".")), [], "nothing half-removed is left behind");
});
