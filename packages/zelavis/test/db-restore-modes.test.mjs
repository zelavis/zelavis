import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeDatabase, partitionMapFor } from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const withTenant = (t, body) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-restore-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Effect.runPromise(
    Effect.scoped(Effect.gen(function* () {
      const db = yield* makeDatabase({
        partitionMap: partitionMapFor(["s0"]),
        openShard: (shard) => makeNodeSqliteStore(shard, dir),
      });
      return yield* body(db.forTenant("acme"), db);
    })),
  );
};

/** The state a backup is taken from: two posts and a collection. */
const original = (tenant) =>
  Effect.gen(function* () {
    yield* tenant.documents.createCollection({ name: "posts" });
    yield* tenant.documents.insert({
      collection: "posts", id: "p1", data: { title: "Atlas" },
    });
    yield* tenant.documents.insert({
      collection: "posts", id: "p2", data: { title: "Beacon" },
    });
    yield* tenant.documents.update({
      collection: "posts", id: "p1", data: { title: "Atlas revised" },
    });
    return yield* tenant.backups.exportTenant();
  });

const titles = (tenant) =>
  Effect.map(
    tenant.documents.findMany({ collection: "posts" }),
    (docs) => docs.map((d) => `${d.id}:${d.data.title}:v${d.version}`).sort(),
  );

test("restoring into a tenant holding data still refuses by default", async (t) => {
  await withTenant(t, (tenant) =>
    Effect.gen(function* () {
      const backup = yield* original(tenant);

      const refused = yield* Effect.flip(tenant.backups.restoreTenant(backup));
      assert.equal(refused._tag, "TenantNotEmpty");
      assert.equal(refused.tenant, "acme");

      // The default cannot lose anything: the caller is told there is data here
      // rather than having it purged or written over.
      assert.deepEqual(yield* titles(tenant), ["p1:Atlas revised:v2", "p2:Beacon:v1"]);
    }),
  );
});

test("a purge leaves the tenant as the backup describes it", async (t) => {
  await withTenant(t, (tenant) =>
    Effect.gen(function* () {
      const backup = yield* original(tenant);

      // Drift: one document changed, one added, one removed.
      yield* tenant.documents.update({
        collection: "posts", id: "p1", data: { title: "drifted" },
      });
      yield* tenant.documents.insert({
        collection: "posts", id: "p3", data: { title: "Cobalt" },
      });
      yield* tenant.documents.delete({ collection: "posts", id: "p2" });
      assert.deepEqual(yield* titles(tenant), ["p1:drifted:v3", "p3:Cobalt:v1"]);

      const result = yield* tenant.backups.restoreTenant(backup, { into: "purge" });
      assert.ok(result.removed > 0, "what was there was discarded first");
      assert.equal(result.superseded, 0, "nothing was written over; it was replaced");

      // Including p3, which the backup never mentioned: a purge is a
      // replacement, not a union.
      assert.deepEqual(yield* titles(tenant), ["p1:Atlas revised:v2", "p2:Beacon:v1"]);
      assert.deepEqual(
        (yield* tenant.documents.listCollections()).map((c) => c.name), ["posts"]);
    }),
  );
});

test("a purge clears what an export would have carried, and no less", async (t) => {
  await withTenant(t, (tenant) =>
    Effect.gen(function* () {
      const backup = yield* original(tenant);

      // A collection and a schema the backup does not know about. Clearing less
      // than a restore replaces would leave these behind, and the tenant would
      // then be neither what it was nor what the backup says.
      yield* tenant.documents.createCollection({ name: "notes" });
      yield* tenant.documents.insert({
        collection: "notes", id: "n1", data: { body: "kept?" },
      });
      yield* tenant.schemas.save({
        collection: "notes",
        version: 1,
        fields: [{ name: "body", field: { _tag: "TextField", label: "Body", required: true } }],
      });

      yield* tenant.backups.restoreTenant(backup, { into: "purge" });

      assert.deepEqual(
        (yield* tenant.documents.listCollections()).map((c) => c.name), ["posts"]);
      assert.deepEqual(yield* tenant.schemas.listVersions("notes"), []);
      assert.deepEqual(yield* titles(tenant), ["p1:Atlas revised:v2", "p2:Beacon:v1"]);
    }),
  );
});

test("a merge writes the backup over what shares a name and leaves the rest", async (t) => {
  await withTenant(t, (tenant) =>
    Effect.gen(function* () {
      const backup = yield* original(tenant);

      yield* tenant.documents.update({
        collection: "posts", id: "p1", data: { title: "drifted" },
      });
      yield* tenant.documents.insert({
        collection: "posts", id: "p3", data: { title: "Cobalt" },
      });
      yield* tenant.documents.delete({ collection: "posts", id: "p2" });

      const result = yield* tenant.backups.restoreTenant(backup, { into: "merge" });
      assert.equal(result.removed, 0, "a merge discards nothing up front");
      assert.ok(result.superseded > 0, "and writes over the names it shares");

      const found = yield* titles(tenant);
      // p1 was written over, p2 was recreated, p3 was left alone.
      assert.ok(found.some((line) => line.startsWith("p1:Atlas revised:")));
      assert.ok(found.some((line) => line.startsWith("p2:Beacon:")));
      assert.ok(found.some((line) => line.startsWith("p3:Cobalt:")));
      assert.equal(found.length, 3);
    }),
  );
});

