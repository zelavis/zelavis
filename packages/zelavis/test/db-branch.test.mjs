// Branching a Tenant: a new Tenant holding a copy of another as of one
// position of its log — records, history, definitions and derived state — that
// goes its own way from there. These tests hold a branch to its source as of
// the branch point while the source keeps taking writes, to cursors and
// checkpoints carrying on across it, to a branch of a branch, a compacted
// source, a branch cut off part way, and to what it refuses.
import assert from "node:assert/strict";
import test from "node:test";
import { Cause, Effect, Exit, Fiber, Stream } from "effect";
import { makeDatabase, partitionMapFor, shardFor } from "../dist/db/index.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { openShardOverKv } from "../dist/db/kv-store.js";
import { StoreError } from "../dist/db/errors.js";

const map = partitionMapFor(["s0", "s1"]);

/** A database over memory engines, with each shard's store at hand and an optional engine in front. */
const withDatabase = (body, { wrap } = {}) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const shards = new Map();
    const db = yield* makeDatabase({
      partitionMap: map,
      crossTenantRefresh: false,
      openShard: (shard) => {
        const engine = memoryKvEngine();
        return Effect.tap(openShardOverKv(shard, wrap === undefined ? engine : wrap(shard, engine)), (store) =>
          Effect.sync(() => shards.set(shard, store)));
      },
    });
    return yield* body(db, shards);
  })));

/** Two Tenant names on different shards, so a branch crosses shards; and two sharing one. */
const across = (() => {
  const names = Array.from({ length: 64 }, (_, at) => `t${at}`);
  const first = names[0];
  const other = names.find((name) => shardFor(map, name) !== shardFor(map, first));
  const same = names.find((name) => name !== first && shardFor(map, name) === shardFor(map, first));
  return { first, other, same };
})();

const posts = (tenant) => Effect.map(tenant.documents.findMany({ collection: "posts" }), (docs) =>
  Object.fromEntries(docs.map((doc) => [doc.id, `${doc.data.title}@${doc.version}`]).sort(([a], [b]) => (a < b ? -1 : 1))));

const seedPosts = (tenant, ids) => Effect.gen(function* () {
  yield* tenant.documents.createCollection({ name: "posts", columns: ["title", "rank"] });
  for (const [at, id] of ids.entries()) yield* tenant.documents.insert({ collection: "posts", id, data: { title: id, rank: at } });
});

/** The position a cursor names, read the way the store writes it. */
const positionOf = (cursor) => {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  return Number(raw.slice(raw.lastIndexOf("|") + 1));
};

const squashed = (exit) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined);

for (const [label, into] of [["on another shard", across.other], ["on the same shard", across.same]]) {
  test(`a branch ${label} holds the source's documents, queries, versions and history, and then goes its own way`, () =>
    withDatabase((db, shards) => Effect.gen(function* () {
      const source = db.forTenant(across.first);
      yield* seedPosts(source, ["p1", "p2", "p3"]);
      yield* source.documents.update({ collection: "posts", id: "p1", data: { title: "p1 revised", rank: 0 } });
      yield* source.documents.delete({ collection: "posts", id: "p2" });
      const before = yield* posts(source);

      const made = yield* db.branchTenant(across.first, into);
      assert.equal(made.tenant, across.first);
      assert.equal(made.into, into);
      assert.equal(made.shard, db.shardOf(into));
      assert.ok(made.cursor !== undefined);

      const branch = db.forTenant(into);
      assert.deepEqual(yield* posts(branch), before, "the same documents at the same versions");
      const ranked = yield* branch.documents.findMany({ collection: "posts", where: [{ path: "rank", op: "gte", value: 1 }], orderBy: [{ path: "rank" }] });
      assert.deepEqual(ranked.map((doc) => doc.id), ["p3"], "a declared column is queried in the branch as in the source");
      assert.deepEqual(
        (yield* branch.events.read({ limit: 100 })).events.map((event) => [event.type, event.documentId, event.revision]),
        (yield* source.events.read({ limit: 100 })).events.map((event) => [event.type, event.documentId, event.revision]),
        "the branch's history is the source's",
      );

      yield* source.documents.insert({ collection: "posts", id: "s-only", data: { title: "s", rank: 9 } });
      yield* branch.documents.insert({ collection: "posts", id: "b-only", data: { title: "b", rank: 9 } });
      assert.ok(!("b-only" in (yield* posts(source))), "a write to the branch never reaches the source");
      assert.ok(!("s-only" in (yield* posts(branch))), "a write to the source never reaches the branch");

      const stats = yield* shards.get(db.shardOf(into)).partition(into).stats;
      const sourceStats = yield* shards.get(db.shardOf(across.first)).partition(across.first).stats;
      assert.notEqual(stats.incarnation, sourceStats.incarnation, "a branch is a new life of its own");
      assert.equal(stats.seeding, false);
      assert.deepEqual(stats.lineage, [{ partition: across.first, upTo: positionOf(made.cursor) }]);
      assert.deepEqual((yield* db.tenants).filter((tenant) => tenant === into), [into]);
    })));
}

