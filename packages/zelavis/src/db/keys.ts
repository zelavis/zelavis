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
  /** Retired: equality is answered by `Ordered`. A reindex drops what older stores hold here. */
  Column: 0x04,
  Measure: 0x05,
  Edge: 0x06,
  Identity: 0x07,
  IdentityBySeq: 0x08,
  Meta: 0x09,
  Event: 0x0a,
  Segment: 0x0b,
  Tombstone: 0x0c,
  Ordered: 0x0d,
  Dirty: 0x0e,
  Snapshot: 0x0f,
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
const writeEscaped = (out: number[], bytes: Uint8Array): void => {
  for (const byte of bytes) {
    if (byte === 0x00) out.push(0x01, 0x01);
    else if (byte === 0x01) out.push(0x01, 0x02);
    else out.push(byte);
  }
  out.push(0x00);
};

const writeString = (out: number[], value: string): void => writeEscaped(out, encoder.encode(value));

const readEscaped = (bytes: Uint8Array, at: number): { raw: Uint8Array; next: number } => {
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
  return { raw: Uint8Array.from(raw), next: i };
};

const readString = (bytes: Uint8Array, at: number): { value: string; next: number } => {
  const { raw, next } = readEscaped(bytes, at);
  return { value: decoder.decode(raw), next };
};

/**
 * A value the ordered lens can sort: JSON's scalars, which is what a document
 * holds, and byte strings for callers below the document layer.
 *
 * Each is encoded so that byte order is value order, the only order a
 * key-value engine knows. There is no separate integer, decimal or timestamp
 * kind, and the reasons are deliberate:
 *
 * - Integers are numbers. Every integer JSON carries exactly is a float64, so
 *   `2`, `2.5` and `3` sort together by value rather than by representation.
 * - A decimal that must not round belongs in a fixed-scale integer (cents, not
 *   dollars) or a string written to sort, never in a float that happens to
 *   look right.
 * - A timestamp sorts as a number of milliseconds, or as an ISO-8601 string
 *   written in UTC at one precision. Mixing the two in one column sorts every
 *   number before every string, which is correct and almost never intended.
 */
export type OrderedValue = null | boolean | number | string | Uint8Array;

/**
 * Where each kind of value sorts relative to the others.
 *
 * One column can hold different kinds in different documents, so there has to
 * be an order across kinds, not only within one — and a fixed one, never the
 * host's. Null sorts last, as `NULLS LAST` does for an ascending order in SQL:
 * the values a column is about come first, and the absence of one after them.
 * The gaps leave room for kinds added later without re-keying these.
 */
const Rank = {
  False: 0x20,
  True: 0x21,
  Number: 0x30,
  String: 0x40,
  Bytes: 0x50,
  Null: 0x70,
} as const;

/** The first and last rank of a value's kind; booleans are one kind. */
const kindOf = (value: OrderedValue): readonly [first: number, last: number] =>
  value === null
    ? [Rank.Null, Rank.Null]
    : typeof value === "boolean"
      ? [Rank.False, Rank.True]
      : typeof value === "number"
        ? [Rank.Number, Rank.Number]
        : typeof value === "string"
          ? [Rank.String, Rank.String]
          : [Rank.Bytes, Rank.Bytes];

/**
 * A float64 as eight bytes whose order is numeric order.
 *
 * IEEE 754 already orders non-negative numbers as unsigned big-endian bytes.
 * Flipping the sign bit lifts them above the negatives; flipping every bit of a
 * negative reverses its magnitude, so -1 sorts above -2. Negative zero is
 * written as zero, because the two are equal and must be one key.
 */
const writeNumber = (out: number[], value: number): void => {
  if (!Number.isFinite(value)) {
    throw new RangeError(`An ordered value must be a finite number, not ${value}.`);
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value === 0 ? 0 : value);
  if (bytes[0]! & 0x80) {
    for (let i = 0; i < 8; i++) bytes[i] = ~bytes[i]! & 0xff;
  } else {
    bytes[0] = bytes[0]! ^ 0x80;
  }
  for (const byte of bytes) out.push(byte);
};

