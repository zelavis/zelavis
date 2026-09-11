import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Stream } from "effect";
import { and, asSeq, equals, term } from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";
import { decodeSegment, encodeSegment, SEGMENT_SPAN, segmentOf } from "../dist/db/segments.js";

const enc = new TextEncoder();

const withStore = (t, body) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-seal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Effect.runPromise(
    Effect.scoped(Effect.gen(function* () {
      const store = yield* makeNodeSqliteStore("acme", dir);
      return yield* body(store);
    })),
  );
};

const seqs = (store, q) => Effect.map(Stream.runCollect(store.resolve(q)), (c) => [...c]);

const roundTrip = (ids, base) => {
  const out = [];
  decodeSegment(encodeSegment(ids, base), base, (id) => out.push(id));
  return out;
};

test("a segment blob round-trips in both of its shapes", () => {
  // Sparse: an offset list, two bytes an identifier.
  const sparse = [0, 1, 7, 8, 255, 4095];
  assert.deepEqual(roundTrip(sparse, 0), sparse);

  // Dense: past the crossover the same values must survive a bitmap.
  const dense = [];
  for (let i = 0; i < SEGMENT_SPAN; i += 2) dense.push(i);
  assert.deepEqual(roundTrip(dense, 0), dense);

  // A segment other than the first: offsets are relative, values are not.
  const base = 3 * SEGMENT_SPAN;
  const shifted = [base, base + 9, base + SEGMENT_SPAN - 1];
  assert.deepEqual(roundTrip(shifted, base), shifted);

  assert.equal(roundTrip([], 0).length, 0);
  assert.equal(segmentOf(SEGMENT_SPAN - 1), 0);
  assert.equal(segmentOf(SEGMENT_SPAN), 1);
});

test("the two shapes are chosen by density, not fixed", () => {
  const sparse = encodeSegment([1, 2, 3], 0);
  const dense = [];
  for (let i = 0; i < 8000; i++) dense.push(i);
  assert.ok(sparse.length < 64, "a three-id segment is not an 8 KB bitmap");
  assert.equal(encodeSegment(dense, 0).length, 1 + SEGMENT_SPAN / 8);
});

const write = (store, seq, region, words) =>
  store.transact((txn) =>
    txn.put(
      asSeq(seq),
      enc.encode(JSON.stringify({ seq, region })),
      {
        terms: words.map((w) => ["title", w]),
        columns: [["region", region]],
        measures: [["visits", seq]],
        edges: [["uses", 900 + (seq % 2)]],
      },
      { namespace: "doc/acme/posts", key: `p${seq}` },
    ));

test("sealing answers every query the live tier answered", async (t) => {
  await withStore(t, (store) =>
    Effect.gen(function* () {
      for (let seq = 1; seq <= 200; seq++) {
        yield* write(store, seq, seq % 2 === 0 ? "eu-west" : "us-east", ["atlas", `w${seq % 7}`]);
      }

      const before = {
        term: yield* seqs(store, term("title", "atlas")),
        column: yield* seqs(store, equals("region", "eu-west")),
        narrow: yield* seqs(store, and(term("title", "w3"), equals("region", "eu-west"))),
      };
      assert.equal(before.term.length, 200);

      const sealed = yield* store.sealPostings;
      assert.ok(sealed.segments > 0, "something was sealed");

      assert.deepEqual(yield* seqs(store, term("title", "atlas")), before.term);
      assert.deepEqual(yield* seqs(store, equals("region", "eu-west")), before.column);
      assert.deepEqual(yield* seqs(store, and(term("title", "w3"), equals("region", "eu-west"))),
        before.narrow);

      // The payload is untouched by any of this.
      assert.equal((yield* store.read(asSeq(7))).version, 1);
    }),
  );
});

test("writes after a seal are found beside the blobs, not instead of them", async (t) => {
  await withStore(t, (store) =>
    Effect.gen(function* () {
      for (let seq = 1; seq <= 50; seq++) yield* write(store, seq, "eu-west", ["atlas"]);
      yield* store.sealPostings;

      for (let seq = 51; seq <= 60; seq++) yield* write(store, seq, "eu-west", ["atlas"]);

      const found = yield* seqs(store, term("title", "atlas"));
      assert.equal(found.length, 60, "the sealed tier and the live tier are both read");
      assert.deepEqual(found.slice(-3), [58, 59, 60]);
    }),
  );
});

