import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Stream } from "effect";
import { and, asSeq, equals, term } from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const enc = new TextEncoder();
const row = (n, region, words) => ({
  bytes: enc.encode(JSON.stringify({ n, region })),
  manifest: {
    terms: words.map((w) => ["title", w]),
    columns: [["region", region]],
    measures: [["visits", n * 10]],
    edges: [["uses", 1_000_000 + (n % 3)]],
  },
});

const withStore = (t, body) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-compact-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Effect.runPromise(
    Effect.scoped(Effect.gen(function* () {
      const store = yield* makeNodeSqliteStore("acme", dir);
      return yield* body(store);
    })),
  );
};

const seqs = (store, q) => Effect.map(Stream.runCollect(store.resolve(q)), (c) => [...c]);

// A record rewritten many times: the case compaction exists for, where storage
// tracks writes rather than what is still there.
const churn = (store, times) =>
  Effect.gen(function* () {
    yield* store.transact((txn) =>
      txn.put(asSeq(1), row(1, "eu-west", ["atlas"]).bytes, row(1, "eu-west", ["atlas"]).manifest,
        { namespace: "doc/acme/posts", key: "p1" }));
    for (let i = 2; i <= times; i++) {
      const r = row(i, i === times ? "us-east" : "eu-west", [i === times ? "beacon" : "atlas"]);
      yield* store.transact((txn) =>
        txn.put(asSeq(1), r.bytes, r.manifest, { namespace: "doc/acme/posts", key: "p1" }));
    }
  });

test("compaction removes history and keeps everything a query needs", async (t) => {
  await withStore(t, (store) =>
    Effect.gen(function* () {
      yield* churn(store, 20);
      assert.equal([...(yield* Stream.runCollect(store.events.read({ limit: 100 })))].length, 20);

      const result = yield* store.compact();
      assert.equal(result.removed, 20, "all history removed");
      assert.ok(result.compactedTo > 0);
      assert.equal(yield* store.compactedTo, result.compactedTo);

      assert.deepEqual([...(yield* Stream.runCollect(store.events.read({ limit: 100 })))], [],
        "the log is empty");

      // Everything a reader needs is state, not history.
      assert.deepEqual(yield* seqs(store, term("title", "beacon")), [1], "postings intact");
      assert.deepEqual(yield* seqs(store, term("title", "atlas")), [], "stale posting still gone");
      assert.deepEqual(yield* seqs(store, equals("region", "us-east")), [1]);
      assert.equal(yield* store.lookup("doc/acme/posts", "p1"), 1, "identity intact");
      assert.equal((yield* store.read(asSeq(1))).version, 20, "version intact");
      assert.equal([...(yield* store.measure("visits"))][1], 200, "measure intact");
    }),
  );
});

test("compaction can keep a tail of recent history", async (t) => {
  await withStore(t, (store) =>
    Effect.gen(function* () {
      yield* churn(store, 10);
      const result = yield* store.compact({ keep: 3 });
      assert.equal(result.removed, 7);
      const left = [...(yield* Stream.runCollect(store.events.read({ limit: 100 })))];
      assert.equal(left.length, 3, "the newest three survive");
      assert.deepEqual(left.map((e) => e.version), [8, 9, 10]);
    }),
  );
});

test("a cursor from before the cut is refused rather than silently continued", async (t) => {
  await withStore(t, (store) =>
    Effect.gen(function* () {
      yield* churn(store, 10);
      const early = [...(yield* Stream.runCollect(store.events.read({ limit: 2 })))];
      const staleCursor = early[1].cursor;

      yield* store.compact({ keep: 2 });

      // Continuing here would skip writes the follower can never obtain again,
      // so it fails instead of returning a partial tail.
      const outcome = yield* Stream.runCollect(store.events.read({ after: staleCursor })).pipe(
        Effect.as("continued"),
        Effect.catchTag("CursorCompacted", (e) => Effect.succeed(e)),
      );
      assert.notEqual(outcome, "continued");
      assert.equal(outcome._tag, "CursorCompacted");
      assert.ok(outcome.compactedTo > outcome.requested);

      // A cursor after the cut still works.
      const recent = [...(yield* Stream.runCollect(store.events.read({ limit: 1 })))];
      const fresh = yield* Stream.runCollect(store.events.read({ after: recent[0].cursor }));
      assert.equal([...fresh].length, 1);
    }),
  );
});

