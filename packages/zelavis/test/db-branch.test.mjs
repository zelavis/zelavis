// Branching a Tenant: a new Tenant holding a copy of another as of one
// position of its log — records, history, definitions and derived state — that
// goes its own way from there. These tests hold a branch to its source as of
// the branch point while the source keeps taking writes, to cursors and
// checkpoints carrying on across it, to a branch of a branch, a compacted
// source, a branch cut off part way and finished when the database reopens, a
// source moved while it is branched, the outbox it leaves behind or copies, a
// divided Tenant branched part by part, and to what it refuses.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Cause, Deferred, Effect, Exit, Fiber, Stream } from "effect";
import { makeDatabase, partitionMapFor, shardFor } from "../dist/db/index.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { makeNodeSqliteEngine } from "../dist/db/engines/node-sqlite.js";
import { openShardOverKv } from "../dist/db/kv-store.js";
import { StoreError } from "../dist/db/errors.js";

const map = partitionMapFor(["s0", "s1"]);

/** A database over memory engines, with each shard's store at hand and an optional engine in front. */
const withDatabase = (body, { wrap, drainTimeout } = {}) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const shards = new Map();
    const db = yield* makeDatabase({
      partitionMap: map,
      crossTenantRefresh: false,
      ...(drainTimeout === undefined ? {} : { drainTimeout }),
      openShard: (shard) => {
        const engine = memoryKvEngine();
        return Effect.tap(openShardOverKv(shard, wrap === undefined ? engine : wrap(shard, engine)), (store) =>
          Effect.sync(() => shards.set(shard, store)));
      },
    });
    return yield* body(db, shards);
  })));

/** The same over SQLite files in `dir`, so a second open finds what the first left. */
const onDisk = (dir, body, { wrap } = {}) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const shards = new Map();
    const db = yield* makeDatabase({
      partitionMap: map,
      crossTenantRefresh: false,
      openShard: (shard) => Effect.flatMap(makeNodeSqliteEngine(shard, dir), (engine) =>
        Effect.tap(openShardOverKv(shard, wrap === undefined ? engine : wrap(shard, engine)), (store) =>
          Effect.sync(() => shards.set(shard, store)))),
    });
    return yield* body(db, shards);
  })));

/** Fail the `failAt`-th batch written to `shard` (or touching `partition`) while armed. */
const cutting = (armed) => (shard, engine) => ({
  ...engine,
  conditionalWrite: (writes, conditions) => {
    const hit = armed.partition === undefined
      ? armed.target === shard
      : writes.some((write) => Buffer.from(write.key).includes(armed.partition));
    if (hit && (armed.target !== undefined || armed.partition !== undefined)) {
      armed.writes += 1;
      if (armed.writes === armed.failAt) return Effect.fail(new StoreError({ op: "test", cause: "cut off" }));
    }
    return engine.conditionalWrite(writes, conditions);
  },
});

const messageIds = (tenant, after) => Effect.map(tenant.outbox.read({ ...(after === undefined ? {} : { after }), limit: 1000 }),
  (page) => page.messages.map((message) => message.id));

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

