/**
 * The multimodal conformance matrix.
 *
 * One payload, written through either door — the documents API or the
 * key/value API over the same collection — must read back the same through
 * every lens: by id and by key, equality, range and order, full-text, measures,
 * edges, geometry and similarity. And it must keep doing so wherever the data
 * goes: when the lenses are declared after the data (backfill, here by a schema
 * activation), on a follower carried by the log (replication), and in a Tenant
 * restored from a backup. Every answer is checked against an exact model kept
 * beside the writes, on every engine available here.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { documentsFor, keyValueFor, domainEventsFor, levelFollower, makeDatabase, partitionMapFor } from "../dist/db/index.js";
import { makeMemoryStore } from "../dist/db/engines/memory-kv.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";
import { makeLmdbStore } from "../dist/db/engines/lmdb.js";
import { makeRocksdbJsStore } from "../dist/db/engines/rocksdb-js.js";
import { engineAvailable } from "./_engine-available.mjs";

const engines = [
  { name: "memory", open: () => (shard) => makeMemoryStore(shard) },
  { name: "node:sqlite", open: (dir) => (shard) => makeNodeSqliteStore(shard, dir) },
  ...(engineAvailable("lmdb") ? [{ name: "lmdb", open: (dir) => (shard) => makeLmdbStore(shard, dir) }] : []),
  ...(engineAvailable("@harperfast/rocksdb-js") ? [{ name: "rocksdb", open: (dir) => (shard) => makeRocksdbJsStore(shard, dir) }] : []),
];

const fields = [
  { name: "title", field: { _tag: "TextField", label: "Title", required: true } },
  { name: "color", field: { _tag: "SelectField", label: "Color", required: true, options: ["red", "blue", "green"] } },
  { name: "price", field: { _tag: "NumberField", label: "Price", required: true } },
  { name: "owner", field: { _tag: "ReferenceField", label: "Owner", required: false, collection: "people" } },
  { name: "where", field: { _tag: "GeometryField", label: "Where", required: false, coordinates: "wgs84", resolution: 7 } },
  { name: "embedding", field: { _tag: "VectorField", label: "Embedding", required: false, model: "test", modelVersion: "1", dimension: 3, metric: "euclidean" } },
];

const item = (n) => ({
  title: `${n % 3 === 0 ? "alpha" : "beta"} widget number${n}`,
  color: ["red", "blue", "green"][n % 3],
  price: n * 5,
  owner: { collection: "people", id: n % 2 === 0 ? "ann" : "bob" },
  where: { type: "Point", coordinates: [13.4 + n * 0.001, 52.5] },
  embedding: [n, n % 4, 1],
});

/**
 * Writes alternating between the two doors, then changes and removals through
 * each, recording what every item should be. Returns the model.
 */
const writeMixed = (tenant, from, to, model) => Effect.gen(function* () {
  const kv = tenant.kv.namespace("items");
  for (let n = from; n < to; n++) {
    const id = `i${n}`;
    if (n % 2 === 0) yield* tenant.documents.insert({ collection: "items", id, data: item(n) });
    else yield* kv.set(id, item(n));
    model.set(id, item(n));
  }
  // A change through the other door than the one that wrote it, and a removal through each.
  const changed = { ...item(from), price: 999, title: "alpha renamed" };
  yield* kv.set(`i${from}`, changed);
  model.set(`i${from}`, changed);
  const second = { ...item(from + 1), color: "red" };
  yield* tenant.documents.update({ collection: "items", id: `i${from + 1}`, data: second, mode: "replace" });
  model.set(`i${from + 1}`, second);
  yield* tenant.documents.delete({ collection: "items", id: `i${from + 2}` });
  model.delete(`i${from + 2}`);
  yield* kv.remove(`i${from + 3}`);
  model.delete(`i${from + 3}`);
});

const ids = (docs) => docs.map((doc) => doc.id).sort();
const expectIds = (model, keep) => [...model].filter(([, value]) => keep(value)).map(([id]) => id).sort();
const distance = (a, b) => Math.hypot(...a.map((x, i) => x - b[i]));
const metres = ([lon1, lat1], [lon2, lat2]) => {
  const rad = Math.PI / 180, dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(h));
};

