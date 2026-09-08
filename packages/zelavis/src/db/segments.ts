/**
 * Postings stored as blobs rather than as one key per posting.
 *
 * A posting written as a key with no value is the cheapest possible write —
 * idempotent, tiny, no read-modify-write — and the most expensive possible
 * read. Resolving a term that matches half a million objects means half a
 * million b-tree entries visited and half a million keys decoded, which is the
 * cost that dominates a wide query however good the set algebra above it is.
 *
 * A blob inverts that: one entry per 65536 identifiers instead of one per
 * posting, so the same term costs eight seeks rather than half a million. The
 * write side keeps its cheap shape, because blobs are never edited in place —
 * they are sealed from state, and everything written since sits in the live
 * tier beside them.
 *
 * The identifier space is dense and partition-local, which is what makes a
 * fixed span work: segment `n` covers `[n * 65536, (n + 1) * 65536)`, and a
 * sparse tenant simply has fewer segments rather than emptier ones.
 */

/** Identifiers per segment. Also the bit count of a dense segment. */
export const SEGMENT_SPAN = 65536;

const DENSE_BYTES = SEGMENT_SPAN / 8;

const SPARSE = 0x00;
const DENSE = 0x01;

/**
 * Sparse costs two bytes an identifier, dense a flat 8192.
 *
 * Below the crossover the offset list is both smaller and faster to walk, so
 * the shape is chosen per segment. This mirrors the in-memory choice in
 * `postings.ts` for the same reason: a fixed representation is wrong at one
 * end of the density range or the other.
 */
const preferDense = (count: number) => count * 2 >= DENSE_BYTES;

export const segmentOf = (id: number): number => Math.floor(id / SEGMENT_SPAN);

/** The identifiers of one segment, ascending, as a blob. */
export const encodeSegment = (ids: ReadonlyArray<number>, base: number): Uint8Array => {
  if (preferDense(ids.length)) {
    const out = new Uint8Array(1 + DENSE_BYTES);
    out[0] = DENSE;
    for (const id of ids) {
      const offset = id - base;
      out[1 + (offset >>> 3)]! |= 1 << (offset & 7);
    }
    return out;
  }
  const out = new Uint8Array(1 + ids.length * 2);
  out[0] = SPARSE;
  const view = new DataView(out.buffer);
  for (let i = 0; i < ids.length; i++) {
    view.setUint16(1 + i * 2, ids[i]! - base, true);
  }
  return out;
};

/** Ascending identifiers of a blob, handed out one at a time. */
export const decodeSegment = (bytes: Uint8Array, base: number, emit: (id: number) => void): void => {
  if (bytes.length === 0) return;
  if (bytes[0] === DENSE) {
    for (let byte = 0; byte < DENSE_BYTES; byte++) {
      let bits = bytes[1 + byte] ?? 0;
      while (bits !== 0) {
        const lsb = bits & -bits;
        emit(base + (byte << 3) + (31 - Math.clz32(lsb)));
        bits ^= lsb;
      }
    }
    return;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 1; at + 1 < bytes.length; at += 2) {
    emit(base + view.getUint16(at, true));
  }
};
