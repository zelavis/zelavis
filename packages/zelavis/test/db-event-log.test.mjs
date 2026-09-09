import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Stream } from "effect";
import { and, asSeq, equals, term } from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const enc = new TextEncoder();

const row = (seq, region, words, plugin) => ({
  bytes: enc.encode(JSON.stringify({ seq, region, words })),
  manifest: {
    terms: words.map((w) => ["title", w]),
    columns: [["region", region]],
    measures: [["visits", seq * 10]],
    edges: [["uses", 1_000_000 + plugin]],
  },
});

const FIXTURES = [
  row(1, "eu-west", ["atlas", "beacon"], 17),
  row(2, "eu-west", ["atlas", "cobalt"], 17),
  row(3, "us-east", ["atlas"], 18),
];

const seqs = (store, query) =>
  Effect.map(Stream.runCollect(store.resolve(query)), (c) => [...c]);

const ingest = (store) =>
  store.transact((txn) =>
    Effect.forEach(FIXTURES, (r, i) => txn.put(asSeq(i + 1), r.bytes, r.manifest)),
  );


const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-db-log-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("event log is the source of truth: lenses rebuild from it alone", async (t) => {
  const dir = tempDir(t);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* makeNodeSqliteStore("acme", dir);
        yield* ingest(store);

        const query = and(term("title", "atlas"), equals("region", "eu-west"));
        const before = yield* seqs(store, query);
        assert.deepEqual(before, [1, 2]);

        // Drop every lens and re-derive purely from the log.
        const applied = yield* store.rebuildLenses;
        assert.equal(applied, 3, "one event per write");

        const after = yield* seqs(store, query);
        assert.deepEqual(after, before, "rebuilt lenses match");

        const visits = yield* store.measure("visits");
        assert.equal(after.reduce((s, x) => s + visits[x], 0), 30, "measures rebuilt");
      }),
    ),
  );
});

test("log replicates to a follower, and applying twice changes nothing", async (t) => {
  const dir = tempDir(t);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const leader = yield* makeNodeSqliteStore("leader", dir);
        const follower = yield* makeNodeSqliteStore("follower", dir);
        yield* ingest(leader);
        yield* leader.transact((txn) => txn.retract(asSeq(3)));

        const drain = Effect.gen(function* () {
          const batch = yield* Stream.runCollect(leader.events.read());
          yield* Effect.forEach([...batch], (e) => follower.events.apply(e));
          return [...batch];
        });

        const first = yield* drain;
        assert.equal(first.length, 4, "3 puts + 1 retract");

        const query = term("title", "atlas");
        assert.deepEqual(yield* seqs(follower, query), yield* seqs(leader, query));
        assert.deepEqual(yield* seqs(follower, query), [1, 2], "retracted row is gone");

        // Re-consume the same range: idempotent by (seq, version).
        yield* drain;
        assert.deepEqual(yield* seqs(follower, query), [1, 2], "no duplicate projection");
      }),
    ),
  );
});

test("cursors continue exactly and are rejected across partitions", async (t) => {
  const dir = tempDir(t);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const a = yield* makeNodeSqliteStore("alpha", dir);
        const b = yield* makeNodeSqliteStore("beta", dir);
        yield* ingest(a);

        const head = yield* a.events.head;
        assert.ok(head, "head cursor exists");

        const firstTwo = [...(yield* Stream.runCollect(a.events.read({ limit: 2 })))];
        assert.equal(firstTwo.length, 2);

        const rest = [
          ...(yield* Stream.runCollect(a.events.read({ after: firstTwo[1].cursor }))),
        ];
        assert.equal(rest.length, 1, "continuation resumes after the cursor");
        assert.equal(rest[0].seq, 3);

        assert.deepEqual(
          [...(yield* Stream.runCollect(a.events.read({ after: head })))],
          [],
          "nothing after head",
        );

        // A cursor issued by another partition must not be honoured.
        const outcome = yield* Stream.runCollect(b.events.read({ after: head })).pipe(
          Effect.as("read"),
          Effect.catchTag("ForeignCursor", () => Effect.succeed("rejected")),
        );
        assert.equal(outcome, "rejected");
      }),
    ),
  );
});

test("a superseded writer is fenced", async (t) => {
  const dir = tempDir(t);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const stale = yield* makeNodeSqliteStore("acme", dir);
        assert.equal(stale.generation, 1);

        // Opening the partition again claims the next generation.
        const current = yield* makeNodeSqliteStore("acme", dir);
        assert.equal(current.generation, 2);

        const rejected = yield* stale
          .transact((txn) => txn.put(asSeq(1), FIXTURES[0].bytes, FIXTURES[0].manifest))
          .pipe(
            Effect.as("wrote"),
            Effect.catchTag("WriterFenced", () => Effect.succeed("fenced")),
          );
        assert.equal(rejected, "fenced", "stale generation refused");

        yield* current.transact((txn) =>
          txn.put(asSeq(1), FIXTURES[0].bytes, FIXTURES[0].manifest),
        );
        assert.deepEqual(yield* seqs(current, term("title", "atlas")), [1]);
      }),
    ),
  );
});
