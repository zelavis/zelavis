// A restore into the tenant a backup was taken from writes into that tenant's
// own log: a purge retracts what is there, then the backup's records are put.
// So projections and time series that read the log carry on from where they
// were and end exactly where a rebuild over the whole log ends — nothing they
// derived describes records the restore removed.
//
// A purge also works a page at a time, one transaction per page, rather than
// reading the whole tenant into memory and committing once per record.
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { makeDatabase, partitionMapFor } from "../dist/db/index.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { openShardOverKv } from "../dist/db/kv-store.js";

/** A database on one in-memory shard, counting the commits it makes. */
const withDatabase = (body) => {
  const base = memoryKvEngine();
  const commits = { count: 0 };
  const engine = {
    ...base,
    conditionalWrite: (writes, conditions) => {
      commits.count += 1;
      return base.conditionalWrite(writes, conditions);
    },
  };
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const db = yield* makeDatabase({
      partitionMap: partitionMapFor(["s0"]),
      openShard: (shard) => openShardOverKv(shard, engine),
    });
    return yield* body({ tenant: db.forTenant("acme"), commits });
  })));
};

/**
 * A projection of each post's title, idempotent by event id as the contract
 * asks, with its own state so two of them can be compared.
 */
const titles = (tenant, name) => Effect.gen(function* () {
  const state = new Map();
  const applied = new Set();
  yield* tenant.projections.register({
    name,
    source: { collections: ["posts"] },
    apply: (event) => Effect.sync(() => {
      if (applied.has(event.eventId)) return;
      applied.add(event.eventId);
      if (event.type === "document.deleted") state.delete(event.documentId);
      else if (event.type === "document.upserted") state.set(event.documentId, event.payload.data.title);
    }),
    reset: () => Effect.sync(() => {
      state.clear();
      applied.clear();
    }),
  });
  return () => Object.fromEntries([...state].sort(([a], [b]) => (a < b ? -1 : 1)));
});

const SERIES = {
  name: "writes",
  source: { collections: ["posts"], eventTypes: ["document.upserted"] },
  map: (event) => ({ timestamp: Date.parse(event.timestamp), value: 1, tags: { post: event.documentId } }),
};

const points = (tenant) => Effect.map(tenant.timeSeries.get("writes").range({}), (all) =>
  all.map((point) => `${point.timestamp}:${point.value}:${point.tags.post}`).sort());

const documents = (tenant) => Effect.map(tenant.documents.findMany({ collection: "posts" }), (docs) =>
  Object.fromEntries(docs.map((doc) => [doc.id, doc.data.title]).sort(([a], [b]) => (a < b ? -1 : 1))));

for (const into of ["purge", "merge"]) {
  test(`after a ${into} restore, projections and time series carried on match a rebuild over the whole log`, () =>
    withDatabase(({ tenant }) => Effect.gen(function* () {
      yield* tenant.documents.createCollection({ name: "posts" });
      for (const id of ["p1", "p2", "p3"]) yield* tenant.documents.insert({ collection: "posts", id, data: { title: id } });
      yield* tenant.documents.update({ collection: "posts", id: "p1", data: { title: "p1 revised" } });
      const carried = yield* titles(tenant, "carried");
      yield* tenant.timeSeries.define(SERIES);
      yield* tenant.projections.run("carried");
      yield* tenant.timeSeries.ingest("writes");

      const backup = yield* tenant.backups.exportTenant;

      // Changed after the backup, and consumed, so derived state describes it.
      yield* tenant.documents.insert({ collection: "posts", id: "p9", data: { title: "since" } });
      yield* tenant.documents.delete({ collection: "posts", id: "p2" });
      yield* tenant.documents.update({ collection: "posts", id: "p3", data: { title: "p3 changed" } });
      yield* tenant.projections.run("carried");
      yield* tenant.timeSeries.ingest("writes");

      const result = yield* tenant.backups.restoreTenant(backup, { into });
      yield* tenant.projections.run("carried");
      yield* tenant.timeSeries.ingest("writes");

      const now = yield* documents(tenant);
      assert.deepEqual(now, into === "purge"
        ? { p1: "p1 revised", p2: "p2", p3: "p3" }
        : { p1: "p1 revised", p2: "p2", p3: "p3", p9: "since" });
      assert.deepEqual(carried(), now, "the projection carried across the restore holds what the tenant holds");

      const fresh = yield* titles(tenant, "fresh");
      yield* tenant.projections.run("fresh");
      assert.deepEqual(carried(), fresh(), "and what a projection reading the whole log from the start holds");

      const incremental = yield* points(tenant);
      yield* tenant.timeSeries.rebuild("writes");
      assert.deepEqual(incremental, yield* points(tenant), "the series carried across the restore is the rebuilt one");
      assert.ok(into === "purge" ? result.removed > 0 : result.superseded > 0);
    })));
}

test("a purge retracts a page of records per transaction, never the whole tenant at once or one at a time", () =>
  withDatabase(({ tenant, commits }) => Effect.gen(function* () {
    // Taken before anything is written: a backup with nothing in it, so the
    // restore below commits only what its purge does.
    const empty = yield* tenant.backups.exportTenant;
    assert.equal(empty.events.length, 0);

    yield* tenant.documents.createCollection({ name: "posts" });
    const POSTS = 600;
    for (let at = 0; at < POSTS; at += 100) {
      yield* tenant.documents.write({
        operations: Array.from({ length: 100 }, (_, i) => ({
          _tag: "Insert", collection: "posts", id: `p${at + i}`, data: { title: `post ${at + i}` },
        })),
      });
    }

    commits.count = 0;
    const result = yield* tenant.backups.restoreTenant(empty, { into: "purge" });
    assert.ok(result.removed > POSTS, `every post and the collection went (${result.removed})`);
    assert.equal(commits.count, Math.ceil(result.removed / 256), "one commit per page of 256");
    assert.deepEqual(yield* tenant.documents.listCollections, []);
  })));
