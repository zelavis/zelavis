import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeDatabase, partitionMapFor, shardFor, shardsOf, virtualRangeFor } from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const withDb = (t, shards, body, options) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-tenant-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const partitionMap = partitionMapFor(shards, options);
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* makeDatabase({
          partitionMap,
          openShard: (shard) => makeNodeSqliteStore(shard, dir),
        });
        return yield* body(db, dir);
      }),
    ),
  );
};

test("partition map: covers every range and places tenants deterministically", () => {
  const map = partitionMapFor(["s0", "s1", "s2", "s3"]);
  assert.equal(map.virtualRanges, 256);
  assert.deepEqual(shardsOf(map), ["s0", "s1", "s2", "s3"]);

  // Contiguous and complete: no range is unplaced or placed twice.
  let cursor = 0;
  for (const p of map.placements) {
    assert.equal(p.from, cursor, "placements are contiguous");
    cursor = p.to;
  }
  assert.equal(cursor, 256, "placements cover every range");

  // Deterministic across calls and across map instances with the same shards.
  const again = partitionMapFor(["s0", "s1", "s2", "s3"]);
  for (const tenant of ["acme", "globex", "initech", "t-42"]) {
    assert.equal(shardFor(map, tenant), shardFor(again, tenant), `${tenant} is stable`);
    const slot = virtualRangeFor(map, tenant);
    assert.ok(slot >= 0 && slot < 256, "slot in range");
  }

  assert.throws(() => partitionMapFor([]), /at least one shard/);
  assert.throws(() => partitionMapFor(["a", "b"], { virtualRanges: 1 }), /virtual range per shard/);
});

test("adding shards moves ranges rather than rehashing tenants", () => {
  const tenants = Array.from({ length: 400 }, (_, i) => `tenant-${i}`);
  const before = partitionMapFor(["s0", "s1"]);
  const after = partitionMapFor(["s0", "s1", "s2", "s3"]);

  // The slot a tenant hashes to never changes; only where that slot is placed.
  for (const tenant of tenants) {
    assert.equal(virtualRangeFor(before, tenant), virtualRangeFor(after, tenant));
  }

  const moved = tenants.filter((t) => shardFor(before, t) !== shardFor(after, t));
  assert.ok(moved.length > 0, "some tenants move");
  assert.ok(moved.length < tenants.length, "not everything moves");
});

test("tenants sharing a shard cannot see each other's data", async (t) => {
  // One shard on purpose: this is the case where isolation could leak.
  await withDb(t, ["only"], (db) =>
    Effect.gen(function* () {
      const acme = db.forTenant("acme").documents;
      const globex = db.forTenant("globex").documents;
      assert.equal(db.shardOf("acme"), "only");
      assert.equal(db.shardOf("globex"), "only");

      yield* acme.createCollection({ name: "posts" });
      yield* globex.createCollection({ name: "posts" });

      yield* acme.insert({ collection: "posts", id: "shared-id", data: { owner: "acme", region: "eu" } });
      yield* globex.insert({ collection: "posts", id: "shared-id", data: { owner: "globex", region: "eu" } });

      // The same document id in the same collection name, different tenants.
      assert.equal((yield* acme.findById({ collection: "posts", id: "shared-id" })).data.owner, "acme");
      assert.equal((yield* globex.findById({ collection: "posts", id: "shared-id" })).data.owner, "globex");

      // A filter that matches both tenants' rows returns only the caller's.
      const found = yield* acme.findMany({ collection: "posts", where: [{ path: "region", value: "eu" }] });
      assert.deepEqual(found.map((d) => d.data.owner), ["acme"], "no cross-tenant rows");

      // Listing collections is tenant-scoped too.
      yield* acme.createCollection({ name: "acme-only" });
      assert.deepEqual((yield* acme.listCollections()).map((c) => c.name), ["acme-only", "posts"]);
      assert.deepEqual((yield* globex.listCollections()).map((c) => c.name), ["posts"]);
      assert.equal(yield* globex.collectionExists("acme-only"), false);

      // Deleting one tenant's document leaves the other's alone.
      assert.equal(yield* acme.delete({ collection: "posts", id: "shared-id" }), true);
      assert.equal(yield* acme.findById({ collection: "posts", id: "shared-id" }), undefined);
      assert.equal((yield* globex.findById({ collection: "posts", id: "shared-id" })).data.owner, "globex");
    }),
  );
});

test("a tenant's data lives wholly on one shard", async (t) => {
  await withDb(t, ["s0", "s1", "s2", "s3"], (db) =>
    Effect.gen(function* () {
      const names = Array.from({ length: 60 }, (_, i) => `tenant-${i}`);
      const used = new Set(names.map((n) => db.shardOf(n)));
      assert.ok(used.size > 1, "tenants spread across shards");

      for (const name of names.slice(0, 8)) {
        const docs = db.forTenant(name).documents;
        yield* docs.createCollection({ name: "notes" });
        yield* docs.insert({ collection: "notes", id: "n1", data: { who: name } });
      }

      for (const name of names.slice(0, 8)) {
        const docs = db.forTenant(name).documents;
        const found = yield* docs.findMany({ collection: "notes" });
        assert.deepEqual(found.map((d) => d.data.who), [name], `${name} sees only its own`);
      }

      // Routing is a pure function of the map, so it agrees with placement.
      for (const name of names) {
        assert.equal(db.shardOf(name), shardFor(db.partitionMap, name));
      }
    }),
  );
});
