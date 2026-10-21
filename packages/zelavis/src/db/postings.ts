import { asSeq, type Seq } from "./model.js";

/**
 * A set of identifiers, kept as one container per segment of 65536.
 *
 * Measurements on a million-object dataset showed the columnar path spending
 * most of its time turning several hundred thousand postings into JavaScript
 * objects before intersecting them, and — worse — the cost scaled with the
 * *widest* predicate rather than the size of the answer. A wide predicate is
 * exactly what a developer writes without thinking about it.
 *
 * Both problems come from the representation. A sorted list must be walked in
 * full to be intersected; a bitmap can be *probed* in constant time. So a
 * narrow run intersected against a wide one costs the narrow one's length, and
 * the wide side never becomes a JavaScript array at all.
 *
 * Segments are the unit because they are the sealed blob's unit: a blob decodes
 * straight into one container, and the choice between a list and a bitmap is
 * made per segment, as the blob makes it. A set operation walks the segments of
 * both sides together and skips any segment one side does not have, so the
 * identifier space can be as wide as a partition's — 48 bits — and a sparse set
 * across it costs only the segments it touches.
 */

/** Identifiers per segment, and bits per bitmap. */
export const SPAN = 65536;

const WORDS = SPAN / 32;

/**
 * A list costs two bytes an identifier and a bitmap a flat 8192, so a segment
 * holding more than 4096 is cheaper, and faster to probe, as a bitmap.
 */
const BITMAP_THRESHOLD = 4096;

/** One segment's identifiers, as offsets within it. */
export type Container =
  | { readonly kind: "list"; readonly offsets: Uint16Array }
  | { readonly kind: "bitmap"; readonly words: Uint32Array; readonly count: number };

/** Segment indexes ascending, each with its non-empty container. */
export interface Postings {
  readonly segments: ReadonlyArray<number>;
  readonly containers: ReadonlyArray<Container>;
}

export const empty: Postings = { segments: [], containers: [] };

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

const bit = (words: Uint32Array, offset: number): boolean =>
  ((words[offset >>> 5]! >>> (offset & 31)) & 1) === 1;

const containerSize = (c: Container): number => (c.kind === "list" ? c.offsets.length : c.count);

