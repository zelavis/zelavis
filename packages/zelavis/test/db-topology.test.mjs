import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import {
  makeDatabase,
  partitionMapFor,
  SYSTEM_PLACEMENTS,
  TOPOLOGY_SHARD,
  validatePartitionMap,
  validatePlacementCatalog,
} from "../dist/db/index.js";
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
  const dir = mkdtempSync(join(tmpdir(), "zv-topo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("partition map validation catches gaps, overlaps and inversions", () => {
  assert.equal(validatePartitionMap(partitionMapFor(["a", "b"])), undefined);

  const gap = {
    version: 1, virtualRanges: 256,
    placements: [{ from: 0, to: 100, shard: "a" }, { from: 120, to: 256, shard: "b" }],
  };
  assert.match(validatePartitionMap(gap).reason, /100\.\.120 are unplaced/);

  const overlap = {
    version: 1, virtualRanges: 256,
    placements: [{ from: 0, to: 200, shard: "a" }, { from: 100, to: 256, shard: "b" }],
  };
  assert.match(validatePartitionMap(overlap).reason, /overlap/);

  const short = {
    version: 1, virtualRanges: 256,
    placements: [{ from: 0, to: 200, shard: "a" }],
  };
  assert.match(validatePartitionMap(short).reason, /200\.\.256 are unplaced/);

  const inverted = {
    version: 1, virtualRanges: 256,
    placements: [{ from: 0, to: 0, shard: "a" }, { from: 0, to: 256, shard: "b" }],
  };
  assert.match(validatePartitionMap(inverted).reason, /empty or inverted/);
});

test("the stored map survives reopening and outranks what the caller passes", async (t) => {
  const dir = tempDir(t);

  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      assert.deepEqual(db.partitionMap.placements.map((p) => p.shard), ["s0", "s1"]);
      const tenant = db.forTenant("acme");
      yield* tenant.documents.createCollection({ name: "posts" });
      yield* tenant.documents.insert({ collection: "posts", id: "p1", data: { title: "Atlas" } });
      return db.shardOf("acme");
    }),
  ).then(async (originalShard) => {
    // Reopening with a different shard list must not re-place ranges: the data
    // is already sitting where the stored map says it is.
    await openAt(dir, partitionMapFor(["x0", "x1", "x2", "x3"]), (db) =>
      Effect.gen(function* () {
        assert.deepEqual(
          db.partitionMap.placements.map((p) => p.shard),
          ["s0", "s1"],
          "the stored map wins",
        );
        assert.equal(db.shardOf("acme"), originalShard, "placement is unchanged");
        const found = yield* db.forTenant("acme").documents.findById({
          collection: "posts", id: "p1",
        });
        assert.equal(found.data.title, "Atlas", "data is still reachable");
      }),
    );
  });
});

test("a map change is refused while tenants stand on the ranges it moves", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      // Occupy both shards.
      const names = Array.from({ length: 40 }, (_, i) => `tenant-${i}`);
      for (const name of names) {
        yield* db.forTenant(name).documents.createCollection({ name: "notes" });
      }
      const used = new Set(names.map((n) => db.shardOf(n)));
      assert.equal(used.size, 2, "both shards are occupied");

      const next = { ...partitionMapFor(["s0", "s1", "s2", "s3"]), version: 2 };
      const moves = yield* db.topology.plan(next);
      assert.ok(moves.length > 0, "the change moves ranges");
      assert.ok(moves.some((m) => m.tenants.length > 0), "some moved ranges are occupied");

      const refused = yield* db.topology.update(next).pipe(
        Effect.as("applied"),
        Effect.catchTag("RangeNotEmpty", (e) => Effect.succeed(e)),
      );
      assert.notEqual(refused, "applied", "moving occupied ranges is refused");
      assert.ok(refused.tenants.length > 0, "the error names who is standing there");
      assert.equal(db.topology.current().version, 1, "the map is unchanged");
    }),
  );
});

