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
 *
 * One engine holds one shard, and a shard holds many partitions. Every key a
 * partition writes begins with that partition's name, so a partition owns one
 * contiguous range of the keyspace: its identifiers, its log and its lenses
 * cannot meet another partition's, whatever a lens forgets to name, and the
 * whole partition can be copied or removed as a range.
 */

/** The two halves of a shard's keyspace. */
export const Space = {
  /** The shard's own records: who may write it, and which layout it holds. */
  Shard: 0x00,
  /** Partitions, each under its own name. */
  Partition: 0x01,
} as const;

/** Tags inside a partition's range. */
export const Tag = {
  /** One record: its version, identity, manifest and body, or that it was retired. */
  Record: 0x01,
  Term: 0x03,
  // 0x04 is unused: equality is answered by `Ordered`.
  Measure: 0x05,
  Edge: 0x06,
  Identity: 0x07,
  Meta: 0x09,
  Event: 0x0a,
  Segment: 0x0b,
  Tombstone: 0x0c,
  Ordered: 0x0d,
  Dirty: 0x0e,
  Snapshot: 0x0f,
  EdgeReverse: 0x10,
  /** Retired records by the position that retired them, so compaction finds the ones it may drop. */
  Retired: 0x11,
} as const;

export type Tag = (typeof Tag)[keyof typeof Tag];

/** The highest identifier a partition hands out: six bytes in every key. */
export const MAX_SEQ = 2 ** 48 - 1;

/** Bytes an identifier takes at the end of a key. */
export const SEQ_BYTES = 6;

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

const writeEscapedPrefix = (out: number[], bytes: Uint8Array): void => {
  for (const byte of bytes) {
    if (byte === 0x00) out.push(0x01, 0x01);
    else if (byte === 0x01) out.push(0x01, 0x02);
    else out.push(byte);
  }
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


/** Four bytes, refused rather than masked when the value does not fit. */
const writeU32 = (out: number[], value: number): void => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${value} does not fit in four bytes.`);
  }
  out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
};

const readU32 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;

/** An identifier as six big-endian bytes. Above `MAX_SEQ` is refused, never wrapped. */
const writeSeq = (out: number[], seq: number): void => {
  if (!Number.isInteger(seq) || seq < 0 || seq > MAX_SEQ) {
    throw new RangeError(`${seq} is not an identifier: identifiers run from 0 to ${MAX_SEQ}.`);
  }
  const high = Math.floor(seq / 2 ** 32);
  out.push((high >>> 8) & 0xff, high & 0xff);
  writeU32(out, seq >>> 0);
};

const readSeq = (bytes: Uint8Array, at: number): number =>
  ((bytes[at]! << 8) | bytes[at + 1]!) * 2 ** 32 + readU32(bytes, at + 2);

/** A position or counter as eight big-endian bytes, up to the largest safe integer. */
const writeU64 = (out: number[], value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${value} is not a position: positions are safe non-negative integers.`);
  }
  writeU32(out, Math.floor(value / 2 ** 32));
  writeU32(out, value >>> 0);
};

const readU64 = (bytes: Uint8Array, at: number): number =>
  readU32(bytes, at) * 2 ** 32 + readU32(bytes, at + 4);

/** An identifier as the bytes a key ends with. */
export const seqBytes = (seq: number): Uint8Array => {
  const out: number[] = [];
  writeSeq(out, seq);
  return Uint8Array.from(out);
};

/** The identifier six bytes hold, wherever they sit. */
export const readSeqAt = (bytes: Uint8Array, at: number): number => readSeq(bytes, at);

/** A counter as the eight bytes a meta value holds. */
export const u64Bytes = (value: number): Uint8Array => {
  const out: number[] = [];
  writeU64(out, value);
  return Uint8Array.from(out);
};

/** The counter eight bytes hold. */
export const readU64At = (bytes: Uint8Array, at: number): number => readU64(bytes, at);

/** The trailing identifier of a posting key, whatever precedes it. */
export const seqOf = (key: Uint8Array): number => readSeq(key, key.length - SEQ_BYTES);

