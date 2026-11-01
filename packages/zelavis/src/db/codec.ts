/**
 * The binary shapes a partition stores: records, events and the manifests
 * inside both.
 *
 * Binary rather than JSON because a stored record carries bytes — the document
 * as written — and JSON can only carry those as base64, a third larger and
 * parsed twice. Every length is written before what it measures and every read
 * is checked against the end of the value, so a truncated or foreign value is
 * refused rather than read past.
 *
 * Deterministic: the same event always encodes to the same bytes. A follower
 * compares an event it is handed against the one it already holds at that
 * position by comparing encodings, which only works if there is one.
 */
import { asSeq, type IndexManifest, type ObjectIdentity, type OrderedScalar, type Seq } from "./model.js";
import type { RecordState } from "./store.js";
import { MAX_SEQ } from "./keys.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Refused input: a value that is not one this layout wrote. */
export class MalformedRecord extends Error {
  constructor(what: string) {
    super(`Malformed stored ${what}.`);
    this.name = "MalformedRecord";
  }
}

class Writer {
  private buffer = new Uint8Array(64);
  private length = 0;

  private reserve(bytes: number): void {
    if (this.length + bytes <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.length + bytes) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }

  u8(value: number): void {
    this.reserve(1);
    this.buffer[this.length++] = value;
  }

  u32(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new RangeError(`${value} does not fit in four bytes.`);
    }
    this.reserve(4);
    new DataView(this.buffer.buffer).setUint32(this.length, value);
    this.length += 4;
  }

  /** An identifier, in six bytes. */
  seq(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > MAX_SEQ) {
      throw new RangeError(`${value} is not an identifier.`);
    }
    this.reserve(6);
    const view = new DataView(this.buffer.buffer);
    view.setUint16(this.length, Math.floor(value / 2 ** 32));
    view.setUint32(this.length + 2, value >>> 0);
    this.length += 6;
  }

  /** A position or a generation, in eight bytes. */
  u64(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${value} is not a safe non-negative integer.`);
    }
    this.reserve(8);
    const view = new DataView(this.buffer.buffer);
    view.setUint32(this.length, Math.floor(value / 2 ** 32));
    view.setUint32(this.length + 4, value >>> 0);
    this.length += 8;
  }

  f64(value: number): void {
    this.reserve(8);
    new DataView(this.buffer.buffer).setFloat64(this.length, value);
    this.length += 8;
  }

  /** A count or a length: seven bits a byte, so the small ones every value has take one. */
  varint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${value} is not a length.`);
    }
    let rest = value;
    while (rest >= 0x80) {
      this.u8((rest % 0x80) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    this.u8(rest);
  }

  raw(bytes: Uint8Array): void {
    this.reserve(bytes.length);
    this.buffer.set(bytes, this.length);
    this.length += bytes.length;
  }

  string(value: string): void {
    const bytes = encoder.encode(value);
    this.varint(bytes.length);
    this.raw(bytes);
  }

  finish(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

class Reader {
  private at = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array, private readonly what: string) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private need(count: number): number {
    if (this.at + count > this.bytes.length) throw new MalformedRecord(this.what);
    const at = this.at;
    this.at += count;
    return at;
  }

  u8(): number {
    return this.bytes[this.need(1)]!;
  }

  u32(): number {
    return this.view.getUint32(this.need(4));
  }

  seq(): number {
    const at = this.need(6);
    return this.view.getUint16(at) * 2 ** 32 + this.view.getUint32(at + 2);
  }

  u64(): number {
    const at = this.need(8);
    const value = this.view.getUint32(at) * 2 ** 32 + this.view.getUint32(at + 4);
    if (!Number.isSafeInteger(value)) throw new MalformedRecord(this.what);
    return value;
  }

  f64(): number {
    return this.view.getFloat64(this.need(8));
  }

  varint(): number {
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = this.u8();
      value += (byte & 0x7f) * scale;
      if (!Number.isSafeInteger(value)) throw new MalformedRecord(this.what);
      if ((byte & 0x80) === 0) return value;
      scale *= 0x80;
    }
  }

  string(): string {
    const length = this.varint();
    const at = this.need(length);
    return decoder.decode(this.bytes.subarray(at, at + length));
  }

  /** Everything left: a body is always last, so it needs no length of its own. */
  rest(): Uint8Array {
    const at = this.at;
    this.at = this.bytes.length;
    return this.bytes.subarray(at);
  }

  end(): void {
    if (this.at !== this.bytes.length) throw new MalformedRecord(this.what);
  }
}

const Scalar = { Null: 0, False: 1, True: 2, Number: 3, String: 4 } as const;