const readNumber = (bytes: Uint8Array, at: number): number => {
  // A copy, made explicitly. A key can arrive as a Node Buffer — LMDB hands
  // them back that way — and `Buffer#slice` is a view, not a copy: flipping
  // its bits would corrupt the caller's key, and its `.buffer` is a whole pool
  // rather than these eight bytes.
  const raw = Uint8Array.from(bytes.subarray(at, at + 8));
  if (raw[0]! & 0x80) {
    raw[0] = raw[0]! ^ 0x80;
  } else {
    for (let i = 0; i < 8; i++) raw[i] = ~raw[i]! & 0xff;
  }
  return new DataView(raw.buffer).getFloat64(0);
};

/**
 * Strings compare by code point: the order of their UTF-8 bytes. Nothing is
 * normalized or case-folded and no locale is consulted, so a precomposed
 * accented letter and the same letter spelled with a combining accent are
 * different values, and `"Z"` sorts before `"a"`. A collation that folds either
 * would be a different index, chosen by name, not a default.
 */
const writeOrderedValue = (out: number[], value: OrderedValue): void => {
  if (value === null) out.push(Rank.Null);
  else if (value === false) out.push(Rank.False);
  else if (value === true) out.push(Rank.True);
  else if (typeof value === "number") {
    out.push(Rank.Number);
    writeNumber(out, value);
  } else if (typeof value === "string") {
    out.push(Rank.String);
    writeString(out, value);
  } else if (value instanceof Uint8Array) {
    out.push(Rank.Bytes);
    writeEscaped(out, value);
  } else {
    throw new TypeError(`Not an ordered value: ${typeof value}.`);
  }
};