test("a branch taken while the source keeps taking writes is the source as of one position, and its records match its log", () =>
  withDatabase((db, shards) => Effect.gen(function* () {
    const source = db.forTenant(across.first);
    yield* seedPosts(source, Array.from({ length: 300 }, (_, at) => `p${at}`));
    const writer = yield* Effect.forkChild(Effect.gen(function* () {
      for (let at = 0; at < 300; at++) {
        yield* source.documents.update({ collection: "posts", id: `p${at % 50}`, data: { title: `w${at}`, rank: at } });
        yield* source.documents.insert({ collection: "posts", id: `n${at}`, data: { title: `n${at}`, rank: at } });
        yield* Effect.yieldNow;
      }
    }));
    const made = yield* db.branchTenant(across.first, across.other);
    yield* Fiber.join(writer);
    const through = positionOf(made.cursor);

    // The source as of `through`: its log replayed up to there, each document's version.
    const sourceStore = shards.get(db.shardOf(across.first)).partition(across.first);
    const expected = new Map();
    let after;
    for (;;) {
      const batch = [...(yield* Stream.runCollect(sourceStore.events.read({ ...(after ? { after } : {}), limit: 500 })))];
      const upTo = batch.filter((event) => positionOf(event.cursor) <= through);
      for (const event of upTo) {
        if (event.identity?.namespace !== "doc/posts") continue;
        if (event._tag === "ObjectPut") expected.set(event.identity.key, event.version);
        else expected.delete(event.identity.key);
      }
      if (upTo.length < batch.length || batch.length < 500) break;
      after = batch[batch.length - 1].cursor;
    }
    const versions = Object.fromEntries((yield* db.forTenant(across.other).documents.findMany({ collection: "posts", limit: 10000 }))
      .map((doc) => [doc.id, doc.version]));
    assert.deepEqual(versions, Object.fromEntries(expected), "every document at the version the source held at the branch point");
    assert.ok(through < (yield* sourceStore.stats).head, "the source wrote on past the branch point meanwhile");

    const branchStore = shards.get(db.shardOf(across.other)).partition(across.other);
    const held = yield* posts(db.forTenant(across.other));
    assert.equal((yield* branchStore.stats).head, through, "the branch's log ends at the branch point");
    yield* branchStore.rebuildLenses;
    assert.deepEqual(yield* posts(db.forTenant(across.other)), held, "every lens rebuilt from the branch's own log says the same");
  })));

