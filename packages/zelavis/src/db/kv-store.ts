import { Effect, Semaphore, Stream } from "effect";
import {
  CursorCompacted, CursorMismatch, ForeignCursor, LogCompacted, StoreError, WriterFenced,
} from "./errors.js";
import type { AppliedEvent, DbEvent, EventCursor } from "./events.js";
import {
  edgeKey, edgePrefix, eventKey, eventPrefix,
  identityBySeqKey, identityKey, manifestKey, measureKey, measurePrefix,
  compareKeys, metaKey, payloadKey, positionOf, segmentIndexOf, segmentKey, segmentPrefix,
  seqOf, Tag, termKey, termPrefix, tombstoneKey, tombstonePrefix,
  decodeOrderedKey, dirtyKey, inPrefixRange, orderedColumnPrefix, orderedKey, orderedKindRange,
  orderedValuePrefix, prefixEnd, type OrderedValue,
} from "./keys.js";
import type { KvEngine, KvScanOptions, KvWrite } from "./kv.js";
import {
  asSeq, type IndexManifest, type ObjectIdentity, type PartitionKey, type Seq,
} from "./model.js";
import * as Postings from "./postings.js";
import {
  decodeSegment, encodeSegment, SEGMENT_SPAN, SegmentBuffer, segmentOf,
} from "./segments.js";
import type { Query, RangeBound, RangeQuery } from "./query.js";
import type {
  EventsApi, ObjectStoreApi, OrderedCursor, OrderedPage, OrderedReadInput, OrderedRow, Txn,
} from "./store.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const u32 = (value: number): Uint8Array =>
  Uint8Array.from([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);

const readU32 = (bytes: Uint8Array, at = 0): number =>
  ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;

const f64 = (value: number): Uint8Array => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value);
  return out;
};

const readF64 = (bytes: Uint8Array): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0);

/** `[version][body]` in one value, so reading an object is a single lookup. */
const encodePayload = (version: number, body: Uint8Array): Uint8Array => {
  const out = new Uint8Array(4 + body.length);
  out.set(u32(version), 0);
  out.set(body, 4);
  return out;
};

const json = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));
const unjson = <A>(bytes: Uint8Array): A => JSON.parse(decoder.decode(bytes)) as A;
const EMPTY = new Uint8Array(0);
const emptyManifest = (): IndexManifest => ({ terms: [], columns: [], measures: [], edges: [] });

/** Keys compare as bytes; a batch keyed by them needs a string. */
const keyId = (key: Uint8Array): string => {
  let out = "";
  for (const byte of key) out += String.fromCharCode(byte);
  return out;
};

const META_NEXT_SEQ = "next_seq";
const META_NEXT_POSITION = "next_position";
const META_GENERATION = "generation";
/** The position everything at or below has been compacted away. */
const META_COMPACTED_TO = "compacted_to";
/**
 * Whether any blob exists, which is the write path's only question about them.
 *
 * It is deliberately not a high-water mark over identifiers. That would let a
 * removal above the mark skip its tombstone, and two things make the mark
 * unsound: the allocator's counter only moves for callers that let it assign
 * identifiers, and an edge posting is keyed by the identifier it *points at*,
 * which no mark over allocated identifiers bounds. A tombstone for something
 * no blob claims costs one empty key and is swept at the next seal; a missing
 * one returns a row that is not there, so the cheap side is the safe one.
 */
const META_SEALED = "sealed";

/**
 * Set once a seal has swept every live posting; cleared by a reindex or a
 * rebuild. A seal after a sweep visits only the groups marked dirty since. A
 * seal before one — or after a sweep that was cut short — sweeps again,
 * because a posting written before the store was sealed carries no mark.
 */
const META_SWEPT = "swept";

/** Writes per batch while sealing, which also bounds the memory it holds. */
const SEAL_BATCH = 4096;

/**
 * What a rebuild drops and re-derives.
 *
 * Postings hold nothing a manifest does not already say, so they can be
 * reconstructed from state alone. That is what makes compaction possible: the
 * payloads, manifests and identities are already a snapshot, so the log is
 * history rather than the only way back to a working index.
 */
const DERIVED_TAGS = [
  Tag.Term, Tag.Column, Tag.Measure, Tag.Edge, Tag.Segment, Tag.Tombstone, Tag.Ordered, Tag.Dirty,
] as const;

/**
 * The lenses whose postings can be sealed into blobs.
 *
 * Measures are absent on purpose: a measure key carries a value, so it is a
 * stored number rather than a posting, and folding it into a set would lose
 * exactly the thing it exists to hold.
 */
const SEALABLE_TAGS = [Tag.Term, Tag.Ordered, Tag.Edge] as const;

/**
 * The fewest postings one value needs, within one segment, to be sealed.
 *
 * Sealing trades a key per posting for a key per blob, and pays for itself only
 * when a blob holds many: a unique value — a price, a name, a timestamp — would
 * become one blob per posting, the same number of keys plus a decode on every
 * read, and an ordered read would visit each one separately. So a value below
 * this stays live, and the lens keeps both shapes: blobs for the values many
 * objects share, keys for the ones few do.
 */
const MIN_SEALED_POSTINGS = 64;

/** State a rebuild keeps, and compaction relies on. */
const STATE_TAGS = [Tag.Payload, Tag.Manifest, Tag.Identity, Tag.IdentityBySeq] as const;

/** Everything a full replay from the log clears first. */
const LENS_TAGS = [...STATE_TAGS, ...DERIVED_TAGS] as const;

interface StoredEvent {
  readonly generation: number;
  readonly seq: number;
  readonly kind: "put" | "retract";
  readonly version: number;
  readonly at: number;
  readonly body?: string;
  readonly manifest?: IndexManifest;
  readonly identity?: ObjectIdentity;
}

const SEPARATOR = "|";

const encodeCursor = (partition: PartitionKey, position: number): EventCursor =>
  Buffer.from(partition + SEPARATOR + String(position), "utf8").toString("base64url") as EventCursor;

/**
 * An ordered read's position: the last key it returned, with the partition,
 * column and direction it belongs to, so it cannot continue a different read.
 */
const encodeOrderedCursor = (
  partition: PartitionKey,
  column: string,
  direction: "asc" | "desc",
  key: Uint8Array,
): OrderedCursor =>
  Buffer.from(
    JSON.stringify({ p: partition, c: column, d: direction, k: Buffer.from(key).toString("hex") }),
    "utf8",
  ).toString("base64url") as OrderedCursor;

