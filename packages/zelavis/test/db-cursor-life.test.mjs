// An event cursor belongs to one life of one partition. A Tenant removed and written again starts a new log whose
// positions begin over, so a cursor kept from before must be refused rather than read as a place in the new log:
// read as one, it skips every event of the new life up to its old position and nobody hears about it. These tests
// hold the store to that across removal and recreation, and to what must keep working: a branch continuing its
// source's cursor up to the branch point, a move keeping the life, and position 0 meaning the start of any life.
import assert from "node:assert/strict";
import test from "node:test";
import { Cause, Effect, Exit } from "effect";
import { makeDatabase, partitionMapFor, shardFor } from "../dist/db/index.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { openShardOverKv } from "../dist/db/kv-store.js";

const map = partitionMapFor(["s0", "s1"]);

const withDatabase = (body) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const shards = new Map();
    const db = yield* makeDatabase({
      partitionMap: map,
      crossTenantRefresh: false,
      openShard: (shard) => Effect.tap(openShardOverKv(shard, memoryKvEngine()), (store) => Effect.sync(() => shards.set(shard, store))),
    });
    return yield* body(db, shards);
  })));

const across = (() => {
  const names = Array.from({ length: 64 }, (_, at) => `t${at}`);
  const first = names[0];
  const other = names.find((name) => shardFor(map, name) !== shardFor(map, first));
  return { first, other };
})();

const write = (tenant, ids) => Effect.forEach(ids, (id) => tenant.documents.insert({ collection: "posts", id, data: { title: id } }));
const squashed = (exit) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined);

test("a cursor from before a Tenant was removed and written again is refused, not read as a place in the new log", () =>
  withDatabase((db) => Effect.gen(function* () {
    const tenant = db.forTenant(across.first);
    yield* tenant.documents.createCollection({ name: "posts" });
    yield* write(tenant, ["a", "b", "c", "d", "e", "f"]);
    const old = (yield* tenant.events.read({ limit: 100 })).cursor;
    assert.ok(old !== undefined);

    yield* db.dropTenant(across.first);
    yield* tenant.documents.createCollection({ name: "posts" });
    yield* write(tenant, ["x"]);

    const exit = yield* Effect.exit(tenant.events.read({ after: old, limit: 100 }));
    const error = squashed(exit);
    assert.equal(error?._tag, "CursorFromAnotherLife", `the old cursor was read as ${JSON.stringify(Exit.isSuccess(exit) ? exit.value.events.map((event) => event.documentId) : error)}`);
    assert.equal(error.partition, across.first);

    // Once the new log has passed the old position, the old cursor would have resumed somewhere in the middle of it.
    yield* write(tenant, ["y", "z", "w", "v", "u", "t", "s"]);
    assert.equal(squashed(yield* Effect.exit(tenant.events.read({ after: old, limit: 100 })))?._tag, "CursorFromAnotherLife");

    const fresh = yield* tenant.events.read({ limit: 100 });
    assert.deepEqual(fresh.events.filter((event) => event.documentId !== undefined).map((event) => event.documentId),
      ["x", "y", "z", "w", "v", "u", "t", "s"], "a reader starting over sees the whole new life");
    assert.deepEqual((yield* tenant.events.read({ after: fresh.cursor, limit: 100 })).events, [], "a cursor of this life carries on");
  })));