test("a cursor, a projection checkpoint and a time series from before the branch point carry on in the branch", () =>
  withDatabase((db) => Effect.gen(function* () {
    const source = db.forTenant(across.first);
    yield* seedPosts(source, ["p1", "p2"]);
    // Definitions carry functions, so each process registers them on each Tenant; the state they built is data.
    const series = (tenant) => tenant.timeSeries.define({
      name: "writes",
      source: { collections: ["posts"], eventTypes: ["document.upserted"] },
      map: (event) => ({ timestamp: Date.parse(event.timestamp), value: 1, tags: { post: event.documentId } }),
    });
    yield* series(source);
    const counted = (tenant) => tenant.projections.register({ name: "count", source: { collections: ["posts"] }, apply: () => Effect.void });
    yield* counted(source);
    assert.ok((yield* source.projections.run("count")).applied > 0);
    yield* source.timeSeries.ingest("writes");
    const page = yield* source.events.read({ limit: 100 });

    yield* db.branchTenant(across.first, across.other);
    yield* source.documents.insert({ collection: "posts", id: "later", data: { title: "later", rank: 5 } });
    const sourceLater = yield* source.events.read({ after: page.cursor, limit: 100 });

    const branch = db.forTenant(across.other);
    assert.deepEqual((yield* branch.events.read({ after: page.cursor, limit: 100 })).events, [], "the source's cursor names the same place here");
    const foreign = yield* Effect.exit(branch.events.read({ after: sourceLater.cursor, limit: 100 }));
    assert.equal(squashed(foreign)?._tag, "ForeignCursor", "past the branch point the source's cursor is another history");

    yield* counted(branch);
    assert.equal((yield* branch.projections.run("count")).applied, 0, "the checkpoint carried over: nothing applied twice");
    yield* branch.documents.insert({ collection: "posts", id: "p3", data: { title: "p3", rank: 2 } });
    assert.equal((yield* branch.projections.run("count")).applied, 1);

    yield* series(branch);
    assert.equal((yield* branch.timeSeries.ingest("writes")).points, 1, "the series carried on: only the new write is a new point");
    const carried = (yield* branch.timeSeries.get("writes").range({})).map((point) => point.tags.post).sort();
    assert.deepEqual(carried, ["p1", "p2", "p3"]);
    yield* branch.timeSeries.rebuild("writes");
    assert.deepEqual((yield* branch.timeSeries.get("writes").range({})).map((point) => point.tags.post).sort(), carried,
      "what the series carried on to is what a rebuild over the branch's log gives");
  })));

test("a branch of a branch knows both ancestors, and a cursor of the first carries on in the last", () =>
  withDatabase((db, shards) => Effect.gen(function* () {
    const source = db.forTenant(across.first);
    yield* seedPosts(source, ["p1"]);
    const early = (yield* source.events.read({ limit: 100 })).cursor;
    const first = yield* db.branchTenant(across.first, across.other);
    yield* db.forTenant(across.other).documents.insert({ collection: "posts", id: "p2", data: { title: "p2", rank: 1 } });
    const second = yield* db.branchTenant(across.other, across.same);

    assert.deepEqual(yield* posts(db.forTenant(across.same)), yield* posts(db.forTenant(across.other)));
    const stats = yield* shards.get(db.shardOf(across.same)).partition(across.same).stats;
    assert.deepEqual(stats.lineage, [
      { partition: across.other, upTo: positionOf(second.cursor) },
      { partition: across.first, upTo: positionOf(first.cursor) },
    ]);
    const after = yield* db.forTenant(across.same).events.read({ after: early, limit: 100 });
    assert.deepEqual(after.events.map((event) => event.documentId), ["p2"]);
  })));

test("a source that has compacted its log branches into one whose lenses still rebuild", () =>
  withDatabase((db, shards) => Effect.gen(function* () {
    const source = db.forTenant(across.first);
    yield* seedPosts(source, ["p1", "p2", "p3"]);
    yield* source.documents.update({ collection: "posts", id: "p1", data: { title: "again", rank: 0 } });
    const sourceStore = shards.get(db.shardOf(across.first)).partition(across.first);
    const { compactedTo } = yield* sourceStore.compact({ keep: 1 });
    assert.ok(compactedTo > 0);
    yield* source.documents.insert({ collection: "posts", id: "p4", data: { title: "p4", rank: 3 } });

    yield* db.branchTenant(across.first, across.other);
    const branchStore = shards.get(db.shardOf(across.other)).partition(across.other);
    assert.equal((yield* branchStore.stats).compactedTo, compactedTo);
    const held = yield* posts(db.forTenant(across.other));
    assert.deepEqual(held, yield* posts(source));
    yield* branchStore.rebuildLenses;
    assert.deepEqual(yield* posts(db.forTenant(across.other)), held);
  })));

