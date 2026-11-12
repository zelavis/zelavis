import { Effect } from "effect";
import { makeDatabase, partitionMapFor } from "../dist/db/index.js";
import { openShardOverKv } from "../dist/db/kv-store.js";

/**
 * A Tenant with every kind of data the listed reads touch (documents, references, edges, measures, text,
 * vectors, events, an outbox, an aggregate and a replicated collection), on engines the caller provides.
 * Returns the database, the engines by shard and one example input for every listed read.
 */
export const buildReadsFixture = (engineFor) => Effect.gen(function* () {
  const engines = new Map();
  const db = yield* makeDatabase({ partitionMap: partitionMapFor(["s0", "s1"]), openShard: (shard) => Effect.gen(function* () {
    if (!engines.has(shard)) engines.set(shard, yield* engineFor(shard));
    return yield* openShardOverKv(shard, engines.get(shard));
  }) });
  const tenant = db.forTenant("t"), docs = tenant.documents;
  yield* docs.createCollection({ name: "people" });
  yield* docs.insert({ collection: "people", id: "p", data: { name: "Ann" } });
  yield* docs.createCollection({ name: "notes", columns: ["category", "authorId"], analyzer: { fields: ["title"], version: 1 },
    embedding: { field: "vec", dimension: 2, metric: "cosine", version: 1 },
    references: [{ name: "author", path: "authorId", collection: "people" }],
    edges: [{ name: "wrote", path: "authorId", collection: "people" }],
    measures: [{ name: "x", path: "x" }, { name: "y", path: "y" }] });
  yield* docs.write({ operations: [
    { _tag: "Insert", collection: "notes", id: "n1", data: { title: "alpha", category: "a", authorId: "p", x: 1, y: 2, vec: [1, 0] } },
    { _tag: "Insert", collection: "notes", id: "n2", data: { title: "beta", category: "b", authorId: "p", x: 2, y: 4, vec: [0, 1] } },
  ], emit: [{ id: "m1", topic: "notes", payload: {} }, { id: "m2", topic: "notes", payload: {} }] });
  yield* tenant.aggregates.define({ name: "total", collection: "notes", operations: [{ name: "sum", op: "sum", measure: "x" }] });
  yield* tenant.aggregates.refresh("total");
  yield* db.topology.placement.declare("plans", "replicated");
  yield* db.global.documents.createCollection({ name: "plans" });
  yield* db.global.documents.insert({ collection: "plans", id: "pro", data: { seats: 25 } });
  yield* db.replication.refresh;
  return { db, tenant, docs, engines };
});

/** One example input for every listed read, and inputs that make some of them fail; both given the Tenant's documents. */
export const readInputs = (rows) => ({
  inputs: {
    "documents.count": { collection: "notes" }, "documents.modalities": { collection: "notes" },
    "documents.listCollections": null, "documents.collectionExists": "notes",
    "documents.findById": { collection: "notes", id: "n1" }, "documents.findMany": { collection: "notes" },
    "documents.searchStatistics": { collection: "notes", search: "alpha" }, "documents.findPage": { collection: "notes" },
    "documents.withRelated": { collection: "notes", documents: rows }, "documents.traverse": { collection: "notes", id: "n1", edge: "wrote" },
    "documents.summarize": { collection: "notes", measure: "x", op: "sum" }, "documents.covariance": { collection: "notes", measure: "x", with: "y" },
    "documents.histogram": { collection: "notes", measure: "x", boundaries: [0, 2, 4] },
    "documents.summarizeBy": { collection: "notes", measure: "x", op: "sum", groupBy: "category" },
    "shared.listCollections": null, "shared.collectionExists": "plans", "shared.findById": { collection: "plans", id: "pro" },
    "shared.findMany": { collection: "plans" }, "shared.findPage": { collection: "plans" },
    "events.read": {}, "aggregates.list": null, "aggregates.get": "total", "outbox.read": {},
  },
  failures: { "documents.modalities": [{ collection: "missing" }], "documents.traverse": [{ collection: "notes", id: "n1", edge: "missing" }], "documents.withRelated": [{ collection: "notes", documents: rows, references: ["missing"] }], "documents.summarize": [{ collection: "notes", measure: "missing", op: "sum" }], "documents.covariance": [{ collection: "notes", measure: "x", with: "missing" }], "documents.summarizeBy": [{ collection: "notes", measure: "x", op: "sum", groupBy: "category", groups: 0 }], "documents.histogram": [{ collection: "notes", measure: "x", bins: 0 }], "documents.findMany": [ { collection: "notes", where: [{ path: "unknown", value: 1 }] }, { collection: "notes", related: [{ reference: "missing" }] } ], "documents.findPage": [{ collection: "notes", limit: 0 }, { collection: "notes", related: [{ reference: "missing" }] }], "shared.findMany": [{ collection: "plans", related: [{ reference: "missing" }] }], "shared.findPage": [{ collection: "plans", limit: 0 }], "aggregates.get": ["missing"] },
});