const readOrderedValue = (bytes: Uint8Array, at: number): { value: OrderedValue; next: number } => {
  switch (bytes[at]) {
    case Rank.Null:
      return { value: null, next: at + 1 };
    case Rank.False:
      return { value: false, next: at + 1 };
    case Rank.True:
      return { value: true, next: at + 1 };
    case Rank.Number:
      return { value: readNumber(bytes, at + 1), next: at + 9 };
    case Rank.String:
      return readString(bytes, at + 1);
    case Rank.Bytes: {
      const { raw, next } = readEscaped(bytes, at + 1);
      return { value: raw, next };
    }
    default:
      throw new RangeError(`Unknown ordered value kind 0x${bytes[at]?.toString(16)}.`);
  }
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

/**
 * `[tag][column][value][seq]` — one posting per value, in value order.
 *
 * Unlike the column lens, which answers equality, this one answers order: a
 * range is a contiguous run of keys, and so is a page of it in either
 * direction. Equal values tie-break by identifier, which makes the order total
 * and a page boundary exact.
 */
export const orderedKey = (column: string, value: OrderedValue, seq: number): Uint8Array =>
  build(Tag.Ordered, (out) => {
    writeString(out, column);
    writeOrderedValue(out, value);
    writeU32(out, seq);
  });

/** Every value of one column, in order. */
export const orderedColumnPrefix = (column: string): Uint8Array =>
  build(Tag.Ordered, (out) => writeString(out, column));

/**
 * Every object holding exactly this value in the column.
 *
 * No value's encoding is a prefix of another's — numbers are fixed-width and
 * strings and bytes are terminated — so this range never reaches a longer one.
 */
export const orderedValuePrefix = (column: string, value: OrderedValue): Uint8Array =>
  build(Tag.Ordered, (out) => {
    writeString(out, column);
    writeOrderedValue(out, value);
  });

/** The column, value and identifier an ordered key records. */
export const decodeOrderedKey = (
  key: Uint8Array,
): { readonly column: string; readonly value: OrderedValue; readonly seq: number } => {
  const column = readString(key, 1);
  const { value } = readOrderedValue(key, column.next);
  return { column: column.value, value, seq: readU32(key, key.length - 4) };
};

/**
 * The run of one column holding values of the same kind as `value`.
 *
 * What a one-sided range is held within: `lt(5)` asks about numbers below
 * five, not about the booleans that happen to sort below every number.
 */
export const orderedKindRange = (
  column: string,
  value: OrderedValue,
): { readonly start: Uint8Array; readonly end: Uint8Array } => {
  const [first, last] = kindOf(value);
  return {
    start: build(Tag.Ordered, (out) => {
      writeString(out, column);
      out.push(first);
    }),
    end: build(Tag.Ordered, (out) => {
      writeString(out, column);
      out.push(last + 1);
    }),
  };
};

/** Whether two values are of one kind, and so comparable the way a one-sided range compares them. */
export const sameOrderedKind = (a: OrderedValue, b: OrderedValue): boolean =>
  kindOf(a)[0] === kindOf(b)[0];

/**
 * Value order exactly as the ordered lens sorts: the order of the encodings.
 *
 * Anything that sorts values outside the lens uses this, so an answer from an
 * index and an answer sorted in memory can never disagree.
 */
export const compareOrderedValues = (a: OrderedValue, b: OrderedValue): number => {
  const left: number[] = [];
  const right: number[] = [];
  writeOrderedValue(left, a);
  writeOrderedValue(right, b);
  return compareKeys(Uint8Array.from(left), Uint8Array.from(right));
};

/** One field of a composite key: its value, and how that field sorts. */
export interface TupleComponent {
  /** Null or undefined when there is no value to sort by. */
  readonly value: OrderedValue | undefined;
  readonly direction: "asc" | "desc";
  readonly nulls: "first" | "last";
}

/** A missing value in a composite key: below every value, or above every one. */
const NoValue = { First: 0x10, Last: 0xf0 } as const;

/**
 * A tuple of values as a string whose order is the tuple's.
 *
 * Each field is encoded as the ordered lens encodes a value, and those
 * encodings are self-delimiting — a number is fixed-width and a string
 * terminated — so concatenating them sorts field by field. A descending field
 * has every byte of its encoding inverted, which reverses its order and keeps
 * it self-delimiting. A missing value is one byte below or above every
 * encoded value of either direction, so where nulls go is the field's own
 * choice rather than a side effect of its direction.
 *
 * The bytes are written as lowercase hex, whose character order is byte order,
 * which makes the tuple an ordinary string in the ordered lens: sealed, paged
 * and backed up like any other value, and a prefix of fields is a prefix of
 * the string.
 */
export const orderedTuple = (components: ReadonlyArray<TupleComponent>): string => {
  let hex = "";
  for (const component of components) {
    const out: number[] = [];
    if (component.value === null || component.value === undefined) {
      out.push(component.nulls === "first" ? NoValue.First : NoValue.Last);
    } else {
      writeOrderedValue(out, component.value);
      if (component.direction === "desc") {
        for (let i = 0; i < out.length; i++) out[i] = ~out[i]! & 0xff;
      }
    }
    for (const byte of out) hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
};

/**
 * The values of a tuple `orderedTuple` wrote, undefined where a field had
 * none. The directions must be the ones it was written with: a descending
 * field's bytes are inverted, and nothing in them says so.
 */
export const decodeOrderedTuple = (
  tuple: string,
  directions: ReadonlyArray<"asc" | "desc">,
): Array<OrderedValue | undefined> => {
  const bytes = Uint8Array.from(tuple.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  const out: Array<OrderedValue | undefined> = [];
  let at = 0;
  for (const direction of directions) {
    if (bytes[at] === NoValue.First || bytes[at] === NoValue.Last) {
      out.push(undefined);
      at += 1;
      continue;
    }
    const rest = direction === "desc" ? bytes.subarray(at).map((byte) => ~byte & 0xff) : bytes.subarray(at);
    const { value, next } = readOrderedValue(rest, 0);
    out.push(value);
    at += next;
  }
  return out;
};

/**
 * `[Snapshot][seq]` — one live record as of the position the snapshot covers.
 *
 * Outside both the state and the derived tags on purpose: a rebuild clears
 * those and re-derives them, and it would be clearing what it is rebuilding
 * from. A snapshot is neither state nor a lens; it is a copy of state, kept so
 * that history cut away by compaction is not the only way back.
 */
export const snapshotKey = (seq: number): Uint8Array =>
  build(Tag.Snapshot, (out) => writeU32(out, seq));

export const snapshotPrefix = (): Uint8Array => Uint8Array.from([Tag.Snapshot]);

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

/**
 * `[Dirty][live prefix][segment]` — a seal group written since the last seal.
 *
 * Once a store has been sealed, a posting write marks the group it lands in —
 * one lens prefix within one segment span — so the next seal visits the groups
 * that changed instead of every posting still live. A posting an earlier seal
 * declined as too sparse would otherwise be read again by every seal after it.
 */
export const dirtyKey = (livePrefix: Uint8Array, segment: number): Uint8Array => {
  const out = new Uint8Array(livePrefix.length + 5);
  out[0] = Tag.Dirty;
  out.set(livePrefix, 1);
  new DataView(out.buffer).setUint32(livePrefix.length + 1, segment);
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