const containerHas = (c: Container, offset: number): boolean => {
  if (c.kind === "bitmap") return bit(c.words, offset);
  let lo = 0;
  let hi = c.offsets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = c.offsets[mid]!;
    if (v === offset) return true;
    if (v < offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
};

/** The cheaper shape for a set of words, or nothing when it is empty. */
const fromWords = (words: Uint32Array): Container | undefined => {
  const count = popcount(words);
  if (count === 0) return undefined;
  if (count > BITMAP_THRESHOLD) return { kind: "bitmap", words, count };
  const offsets = new Uint16Array(count);
  let n = 0;
  for (let w = 0; w < words.length; w++) {
    let bits = words[w]!;
    while (bits !== 0) {
      const lsb = bits & -bits;
      offsets[n++] = (w << 5) + (31 - Math.clz32(lsb));
      bits ^= lsb;
    }
  }
  return { kind: "list", offsets };
};

/** Sorted, distinct offsets in the cheaper shape, or nothing when there are none. */
const fromOffsets = (offsets: Uint16Array): Container | undefined => {
  if (offsets.length === 0) return undefined;
  if (offsets.length <= BITMAP_THRESHOLD) return { kind: "list", offsets };
  const words = new Uint32Array(WORDS);
  for (const offset of offsets) words[offset >>> 5]! |= 1 << (offset & 31);
  return { kind: "bitmap", words, count: offsets.length };
};

const wordsOf = (c: Container): Uint32Array => {
  if (c.kind === "bitmap") return c.words;
  const words = new Uint32Array(WORDS);
  for (const offset of c.offsets) words[offset >>> 5]! |= 1 << (offset & 31);
  return words;
};

const keepOffsets = (source: Uint16Array, keep: (offset: number) => boolean): Container | undefined => {
  const out = new Uint16Array(source.length);
  let n = 0;
  for (const offset of source) if (keep(offset)) out[n++] = offset;
  return fromOffsets(out.slice(0, n));
};

const containerAnd = (a: Container, b: Container): Container | undefined => {
  // The case worth optimizing: one narrow run against one wide one. Probing the
  // wide side costs the narrow side's length, so a selective predicate stays
  // cheap no matter how unselective its partner is.
  if (a.kind === "list" && b.kind === "bitmap") return keepOffsets(a.offsets, (o) => bit(b.words, o));
  if (a.kind === "bitmap" && b.kind === "list") return containerAnd(b, a);
  if (a.kind === "bitmap" && b.kind === "bitmap") {
    const words = new Uint32Array(WORDS);
    for (let i = 0; i < WORDS; i++) words[i] = a.words[i]! & b.words[i]!;
    return fromWords(words);
  }
  // Two sorted runs: a merge, allocating nothing per element.
  const x = (a as { offsets: Uint16Array }).offsets;
  const y = (b as { offsets: Uint16Array }).offsets;
  const out = new Uint16Array(Math.min(x.length, y.length));
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
  return fromOffsets(out.slice(0, n));
};

const containerOr = (a: Container, b: Container): Container => {
  if (a.kind === "list" && b.kind === "list") {
    const x = a.offsets;
    const y = b.offsets;
    const out = new Uint16Array(x.length + y.length);
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
    return fromOffsets(out.slice(0, n))!;
  }
  const words = Uint32Array.from(wordsOf(a));
  const other = wordsOf(b);
  for (let i = 0; i < WORDS; i++) words[i]! |= other[i]!;
  return fromWords(words)!;
};

/**
 * Everything in `a` that is not in `b`.
 *
 * The read side of the sealed tier: a blob cannot be edited, so a posting
 * removed from a lens it was sealed into is subtracted here instead. `b` is the
 * tombstone set and is normally tiny, so a list on the left is filtered by
 * probing, and a bitmap has `b`'s bits cleared rather than being rewalked.
 */
const containerAndNot = (a: Container, b: Container): Container | undefined => {
  if (a.kind === "list") return keepOffsets(a.offsets, (o) => !containerHas(b, o));
  const words = Uint32Array.from(a.words);
  if (b.kind === "list") {
    for (const offset of b.offsets) words[offset >>> 5]! &= ~(1 << (offset & 31));
  } else {
    for (let i = 0; i < WORDS; i++) words[i]! &= ~b.words[i]!;
  }
  return fromWords(words);
};

const indexOf = (segments: ReadonlyArray<number>, segment: number): number => {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = segments[mid]!;
    if (v === segment) return mid;
    if (v < segment) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
};

export const size = (p: Postings): number => {
  let total = 0;
  for (const c of p.containers) total += containerSize(c);
  return total;
};

export const has = (p: Postings, id: number): boolean => {
  const at = indexOf(p.segments, Math.floor(id / SPAN));
  return at >= 0 && containerHas(p.containers[at]!, id % SPAN);
};

/**
 * Accumulates identifiers, in any order, then picks each segment's shape.
 *
 * Most callers add in ascending order and pay nothing for sorting; a range read
 * adds in value order, and its segments are sorted once when built.
 */
export class PostingsBuilder {
  private readonly bySegment = new Map<number, { offsets: number[]; sorted: boolean }>();

  add(id: number): void {
    const segment = Math.floor(id / SPAN);
    const offset = id % SPAN;
    const held = this.bySegment.get(segment);
    if (held === undefined) {
      this.bySegment.set(segment, { offsets: [offset], sorted: true });
      return;
    }
    const last = held.offsets[held.offsets.length - 1]!;
    if (offset === last) return;
    if (offset < last) held.sorted = false;
    held.offsets.push(offset);
  }

  /** A whole decoded segment: offsets ascending, as a blob holds them. */
  addSegment(segment: number, container: Container): void {
    if (container.kind === "list") {
      for (const offset of container.offsets) this.add(segment * SPAN + offset);
      return;
    }
    let held = this.bySegment.get(segment);
    if (held === undefined) {
      held = { offsets: [], sorted: true };
      this.bySegment.set(segment, held);
    }
    for (let w = 0; w < WORDS; w++) {
      let bits = container.words[w]!;
      while (bits !== 0) {
        const lsb = bits & -bits;
        const offset = (w << 5) + (31 - Math.clz32(lsb));
        const last = held.offsets[held.offsets.length - 1];
        if (last !== undefined && offset <= last) {
          if (offset === last) {
            bits ^= lsb;
            continue;
          }
          held.sorted = false;
        }
        held.offsets.push(offset);
        bits ^= lsb;
      }
    }
  }

  build(): Postings {
    const segments = [...this.bySegment.keys()].sort((a, b) => a - b);
    const containers: Container[] = [];
    const kept: number[] = [];
    for (const segment of segments) {
      const held = this.bySegment.get(segment)!;
      let offsets = Uint16Array.from(held.offsets);
      if (!held.sorted) {
        offsets.sort();
        let n = 0;
        for (let i = 0; i < offsets.length; i++) {
          if (i === 0 || offsets[i] !== offsets[i - 1]) offsets[n++] = offsets[i]!;
        }
        offsets = offsets.slice(0, n);
      }
      const container = fromOffsets(offsets);
      if (container === undefined) continue;
      kept.push(segment);
      containers.push(container);
    }
    return { segments: kept, containers };
  }
}

export const and = (a: Postings, b: Postings): Postings => {
  const segments: number[] = [];
  const containers: Container[] = [];
  let i = 0;
  let j = 0;
  while (i < a.segments.length && j < b.segments.length) {
    const x = a.segments[i]!;
    const y = b.segments[j]!;
    if (x === y) {
      const both = containerAnd(a.containers[i]!, b.containers[j]!);
      if (both !== undefined) {
        segments.push(x);
        containers.push(both);
      }
      i++;
      j++;
    } else if (x < y) i++;
    else j++;
  }
  return { segments, containers };
};

export const or = (a: Postings, b: Postings): Postings => {
  const segments: number[] = [];
  const containers: Container[] = [];
  let i = 0;
  let j = 0;
  while (i < a.segments.length || j < b.segments.length) {
    const x = a.segments[i];
    const y = b.segments[j];
    if (y === undefined || (x !== undefined && x < y)) {
      segments.push(x!);
      containers.push(a.containers[i++]!);
    } else if (x === undefined || y < x) {
      segments.push(y);
      containers.push(b.containers[j++]!);
    } else {
      segments.push(x);
      containers.push(containerOr(a.containers[i++]!, b.containers[j++]!));
    }
  }
  return { segments, containers };
};

/** Everything in `a` that is not in `b`. */
export const andNot = (a: Postings, b: Postings): Postings => {
  if (b.segments.length === 0) return a;
  const segments: number[] = [];
  const containers: Container[] = [];
  let j = 0;
  for (let i = 0; i < a.segments.length; i++) {
    const x = a.segments[i]!;
    while (j < b.segments.length && b.segments[j]! < x) j++;
    const left = j < b.segments.length && b.segments[j] === x
      ? containerAndNot(a.containers[i]!, b.containers[j]!)
      : a.containers[i]!;
    if (left === undefined) continue;
    segments.push(x);
    containers.push(left);
  }
  return { segments, containers };
};

/** Ascending identifiers, materializing nothing beyond the current value. */
export function* iterate(p: Postings): Generator<Seq> {
  for (let s = 0; s < p.segments.length; s++) {
    const base = p.segments[s]! * SPAN;
    const c = p.containers[s]!;
    if (c.kind === "list") {
      for (const offset of c.offsets) yield asSeq(base + offset);
      continue;
    }
    for (let w = 0; w < WORDS; w++) {
      let bits = c.words[w]!;
      while (bits !== 0) {
        const lsb = bits & -bits;
        yield asSeq(base + (w << 5) + (31 - Math.clz32(lsb)));
        bits ^= lsb;
      }
    }
  }
}

/** Every identifier, ascending, as an array: for callers that need them all at once. */
export const ids = (p: Postings): Array<number> => [...iterate(p)];

/** Intersect narrowest-first so the working set shrinks as early as possible. */
export const andAll = (runs: ReadonlyArray<Postings>): Postings => {
  if (runs.length === 0) return empty;
  const ordered = [...runs].sort((a, b) => size(a) - size(b));
  let acc = ordered[0]!;
  for (let i = 1; i < ordered.length && acc.segments.length > 0; i++) acc = and(acc, ordered[i]!);
  return acc;
};

export const orAll = (runs: ReadonlyArray<Postings>): Postings => {
  if (runs.length === 0) return empty;
  let acc = runs[0]!;
  for (let i = 1; i < runs.length; i++) acc = or(acc, runs[i]!);
  return acc;
};
