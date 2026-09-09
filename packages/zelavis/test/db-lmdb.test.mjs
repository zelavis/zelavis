// The object-store contract over LMDB. A memory-mapped B+tree, where a read is a pointer into a page.
//
// The store is built entirely on the key-value interface, and
// `db-kv-engines.test.mjs` holds every engine to that interface. This is the
// composition above it: the same lens assertions the other engines pass, run
// against a store actually opened on lmdb, so a driver that satisfies the
// interface and still breaks the store above it fails here.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Stream } from "effect";
import { and, asSeq, edge, equals, term } from "../dist/db/index.js";
import { makeLmdbStore } from "../dist/db/engines/lmdb.js";
import { engineAvailable } from "./_engine-available.mjs";

const enc = new TextEncoder();
const dec = new TextDecoder();

// An optional peer, so a checkout without it is ordinary rather than broken.
const installed = engineAvailable("lmdb");
const skip = installed ? false : "lmdb is not installed";

const site = (seq, region, plugins, words) => ({
  bytes: enc.encode(JSON.stringify({ seq, region, plugins, title: words.join(" ") })),
  manifest: {
    terms: words.map((w) => ["title", w]),
    columns: [["region", region]],
    measures: [["visits", seq * 10]],
    edges: plugins.map((p) => ["uses", 1_000_000 + p]),
  },
});

/** Opens a store on LMDB itself, rather than on whatever the host defaults to. */
const withStore = (t, body) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-lmdb-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Effect.runPromise(
    Effect.scoped(Effect.gen(function* () {
      return yield* body(yield* makeLmdbStore("acme", dir));
    })),
  );
};

test("lmdb: one payload, many lenses, resolved through a shared seq space", { skip }, async (t) => {
  await withStore(t, (store) =>
    Effect.gen(function* () {
      const rows = [
        site(1, "eu-west", [17, 18], ["atlas", "beacon"]),
        site(2, "eu-west", [17], ["atlas", "cobalt"]),
        site(3, "us-east", [17], ["atlas", "delta"]),
        site(4, "eu-west", [99], ["ember"]),
      ];

      const collect = (query) =>
        Effect.map(Stream.runCollect(store.resolve(query)), (c) => [...c]);

      // ingest: the payload is written once, lenses receive pointers only
      yield* store.transact((txn) =>
        Effect.forEach(rows, (row, i) => txn.put(asSeq(i + 1), row.bytes, row.manifest)),
      );

      assert.deepEqual(yield* collect(term("title", "atlas")), [1, 2, 3], "document lens");
      assert.deepEqual(yield* collect(equals("region", "eu-west")), [1, 2, 4], "column lens");
      assert.deepEqual(yield* collect(edge("uses", 1_000_017)), [], "edge lens is directional");

      // the cross-model query: three data models, one intersection
      const cross = yield* collect(and(term("title", "atlas"), equals("region", "eu-west")));
      assert.deepEqual(cross, [1, 2], "cross-model intersection");

      // payload is untouched until the answer set is small
      const first = yield* store.read(asSeq(1));
      assert.equal(JSON.parse(dec.decode(first.bytes)).region, "eu-west");

      // aggregation reads the measure vector, never the payloads
      const visits = yield* store.measure("visits");
      assert.equal(cross.reduce((sum, s) => sum + visits[s], 0), 30);
    }),
  );
});

test("lmdb: retraction leaves no posting behind", { skip }, async (t) => {
  await withStore(t, (store) =>
    Effect.gen(function* () {
      const before = site(1, "eu-west", [17], ["atlas"]);
      const after = site(1, "ap-south", [18], ["marble"]);

      const seqs = (query) =>
        Effect.map(Stream.runCollect(store.resolve(query)), (c) => [...c]);

      yield* store.transact((txn) => txn.put(asSeq(1), before.bytes, before.manifest));
      // updating must retract every posting the previous version produced
      yield* store.transact((txn) => txn.put(asSeq(1), after.bytes, after.manifest));

      assert.deepEqual(yield* seqs(term("title", "atlas")), [], "stale term retracted");
      assert.deepEqual(yield* seqs(equals("region", "eu-west")), [], "stale column retracted");
      assert.deepEqual(yield* seqs(term("title", "marble")), [1], "new term present");

      yield* store.transact((txn) => txn.retract(asSeq(1)));

      assert.deepEqual(yield* seqs(term("title", "marble")), [], "delete retracts");
      assert.deepEqual(yield* seqs(equals("region", "ap-south")), [], "delete retracts columns");
    }),
  );
});