test("a posting removed from a sealed blob stops matching", async (t) => {
  await withStore(t, (store) =>
    Effect.gen(function* () {
      for (let seq = 1; seq <= 40; seq++) yield* write(store, seq, "eu-west", ["atlas"]);
      yield* store.sealPostings;

      // A blob cannot be edited, so both of these have to work through
      // tombstones rather than by removing the bit.
      yield* store.transact((txn) => txn.retract(asSeq(5)));
      yield* write(store, 9, "us-east", ["beacon"]);

      const atlas = yield* seqs(store, term("title", "atlas"));
      assert.ok(!atlas.includes(5), "a retracted object leaves the lens");
      assert.ok(!atlas.includes(9), "a term the new version dropped stops matching");
      assert.equal(atlas.length, 38);

      assert.deepEqual(yield* seqs(store, term("title", "beacon")), [9]);
      assert.ok(!(yield* seqs(store, equals("region", "eu-west"))).includes(9));
      assert.deepEqual(yield* seqs(store, equals("region", "us-east")), [9]);
    }),
  );
});

test("an update that keeps a term keeps the posting the tombstone would hide", async (t) => {
  await withStore(t, (store) =>
    Effect.gen(function* () {
      for (let seq = 1; seq <= 20; seq++) yield* write(store, seq, "eu-west", ["atlas"]);
      yield* store.sealPostings;

      // Retract-and-re-add inside one transaction: the tombstone is written and
      // then cancelled, and the batch is keyed, so the later call is the one
      // that lands. If the order were wrong the record would vanish from a
      // lens it never left.
      yield* write(store, 4, "eu-west", ["atlas", "cobalt"]);

      assert.ok((yield* seqs(store, term("title", "atlas"))).includes(4));
      assert.deepEqual(yield* seqs(store, term("title", "cobalt")), [4]);
      assert.deepEqual(yield* seqs(store, equals("region", "eu-west")).pipe(
        Effect.map((ids) => ids.length)), 20);
    }),
  );
});

test("sealing twice is sealing once, and the second answers the same", async (t) => {
  await withStore(t, (store) =>
    Effect.gen(function* () {
      // Enough objects that one value clears the sealing threshold.
      for (let seq = 1; seq <= 100; seq++) yield* write(store, seq, "eu-west", ["atlas"]);
      const first = yield* store.sealPostings;

      yield* store.transact((txn) => txn.retract(asSeq(3)));
      // Too few to seal: these stay live keys, and are found all the same.
      for (let seq = 101; seq <= 110; seq++) yield* write(store, seq, "us-east", ["beacon"]);

      const expected = yield* seqs(store, term("title", "atlas"));
      const second = yield* store.sealPostings;

      assert.equal(second.postings > 0, true);
      assert.deepEqual(yield* seqs(store, term("title", "atlas")), expected,
        "a re-seal folds the tombstoned posting away rather than resurrecting it");
      assert.deepEqual(yield* seqs(store, term("title", "beacon")),
        [101, 102, 103, 104, 105, 106, 107, 108, 109, 110]);
      assert.ok(first.segments > 0);
    }),
  );
});

test("sealing spans segment boundaries", async (t) => {
  await withStore(t, (store) =>
    Effect.gen(function* () {
      // Identifiers are allocated densely, so reaching a second segment
      // honestly would mean 65536 objects. Placing them by hand is the same
      // thing for the fold, which only ever sees the trailing identifier.
      // Three spans dense enough to seal, and one identifier alone in a fourth,
      // too sparse to be worth a blob: it stays a live key.
      const dense = [0, 1, 3].flatMap((span) =>
        Array.from({ length: 64 }, (_, i) => span * SEGMENT_SPAN + 1 + i));
      const ids = [...dense, SEGMENT_SPAN * 5 + 7];
      for (const seq of ids) yield* write(store, seq, "eu-west", ["atlas"]);

      const sealed = yield* store.sealPostings;
      assert.ok(sealed.segments >= 3, "one blob per span, not one blob overall");
      assert.equal(sealed.postings, dense.length * 2, "the lone identifier was sealed anyway");
      assert.deepEqual(yield* seqs(store, term("title", "atlas")), ids);
      assert.deepEqual(yield* seqs(store, equals("region", "eu-west")), ids);
    }),
  );
});

