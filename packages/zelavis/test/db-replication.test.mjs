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
      assert.ok(
        passes.every((p) => p.records > 0 && p.applied === 0),
        "the write already carried, so a refresh finds them there and writes nothing",
      );

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
      assert.ok(
        pass.every((p) => p.applied === 0 && p.retracted === 0),
        "both changes carried at the write, leaving a refresh nothing to do",
      );

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

test("opening the database levels a replica that fell behind", async (t) => {
  const dir = tempDir(t);
  const home = await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      yield* declareReplicated(db, "plans");
      yield* db.global.documents.insert({ collection: "plans", id: "pro", data: { seats: 25 } });
      return db.shardOf("acme");
    }),
  );

  // Take the copy back off that shard behind the database's back: what an
  // interrupted pass, or a shard that joined while nothing was watching, leaves.
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* makeNodeSqliteStore(home, dir);
        const seq = yield* store.lookup("doc/zv.global/plans", "pro");
        assert.notEqual(seq, undefined, "the replica was there to remove");
        yield* store.transact((txn) => txn.retract(seq));
      }),
    ),
  );

  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      const found = yield* db.forTenant("acme").shared.findById({
        collection: "plans", id: "pro",
      });
      assert.equal(found.data.seats, 25, "opening put the missing copy back");
    }),
  );
});

test("a replicated collection cannot declare edges in the first place", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      yield* db.topology.placement.declare("linked", "replicated");

      // Refused where the edge is declared, with the error the collection API
      // already reports for a constraint it cannot accept — not as a defect
      // raised later by whichever write first produced one.
      const refused = yield* db.global.documents
        .createCollection({
          name: "linked",
          edges: [{ name: "parent", path: "parentId", collection: "linked" }],
        })
        .pipe(
          Effect.as("created"),
          Effect.catchTag("InvalidConstraint", (e) => Effect.succeed(e)),
        );
      assert.notEqual(refused, "created", "an edge cannot survive a reallocated identifier");
      assert.equal(refused.collection, "linked");
      assert.equal(refused.name, "parent");
      assert.match(refused.reason, /identifier/, "it says why a copy cannot carry it");

      // Without edges the same collection is ordinary, and replicates.
      yield* db.global.documents.createCollection({ name: "linked" });
      yield* db.global.documents.insert({ collection: "linked", id: "a", data: { n: 1 } });
      const found = yield* db.forTenant("acme").shared.findById({
        collection: "linked", id: "a",
      });
      assert.equal(found.data.n, 1);
    }),
  );
});

test("a global collection may declare edges, since nothing copies it", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      yield* db.global.documents.createCollection({
        name: "linked",
        edges: [{ name: "parent", path: "parentId", collection: "linked" }],
      });
      assert.equal(db.topology.placement.classOf("linked"), "global");
      yield* db.global.documents.insert({ collection: "linked", id: "a", data: { n: 1 } });
      yield* db.global.documents.insert({
        collection: "linked", id: "b", data: { n: 2, parentId: "a" },
      });

      const linked = yield* db.global.documents.findById({ collection: "linked", id: "b" });
      assert.equal(linked.data.parentId, "a", "the edge is ordinary where it stays put");

      // And declaring it replicated afterwards is refused by the class itself.
      const reclassified = yield* db.topology.placement
        .declare("linked", "replicated")
        .pipe(
          Effect.as("declared"),
          Effect.catchTag("PlacementImmutable", (e) => Effect.succeed(e)),
        );
      assert.notEqual(reclassified, "declared", "a class does not change under data");
      assert.equal(reclassified.current, "global");
    }),
  );
});

test("a write reaches the replicas without an explicit refresh", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      yield* declareReplicated(db, "plans");
      yield* db.global.documents.insert({ collection: "plans", id: "pro", data: { seats: 25 } });

      // No refresh call anywhere in this test.
      for (const tenant of ["acme", "globex"]) {
        const found = yield* db.forTenant(tenant).shared.findById({
          collection: "plans", id: "pro",
        });
        assert.equal(found.data.seats, 25, `${tenant} sees the insert immediately`);
      }

      yield* db.global.documents.update({
        collection: "plans", id: "pro", data: { seats: 50 },
      });
      const updated = yield* db.forTenant("acme").shared.findById({
        collection: "plans", id: "pro",
      });
      assert.equal(updated.data.seats, 50, "the update carried too");

      yield* db.global.documents.delete({ collection: "plans", id: "pro" });
      const gone = yield* db.forTenant("acme").shared.findById({
        collection: "plans", id: "pro",
      });
      assert.equal(gone, undefined, "and so did the delete");

      // Nothing was left for a refresh to reconcile.
      const settled = yield* db.replication.refresh;
      assert.ok(
        settled.every((p) => p.applied === 0 && p.retracted === 0),
        "propagation left the replicas already level",
      );
    }),
  );
});

test("a batch write carries every document it touched", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      yield* declareReplicated(db, "plans");
      yield* db.global.documents.write({
        operations: [
          { _tag: "Insert", collection: "plans", id: "pro", data: { seats: 25 } },
          { _tag: "Insert", collection: "plans", id: "lite", data: { seats: 1 } },
        ],
      });

      const shared = db.forTenant("acme").shared;
      assert.equal((yield* shared.findById({ collection: "plans", id: "pro" })).data.seats, 25);
      assert.equal((yield* shared.findById({ collection: "plans", id: "lite" })).data.seats, 1);

      yield* db.global.documents.write({
        operations: [
          { _tag: "Update", collection: "plans", id: "pro", data: { seats: 99 } },
          { _tag: "Delete", collection: "plans", id: "lite" },
        ],
      });
      assert.equal((yield* shared.findById({ collection: "plans", id: "pro" })).data.seats, 99);
      assert.equal(yield* shared.findById({ collection: "plans", id: "lite" }), undefined);

      const settled = yield* db.replication.refresh;
      assert.ok(settled.every((p) => p.applied === 0 && p.retracted === 0));
    }),
  );
});

test("writing a global collection carries nothing to the shards", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      yield* db.global.documents.createCollection({ name: "secrets" });
      yield* db.global.documents.insert({ collection: "secrets", id: "k", data: { v: 1 } });

      const shared = db.forTenant("acme").shared;
      assert.deepEqual(yield* shared.listCollections, [], "a global collection stays put");

      const settled = yield* db.replication.refresh;
      assert.ok(
        settled.every((p) => p.applied === 0 && p.retracted === 0 && p.records === 0),
        "and a refresh agrees there is nothing to replicate",
      );
    }),
  );
});