/** Every lens, read and compared with the model. `where` names the copy being checked. */
const assertLenses = (where, documents, kv, model) => Effect.gen(function* () {
  // By id, and by key: the same payload through both doors.
  for (const [id, value] of model) {
    const doc = yield* documents.findById({ collection: "items", id });
    assert.deepEqual(doc?.data, value, `${where}: document ${id}`);
    assert.deepEqual((yield* kv.get(id))?.value, value, `${where}: key ${id}`);
  }
  assert.equal(yield* documents.count({ collection: "items" }), model.size, `${where}: count`);
  // Columns: equality.
  assert.deepEqual(ids(yield* documents.findMany({ collection: "items", where: [{ path: "color", value: "red" }] })),
    expectIds(model, (v) => v.color === "red"), `${where}: equality`);
  // Ordered lens: a range in order.
  const ranged = yield* documents.findMany({
    collection: "items", where: [{ path: "price", op: "gte", value: 50 }], orderBy: [{ path: "price", direction: "desc" }],
  });
  const expectedRange = [...model].filter(([, v]) => v.price >= 50).sort(([a, x], [b, y]) => y.price - x.price || (a < b ? -1 : 1)).map(([id]) => id);
  assert.deepEqual(ranged.map((doc) => doc.price ?? doc.data.price), expectedRange.map((id) => model.get(id).price), `${where}: range order`);
  // Terms: full-text.
  assert.deepEqual(ids(yield* documents.findMany({ collection: "items", search: "alpha" })),
    expectIds(model, (v) => v.title.split(/\W+/).includes("alpha")), `${where}: search`);
  // Measures.
  const sum = yield* documents.summarize({ collection: "items", measure: "price", op: "sum" });
  assert.equal(sum.value, [...model.values()].reduce((total, v) => total + v.price, 0), `${where}: measure sum`);
  const redSum = yield* documents.summarize({ collection: "items", measure: "price", op: "sum", where: [{ path: "color", value: "red" }] });
  assert.equal(redSum.value, [...model.values()].filter((v) => v.color === "red").reduce((t, v) => t + v.price, 0), `${where}: filtered measure`);
  // Edges: who links to ann.
  const owned = yield* documents.findMany({ collection: "items", linked: { id: "ann", edge: "owner", direction: "inbound", collection: "items" } });
  assert.deepEqual(ids(owned), expectIds(model, (v) => v.owner?.id === "ann"), `${where}: edges`);
  // Geometry: within a radius, decided exactly.
  const centre = [13.405, 52.5];
  const near = yield* documents.findMany({ collection: "items", geometry: { field: "where", near: centre, radius: 300 } });
  assert.deepEqual(ids(near), expectIds(model, (v) => metres(v.where.coordinates, centre) <= 300), `${where}: geometry`);
  // Similarity: the exact nearest three.
  const probe = [4, 1, 1];
  const similar = yield* documents.findMany({ collection: "items", similar: { field: "embedding", vector: probe, k: 3, approximate: false } });
  const nearest = [...model].sort(([a, x], [b, y]) => distance(x.embedding, probe) - distance(y.embedding, probe) || (a < b ? -1 : 1)).slice(0, 3);
  assert.deepEqual(similar.map((doc) => distance(doc.data.embedding, probe)), nearest.map(([, v]) => distance(v.embedding, probe)), `${where}: similarity`);
  // KV scan sees exactly the live keys.
  const keys = [];
  let cursor;
  do {
    const page = yield* kv.scan({ limit: 4, ...(cursor === undefined ? {} : { after: cursor }) });
    keys.push(...page.entries.map((entry) => entry.key));
    cursor = page.next;
  } while (cursor !== undefined);
  assert.deepEqual(keys.sort(), [...model.keys()].sort(), `${where}: kv scan`);
});