test("a reindex unseals, and a rebuild from the log agrees with both", async (t) => {
  await withStore(t, (store) =>
    Effect.gen(function* () {
      for (let seq = 1; seq <= 25; seq++) yield* write(store, seq, "eu-west", ["atlas"]);
      yield* store.sealPostings;
      yield* store.transact((txn) => txn.retract(asSeq(2)));

      const expected = yield* seqs(store, term("title", "atlas"));
      assert.ok(!expected.includes(2));

      yield* store.reindexLenses;
      assert.deepEqual(yield* seqs(store, term("title", "atlas")), expected,
        "the live tier alone answers what the two tiers answered");

      yield* store.rebuildLenses;
      assert.deepEqual(yield* seqs(store, term("title", "atlas")), expected,
        "and so does a full replay from the log");
    }),
  );
});

test("a lens wider than one write batch seals whole", async (t) => {
  await withStore(t, (store) =>
    Effect.gen(function* () {
      // Sealing writes in batches, and a batch cut inside a segment would put
      // the identifiers so far under the segment's key and then put the rest
      // under the same key — the second replacing the first. Every count here
      // is below the batch size individually; only the term spanning all of
      // them crosses it.
      const total = 12_000;
      for (let seq = 1; seq <= total; seq++) {
        yield* write(store, seq, `r${seq % 3}`, ["atlas", `t${seq % 400}`]);
      }

      const sealed = yield* store.sealPostings;
      assert.ok(sealed.postings > 12_000, "every lens was folded, not just one");

      const atlas = yield* seqs(store, term("title", "atlas"));
      assert.equal(atlas.length, total, "no posting was dropped by a batch cut");
      assert.equal(atlas[0], 1);
      assert.equal(atlas[atlas.length - 1], total);

      const region = yield* seqs(store, equals("region", "r1"));
      assert.equal(region.length, 4000);
    }),
  );
});

test("a re-seal touches only the segments something changed in", async (t) => {
  await withStore(t, (store) =>
    Effect.gen(function* () {
      // Many distinct lenses, so a rebuild and a merge differ by a lot.
      // Forty terms of 75 objects each: every one dense enough to seal.
      for (let seq = 1; seq <= 3000; seq++) {
        yield* write(store, seq, `r${seq % 3}`, ["atlas", `t${seq % 40}`]);
      }
      const first = yield* store.sealPostings;
      assert.ok(first.segments > 40, "the first seal writes every lens");

      // One object changes. Under a rebuild the next seal would fold all of
      // them again; a merge should reach only the lenses this object is in.
      yield* write(store, 42, "r0", ["atlas", "t42", "cobalt"]);

      const second = yield* store.sealPostings;
      assert.ok(
        second.segments <= 8,
        `a re-seal rewrote ${second.segments} segments for a one-object change`,
      );

      // And the ones it did not touch still answer.
      assert.equal((yield* seqs(store, term("title", "atlas"))).length, 3000);
      assert.equal((yield* seqs(store, term("title", "t7"))).length, 75);
      assert.deepEqual(yield* seqs(store, term("title", "cobalt")), [42]);
      assert.equal((yield* seqs(store, equals("region", "r1"))).length, 1000);
    }),
  );
});