/** The identifier a `[etype][src][dst]` edge key points at. */
export const dstOf = (key: Uint8Array): number => readSeq(key, key.length - SEQ_BYTES);

/** The identifier a `[etype][dst][src]` reverse edge key points at. */
export const srcOf = (key: Uint8Array): number => readSeq(key, key.length - SEQ_BYTES);

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


/** `[Shard][name]` — one of the shard's own records. */
export const shardMetaKey = (name: string): Uint8Array => {
  const out: number[] = [Space.Shard];
  writeString(out, name);
  return Uint8Array.from(out);
};

/** Where every partition's range begins. */
export const partitionSpace = (): Uint8Array => Uint8Array.of(Space.Partition);

/** The range one partition owns: `[Partition][name]`. */
export const partitionPrefix = (partition: string): Uint8Array => {
  const out: number[] = [Space.Partition];
  writeString(out, partition);
  return Uint8Array.from(out);
};

/** The partition a key in the partition space belongs to. */
export const partitionOf = (key: Uint8Array): string => readString(key, 1).value;

/** Every key one partition writes, built under its prefix. */
export interface PartitionKeys {
  readonly partition: string;
  /** `[Partition][name]`: the whole range, for copying or removing it. */
  readonly prefix: Uint8Array;
  /** Every key under one tag. */
  readonly tag: (tag: Tag) => Uint8Array;

  /** `[Record][seq]` — the record: one read is the whole of it. */
  readonly record: (seq: number) => Uint8Array;
  /** `[Retired][position][seq]` — a retired record, by the position that retired it. */
  readonly retired: (position: number, seq: number) => Uint8Array;
  /** The first retired key past `position`: a scan up to it covers everything retired at or before. */
  readonly retiredAfter: (position: number) => Uint8Array;

  /** `[Identity][namespace][key]` → seq. The caller's own name for a record. */
  readonly identity: (namespace: string, key: string) => Uint8Array;
  /** Every identity in one namespace, in caller-key byte order. */
  readonly identityPrefix: (namespace: string) => Uint8Array;
  /** Every identity whose caller key starts with `prefix`. */
  readonly identityNamePrefix: (namespace: string, prefix: string) => Uint8Array;
  readonly decodeIdentity: (key: Uint8Array) => { namespace: string; key: string };

  readonly meta: (name: string) => Uint8Array;

  /** `[Event][position]` — events are read in position order, so the position is the key. */
  readonly event: (position: number) => Uint8Array;
  readonly positionOf: (key: Uint8Array) => number;

  /** `[Snapshot][id][seq]` — one live record as of the position snapshot `id` covers. */
  readonly snapshot: (id: number, seq: number) => Uint8Array;
  readonly snapshotPrefix: (id: number) => Uint8Array;

  /** `[Term][field][term][seq]` — a prefix scan of field and term is the posting list. */
  readonly term: (field: string, term: string, seq: number) => Uint8Array;
  readonly termPrefix: (field: string, term: string) => Uint8Array;
  /** `[Term][field][escaped prefix]` — covers every term starting with `prefix`. */
  readonly termPrefixKey: (field: string, prefix: string) => Uint8Array;
  /** Field and term of a term posting key or of the segment key standing for one. */
  readonly readTermKey: (key: Uint8Array) => { field: string; term: string } | undefined;

  /** `[Ordered][column][value][seq]` — one posting per value, in value order. */
  readonly ordered: (column: string, value: OrderedValue, seq: number) => Uint8Array;
  readonly orderedColumnPrefix: (column: string) => Uint8Array;
  readonly orderedValuePrefix: (column: string, value: OrderedValue) => Uint8Array;
  readonly orderedKindRange: (column: string, value: OrderedValue) => {
    readonly start: Uint8Array;
    readonly end: Uint8Array;
  };
  readonly decodeOrdered: (key: Uint8Array) => {
    readonly column: string;
    readonly value: OrderedValue;
    readonly seq: number;
  };

  readonly measure: (column: string, seq: number) => Uint8Array;
  readonly measurePrefix: (column: string) => Uint8Array;

