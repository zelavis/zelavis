import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeDatabase, partitionMapFor } from "../dist/dbnew/index.js";
import { makeNodeSqliteStore } from "../dist/dbnew/adapters/node-sqlite.js";

const withDb = (t, shards, body) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-events-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* makeDatabase({
          partitionMap: partitionMapFor(shards),
          nodeId: "node-a",
          openShard: (shard) => makeNodeSqliteStore(shard, dir),
        });
        return yield* body(db);
      }),
    ),
  );
};

test("events: document writes produce a readable domain log", async (t) => {
  await withDb(t, ["only"], (db) =>
    Effect.gen(function* () {
      const { documents, events } = db.forTenant("acme");
      yield* documents.createCollection({ name: "posts" });
      yield* documents.insert({ collection: "posts", id: "p1", data: { title: "Atlas" } });
      yield* documents.update({ collection: "posts", id: "p1", data: { title: "Beacon" } });
      yield* documents.delete({ collection: "posts", id: "p1" });

      const log = yield* events.read();
      assert.deepEqual(
        log.map((e) => e.type),
        ["collection.created", "document.upserted", "document.upserted", "document.deleted"],
      );

      const [created, inserted, updated, deleted] = log;
      assert.equal(created.collection, "posts");
      assert.equal(created.documentId, undefined, "collection events have no document");
      assert.equal(inserted.documentId, "p1");
      assert.deepEqual(inserted.payload.data, { title: "Atlas" });
      assert.deepEqual(updated.payload.data, { title: "Beacon" });
      assert.equal(updated.revision, inserted.revision + 1, "revision advances");
      assert.deepEqual(deleted.payload, { deleted: true });
      assert.equal(deleted.documentId, "p1", "a delete is attributed to its document");

      for (const event of log) {
        assert.equal(event.tenantId, "acme");
        assert.equal(event.nodeId, "node-a");
        assert.ok(Date.parse(event.timestamp) > 0, "timestamp is a real instant");
        assert.ok(event.eventId.length > 0);
      }
    }),
  );
});

test("events: filtering, continuation, and tenant scoping", async (t) => {
  await withDb(t, ["only"], (db) =>
    Effect.gen(function* () {
      const acme = db.forTenant("acme");
      const globex = db.forTenant("globex");

      yield* acme.documents.createCollection({ name: "posts" });
      yield* acme.documents.createCollection({ name: "pages" });
      yield* acme.documents.insert({ collection: "posts", id: "p1", data: { n: 1 } });
      yield* acme.documents.insert({ collection: "pages", id: "g1", data: { n: 2 } });
      yield* globex.documents.createCollection({ name: "posts" });
      yield* globex.documents.insert({ collection: "posts", id: "p1", data: { n: 99 } });

      const mine = yield* acme.events.read();
      assert.equal(mine.length, 4, "another tenant's writes are not in my log");
      assert.ok(mine.every((e) => e.tenantId === "acme"));

      const posts = yield* acme.events.read({ collection: "posts" });
      assert.deepEqual(posts.map((e) => e.collection), ["posts", "posts"]);

      const byDoc = yield* acme.events.read({ documentId: "p1" });
      assert.deepEqual(byDoc.map((e) => e.documentId), ["p1"]);

      // Continuation by opaque cursor picks up exactly where it left off.
      const first = yield* acme.events.read({ limit: 2 });
      assert.equal(first.length, 2);
      const rest = yield* acme.events.read({ after: first[1].cursor });
      assert.deepEqual([...first, ...rest].map((e) => e.eventId), mine.map((e) => e.eventId));

      const atEnd = yield* acme.events.read({ after: mine[mine.length - 1].cursor });
      assert.deepEqual(atEnd, [], "nothing after the last cursor");
    }),
  );
});

test("projections: run advances a checkpoint, rebuild replays from the start", async (t) => {
  await withDb(t, ["only"], (db) =>
    Effect.gen(function* () {
      const { documents, projections } = db.forTenant("acme");
      yield* documents.createCollection({ name: "posts" });

      let seen = [];
      yield* projections.register({
        name: "titles",
        description: "collects post titles",
        source: { collections: ["posts"], eventTypes: ["document.upserted"] },
        apply: (event) => Effect.sync(() => seen.push(event.payload.data.title)),
        reset: () => Effect.sync(() => { seen = []; }),
      });

      yield* documents.insert({ collection: "posts", id: "p1", data: { title: "Atlas" } });
      yield* documents.insert({ collection: "posts", id: "p2", data: { title: "Beacon" } });

      const first = yield* projections.run("titles");
      assert.equal(first.applied, 2, "source filter excluded collection.created");
      assert.deepEqual(seen, ["Atlas", "Beacon"]);
      assert.ok(first.checkpoint, "checkpoint recorded");

      // Running again from the checkpoint applies nothing new.
      const idle = yield* projections.run("titles");
      assert.equal(idle.applied, 0, "checkpoint prevents reprocessing");
      assert.deepEqual(seen, ["Atlas", "Beacon"]);

      yield* documents.insert({ collection: "posts", id: "p3", data: { title: "Cobalt" } });
      const incremental = yield* projections.run("titles");
      assert.equal(incremental.applied, 1, "only the new event");
      assert.deepEqual(seen, ["Atlas", "Beacon", "Cobalt"]);

      // A rebuild discards derived state and replays the whole log.
      const rebuilt = yield* projections.rebuild("titles");
      assert.equal(rebuilt.applied, 3);
      assert.deepEqual(seen, ["Atlas", "Beacon", "Cobalt"], "replay is deterministic");

      const listed = yield* projections.list();
      assert.equal(listed.length, 1);
      assert.equal(listed[0].name, "titles");
      assert.deepEqual(listed[0].sourceCollections, ["posts"]);
      assert.ok(listed[0].checkpoint);

      const missing = yield* projections.run("absent").pipe(
        Effect.as("ran"),
        Effect.catchTag("ProjectionNotFound", () => Effect.succeed("missing")),
      );
      assert.equal(missing, "missing");
    }),
  );
});

test("projections: checkpoints are per tenant and survive reopening", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-checkpoint-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const partitionMap = partitionMapFor(["only"]);
  const open = (body) =>
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

  const counts = { acme: 0, globex: 0 };
  const projection = (tenant) => ({
    name: "counter",
    apply: () => Effect.sync(() => { counts[tenant]++; }),
  });

  await open((db) =>
    Effect.gen(function* () {
      for (const tenant of ["acme", "globex"]) {
        const t = db.forTenant(tenant);
        yield* t.documents.createCollection({ name: "posts" });
        yield* t.documents.insert({ collection: "posts", id: "a", data: {} });
        yield* t.projections.register(projection(tenant));
        yield* t.projections.run("counter");
      }
      assert.deepEqual(counts, { acme: 2, globex: 2 }, "each tenant sees only its own events");
    }),
  );

  // A new process, the same files: the checkpoint is durable, so nothing replays.
  await open((db) =>
    Effect.gen(function* () {
      const t = db.forTenant("acme");
      yield* t.projections.register(projection("acme"));
      const result = yield* t.projections.run("counter");
      assert.equal(result.applied, 0, "durable checkpoint survives reopening");
      assert.equal(counts.acme, 2);
    }),
  );
});
