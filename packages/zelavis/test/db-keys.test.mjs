import assert from "node:assert/strict";
import test from "node:test";
import {
  columnKey, columnPrefix, compareKeys, decodeIdentity, dstOf, edgeKey, edgePrefix,
  identityKey, inPrefixRange, prefixEnd, seqOf, termKey, termPrefix,
} from "../dist/db/keys.js";

const sorted = (keys) => [...keys].sort(compareKeys);

test("numbers sort numerically, not lexically", () => {
  // The classic failure: "10" < "2" as text. Fixed-width big-endian fixes it.
  const ids = [1, 2, 9, 10, 11, 100, 255, 256, 65535, 65536, 4294967295];
  const order = sorted(ids.map((n) => termKey("title", "atlas", n))).map(seqOf);
  assert.deepEqual(order, ids);
});

test("string boundaries cannot collide across parts", () => {
  // ("ab","c") and ("a","bc") concatenate identically without a terminator.
  assert.notDeepEqual([...termKey("ab", "c", 1)], [...termKey("a", "bc", 1)]);

  assert.equal(inPrefixRange(termKey("ab", "c", 1), termPrefix("ab", "c")), true);
  assert.equal(inPrefixRange(termKey("a", "bc", 1), termPrefix("ab", "c")), false);

  // A term that is a prefix of another must not be caught by its scan.
  const atlas = termKey("title", "atlas", 1);
  assert.equal(inPrefixRange(atlas, termPrefix("title", "atl")), false, "atlas is not atl");
  assert.equal(inPrefixRange(atlas, termPrefix("title", "atlas")), true);
});

test("embedded null bytes survive and stay ordered", () => {
  const NUL = '\u0000';
  const withNull = termKey("title", `a${NUL}b`, 7);
  assert.equal(seqOf(withNull), 7, "the trailing identifier is still readable");
  assert.equal(inPrefixRange(withNull, termPrefix("title", `a${NUL}b`)), true);
  // The encoding of "a<NUL>b" genuinely begins with the encoding of "a", because
  // the escape shares its first byte with the terminator. Only a range test
  // excludes it — which is why membership here is never a byte-prefix check.
  assert.equal(inPrefixRange(withNull, termPrefix("title", "a")), false,
    "a range test rejects what a byte-prefix test would accept");

  // Escaping must not invert order: "a", then "a<NUL>b", then "ab".
  const order = sorted([
    termKey("t", "a", 1), termKey("t", `a${NUL}b`, 1), termKey("t", "ab", 1),
  ]);
  assert.equal(inPrefixRange(order[0], termPrefix("t", "a")), true);
  assert.equal(inPrefixRange(order[1], termPrefix("t", `a${NUL}b`)), true);
  assert.equal(inPrefixRange(order[2], termPrefix("t", "ab")), true);
});

test("lenses occupy disjoint ranges", () => {
  // A scan of one lens must never reach another, which is what replaces
  // column families on an engine that has none.
  const term = termKey("region", "eu", 1);
  const column = columnKey("region", "eu", 1);
  assert.notEqual(term[0], column[0], "different tags");
  assert.equal(inPrefixRange(term, columnPrefix("region", "eu")), false);
  assert.equal(inPrefixRange(column, termPrefix("region", "eu")), false);
});

test("edges scan by source and yield their destination", () => {
  assert.deepEqual(sorted([30, 10, 20].map((d) => edgeKey("uses", 5, d))).map(dstOf), [10, 20, 30]);
  assert.equal(inPrefixRange(edgeKey("uses", 5, 10), edgePrefix("uses", 5)), true);
  assert.equal(inPrefixRange(edgeKey("uses", 6, 10), edgePrefix("uses", 5)), false, "source is exact");
});

test("identity round-trips, including awkward names", () => {
  for (const [ns, key] of [
    ["doc/acme/posts", "p1"],
    ["doc/acme/posts", "id with spaces"],
    ["zv.schema", "acme/posts/1"],
    ["doc/a", "b/c"],
  ]) {
    assert.deepEqual(decodeIdentity(identityKey(ns, key)), { namespace: ns, key });
  }
  assert.notDeepEqual([...identityKey("doc/a", "b")], [...identityKey("doc", "a/b")]);
});

test("prefix ranges have a correct exclusive end", () => {
  const prefix = termPrefix("title", "atlas");
  const end = prefixEnd(prefix);
  assert.ok(end, "a normal prefix has an upper bound");
  assert.equal(compareKeys(prefix, end) < 0, true);
  assert.equal(compareKeys(termKey("title", "atlas", 4294967295), end) < 0, true,
    "every key under the prefix is below the bound");
  assert.equal(compareKeys(termKey("title", "atlaz", 1), end) >= 0, true,
    "the next term is at or above the bound");

  assert.equal(prefixEnd(Uint8Array.from([0xff, 0xff])), undefined, "all-0xFF has no bound");
  assert.deepEqual([...prefixEnd(Uint8Array.from([0x01, 0xff]))], [0x02]);
});

test("scanning a prefix selects exactly its members", () => {
  const all = [
    termKey("title", "atlas", 1), termKey("title", "atlas", 2),
    termKey("title", "atlantic", 3), termKey("title", "beacon", 4),
    termKey("body", "atlas", 5), columnKey("title", "atlas", 6),
  ];
  const prefix = termPrefix("title", "atlas");
  const end = prefixEnd(prefix);
  const selected = sorted(all)
    .filter((k) => compareKeys(k, prefix) >= 0 && compareKeys(k, end) < 0)
    .map(seqOf);
  assert.deepEqual(selected, [1, 2], "only this field and this term");
});