const decodeOrderedCursor = (
  partition: PartitionKey,
  column: string,
  direction: "asc" | "desc",
  cursor: OrderedCursor,
): Effect.Effect<Uint8Array, ForeignCursor | CursorMismatch> =>
  Effect.gen(function* () {
    const malformed = new CursorMismatch({ reason: "the cursor is not one an ordered read produced" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    } catch {
      return yield* malformed;
    }
    if (typeof parsed !== "object" || parsed === null) return yield* malformed;
    const { p, c, d, k } = parsed as Record<string, unknown>;
    if (typeof p !== "string" || typeof c !== "string" || typeof k !== "string") return yield* malformed;
    if (d !== "asc" && d !== "desc") return yield* malformed;
    if (p !== partition) return yield* new ForeignCursor({ expected: partition, received: p });
    if (c !== column || d !== direction) {
      return yield* new CursorMismatch({
        reason: `the cursor continues a ${d} read of "${c}", not a ${direction} read of "${column}"`,
      });
    }
    const key = new Uint8Array(Buffer.from(k, "hex"));
    if (!inPrefixRange(key, orderedColumnPrefix(column))) return yield* malformed;
    return key;
  });

/** The smallest key above `key`: nothing sorts between a key and itself plus a zero byte. */
const successorOf = (key: Uint8Array): Uint8Array => {
  const out = new Uint8Array(key.length + 1);
  out.set(key);
  return out;
};

const scanOptions = (
  from: Uint8Array | undefined,
  to: Uint8Array | undefined,
  reverse: boolean,
  limit?: number,
): KvScanOptions => ({
  ...(from === undefined ? {} : { from }),
  ...(to === undefined ? {} : { to }),
  reverse,
  ...(limit === undefined ? {} : { limit }),
});

const decodeCursor = (partition: PartitionKey, cursor: EventCursor): number => {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const at = raw.lastIndexOf(SEPARATOR);
  const owner = raw.slice(0, at);
  if (owner !== partition) throw new ForeignCursor({ expected: partition, received: owner });
  return Number(raw.slice(at + 1));
};

/**
 * The store over an ordered key-value engine.
 *
 * Each lens is a key range rather than a table. A posting list is the entries
 * under one prefix, already sorted, and intersection walks them exactly as
 * before. That is the shape the design wanted from the start, and it is what
 * lets an engine with no tables back the same semantics.
 */
export const storeOverKv = (
  partition: PartitionKey,
  engine: KvEngine,
  generation: number,
): ObjectStoreApi => {
  const readMeta = (name: string) =>
    Effect.map(engine.get(metaKey(name)), (bytes) => (bytes === undefined ? 0 : readU32(bytes)));

  /**
   * One writer at a time.
   *
   * Every write below reads store state and writes it back changed: a commit
   * reads the log's next position, `nextSeq` the identifier counter, a seal the
   * blobs it folds into. On an engine whose reads and writes are asynchronous,
   * two of those in flight at once read the same value and the second write
   * replaces the first — a commit that returned and left no trace. LMDB and
   * RocksDB each lost 31 of 32 concurrent commits that way.
   *
   * Reads take no permit: they see committed state, which is all they promise.
   * Nothing holding the permit calls another operation that takes it.
   */
  const exclusive = Semaphore.withPermit(Semaphore.makeUnsafe(1));

  const assertCurrent = Effect.gen(function* () {
    const current = yield* readMeta(META_GENERATION);
    if (current !== generation) {
      return yield* new WriterFenced({ partition, claimed: generation, current });
    }
  });

  /**
   * Reads see the batch being built.
   *
   * A put that follows a retract of the same identifier in one transaction has
   * to observe the retraction, or it re-reads a manifest the batch already
   * removed and deletes postings it just wrote.
   */
  const pendingView = (pending: Map<string, KvWrite>) => ({
    get: (key: Uint8Array) => {
      const staged = pending.get(keyId(key));
      if (staged === undefined) return engine.get(key);
      return Effect.succeed(staged.op === "put" ? staged.value : undefined);
    },
    put: (key: Uint8Array, value: Uint8Array) => {
      pending.set(keyId(key), { op: "put", key, value });
    },
    del: (key: Uint8Array) => {
      pending.set(keyId(key), { op: "delete", key });
    },
  });

  type View = ReturnType<typeof pendingView>;

  /**
   * Drop a posting from both tiers.
   *
   * The live key goes; a blob cannot be edited, so once anything has been
   * sealed the removal leaves a tombstone for the read to subtract instead.
   */
  /**
   * Mark the seal group a posting belongs to as changed since the last seal.
   * One key per group, overwritten rather than added to, however many of its
   * postings change.
   */
  const markDirty = (view: View, key: Uint8Array): void => {
    view.put(dirtyKey(key.subarray(0, key.length - 4), segmentOf(seqOf(key))), EMPTY);
  };

  const dropPosting = (view: View, key: Uint8Array, sealed: boolean): void => {
    view.del(key);
    if (sealed) {
      view.put(tombstoneKey(key), EMPTY);
      markDirty(view, key);
    }
  };

  /** Write a posting, cancelling any tombstone a previous version left. */
  const addPosting = (
    view: View, key: Uint8Array, value: Uint8Array, sealed: boolean,
  ): void => {
    view.put(key, value);
    // An update that keeps a term retracts and re-adds it in one transaction.
    // Without this the tombstone written a moment ago would hide the posting
    // just written — the batch is keyed, so the later call is the one that
    // lands.
    if (sealed) {
      view.del(tombstoneKey(key));
      markDirty(view, key);
    }
  };

  const unproject = (view: View, seq: Seq, sealed: boolean) =>
    Effect.gen(function* () {
      const stored = yield* view.get(manifestKey(seq));
      if (stored === undefined) return;
      const manifest = unjson<IndexManifest>(stored);
      for (const [field, term] of manifest.terms) {
        dropPosting(view, termKey(field, term, seq), sealed);
      }
      for (const [column, value] of manifest.columns) {
        dropPosting(view, orderedKey(column, value, seq), sealed);
      }
      for (const [column] of manifest.measures) view.del(measureKey(column, seq));
      for (const [edgeType, to] of manifest.edges) {
        dropPosting(view, edgeKey(edgeType, seq, to), sealed);
      }
      view.del(manifestKey(seq));

      const identity = yield* view.get(identityBySeqKey(seq));
      if (identity !== undefined) {
        const decoded = unjson<ObjectIdentity>(identity);
        view.del(identityKey(decoded.namespace, decoded.key));
        view.del(identityBySeqKey(seq));
      }
    });

  const project = (
    view: View,
    seq: Seq,
    version: number,
    body: Uint8Array,
    manifest: IndexManifest,
    sealed: boolean,
    identity?: ObjectIdentity,
  ) =>
    Effect.gen(function* () {
      yield* unproject(view, seq, sealed);
      view.put(payloadKey(seq), encodePayload(version, body));
      // A posting is a key with no value: the key itself is the fact.
      for (const [field, term] of manifest.terms) {
        addPosting(view, termKey(field, term, seq), EMPTY, sealed);
      }
      for (const [column, value] of manifest.columns) {
        addPosting(view, orderedKey(column, value, seq), EMPTY, sealed);
      }
      for (const [column, value] of manifest.measures) view.put(measureKey(column, seq), f64(value));
      for (const [edgeType, to] of manifest.edges) {
        addPosting(view, edgeKey(edgeType, seq, to), EMPTY, sealed);
      }
      view.put(manifestKey(seq), json(manifest));
      if (identity !== undefined) {
        view.put(identityKey(identity.namespace, identity.key), u32(seq));
        view.put(identityBySeqKey(seq), json(identity));
      }
    });

  const versionOf = (view: View, seq: Seq) =>
    Effect.map(view.get(payloadKey(seq)), (bytes) => (bytes === undefined ? 0 : readU32(bytes)));

  const bodyOf = (stored: StoredEvent): Uint8Array =>
    stored.body === undefined ? EMPTY : new Uint8Array(Buffer.from(stored.body, "base64"));

  const commit = <A, E, R>(
    f: (view: View, txn: Txn, append: (event: StoredEvent) => void) => Effect.Effect<A, E, R>,
  ) =>
    exclusive(Effect.gen(function* () {
      const pending = new Map<string, KvWrite>();
      const view = pendingView(pending);
      let position = yield* readMeta(META_NEXT_POSITION);
      const sealed = (yield* readMeta(META_SEALED)) > 0;

      const append = (event: StoredEvent): void => {
        position += 1;
        view.put(eventKey(position), json(event));
      };

      const txn: Txn = {
        put: (seq, bytes, manifest, identity) =>
          Effect.gen(function* () {
            yield* assertCurrent;
            const version = (yield* versionOf(view, seq)) + 1;
            append({
              generation, seq, kind: "put", version, at: Date.now(),
              body: Buffer.from(bytes).toString("base64"), manifest,
              ...(identity === undefined ? {} : { identity }),
            });
            yield* project(view, seq, version, bytes, manifest, sealed, identity);
          }),

        retract: (seq) =>
          Effect.gen(function* () {
            yield* assertCurrent;
            const version = yield* versionOf(view, seq);
            if (version === 0) return;
            append({
              generation, seq, kind: "retract", version: version + 1, at: Date.now(),
            });
            yield* unproject(view, seq, sealed);
            view.del(payloadKey(seq));
          }),
      };

      const result = yield* f(view, txn, append);
      view.put(metaKey(META_NEXT_POSITION), u32(position));
      // One batch: the whole transaction lands, or none of it does.
      yield* engine.write([...pending.values()]);
      return result;
    }));

  /**
   * A posting list, read from both tiers.
   *
   * Sealed blobs carry everything up to the last seal, the live keys carry
   * everything written since, and tombstones carry what was removed from a
   * blob that cannot be edited. The union minus the tombstones is the answer.
   *
   * Both scans are ascending in identifier order — segments are keyed by index
   * and live postings by their trailing identifier — so each side folds
   * straight into a builder and a wide list never becomes a JavaScript array.
   */
  const postingsUnder = (prefix: Uint8Array) =>
    Effect.gen(function* () {
      const sealed = new Postings.PostingsBuilder();
      yield* Stream.runForEach(engine.scan(segmentPrefix(prefix)), (entry) =>
        Effect.sync(() => {
          const base = segmentIndexOf(entry.key) * SEGMENT_SPAN;
          decodeSegment(entry.value, base, (id) => sealed.add(id));
        }));

      const live = new Postings.PostingsBuilder();
      yield* Stream.runForEach(engine.scan(prefix), (entry) =>
        Effect.sync(() => live.add(seqOf(entry.key))));

      const present = Postings.or(sealed.build(), live.build());

      // Tombstones exist only where something sealed was later removed, so the
      // common case is an empty range scan rather than a set operation.
      const removed = new Postings.PostingsBuilder();
      yield* Stream.runForEach(engine.scan(tombstonePrefix(prefix)), (entry) =>
        Effect.sync(() => removed.add(seqOf(entry.key))));

      return Postings.andNot(present, removed.build());
    });

  /**
   * The key range a pair of bounds covers in one column of the ordered lens.
   *
   * An inclusive lower bound starts at the value's first key and an exclusive
   * one just past its last; an upper bound mirrors that. With one bound the
   * other side stops at the edge of that bound's kind, so a range compares
   * like with like; with neither, it is the whole column.
   */
  const rangeBounds = (column: string, lower?: RangeBound, upper?: RangeBound) => ({
    prefix: orderedColumnPrefix(column),
    from:
      lower !== undefined
        ? lower.inclusive
          ? orderedValuePrefix(column, lower.value)
          : prefixEnd(orderedValuePrefix(column, lower.value))
        : upper !== undefined
          ? orderedKindRange(column, upper.value).start
          : undefined,
    to:
      upper !== undefined
        ? upper.inclusive
          ? prefixEnd(orderedValuePrefix(column, upper.value))
          : orderedValuePrefix(column, upper.value)
        : lower !== undefined
          ? orderedKindRange(column, lower.value).end
          : undefined,
  });

  /** A key as a set member: tombstones are matched by content, not identity. */
  const hexOf = (bytes: Uint8Array) =>
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex");

  /**
   * The tombstoned postings of one column within a key range.
   *
   * A tombstone exists only where a sealed posting was removed since the last
   * seal, so this is usually an empty scan, and it is bounded by the removals
   * since then rather than by the column.
   */
  const tombstonesIn = (prefix: Uint8Array, from: Uint8Array | undefined, to: Uint8Array | undefined) =>
    Effect.gen(function* () {
      const removed = new Set<string>();
      yield* Stream.runForEach(
        engine.scan(
          tombstonePrefix(prefix),
          scanOptions(from && tombstonePrefix(from), to && tombstonePrefix(to), false),
        ),
        (entry) =>
          Effect.sync(() => {
            removed.add(hexOf(entry.key.subarray(1)));
          }),
      );
      return removed;
    });

  /**
   * The live keys a sealed blob stands for, ascending, within `[from, to)`.
   *
   * A segment key is its live prefix — for the ordered lens, one value of one
   * column — behind the segment tag, with the segment index after it. Putting
   * each identifier back behind that prefix gives the keys the blob replaced,
   * in the order the live tier would have held them.
   */
  const expandBlob = (
    blob: { readonly key: Uint8Array; readonly value: Uint8Array },
    from: Uint8Array | undefined,
    to: Uint8Array | undefined,
  ): Array<Uint8Array> => {
    const livePrefix = blob.key.subarray(1, blob.key.length - 4);
    const keys: Array<Uint8Array> = [];
    decodeSegment(blob.value, segmentIndexOf(blob.key) * SEGMENT_SPAN, (id) => {
      const key = new Uint8Array(livePrefix.length + 4);
      key.set(livePrefix);
      key.set(u32(id), livePrefix.length);
      if (from !== undefined && compareKeys(key, from) < 0) return;
      if (to !== undefined && compareKeys(key, to) >= 0) return;
      keys.push(key);
    });
    return keys;
  };

  /**
   * A range as a set of identifiers, so it intersects with every other lens.
   *
   * Both tiers count: the live postings in range, and the blobs of every value
   * in range less what the tombstones removed. Range bounds fall on value
   * boundaries and a blob holds one value, so a blob is wholly inside the range
   * or wholly outside it. Identifiers come out in value order and a postings set
   * is kept in identifier order, so they are sorted — and de-duplicated, because
   * a posting written again after a seal is in both tiers, and a manifest may
   * give one object several values in a column.
   */
  const rangePostings = (query: RangeQuery): Effect.Effect<Postings.Postings, StoreError> =>
    Effect.gen(function* () {
      const { prefix, from, to } = rangeBounds(query.column, query.lower, query.upper);
      const removed = yield* tombstonesIn(prefix, from, to);
      const found: Array<number> = [];
      yield* Stream.runForEach(engine.scan(prefix, scanOptions(from, to, false)), (entry) =>
        Effect.sync(() => {
          found.push(seqOf(entry.key));
        }));
      yield* Stream.runForEach(
        engine.scan(segmentPrefix(prefix), scanOptions(from && segmentPrefix(from), to && segmentPrefix(to), false)),
        (entry) =>
          Effect.sync(() => {
            if (removed.size === 0) {
              decodeSegment(entry.value, segmentIndexOf(entry.key) * SEGMENT_SPAN, (id) => found.push(id));
              return;
            }
            for (const key of expandBlob(entry, undefined, undefined)) {
              if (!removed.has(hexOf(key))) found.push(seqOf(key));
            }
          }),
      );
      const sorted = Uint32Array.from(found).sort();
      const builder = new Postings.PostingsBuilder();
      let previous = -1;
      for (const seq of sorted) {
        if (seq !== previous) builder.add(seq);
        previous = seq;
      }
      return builder.build();
    });

  /** Live keys pulled per step of an ordered read. */
  const LIVE_CHUNK = 256;

  /** Blobs fetched per step of an ordered read, expanded only as far as a step needs. */
  const BLOB_CHUNK = 16;

  /**
   * One column's ordered postings from both tiers, as a single run in scan order.
   *
   * The live tier holds keys; the sealed tier holds blobs, each one value's
   * postings over a span of identifiers, keyed in the same order as the keys it
   * replaced. Expanding a blob back into those keys puts both tiers in one
   * order, so a two-way merge reads them as a single run: a key in both tiers —
   * written again after a seal — appears once, and a tombstoned one, removed
   * from a blob that cannot be edited, not at all. Each tier is pulled a bounded
   * step at a time, one blob or `LIVE_CHUNK` keys, so a page reads about what it
   * returns rather than the column.
   *
   * `from` and `to` bound the live keys exactly. `sealedFrom` and `sealedTo`
   * bound the blobs and may be wider: a blob straddling a bound is expanded and
   * trimmed to it.
   */
  const mergeOrdered = (input: {
    readonly column: string;
    readonly from: Uint8Array | undefined;
    readonly to: Uint8Array | undefined;
    readonly sealedFrom: Uint8Array | undefined;
    readonly sealedTo: Uint8Array | undefined;
    readonly reverse: boolean;
    readonly filter: Postings.Postings | undefined;
    readonly limit: number;
  }): Effect.Effect<
    Array<{ readonly key: Uint8Array; readonly seq: number; readonly value: OrderedValue }>,
    StoreError
  > =>
    Effect.gen(function* () {
      const prefix = orderedColumnPrefix(input.column);
      const { reverse } = input;
      const removed = yield* tombstonesIn(prefix, input.from, input.to);

      let liveFrom = input.from;
      let liveTo = input.to;
      let liveDone = false;
      // The first pull is sized to the page, which most reads end inside: a
      // small page — a scatter asks every tenant for a few rows — would
      // otherwise read a full chunk of keys to return a handful.
      let liveChunk = Math.min(LIVE_CHUNK, input.limit);
      const pullLive = Effect.gen(function* () {
        if (liveDone) return [] as Array<Uint8Array>;
        const size = liveChunk;
        liveChunk = LIVE_CHUNK;
        const chunk = [
          ...(yield* Stream.runCollect(engine.scan(prefix, scanOptions(liveFrom, liveTo, reverse, size)))),
        ].map((entry) => new Uint8Array(entry.key));
        if (chunk.length < size) liveDone = true;
        const last = chunk.at(-1);
        if (last !== undefined) {
          if (reverse) liveTo = last;
          else liveFrom = successorOf(last);
        }
        return chunk;
      });

      let blobFrom = input.sealedFrom;
      let blobTo = input.sealedTo;
      let sealedDone = false;
      const pullSealed = Effect.gen(function* () {
        while (!sealedDone) {
          const blobs = [
            ...(yield* Stream.runCollect(
              engine.scan(segmentPrefix(prefix), scanOptions(blobFrom, blobTo, reverse, BLOB_CHUNK)),
            )),
          ];
          const keys: Array<Uint8Array> = [];
          let used = 0;
          for (const blob of blobs) {
            used += 1;
            if (reverse) blobTo = new Uint8Array(blob.key);
            else blobFrom = successorOf(blob.key);
            const expanded = expandBlob(blob, input.from, input.to);
            if (reverse) expanded.reverse();
            for (const key of expanded) keys.push(key);
            // Enough for a step: the rest of this batch is fetched again next time.
            if (keys.length >= LIVE_CHUNK) break;
          }
          if (used === blobs.length && blobs.length < BLOB_CHUNK) sealedDone = true;
          if (keys.length > 0) return keys;
        }
        return [] as Array<Uint8Array>;
      });

      const first = (a: Uint8Array, b: Uint8Array) =>
        reverse ? compareKeys(a, b) > 0 : compareKeys(a, b) < 0;
      let live: Array<Uint8Array> = [];
      let sealed: Array<Uint8Array> = [];
      let li = 0;
      let si = 0;
      let liveEmpty = false;
      let sealedEmpty = false;
      const out: Array<{ readonly key: Uint8Array; readonly seq: number; readonly value: OrderedValue }> = [];
      while (out.length < input.limit) {
        if (li >= live.length && !liveEmpty) {
          live = yield* pullLive;
          li = 0;
          if (live.length === 0) liveEmpty = true;
        }
        if (si >= sealed.length && !sealedEmpty) {
          sealed = yield* pullSealed;
          si = 0;
          if (sealed.length === 0) sealedEmpty = true;
        }
        const x = live[li];
        const y = sealed[si];
        let key: Uint8Array;
        if (x === undefined && y === undefined) break;
        if (y === undefined || (x !== undefined && first(x, y))) {
          key = x!;
          li += 1;
        } else if (x === undefined || first(y, x)) {
          key = y;
          si += 1;
        } else {
          key = x;
          li += 1;
          si += 1;
        }
        if (removed.size > 0 && removed.has(hexOf(key))) continue;
        const { seq, value } = decodeOrderedKey(key);
        if (input.filter !== undefined && !Postings.has(input.filter, seq)) continue;
        out.push({ key, seq, value });
      }
      return out;
    });

  const evaluate = (query: Query): Effect.Effect<Postings.Postings, StoreError> => {
    switch (query._tag) {
      case "Range": return rangePostings(query);
      case "Term": return postingsUnder(termPrefix(query.field, query.term));
      case "Equals": return postingsUnder(orderedValuePrefix(query.column, query.value));
      case "Edge": return postingsUnder(edgePrefix(query.edgeType, query.from));
      case "And": return Effect.map(Effect.forEach(query.of, evaluate), Postings.andAll);
      case "Or": return Effect.map(Effect.forEach(query.of, evaluate), Postings.orAll);
    }
  };

  /**
   * One page of an ordered read.
   *
   * The merged run is read in the requested direction and stops one row past
   * the page; that row is how the page knows another follows, and it is not
   * returned. A cursor records the last key returned, so the next page starts
   * strictly past it — exact even when many objects share a value, because the
   * identifier is part of the key. The blobs of the cursor's own value are read
   * again and trimmed, since the rest of that value may sit in the same blob.
   */
  const readOrdered = (
    input: OrderedReadInput,
  ): Effect.Effect<OrderedPage, StoreError | ForeignCursor | CursorMismatch> =>
    Effect.gen(function* () {
      const direction = input.direction ?? "asc";
      const limit = input.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1) {
        return yield* Effect.die(
          new RangeError(`An ordered read's limit must be a positive integer, not ${limit}.`),
        );
      }
      const bounds = rangeBounds(input.column, input.lower, input.upper);
      let { from, to } = bounds;
      let sealedFrom = from && segmentPrefix(from);
      let sealedTo = to && segmentPrefix(to);
      if (input.after !== undefined) {
        const last = yield* decodeOrderedCursor(partition, input.column, direction, input.after);
        const valueBlobs = segmentPrefix(last.subarray(0, last.length - 4));
        if (direction === "asc") {
          const next = successorOf(last);
          if (from === undefined || compareKeys(next, from) > 0) {
            from = next;
            sealedFrom = valueBlobs;
          }
        } else if (to === undefined || compareKeys(last, to) < 0) {
          to = last;
          sealedTo = prefixEnd(valueBlobs);
        }
      }
      const filter = input.where === undefined ? undefined : yield* evaluate(input.where);
      const rows = yield* mergeOrdered({
        column: input.column, from, to, sealedFrom, sealedTo,
        reverse: direction === "desc", filter, limit: limit + 1,
      });
      const more = rows.length > limit;
      const page = more ? rows.slice(0, limit) : rows;
      const out = page.map((row): OrderedRow => ({
        seq: asSeq(row.seq),
        value: row.value,
        cursor: encodeOrderedCursor(partition, input.column, direction, row.key),
      }));
      return { rows: out, ...(more ? { next: out.at(-1)!.cursor } : {}) };
    });

  const toEvent = (position: number, stored: StoredEvent): DbEvent => {
    const common = {
      cursor: encodeCursor(partition, position),
      partition,
      generation: stored.generation,
      at: stored.at,
      seq: asSeq(stored.seq),
      version: stored.version,
    };
    return stored.kind === "put"
      ? {
          _tag: "ObjectPut", ...common,
          bytes: bodyOf(stored),
          manifest: stored.manifest ?? emptyManifest(),
          ...(stored.identity === undefined ? {} : { identity: stored.identity }),
        }
      : { _tag: "ObjectRetracted", ...common };
  };

  const readEvents = (
    options?: { readonly after?: EventCursor; readonly limit?: number },
  ): Effect.Effect<ReadonlyArray<DbEvent>, StoreError | ForeignCursor | CursorCompacted> =>
      Effect.gen(function* () {
          const after = options?.after === undefined ? 0 : decodeCursor(partition, options.after);
          const compactedTo = yield* readMeta(META_COMPACTED_TO);
          // A cursor from before the compaction point cannot be continued: the
          // events between it and here are gone. Saying so is the difference
          // between a follower knowing it must re-seed and one silently missing
          // writes it will never see again.
          if (options?.after !== undefined && after < compactedTo) {
            return yield* new CursorCompacted({ partition, requested: after, compactedTo });
          }
          const limit = options?.limit ?? 1024;
          const out: DbEvent[] = [];
          yield* Stream.runForEach(engine.scan(eventPrefix()), (entry) =>
            Effect.sync(() => {
              if (out.length >= limit) return;
              const position = positionOf(entry.key);
              if (position > after) out.push(toEvent(position, unjson<StoredEvent>(entry.value)));
            }));
          return out;
      }).pipe(
        // decodeCursor throws on a foreign cursor, which is a caller error
        // rather than a defect, so it is returned to the error channel.
        Effect.catchDefect(
          (cause: unknown): Effect.Effect<never, StoreError | ForeignCursor | CursorCompacted> =>
            Effect.fail(
              cause instanceof ForeignCursor
                ? cause
                : new StoreError({ op: "events.read", cause }),
            ),
        ),
      );

  const events: EventsApi = {
    read: (options) => Stream.fromIterableEffect(readEvents(options)),

    head: Effect.map(readMeta(META_NEXT_POSITION), (position) =>
      position === 0 ? undefined : encodeCursor(partition, position)),

    apply: (event: AppliedEvent) =>
      commit((view, _txn, append) =>
        Effect.gen(function* () {
          // Idempotent by version, so a follower may re-consume a range.
          const seen = yield* versionOf(view, asSeq(event.seq));
          if (seen >= event.version) return;
          // The follower records the event in its own log as well as projecting
          // it. Without that a replica holds the right rows and an empty
          // history, so anything reading the log there — a projection, a
          // rebuild, a backup — sees nothing to replay.
          append(
            event._tag === "ObjectPut"
              ? {
                  generation: event.generation,
                  seq: event.seq,
                  kind: "put",
                  version: event.version,
                  at: event.at,
                  body: Buffer.from(event.bytes).toString("base64"),
                  manifest: event.manifest,
                  ...(event.identity === undefined ? {} : { identity: event.identity }),
                }
              : {
                  generation: event.generation,
                  seq: event.seq,
                  kind: "retract",
                  version: event.version,
                  at: event.at,
                },
          );
          const sealed = (yield* readMeta(META_SEALED)) > 0;
          if (event._tag === "ObjectPut") {
            yield* project(view, event.seq, event.version, event.bytes, event.manifest,
              sealed, event.identity);
          } else {
            yield* unproject(view, event.seq, sealed);
            view.del(payloadKey(event.seq));
          }
        })),
  };

  /**
   * Re-derive the postings from the manifests.
   *
   * Works whether or not the log has been compacted, because a manifest records
   * exactly what its object contributed. It cannot detect a corrupt manifest,
   * which is what a full replay is for.
   */
  const reindexLenses = exclusive(Effect.gen(function* () {
    const pending = new Map<string, KvWrite>();
    const view = pendingView(pending);
    for (const tag of DERIVED_TAGS) {
      yield* Stream.runForEach(engine.scan(Uint8Array.from([tag])), (entry) =>
        Effect.sync(() => view.del(entry.key)));
    }
    // The blobs went with the rest, so what is left is an unsealed live tier.
    view.put(metaKey(META_SEALED), u32(0));
    view.put(metaKey(META_SWEPT), u32(0));
    let count = 0;
    const manifests: Array<{ seq: Seq; manifest: IndexManifest }> = [];
    yield* Stream.runForEach(engine.scan(Uint8Array.from([Tag.Manifest])), (entry) =>
      Effect.sync(() => {
        manifests.push({ seq: asSeq(readU32(entry.key, 1)), manifest: unjson(entry.value) });
      }));
    for (const { seq, manifest } of manifests) {
      for (const [field, term] of manifest.terms) view.put(termKey(field, term, seq), EMPTY);
      for (const [column, value] of manifest.columns) view.put(orderedKey(column, value, seq), EMPTY);
      for (const [column, value] of manifest.measures) view.put(measureKey(column, seq), f64(value));
      for (const [edgeType, to] of manifest.edges) view.put(edgeKey(edgeType, seq, to), EMPTY);
      count += 1;
    }
    yield* engine.write([...pending.values()]);
    return count;
  }));

  return {
    partition,
    generation,
    events,

    rebuildLenses: exclusive(Effect.gen(function* () {
      const compactedTo = yield* readMeta(META_COMPACTED_TO);
      // Replaying a truncated log would rebuild a partial index and report a
      // count as though it were whole. `reindexLenses` is the operation that
      // still works here, because it reads state rather than history.
      if (compactedTo > 0) return yield* new LogCompacted({ partition, compactedTo });
      const stored: Array<{ position: number; event: StoredEvent }> = [];
      yield* Stream.runForEach(engine.scan(eventPrefix()), (entry) =>
        Effect.sync(() => {
          stored.push({ position: positionOf(entry.key), event: unjson<StoredEvent>(entry.value) });
        }));
      stored.sort((a, b) => a.position - b.position);

      const pending = new Map<string, KvWrite>();
      const view = pendingView(pending);
      // Every lens is dropped and re-derived; the log is the only input.
      for (const tag of LENS_TAGS) {
        yield* Stream.runForEach(engine.scan(Uint8Array.from([tag])), (entry) =>
          Effect.sync(() => view.del(entry.key)));
      }
      // The sealed tier was just dropped with the rest, so the replay rebuilds
      // into an unsealed store: no blob can claim a posting, and no tombstone
      // is needed for one.
      view.put(metaKey(META_SEALED), u32(0));
    view.put(metaKey(META_SWEPT), u32(0));
      for (const { event } of stored) {
        if (event.kind === "put") {
          yield* project(view, asSeq(event.seq), event.version, bodyOf(event),
            event.manifest ?? emptyManifest(), false, event.identity);
        } else {
          yield* unproject(view, asSeq(event.seq), false);
          view.del(payloadKey(asSeq(event.seq)));
        }
      }
      yield* engine.write([...pending.values()]);
      return stored.length;
    })),

    reindexLenses,

    /**
     * Fold the live postings into immutable blobs, one per 65536 identifiers.
     *
     * A posting written as a bare key is the cheapest write and the most
     * expensive read: a term matching half a million objects costs half a
     * million b-tree entries every time it is asked for. Sealing trades that
     * for eight blob reads, and keeps the cheap write by never editing a blob —
     * anything written after the seal lands in the live tier beside it, and
     * anything removed from a sealed blob leaves a tombstone the read
     * subtracts.
     *
     * Sealing is incremental: a segment is read, merged and written back only
     * when a live posting or a tombstone falls inside it, so a periodic seal
     * costs what changed rather than what is stored. A first seal is the same
     * operation against blobs that do not exist yet.
     *
     * That makes each seal a merge rather than a rebuild, so the blobs are the
     * accumulated result of every seal so far rather than a fresh function of
     * state. `reindexLenses` is what re-derives them from the manifests when
     * that accumulation needs checking or repairing.
     *
     * Three orderings carry the correctness. The sealed flag is written before
     * any blob, so a removal arriving mid-seal writes a tombstone it might not
     * have needed rather than skipping one it did. Each blob lands in the same
     * batch as the deletion of the live keys it absorbed, so an interrupted
     * seal leaves some lens keys sealed and the rest live — which the read
     * already handles, because it reads both. And the additions land before the
     * removals are read: both passes can touch one segment, so a removal that
     * read the blob as it was before the additions would write back a blob
     * missing them.
     *
     * After the first complete seal, a seal visits only the groups written
     * since, which writes mark as they go (`markDirty`). A value an earlier seal
     * declined as too sparse is not read again until it changes — what keeps a
     * re-seal proportional to what changed. The first seal, and the first after
     * a reindex or a rebuild, sweeps every live posting instead, and only a
     * sweep that finishes counts as one: the flag saying so is written last.
     *
     * The counts describe the segments this seal wrote, not what it added: a
     * merged segment reports everything it now holds. `examined` is the live
     * postings the seal read.
     */
    sealPostings: exclusive(Effect.gen(function* () {
      const swept = (yield* readMeta(META_SWEPT)) > 0;
      // Written before the first blob, so a removal arriving mid-seal writes a
      // tombstone it might not have needed rather than skipping one it did.
      yield* engine.write([{ op: "put", key: metaKey(META_SEALED), value: u32(1) }]);
      let examined = 0;

      const buffer = new SegmentBuffer();
      let batch: KvWrite[] = [];
      let segments = 0;
      let postings = 0;
      let openPrefix: Uint8Array | undefined;
      let openSegment = -1;
      // The live keys gathered into the open segment, deleted only if it seals.
      const gathered: Array<Uint8Array> = [];
      let hadBlob = false;

      /**
       * Write back the segment the buffer holds.
       *
       * A segment that ends up empty has its blob deleted rather than written
       * as an empty one, so a lens emptied by retractions costs nothing rather
       * than a key per segment it once spanned.
       */
      const flush = () => {
        if (openPrefix === undefined) return;
        if (!hadBlob && buffer.size < MIN_SEALED_POSTINGS) {
          // Too few to be worth a blob: they stay live keys, which a scan
          // reads directly. A blob for one or two postings still costs a key
          // of its own, and a decode on every read that passes it.
          gathered.length = 0;
          openPrefix = undefined;
          openSegment = -1;
          return;
        }
        for (const live of gathered) batch.push({ op: "delete", key: live });
        gathered.length = 0;
        const key = segmentKey(openPrefix, openSegment);
        if (buffer.size === 0) {
          batch.push({ op: "delete", key });
        } else {
          const base = openSegment * SEGMENT_SPAN;
          batch.push({ op: "put", key, value: encodeSegment(buffer.ids(base), base) });
          segments += 1;
          postings += buffer.size;
        }
        openPrefix = undefined;
        openSegment = -1;
      };

      /**
       * Move to the segment a posting key belongs to, loading its blob.
       *
       * Every posting key ends in the identifier it records, so what precedes
       * it is the lens — the same slice for terms, columns and edges alike.
       */
      const openFor = (key: Uint8Array, id: number) =>
        Effect.gen(function* () {
          const prefix = key.subarray(0, key.length - 4);
          const segment = segmentOf(id);
          if (openPrefix !== undefined
            && segment === openSegment
            && compareKeys(prefix, openPrefix) === 0) return;

          flush();
          // The batch is only ever cut where a segment ends. Cutting it
          // mid-blob would write the identifiers so far under the segment's
          // key and then the rest under the same key, the second put replacing
          // the first — a seal that silently loses postings.
          if (batch.length >= SEAL_BATCH) {
            yield* engine.write(batch);
            batch = [];
          }
          openPrefix = Uint8Array.from(prefix);
          openSegment = segment;
          buffer.reset();
          const existing = yield* engine.get(segmentKey(openPrefix, segment));
          hadBlob = existing !== undefined;
          if (existing !== undefined) {
            decodeSegment(existing, 0, (offset) => buffer.add(offset));
          }
        });

      const take = (key: Uint8Array) =>
        Effect.gen(function* () {
          const id = seqOf(key);
          yield* openFor(key, id);
          buffer.add(id % SEGMENT_SPAN);
          gathered.push(new Uint8Array(key));
          examined += 1;
        });

      if (!swept) {
        // A sweep: every live posting folds into the blob that covers it, and
        // blobs no live posting touches are never read.
        for (const tag of SEALABLE_TAGS) {
          yield* Stream.runForEach(engine.scan(Uint8Array.from([tag])), (entry) => take(entry.key));
          flush();
        }
      } else {
        // Only the groups written since the last seal. Each mark is cleared in
        // the batch that carries its group's writes — the batch is only cut
        // where a group ends — so an interrupted seal redoes exactly the
        // groups it did not finish.
        const marks = [...(yield* Stream.runCollect(engine.scan(Uint8Array.from([Tag.Dirty]))))]
          .map((entry) => new Uint8Array(entry.key));
        for (const mark of marks) {
          const livePrefix = mark.subarray(1, mark.length - 4);
          const base = readU32(mark, mark.length - 4) * SEGMENT_SPAN;
          const at = (seq: number) => {
            const key = new Uint8Array(livePrefix.length + 4);
            key.set(livePrefix);
            key.set(u32(seq), livePrefix.length);
            return key;
          };
          const to = base + SEGMENT_SPAN > 0xffffffff ? undefined : at(base + SEGMENT_SPAN);
          yield* Stream.runForEach(
            engine.scan(livePrefix, scanOptions(at(base), to, false)),
            (entry) => take(entry.key),
          );
          batch.push({ op: "delete", key: mark });
        }
        flush();
      }
      // Both passes can reach the same segment, and pass two rewrites whatever
      // it reads — so pass one's blobs have to have landed, or the additions
      // they carry are dropped by the write that follows.
      if (batch.length > 0) {
        yield* engine.write(batch);
        batch = [];
      }

      // Tombstones clear bits the blobs still claim. A tombstone written
      // conservatively — for a posting no blob held — clears nothing and is
      // dropped all the same.
      yield* Stream.runForEach(engine.scan(Uint8Array.from([Tag.Tombstone])), (entry) =>
        Effect.gen(function* () {
          // A tombstone key is a posting key with one byte in front of it.
          const posting = entry.key.subarray(1);
          const id = seqOf(posting);
          yield* openFor(posting, id);
          buffer.remove(id % SEGMENT_SPAN);
          batch.push({ op: "delete", key: entry.key });
        }));
      flush();

      if (!swept) {
        // A sweep covers every mark written since the store was sealed, and it
        // is only a sweep once it has finished: the flag goes last.
        yield* Stream.runForEach(engine.scan(Uint8Array.from([Tag.Dirty])), (entry) =>
          Effect.sync(() => {
            batch.push({ op: "delete", key: new Uint8Array(entry.key) });
          }));
        batch.push({ op: "put", key: metaKey(META_SWEPT), value: u32(1) });
      }
      if (batch.length > 0) yield* engine.write(batch);
      return { segments, postings, examined };
    })),

    /**
     * Drop history that no longer describes anything reachable.
     *
     * Storage grows with writes rather than with live objects: a record updated
     * ten times keeps ten events forever, so a busy tenant outgrows memory on
     * history rather than on size. Compaction removes that, and the state left
     * behind is a complete snapshot — payloads, manifests and identities — so
     * nothing that a query or a reindex needs is in the part being removed.
     *
     * What is lost is the ability to replay from before the cut, which is why
     * cursors older than it are rejected rather than quietly continued.
     */
    compact: (options) =>
      exclusive(Effect.gen(function* () {
        const keep = options?.keep ?? 0;
        const positions: number[] = [];
        yield* Stream.runForEach(engine.scan(eventPrefix()), (entry) =>
          Effect.sync(() => positions.push(positionOf(entry.key))));
        positions.sort((a, b) => a - b);
        const cut = positions.length - keep;
        if (cut <= 0) return { removed: 0, compactedTo: yield* readMeta(META_COMPACTED_TO) };
        const compactedTo = positions[cut - 1]!;
        const writes: KvWrite[] = positions
          .slice(0, cut)
          .map((position) => ({ op: "delete" as const, key: eventKey(position) }));
        writes.push({ op: "put", key: metaKey(META_COMPACTED_TO), value: u32(compactedTo) });
        yield* engine.write(writes);
        return { removed: cut, compactedTo };
      })),

    compactedTo: readMeta(META_COMPACTED_TO),

    liveRecords: Effect.gen(function* () {
      // Driven by the identity index, because a record without a caller-facing
      // name is derived state rather than something a backup should carry.
      const identities: Array<{ seq: Seq; identity: ObjectIdentity }> = [];
      yield* Stream.runForEach(engine.scan(Uint8Array.from([Tag.IdentityBySeq])), (entry) =>
        Effect.sync(() => {
          identities.push({ seq: asSeq(readU32(entry.key, 1)), identity: unjson(entry.value) });
        }));
      const out = [];
      for (const { seq, identity } of identities) {
        const payload = yield* engine.get(payloadKey(seq));
        const manifest = yield* engine.get(manifestKey(seq));
        if (payload === undefined) continue;
        out.push({
          seq,
          version: readU32(payload),
          bytes: payload.subarray(4),
          manifest: manifest === undefined ? emptyManifest() : unjson<IndexManifest>(manifest),
          identity,
        });
      }
      return out;
    }),

    lookup: (namespace, key) =>
      Effect.map(engine.get(identityKey(namespace, key)), (bytes) =>
        bytes === undefined ? undefined : asSeq(readU32(bytes))),

    identityOf: (seq) =>
      Effect.map(engine.get(identityBySeqKey(seq)), (bytes) =>
        bytes === undefined ? undefined : unjson<ObjectIdentity>(bytes)),

    nextSeq: exclusive(Effect.gen(function* () {
      const next = (yield* readMeta(META_NEXT_SEQ)) + 1;
      yield* engine.write([{ op: "put", key: metaKey(META_NEXT_SEQ), value: u32(next) }]);
      return asSeq(next);
    })),

    transact: (f) => commit((_view, txn) => f(txn)),

    read: (seq) =>
      Effect.map(engine.get(payloadKey(seq)), (bytes) =>
        bytes === undefined
          ? undefined
          : { seq, version: readU32(bytes), bytes: bytes.subarray(4) }),

    resolve: (query) => Stream.fromIterableEffect(Effect.map(evaluate(query), Postings.iterate)),

    ordered: (input) => readOrdered(input),

    extent: (column, where) =>
      Effect.gen(function* () {
        // Everything before the null run: null sorts last and is not a value.
        const beforeNull = orderedKindRange(column, null).start;
        const filter = where === undefined ? undefined : yield* evaluate(where);
        const end = (reverse: boolean) =>
          Effect.map(
            mergeOrdered({
              column, from: undefined, to: beforeNull,
              sealedFrom: undefined, sealedTo: segmentPrefix(beforeNull),
              reverse, filter, limit: 1,
            }),
            (rows) => rows[0]?.value,
          );
        const min = yield* end(false);
        const max = yield* end(true);
        return {
          ...(min === undefined ? {} : { min }),
          ...(max === undefined ? {} : { max }),
        };
      }),

    measure: (column) =>
      Effect.gen(function* () {
        const found: Array<{ seq: number; value: number }> = [];
        let max = 0;
        yield* Stream.runForEach(engine.scan(measurePrefix(column)), (entry) =>
          Effect.sync(() => {
            const seq = seqOf(entry.key);
            if (seq > max) max = seq;
            found.push({ seq, value: readF64(entry.value) });
          }));
        const vector = new Float64Array(max + 1);
        for (const { seq, value } of found) vector[seq] = value;
        return vector;
      }),
  } satisfies ObjectStoreApi;
};

