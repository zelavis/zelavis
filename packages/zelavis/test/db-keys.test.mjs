import assert from "node:assert/strict";
import test from "node:test";
import {
  compareKeys, compareOrderedValues, decodeIdentity, decodeOrderedKey,
  dstOf, edgeKey, edgePrefix, identityKey, inPrefixRange, orderedColumnPrefix, orderedKey,
  orderedTuple, orderedValuePrefix, prefixEnd, seqOf, termKey, termPrefix,
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
  const column = orderedKey("region", "eu", 1);
  assert.notEqual(term[0], column[0], "different tags");
  assert.equal(inPrefixRange(term, orderedValuePrefix("region", "eu")), false);
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
    termKey("body", "atlas", 5), orderedKey("title", "atlas", 6),
  ];
  const prefix = termPrefix("title", "atlas");
  const end = prefixEnd(prefix);
  const selected = sorted(all)
    .filter((k) => compareKeys(k, prefix) >= 0 && compareKeys(k, end) < 0)
    .map(seqOf);
  assert.deepEqual(selected, [1, 2], "only this field and this term");
});

// Built from code points, so the characters that matter here are named rather
// than pasted: the two bytes the key encoding escapes, a precomposed accent
// and its combining spelling, and a pair on either side of the surrogate range.
const NUL = String.fromCharCode(0);
const SOH = String.fromCharCode(1);
const COMBINING_ACUTE = String.fromCharCode(0x301);
const E_ACUTE = String.fromCharCode(0xe9);
const PRIVATE_USE = String.fromCharCode(0xe000);
const EMOJI = String.fromCodePoint(0x1f600);

// Every kind the ordered lens accepts, in the one order it defines.
const ORDER = [
  false, true,
  -Number.MAX_VALUE, -1e300, -1000, -2.5, -2, -1, -Number.MIN_VALUE, 0,
  Number.MIN_VALUE, 0.1, 1, 2, 2.5, 10, 1e21, Number.MAX_VALUE,
  "", NUL, SOH, "A", "Z", "a", "a" + NUL, "ab", "b",
  // No normalization: a combining accent is not the precomposed letter.
  "e" + COMBINING_ACUTE, E_ACUTE,
  // Code point order, not JavaScript's UTF-16 order.
  PRIVATE_USE, EMOJI,
  new Uint8Array(0), Uint8Array.of(0), Uint8Array.of(0, 0), Uint8Array.of(1), Uint8Array.of(255),
  // Null last, as NULLS LAST orders it.
  null,
];
const show = (v) => (v instanceof Uint8Array ? `bytes[${[...v]}]` : JSON.stringify(v));
const shuffled = (items) => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = (i * 7919 + 13) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

test("ordered values sort by value, across kinds, in one fixed order", () => {
  const byKey = shuffled(ORDER)
    .map((value) => ({ value, key: orderedKey("price", value, 1) }))
    .sort((a, b) => compareKeys(a.key, b.key))
    .map(({ value }) => show(value));
  assert.deepEqual(byKey, ORDER.map(show));
  assert.deepEqual(shuffled(ORDER).sort(compareOrderedValues).map(show), ORDER.map(show));
  // The host's own order disagrees, which is why it is not used.
  assert.ok(EMOJI < PRIVATE_USE, "JavaScript compares UTF-16 code units");
});

test("negative zero is zero, and a number that is not finite is refused", () => {
  assert.equal(compareOrderedValues(-0, 0), 0);
  assert.deepEqual([...orderedKey("n", -0, 1)], [...orderedKey("n", 0, 1)]);
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(() => orderedKey("n", bad, 1), RangeError);
  }
});

test("an ordered key decodes to what it records", () => {
  for (const value of ORDER) {
    const decoded = decodeOrderedKey(orderedKey("a column", value, 4242));
    assert.equal(decoded.column, "a column");
    assert.equal(decoded.seq, 4242);
    assert.equal(show(decoded.value), show(value));
  }
});