test("a seal that both adds to and removes from one segment keeps both", async (t) => {
  await withStore(t, (store) =>
    Effect.gen(function* () {
      for (let seq = 1; seq <= 20; seq++) yield* write(store, seq, "eu-west", ["atlas"]);
      yield* store.sealPostings;

      // Both land in the same blob: one as a live posting, one as a tombstone.
      // The removal pass rewrites whatever it reads, so if it read the segment
      // as it stood before the addition, the addition would be written away.
      yield* write(store, 21, "eu-west", ["atlas"]);
      yield* store.transact((txn) => txn.retract(asSeq(3)));

      yield* store.sealPostings;

      const atlas = yield* seqs(store, term("title", "atlas"));
      assert.ok(atlas.includes(21), "the addition survived the removal pass");
      assert.ok(!atlas.includes(3), "the removal still applied");
      assert.equal(atlas.length, 20);

      // Nothing is left in either overlay: it is all in the blob now.
      const again = yield* store.sealPostings;
      assert.equal(again.segments, 0, "a seal with nothing to do writes nothing");
      assert.deepEqual(yield* seqs(store, term("title", "atlas")), atlas);
    }),
  );
});

test("a lens emptied by retraction loses its blob rather than keeping an empty one", async (t) => {
  await withStore(t, (store) =>
    Effect.gen(function* () {
      for (let seq = 1; seq <= 10; seq++) yield* write(store, seq, "eu-west", ["atlas"]);
      yield* store.sealPostings;

      for (let seq = 1; seq <= 10; seq++) {
        yield* store.transact((txn) => txn.retract(asSeq(seq)));
      }
      const swept = yield* store.sealPostings;
      assert.equal(swept.segments, 0, "an empty segment is deleted, not written");
      assert.deepEqual(yield* seqs(store, term("title", "atlas")), []);
      assert.deepEqual(yield* seqs(store, equals("region", "eu-west")), []);

      // And the lens still works when something comes back to it.
      yield* write(store, 11, "eu-west", ["atlas"]);
      assert.deepEqual(yield* seqs(store, term("title", "atlas")), [11]);
      yield* store.sealPostings;
      assert.deepEqual(yield* seqs(store, term("title", "atlas")), [11]);
    }),
  );
});

test("a re-seal reads only the groups written since, not the ones it declined", async (t) => {
  await withStore(t, (store) =>
    Effect.gen(function* () {
      // Each object: a shared title and a unique one, a region shared by a
      // third of them, and an edge from itself. The shared ones seal; the
      // unique title and the edge are too sparse and stay live.
      for (let seq = 1; seq <= 300; seq++) {
        yield* write(store, seq, `r${seq % 3}`, ["atlas", `u${seq}`]);
      }
      const first = yield* store.sealPostings;
      assert.equal(first.examined, 300 * 4, "the first seal sweeps every live posting");

      yield* write(store, 301, "r1", ["atlas", "u301"]);
      const second = yield* store.sealPostings;
      assert.equal(second.examined, 4,
        `a one-object change re-read ${second.examined} postings, so declined ones were read again`);

      const third = yield* store.sealPostings;
      assert.equal(third.examined, 0, "a seal with nothing written reads nothing");
      assert.equal(third.segments, 0);

      assert.equal((yield* seqs(store, term("title", "atlas"))).length, 301);
      assert.deepEqual(yield* seqs(store, term("title", "u7")), [7]);
      assert.deepEqual(yield* seqs(store, term("title", "u301")), [301]);
      assert.equal((yield* seqs(store, equals("region", "r1"))).length, 101);

      // A reindex unseals, so the next seal has to sweep again.
      yield* store.reindexLenses;
      const afterReindex = yield* store.sealPostings;
      assert.equal(afterReindex.examined, 301 * 4);
      assert.equal((yield* seqs(store, term("title", "atlas"))).length, 301);
    }),
  );
});

test("a value an earlier seal declined is sealed once it has grown enough", async (t) => {
  await withStore(t, (store) =>
    Effect.gen(function* () {
      for (let seq = 1; seq <= 40; seq++) yield* write(store, seq, `solo${seq}`, ["grow"]);
      const first = yield* store.sealPostings;
      assert.equal(first.segments, 0, "forty postings of one value are below the threshold");

      for (let seq = 41; seq <= 70; seq++) yield* write(store, seq, `solo${seq}`, ["grow"]);
      const second = yield* store.sealPostings;
      assert.ok(second.segments >= 1, "the value that grew past the threshold was sealed");
      assert.ok(second.examined >= 70, "all of the grown value's postings were read, old and new");
      assert.equal((yield* seqs(store, term("title", "grow"))).length, 70);
    }),
  );
});