/**
 * The layout this code writes.
 *
 * 2: equality and order share one sealable scalar lens, and the separate
 * equality lens is gone.
 */
const CURRENT_FORMAT = 2;
const META_FORMAT = "format";

/**
 * Open a store over an engine: claim the writer generation, and bring an
 * older layout current before anything reads it.
 *
 * The lenses are derived from the manifests, so an older layout needs no
 * migration of its own — it is re-indexed, which drops every derived key,
 * the retired ones included, and writes them again as this code reads them.
 * A store with no events has nothing to re-index and is only marked.
 */
export const openStoreOverKv = (
  partition: PartitionKey,
  engine: KvEngine,
): Effect.Effect<ObjectStoreApi, StoreError> =>
  Effect.gen(function* () {
    const store = storeOverKv(partition, engine, yield* claimGeneration(engine));
    const format = yield* engine.get(metaKey(META_FORMAT));
    if (format === undefined || readU32(format) < CURRENT_FORMAT) {
      if ((yield* engine.get(metaKey(META_NEXT_POSITION))) !== undefined) {
        yield* store.reindexLenses.pipe(
          Effect.mapError((cause) =>
            cause._tag === "StoreError" ? cause : new StoreError({ op: "format.upgrade", cause })),
        );
      }
      yield* engine.write([{ op: "put", key: metaKey(META_FORMAT), value: u32(CURRENT_FORMAT) }]);
    }
    return store;
  });

/** Claims the next writer generation, fencing whoever held the previous one. */
export const claimGeneration = (engine: KvEngine): Effect.Effect<number, StoreError> =>
  Effect.gen(function* () {
    const current = yield* engine.get(metaKey(META_GENERATION));
    const next = (current === undefined ? 0 : readU32(current)) + 1;
    yield* engine.write([{ op: "put", key: metaKey(META_GENERATION), value: u32(next) }]);
    return next;
  });
