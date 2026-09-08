import assert from "node:assert/strict";
import test from "node:test";
import { Postings } from "../dist/db/index.js";

const rnd = (seed) => () =>
  ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >>> 0) / 0x80000000;

const build = (ids) => {
  const b = new Postings.PostingsBuilder();
  for (const id of [...ids].sort((a, z) => a - z)) b.add(id);
  return b.build();
};

const sample = (rand, universe, density) => {
  const out = new Set();
  for (let i = 1; i < universe; i++) if (rand() < density) out.add(i);
  return out;
};

test("postings: representation is chosen by density", () => {
  // 5 ids spread over 10,000 is far below the bitset break-even.
  assert.equal(build([1, 500, 2000, 7000, 9999]).kind, "array");
  // Half of a 1,000-wide universe is well above it.
  const dense = [];
  for (let i = 1; i < 1000; i += 2) dense.push(i);
  assert.equal(build(dense).kind, "bitset");
  assert.equal(Postings.size(build(dense)), dense.length);
});

test("postings: and/or match Set semantics across every representation pair", () => {
  const rand = rnd(20260907);
  for (let trial = 0; trial < 60; trial++) {
    const universe = 200 + Math.floor(rand() * 3000);
    // Densities chosen to straddle the break-even so array×array,
    // array×bitset and bitset×bitset all occur.
    const a = sample(rand, universe, rand() < 0.5 ? 0.005 : 0.4);
    const b = sample(rand, universe, rand() < 0.5 ? 0.005 : 0.4);

    const pa = build(a);
    const pb = build(b);

    const expectAnd = [...a].filter((x) => b.has(x)).sort((x, y) => x - y);
    const expectOr = [...new Set([...a, ...b])].sort((x, y) => x - y);

    assert.deepEqual([...Postings.iterate(Postings.and(pa, pb))], expectAnd,
      `and @ trial ${trial} (${pa.kind} × ${pb.kind})`);
    assert.deepEqual([...Postings.iterate(Postings.or(pa, pb))], expectOr,
      `or @ trial ${trial} (${pa.kind} × ${pb.kind})`);

    // and is commutative regardless of which side is dense
    assert.deepEqual(
      [...Postings.iterate(Postings.and(pb, pa))], expectAnd, "and commutes");

    assert.equal(Postings.size(pa), a.size, "size");
    assert.deepEqual([...Postings.iterate(Postings.toArray(pa))], [...a].sort((x, y) => x - y),
      "toArray round-trips");

    for (const probe of [1, Math.floor(universe / 2), universe - 1]) {
      assert.equal(Postings.has(pa, probe), a.has(probe), `has(${probe})`);
    }
  }
});

test("postings: word boundaries and empty sets", () => {
  // Bits 31/32/63/64 are where off-by-one errors in word indexing surface.
  const edges = build([31, 32, 63, 64, 95, 96]);
  assert.deepEqual([...Postings.iterate(edges)], [31, 32, 63, 64, 95, 96]);

  assert.deepEqual([...Postings.iterate(Postings.empty)], []);
  assert.equal(Postings.size(Postings.empty), 0);
  assert.deepEqual([...Postings.iterate(Postings.and(edges, Postings.empty))], []);
  assert.deepEqual([...Postings.iterate(Postings.or(edges, Postings.empty))],
    [31, 32, 63, 64, 95, 96]);
  assert.deepEqual([...Postings.iterate(Postings.andAll([]))], []);
});

test("postings: andAll intersects narrowest-first", () => {
  const wide = [];
  for (let i = 1; i <= 4000; i++) wide.push(i);
  const narrow = [7, 4000];
  const mid = [];
  for (let i = 1; i <= 4000; i += 2) mid.push(i);

  const result = Postings.andAll([build(wide), build(narrow), build(mid)]);
  assert.deepEqual([...Postings.iterate(result)], [7]);
});