  readonly edge: (edgeType: string, src: number, dst: number) => Uint8Array;
  readonly edgePrefix: (edgeType: string, src: number) => Uint8Array;
  readonly reverseEdge: (edgeType: string, dst: number, src: number) => Uint8Array;
  readonly reverseEdgePrefix: (edgeType: string, dst: number) => Uint8Array;

  /** `[Segment][live prefix][index]` — one blob per 65536 identifiers. */
  readonly segment: (livePrefix: Uint8Array, index: number) => Uint8Array;
  readonly segmentPrefix: (livePrefix: Uint8Array) => Uint8Array;
  readonly segmentIndexOf: (key: Uint8Array) => number;
  /** The live prefix a segment key stands for. */
  readonly liveOfSegment: (key: Uint8Array) => Uint8Array;

  /** A posting removed from a lens that a sealed blob still claims. */
  readonly tombstone: (postingKey: Uint8Array) => Uint8Array;
  readonly tombstonePrefix: (livePrefix: Uint8Array) => Uint8Array;
  /** The posting key a tombstone shadows. */
  readonly liveOfTombstone: (key: Uint8Array) => Uint8Array;

  /** `[Dirty][live prefix][segment]` — a seal group written since the last seal. */
  readonly dirty: (livePrefix: Uint8Array, segment: number) => Uint8Array;
  /** The live prefix and segment a dirty mark names. */
  readonly liveOfDirty: (key: Uint8Array) => { readonly livePrefix: Uint8Array; readonly segment: number };
}

/**
 * The keys of one partition.
 *
 * Built once per partition handle: the prefix is computed here and every key
 * starts with it. Sealed and retracted postings are built by inserting their
 * tier's tag between the prefix and the live key's own tag, rather than by
 * re-encoding its fields, so terms, columns and edges stay as disjoint under
 * `Segment` as they are under their own tags, and a lens added later gets both
 * tiers without a key function of its own.
 */
