import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Stream } from "effect";
import { and, asSeq, equals, term } from "../dist/db/index.js";
import { makeLibsqlStore } from "../dist/db/engines/libsql.js";
import { openNodeDatabase } from "../dist/db/node-host.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const enc = new TextEncoder();
const row = (seq, region, words) => ({
  bytes: enc.encode(JSON.stringify({ seq, region })),
  manifest: {
    terms: words.map((w) => ["title", w]),
    columns: [["region", region]],
    measures: [["visits", seq * 10]],
    edges: [["uses", 1_000_000 + (seq % 3)]],
  },
});

const FIXTURES = [
  row(1, "eu-west", ["atlas", "beacon"]),
  row(2, "eu-west", ["atlas", "cobalt"]),
  row(3, "us-east", ["atlas"]),
];

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-libsql-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const exercise = (store) =>
  Effect.gen(function* () {
    yield* store.transact((txn) =>
      Effect.forEach(FIXTURES, (r, i) => txn.put(asSeq(i + 1), r.bytes, r.manifest), {
        discard: true,
      }),
    );
    const seqs = (q) => Effect.map(Stream.runCollect(store.resolve(q)), (c) => [...c]);
    return {
      doc: yield* seqs(term("title", "atlas")),
      col: yield* seqs(equals("region", "eu-west")),
      cross: yield* seqs(and(term("title", "atlas"), equals("region", "eu-west"))),
      measures: [...(yield* store.measure("visits"))].sort(([a], [b]) => a - b),
      events: (yield* Stream.runCollect(store.events.read())).length,
    };
  });

test("libsql and the built-in driver agree, running the same store logic", async (t) => {
  const libsqlDir = tempDir(t);
  const nodeDir = tempDir(t);

  const [viaLibsql, viaNode] = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const a = (yield* makeLibsqlStore("acme", { directory: libsqlDir })).partition("acme");
        const b = (yield* makeNodeSqliteStore("acme", nodeDir)).partition("acme");
        return [yield* exercise(a), yield* exercise(b)];
      }),
    ),
  );

  // Both drivers share storeOverGateway, so a difference here would mean the
  // gateway is not actually interchangeable.
  assert.deepEqual(viaLibsql, viaNode, "the two engines return identical results");
  assert.deepEqual(viaLibsql.doc, [1, 2, 3]);
  assert.deepEqual(viaLibsql.cross, [1, 2]);
});

test("libsql: retraction, rebuild and identity behave as on the built-in driver", async (t) => {
  const dir = tempDir(t);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = (yield* makeLibsqlStore("acme", { directory: dir })).partition("acme");
        const seqs = (q) => Effect.map(Stream.runCollect(store.resolve(q)), (c) => [...c]);

        yield* store.transact((txn) =>
          txn.put(asSeq(1), FIXTURES[0].bytes, FIXTURES[0].manifest, {
            namespace: "doc/acme/posts",
            key: "p1",
          }),
        );
        assert.equal(yield* store.lookup("doc/acme/posts", "p1"), 1, "identity round-trips");

        // Updating must retract the previous version's postings.
        yield* store.transact((txn) =>
          txn.put(asSeq(1), FIXTURES[2].bytes, FIXTURES[2].manifest, {
            namespace: "doc/acme/posts",
            key: "p1",
          }),
        );
        assert.deepEqual(yield* seqs(equals("region", "eu-west")), [], "stale posting retracted");
        assert.deepEqual(yield* seqs(equals("region", "us-east")), [1]);

        const applied = yield* store.rebuildLenses;
        assert.ok(applied > 0, "the log rebuilds the lenses");
        assert.deepEqual(yield* seqs(equals("region", "us-east")), [1], "rebuild matches");

        yield* store.transact((txn) => txn.retract(asSeq(1)));
        assert.deepEqual(yield* seqs(equals("region", "us-east")), []);
        assert.equal(yield* store.lookup("doc/acme/posts", "p1"), undefined);
      }),
    ),
  );
});

test("libsql backs a full sharded database through the same runtime api", async (t) => {
  const dir = tempDir(t);
  await (async () => {
        const opened = await openNodeDatabase({
          directory: dir, nodeId: "libsql-node", engine: { name: "libsql" },
        });
        const api = opened.api;
        {
          const tenant = api.forTenant("acme");
          await tenant.documents.createCollection({ name: "posts" });
          await tenant.documents.insert({
            collection: "posts", id: "p1", data: { title: "Atlas", region: "eu" },
          });
          const found = await tenant.documents.findMany({
            collection: "posts", where: [{ path: "region", value: "eu" }],
          });
          assert.deepEqual(found.map((d) => d.id), ["p1"]);

          const views = await tenant.systemViews.query({ name: "collections" });
          assert.deepEqual(views.rows.map((r) => r.id), ["posts"]);

          const backup = await tenant.backups.exportTenant();
          assert.ok(backup.events.length > 0, "the log is readable for backup");
        }
        assert.equal(opened.partitionMap.placements.length, 4, "sharded from creation");
        assert.equal(opened.engine, "libsql");
        await opened.close();
  })();
});

test("the host opens libsql through engine selection", async (t) => {
  const dir = tempDir(t);
  const opened = await openNodeDatabase({
    directory: dir, nodeId: "libsql-host", engine: { name: "libsql" },
  });
  assert.equal(opened.api.context.nodeId, "libsql-host");
  assert.equal(opened.partitionMap.placements.length, 4);

  const tenant = opened.api.forTenant("acme");
  await tenant.documents.createCollection({ name: "posts" });
  await tenant.documents.insert({ collection: "posts", id: "p1", data: { title: "Atlas" } });
  await opened.close();

  // The stored partition map is durable across a close, as on the built-in driver.
  const again = await openNodeDatabase({ directory: dir, engine: { name: "libsql" } });
  t.after(() => again.close());
  assert.equal(again.api.shardOf("acme"), opened.api.shardOf("acme"));
  const found = await again.api.forTenant("acme").documents.findById({
    collection: "posts", id: "p1",
  });
  assert.equal(found.data.title, "Atlas");
});

test("libsql: a snapshot reads the file as it was when taken, through a connection of its own", async (t) => {
  const { makeLibsqlEngine } = await import("../dist/db/engines/libsql.js");
  const dir = tempDir(t);
  const key = (...parts) => Uint8Array.from(parts);
  const text = (b) => new TextDecoder().decode(b);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const engine = yield* makeLibsqlEngine("kv", { directory: dir });
    yield* engine.write([{ op: "put", key: key(1, 1), value: enc.encode("one") }]);
    yield* Effect.scoped(Effect.gen(function* () {
      const snapshot = yield* engine.snapshot;
      yield* engine.write([{ op: "put", key: key(1, 1), value: enc.encode("ONE") }, { op: "put", key: key(1, 2), value: enc.encode("two") }]);
      assert.equal(text(yield* snapshot.get(key(1, 1))), "one");
      assert.equal(yield* snapshot.get(key(1, 2)), undefined);
      assert.deepEqual([...(yield* Stream.runCollect(snapshot.scan(key(1))))].map((entry) => text(entry.value)), ["one"]);
    }));
    assert.equal(text(yield* engine.get(key(1, 1))), "ONE");
  })));
});

test("libsql: an in-memory database is refused, since a snapshot needs a second connection to its file", async () => {
  const { makeLibsqlEngine } = await import("../dist/db/engines/libsql.js");
  const failure = await Effect.runPromise(Effect.scoped(Effect.flip(makeLibsqlEngine("kv", { directory: ":memory:" }))));
  assert.equal(failure._tag, "StoreError");
  assert.match(String(failure.cause), /needs a directory/);
});