test("a branch is refused for the same name, reserved and plugin Tenants, part names, a divided target, an empty source and an occupied target", () =>
  withDatabase((db) => Effect.gen(function* () {
    yield* seedPosts(db.forTenant(across.first), ["p1"]);
    yield* seedPosts(db.forTenant(across.same), ["q1"]);
    yield* db.topology.subdivision.subdivide("whale", ["a", "b"]);
    const reason = (tenant, into) => Effect.map(Effect.flip(db.branchTenant(tenant, into)), (error) => `${error._tag}: ${error.reason}`);
    assert.equal(yield* reason(across.first, across.first), "TenantNotBranchable: a Tenant cannot be branched into itself");
    assert.equal(yield* reason(across.first, "zv.copy"), `TenantNotBranchable: "zv.copy" is reserved`);
    assert.equal(yield* reason("service:shop", across.other), `TenantNotBranchable: "service:shop" belongs to a plugin`);
    assert.equal(yield* reason(across.first, "whale"), `TenantNotBranchable: "whale" is divided into parts and "${across.first}" is not`);
    assert.equal(yield* reason(across.first, "whale#a"), `TenantNotBranchable: "whale#a" names a part; branch the Tenant it belongs to`);
    assert.equal(yield* reason("whale", across.other), `TenantNotBranchable: "whale" holds nothing`);
    assert.equal(
      yield* Effect.map(Effect.flip(db.branchTenant(across.first, across.other, { outbox: "keep" })), (error) => error.reason),
      `outbox must be "leave" or "copy", not "keep"`,
    );
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

test("a branch leaves the source's undelivered outbox messages with it by default, keeps its receipts, and copies the messages when asked", () =>
  withDatabase((db, shards) => Effect.gen(function* () {
    const source = db.forTenant(across.first);
    yield* seedPosts(source, ["p1"]);
    const before = (yield* source.events.read({ limit: 100 })).cursor;
    for (const id of ["m0", "m1", "m2"]) yield* source.outbox.emit({ topic: "mail", payload: { id }, id });
    yield* source.outbox.emit({ topic: "mail", payload: { keyed: true }, idempotencyKey: "k1" });
    yield* source.outbox.remove({ ids: ["m0"] });

    const left = yield* db.branchTenant(across.first, across.other);
    const branch = db.forTenant(across.other);
    assert.deepEqual(yield* messageIds(branch), [], "nothing the source still owes is read from the branch");
    assert.deepEqual(yield* messageIds(branch, before), [], "not even from a source cursor before the branch point");
    assert.deepEqual(yield* messageIds(source), ["m1", "m2", "idempotent:k1"], "the source keeps them to deliver");
    assert.deepEqual(yield* posts(branch), yield* posts(source), "documents are copied all the same");

    const stats = yield* shards.get(db.shardOf(across.other)).partition(across.other).stats;
    assert.ok(stats.head > stats.lineage[0].upTo, "they are retracted in the branch's own log, past the branch point");
    assert.equal(positionOf(left.cursor), stats.head);
    assert.equal(stats.leaving, undefined, "a finished branch keeps no note of what it left");

    // The receipt came along: a replay is the write that already happened, so no message is emitted again.
    const replayed = yield* branch.outbox.emit({ topic: "mail", payload: { keyed: true }, idempotencyKey: "k1" });
    assert.equal(replayed.id, "idempotent:k1");
    yield* branch.outbox.emit({ topic: "mail", payload: { id: "m3" }, id: "m3" });
    assert.deepEqual(yield* messageIds(branch), ["m3"], "only what the branch emits itself is its to deliver");
    yield* shards.get(db.shardOf(across.other)).partition(across.other).rebuildLenses;
    assert.deepEqual(yield* messageIds(branch), ["m3"]);

    yield* db.branchTenant(across.first, across.same, { outbox: "copy" });
    assert.deepEqual(yield* messageIds(db.forTenant(across.same)), ["m1", "m2", "idempotent:k1"], "copied, ids and order kept");
  })));

test("a divided Tenant branches into one divided the same way, part by part, and a part cut off is finished by the same call", () => {
  const armed = { partition: undefined, writes: 0, failAt: 0 };
  return withDatabase((db) => Effect.gen(function* () {
    yield* db.topology.subdivision.subdivide("whale", ["a", "b", "c"]);
    yield* seedPosts(db.forPart("whale", "a"), ["a1"]);
    yield* seedPosts(db.forPart("whale", "b"), ["b1", "b2"]);
    yield* db.forPart("whale", "b").outbox.emit({ topic: "mail", payload: {}, id: "owed" });

    // Part b's copy is cut off after its first batch; part a's is whole by then.
    armed.partition = "orca#b";
    armed.writes = 0;
    armed.failAt = 2;
    assert.ok(Exit.isFailure(yield* Effect.exit(db.branchTenant("whale", "orca"))));
    armed.partition = undefined;
    assert.deepEqual(db.topology.subdivision.partsOf("orca"), ["a", "b", "c"], "the target is divided as the source is");
    assert.equal(squashed(yield* Effect.exit(db.forPart("orca", "b").documents.findMany({ collection: "posts" })))?._tag, "TenantBranching");

    const made = yield* db.branchTenant("whale", "orca");
    assert.deepEqual(made.parts.map((entry) => entry.part), ["b"], "a finished part is not copied again; an empty one has nothing to copy");
    assert.equal(made.shard, undefined);
    assert.equal(made.records, made.parts[0].records);
    for (const part of ["a", "b"]) {
      assert.deepEqual(yield* posts(db.forPart("orca", part)), yield* posts(db.forPart("whale", part)), `part ${part} holds its counterpart's records`);
    }
    assert.deepEqual(yield* messageIds(db.forPart("orca", "b")), [], "each part leaves its outbox behind");
    assert.throws(() => db.forTenant("orca"), (error) => error._tag === "TenantDivided");

    const reason = (tenant, into) => Effect.map(Effect.flip(db.branchTenant(tenant, into)), (error) => error.reason);
    assert.equal(yield* reason("whale", "orca"), `"orca" already holds data`);
    yield* db.topology.subdivision.subdivide("shark", ["x", "y"]);
    assert.equal(yield* reason("whale", "shark"), `"shark" is divided into x, y, not a, b, c`);
    yield* seedPosts(db.forTenant(across.first), ["p1"]);
    assert.equal(yield* reason("whale", across.first), `"${across.first}" already holds data`);
    assert.equal(db.topology.subdivision.partsOf(across.first), undefined, "a refused target is not divided");
  }), { wrap: cutting(armed) });
});

test("the source of a branch can be moved while it is copied: only the branch is leased for the whole copy", () => {
  const pause = { armed: false, reached: undefined, resume: undefined };
  return withDatabase((db) => Effect.gen(function* () {
    const source = db.forTenant(across.first);
    yield* source.documents.createCollection({ name: "posts", columns: ["title", "rank"] });
    for (let batch = 0; batch < 9; batch++) {
      yield* source.documents.write({
        operations: Array.from({ length: 500 }, (_, at) => ({ _tag: "Insert", collection: "posts", id: `p${batch * 500 + at}`, data: { title: `p${batch}`, rank: at } })),
      });
    }
    pause.reached = yield* Deferred.make();
    pause.resume = yield* Deferred.make();
    pause.armed = true;
    const branching = yield* Effect.forkChild(db.branchTenant(across.first, across.other));
    // The branch has written its first batch and stopped there, part way through the source's records.
    yield* Deferred.await(pause.reached);
    const destination = db.shardOf(across.other);
    assert.notEqual(db.shardOf(across.first), destination);
    yield* db.movement.rebalance({ version: 2, virtualRanges: 256, placements: [{ from: 0, to: 256, shard: destination }] });
    assert.equal(db.shardOf(across.first), destination, "the source moved while its branch was being copied");
    yield* Deferred.succeed(pause.resume, undefined);
    const made = yield* Fiber.join(branching);
    assert.equal(made.records > 4096, true, "the copy spans more than one page of the source");
    const held = yield* posts(db.forTenant(across.other));
    assert.equal(Object.keys(held).length, 4500);
    assert.deepEqual(held, yield* posts(source), "the pages read after the move came from where the source went");
  }), {
    drainTimeout: "200 millis",
    wrap: (shard, engine) => ({
      ...engine,
      conditionalWrite: (writes, conditions) => {
        if (!pause.armed || !writes.some((write) => Buffer.from(write.key).includes(across.other))) return engine.conditionalWrite(writes, conditions);
        pause.armed = false;
        return Effect.flatMap(engine.conditionalWrite(writes, conditions), (accepted) =>
          Effect.as(Effect.andThen(Deferred.succeed(pause.reached, undefined), Deferred.await(pause.resume)), accepted));
      },
    }),
  });
});

test("a branch cut off by a crash is finished when the database next opens, leaving behind what it was leaving", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-branch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const armed = { target: undefined, writes: 0, failAt: 0 };
  await onDisk(dir, (db, shards) => Effect.gen(function* () {
    const source = db.forTenant(across.first);
    yield* seedPosts(source, ["p1", "p2"]);
    yield* source.outbox.emit({ topic: "mail", payload: {}, id: "owed" });
    armed.target = db.shardOf(across.other);
    armed.writes = 0;
    armed.failAt = 2;
    assert.ok(Exit.isFailure(yield* Effect.exit(db.branchTenant(across.first, across.other))));
    armed.target = undefined;
    const stats = yield* shards.get(db.shardOf(across.other)).partition(across.other).stats;
    assert.deepEqual([stats.seeding, stats.leaving], [true, ["zv.outbox"]], "the unfinished branch notes what it leaves");
  }), { wrap: cutting(armed) });

  await onDisk(dir, (db, shards) => Effect.gen(function* () {
    const branch = db.forTenant(across.other);
    assert.deepEqual(yield* posts(branch), yield* posts(db.forTenant(across.first)), "finished on open, before any call");
    assert.deepEqual(yield* messageIds(branch), [], "and still left the outbox behind");
    const stats = yield* shards.get(db.shardOf(across.other)).partition(across.other).stats;
    assert.equal(stats.seeding, false);
    assert.equal(stats.leaving, undefined);
  }));
});


test("a divided Tenant is one Tenant in db.tenants, and its parts are partitions", () =>
  withDatabase((db) => Effect.gen(function* () {
    yield* db.topology.subdivision.subdivide("whale", ["a", "b"]);
    yield* seedPosts(db.forPart("whale", "a"), ["a1"]);
    yield* seedPosts(db.forPart("whale", "b"), ["b1"]);
    yield* seedPosts(db.forTenant("plain"), ["p1"]);
    const own = (names) => names.filter((name) => !name.startsWith("zv.")).sort();
    assert.deepEqual(own(yield* db.tenants), ["plain", "whale"]);
    assert.deepEqual(own(yield* db.partitions), ["plain", "whale#a", "whale#b"]);
  })));

test("a branch cut off whose source has since been removed is removed unfinished when the database next opens", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-branch-gone-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const armed = { target: undefined, writes: 0, failAt: 0 };
  await onDisk(dir, (db, shards) => Effect.gen(function* () {
    yield* seedPosts(db.forTenant(across.first), ["p1", "p2"]);
    armed.target = db.shardOf(across.other);
    armed.writes = 0;
    armed.failAt = 2;
    assert.ok(Exit.isFailure(yield* Effect.exit(db.branchTenant(across.first, across.other))));
    armed.target = undefined;
    assert.equal((yield* shards.get(db.shardOf(across.other)).partition(across.other).stats).seeding, true);
    yield* db.dropTenant(across.first);
  }), { wrap: cutting(armed) });

  await onDisk(dir, (db, shards) => Effect.gen(function* () {
    assert.ok(!(yield* db.tenants).includes(across.other), "the unfinished copy is gone, not left refusing for ever");
    assert.ok(!(yield* shards.get(db.shardOf(across.other)).partitions).includes(across.other));
    // The name is free again: a Tenant written to there starts from nothing.
    yield* seedPosts(db.forTenant(across.other), ["fresh"]);
    assert.deepEqual(yield* posts(db.forTenant(across.other)), { fresh: "fresh@1" });
    assert.equal((yield* shards.get(db.shardOf(across.other)).partition(across.other).stats).seeding, false);
  }));
});

test("a branch as of a past cursor or time is the source as it was then, and is refused once the log is compacted", () =>
  withDatabase((db, shards) => Effect.gen(function* () {
    const source = db.forTenant(across.first);
    yield* seedPosts(source, ["p1", "p2"]);
    const then = yield* posts(source);
    const cursor = (yield* source.events.read({ limit: 1000 })).cursor;
    yield* Effect.sleep("5 millis");
    const time = new Date().toISOString();
    yield* Effect.sleep("5 millis");
    yield* source.documents.update({ collection: "posts", id: "p1", data: { title: "changed", rank: 9 } });
    yield* source.documents.delete({ collection: "posts", id: "p2" });
    yield* source.documents.insert({ collection: "posts", id: "p3", data: { title: "p3", rank: 3 } });
    const now = yield* posts(source);

    const window = yield* db.recoveryWindow(across.first);
    assert.equal(window.partitions.length, 1);
    assert.equal(window.partitions[0].earliest, 0, "a log never compacted reaches back to its start");
    assert.ok(window.partitions[0].latest > 0 && window.partitions[0].earliestAt <= window.partitions[0].latestAt);

    const byCursor = yield* db.branchTenant(across.first, "past-cursor", { asOf: cursor });
    assert.equal(byCursor.records, 0, "made from the log, not the present records");
    assert.deepEqual(yield* posts(db.forTenant("past-cursor")), then, "as of the cursor");
    yield* db.branchTenant(across.first, "past-time", { asOfTime: time });
    assert.deepEqual(yield* posts(db.forTenant("past-time")), then, "as of the time");
    assert.deepEqual(yield* posts(source), now, "the source is untouched");
    // The branch is a Tenant of its own, taking writes from its own point on.
    yield* db.forTenant("past-cursor").documents.insert({ collection: "posts", id: "fork", data: { title: "fork", rank: 1 } });
    assert.ok(!Object.keys(yield* posts(source)).includes("fork"));
    // Its lineage accepts the source's cursor only up to the point it was made at.
    assert.equal((yield* db.forTenant("past-cursor").events.read({ after: cursor, limit: 10 })).events.length, 1);

    for (const [options, reason] of [
      [{ asOf: cursor, asOfTime: time }, /not both/],
      [{ asOfTime: "yesterday-ish" }, /not an ISO 8601 time/],
    ]) {
      const refused = yield* Effect.flip(db.branchTenant(across.first, "nope", options));
      assert.equal(refused._tag, "TenantNotBranchable");
      assert.match(refused.reason, reason);
    }
    const store = shards.get(db.shardOf(across.first)).partition(across.first);
    yield* store.compact({ keep: 1 });
    const compacted = yield* Effect.flip(db.branchTenant(across.first, "too-late", { asOf: cursor }));
    assert.match(compacted.reason, /compacted its log/);
    const after = yield* db.recoveryWindow(across.first);
    assert.equal(after.partitions[0].earliest, after.partitions[0].latest, "once compacted, only the present is in reach");
    assert.ok(!(yield* db.tenants).includes("too-late"), "a refused branch leaves nothing behind");
  })));

test("a divided Tenant branches as of a time part by part, and refuses a cursor", () =>
  withDatabase((db) => Effect.gen(function* () {
    yield* db.topology.subdivision.subdivide("whale", ["a", "b"]);
    for (const part of ["a", "b"]) yield* seedPosts(db.forPart("whale", part), [`${part}1`]);
    yield* Effect.sleep("5 millis");
    const time = new Date().toISOString();
    yield* Effect.sleep("5 millis");
    for (const part of ["a", "b"]) yield* db.forPart("whale", part).documents.insert({ collection: "posts", id: `${part}2`, data: { title: "late", rank: 2 } });
    const branched = yield* db.branchTenant("whale", "whale-then", { asOfTime: time });
    assert.deepEqual(branched.parts.map((entry) => entry.part), ["a", "b"]);
    for (const part of ["a", "b"]) assert.deepEqual(Object.keys(yield* posts(db.forPart("whale-then", part))), [`${part}1`]);
    const cursor = (yield* db.forPart("whale", "a").events.read({ limit: 1 })).cursor;
    assert.match((yield* Effect.flip(db.branchTenant("whale", "whale-x", { asOf: cursor }))).reason, /use asOfTime/);
    assert.equal((yield* db.recoveryWindow("whale")).partitions.length, 2);
  })));

test("a branch as of a past position cut off by a crash is finished at open as of the same position", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-branch-asof-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const armed = { target: undefined, writes: 0, failAt: 0 };
  let then;
  await onDisk(dir, (db) => Effect.gen(function* () {
    const source = db.forTenant(across.first);
    yield* seedPosts(source, Array.from({ length: 30 }, (_, n) => `p${n}`));
    then = yield* posts(source);
    const cursor = (yield* source.events.read({ limit: 1000 })).cursor;
    yield* source.documents.insert({ collection: "posts", id: "later", data: { title: "later", rank: 99 } });
    armed.target = db.shardOf(across.other);
    armed.writes = 0;
    armed.failAt = 2;
    assert.ok(Exit.isFailure(yield* Effect.exit(db.branchTenant(across.first, across.other, { asOf: cursor }))));
    armed.target = undefined;
  }), { wrap: cutting(armed) });
  await onDisk(dir, (db, shards) => Effect.gen(function* () {
    assert.deepEqual(yield* posts(db.forTenant(across.other)), then, "finished at open, as of the same position");
    const stats = yield* shards.get(db.shardOf(across.other)).partition(across.other).stats;
    assert.deepEqual([stats.seeding, stats.asOf], [false, undefined]);
  }));
});

test("after compaction a Tenant is still recovered as of any position from its snapshot on", () =>
  withDatabase((db, shards) => Effect.gen(function* () {
    const source = db.forTenant(across.first);
    const store = shards.get(db.shardOf(across.first)).partition(across.first);
    yield* seedPosts(source, ["p1", "p2"]);
    const beforeSnapshot = (yield* source.events.read({ limit: 1000 })).cursor;
    yield* source.documents.update({ collection: "posts", id: "p1", data: { title: "at snapshot", rank: 5 } });
    const { position: snapshotAt } = yield* store.snapshot;
    yield* source.documents.insert({ collection: "posts", id: "p3", data: { title: "after", rank: 6 } });
    const middle = yield* posts(source);
    const middleCursor = (yield* source.events.read({ limit: 1000 })).cursor;
    yield* source.documents.delete({ collection: "posts", id: "p2" });
    const compaction = yield* store.compact({ keep: 0 });
    assert.equal(compaction.compactedTo, snapshotAt, "compaction stops at the snapshot");
    assert.equal(compaction.snapshotAt, snapshotAt);

    const window = yield* db.recoveryWindow(across.first);
    assert.equal(window.partitions[0].earliest, snapshotAt, "the recovery window starts at the snapshot");
    const recovered = yield* db.branchTenant(across.first, "from-snapshot", { asOf: middleCursor });
    assert.ok(recovered.records > 0, "made from the snapshot's records");
    assert.deepEqual(yield* posts(db.forTenant("from-snapshot")), middle, "as of a position after the snapshot");
    const copy = shards.get(db.shardOf("from-snapshot")).partition("from-snapshot");
    yield* copy.rebuildLenses;
    assert.deepEqual(yield* posts(db.forTenant("from-snapshot")), middle, "and it can rebuild its lenses from its own snapshot");
    assert.match((yield* Effect.flip(db.branchTenant(across.first, "too-early", { asOf: beforeSnapshot }))).reason, /recovery window starts later/);
  })));
