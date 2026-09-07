import { asSeq, type Seq } from "./model.js";

/**
 * A set of identifiers in one of two shapes.
 *
 * Measurements on a million-object dataset showed the columnar path spending
 * most of its time turning several hundred thousand postings into JavaScript
 * objects before intersecting them, and — worse — the cost scaled with the
 * *widest* predicate rather than the size of the answer. A wide predicate is
 * exactly what a developer writes without thinking about it.
 *
 * Both problems come from the representation. A sorted list must be walked in
 * full to be intersected; a bitset can be *probed* in constant time. So a
 * narrow run intersected against a wide one costs the narrow one's length, and
 * the wide side never becomes a JavaScript array at all.
 */
export type Postings =
  | { readonly kind: "array"; readonly ids: Uint32Array }
  | { readonly kind: "bitset"; readonly words: Uint32Array; readonly universe: number };

export const empty: Postings = { kind: "array", ids: new Uint32Array(0) };

const wordsFor = (universe: number) => new Uint32Array((universe + 31) >>> 5);

const test = (words: Uint32Array, id: number): boolean =>
  ((words[id >>> 5]! >>> (id & 31)) & 1) === 1;

const popcount = (words: Uint32Array): number => {
  let total = 0;
  for (let i = 0; i < words.length; i++) {
    let v = words[i]!;
    v = v - ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    total += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return total;
};

/**
 * A bitset costs `universe / 8` bytes; a sorted array costs `4n`. Below this
 * density the array is both smaller and faster to scan, so the representation
 * is chosen per set rather than fixed globally.
 */
const preferBitset = (count: number, universe: number) => count > universe / 32;

export const size = (p: Postings): number =>
  p.kind === "array" ? p.ids.length : popcount(p.words);

export const has = (p: Postings, id: number): boolean => {
  if (p.kind === "bitset") return id < p.universe && test(p.words, id);
  let lo = 0;
  let hi = p.ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = p.ids[mid]!;
    if (v === id) return true;
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
};

/** Accumulates ascending identifiers, then picks a representation. */
export class PostingsBuilder {
  private ids: Uint32Array = new Uint32Array(64);
  private count = 0;
  private max = 0;

  add(id: number): void {
    if (this.count === this.ids.length) {
      const grown = new Uint32Array(this.ids.length * 2);
      grown.set(this.ids);
      this.ids = grown;
    }
    this.ids[this.count++] = id;
    if (id > this.max) this.max = id;
  }

  build(): Postings {
    if (this.count === 0) return empty;
    const universe = this.max + 1;
    if (!preferBitset(this.count, universe)) {
      return { kind: "array", ids: this.ids.slice(0, this.count) };
    }
    const words = wordsFor(universe);
    for (let i = 0; i < this.count; i++) {
      const id = this.ids[i]!;
      words[id >>> 5]! |= 1 << (id & 31);
    }
    return { kind: "bitset", words, universe };
  }
}

const filterByMembership = (source: Uint32Array, keep: (id: number) => boolean): Postings => {
  const out = new Uint32Array(source.length);
  let n = 0;
  for (let i = 0; i < source.length; i++) {
    const id = source[i]!;
    if (keep(id)) out[n++] = id;
  }
  return { kind: "array", ids: out.slice(0, n) };
};

export const and = (a: Postings, b: Postings): Postings => {
  // The case worth optimizing: one narrow run against one wide one. Probing the
  // wide side costs the narrow side's length, so a selective predicate stays
  // cheap no matter how unselective its partner is.
  if (a.kind === "array" && b.kind === "bitset") {
    return filterByMembership(a.ids, (id) => id < b.universe && test(b.words, id));
  }
  if (a.kind === "bitset" && b.kind === "array") return and(b, a);

  if (a.kind === "bitset" && b.kind === "bitset") {
    const universe = Math.min(a.universe, b.universe);
    const words = wordsFor(universe);
    for (let i = 0; i < words.length; i++) words[i] = a.words[i]! & b.words[i]!;
    const result: Postings = { kind: "bitset", words, universe };
    // An intersection is usually far sparser than its inputs; hand back the
    // cheaper shape so the next operation starts from the better side.
    const n = popcount(words);
    return preferBitset(n, universe) ? result : toArray(result);
  }

  // Two sorted runs: a merge, allocating nothing per element.
  const x = (a as { ids: Uint32Array }).ids;
  const y = (b as { ids: Uint32Array }).ids;
  const out = new Uint32Array(Math.min(x.length, y.length));
  let i = 0;
  let j = 0;
  let n = 0;
  while (i < x.length && j < y.length) {
    const p = x[i]!;
    const q = y[j]!;
    if (p === q) {
      out[n++] = p;
      i++;
      j++;
    } else if (p < q) i++;
    else j++;
  }
  return { kind: "array", ids: out.slice(0, n) };
};

export const or = (a: Postings, b: Postings): Postings => {
  if (a.kind === "bitset" && b.kind === "bitset") {
    const universe = Math.max(a.universe, b.universe);
    const words = wordsFor(universe);
    for (let i = 0; i < words.length; i++) {
      words[i] = (i < a.words.length ? a.words[i]! : 0) | (i < b.words.length ? b.words[i]! : 0);
    }
    return { kind: "bitset", words, universe };
  }
  if (a.kind === "bitset" || b.kind === "bitset") {
    const dense = (a.kind === "bitset" ? a : b) as Extract<Postings, { kind: "bitset" }>;
    const sparse = (a.kind === "array" ? a : b) as Extract<Postings, { kind: "array" }>;
    const universe = Math.max(dense.universe, sparse.ids.length === 0
      ? 0
      : sparse.ids[sparse.ids.length - 1]! + 1);
    const words = wordsFor(universe);
    words.set(dense.words);
    for (let i = 0; i < sparse.ids.length; i++) {
      const id = sparse.ids[i]!;
      words[id >>> 5]! |= 1 << (id & 31);
    }
    return { kind: "bitset", words, universe };
  }

  const x = a.ids;
  const y = b.ids;
  const out = new Uint32Array(x.length + y.length);
  let i = 0;
  let j = 0;
  let n = 0;
  while (i < x.length && j < y.length) {
    const p = x[i]!;
    const q = y[j]!;
    if (p === q) {
      out[n++] = p;
      i++;
      j++;
    } else if (p < q) out[n++] = x[i++]!;
    else out[n++] = y[j++]!;
  }
  while (i < x.length) out[n++] = x[i++]!;
  while (j < y.length) out[n++] = y[j++]!;
  return { kind: "array", ids: out.slice(0, n) };
};

export const toArray = (p: Postings): Postings & { kind: "array" } => {
  if (p.kind === "array") return p;
  const out = new Uint32Array(popcount(p.words));
  let n = 0;
  for (let w = 0; w < p.words.length; w++) {
    let bits = p.words[w]!;
    while (bits !== 0) {
      const lsb = bits & -bits;
      out[n++] = (w << 5) + (31 - Math.clz32(lsb));
      bits ^= lsb;
    }
  }
  return { kind: "array", ids: out };
};

/** Ascending identifiers, materializing nothing beyond the current value. */
export function* iterate(p: Postings): Generator<Seq> {
  if (p.kind === "array") {
    for (let i = 0; i < p.ids.length; i++) yield asSeq(p.ids[i]!);
    return;
  }
  for (let w = 0; w < p.words.length; w++) {
    let bits = p.words[w]!;
    while (bits !== 0) {
      const lsb = bits & -bits;
      yield asSeq((w << 5) + (31 - Math.clz32(lsb)));
      bits ^= lsb;
    }
  }
}

/** Intersect narrowest-first so the working set shrinks as early as possible. */
export const andAll = (runs: ReadonlyArray<Postings>): Postings => {
  if (runs.length === 0) return empty;
  const ordered = [...runs].sort((a, b) => size(a) - size(b));
  let acc = ordered[0]!;
  for (let i = 1; i < ordered.length && size(acc) > 0; i++) acc = and(acc, ordered[i]!);
  return acc;
};

export const orAll = (runs: ReadonlyArray<Postings>): Postings => {
  if (runs.length === 0) return empty;
  let acc = runs[0]!;
  for (let i = 1; i < runs.length; i++) acc = or(acc, runs[i]!);
  return acc;
};