export const partitionKeys = (partition: string): PartitionKeys => {
  const prefix = partitionPrefix(partition);
  const head = Array.from(prefix);
  const at = prefix.length;

  const build = (tag: Tag, write: (out: number[]) => void): Uint8Array => {
    const out: number[] = [...head, tag];
    write(out);
    return Uint8Array.from(out);
  };

  /** A live key moved into another tier: the tier's tag goes in after the prefix. */
  const shadow = (tag: Tag, live: Uint8Array): Uint8Array => {
    const out = new Uint8Array(live.length + 1);
    out.set(prefix);
    out[at] = tag;
    out.set(live.subarray(at), at + 1);
    return out;
  };

  /** The live key a shadow stands for, `trailing` bytes of tier bookkeeping removed. */
  const unshadow = (key: Uint8Array, trailing: number): Uint8Array => {
    const out = new Uint8Array(key.length - 1 - trailing);
    out.set(prefix);
    out.set(key.subarray(at + 1, key.length - trailing), at);
    return out;
  };

  const withU32 = (key: Uint8Array, value: number): Uint8Array => {
    const tail: number[] = [];
    writeU32(tail, value);
    const out = new Uint8Array(key.length + 4);
    out.set(key);
    out.set(tail, key.length);
    return out;
  };

  const ordered = (column: string, value: OrderedValue, seq: number) =>
    build(Tag.Ordered, (out) => {
      writeString(out, column);
      writeOrderedValue(out, value);
      writeSeq(out, seq);
    });

  return {
    partition,
    prefix,
    tag: (tag) => Uint8Array.from([...head, tag]),

    record: (seq) => build(Tag.Record, (out) => writeSeq(out, seq)),
    retired: (position, seq) => build(Tag.Retired, (out) => {
      writeU64(out, position);
      writeSeq(out, seq);
    }),
    retiredAfter: (position) => build(Tag.Retired, (out) => writeU64(out, position + 1)),

    identity: (namespace, key) => build(Tag.Identity, (out) => {
      writeString(out, namespace);
      writeString(out, key);
    }),
    identityPrefix: (namespace) => build(Tag.Identity, (out) => writeString(out, namespace)),
    identityNamePrefix: (namespace, name) => build(Tag.Identity, (out) => {
      writeString(out, namespace);
      writeEscapedPrefix(out, encoder.encode(name));
    }),
    decodeIdentity: (key) => {
      const namespace = readString(key, at + 1);
      const name = readString(key, namespace.next);
      return { namespace: namespace.value, key: name.value };
    },

    meta: (name) => build(Tag.Meta, (out) => writeString(out, name)),

    event: (position) => build(Tag.Event, (out) => writeU64(out, position)),
    positionOf: (key) => readU64(key, at + 1),

    snapshot: (id, seq) => build(Tag.Snapshot, (out) => {
      writeU64(out, id);
      writeSeq(out, seq);
    }),
    snapshotPrefix: (id) => build(Tag.Snapshot, (out) => writeU64(out, id)),

    term: (field, term, seq) => build(Tag.Term, (out) => {
      writeString(out, field);
      writeString(out, term);
      writeSeq(out, seq);
    }),
    termPrefix: (field, term) => build(Tag.Term, (out) => {
      writeString(out, field);
      writeString(out, term);
    }),
    termPrefixKey: (field, termPrefix) => build(Tag.Term, (out) => {
      writeString(out, field);
      writeEscapedPrefix(out, encoder.encode(termPrefix));
    }),
    readTermKey: (key) => {
      if (key.length < at + 2) return undefined;
      const tag = key[at];
      const from = tag === Tag.Term ? at + 1 : tag === Tag.Segment && key[at + 1] === Tag.Term ? at + 2 : -1;
      if (from < 0) return undefined;
      const field = readString(key, from);
      const term = readString(key, field.next);
      return { field: field.value, term: term.value };
    },

    ordered,
    orderedColumnPrefix: (column) => build(Tag.Ordered, (out) => writeString(out, column)),
    orderedValuePrefix: (column, value) => build(Tag.Ordered, (out) => {
      writeString(out, column);
      writeOrderedValue(out, value);
    }),
    orderedKindRange: (column, value) => {
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
    },
    decodeOrdered: (key) => {
      const column = readString(key, at + 1);
      const { value } = readOrderedValue(key, column.next);
      return { column: column.value, value, seq: seqOf(key) };
    },

    measure: (column, seq) => build(Tag.Measure, (out) => {
      writeString(out, column);
      writeSeq(out, seq);
    }),
    measurePrefix: (column) => build(Tag.Measure, (out) => writeString(out, column)),

    edge: (edgeType, src, dst) => build(Tag.Edge, (out) => {
      writeString(out, edgeType);
      writeSeq(out, src);
      writeSeq(out, dst);
    }),
    edgePrefix: (edgeType, src) => build(Tag.Edge, (out) => {
      writeString(out, edgeType);
      writeSeq(out, src);
    }),
    reverseEdge: (edgeType, dst, src) => build(Tag.EdgeReverse, (out) => {
      writeString(out, edgeType);
      writeSeq(out, dst);
      writeSeq(out, src);
    }),
    reverseEdgePrefix: (edgeType, dst) => build(Tag.EdgeReverse, (out) => {
      writeString(out, edgeType);
      writeSeq(out, dst);
    }),

    segment: (livePrefix, index) => withU32(shadow(Tag.Segment, livePrefix), index),
    segmentPrefix: (livePrefix) => shadow(Tag.Segment, livePrefix),
    segmentIndexOf: (key) => readU32(key, key.length - 4),
    liveOfSegment: (key) => unshadow(key, 4),

    tombstone: (postingKey) => shadow(Tag.Tombstone, postingKey),
    tombstonePrefix: (livePrefix) => shadow(Tag.Tombstone, livePrefix),
    liveOfTombstone: (key) => unshadow(key, 0),

    dirty: (livePrefix, segment) => withU32(shadow(Tag.Dirty, livePrefix), segment),
    liveOfDirty: (key) => ({ livePrefix: unshadow(key, 4), segment: readU32(key, key.length - 4) }),
  };
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
