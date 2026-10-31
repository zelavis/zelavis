// A Tenant read out as a stream: records and the log after them, in pages, consistent once the log has
// been followed past where the records were read. These tests hold the stream to the Tenant as of its
// last event while writes carry on between pages, a compaction between pages, a cursor that is not the
// Tenant's, a Tenant removed and written again, and a divided Tenant exported part by part.
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
import { isDerivedNamespace } from "../dist/db/tenancy.js";

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


const names = Array.from({ length: 64 }, (_, at) => `t${at}`);
const first = names[0];

const seedPosts = (tenant, ids) => Effect.gen(function* () {
  yield* tenant.documents.createCollection({ name: "posts", columns: ["title", "rank"] });
  for (const [at, id] of ids.entries()) yield* tenant.documents.insert({ collection: "posts", id, data: { title: id, rank: at } });
});

/** Apply entries the way a restore does, by version: a map of identifier to the version held, `null` once retracted. */
const applyAll = (held, entries) => {
  for (const entry of entries) {
    const key = entry.part === undefined ? String(entry.seq) : `${entry.part}:${entry.seq}`;
    const had = held.get(key);
    if (had !== undefined && had.version >= entry.version) continue;
    held.set(key, { version: entry.version, live: entry.kind === "put" });
  }
};
const liveOf = (held) => [...held.entries()].filter(([, value]) => value.live).map(([key, value]) => `${key}@${value.version}`).sort();

/** What a partition really holds: carried records and their versions. */
const actual = (store, part) => Effect.gen(function* () {
  const rows = [];
  let after;
  for (;;) {
    const page = yield* store.scanRecords({ ...(after === undefined ? {} : { after }), limit: 100 });
    for (const { seq, record } of page) {
      if (record.live && record.identity !== undefined && !isDerivedNamespace(record.identity.namespace)) rows.push(`${part === undefined ? "" : `${part}:`}${seq}@${record.version}`);
    }
    if (page.length < 100) break;
    after = page[page.length - 1].seq;
  }
  return rows.sort();
});

test("an export in small pages, with writes and a compaction between them, ends as the Tenant", () =>
  withDatabase((db, shards) => Effect.gen(function* () {
    const tenant = db.forTenant(first);
    yield* seedPosts(tenant, Array.from({ length: 12 }, (_, at) => `p${at}`));
    const store = shards.get(db.shardOf(first)).partition(first);
    const held = new Map();
    let cursor;
    let pages = 0;
    let consistentSeen = false;
    while (!consistentSeen) {
      const page = yield* db.exportPage(first, { ...(cursor === undefined ? {} : { cursor }), limit: 3 });
      applyAll(held, page.entries);
      cursor = page.cursor;
      consistentSeen = page.consistent;
      pages += 1;
      assert.ok(pages < 40, "the export ends");
      // The Tenant is written, and its log compacted as far as upkeep is allowed, while the export is between pages.
      if (!consistentSeen) {
        yield* tenant.documents.update({ collection: "posts", id: `p${pages % 12}`, data: { title: `changed${pages}`, rank: pages } });
        yield* tenant.documents.insert({ collection: "posts", id: `late${pages}`, data: { title: "late", rank: 100 + pages } });
        yield* store.compact({ keep: 0 });
      }
    }
    assert.ok(pages > 3, "small pages take several calls");
    // Consistent: what was received is the Tenant as of its last event, however it was written meanwhile.
    // Writes made after the last call are further pages away.
    const tail = yield* db.exportPage(first, { cursor, limit: 1000 });
    assert.equal(tail.consistent, true, "consistent stays true");
    applyAll(held, tail.entries);
    assert.deepEqual(liveOf(held), yield* actual(store));
    // And the stream goes on: a write after the export is the next page.
    yield* tenant.documents.insert({ collection: "posts", id: "after", data: { title: "after", rank: 999 } });
    const more = yield* db.exportPage(first, { cursor: tail.cursor });
    assert.equal(more.consistent, true);
    assert.ok(more.entries.length >= 1);
    applyAll(held, more.entries);
    assert.deepEqual(liveOf(held), yield* actual(store));
  })));

test("an export ends the hold on the log when it is consistent, and compaction then goes on", () =>
  withDatabase((db, shards) => Effect.gen(function* () {
    const tenant = db.forTenant(first);
    yield* seedPosts(tenant, ["a", "b", "c", "d", "e"]);
    const store = shards.get(db.shardOf(first)).partition(first);
    const page = yield* db.exportPage(first, { limit: 2 });
    assert.equal(page.consistent, false);
    yield* tenant.documents.insert({ collection: "posts", id: "f", data: { title: "f", rank: 5 } });
    const held = yield* store.compact({ keep: 0 });
    assert.ok(held.heldAt !== undefined, "an unfinished export holds the log");
    let cursor = page.cursor;
    for (;;) {
      const next = yield* db.exportPage(first, { cursor, limit: 2 });
      cursor = next.cursor;
      if (next.consistent) break;
    }
    const freed = yield* store.compact({ keep: 0 });
    assert.equal(freed.heldAt, undefined, "a consistent export holds nothing");
  })));

