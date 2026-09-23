import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeDatabase, partitionMapFor } from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const openAt = (dir, partitionMap, body) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* makeDatabase({
          partitionMap,
          openShard: (shard) => makeNodeSqliteStore(shard, dir),
        });
        return yield* body(db);
      }),
    ),
  );

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-repl-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** Declare first, create second: that is how a replicated collection is made. */
const declareReplicated = (db, name) =>
  Effect.gen(function* () {
    yield* db.topology.placement.declare(name, "replicated");
    yield* db.global.documents.createCollection({ name });
  });

test("a replicated collection reaches every shard, and a tenant reads it locally", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      yield* declareReplicated(db, "plans");
      yield* db.global.documents.insert({
        collection: "plans", id: "pro", data: { seats: 25 },
      });

      const passes = yield* db.replication.refresh;
      assert.deepEqual(passes.map((p) => p.shard), ["s0", "s1"], "every placed shard is levelled");
      assert.ok(passes.every((p) => p.applied > 0), "each shard took the records");

      // Two tenants that hash to different shards both read it locally.
      for (const tenant of ["acme", "globex"]) {
        const found = yield* db.forTenant(tenant).shared.findById({
          collection: "plans", id: "pro",
        });
        assert.equal(found.data.seats, 25, `${tenant} reads the replica on its own shard`);
      }
    }),
  );
});

test("a refresh with nothing to do writes nothing", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      yield* declareReplicated(db, "plans");
      yield* db.global.documents.insert({ collection: "plans", id: "pro", data: { seats: 25 } });

      yield* db.replication.refresh;
      const second = yield* db.replication.refresh;
      assert.ok(
        second.every((p) => p.applied === 0 && p.retracted === 0),
        "a settled replica costs no writes",
      );
    }),
  );
});

test("updates propagate and deletes are retracted from every replica", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      yield* declareReplicated(db, "plans");
      yield* db.global.documents.insert({ collection: "plans", id: "pro", data: { seats: 25 } });
      yield* db.global.documents.insert({ collection: "plans", id: "lite", data: { seats: 1 } });
      yield* db.replication.refresh;

      yield* db.global.documents.update({
        collection: "plans", id: "pro", data: { seats: 50 },
      });
      yield* db.global.documents.delete({ collection: "plans", id: "lite" });

      const pass = yield* db.replication.refresh;
      assert.ok(pass.every((p) => p.retracted === 1), "the deleted record is removed everywhere");

      const shared = db.forTenant("acme").shared;
      const updated = yield* shared.findById({ collection: "plans", id: "pro" });
      assert.equal(updated.data.seats, 50, "the update reached the replica");

      const gone = yield* shared.findById({ collection: "plans", id: "lite" });
      assert.equal(gone, undefined, "the deleted record is not readable from the replica");
    }),
  );
});

test("a global collection stays in the global store and is never copied out", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      // One of each class, App-scoped.
      yield* declareReplicated(db, "plans");
      yield* db.global.documents.createCollection({ name: "secrets" });
      assert.equal(db.topology.placement.classOf("secrets"), "global");

      yield* db.global.documents.insert({ collection: "plans", id: "pro", data: { seats: 25 } });
      yield* db.global.documents.insert({ collection: "secrets", id: "k", data: { v: 1 } });
      yield* db.replication.refresh;

      const shared = db.forTenant("acme").shared;
      const names = (yield* shared.listCollections).map((c) => c.name);
      assert.deepEqual(names, ["plans"], "only the replicated collection is on the shard");

      // Both remain readable where they actually live.
      const viaGlobal = yield* db.global.documents.findById({ collection: "secrets", id: "k" });
      assert.equal(viaGlobal.data.v, 1);
    }),
  );
});

test("replication does not make the App look like a tenant on a shard", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      yield* declareReplicated(db, "plans");
      yield* db.global.documents.insert({ collection: "plans", id: "pro", data: { seats: 25 } });
      yield* db.replication.refresh;

      // The tenant marker must not travel: tenantsOn drives rebalance planning,
      // and a copy standing in a range would look like data that must be moved.
      const targets = yield* db.scatter.targets();
      assert.ok(
        !targets.some((entry) => entry.tenant === "zv.global"),
        "the App is not an occupant of any shard",
      );

      const moves = yield* db.topology.plan({
        ...partitionMapFor(["s0", "s1", "s2", "s3"]), version: 2,
      });
      assert.ok(
        moves.every((move) => !move.tenants.includes("zv.global")),
        "a rebalance never plans to move the App's replica",
      );
    }),
  );
});

test("a replica is refreshed when the database opens", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      yield* declareReplicated(db, "plans");
      yield* db.global.documents.insert({ collection: "plans", id: "pro", data: { seats: 25 } });
      // Deliberately no refresh: the write is in the global store only.
      const shared = db.forTenant("acme").shared;
      const before = yield* shared.findById({ collection: "plans", id: "pro" });
      assert.equal(before, undefined, "a write is not visible to replicas until a refresh");
      assert.deepEqual(yield* shared.listCollections, [], "nor is the collection");
    }),
  ).then(() =>
    openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
      Effect.gen(function* () {
        const found = yield* db.forTenant("acme").shared.findById({
          collection: "plans", id: "pro",
        });
        assert.equal(found.data.seats, 25, "opening levelled the replica");
      }),
    ),
  );
});

test("a replicated collection carrying edges is refused, not copied wrong", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      yield* db.topology.placement.declare("linked", "replicated");
      yield* db.global.documents.createCollection({
        name: "linked",
        edges: [{ name: "parent", path: "parentId", collection: "linked" }],
      });
      yield* db.global.documents.insert({ collection: "linked", id: "a", data: { n: 1 } });
      yield* db.global.documents.insert({
        collection: "linked", id: "b", data: { n: 2, parentId: "a" },
      });

      const outcome = yield* db.replication.refresh.pipe(
        Effect.as("copied"),
        Effect.catchTag("ReplicationUnsupported", (e) => Effect.succeed(e)),
      );
      assert.notEqual(outcome, "copied", "an edge cannot survive a reallocated identifier");
      assert.equal(outcome.collection, "linked");
      assert.match(outcome.reason, /identifier/);
    }),
  );
});
