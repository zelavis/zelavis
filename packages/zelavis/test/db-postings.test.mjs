// Postings: sets of identifiers, one container per segment of 65536.
//
// Every operation is checked against plain Set semantics over many seeded
// samples, chosen so that both container shapes occur, segments are shared and
// unshared between the two sides, and identifiers sit past 32 bits.
import assert from "node:assert/strict";
import test from "node:test";
import { Postings } from "../dist/db/index.js";

const SPAN = 65536;

const rnd = (seed) => () =>
  ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >>> 0) / 0x80000000;

const build = (ids, { shuffled = false } = {}) => {
  const b = new Postings.PostingsBuilder();
  const order = [...ids].sort((a, z) => a - z);
  if (shuffled) order.reverse();
  for (const id of order) b.add(id);
  return b.build();
};

/** Ids in a few segments, some far apart, at a density per segment. */
const sample = (rand, density) => {
  const out = new Set();
  const segments = [0, 1, 3, 2 ** 24 + 5].filter(() => rand() < 0.8);
  for (const segment of segments) {
    for (let offset = 0; offset < SPAN; offset += 1 + Math.floor(rand() / density)) out.add(segment * SPAN + offset);
  }
  return out;
};

const kinds = (p) => p.containers.map((c) => c.kind).join(",");

test("postings: each segment takes the cheaper shape for what it holds", () => {
  // Five ids in one segment are far below the bitmap break-even.
  const sparse = build([1, 500, 2000, 7000, 9999]);
  assert.deepEqual(sparse.segments, [0]);
  assert.equal(kinds(sparse), "list");
  // Half of a segment is well above it, and a neighbouring sparse segment keeps its list.
  const ids = [];
  for (let i = 0; i < SPAN; i += 2) ids.push(i);
  ids.push(SPAN + 3);
  const mixed = build(ids);
  assert.deepEqual(mixed.segments, [0, 1]);
  assert.equal(kinds(mixed), "bitmap,list");
  assert.equal(Postings.size(mixed), ids.length);
});

test("postings: and, or and andNot match Set semantics across every shape pair", () => {
  const rand = rnd(20261021);
  for (let trial = 0; trial < 40; trial++) {
    // Densities straddle the per-segment break-even, so list×list,
    // list×bitmap and bitmap×bitmap all occur.
    const a = sample(rand, rand() < 0.5 ? 0.002 : 0.2);
    const b = sample(rand, rand() < 0.5 ? 0.002 : 0.2);
    const pa = build(a);
    const pb = build(b, { shuffled: trial % 2 === 0 });

    const sorted = (set) => [...set].sort((x, y) => x - y);
    const expectAnd = sorted([...a].filter((x) => b.has(x)));
    const expectOr = sorted(new Set([...a, ...b]));
    const expectAndNot = sorted([...a].filter((x) => !b.has(x)));

    assert.deepEqual(Postings.ids(Postings.and(pa, pb)), expectAnd, `and @ ${trial} (${kinds(pa)} × ${kinds(pb)})`);
    assert.deepEqual(Postings.ids(Postings.and(pb, pa)), expectAnd, `and commutes @ ${trial}`);
    assert.deepEqual(Postings.ids(Postings.or(pa, pb)), expectOr, `or @ ${trial}`);
    assert.deepEqual(Postings.ids(Postings.andNot(pa, pb)), expectAndNot, `andNot @ ${trial}`);
    assert.equal(Postings.size(pa), a.size, "size");
    assert.deepEqual(Postings.ids(pb), sorted(b), "a set built in any order reads back ascending");

    for (const probe of [...[...a].slice(0, 5), 1, SPAN, 2 ** 24 * SPAN + 6, 2 ** 40]) {
      assert.equal(Postings.has(pa, probe), a.has(probe), `has(${probe})`);
    }
  }
});

test("postings: segment boundaries, wide identifiers and empty sets", () => {
  const boundary = [SPAN - 1, SPAN, 2 * SPAN - 1, 2 * SPAN, 2 ** 32 - 1, 2 ** 32, 2 ** 48 - 1];
  const edges = build(boundary);
  assert.deepEqual(Postings.ids(edges), boundary);
  assert.equal(new Set(edges.segments).size, edges.segments.length, "one container per segment");

  // A repeated id counts once, however it arrives.
  assert.deepEqual(Postings.ids(build([5, 5, 3, 5, 3], { shuffled: true })), [3, 5]);

  assert.deepEqual(Postings.ids(Postings.empty), []);
  assert.equal(Postings.size(Postings.empty), 0);
  assert.deepEqual(Postings.ids(Postings.and(edges, Postings.empty)), []);
  assert.deepEqual(Postings.ids(Postings.or(edges, Postings.empty)), boundary);
  assert.deepEqual(Postings.ids(Postings.andNot(edges, edges)), []);
  assert.deepEqual(Postings.ids(Postings.andAll([])), []);
});

test("postings: andAll intersects narrowest-first", () => {
  const wide = [];
  for (let i = 1; i <= 4000; i++) wide.push(i);
  const narrow = [7, 4000];
  const mid = [];
  for (let i = 1; i <= 4000; i += 2) mid.push(i);

  const result = Postings.andAll([build(wide), build(narrow), build(mid)]);
  assert.deepEqual(Postings.ids(result), [7]);
});