/** The log as one read, and as pages continued by cursor: the same events, in the same order. */
const assertEventContinuity = (where, events, writes) => Effect.gen(function* () {
  const whole = yield* events.read({ collection: "items", limit: 1000 });
  // Every write is a document event, and so is every document the backfill
  // re-derived: that is a new record version carrying the new postings, which
  // is what lets a follower replay them. Nothing is logged twice.
  const documentEvents = whole.events.filter((event) => event.type.startsWith("document."));
  assert.equal(documentEvents.length, writes, `${where}: one event per write and per re-derived document`);
  assert.equal(new Set(whole.events.map((event) => event.eventId)).size, whole.events.length, `${where}: no event twice`);
  const paged = [];
  let after;
  for (;;) {
    const page = yield* events.read({ collection: "items", limit: 3, ...(after === undefined ? {} : { after }) });
    paged.push(...page.events);
    after = page.cursor;
    if (!page.more && page.events.length === 0) break;
    if (!page.more) { const tail = yield* events.read({ collection: "items", after, limit: 3 }); paged.push(...tail.events); break; }
  }
  assert.deepEqual(paged.map((event) => event.eventId), whole.events.map((event) => event.eventId), `${where}: paged = whole`);
});

for (const engine of engines) {
  test(`multimodal conformance on ${engine.name}: both doors, every lens, backfill, events, replication, backup`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "zv-conformance-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const opened = new Map();
    const openShard = engine.open(dir);
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const db = yield* makeDatabase({
        partitionMap: partitionMapFor(["s0"]),
        openShard: (shard) => Effect.tap(openShard(shard), (store) => Effect.sync(() => opened.set(shard, store))),
      });
      const acme = db.forTenant("acme");
      yield* acme.documents.createCollection({ name: "people" });
      for (const id of ["ann", "bob"]) yield* acme.documents.insert({ collection: "people", id, data: { name: id } });
      yield* acme.documents.createCollection({ name: "items" });
      const model = new Map();

      // Data first, lenses after: the schema's activation backfills them.
      yield* writeMixed(acme, 0, 12, model);
      const activated = yield* acme.schemas.save({ collection: "items", version: 1, fields });
      assert.equal(activated.activation.documents, model.size);
      assert.deepEqual(activated.activation.skipped, [], "every field here states what it is");
      yield* assertLenses("backfilled", acme.documents, acme.kv.namespace("items"), model);

      // Lenses first, data after: written under the declarations.
      yield* writeMixed(acme, 12, 24, model);
      yield* assertLenses("primary", acme.documents, acme.kv.namespace("items"), model);
      // 24 writes, 2 changes and 2 removals per round.
      const logged = 2 * (12 + 4) + activated.activation.documents;
      yield* assertEventContinuity("primary", acme.events, logged);

      // Replication: a follower carried by the log reads the same through every lens.
      const leader = opened.get(db.shardOf("acme")).partition("acme");
      const replicaShard = yield* makeMemoryStore("replica");
      yield* levelFollower(leader, { shard: replicaShard, partition: "acme" });
      const replica = replicaShard.partition("acme");
      const replicaDocuments = documentsFor(replica, "acme");
      const replicaEvents = domainEventsFor(replica, "acme");
      yield* assertLenses("replica", replicaDocuments, keyValueFor(replica, "acme", replicaDocuments, replicaEvents).namespace("items"), model);
      yield* assertEventContinuity("replica", replicaEvents, logged);
      // And keeps doing so as the leader moves on.
      yield* writeMixed(acme, 24, 30, model);
      const pass = yield* levelFollower(leader, { shard: replicaShard, partition: "acme" });
      assert.equal(pass.seeded, 0, "carried on from its head, not copied again");
      yield* assertLenses("replica, carried on", replicaDocuments, keyValueFor(replica, "acme", replicaDocuments, replicaEvents).namespace("items"), model);

      // Backup and restore into another Tenant: the same answers again.
      const backup = yield* acme.backups.exportTenant;
      const restored = db.forTenant("acme-restored");
      yield* restored.backups.restoreTenant({ ...backup, tenantId: "acme-restored" });
      yield* assertLenses("restored", restored.documents, restored.kv.namespace("items"), model);
    })));
  });
}