test("a merge lands over a record whose local history has moved on", async (t) => {
  await withTenant(t, (tenant) =>
    Effect.gen(function* () {
      const backup = yield* original(tenant);

      // Two more local versions, so p1 stands at v4.
      yield* tenant.documents.update({
        collection: "posts", id: "p1", data: { title: "third" },
      });
      yield* tenant.documents.update({
        collection: "posts", id: "p1", data: { title: "fourth" },
      });
      const before = yield* tenant.documents.findById({ collection: "posts", id: "p1" });
      assert.equal(before.version, 4);

      yield* tenant.backups.restoreTenant(backup, { into: "merge" });

      // The backup's versions for p1 start again at one, and a put no newer
      // than what is stored is ignored by design — the rule that lets a replica
      // re-consume a range it has already seen. So this assertion is the test
      // for the lift: without it both puts would be dropped as stale and the
      // title would still read "fourth".
      const after = yield* tenant.documents.findById({ collection: "posts", id: "p1" });
      assert.equal(after.data.title, "Atlas revised", "the backup won");

      // The document carries its own version field, restored from the backup as
      // written; it is not the store's record version and does not track it.
      assert.equal(after.version, 2);
    }),
  );
});

test("a backup belonging to another tenant is refused however it is labelled", async (t) => {
  await withTenant(t, (tenant, db) =>
    Effect.gen(function* () {
      const backup = yield* original(tenant);
      const fresh = db.forTenant("bravo");

      const labelled = yield* Effect.flip(fresh.backups.restoreTenant(backup));
      assert.equal(labelled._tag, "BackupTenantMismatch");
      assert.equal(labelled.received, "acme");

      // Relabelling the envelope does not change whose records are inside. It
      // used to be enough to get past the check, and under a merge that meant
      // looking those names up and writing over the tenant they really belong
      // to — which shares this shard.
      const relabelled = { ...backup, tenantId: "bravo" };
      const inside = yield* Effect.flip(
        fresh.backups.restoreTenant(relabelled, { into: "merge" }));
      assert.equal(inside._tag, "BackupTenantMismatch");
      assert.equal(inside.received, "acme");

      // And acme still reads as it did.
      assert.deepEqual(yield* titles(tenant), ["p1:Atlas revised:v2", "p2:Beacon:v1"]);
    }),
  );
});

test("purging twice is purging once", async (t) => {
  await withTenant(t, (tenant) =>
    Effect.gen(function* () {
      const backup = yield* original(tenant);
      yield* tenant.backups.restoreTenant(backup, { into: "purge" });
      const once = yield* titles(tenant);
      const second = yield* tenant.backups.restoreTenant(backup, { into: "purge" });
      assert.ok(second.removed > 0, "the first restore's records were cleared again");
      assert.deepEqual(yield* titles(tenant), once);
    }),
  );
});

test("a restore into a non-empty tenant leaves nothing indexed but unreachable", async (t) => {
  await withTenant(t, (tenant) =>
    Effect.gen(function* () {
      const backup = yield* original(tenant);
      yield* tenant.documents.update({
        collection: "posts", id: "p1", data: { title: "drifted" },
      });

      // The failure both modes exist to avoid: replaying blindly would repoint
      // the name at a new record and leave the old one in the lenses, matching
      // queries that nothing can reach. A query for the old value must find
      // nothing afterwards.
      for (const into of ["purge", "merge"]) {
        yield* tenant.backups.restoreTenant(backup, { into });
        const drifted = yield* tenant.documents.findMany({
          collection: "posts", where: [{ path: "title", value: "drifted" }],
        });
        assert.deepEqual(drifted, [], `${into} left the superseded record indexed`);

        const all = yield* tenant.documents.findMany({ collection: "posts" });
        assert.equal(all.length, 2, `${into} left a duplicate behind`);
        assert.deepEqual(all.map((d) => d.id).sort(), ["p1", "p2"]);
      }
    }),
  );
});

test("a backup taken after a restore round-trips again", async (t) => {
  await withTenant(t, (tenant) =>
    Effect.gen(function* () {
      const backup = yield* original(tenant);
      yield* tenant.documents.insert({
        collection: "posts", id: "p9", data: { title: "extra" },
      });

      yield* tenant.backups.restoreTenant(backup, { into: "purge" });
      const again = yield* tenant.backups.exportTenant();

      // Restoring what a restore produced has to give the same tenant, or the
      // format loses something each time it goes round.
      yield* tenant.backups.restoreTenant(again, { into: "purge" });
      assert.deepEqual(yield* titles(tenant), ["p1:Atlas revised:v2", "p2:Beacon:v1"]);
    }),
  );
});
