/**
 * Order-preserving binary keys.
 *
 * A key-value engine sorts by bytes, so every range scan in this store depends
 * on byte order matching logical order. If it does not, a posting scan returns
 * the wrong rows and reports them as data rather than as an error — the worst
 * failure this system can have, because nothing looks broken.
 *
 * Two rules make that hold. Numbers are fixed-width big-endian, so `2 < 10`
 * byte-wise as well as numerically. Strings are terminated rather than
 * separated by position, so `("ab", "c")` cannot encode to the same bytes as
 * `("a", "bc")` — the collision that a naive `field + ":" + term` invites.
 */

/**
 * Lens tags.
 *
 * Each lens occupies a disjoint range of one keyspace. That is how a store with
 * no column families still gets namespaces: a scan for terms cannot wander into
 * payloads, because it never leaves its tag.
 */
export const Tag = {
  Payload: 0x01,
  Manifest: 0x02,
  Term: 0x03,
  Column: 0x04,
  Measure: 0x05,
  Edge: 0x06,
  Identity: 0x07,
  IdentityBySeq: 0x08,
  Meta: 0x09,
  Event: 0x0a,
  Segment: 0x0b,
  Tombstone: 0x0c,
} as const;

export type Tag = (typeof Tag)[keyof typeof Tag];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A terminated, escaped string.
 *
 * `0x00` terminates. An escaped byte must therefore never *begin* with `0x00`,
 * or the encoding of a value containing one starts with the encoding of the
 * value truncated before it — and a prefix range for the short value then
 * contains the long one. `0x00 0xFF` fails exactly there: it sorts below the
 * incremented bound, so the range includes what it must exclude.
 *
 * So `0x00` escapes to `0x01 0x01` and `0x01` to `0x01 0x02`. Nothing escaped
 * starts with the terminator, and order still holds: the escape lead `0x01`
 * sorts above the terminator and below every literal byte from `0x02` up.
 */
const writeString = (out: number[], value: string): void => {
  for (const byte of encoder.encode(value)) {
    if (byte === 0x00) out.push(0x01, 0x01);
    else if (byte === 0x01) out.push(0x01, 0x02);
    else out.push(byte);
  }
  out.push(0x00);
};

const readString = (bytes: Uint8Array, at: number): { value: string; next: number } => {
  const raw: number[] = [];
  let i = at;
  while (i < bytes.length) {
    const byte = bytes[i]!;
    if (byte === 0x00) {
      i += 1;
      break;
    }
    if (byte === 0x01) {
      raw.push(bytes[i + 1] === 0x01 ? 0x00 : 0x01);
      i += 2;
      continue;
    }
    raw.push(byte);
    i += 1;
  }
  return { value: decoder.decode(Uint8Array.from(raw)), next: i };
};

const writeU32 = (out: number[], value: number): void => {
  out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
};

const readU32 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;

const build = (tag: Tag, write: (out: number[]) => void): Uint8Array => {
  const out: number[] = [tag];
  write(out);
  return Uint8Array.from(out);
};

/** `[tag][seq]` — the payload and its manifest, addressed by identifier. */
export const payloadKey = (seq: number): Uint8Array =>
  build(Tag.Payload, (out) => writeU32(out, seq));

export const manifestKey = (seq: number): Uint8Array =>
  build(Tag.Manifest, (out) => writeU32(out, seq));

/** `[tag][field][term][seq]` — a prefix scan of field+term is the posting list. */
export const termKey = (field: string, term: string, seq: number): Uint8Array =>
  build(Tag.Term, (out) => {
    writeString(out, field);
    writeString(out, term);
    writeU32(out, seq);
  });

export const termPrefix = (field: string, term: string): Uint8Array =>
  build(Tag.Term, (out) => {
    writeString(out, field);
    writeString(out, term);
  });

export const columnKey = (column: string, value: string, seq: number): Uint8Array =>
  build(Tag.Column, (out) => {
    writeString(out, column);
    writeString(out, value);
    writeU32(out, seq);
  });

export const columnPrefix = (column: string, value: string): Uint8Array =>
  build(Tag.Column, (out) => {
    writeString(out, column);
    writeString(out, value);
  });

export const measureKey = (column: string, seq: number): Uint8Array =>
  build(Tag.Measure, (out) => {
    writeString(out, column);
    writeU32(out, seq);
  });

export const measurePrefix = (column: string): Uint8Array =>
  build(Tag.Measure, (out) => writeString(out, column));

export const edgeKey = (edgeType: string, src: number, dst: number): Uint8Array =>
  build(Tag.Edge, (out) => {
    writeString(out, edgeType);
    writeU32(out, src);
    writeU32(out, dst);
  });

export const edgePrefix = (edgeType: string, src: number): Uint8Array =>
  build(Tag.Edge, (out) => {
    writeString(out, edgeType);
    writeU32(out, src);
  });