const writeScalar = (out: Writer, value: OrderedScalar): void => {
  if (value === null) out.u8(Scalar.Null);
  else if (value === false) out.u8(Scalar.False);
  else if (value === true) out.u8(Scalar.True);
  else if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError(`A column value must be finite, not ${value}.`);
    out.u8(Scalar.Number);
    out.f64(value);
  } else {
    out.u8(Scalar.String);
    out.string(value);
  }
};

const readScalar = (input: Reader, what: string): OrderedScalar => {
  switch (input.u8()) {
    case Scalar.Null: return null;
    case Scalar.False: return false;
    case Scalar.True: return true;
    case Scalar.Number: {
      const value = input.f64();
      if (!Number.isFinite(value)) throw new MalformedRecord(what);
      return value;
    }
    case Scalar.String: return input.string();
    default: throw new MalformedRecord(what);
  }
};

const writeManifest = (out: Writer, manifest: IndexManifest): void => {
  out.varint(manifest.terms.length);
  for (const [field, term] of manifest.terms) {
    out.string(field);
    out.string(term);
  }
  out.varint(manifest.columns.length);
  for (const [column, value] of manifest.columns) {
    out.string(column);
    writeScalar(out, value);
  }
  out.varint(manifest.measures.length);
  for (const [column, value] of manifest.measures) {
    if (!Number.isFinite(value)) throw new RangeError(`A measure must be finite, not ${value}.`);
    out.string(column);
    out.f64(value);
  }
  out.varint(manifest.edges.length);
  for (const [edgeType, to] of manifest.edges) {
    out.string(edgeType);
    out.seq(to);
  }
};

const readManifest = (input: Reader, what: string): IndexManifest => {
  const terms: Array<readonly [string, string]> = [];
  for (let n = input.varint(); n > 0; n--) terms.push([input.string(), input.string()]);
  const columns: Array<readonly [string, OrderedScalar]> = [];
  for (let n = input.varint(); n > 0; n--) columns.push([input.string(), readScalar(input, what)]);
  const measures: Array<readonly [string, number]> = [];
  for (let n = input.varint(); n > 0; n--) {
    const column = input.string();
    const value = input.f64();
    if (!Number.isFinite(value)) throw new MalformedRecord(what);
    measures.push([column, value]);
  }
  const edges: Array<readonly [string, Seq]> = [];
  for (let n = input.varint(); n > 0; n--) edges.push([input.string(), asSeq(input.seq())]);
  return { terms, columns, measures, edges };
};

/** A manifest alone, as a snapshot of what a record contributed. */
export const encodeManifest = (manifest: IndexManifest): Uint8Array => {
  const out = new Writer();
  writeManifest(out, manifest);
  return out.finish();
};

/** A record as stored: see `RecordState`. */
export type StoredRecord = RecordState;

const RecordFlag = { Retired: 0x01, Identity: 0x02 } as const;

export const encodeRecord = (record: StoredRecord): Uint8Array => {
  const out = new Writer();
  if (!record.live) {
    out.u8(RecordFlag.Retired);
    out.u32(record.version);
    out.u64(record.retiredAt);
    return out.finish();
  }
  out.u8(record.identity === undefined ? 0 : RecordFlag.Identity);
  out.u32(record.version);
  if (record.identity !== undefined) {
    out.string(record.identity.namespace);
    out.string(record.identity.key);
  }
  writeManifest(out, record.manifest);
  out.raw(record.body);
  return out.finish();
};

export const decodeRecord = (bytes: Uint8Array): StoredRecord => {
  const input = new Reader(bytes, "record");
  const flags = input.u8();
  if ((flags & ~(RecordFlag.Retired | RecordFlag.Identity)) !== 0) throw new MalformedRecord("record");
  const version = input.u32();
  if ((flags & RecordFlag.Retired) !== 0) {
    const retiredAt = input.u64();
    input.end();
    return { live: false, version, retiredAt };
  }
  const identity = (flags & RecordFlag.Identity) === 0
    ? undefined
    : { namespace: input.string(), key: input.string() };
  const manifest = readManifest(input, "record");
  return {
    live: true,
    version,
    ...(identity === undefined ? {} : { identity }),
    manifest,
    body: input.rest(),
  };
};

/** One entry of a partition's log. */
export type StoredEvent =
  | {
    readonly kind: "put";
    readonly generation: number;
    readonly seq: number;
    readonly version: number;
    readonly at: number;
    /** The node that accepted the write. */
    readonly origin: string;
    readonly identity?: ObjectIdentity;
    readonly manifest: IndexManifest;
    readonly body: Uint8Array;
  }
  | {
    readonly kind: "retract";
    readonly generation: number;
    readonly seq: number;
    readonly version: number;
    readonly at: number;
    readonly origin: string;
    readonly identity?: ObjectIdentity;
  };

