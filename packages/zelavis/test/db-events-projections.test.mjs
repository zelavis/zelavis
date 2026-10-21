import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeDatabase, partitionMapFor } from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const withDb = (t, shards, body) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-events-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* makeDatabase({
          partitionMap: partitionMapFor(shards),
          nodeId: "node-a",
          // The node opening a shard is the one its events name as their writer.
          openShard: (shard, { origin }) => makeNodeSqliteStore(shard, dir, { origin }),
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

      const log = (yield* events.read()).events;
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

      const mine = (yield* acme.events.read()).events;
      assert.equal(mine.length, 4, "another tenant's writes are not in my log");
      assert.ok(mine.every((e) => e.tenantId === "acme"));

      const posts = (yield* acme.events.read({ collection: "posts" })).events;
      assert.deepEqual(posts.map((e) => e.collection), ["posts", "posts"]);

      const byDoc = (yield* acme.events.read({ documentId: "p1" })).events;
      assert.deepEqual(byDoc.map((e) => e.documentId), ["p1"]);

      // Continuation by opaque cursor picks up exactly where it left off.
      const first = yield* acme.events.read({ limit: 2 });
      assert.equal(first.events.length, 2);
      assert.equal(first.more, true, "a full page may have more behind it");
      const rest = yield* acme.events.read({ after: first.cursor });
      assert.equal(rest.more, false);
      assert.deepEqual([...first.events, ...rest.events].map((e) => e.eventId), mine.map((e) => e.eventId));

      const atEnd = yield* acme.events.read({ after: mine[mine.length - 1].cursor });
      assert.deepEqual(atEnd.events, [], "nothing after the last cursor");
      assert.equal(atEnd.more, false);
    }),
  );
});

/** Every item from `after` to the end of the log, following each page's cursor. */
const readToEnd = (read, items, after) =>
  Effect.gen(function* () {
    const out = [];
    let cursor = after;
    let reads = 0;
    for (;;) {
      const page = yield* read(cursor);
      reads += 1;
      out.push(...items(page));
      cursor = page.cursor ?? cursor;
      if (!page.more) return { items: out, cursor, reads };
    }
  });

test("events: a long run of other writes never stalls a reader", async (t) => {
  await withDb(t, ["only"], (db) =>
    Effect.gen(function* () {
      // One shard, but each tenant writes a log of its own, so the other
      // tenant's writes are never in the way. A tenant's own writes to another
      // collection are: a read looks at a bounded stretch of the log, so its
      // cursor has to move past everything it looked at, or a reader behind a
      // long run of them would be handed the same empty answer on every call.
      const acme = db.forTenant("acme");
      const globex = db.forTenant("globex");
      yield* acme.documents.createCollection({ name: "posts" });
      yield* acme.documents.createCollection({ name: "pages" });
      yield* globex.documents.createCollection({ name: "posts" });

      const titles = [];
      yield* acme.projections.register({
        name: "titles",
        source: { collections: ["posts"], eventTypes: ["document.upserted"] },
        apply: (event) => Effect.sync(() => titles.push(event.payload.data.title)),
      });
      yield* acme.documents.insert({ collection: "posts", id: "p1", data: { title: "Atlas" } });
      assert.equal((yield* acme.projections.run("titles")).applied, 1);
      const eventsAt = (yield* readToEnd((after) => acme.events.read({ after }), (page) => page.events)).cursor;
      const posts = acme.kv.namespace("posts");
      const changesAt = (yield* readToEnd((after) => posts.changes({ after }), (page) => page.changes)).cursor;

      for (let i = 0; i < 500; i++) {
        yield* globex.documents.insert({ collection: "posts", id: `g${i}`, data: { title: `G${i}` } });
      }
      for (let i = 0; i < 5000; i++) {
        yield* acme.documents.insert({ collection: "pages", id: `a${i}`, data: { title: `A${i}` } });
      }
      yield* acme.documents.insert({ collection: "posts", id: "p2", data: { title: "Beacon" } });

      const first = yield* acme.events.read({ collection: "posts", after: eventsAt });
      assert.deepEqual(first.events, [], "nothing of this collection in the stretch one read looks at");
      assert.equal(first.more, true);
      assert.notEqual(first.cursor, eventsAt, "but the cursor moved past what it looked at");

      const events = yield* readToEnd(
        (after) => acme.events.read({ collection: "posts", after }),
        (page) => page.events,
        eventsAt,
      );
      assert.deepEqual(events.items.map((event) => event.documentId), ["p2"]);
      assert.ok(events.reads > 1, "the stretch took more than one read");

      const changes = yield* readToEnd((after) => posts.changes({ after }), (page) => page.changes, changesAt);
      assert.deepEqual(changes.items.map((change) => change.key), ["p2"]);

      assert.equal((yield* acme.projections.run("titles")).applied, 1);
      assert.deepEqual(titles, ["Atlas", "Beacon"]);

      // An idle run writes no checkpoint: the only thing past the last one is
      // that checkpoint itself, and writing another for it would make every
      // run a write.
      assert.equal((yield* acme.projections.run("titles")).applied, 0);
      const settled = (yield* readToEnd((after) => acme.events.read({ after }), (page) => page.events)).cursor;
      assert.equal((yield* acme.projections.run("titles")).applied, 0);
      assert.equal((yield* acme.events.read({ after: settled })).cursor, settled, "nothing was written");
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

      const listed = yield* projections.list;
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