test("a map change is accepted when the ranges it moves are empty", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      // One tenant only, so most ranges are unoccupied.
      const solo = "acme";
      yield* db.forTenant(solo).documents.createCollection({ name: "posts" });
      const home = db.shardOf(solo);

      // Move every range onto the shard that already holds the only tenant.
      const next = {
        version: 2,
        virtualRanges: 256,
        placements: [{ from: 0, to: 256, shard: home }],
      };
      const applied = yield* db.topology.update(next);
      assert.equal(applied.version, 2);
      assert.equal(db.topology.current().version, 2);

      const rejectedVersion = yield* db.topology
        .update({ ...next, version: 2 })
        .pipe(Effect.as("applied"), Effect.catchTag("PartitionMapInvalid", () => Effect.succeed("rejected")));
      assert.equal(rejectedVersion, "rejected", "the version must advance");

      const rejectedShape = yield* db.topology
        .update({ version: 3, virtualRanges: 256, placements: [{ from: 0, to: 100, shard: home }] })
        .pipe(Effect.as("applied"), Effect.catchTag("PartitionMapInvalid", () => Effect.succeed("rejected")));
      assert.equal(rejectedShape, "rejected", "an incomplete map is refused");
    }),
  ).then(() =>
    // The accepted change is durable.
    openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
      Effect.gen(function* () {
        assert.equal(db.partitionMap.version, 2, "the stored version is reloaded");
        assert.equal(db.partitionMap.placements.length, 1);
        const found = yield* db.forTenant("acme").documents.listCollections;
        assert.deepEqual(found.map((c) => c.name), ["posts"], "data survived the change");
      }),
    ),
  );
});

test("placement catalog validation catches unknown classes and displaced internals", () => {
  const seeded = { version: 1, collections: { ...SYSTEM_PLACEMENTS } };
  assert.equal(validatePlacementCatalog(seeded), undefined);

  assert.match(
    validatePlacementCatalog({ ...seeded, version: 0 }).reason,
    /version must be positive/,
  );

  const unknown = {
    version: 1,
    collections: { ...SYSTEM_PLACEMENTS, notes: "sharded" },
  };
  assert.match(validatePlacementCatalog(unknown).reason, /unknown placement "sharded"/);

  assert.match(
    validatePlacementCatalog({ version: 1, collections: {} }).reason,
    /"zv\.topology" is unplaced/,
  );

  const reclassified = { version: 1, collections: { [TOPOLOGY_SHARD]: "partitioned" } };
  assert.match(
    validatePlacementCatalog(reclassified).reason,
    /placed "partitioned" rather than "global"/,
  );
});

test("a fresh database seeds the catalog and defaults everything else to partitioned", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      const placement = db.topology.placement;
      assert.equal(
        placement.classOf(TOPOLOGY_SHARD),
        "global",
        "the map's own store is classified, not special-cased",
      );
      assert.equal(
        placement.classOf("posts"),
        "partitioned",
        "an unmentioned collection is the default, not an error",
      );
      assert.equal(placement.current().version, 1);
      yield* Effect.void;
    }),
  );
});

test("declaring a placement is idempotent, durable, and refuses a second class", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      const placement = db.topology.placement;

      const declared = yield* placement.declare("plans", "global");
      assert.equal(declared.version, 2, "a declaration advances the catalog");
      assert.equal(placement.classOf("plans"), "global");

      const again = yield* placement.declare("plans", "global");
      assert.equal(again.version, 2, "redeclaring the same class writes nothing");

      const reclassified = yield* placement.declare("plans", "replicated").pipe(
        Effect.as("applied"),
        Effect.catchTag("PlacementImmutable", (e) => Effect.succeed(e)),
      );
      assert.notEqual(reclassified, "applied", "a class change is not a catalog edit");
      assert.equal(reclassified.current, "global");
      assert.equal(reclassified.requested, "replicated");

      const reserved = yield* placement.declare("zv_internal", "global").pipe(
        Effect.as("applied"),
        Effect.catchTag("PlacementCatalogInvalid", () => Effect.succeed("rejected")),
      );
      assert.equal(reserved, "rejected", "an App may not place a reserved name");
    }),
  ).then(() =>
    openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
      Effect.gen(function* () {
        assert.equal(db.topology.placement.classOf("plans"), "global", "the catalog is durable");
        assert.equal(db.topology.placement.current().version, 2);
        yield* Effect.void;
      }),
    ),
  );
});