test("a value's prefix selects exactly that value", () => {
  const within = (v, prefix) => inPrefixRange(orderedKey("c", v, 9), orderedValuePrefix("c", prefix));
  assert.equal(within("a", "a"), true);
  assert.equal(within("ab", "a"), false, "ab is not a");
  assert.equal(within("a" + NUL, "a"), false, "a followed by NUL is not a");
  assert.equal(within(1.5, 1), false);
  assert.equal(within(1, true), false, "true is not 1");
  assert.equal(within(Uint8Array.of(0, 0), Uint8Array.of(0)), false);
});

test("equal values tie-break by identifier, and the lens keeps to its own range", () => {
  assert.ok(compareKeys(orderedKey("c", 5, 2), orderedKey("c", 5, 10)) < 0);
  assert.ok(compareKeys(orderedKey("c", 5, 4294967295), orderedKey("c", 5.000001, 0)) < 0);
  assert.equal(inPrefixRange(orderedKey("c", 5, 1), orderedColumnPrefix("c")), true);
  assert.equal(inPrefixRange(orderedKey("cd", 5, 1), orderedColumnPrefix("c")), false);
  assert.equal(inPrefixRange(termKey("c", "5", 1), orderedColumnPrefix("c")), false);
});

test("decoding a key held in a shared buffer reads the key and leaves it alone", () => {
  // LMDB returns keys as Buffers that view a larger pool. A decoder that copied
  // with `slice` would get a view instead, read the pool's first bytes, and
  // write its bit flips back into the caller's key.
  for (const value of [-2.5, 0, 7, 1e21, "a", null, true]) {
    const key = orderedKey("n", value, 7);
    const pool = Buffer.alloc(key.length + 16, 0xab);
    pool.set(key, 16);
    const view = pool.subarray(16);
    const before = [...view];
    assert.equal(show(decodeOrderedKey(view).value), show(value));
    assert.deepEqual([...view], before, "decoding changed the key");
  }
});

test("a composite key sorts field by field, each with its own direction and null placement", () => {
  const nul = String.fromCharCode(0);
  const pool = [undefined, null, false, true, -2.5, -0, 0, 1, 10, 1e21, "", "a", `a${nul}`, "ab", "b", "é", "Z"];
  const spec = [
    { direction: "asc", nulls: "last" },
    { direction: "desc", nulls: "first" },
    { direction: "desc", nulls: "last" },
  ];
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const tuples = Array.from({ length: 4000 }, () => spec.map(() => pool[Math.floor(random() * pool.length)]));
  const encode = (tuple) => orderedTuple(tuple.map((value, i) => ({ value, ...spec[i] })));
  const compareField = (a, b, { direction, nulls }) => {
    const aNone = a === null || a === undefined;
    const bNone = b === null || b === undefined;
    if (aNone || bNone) return aNone === bNone ? 0 : (aNone ? 1 : -1) * (nulls === "first" ? -1 : 1);
    const order = compareOrderedValues(a, b);
    return direction === "desc" ? -order : order;
  };
  const compareTuple = (a, b) => {
    for (let i = 0; i < spec.length; i++) {
      const order = compareField(a[i], b[i], spec[i]);
      if (order !== 0) return order;
    }
    return 0;
  };
  for (let i = 0; i + 1 < tuples.length; i++) {
    const [a, b] = [tuples[i], tuples[i + 1]];
    const [x, y] = [encode(a), encode(b)];
    assert.match(x, /^[0-9a-f]+$/);
    assert.equal(Math.sign(x < y ? -1 : x > y ? 1 : 0), Math.sign(compareTuple(a, b)),
      `${JSON.stringify(a)} against ${JSON.stringify(b)}`);
    // The leading fields alone are a prefix of the whole, which is what a seek by them relies on.
    assert.ok(x.startsWith(orderedTuple(a.slice(0, 2).map((value, j) => ({ value, ...spec[j] })))));
  }
});
