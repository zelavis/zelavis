import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Layer, Stream } from "effect";
import { and, asSeq, edge, equals, term } from "../dist/db/index.js";
import { DbRoot, Partitions } from "../dist/db/engines/node-sqlite.js";
import { ObjectStore } from "../dist/db/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

const site = (seq, region, plugins, words) => ({
  bytes: enc.encode(JSON.stringify({ seq, region, plugins, title: words.join(" ") })),
  manifest: {
    terms: words.map((w) => ["title", w]),
    columns: [["region", region]],
    measures: [["visits", seq * 10]],
    edges: plugins.map((p) => ["uses", 1_000_000 + p]),
  },
});

const run = (directory, program) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(Partitions.layer),
      Effect.provide(DbRoot.layer(directory)),
    ),
  );

test("db: one payload, many lenses, resolved through a shared seq space", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-db-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const rows = [
    site(1, "eu-west", [17, 18], ["atlas", "beacon"]),
    site(2, "eu-west", [17], ["atlas", "cobalt"]),
    site(3, "us-east", [17], ["atlas", "delta"]),
    site(4, "eu-west", [99], ["ember"]),
  ];

  const collect = (query) =>
    Effect.gen(function* () {
      const store = yield* ObjectStore;
      return yield* Stream.runCollect(store.resolve(query));
    }).pipe(Effect.provide(Partitions.get("acme")));

  await run(dir, Effect.gen(function* () {
    // ingest: the payload is written once, lenses receive pointers only
    yield* Effect.gen(function* () {
      const store = yield* ObjectStore;
      yield* store.transact((txn) =>
        Effect.forEach(rows, (row, i) => txn.put(asSeq(i + 1), row.bytes, row.manifest)),
      );
    }).pipe(Effect.provide(Partitions.get("acme")));

    const doc = yield* collect(term("title", "atlas"));
    assert.deepEqual([...doc], [1, 2, 3], "document lens");

    const col = yield* collect(equals("region", "eu-west"));
    assert.deepEqual([...col], [1, 2, 4], "column lens");

    const graph = yield* collect(edge("uses", 1_000_017));
    assert.deepEqual([...graph], [], "edge lens is directional");

    // the cross-model query: three data models, one intersection
    const cross = yield* collect(
      and(term("title", "atlas"), equals("region", "eu-west")),
    );
    assert.deepEqual([...cross], [1, 2], "cross-model intersection");

    // payload is untouched until the answer set is small
    const store = yield* Effect.provide(ObjectStore, Partitions.get("acme"));
    const first = yield* store.read(asSeq(1));
    assert.equal(JSON.parse(dec.decode(first.bytes)).region, "eu-west");

    // aggregation reads the measure vector, never the payloads
    const visits = yield* store.measure("visits");
    assert.equal([...cross].reduce((sum, s) => sum + visits[s], 0), 30);
  }));
});

test("db: retraction leaves no posting behind", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-db-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const before = site(1, "eu-west", [17], ["atlas"]);
  const after = site(1, "ap-south", [18], ["marble"]);

  const seqs = (query) =>
    Effect.gen(function* () {
      const store = yield* ObjectStore;
      return [...(yield* Stream.runCollect(store.resolve(query)))];
    }).pipe(Effect.provide(Partitions.get("acme")));

  await run(dir, Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const store = yield* ObjectStore;
      yield* store.transact((txn) => txn.put(asSeq(1), before.bytes, before.manifest));
      // updating must retract every posting the previous version produced
      yield* store.transact((txn) => txn.put(asSeq(1), after.bytes, after.manifest));
    }).pipe(Effect.provide(Partitions.get("acme")));

    assert.deepEqual(yield* seqs(term("title", "atlas")), [], "stale term retracted");
    assert.deepEqual(yield* seqs(equals("region", "eu-west")), [], "stale column retracted");
    assert.deepEqual(yield* seqs(term("title", "marble")), [1], "new term present");

    yield* Effect.gen(function* () {
      const store = yield* ObjectStore;
      yield* store.transact((txn) => txn.retract(asSeq(1)));
    }).pipe(Effect.provide(Partitions.get("acme")));

    assert.deepEqual(yield* seqs(term("title", "marble")), [], "delete retracts");
    assert.deepEqual(yield* seqs(equals("region", "ap-south")), [], "delete retracts columns");
  }));
});
