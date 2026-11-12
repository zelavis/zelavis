// A restore into an empty or purged tenant gives records back their own
// identifiers: the ones the backup names, edges and all.
//
// Only a live record already holding one of them — a checkpoint, or a record
// from another history than the backup's — sends the restore back to
// remapping, as a merge does; a retired record there only means the restored
// versions start higher. The allocator is moved past every identifier first,
// so nothing written meanwhile or afterwards can be handed one of them.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Stream } from "effect";
import { makeDatabase, partitionMapFor } from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

/** A database in its own directory, with the shard store kept for reading identifiers. */
const openAt = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-restore-ids-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Effect.gen(function* () {
    const stores = new Map();
    const db = yield* makeDatabase({
      partitionMap: partitionMapFor(["s0"]),
      openShard: (shard) => Effect.tap(makeNodeSqliteStore(shard, dir), (store) => Effect.sync(() => stores.set(shard, store))),
    });
    return { tenant: db.forTenant("acme"), partition: () => stores.get("s0").partition("acme") };
  });
};

const run = (body) => Effect.runPromise(Effect.scoped(body));

/** Authors, and posts linked to them by a typed edge. */
const authored = (tenant) => Effect.gen(function* () {
  yield* tenant.documents.createCollection({ name: "authors" });
  yield* tenant.documents.createCollection({
    name: "posts", edges: [{ name: "author", path: "authorId", collection: "authors" }],
  });
  // An author removed again before any backup: a gap in the identifiers, so a
  // restore that renumbered from one could not land on the same ones.
  yield* tenant.documents.insert({ collection: "authors", id: "a0", data: { name: "gone" } });
  for (const id of ["a1", "a2"]) yield* tenant.documents.insert({ collection: "authors", id, data: { name: id } });
  yield* tenant.documents.delete({ collection: "authors", id: "a0" });
  for (const [id, authorId] of [["p1", "a1"], ["p2", "a2"], ["p3", "a1"]]) {
    yield* tenant.documents.insert({ collection: "posts", id, data: { title: id, authorId } });
  }
  yield* tenant.documents.update({ collection: "posts", id: "p1", data: { title: "p1 revised", authorId: "a1" } });
});

/** Every named record's identifier, and the edges its manifest holds. */
const identities = (partition) => Effect.gen(function* () {
  const out = {};
  yield* Stream.runForEach(partition.records, ({ seq, record }) => Effect.sync(() => {
    if (!record.live || record.identity === undefined || !record.identity.namespace.startsWith("doc/")) return;
    out[`${record.identity.namespace}/${record.identity.key}`] = { seq: Number(seq), edges: record.manifest.edges.map(([type, to]) => `${type}->${Number(to)}`) };
  }));
  return out;
});

const titles = (tenant) =>
  Effect.map(tenant.documents.findMany({ collection: "posts" }), (docs) => docs.map((d) => `${d.id}:${d.data.title}:v${d.version}`).sort());

test("an empty tenant gets the backup's own identifiers back, edges included, and later writes go past them", (t) => run(Effect.gen(function* () {
  const source = yield* openAt(t);
  yield* authored(source.tenant);
  const backup = yield* source.tenant.backups.exportTenant;
  const expected = yield* identities(source.partition());

  const target = yield* openAt(t);
  yield* target.tenant.backups.restoreTenant(backup);
  assert.deepEqual(yield* identities(target.partition()), expected);
  assert.deepEqual(yield* titles(target.tenant), yield* titles(source.tenant));

  const highest = Math.max(...Object.values(expected).map((entry) => entry.seq));
  yield* target.tenant.documents.insert({ collection: "posts", id: "p4", data: { title: "after", authorId: "a2" } });
  const after = yield* identities(target.partition());
  assert.ok(after["doc/posts/p4"].seq > highest, "a write after the restore is given an identifier past every restored one");
  assert.deepEqual(yield* titles(target.tenant), [...(yield* titles(source.tenant)), "p4:after:v1"].sort());
})));

test("a purge restore puts the tenant back under the backup's identifiers", (t) => run(Effect.gen(function* () {
  const { tenant, partition } = yield* openAt(t);
  yield* authored(tenant);
  const backup = yield* tenant.backups.exportTenant;
  const expected = yield* identities(partition());

  yield* tenant.documents.delete({ collection: "posts", id: "p2" });
  yield* tenant.documents.insert({ collection: "posts", id: "p9", data: { title: "not in the backup", authorId: "a1" } });
  yield* tenant.documents.update({ collection: "posts", id: "p3", data: { title: "changed", authorId: "a2" } });

  yield* tenant.backups.restoreTenant(backup, { into: "purge" });
  assert.deepEqual(yield* identities(partition()), expected);
  assert.deepEqual(yield* titles(tenant), ["p1:p1 revised:v2", "p2:p2:v1", "p3:p3:v1"]);
})));