/** `[tag][namespace][key]` → seq. The caller's own name for a record. */
export const identityKey = (namespace: string, key: string): Uint8Array =>
  build(Tag.Identity, (out) => {
    writeString(out, namespace);
    writeString(out, key);
  });

/** The reverse binding, so retraction can clear an identity it was not given. */
export const identityBySeqKey = (seq: number): Uint8Array =>
  build(Tag.IdentityBySeq, (out) => writeU32(out, seq));

export const metaKey = (name: string): Uint8Array =>
  build(Tag.Meta, (out) => writeString(out, name));

/** Events are read in position order, so the position is the key. */
export const eventKey = (position: number): Uint8Array =>
  build(Tag.Event, (out) => writeU32(out, position));

export const eventPrefix = (): Uint8Array => Uint8Array.from([Tag.Event]);

/**
 * A sealed or retracted posting, addressed by the live key it shadows.
 *
 * Both tiers are built by *prefixing* a live posting key rather than by
 * re-encoding its fields, which keeps the lens tag inside the key. Terms,
 * columns and edges therefore stay as disjoint under `Segment` as they are
 * under their own tags, and every lens gets both tiers without a key function
 * of its own — including any lens added later.
 */
const under = (tag: Tag, key: Uint8Array): Uint8Array => {
  const out = new Uint8Array(key.length + 1);
  out[0] = tag;
  out.set(key, 1);
  return out;
};

/** `[Segment][live prefix][index]` — one blob per 65536 identifiers. */
export const segmentKey = (livePrefix: Uint8Array, index: number): Uint8Array => {
  const head = under(Tag.Segment, livePrefix);
  const out = new Uint8Array(head.length + 4);
  out.set(head);
  const at: number[] = [];
  writeU32(at, index);
  out.set(Uint8Array.from(at), head.length);
  return out;
};

export const segmentPrefix = (livePrefix: Uint8Array): Uint8Array =>
  under(Tag.Segment, livePrefix);

export const segmentIndexOf = (key: Uint8Array): number => readU32(key, key.length - 4);

/**
 * A posting removed from a lens that a sealed blob still claims.
 *
 * Sealed blobs are immutable, so a retraction cannot reach into one. It leaves
 * a tombstone instead, and the read subtracts it. Only postings below the seal
 * high-water mark need one: anything newer exists only in the live tier, where
 * deleting the key is enough.
 */
export const tombstoneKey = (postingKey: Uint8Array): Uint8Array =>
  under(Tag.Tombstone, postingKey);

export const tombstonePrefix = (livePrefix: Uint8Array): Uint8Array =>
  under(Tag.Tombstone, livePrefix);

/** The trailing identifier of a posting key, whatever precedes it. */
export const seqOf = (key: Uint8Array): number => readU32(key, key.length - 4);

/** The identifier a `[tag][etype][src][dst]` edge key points at. */
export const dstOf = (key: Uint8Array): number => readU32(key, key.length - 4);

export const positionOf = (key: Uint8Array): number => readU32(key, 1);

export const decodeIdentity = (key: Uint8Array): { namespace: string; key: string } => {
  const namespace = readString(key, 1);
  const name = readString(key, namespace.next);
  return { namespace: namespace.value, key: name.value };
};

/** Bytewise comparison, matching how an engine orders its keys. */
export const compareKeys = (a: Uint8Array, b: Uint8Array): number => {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
};

/**
 * The half-open range a prefix selects.
 *
 * Membership is a range test, never a byte-prefix test. The escape scheme above
 * is what currently keeps the two from disagreeing — no escaped byte begins
 * with the terminator, so no longer key can start with a shorter key's
 * encoding. That is a property of the encoding, not of the question being
 * asked, and it was already once written the other way: with `0x00` escaped as
 * `0x00 0xFF`, the encoding of `("a\0b")` did begin with the encoding of
 * `("a")`, and a byte-prefix check matched it while the range test did not.
 *
 * This is why no `hasPrefix` helper exists: it would be right often enough to
 * look correct, and wrong again the moment the encoding changes underneath it.
 */
export const prefixRange = (
  prefix: Uint8Array,
): { readonly start: Uint8Array; readonly end: Uint8Array | undefined } => ({
  start: prefix,
  end: prefixEnd(prefix),
});

export const inPrefixRange = (key: Uint8Array, prefix: Uint8Array): boolean => {
  if (compareKeys(key, prefix) < 0) return false;
  const end = prefixEnd(prefix);
  return end === undefined || compareKeys(key, end) < 0;
};

/**
 * The exclusive upper bound of a prefix range.
 *
 * Increments the last byte that can be incremented; a prefix of all `0xFF`
 * bytes has no upper bound and scans to the end of the keyspace.
 */
export const prefixEnd = (prefix: Uint8Array): Uint8Array | undefined => {
  const end = Uint8Array.from(prefix);
  for (let i = end.length - 1; i >= 0; i--) {
    if (end[i]! < 0xff) {
      end[i] = end[i]! + 1;
      return end.subarray(0, i + 1);
    }
  }
  return undefined;
};