test("a branch cut off part way refuses every read and write until the same branch is run again", () => {
  const armed = { target: undefined, writes: 0, failAt: 0 };
  return withDatabase((db) => Effect.gen(function* () {
    const source = db.forTenant(across.first);
    yield* seedPosts(source, ["p1", "p2"]);
    armed.target = db.shardOf(across.other);
    // The records go in the first batch; the second follows the source's log.
    armed.writes = 0;
    armed.failAt = 2;
    const cut = yield* Effect.exit(db.branchTenant(across.first, across.other));
    assert.ok(Exit.isFailure(cut));
    armed.target = undefined;

    const branch = db.forTenant(across.other);
    assert.equal(squashed(yield* Effect.exit(branch.documents.findMany({ collection: "posts" })))?._tag, "TenantBranching");
    assert.equal(squashed(yield* Effect.exit(branch.documents.insert({ collection: "posts", id: "x", data: { title: "x", rank: 1 } })))?._tag, "TenantBranching");

    yield* db.branchTenant(across.first, across.other);
    assert.deepEqual(yield* posts(branch), yield* posts(source));
  }), {
    wrap: (shard, engine) => ({
      ...engine,
      conditionalWrite: (writes, conditions) => {
        if (armed.target === shard) {
          armed.writes += 1;
          if (armed.writes === armed.failAt) return Effect.fail(new StoreError({ op: "test", cause: "cut off" }));
        }
        return engine.conditionalWrite(writes, conditions);
      },
    }),
  });
});

test("a branch is refused for the same name, reserved and plugin Tenants, divided ones, an empty source and an occupied target", () =>
  withDatabase((db) => Effect.gen(function* () {
    yield* seedPosts(db.forTenant(across.first), ["p1"]);
    yield* seedPosts(db.forTenant(across.same), ["q1"]);
    yield* db.topology.subdivision.subdivide("whale", ["a", "b"]);
    const reason = (tenant, into) => Effect.map(Effect.flip(db.branchTenant(tenant, into)), (error) => `${error._tag}: ${error.reason}`);
    assert.equal(yield* reason(across.first, across.first), "TenantNotBranchable: a Tenant cannot be branched into itself");
    assert.equal(yield* reason(across.first, "zv.copy"), `TenantNotBranchable: "zv.copy" is reserved`);
    assert.equal(yield* reason("service:shop", across.other), `TenantNotBranchable: "service:shop" belongs to a plugin`);
    assert.equal(yield* reason(across.first, "whale"), `TenantNotBranchable: "whale" is divided into parts`);
    assert.equal(yield* reason("nobody", across.other), `TenantNotBranchable: "nobody" holds nothing`);
    assert.equal(yield* reason(across.first, across.same), `TenantNotBranchable: "${across.same}" already holds data`);
    assert.deepEqual(yield* posts(db.forTenant(across.same)), { q1: "q1@1" }, "a refused branch leaves the target as it was");
  })));

test("a cross-Tenant index picks the branch up as a Tenant of its own", () =>
  withDatabase((db) => Effect.gen(function* () {
    yield* seedPosts(db.forTenant(across.first), ["p1", "p2"]);
    yield* db.crossTenantIndexes.define({ name: "posts", collection: "posts", columns: ["title"] });
    yield* db.crossTenantIndexes.refresh();
    yield* db.branchTenant(across.first, across.other);
    yield* db.crossTenantIndexes.refresh();
    const found = yield* db.crossTenantIndexes.query({ index: "posts", where: [{ path: "title", value: "p1" }] });
    assert.deepEqual(found.matches.map((match) => match.tenant).sort(), [across.first, across.other].sort());
  })));