test("records deleted since the backup come back under their own identifiers", (t) => run(Effect.gen(function* () {
  const { tenant, partition } = yield* openAt(t);
  yield* authored(tenant);
  const backup = yield* tenant.backups.exportTenant;
  const expected = yield* identities(partition());

  // Emptied, so the default restore accepts it; every identifier is now a
  // retired record whose version outranks the backup's.
  yield* tenant.documents.dropCollection({ name: "posts" });
  yield* tenant.documents.dropCollection({ name: "authors" });
  yield* tenant.backups.restoreTenant(backup);
  assert.deepEqual(yield* identities(partition()), expected);
  assert.deepEqual(yield* titles(tenant), ["p1:p1 revised:v2", "p2:p2:v1", "p3:p3:v1"]);
})));

test("a backup whose identifiers live records hold here is remapped, edges with it", (t) => run(Effect.gen(function* () {
  const source = yield* openAt(t);
  yield* authored(source.tenant);
  const backup = yield* source.tenant.backups.exportTenant;
  const expected = yield* identities(source.partition());

  // Something of another history in the way: a checkpoint, which a backup
  // neither carries nor purges, at the identifier the first post has there.
  const target = yield* openAt(t);
  const occupied = expected["doc/posts/p1"].seq;
  yield* target.partition().transact((txn) => txn.put(occupied, new TextEncoder().encode("{}"),
    { terms: [], columns: [], measures: [], edges: [] }, { namespace: "zv.checkpoint", key: "elsewhere" }));
  yield* target.tenant.backups.restoreTenant(backup);

  const restored = yield* identities(target.partition());
  assert.notEqual(restored["doc/posts/p1"].seq, occupied, "nothing was written over");
  assert.deepEqual(yield* titles(target.tenant), yield* titles(source.tenant));
  // The edges follow the authors to wherever they were put.
  for (const post of ["p1", "p2", "p3"]) {
    const [edge] = restored[`doc/posts/${post}`].edges;
    const author = Object.entries(restored).find(([, entry]) => edge.endsWith(`->${entry.seq}`))?.[0];
    assert.match(author ?? "", /^doc\/authors\/a[12]$/, `${post} still names an author`);
  }
})));

test("a backup naming an identifier that cannot be one is refused before anything is written", (t) => run(Effect.gen(function* () {
  const source = yield* openAt(t);
  yield* authored(source.tenant);
  const backup = yield* source.tenant.backups.exportTenant;
  const target = yield* openAt(t);
  for (const seq of [0, -1, 1.5, 2 ** 48]) {
    const forged = { ...backup, events: backup.events.map((event, i) => (i === 0 ? { ...event, seq } : event)) };
    const refused = yield* Effect.flip(target.tenant.backups.restoreTenant(forged));
    assert.equal(refused._tag, "BackupFormatUnsupported", `identifier ${seq}`);
  }
  assert.deepEqual(yield* identities(target.partition()), {});
})));

test("a time series' state is rebuilt after a restore, not carried into a log it does not describe", (t) => run(Effect.gen(function* () {
  const series = {
    name: "writes",
    source: { collections: ["posts"], eventTypes: ["document.upserted"] },
    map: (event) => ({ timestamp: Date.parse(event.timestamp), value: 1 }),
  };
  const source = yield* openAt(t);
  yield* authored(source.tenant);
  yield* source.tenant.timeSeries.define(series);
  yield* source.tenant.timeSeries.ingest("writes");
  const backup = yield* source.tenant.backups.exportTenant;
  assert.ok(backup.events.every((event) => event.identity?.namespace !== "zv.timeseries.state"));

  const target = yield* openAt(t);
  yield* target.tenant.backups.restoreTenant(backup);
  yield* target.tenant.timeSeries.define(series);
  yield* target.tenant.timeSeries.ingest("writes");
  // One point per post write the restored log holds: the series read it from
  // its own start rather than from a position in the source's log.
  const points = yield* target.tenant.timeSeries.get("writes").range({});
  const restoredPosts = backup.events.filter((event) => event.kind === "put" && event.identity?.namespace === "doc/posts").length;
  assert.equal(points.length, restoredPosts);
})));
