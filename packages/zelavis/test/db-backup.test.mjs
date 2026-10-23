import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Stream } from "effect";
import { backupsFor, documentsFor, makeDatabase, partitionMapFor, ZELAVIS_DB_BACKUP_V1 } from "../dist/db/index.js";
import { makeMemoryStore } from "../dist/db/engines/memory-kv.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const fields = [
  { name: "title", field: { _tag: "TextField", label: "Title", required: true } },
];

const withDb = (t, body) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-backup-"));
  const other = mkdtempSync(join(tmpdir(), "zv-restore-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* makeDatabase({
          partitionMap: partitionMapFor(["only"]),
          openShard: (shard) => makeNodeSqliteStore(shard, dir),
        });
        // A separate database standing in for the destination of a restore.
        const spare = yield* makeDatabase({
          partitionMap: partitionMapFor(["only"]),
          openShard: (shard) => makeNodeSqliteStore(shard, other),
        });
        return yield* body(db, spare);
      }),
    ),
  );
};

const populate = (tenant) =>
  Effect.gen(function* () {
    yield* tenant.documents.createCollection({ name: "posts" });
    yield* tenant.schemas.save({ collection: "posts", version: 1, fields });
    yield* tenant.documents.insert({ collection: "posts", id: "p1", data: { title: "Atlas" } });
    yield* tenant.documents.insert({ collection: "posts", id: "p2", data: { title: "Beacon" } });
    yield* tenant.documents.update({ collection: "posts", id: "p1", data: { title: "Cobalt" } });
    yield* tenant.documents.insert({ collection: "posts", id: "gone", data: { title: "Removed" } });
    yield* tenant.documents.delete({ collection: "posts", id: "gone" });
  });

test("backup: exports a tenant's log and restores it elsewhere", async (t) => {
  await withDb(t, (db, spare) =>
    Effect.gen(function* () {
      const source = db.forTenant("acme");
      yield* populate(source);

      const backup = yield* source.backups.exportTenant;
      assert.equal(backup.format, ZELAVIS_DB_BACKUP_V1);
      assert.equal(backup.tenantId, "acme");
      assert.ok(backup.events.length > 0);
      assert.ok(Date.parse(backup.exportedAt) > 0);

      // Round-trips through JSON: bytes survive as base64.
      const wire = JSON.parse(JSON.stringify(backup));

      const target = spare.forTenant("acme");
      const result = yield* target.backups.restoreTenant(wire);
      assert.equal(result.tenantId, "acme");
      assert.equal(result.events, backup.events.length);

      // Documents, collections and schemas all come back.
      assert.deepEqual((yield* target.documents.listCollections).map((c) => c.name), ["posts"]);
      const docs = yield* target.documents.findMany({ collection: "posts" });
      assert.deepEqual(docs.map((d) => d.id).sort(), ["p1", "p2"], "deleted document stays deleted");
      const p1 = yield* target.documents.findById({ collection: "posts", id: "p1" });
      assert.equal(p1.data.title, "Cobalt", "the latest version is restored");
      assert.equal(p1.version, 2, "revision history is preserved");
      assert.equal((yield* target.schemas.getActive("posts")).version, 1, "schema restored");

      // The schema is live, not just stored.
      const rejected = yield* target.documents
        .insert({ collection: "posts", data: { stray: 1 } })
        .pipe(Effect.as("accepted"), Effect.catchTag("SchemaViolation", () => Effect.succeed("rejected")));
      assert.equal(rejected, "rejected");

      // The source is untouched and the two are now independent.
      yield* target.documents.update({ collection: "posts", id: "p2", data: { title: "Changed" } });
      assert.equal((yield* source.documents.findById({ collection: "posts", id: "p2" })).data.title, "Beacon");
    }),
  );
});

test("backup: restoring into a populated shard does not disturb its other tenants", async (t) => {
  await withDb(t, (db, spare) =>
    Effect.gen(function* () {
      const source = db.forTenant("acme");
      yield* populate(source);

      const backup = yield* source.backups.exportTenant;

      // A different tenant already occupying sequence numbers in the destination.
      const other = spare.forTenant("globex");
      yield* other.documents.createCollection({ name: "posts" });
      yield* other.documents.insert({ collection: "posts", id: "p1", data: { title: "Neighbour" } });

      const target = spare.forTenant("acme");
      yield* target.backups.restoreTenant(backup);

      // Sequence numbers were remapped rather than reused.
      assert.equal(
        (yield* other.documents.findById({ collection: "posts", id: "p1" })).data.title,
        "Neighbour",
        "the neighbouring tenant was not overwritten",
      );
      assert.equal(
        (yield* target.documents.findById({ collection: "posts", id: "p1" })).data.title,
        "Cobalt",
      );
      assert.equal((yield* other.documents.findMany({ collection: "posts" })).length, 1);
    }),
  );
});