test("reindex rebuilds postings from state, and full replay refuses on a cut log", async (t) => {
  await withStore(t, (store) =>
    Effect.gen(function* () {
      yield* churn(store, 6);
      yield* store.compact();

      const refused = yield* store.rebuildLenses.pipe(
        Effect.as("replayed"),
        Effect.catchTag("LogCompacted", () => Effect.succeed("refused")),
      );
      assert.equal(refused, "refused", "a partial replay would report a whole one");

      const reindexed = yield* store.reindexLenses;
      assert.equal(reindexed, 1, "one live record re-derived");
      assert.deepEqual(yield* seqs(store, term("title", "beacon")), [1]);
      assert.deepEqual(yield* seqs(store, equals("region", "us-east")), [1]);
      assert.deepEqual(yield* seqs(store, term("title", "atlas")), [],
        "reindex does not resurrect what the manifest no longer claims");
      assert.equal((yield* store.read(asSeq(1))).version, 6, "state untouched");
    }),
  );
});

test("a backup taken after compaction still restores the whole tenant", async (t) => {
  const source = mkdtempSync(join(tmpdir(), "zv-compact-src-"));
  const target = mkdtempSync(join(tmpdir(), "zv-compact-dst-"));
  t.after(() => {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });

  const { makeDatabase, partitionMapFor } = await import("../dist/db/index.js");
  const open = (dir, body) =>
    Effect.runPromise(
      Effect.scoped(Effect.gen(function* () {
        const db = yield* makeDatabase({
          partitionMap: partitionMapFor(["only"]),
          openShard: (shard) => makeNodeSqliteStore(shard, dir),
        });
        return yield* body(db);
      })),
    );

  const backup = await open(source, (db) =>
    Effect.gen(function* () {
      const tenant = db.forTenant("acme");
      yield* tenant.documents.createCollection({ name: "posts" });
      yield* tenant.documents.insert({ collection: "posts", id: "p1", data: { title: "Atlas" } });
      yield* tenant.documents.insert({ collection: "posts", id: "p2", data: { title: "Beacon" } });
      yield* tenant.documents.update({ collection: "posts", id: "p1", data: { title: "Cobalt" } });
      yield* tenant.documents.insert({ collection: "posts", id: "gone", data: { title: "Removed" } });
      yield* tenant.documents.delete({ collection: "posts", id: "gone" });

      // Drop the history the tenant was built from. Exporting the remaining
      // log would produce a backup missing every record whose creation was
      // compacted away, so the export has to come from state instead.
      const cut = yield* db.maintenance.compact();
      assert.ok(cut.some((shard) => shard.removed > 0), "there was history to drop");

      return yield* tenant.backups.exportTenant;
    }),
  );

  // Compaction happened before the export in the store the tenant sits on, so
  // this is the state-derived path rather than a copy of the log.
  assert.ok(backup.events.length > 0);
  assert.ok(backup.events.every((e) => e.kind === "put"), "state exports as puts");

  await open(target, (db) =>
    Effect.gen(function* () {
      const tenant = db.forTenant("acme");
      const result = yield* tenant.backups.restoreTenant(JSON.parse(JSON.stringify(backup)));
      assert.ok(result.events > 0);

      assert.deepEqual((yield* tenant.documents.listCollections).map((c) => c.name), ["posts"]);
      const docs = yield* tenant.documents.findMany({ collection: "posts" });
      assert.deepEqual(docs.map((d) => d.id).sort(), ["p1", "p2"], "the deleted one stays deleted");
      const p1 = yield* tenant.documents.findById({ collection: "posts", id: "p1" });
      assert.equal(p1.data.title, "Cobalt", "the latest version restored");
    }),
  );
});