test("a cursor that is not this Tenant's, or is malformed, or a bad limit, is refused", () =>
  withDatabase((db) => Effect.gen(function* () {
    yield* seedPosts(db.forTenant(first), ["a", "b", "c"]);
    const other = names[1];
    yield* seedPosts(db.forTenant(other), ["a", "b", "c"]);
    const page = yield* db.exportPage(first, { limit: 1 });
    const refused = (effect) => Effect.map(Effect.exit(effect), (exit) => (Exit.isFailure(exit) ? `${Cause.squash(exit.cause)._tag}: ${Cause.squash(exit.cause).reason}` : "accepted"));
    assert.match(yield* refused(db.exportPage(other, { cursor: page.cursor })), /InvalidExport: the cursor belongs to another Tenant/);
    assert.match(yield* refused(db.exportPage(first, { cursor: "nonsense" })), /InvalidExport: the cursor is not one an export gave/);
    assert.match(yield* refused(db.exportPage(first, { cursor: Buffer.from('{"p":1}').toString("base64url") })), /InvalidExport/);
    assert.match(yield* refused(db.exportPage(first, { limit: 0 })), /InvalidExport: limit is 1 to 1024/);
    assert.match(yield* refused(db.exportPage(first, { limit: 5000 })), /InvalidExport: limit is 1 to 1024/);
  })));

test("a Tenant removed and written again is a new life a cursor does not continue", () =>
  withDatabase((db) => Effect.gen(function* () {
    yield* seedPosts(db.forTenant(first), ["a", "b", "c"]);
    const page = yield* db.exportPage(first, { limit: 1 });
    yield* db.dropTenant(first);
    yield* seedPosts(db.forTenant(first), ["x", "y"]);
    const exit = yield* Effect.exit(db.exportPage(first, { cursor: page.cursor }));
    assert.ok(Exit.isFailure(exit));
    assert.match(String(Cause.squash(exit.cause).reason), /removed and written again/);
  })));

test("a divided Tenant is one export: entries name their parts, and it is consistent once every part is", () =>
  withDatabase((db, shards) => Effect.gen(function* () {
    yield* db.topology.subdivision.subdivide("whale", ["a", "b", "c"]);
    yield* seedPosts(db.forPart("whale", "a"), ["a1", "a2", "a3", "a4"]);
    yield* seedPosts(db.forPart("whale", "b"), ["b1"]);
    const held = new Map();
    let cursor;
    let parts;
    for (let calls = 0; calls < 40; calls++) {
      const page = yield* db.exportPage("whale", { ...(cursor === undefined ? {} : { cursor }), limit: 2 });
      parts = page.parts;
      assert.ok(page.entries.every((entry) => ["a", "b", "c"].includes(entry.part)), "every entry names its part");
      applyAll(held, page.entries);
      cursor = page.cursor;
      if (page.consistent) break;
      yield* db.forPart("whale", "b").documents.insert({ collection: "posts", id: `b-more${calls}`, data: { title: "m", rank: calls } });
    }
    assert.deepEqual(parts, ["a", "b", "c"]);
    const tail = yield* db.exportPage("whale", { cursor, limit: 1000 });
    assert.equal(tail.consistent, true);
    applyAll(held, tail.entries);
    const really = [];
    for (const part of ["a", "b", "c"]) really.push(...(yield* actual(shards.get(db.shardOf(`whale#${part}`)).partition(`whale#${part}`), part)));
    assert.deepEqual(liveOf(held), really.sort());
    const wrong = yield* Effect.exit(db.exportPage("whale", { cursor: Buffer.from(JSON.stringify({ v: 1, parts: ["a"], c: {} })).toString("base64url") }));
    assert.ok(Exit.isFailure(wrong));
  })));

test("a divided Tenant's page holds at most `limit` entries however many parts it has, and every part advances", () =>
  withDatabase((db, shards) => Effect.gen(function* () {
    const parts = Array.from({ length: 24 }, (_, at) => `p${at}`);
    yield* db.topology.subdivision.subdivide("swarm", parts);
    for (const part of parts) yield* seedPosts(db.forPart("swarm", part), [`${part}-1`, `${part}-2`, `${part}-3`]);
    const held = new Map();
    let cursor;
    let calls = 0;
    for (; calls < 400; calls++) {
      const page = yield* db.exportPage("swarm", { ...(cursor === undefined ? {} : { cursor }), limit: 5 });
      assert.ok(page.entries.length <= 5, `a page of ${page.entries.length} entries is over the limit`);
      applyAll(held, page.entries);
      cursor = page.cursor;
      if (page.consistent) break;
      // Writes to the first part carry on throughout; they must not keep the other parts waiting.
      if (calls % 10 === 0) yield* db.forPart("swarm", "p0").documents.insert({ collection: "posts", id: `hot${calls}`, data: { title: "h", rank: calls } });
    }
    assert.ok(calls < 400, "the export became consistent");
    const tail = yield* db.exportPage("swarm", { cursor, limit: 1000 });
    applyAll(held, tail.entries);
    const really = [];
    for (const part of parts) really.push(...(yield* actual(shards.get(db.shardOf(`swarm#${part}`)).partition(`swarm#${part}`), part)));
    assert.deepEqual(liveOf(held), really.sort());
  })));
