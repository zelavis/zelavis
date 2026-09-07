import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeDatabase, partitionMapFor, validatePartitionMap } from "../dist/dbnew/index.js";
import { makeNodeSqliteStore } from "../dist/dbnew/adapters/node-sqlite.js";

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
        const found = yield* db.forTenant("acme").documents.listCollections();
        assert.deepEqual(found.map((c) => c.name), ["posts"], "data survived the change");
      }),
    ),
  );
});