test("App-scoped collections live beside tenants without colliding with them", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      // The same name in both scopes. These are different collections for the
      // same reason two tenants' "plans" already are.
      yield* db.global.documents.createCollection({ name: "plans" });
      yield* db.global.documents.insert({
        collection: "plans", id: "pro", data: { seats: 25 },
      });

      yield* db.forTenant("acme").documents.createCollection({ name: "plans" });
      yield* db.forTenant("acme").documents.insert({
        collection: "plans", id: "pro", data: { seats: 1 },
      });

      const appScoped = yield* db.global.documents.findById({ collection: "plans", id: "pro" });
      const tenantScoped = yield* db.forTenant("acme").documents.findById({
        collection: "plans", id: "pro",
      });
      assert.equal(appScoped.data.seats, 25);
      assert.equal(tenantScoped.data.seats, 1, "the tenant's copy is untouched");

      // A tenant that never created "plans" has none, even though the App does.
      const other = yield* db.forTenant("globex").documents.listCollections;
      assert.deepEqual(other.map((c) => c.name), [], "global collections are not tenant collections");
    }),
  );
});

test("creating an App-scoped collection catalogues it, and the catalog survives reopening", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      assert.equal(db.topology.placement.classOf("plans"), "partitioned", "undeclared is the default");
      yield* db.global.documents.createCollection({ name: "plans" });
      assert.equal(
        db.topology.placement.classOf("plans"),
        "global",
        "creating it in the global scope is what declares it",
      );

      // A tenant collection of the same name does not change the catalog: the
      // catalog names App-scoped collections, not every collection that exists.
      yield* db.forTenant("acme").documents.createCollection({ name: "notes" });
      assert.equal(db.topology.placement.classOf("notes"), "partitioned");
    }),
  ).then(() =>
    openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
      Effect.gen(function* () {
        assert.equal(db.topology.placement.classOf("plans"), "global");
        const found = yield* db.global.documents.findById({ collection: "plans", id: "pro" });
        assert.equal(found, undefined, "no documents were invented");
      }).pipe(Effect.catchTag("DocumentNotFound", () => Effect.void)),
    ),
  );
});

test("the global store is maintained like any other, and scatter never reads it", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      yield* db.global.documents.createCollection({ name: "plans" });
      yield* db.global.documents.insert({ collection: "plans", id: "pro", data: { seats: 25 } });
      yield* db.forTenant("acme").documents.createCollection({ name: "plans" });
      yield* db.forTenant("acme").documents.insert({
        collection: "plans", id: "local", data: { seats: 1 },
      });

      const status = yield* db.maintenance.status;
      const shards = status.map((s) => s.shard);
      assert.ok(shards.includes("zv.global"), "upkeep reaches the store nobody thinks about");
      assert.ok(shards.includes("zv.topology"));

      // A fan-out crosses partitions, and the global store is not one.
      const targets = yield* db.scatter.targets();
      assert.ok(
        !targets.some((entry) => entry.tenant === "zv.global"),
        "the App tenant is not a scatter target",
      );
      const result = yield* db.scatter.findMany({ collection: "plans" });
      assert.deepEqual(
        result.rows.map((row) => row.document.id),
        ["local"],
        "only the tenant's documents are fanned out over",
      );
    }),
  );
});