const EventKind = { Put: 0x01, Retract: 0x02 } as const;
const EVENT_IDENTITY = 0x10;

export const encodeEvent = (event: StoredEvent): Uint8Array => {
  const out = new Writer();
  out.u8((event.kind === "put" ? EventKind.Put : EventKind.Retract)
    | (event.identity === undefined ? 0 : EVENT_IDENTITY));
  out.u64(event.generation);
  out.seq(event.seq);
  out.u32(event.version);
  out.f64(event.at);
  out.string(event.origin);
  if (event.identity !== undefined) {
    out.string(event.identity.namespace);
    out.string(event.identity.key);
  }
  if (event.kind === "put") {
    writeManifest(out, event.manifest);
    out.raw(event.body);
  }
  return out.finish();
};

export const decodeEvent = (bytes: Uint8Array): StoredEvent => {
  const input = new Reader(bytes, "event");
  const head = input.u8();
  const kind = head & 0x0f;
  if ((head & ~(0x0f | EVENT_IDENTITY)) !== 0 || (kind !== EventKind.Put && kind !== EventKind.Retract)) {
    throw new MalformedRecord("event");
  }
  const generation = input.u64();
  const seq = input.seq();
  const version = input.u32();
  const at = input.f64();
  if (!Number.isFinite(at)) throw new MalformedRecord("event");
  const origin = input.string();
  const identity = (head & EVENT_IDENTITY) === 0
    ? undefined
    : { namespace: input.string(), key: input.string() };
  const common = { generation, seq, version, at, origin, ...(identity === undefined ? {} : { identity }) };
  if (kind === EventKind.Retract) {
    input.end();
    return { kind: "retract", ...common };
  }
  const manifest = readManifest(input, "event");
  return { kind: "put", ...common, manifest, body: input.rest() };
};

/** Where a fenced partition is going: the shard it is leaving and the shard it is moving to. */
export interface StoredFence {
  readonly from: string;
  readonly to: string;
}

export const encodeFence = (fence: StoredFence): Uint8Array => {
  const out = new Writer();
  out.string(fence.from);
  out.string(fence.to);
  return out.finish();
};

export const decodeFence = (bytes: Uint8Array): StoredFence => {
  const input = new Reader(bytes, "fence");
  const from = input.string();
  const to = input.string();
  input.end();
  return { from, to };
};

/**
 * Where a branched partition's log came from: each partition whose log
 * positions it shares, and the last position it shares with that one. Nearest
 * first, so a branch of a branch lists its own source, then that source's.
 */
export type StoredLineage = ReadonlyArray<{ readonly partition: string; readonly upTo: number }>;

/** At most this many ancestors are kept: a branch of a branch of… stops there. */
export const LINEAGE_LIMIT = 16;

export const encodeLineage = (lineage: StoredLineage): Uint8Array => {
  const out = new Writer();
  out.u32(lineage.length);
  for (const entry of lineage) {
    out.string(entry.partition);
    out.u64(entry.upTo);
  }
  return out.finish();
};

export const decodeLineage = (bytes: Uint8Array): StoredLineage => {
  const input = new Reader(bytes, "lineage");
  const count = input.u32();
  if (count > LINEAGE_LIMIT) throw new RangeError(`lineage lists ${count} ancestors, more than ${LINEAGE_LIMIT}`);
  const out: Array<{ partition: string; upTo: number }> = [];
  for (let at = 0; at < count; at++) out.push({ partition: input.string(), upTo: input.u64() });
  input.end();
  return out;
};

/** At most this many identity namespaces an unfinished branch leaves behind. */
export const LEAVE_LIMIT = 16;

/** The identity namespaces an unfinished branch leaves behind: a count, then each name. */
export const encodeNames = (names: ReadonlyArray<string>): Uint8Array => {
  const out = new Writer();
  out.u32(names.length);
  for (const name of names) out.string(name);
  return out.finish();
};

export const decodeNames = (bytes: Uint8Array): ReadonlyArray<string> => {
  const input = new Reader(bytes, "names");
  const count = input.u32();
  if (count > LEAVE_LIMIT) throw new RangeError(`a branch leaves ${count} namespaces behind, more than ${LEAVE_LIMIT}`);
  const out: string[] = [];
  for (let at = 0; at < count; at++) out.push(input.string());
  input.end();
  return out;
};
