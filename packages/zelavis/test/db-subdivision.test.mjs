import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeDatabase, partitionKeyFor, partitionMapFor } from "../dist/db/index.js";
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
  const dir = mkdtempSync(join(tmpdir(), "zv-subdiv-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("a divided tenant's parts are separate partitions, and can land on separate shards", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1", "s2", "s3"]), (db) =>
    Effect.gen(function* () {
      yield* db.topology.subdivision.subdivide("whale", ["a", "b", "c", "d"]);

      const keys = db.topology.subdivision.keysOf("whale");
      assert.deepEqual(keys, ["whale#a", "whale#b", "whale#c", "whale#d"]);

      // Each part routes on its own, so the map spreads them like any tenants.
      const shards = new Set(keys.map((key) => db.shardOf(key)));
      assert.ok(shards.size > 1, "the parts do not all land on one shard");

      // Each part is a whole partition in itself: its own collections, its own
      // dense identifiers, its own local intersection.
      for (const part of ["a", "b"]) {
        const handle = db.forPart("whale", part);
        yield* handle.documents.createCollection({ name: "events" });
        yield* handle.documents.insert({
          collection: "events", id: "e1", data: { part },
        });
      }

      const a = yield* db.forPart("whale", "a").documents.findById({
        collection: "events", id: "e1",
      });
      const b = yield* db.forPart("whale", "b").documents.findById({
        collection: "events", id: "e1",
      });
      assert.equal(a.data.part, "a");
      assert.equal(b.data.part, "b", "the same id in another part is another document");
    }),
  );
});

test("an undivided tenant is untouched by any of this", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      assert.equal(db.topology.subdivision.partsOf("acme"), undefined);
      assert.deepEqual(db.topology.subdivision.keysOf("acme"), ["acme"]);

      yield* db.forTenant("acme").documents.createCollection({ name: "notes" });
      yield* db.forTenant("acme").documents.insert({
        collection: "notes", id: "n1", data: { t: 1 },
      });
      const found = yield* db.forTenant("acme").documents.findById({
        collection: "notes", id: "n1",
      });
      assert.equal(found.data.t, 1, "the ordinary path is exactly as it was");

      assert.throws(
        () => db.forPart("acme", "a"),
        /not divided/,
        "an undivided tenant has no parts to reach",
      );
    }),
  );
});

test("reaching a divided tenant as a whole is refused, not silently partial", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      yield* db.topology.subdivision.subdivide("whale", ["a", "b"]);

      assert.throws(
        () => db.forTenant("whale"),
        /divided into a, b/,
        "a fraction is never handed back as though it were the whole",
      );
      assert.throws(() => db.forPart("whale", "z"), /no part "z"/);
    }),
  );
});

test("a question about the whole tenant is a scatter over its parts", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1", "s2", "s3"]), (db) =>
    Effect.gen(function* () {
      yield* db.topology.subdivision.subdivide("whale", ["a", "b", "c"]);
      for (const part of ["a", "b", "c"]) {
        const handle = db.forPart("whale", part);
        yield* handle.documents.createCollection({ name: "events" });
        yield* handle.documents.insert({
          collection: "events", id: `${part}-1`, data: { part },
        });
      }

      const result = yield* db.scatter.findMany({
        collection: "events",
        tenants: db.topology.subdivision.keysOf("whale"),
      });
      assert.deepEqual(
        result.rows.map((row) => row.document.data.part).sort(),
        ["a", "b", "c"],
        "every part answered",
      );
      assert.ok(result.shards >= 2, "and the cost is visible as more than one shard");
    }),
  );
});

test("dividing is refused for a tenant that already holds records", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      yield* db.forTenant("acme").documents.createCollection({ name: "notes" });

      const refused = yield* db.topology.subdivision
        .subdivide("acme", ["a", "b"])
        .pipe(
          Effect.as("divided"),
          Effect.catchTag("SubdivisionInvalid", (e) => Effect.succeed(e)),
        );
      assert.notEqual(refused, "divided", "routing carries no data with it");
      assert.match(refused.reason, /already holds records/);

      // And the tenant is still reachable exactly as before.
      const names = yield* db.forTenant("acme").documents.listCollections;
      assert.deepEqual(names.map((c) => c.name), ["notes"]);
    }),
  );
});

test("a division must be well formed, and cannot be redrawn", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      const refuse = (tenant, parts) =>
        db.topology.subdivision.subdivide(tenant, parts).pipe(
          Effect.as("divided"),
          Effect.catchTag("SubdivisionInvalid", (e) => Effect.succeed(e.reason)),
        );

      assert.match(yield* refuse("whale", ["only"]), /at least two parts/);
      assert.match(yield* refuse("whale", ["a", "a"]), /distinct/);
      assert.match(yield* refuse("whale", ["a", ""]), /empty or contains/);
      assert.match(yield* refuse("whale", ["a", "b#c"]), /empty or contains/);
      assert.match(yield* refuse("od#d", ["a", "b"]), /cannot be divided/);

      yield* db.topology.subdivision.subdivide("whale", ["a", "b"]);
      // Idempotent for the same division, refused for a different one.
      yield* db.topology.subdivision.subdivide("whale", ["a", "b"]);
      assert.match(yield* refuse("whale", ["a", "b", "c"]), /already divided into a, b/);
    }),
  );
});

test("a division survives reopening, and the parts keep their data", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      yield* db.topology.subdivision.subdivide("whale", ["a", "b"]);
      const handle = db.forPart("whale", "a");
      yield* handle.documents.createCollection({ name: "events" });
      yield* handle.documents.insert({ collection: "events", id: "e1", data: { n: 1 } });
    }),
  ).then(() =>
    openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
      Effect.gen(function* () {
        assert.deepEqual(db.topology.subdivision.partsOf("whale"), ["a", "b"]);
        assert.throws(() => db.forTenant("whale"), /divided/);
        const found = yield* db.forPart("whale", "a").documents.findById({
          collection: "events", id: "e1",
        });
        assert.equal(found.data.n, 1, "the part's data is where it was");
      }),
    ),
  );
});

test("a part is an ordinary tenant to everything below routing", async (t) => {
  const dir = tempDir(t);
  await openAt(dir, partitionMapFor(["s0", "s1"]), (db) =>
    Effect.gen(function* () {
      yield* db.topology.subdivision.subdivide("whale", ["a", "b"]);
      const handle = db.forPart("whale", "a");
      yield* handle.documents.createCollection({ name: "events" });
      yield* handle.documents.insert({ collection: "events", id: "e1", data: { n: 1 } });

      // It occupies its shard under its own key, so a rebalance sees it like
      // any other tenant rather than as something it has no name for.
      const key = partitionKeyFor("whale", "a");
      const targets = yield* db.scatter.targets();
      assert.ok(
        targets.some((entry) => entry.tenant === key),
        "the part is an occupant in its own right",
      );

      // And a backup of a part is a backup of a tenant.
      const backup = yield* handle.backups.exportTenant;
      assert.equal(backup.tenantId, key);
      assert.ok(backup.events.length > 0);
    }),
  );
});