test("backup: a restore carries graph links to the records' new identifiers", async (t) => {
  await withDb(t, (db, spare) =>
    Effect.gen(function* () {
      const source = db.forTenant("acme").documents;
      yield* source.createCollection({ name: "people" });
      yield* source.createCollection({
        name: "teams",
        edges: [{ name: "members", path: "members", collection: "people" }],
      });
      yield* source.insert({ collection: "people", id: "alice", data: { name: "Alice" } });
      yield* source.insert({ collection: "people", id: "bob", data: { name: "Bob" } });
      yield* source.insert({ collection: "teams", id: "core", data: { members: ["alice", "bob"] } });
      const members = (docs) => Effect.map(
        docs.findMany({ collection: "people", linked: { collection: "teams", id: "core", edge: "members" } }),
        (found) => found.map((doc) => doc.id).sort(),
      );
      assert.deepEqual(yield* members(source), ["alice", "bob"]);
      const backup = yield* db.forTenant("acme").backups.exportTenant;

      // Another tenant already holds the low identifiers on the destination,
      // so the restored records are given different ones, and an edge copied
      // as it was would name the occupant's records or nothing.
      const occupant = spare.forTenant("globex").documents;
      yield* occupant.createCollection({ name: "people" });
      for (let i = 0; i < 5; i++) {
        yield* occupant.insert({ collection: "people", id: `g${i}`, data: { name: `G${i}` } });
      }
      yield* spare.forTenant("acme").backups.restoreTenant(backup);

      const restored = spare.forTenant("acme").documents;
      assert.deepEqual(yield* members(restored), ["alice", "bob"]);
      const teams = yield* restored.findMany({
        collection: "teams",
        linked: { collection: "teams", id: "alice", edge: "members", direction: "inbound" },
      });
      assert.deepEqual(teams.map((doc) => doc.id), ["core"], "and inbound, through the reverse postings");
    }),
  );
});

test("backup: an export taken while writes continue restores to one moment", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = (yield* makeMemoryStore("s0")).partition("acme");
    const docs = documentsFor(store, "acme");
    yield* docs.createCollection({ name: "pairs" });
    for (const id of ["a", "b", "c"]) yield* docs.insert({ collection: "pairs", id, data: { n: 1 } });
    const rewrite = (n) => docs.write({
      operations: ["a", "b", "c"].map((id) => ({ _tag: "Update", collection: "pairs", id, data: { n } })),
    });
    const seqOfA = yield* store.lookup("doc/pairs", "a");

    // The records are read while writes carry on. Stand in for one batch that
    // commits partway through the read: everything up to "a" read before the
    // batch, everything after it read once the batch has landed — what a scan
    // racing a writer could see, and on its own no single moment.
    const racing = {
      ...store,
      records: Stream.unwrap(Effect.gen(function* () {
        const before = [...(yield* Stream.runCollect(store.records))];
        yield* rewrite(2);
        const after = [...(yield* Stream.runCollect(store.records))];
        const cut = before.findIndex((entry) => Number(entry.seq) === Number(seqOfA));
        return Stream.fromIterable([...before.slice(0, cut + 1), ...after.slice(cut + 1)]);
      })),
    };
    const backup = yield* backupsFor(racing, "acme").exportTenant;

    const copy = (yield* makeMemoryStore("s1")).partition("acme");
    yield* backupsFor(copy, "acme").restoreTenant(backup);
    const values = [];
    for (const id of ["a", "b", "c"]) {
      values.push((yield* documentsFor(copy, "acme").findById({ collection: "pairs", id })).data.n);
    }
    // The export reads one snapshot of the store, taken as it began, so the
    // batch that landed while it ran is wholly absent from the copy rather
    // than half in it.
    assert.deepEqual(values, [1, 1, 1]);
  }))));

test("backup: refuses a foreign format, a mismatched tenant, and a populated one", async (t) => {
  await withDb(t, (db, spare) =>
    Effect.gen(function* () {
      const acme = db.forTenant("acme");
      const globex = db.forTenant("globex");
      yield* populate(acme);
      yield* globex.documents.createCollection({ name: "secrets" });
      yield* globex.documents.insert({ collection: "secrets", id: "s1", data: { title: "Private" } });

      const backup = yield* acme.backups.exportTenant;
      const serialized = JSON.stringify(backup);
      assert.ok(!serialized.includes("secrets"), "another tenant's collection is absent");
      assert.ok(!serialized.includes("Private"), "another tenant's data is absent");

      const badFormat = yield* acme.backups
        .restoreTenant({ ...backup, format: "something.else" })
        .pipe(Effect.as("restored"), Effect.catchTag("BackupFormatUnsupported", () => Effect.succeed("rejected")));
      assert.equal(badFormat, "rejected");

      // A backup carries lens keys naming its own tenant, so replaying it under
      // another name would store records no query for that name reaches.
      const wrongTenant = yield* spare.forTenant("elsewhere").backups
        .restoreTenant(backup)
        .pipe(Effect.as("restored"), Effect.catchTag("BackupTenantMismatch", () => Effect.succeed("rejected")));
      assert.equal(wrongTenant, "rejected");

      // Restoring over live data would repoint keys and orphan what is there.
      const occupied = yield* acme.backups
        .restoreTenant(backup)
        .pipe(Effect.as("restored"), Effect.catchTag("TenantNotEmpty", () => Effect.succeed("rejected")));
      assert.equal(occupied, "rejected");
    }),
  );
});

test("backup: derived state is rebuilt rather than carried", async (t) => {
  await withDb(t, (db, spare) =>
    Effect.gen(function* () {
      const source = db.forTenant("acme");
      yield* source.documents.createCollection({ name: "posts" });
      yield* source.documents.insert({ collection: "posts", id: "p1", data: { title: "Atlas" } });

      let applied = 0;
      yield* source.projections.register({
        name: "count",
        apply: () => Effect.sync(() => { applied++; }),
      });
      yield* source.projections.run("count");
      assert.equal(applied, 2);

      const backup = yield* source.backups.exportTenant;
      assert.ok(
        !JSON.stringify(backup).includes("zv.checkpoint"),
        "a checkpoint is a position in one shard's log and is not carried",
      );

      // The restored tenant replays from the beginning rather than resuming
      // at a position that belonged to a different log.
      const target = spare.forTenant("acme");
      yield* target.backups.restoreTenant(backup);
      let replayed = 0;
      yield* target.projections.register({
        name: "count",
        apply: () => Effect.sync(() => { replayed++; }),
      });
      yield* target.projections.run("count");
      assert.equal(replayed, 2, "projection rebuilds from the restored log");
    }),
  );
});
