import { Context, Effect, Option, Semaphore, Stream } from "effect";
import {
  CursorCompacted, CursorMismatch, EventGap, ForeignCursor, LensesRebuilding, LogCompacted,
  PartitionExhausted, ReplicaDiverged, StoreError, TenantMoving, TenantNotEmpty, TenantRelocated, WriterFenced,
} from "./errors.js";
import type { DbError } from "./errors.js";
import type { AppliedEvent, DbEvent, EventCursor, ReadEventsOptions } from "./events.js";
import {
  compareKeys, compareOrderedValues, inPrefixRange, MAX_SEQ, partitionKeys, partitionOf, partitionPrefix,
  partitionSpace, prefixEnd, readSeqAt, readU64At, sameOrderedKind, SEQ_BYTES, seqBytes, seqOf, shardMetaKey,
  shardRelocationKey,
  Tag, u64Bytes, type OrderedValue,
} from "./keys.js";
import { equalBytes, type KvEngine, type KvReader, type KvScanOptions, type KvWrite } from "./kv.js";
import { asSeq, type IndexManifest, type ObjectIdentity, type PartitionKey, type Seq } from "./model.js";
import * as Postings from "./postings.js";
import {
  containerOf, decodeSegment, encodeSegment, SEGMENT_SPAN, SegmentBuffer, segmentOf,
} from "./segments.js";
import {
  decodeEvent, decodeFence, decodeRecord, encodeEvent, encodeFence, encodeRecord,
  type StoredEvent, type StoredFence, type StoredRecord,
} from "./codec.js";
import type { Query, RangeBound, RangeQuery } from "./query.js";
import { RoutedBy } from "./store.js";
import type {
  EventsApi, ObjectStoreApi, OrderedCursor, OrderedPage, OrderedReadInput, OrderedRow,
  PartitionStats, RecordState, SeedResult, ShardStoreApi, Txn,
} from "./store.js";
import type { ShardId } from "./topology.js";

const encoder = new TextEncoder();
const EMPTY = new Uint8Array(0);
const emptyManifest = (): IndexManifest => ({ terms: [], columns: [], measures: [], edges: [] });

const f64 = (value: number): Uint8Array => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value);
  return out;
};

const readF64 = (bytes: Uint8Array): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0);

/** Keys compare as bytes; a batch keyed by them needs a string. */
const keyId = (key: Uint8Array): string => {
  let out = "";
  for (const byte of key) out += String.fromCharCode(byte);
  return out;
};

/** The shard's own records. */
const SHARD_GENERATION = "generation";
const SHARD_OWNER = "writer_session";
const SHARD_FORMAT = "format";

/**
 * The layout this code writes. A shard carries it so a layout change is caught
 * on open instead of misread.
 */
const CURRENT_FORMAT = 3;

/** One partition's own counters and marks. */
const META_NEXT_SEQ = "next_seq";
const META_HEAD = "head";
const META_REVISION = "revision";
const META_RECORDS = "records";
const META_BYTES = "bytes";
/** The position everything at or below has been compacted away. */
const META_COMPACTED_TO = "compacted_to";

/**
 * The log position the stored snapshot covers, and which snapshot it is.
 *
 * A rebuild replays the log, so compaction takes that ability away: a
 * truncated log rebuilds a partial index. A snapshot gives it back — state as
 * of a position, plus the events after it — which keeps the operation that
 * checks the manifests rather than trusting them available on a partition
 * whose history has been cut.
 */
const META_SNAPSHOT_AT = "snapshot_at";
const META_SNAPSHOT_ID = "snapshot_id";
/** The snapshot a seed writes into its empty partition: the first it has. */
const SEED_SNAPSHOT_ID = 1;

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
 * because a posting written before the partition was sealed carries no mark.
 */
const META_SWEPT = "swept";

/** Writes per batch for work that spans many batches, which also bounds the memory it holds. */
const SEAL_BATCH = 4096;

/**
 * Set while a rebuild or a reindex is under way, and left set by one that was
 * interrupted: 1 for a rebuild, 2 for a reindex. Cleared in the batch that
 * finishes the work.
 */
const META_LENSES = "lenses";
const LENSES_READY = 0;
const LENSES_REBUILDING = 1;
const LENSES_REINDEXING = 2;

/**
 * Set by a move on the shard a partition is leaving: where it is going. Every
 * change to the partition is refused from then on (`TenantMoving`), and a
 * removal that keeps the fence leaves it as the only thing there.
 */
const META_FENCE = "fence";

/**
 * Set by a seed's first batch and cleared by its last: a partition holding it
 * has part of a copy and must be copied again, never carried on from.
 */
const META_SEEDING = "seeding";

/**
 * Random bytes naming this life of the partition: written with the first
 * batch that ever reaches it, copied by a seed, and gone when the partition
 * is removed. A partition removed and written again starts a new log whose
 * positions begin over, so a cursor kept from before means nothing in it;
 * this is how a reader holding one can tell.
 */
const META_INCARNATION = "incarnation";

const toHex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

/** The highest version a record can reach: four bytes in every record and event. */
const MAX_VERSION = 0xffffffff;

/**
 * Postings one clause of a query reads before it is called broad.
 *
 * A broad clause is not read in full while a narrower one is there to drive
 * the query: its few candidates are checked against their own manifests
 * instead, one record read each. So the cap trades one record read per
 * candidate against one posting read per member of the broad clause, and
 * bounds what a selective query pays for a wide partner.
 */
const PROBE_CAP = 4096;

/**
 * What a reindex drops and re-derives.
 *
 * Postings hold nothing a manifest does not already say, so they can be
 * reconstructed from state alone. That is what makes compaction possible: the
 * records are already a snapshot, so the log is history rather than the only
 * way back to a working index.
 */
const DERIVED_TAGS = [
  Tag.Term, Tag.Measure, Tag.Edge, Tag.EdgeReverse, Tag.Segment, Tag.Tombstone, Tag.Ordered, Tag.Dirty,
] as const;

/**
 * The lenses whose postings can be sealed into blobs.
 *
 * Measures are absent on purpose: a measure key carries a value, so it is a
 * stored number rather than a posting, and folding it into a set would lose
 * exactly the thing it exists to hold.
 */
const SEALABLE_TAGS = [Tag.Term, Tag.Ordered, Tag.Edge, Tag.EdgeReverse] as const;

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

/** State a rebuild clears and replays; a reindex keeps it. */
const STATE_TAGS = [Tag.Record, Tag.Identity, Tag.Retired] as const;

/** Everything a full replay from the log clears first. */
const LENS_TAGS = [...STATE_TAGS, ...DERIVED_TAGS] as const;

const SEPARATOR = "|";

const encodeCursor = (partition: PartitionKey, position: number): EventCursor =>
  Buffer.from(partition + SEPARATOR + String(position), "utf8").toString("base64url") as EventCursor;

/**
 * The position an event cursor names, refused when another partition issued it.
 *
 * A position is a place in one partition's log and means nothing in another's.
 */
const cursorPosition = (
  partition: PartitionKey,
  cursor: EventCursor,
): Effect.Effect<number, ForeignCursor | StoreError> => {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const at = raw.lastIndexOf(SEPARATOR);
  const owner = raw.slice(0, at);
  if (at < 0 || owner !== partition) {
    return Effect.fail(new ForeignCursor({ expected: partition, received: at < 0 ? raw : owner }));
  }
  const position = Number(raw.slice(at + 1));
  return Number.isSafeInteger(position) && position >= 0
    ? Effect.succeed(position)
    : Effect.fail(new StoreError({ op: "cursor.decode", cause: "the cursor names no position" }));
};

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

/** A counter as a meta value holds it: eight bytes, or nothing for zero. */
const counterOf = (bytes: Uint8Array | undefined): number => {
  if (bytes === undefined) return 0;
  if (bytes.length !== 8) throw new RangeError("A stored counter is not eight bytes.");
  return readU64At(bytes, 0);
};

const generationOf = (engine: KvEngine) => engine.get(shardMetaKey(SHARD_GENERATION)).pipe(
  Effect.flatMap((bytes) => Effect.try({
    try: () => counterOf(bytes),
    catch: (cause) => new StoreError({ op: "generation.read", cause }),
  })),
);

/**
 * Whether a value falls within a range as the ordered lens reads one: by the
 * lens's own order, and — with one bound — only among values of that bound's
 * kind, as `orderedKindRange` stops a one-sided scan at the edge of the kind.
 */
const inRange = (value: OrderedValue, lower: RangeBound | undefined, upper: RangeBound | undefined): boolean => {
  if (lower !== undefined) {
    const order = compareOrderedValues(value, lower.value);
    if (order < 0 || (order === 0 && !lower.inclusive)) return false;
    if (upper === undefined && !sameOrderedKind(value, lower.value)) return false;
  }
  if (upper !== undefined) {
    const order = compareOrderedValues(value, upper.value);
    if (order > 0 || (order === 0 && !upper.inclusive)) return false;
    if (lower === undefined && !sameOrderedKind(value, upper.value)) return false;
  }
  return true;
};

const sameIdentity = (a: ObjectIdentity | undefined, b: ObjectIdentity | undefined): boolean =>
  a === undefined || b === undefined ? a === b : a.namespace === b.namespace && a.key === b.key;

export interface WriterClaim {
  readonly generation: number;
  readonly session: Uint8Array;
}

/** What every partition on one shard shares. */
interface ShardContext {
  readonly shard: ShardId;
  readonly engine: KvEngine;
  readonly claim: WriterClaim;
  /** The node recorded as the writer of every event this shard accepts. */
  readonly origin: string;
  /** How many postings one clause of a query reads before it is checked per candidate instead. */
  readonly probeCap: number;
}

/** A record as a projection is about to leave it. */
interface NextRecord {
  readonly version: number;
  readonly identity?: ObjectIdentity;
  readonly manifest: IndexManifest;
  readonly body: Uint8Array;
}

/** What a batch has changed of the partition's counters, applied when it commits. */
interface Counters {
  records: number;
  bytes: number;
}

/**
 * One partition's store over the shard's engine.
 *
 * Each lens is a key range under the partition's prefix rather than a table. A
 * posting list is the entries under one prefix, already sorted, and
 * intersection walks them in order.
 */
/**
 * The engine snapshots the running read is answered from, per engine.
 *
 * Fiber-local, so a snapshot belongs to the read that took it (`reading`) and
 * to nothing running beside it.
 */
const ReadSnapshots = Context.Reference<ReadonlyMap<KvEngine, KvReader>>("zelavis/db/ReadSnapshots", {
  defaultValue: () => new Map(),
});

/** An engine whose reads come from the running read's snapshot of it, when there is one. */
const snapshotAware = (raw: KvEngine): KvEngine => ({
  ...raw,
  get: (key) => Effect.flatMap(Effect.service(ReadSnapshots), (taken) => (taken.get(raw) ?? raw).get(key)),
  scan: (prefix, options) =>
    Stream.unwrap(Effect.map(Effect.service(ReadSnapshots), (taken) => (taken.get(raw) ?? raw).scan(prefix, options))),
});

/** `effect` reading the engine as it is, whatever snapshot the read around it holds. */
const liveOn = <A, E, R>(raw: KvEngine, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.service(ReadSnapshots), (taken) => {
    if (!taken.has(raw)) return effect;
    const rest = new Map(taken);
    rest.delete(raw);
    return Effect.provideService(effect, ReadSnapshots, rest);
  });

const openPartition = (
  context: ShardContext,
  partition: PartitionKey,
): {
  readonly api: ObjectStoreApi;
  readonly drop: Effect.Effect<number, StoreError | WriterFenced>;
  readonly relocate: (mapVersion: number) => Effect.Effect<number, StoreError | WriterFenced>;
} => {
  const { engine: raw, origin, probeCap } = context;
  /**
   * Reads go through `engine`, which answers from the running read's snapshot
   * when there is one (`reading`). Nothing that writes, or that keeps what it
   * read as a belief about the partition, may see a snapshot: a stale fence or
   * revision kept as current would let a write through that the partition
   * refuses. So everything under the permit, and all upkeep, reads `raw`
   * (`live`), and so do the reads that fill the handle's beliefs.
   */
  const engine = snapshotAware(raw);
  const live = <A, E, R>(effect: Effect.Effect<A, E, R>) => liveOn(raw, effect);
  const { generation, session } = context.claim;
  const keys = partitionKeys(partition);
  const revisionKey = keys.meta(META_REVISION);
  const incarnationKey = keys.meta(META_INCARNATION);

  const readMetaFrom = (source: KvEngine) => (name: string) =>
    Effect.flatMap(source.get(keys.meta(name)), (bytes) => Effect.try({
      try: () => counterOf(bytes),
      catch: (cause) => new StoreError({ op: "meta.read", cause }),
    }));
  const readMeta = readMetaFrom(engine);
  /** For what the handle keeps as a belief: never from a snapshot. */
  const readMetaLive = readMetaFrom(raw);

  /**
   * One writer at a time, per partition.
   *
   * Every write below reads partition state and writes it back changed: a
   * commit reads the log's head, `nextSeq` the identifier counter, a seal the
   * blobs it folds into. On an engine whose reads and writes are asynchronous,
   * two of those in flight at once read the same value and the second write
   * replaces the first — a commit that returned and left no trace. LMDB and
   * RocksDB each lost 31 of 32 concurrent commits that way.
   *
   * The permit is the partition's, so writes to different partitions on one
   * shard do not wait for each other; the engine still applies each batch
   * atomically. Reads take no permit: they see committed state, which is all
   * they promise. Nothing holding the permit calls another operation that
   * takes it.
   */
  const withPermit = Semaphore.withPermit(Semaphore.makeUnsafe(1));

  /**
   * What this handle believes about the partition, kept rather than read for
   * every write.
   *
   * The handle is the partition's one writer for as long as its claim is
   * current — a shard store keeps one handle per partition, and a newer claim
   * fences this one — so what it last wrote is what the partition holds. A
   * write therefore reads nothing before its work: the conditional commit
   * already checks the writer and the revision, and a belief that has gone
   * stale (a newer owner, or anything that wrote the partition around this
   * handle) is caught there, refused, and dropped, so the next operation reads
   * the partition afresh. A failed commit drops it too: an engine that errors
   * may still have applied the batch.
   *
   * Only an operation holding the permit, or one finding the belief already
   * there, uses it as it is. A read outside the permit that finds it missing
   * reads the partition and keeps what it found only if nothing changed the
   * belief meanwhile — `epoch` moves whenever it is dropped, and every change
   * made through the handle sets it — so a read begun before a change cannot
   * store what it saw over what the change wrote.
   */
  let epoch = 0;
  let revision: Uint8Array | undefined;
  let revisionKnown = false;
  let lenses: number | undefined;
  let fence: StoredFence | null | undefined;
  let relocatedAt: number | null | undefined;

  const forget = () => {
    epoch += 1;
    revisionKnown = false;
    lenses = undefined;
    fence = undefined;
    relocatedAt = undefined;
  };

  const assertCurrent = Effect.gen(function* () {
    const current = yield* generationOf(engine);
    const owner = yield* engine.get(shardMetaKey(SHARD_OWNER));
    if (current !== generation || !equalBytes(owner, session)) {
      return yield* new WriterFenced({ partition, claimed: generation, current });
    }
  });

  const exclusive = <A, E, R>(effect: Effect.Effect<A, E, R>) => withPermit(
    live(Effect.gen(function* () {
      if (!revisionKnown) {
        revision = yield* raw.get(revisionKey);
        revisionKnown = true;
      }
      return yield* effect;
    })),
  );

  /**
   * Whether this partition's lenses can be read and written: not while a
   * rebuild or reindex is under way, nor after one was interrupted.
   */
  const lensesReady = Effect.gen(function* () {
    let state = lenses;
    if (state === undefined) {
      const seen = epoch;
      const stored = yield* readMetaLive(META_LENSES);
      if (lenses === undefined && epoch === seen) lenses = stored;
      state = lenses ?? stored;
    }
    if (state !== LENSES_READY) {
      return yield* new LensesRebuilding({
        partition,
        operation: state === LENSES_REBUILDING ? "rebuild" : "reindex",
      });
    }
  });
  const ready = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.flatMap(lensesReady, () => effect);
  const exclusiveReady = <A, E, R>(effect: Effect.Effect<A, E, R>) => exclusive(ready(effect));

  /** Where the partition is moving, if a move has fenced it. */
  const fenceHeld = Effect.gen(function* () {
    if (fence !== undefined) return fence;
    const seen = epoch;
    const bytes = yield* raw.get(keys.meta(META_FENCE));
    const stored = bytes === undefined ? null : yield* decodeOrDie("fence.read", () => decodeFence(bytes));
    if (fence === undefined && epoch === seen) fence = stored;
    return fence === undefined ? stored : fence;
  });

  const relocationKey = shardRelocationKey(partition);

  /** The map version that moved the partition off this shard, if a move has. */
  const relocationHeld = Effect.gen(function* () {
    if (relocatedAt !== undefined) return relocatedAt;
    const seen = epoch;
    const bytes = yield* raw.get(relocationKey);
    const stored = bytes === undefined ? null : yield* decodeOrDie("relocation.read", () => counterOf(bytes));
    if (relocatedAt === undefined && epoch === seen) relocatedAt = stored;
    return relocatedAt === undefined ? stored : relocatedAt;
  });

  /**
   * Refused when a router sent the call here by a map older than the move that
   * took the partition away: see `ShardStoreApi.relocate`. A call no router
   * sent is not checked.
   */
  const routable = Effect.flatMap(Effect.service(RoutedBy), (routedBy) =>
    routedBy === undefined
      ? Effect.void
      : Effect.flatMap(relocationHeld, (at) =>
          at === null || at <= routedBy
            ? Effect.void
            : Effect.fail(new TenantRelocated({ partition, shard: context.shard, mapVersion: at, routedBy }))));

  /** Refused once a move has fenced the partition: see `ObjectStoreApi.fence`. */
  const unfenced = Effect.flatMap(fenceHeld, (held) =>
    held === null ? Effect.void : Effect.fail(new TenantMoving({ tenant: partition, from: held.from, to: held.to })));

  /**
   * A change to what the partition holds: under the permit, with the lenses
   * whole, and not once a move has fenced it. Upkeep and removal are not
   * changes of that kind and take only `exclusive`.
   */
  const exclusiveWrite = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    exclusiveReady(Effect.flatMap(unfenced, () => effect));

  const conditions = () => [
    { key: shardMetaKey(SHARD_GENERATION), value: u64Bytes(generation) },
    { key: shardMetaKey(SHARD_OWNER), value: session },
    { key: revisionKey, value: revision },
  ];

  /**
   * Commit one batch, checked against the writer and the revision the batch was
   * built on, and advance the revision with it. The shard's generation and
   * session fence a stale owner; the partition's revision catches anything else
   * that wrote it since this handle last did. A refusal is the one time the
   * writer is read: it says which of the two it was.
   */
  const write = Effect.fn("store.conditionalWrite")(function*(writes: ReadonlyArray<KvWrite>) {
    if (engine.conditionalWrite === undefined) {
      return yield* new StoreError({ op: "store.write", cause: "Engine has no conditional commit" });
    }
    const nextRevision = encoder.encode(crypto.randomUUID());
    // No revision is a partition nothing has written: this batch begins its life.
    const incarnationId = keyId(incarnationKey);
    const begins = revision === undefined && !writes.some((entry) => keyId(entry.key) === incarnationId);
    const accepted = yield* engine.conditionalWrite(
      [
        ...(begins ? [{ op: "put" as const, key: incarnationKey, value: crypto.getRandomValues(new Uint8Array(16)) }] : []),
        ...writes,
        { op: "put", key: revisionKey, value: nextRevision },
      ],
      conditions(),
    ).pipe(Effect.onError(() => Effect.sync(forget)));
    if (!accepted) {
      forget();
      yield* assertCurrent;
      return yield* new StoreError({ op: "store.conflict", cause: "Partition changed since this handle last wrote it; retry the complete operation" });
    }
    revision = nextRevision;
  });

  /**
   * Reads see the batch being built.
   *
   * A put that follows a retract of the same identifier in one transaction has
   * to observe the retraction, or it re-reads a record the batch already
   * retired and drops postings it just wrote.
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

  /** What a projection writes into, and what it needs to know about the tiers. */
  interface Projection {
    readonly view: View;
    readonly sealed: boolean;
    readonly counters: Counters;
  }

  const decodeOrDie = <A>(op: string, decode: () => A) =>
    Effect.try({ try: decode, catch: (cause) => new StoreError({ op, cause }) });

  const readRecord = (view: View, seq: number) =>
    Effect.flatMap(view.get(keys.record(seq)), (bytes) =>
      bytes === undefined
        ? Effect.succeed<StoredRecord | undefined>(undefined)
        : decodeOrDie("record.read", (): StoredRecord | undefined => decodeRecord(bytes)));

  /** Every posting a manifest contributes for one record, keyed so two sets can be compared. */
  const postingsOf = (manifest: IndexManifest, seq: number): Map<string, Uint8Array> => {
    const out = new Map<string, Uint8Array>();
    const add = (key: Uint8Array) => out.set(keyId(key), key);
    for (const [field, term] of manifest.terms) add(keys.term(field, term, seq));
    for (const [column, value] of manifest.columns) add(keys.ordered(column, value, seq));
    for (const [edgeType, to] of manifest.edges) {
      add(keys.edge(edgeType, seq, to));
      add(keys.reverseEdge(edgeType, to, seq));
    }
    return out;
  };

  const measuresOf = (manifest: IndexManifest): Map<string, number> =>
    new Map(manifest.measures.map(([column, value]) => [column, value] as const));

  /**
   * Mark the seal group a posting belongs to as changed since the last seal.
   * One key per group, overwritten rather than added to, however many of its
   * postings change.
   */
  const markDirty = (view: View, key: Uint8Array): void => {
    view.put(keys.dirty(key.subarray(0, key.length - SEQ_BYTES), segmentOf(seqOf(key))), EMPTY);
  };

  /**
   * Drop a posting from both tiers.
   *
   * The live key goes; a blob cannot be edited, so once anything has been
   * sealed the removal leaves a tombstone for the read to subtract instead.
   */
  const dropPosting = (view: View, key: Uint8Array, sealed: boolean): void => {
    view.del(key);
    if (sealed) {
      view.put(keys.tombstone(key), EMPTY);
      markDirty(view, key);
    }
  };

  /** Write a posting, cancelling any tombstone a previous version left. */
  const addPosting = (view: View, key: Uint8Array, sealed: boolean): void => {
    view.put(key, EMPTY);
    if (sealed) {
      view.del(keys.tombstone(key));
      markDirty(view, key);
    }
  };

  /** Remove the caller's name for a record, unless it has since been given to another. */
  const releaseIdentity = (view: View, identity: ObjectIdentity, seq: number) =>
    Effect.gen(function* () {
      const key = keys.identity(identity.namespace, identity.key);
      const held = yield* view.get(key);
      if (held !== undefined && held.length === SEQ_BYTES && readSeqAt(held, 0) === seq) view.del(key);
    });

  /**
   * Leave a record as `next` says, writing only what changed.
   *
   * An update that keeps most of a document keeps most of its postings, and
   * rewriting those would cost a write each and mark their seal groups dirty
   * for nothing. So the postings the record had and the ones it now has are
   * compared, and only the difference is written.
   */
  const project = (into: Projection, seq: number, current: StoredRecord | undefined, next: NextRecord) =>
    Effect.gen(function* () {
      const { view, sealed, counters } = into;
      const before = current?.live === true ? postingsOf(current.manifest, seq) : new Map<string, Uint8Array>();
      const after = postingsOf(next.manifest, seq);
      for (const [id, key] of before) if (!after.has(id)) dropPosting(view, key, sealed);
      for (const [id, key] of after) if (!before.has(id)) addPosting(view, key, sealed);

      const measuresBefore = current?.live === true ? measuresOf(current.manifest) : new Map<string, number>();
      const measuresAfter = measuresOf(next.manifest);
      for (const [column] of measuresBefore) if (!measuresAfter.has(column)) view.del(keys.measure(column, seq));
      for (const [column, value] of measuresAfter) {
        if (measuresBefore.get(column) !== value) view.put(keys.measure(column, seq), f64(value));
      }

      const held = current?.live === true ? current.identity : undefined;
      if (held !== undefined && !sameIdentity(held, next.identity)) yield* releaseIdentity(view, held, seq);
      if (next.identity !== undefined && !sameIdentity(held, next.identity)) {
        view.put(keys.identity(next.identity.namespace, next.identity.key), seqBytes(seq));
      }

      // A retired record coming back leaves the retired index, or compaction
      // would later drop it as though it were still gone.
      if (current !== undefined && !current.live) view.del(keys.retired(current.retiredAt, seq));
      view.put(keys.record(seq), encodeRecord({
        live: true,
        version: next.version,
        ...(next.identity === undefined ? {} : { identity: next.identity }),
        manifest: next.manifest,
        body: next.body,
      }));
      if (current?.live !== true) counters.records += 1;
      counters.bytes += next.body.length - (current?.live === true ? current.body.length : 0);
    });

  /**
   * Retire a record: drop everything it contributed and keep only its version
   * and the position that retired it.
   *
   * What is kept is what makes a late event harmless: a put older than the
   * retraction finds a version it is not newer than and changes nothing. A
   * record that never existed here is retired all the same, so a retraction
   * applied before the put it follows still wins.
   */
  const retire = (into: Projection, seq: number, current: StoredRecord | undefined, version: number, position: number) =>
    Effect.gen(function* () {
      const { view, sealed, counters } = into;
      if (current?.live === true) {
        for (const key of postingsOf(current.manifest, seq).values()) dropPosting(view, key, sealed);
        for (const [column] of measuresOf(current.manifest)) view.del(keys.measure(column, seq));
        if (current.identity !== undefined) yield* releaseIdentity(view, current.identity, seq);
        counters.records -= 1;
        counters.bytes -= current.body.length;
      }
      if (current !== undefined && !current.live) view.del(keys.retired(current.retiredAt, seq));
      view.put(keys.record(seq), encodeRecord({ live: false, version, retiredAt: position }));
      view.put(keys.retired(position, seq), EMPTY);
    });

  /** What one log entry does to the state it lands on. */
  const applyEffects = (into: Projection, current: StoredRecord | undefined, event: StoredEvent, position: number) =>
    event.kind === "put"
      ? project(into, event.seq, current, {
          version: event.version,
          ...(event.identity === undefined ? {} : { identity: event.identity }),
          manifest: event.manifest,
          body: event.body,
        })
      : retire(into, event.seq, current, event.version, position);

  interface Commit extends Projection {
    /** The newest position this batch has reached. */
    readonly head: () => number;
    /** Append to the log, answering the position the entry took. */
    readonly append: (event: StoredEvent) => Effect.Effect<number, PartitionExhausted>;
  }

  const commit = <A, E, R>(f: (into: Commit) => Effect.Effect<A, E, R>) =>
    exclusiveWrite(Effect.gen(function* () {
      const pending = new Map<string, KvWrite>();
      const view = pendingView(pending);
      const start = yield* readMeta(META_HEAD);
      let head = start;
      const sealed = (yield* readMeta(META_SEALED)) > 0;
      const counters: Counters = { records: 0, bytes: 0 };

      const append = (event: StoredEvent): Effect.Effect<number, PartitionExhausted> => {
        if (head >= Number.MAX_SAFE_INTEGER) {
          return Effect.fail(new PartitionExhausted({ partition, resource: "log", limit: Number.MAX_SAFE_INTEGER }));
        }
        head += 1;
        view.put(keys.event(head), encodeEvent(event));
        return Effect.succeed(head);
      };

      const result = yield* f({ view, sealed, counters, head: () => head, append });
      if (head !== start) view.put(keys.meta(META_HEAD), u64Bytes(head));
      if (counters.records !== 0) {
        view.put(keys.meta(META_RECORDS), u64Bytes((yield* readMeta(META_RECORDS)) + counters.records));
      }
      if (counters.bytes !== 0) {
        view.put(keys.meta(META_BYTES), u64Bytes((yield* readMeta(META_BYTES)) + counters.bytes));
      }
      // One batch: the whole transaction lands, or none of it does. A batch
      // that changed nothing is not written at all.
      if (pending.size > 0) yield* write([...pending.values()]);
      return result;
    }));

  const nextVersion = (current: StoredRecord | undefined) => {
    const version = (current?.version ?? 0) + 1;
    return version > MAX_VERSION
      ? Effect.fail(new StoreError({ op: "record.version", cause: `a record of "${partition}" has reached its last version` }))
      : Effect.succeed(version);
  };

  const txnFor = (into: Commit): Txn => ({
    put: (seq, bytes, manifest, identity) =>
      Effect.gen(function* () {
        const current = yield* readRecord(into.view, seq);
        const version = yield* nextVersion(current);
        yield* into.append({
          kind: "put", generation, seq, version, at: Date.now(), origin,
          ...(identity === undefined ? {} : { identity }), manifest, body: bytes,
        });
        yield* project(into, seq, current, {
          version, ...(identity === undefined ? {} : { identity }), manifest, body: bytes,
        });
      }),

    retract: (seq) =>
      Effect.gen(function* () {
        const current = yield* readRecord(into.view, seq);
        if (current === undefined || !current.live) return;
        const version = yield* nextVersion(current);
        const position = yield* into.append({
          kind: "retract", generation, seq, version, at: Date.now(), origin,
          ...(current.identity === undefined ? {} : { identity: current.identity }),
        });
        yield* retire(into, seq, current, version, position);
      }),

    allocate: Effect.gen(function* () {
      const held = yield* into.view.get(keys.meta(META_NEXT_SEQ));
      const next = (yield* decodeOrDie("meta.read", () => counterOf(held))) + 1;
      if (next > MAX_SEQ) return yield* new PartitionExhausted({ partition, resource: "identifiers", limit: MAX_SEQ });
      into.view.put(keys.meta(META_NEXT_SEQ), u64Bytes(next));
      return asSeq(next);
    }),
  });

  /** An event as it is stored, whoever wrote it. */
  const storedOf = (event: AppliedEvent | DbEvent): StoredEvent => {
    const common = {
      generation: event.generation,
      seq: event.seq,
      version: event.version,
      at: event.at,
      origin: event.origin ?? origin,
      ...(event.identity === undefined ? {} : { identity: event.identity }),
    };
    return event._tag === "ObjectPut"
      ? { kind: "put", ...common, manifest: event.manifest, body: event.bytes }
      : { kind: "retract", ...common };
  };

  const toEvent = (position: number, stored: StoredEvent): DbEvent => {
    const common = {
      cursor: encodeCursor(partition, position),
      partition,
      generation: stored.generation,
      origin: stored.origin,
      at: stored.at,
      seq: asSeq(stored.seq),
      version: stored.version,
      ...(stored.identity === undefined ? {} : { identity: stored.identity }),
    };
    return stored.kind === "put"
      ? { _tag: "ObjectPut", ...common, bytes: stored.body, manifest: stored.manifest }
      : { _tag: "ObjectRetracted", ...common };
  };

  /**
   * A posting list, read from both tiers.
   *
   * Sealed blobs carry everything up to the last seal, the live keys carry
   * everything written since, and tombstones carry what was removed from a
   * blob that cannot be edited. A blob becomes a container as it is.
   *
   * A prefix can span several values — a term prefix spans every term it
   * starts — and a tombstone cancels its own value's posting only. So each
   * value's blobs lose that value's tombstones before the values are united: a
   * document that lost "atlas" but kept "atlantic" still matches `at*`. A live
   * key never has a tombstone beside it — re-adding a posting removes it — so
   * the live tier is added after.
   */
  const postingsUnder = (prefix: Uint8Array) =>
    Effect.gen(function* () {
      const removed = new Map<string, Postings.PostingsBuilder>();
      yield* Stream.runForEach(engine.scan(keys.tombstonePrefix(prefix)), (entry) =>
        Effect.sync(() => {
          const posting = keys.liveOfTombstone(entry.key);
          const value = keyId(posting.subarray(0, posting.length - SEQ_BYTES));
          let builder = removed.get(value);
          if (builder === undefined) {
            builder = new Postings.PostingsBuilder();
            removed.set(value, builder);
          }
          builder.add(seqOf(posting));
        }));

      // Blobs come in key order, which is value then segment, so each value's
      // run arrives together and ascending.
      let sealed: Postings.Postings = Postings.empty;
      let value: string | undefined;
      let segments: number[] = [];
      let containers: Postings.Container[] = [];
      const close = () => {
        if (value === undefined) return;
        const blobs: Postings.Postings = { segments, containers };
        const gone = removed.get(value);
        sealed = Postings.or(sealed, gone === undefined ? blobs : Postings.andNot(blobs, gone.build()));
        segments = [];
        containers = [];
      };
      yield* Stream.runForEach(engine.scan(keys.segmentPrefix(prefix)), (entry) =>
        Effect.sync(() => {
          const id = keyId(keys.liveOfSegment(entry.key));
          if (id !== value) {
            close();
            value = id;
          }
          const container = containerOf(entry.value);
          if (container === undefined) return;
          segments.push(keys.segmentIndexOf(entry.key));
          containers.push(container);
        }));
      close();

      const live = new Postings.PostingsBuilder();
      yield* Stream.runForEach(engine.scan(prefix), (entry) =>
        Effect.sync(() => live.add(seqOf(entry.key))));

      return Postings.or(sealed, live.build());
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
    prefix: keys.orderedColumnPrefix(column),
    from:
      lower !== undefined
        ? lower.inclusive
          ? keys.orderedValuePrefix(column, lower.value)
          : prefixEnd(keys.orderedValuePrefix(column, lower.value))
        : upper !== undefined
          ? keys.orderedKindRange(column, upper.value).start
          : undefined,
    to:
      upper !== undefined
        ? upper.inclusive
          ? prefixEnd(keys.orderedValuePrefix(column, upper.value))
          : keys.orderedValuePrefix(column, upper.value)
        : lower !== undefined
          ? keys.orderedKindRange(column, lower.value).end
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
          keys.tombstonePrefix(prefix),
          scanOptions(from && keys.tombstonePrefix(from), to && keys.tombstonePrefix(to), false),
        ),
        (entry) =>
          Effect.sync(() => {
            removed.add(hexOf(keys.liveOfTombstone(entry.key)));
          }),
      );
      return removed;
    });

  /**
   * The live keys a sealed blob stands for, ascending, within `[from, to)`.
   *
   * A segment key is its live prefix — for the ordered lens, one value of one
   * column — in the sealed tier, with the segment index after it. Putting each
   * identifier back behind that prefix gives the keys the blob replaced, in
   * the order the live tier would have held them.
   */
  const expandBlob = (
    blob: { readonly key: Uint8Array; readonly value: Uint8Array },
    from: Uint8Array | undefined,
    to: Uint8Array | undefined,
  ): Array<Uint8Array> => {
    const livePrefix = keys.liveOfSegment(blob.key);
    const out: Array<Uint8Array> = [];
    decodeSegment(blob.value, keys.segmentIndexOf(blob.key) * SEGMENT_SPAN, (id) => {
      const key = new Uint8Array(livePrefix.length + SEQ_BYTES);
      key.set(livePrefix);
      key.set(seqBytes(id), livePrefix.length);
      if (from !== undefined && compareKeys(key, from) < 0) return;
      if (to !== undefined && compareKeys(key, to) >= 0) return;
      out.push(key);
    });
    return out;
  };

  /**
   * A range as a set of identifiers, so it intersects with every other lens.
   *
   * Both tiers count: the live postings in range, and the blobs of every value
   * in range less what the tombstones removed. Range bounds fall on value
   * boundaries and a blob holds one value, so a blob is wholly inside the range
   * or wholly outside it. Identifiers come out in value order, which the
   * builder sorts per segment and de-duplicates, because a posting written
   * again after a seal is in both tiers, and a manifest may give one object
   * several values in a column.
   */
  const rangePostings = (query: RangeQuery): Effect.Effect<Postings.Postings, StoreError> =>
    Effect.gen(function* () {
      const { prefix, from, to } = rangeBounds(query.column, query.lower, query.upper);
      const removed = yield* tombstonesIn(prefix, from, to);
      const found = new Postings.PostingsBuilder();
      yield* Stream.runForEach(engine.scan(prefix, scanOptions(from, to, false)), (entry) =>
        Effect.sync(() => found.add(seqOf(entry.key))));
      yield* Stream.runForEach(
        engine.scan(keys.segmentPrefix(prefix), scanOptions(from && keys.segmentPrefix(from), to && keys.segmentPrefix(to), false)),
        (entry) =>
          Effect.sync(() => {
            if (removed.size === 0) {
              const container = containerOf(entry.value);
              if (container !== undefined) found.addSegment(keys.segmentIndexOf(entry.key), container);
              return;
            }
            for (const key of expandBlob(entry, undefined, undefined)) {
              if (!removed.has(hexOf(key))) found.add(seqOf(key));
            }
          }),
      );
      return found.build();
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
    readonly filter: RowFilter | undefined;
    readonly limit: number;
  }): Effect.Effect<
    Array<{ readonly key: Uint8Array; readonly seq: number; readonly value: OrderedValue }>,
    StoreError
  > =>
    Effect.gen(function* () {
      const prefix = keys.orderedColumnPrefix(input.column);
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
              engine.scan(keys.segmentPrefix(prefix), scanOptions(blobFrom, blobTo, reverse, BLOB_CHUNK)),
            )),
          ];
          const found: Array<Uint8Array> = [];
          let used = 0;
          for (const blob of blobs) {
            used += 1;
            if (reverse) blobTo = new Uint8Array(blob.key);
            else blobFrom = successorOf(blob.key);
            const expanded = expandBlob(blob, input.from, input.to);
            if (reverse) expanded.reverse();
            for (const key of expanded) found.push(key);
            // Enough for a step: the rest of this batch is fetched again next time.
            if (found.length >= LIVE_CHUNK) break;
          }
          if (used === blobs.length && blobs.length < BLOB_CHUNK) sealedDone = true;
          if (found.length > 0) return found;
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
        const { seq, value } = keys.decodeOrdered(key);
        if (!(yield* passes(input.filter, seq))) continue;
        out.push({ key, seq, value });
      }
      return out;
    });

  /**
   * Whether a lens range holds no more than `cap` postings, reading at most a
   * few more than that from each tier to find out.
   *
   * Tombstones are not subtracted: an over-count only sends a clause down the
   * broad path, which is exact too, just paid for differently.
   */
  const withinCap = (
    livePrefix: Uint8Array,
    liveOptions: KvScanOptions | undefined,
    sealedOptions: KvScanOptions | undefined,
    cap: number,
  ) =>
    Effect.gen(function* () {
      let counted = 0;
      const blobs = yield* Stream.runCollect(
        engine.scan(keys.segmentPrefix(livePrefix), { ...sealedOptions, limit: cap + 1 }),
      );
      for (const blob of blobs) {
        const container = containerOf(blob.value);
        counted += container === undefined ? 0 : container.kind === "list" ? container.offsets.length : container.count;
        if (counted > cap) return false;
      }
      const live = yield* Stream.runCollect(engine.scan(livePrefix, { ...liveOptions, limit: cap - counted + 1 }));
      return counted + [...live].length <= cap;
    });

  /** One clause's postings when they fit under the cap, or nothing when they do not. */
  const leafWithin = (query: Exclude<Query, { readonly _tag: "And" | "Or" }>, cap: number) =>
    Effect.gen(function* () {
      if (query._tag === "Range") {
        const { prefix, from, to } = rangeBounds(query.column, query.lower, query.upper);
        const fits = yield* withinCap(
          prefix,
          scanOptions(from, to, false),
          scanOptions(from && keys.segmentPrefix(from), to && keys.segmentPrefix(to), false),
          cap,
        );
        return fits ? yield* rangePostings(query) : undefined;
      }
      const prefix = query._tag === "Term"
        ? keys.termPrefix(query.field, query.term)
        : query._tag === "TermPrefix"
          ? keys.termPrefixKey(query.field, query.prefix)
          : query._tag === "Equals"
            ? keys.orderedValuePrefix(query.column, query.value)
            : (query.direction ?? "outbound") === "inbound"
              ? keys.reverseEdgePrefix(query.edgeType, query.from)
              : keys.edgePrefix(query.edgeType, query.from);
      return (yield* withinCap(prefix, undefined, undefined, cap)) ? yield* postingsUnder(prefix) : undefined;
    });

  /**
   * Whether one record's manifest satisfies a query, exactly as the lenses
   * would answer it.
   *
   * The lenses are built from the manifest, so this is the same question asked
   * of one record instead of every record: values compare in the lens's one
   * order (`compareOrderedValues`), and a one-sided range stays within its
   * bound's kind as `orderedKindRange` keeps the lens scan within it. An
   * outbound edge is the source's to answer, so the source's targets are read
   * once and kept in `outbound`.
   */
  const holds = (
    query: Query,
    manifest: IndexManifest,
    seq: number,
    outbound: Map<string, ReadonlySet<number>>,
  ): Effect.Effect<boolean, StoreError> => {
    switch (query._tag) {
      case "Term":
        return Effect.succeed(manifest.terms.some(([field, term]) => field === query.field && term === query.term));
      case "TermPrefix": {
        const wanted = encoder.encode(query.prefix);
        return Effect.succeed(manifest.terms.some(([field, term]) => {
          if (field !== query.field) return false;
          const bytes = encoder.encode(term);
          return bytes.length >= wanted.length && wanted.every((byte, i) => bytes[i] === byte);
        }));
      }
      case "Equals":
        return Effect.succeed(manifest.columns.some(([column, value]) =>
          column === query.column && compareOrderedValues(value, query.value) === 0));
      case "Range":
        return Effect.succeed(manifest.columns.some(([column, value]) =>
          column === query.column && inRange(value, query.lower, query.upper)));
      case "Edge": {
        if ((query.direction ?? "outbound") === "inbound") {
          return Effect.succeed(manifest.edges.some(([edgeType, to]) =>
            edgeType === query.edgeType && Number(to) === query.from));
        }
        const key = `${query.edgeType}\u0000${query.from}`;
        const known = outbound.get(key);
        if (known !== undefined) return Effect.succeed(known.has(seq));
        return Effect.map(readRecord(pendingView(new Map()), query.from), (source) => {
          const targets = new Set<number>(source?.live === true
            ? source.manifest.edges.filter(([edgeType]) => edgeType === query.edgeType).map(([, to]) => Number(to))
            : []);
          outbound.set(key, targets);
          return targets.has(seq);
        });
      }
      case "And":
        return Effect.gen(function* () {
          for (const part of query.of) if (!(yield* holds(part, manifest, seq, outbound))) return false;
          return true;
        });
      case "Or":
        return Effect.gen(function* () {
          for (const part of query.of) if (yield* holds(part, manifest, seq, outbound)) return true;
          return false;
        });
    }
  };

  /** What a query comes to under the cap: a set, or a promise that it is wider than one. */
  type Bounded =
    | { readonly kind: "exact"; readonly postings: Postings.Postings }
    | { readonly kind: "broad" };

  /**
   * A query evaluated without reading any clause past the cap.
   *
   * A clause that fits is an exact set. An AND intersects its exact clauses,
   * and checks each surviving candidate against the broad ones by reading the
   * candidate's manifest — so `status = "rare" AND createdAt > T` costs the
   * rare postings and one record read per rare document, not the whole date
   * range. An AND with no exact clause, and an OR with a broad one, are broad:
   * nothing narrow is there to drive them, and the caller reads them in full.
   */
  const evaluateBounded = (query: Query, cap: number): Effect.Effect<Bounded, StoreError> =>
    Effect.gen(function* () {
      if (query._tag === "And" || query._tag === "Or") {
        const parts = yield* Effect.forEach(query.of, (part) => evaluateBounded(part, cap));
        if (query._tag === "Or") {
          return parts.every((part) => part.kind === "exact")
            ? { kind: "exact", postings: Postings.orAll(parts.map((part) => (part as { postings: Postings.Postings }).postings)) }
            : { kind: "broad" };
        }
        const exact = parts.flatMap((part) => (part.kind === "exact" ? [part.postings] : []));
        if (exact.length === 0) return { kind: "broad" };
        const candidates = Postings.andAll(exact);
        const broad = query.of.filter((_, i) => parts[i]!.kind === "broad");
        if (broad.length === 0) return { kind: "exact", postings: candidates };
        const outbound = new Map<string, ReadonlySet<number>>();
        const kept = new Postings.PostingsBuilder();
        for (const seq of Postings.iterate(candidates)) {
          const record = yield* readRecord(pendingView(new Map()), seq);
          if (record?.live !== true) continue;
          let all = true;
          for (const part of broad) {
            if (!(yield* holds(part, record.manifest, seq, outbound))) {
              all = false;
              break;
            }
          }
          if (all) kept.add(seq);
        }
        return { kind: "exact", postings: kept.build() };
      }
      const postings = yield* leafWithin(query, cap);
      return postings === undefined ? { kind: "broad" } : { kind: "exact", postings };
    });

  /** A query as a set: bounded where a narrow clause can drive it, read in full where none can. */
  const resolveSet = (query: Query) =>
    Effect.flatMap(evaluateBounded(query, probeCap), (bounded) =>
      bounded.kind === "exact" ? Effect.succeed(bounded.postings) : evaluate(query));

  /**
   * Identifiers per window of a windowed read: the cap, rounded down to a power
   * of two so a window never straddles a sealed segment.
   */
  const windowSize = 2 ** Math.floor(Math.log2(Math.min(Math.max(probeCap, 1), SEGMENT_SPAN)));

  /**
   * A query whose answer can be read one window of identifiers at a time.
   *
   * A term, an equality or an edge reads one value's posting list, kept in
   * identifier order under its own prefix, so a window of it is one seek. A
   * range or a term prefix spans many values, each in its own order, so in an
   * AND it is checked per candidate against the record, as `evaluateBounded`
   * checks a broad clause; a query with nothing windowable to drive it has no
   * windowed form.
   */
  type Windowed =
    | { readonly kind: "list"; readonly prefix: Uint8Array }
    | { readonly kind: "and"; readonly drivers: ReadonlyArray<Windowed>; readonly checked: ReadonlyArray<Query> }
    | { readonly kind: "or"; readonly of: ReadonlyArray<Windowed> };

  const windowedOf = (query: Query): Windowed | undefined => {
    switch (query._tag) {
      case "Term":
        return { kind: "list", prefix: keys.termPrefix(query.field, query.term) };
      case "Equals":
        return { kind: "list", prefix: keys.orderedValuePrefix(query.column, query.value) };
      case "Edge":
        return {
          kind: "list",
          prefix: (query.direction ?? "outbound") === "inbound"
            ? keys.reverseEdgePrefix(query.edgeType, query.from)
            : keys.edgePrefix(query.edgeType, query.from),
        };
      case "Range":
      case "TermPrefix":
        return undefined;
      case "And": {
        const drivers: Array<Windowed> = [];
        const checked: Array<Query> = [];
        for (const part of query.of) {
          const windowed = windowedOf(part);
          if (windowed === undefined) checked.push(part);
          else drivers.push(windowed);
        }
        return drivers.length === 0 ? undefined : { kind: "and", drivers, checked };
      }
      case "Or": {
        const of: Array<Windowed> = [];
        for (const part of query.of) {
          const windowed = windowedOf(part);
          if (windowed === undefined) return undefined;
          of.push(windowed);
        }
        return { kind: "or", of };
      }
    }
  };

  /** The live key of an identifier under a prefix, or the end of the prefix past the last one. */
  const postingBound = (prefix: Uint8Array, id: number): Uint8Array | undefined => {
    if (id > MAX_SEQ) return prefixEnd(prefix);
    const key = new Uint8Array(prefix.length + SEQ_BYTES);
    key.set(prefix);
    key.set(seqBytes(id), prefix.length);
    return key;
  };

  /** One value's sealed postings in one segment, less its tombstones, read once per windowed read. */
  type SealedCache = Map<string, Postings.Postings | null>;

  const sealedSegment = (prefix: Uint8Array, segment: number, cache: SealedCache) =>
    Effect.gen(function* () {
      const id = `${keyId(prefix)}/${segment}`;
      const held = cache.get(id);
      if (held !== undefined) return held ?? undefined;
      const bytes = yield* engine.get(keys.segment(prefix, segment));
      const container = bytes === undefined ? undefined : containerOf(bytes);
      if (container === undefined) {
        cache.set(id, null);
        return undefined;
      }
      // A tombstone cancels a sealed posting removed since the seal; only this
      // value's, within this segment, can touch this blob.
      const base = segment * SEGMENT_SPAN;
      const from = postingBound(prefix, base);
      const to = postingBound(prefix, base + SEGMENT_SPAN);
      const removed = new Postings.PostingsBuilder();
      yield* Stream.runForEach(
        engine.scan(
          keys.tombstonePrefix(prefix),
          scanOptions(from && keys.tombstone(from), to && keys.tombstone(to), false),
        ),
        (entry) => Effect.sync(() => removed.add(seqOf(keys.liveOfTombstone(entry.key)))),
      );
      const blob = Postings.andNot({ segments: [segment], containers: [container] }, removed.build());
      cache.set(id, blob);
      return blob;
    });

  /** The first identifier at or after `from` a windowed query could hold: a lower bound for an AND. */
  const nextFrom = (
    shape: Windowed,
    from: number,
    cache: SealedCache,
  ): Effect.Effect<number | undefined, StoreError> =>
    Effect.gen(function* () {
      if (shape.kind === "or") {
        let lowest: number | undefined;
        for (const part of shape.of) {
          const next = yield* nextFrom(part, from, cache);
          if (next !== undefined && (lowest === undefined || next < lowest)) lowest = next;
        }
        return lowest;
      }
      if (shape.kind === "and") {
        let highest = from;
        for (const driver of shape.drivers) {
          const next = yield* nextFrom(driver, from, cache);
          if (next === undefined) return undefined;
          if (next > highest) highest = next;
        }
        return highest;
      }
      if (from > MAX_SEQ) return undefined;
      const live = [...(yield* Stream.runCollect(
        engine.scan(shape.prefix, scanOptions(postingBound(shape.prefix, from), undefined, false, 1)),
      ))][0];
      let next = live === undefined ? undefined : seqOf(live.key);
      // Sealed blobs from the segment holding `from`, until one holds an
      // identifier at or after it — or one starts past the live answer.
      let segment = Math.floor(from / SEGMENT_SPAN);
      for (;;) {
        const blob = [...(yield* Stream.runCollect(
          engine.scan(keys.segmentPrefix(shape.prefix), scanOptions(keys.segment(shape.prefix, segment), undefined, false, 1)),
        ))][0];
        if (blob === undefined) break;
        const index = keys.segmentIndexOf(blob.key);
        if (next !== undefined && index * SEGMENT_SPAN > next) break;
        const sealed = yield* sealedSegment(shape.prefix, index, cache);
        const first = sealed === undefined ? undefined : Postings.between(sealed, from, Number.MAX_SAFE_INTEGER).next();
        if (first !== undefined && first.done !== true) {
          if (next === undefined || first.value < next) next = first.value;
          break;
        }
        segment = index + 1;
      }
      return next;
    });

  /** What a windowed read has spent checking candidates against their records. */
  interface Tally {
    checks: number;
  }

  /** A windowed query's answer within `[lo, hi)`, a window inside one segment. */
  const windowOf = (
    shape: Windowed,
    lo: number,
    hi: number,
    cache: SealedCache,
    tally: Tally,
  ): Effect.Effect<Postings.Postings, StoreError> =>
    Effect.gen(function* () {
      if (shape.kind === "or") {
        return Postings.orAll(yield* Effect.forEach(shape.of, (part) => windowOf(part, lo, hi, cache, tally)));
      }
      if (shape.kind === "and") {
        const candidates = Postings.andAll(yield* Effect.forEach(shape.drivers, (driver) => windowOf(driver, lo, hi, cache, tally)));
        if (shape.checked.length === 0) return candidates;
        const outbound = new Map<string, ReadonlySet<number>>();
        const kept = new Postings.PostingsBuilder();
        for (const seq of Postings.iterate(candidates)) {
          tally.checks += 1;
          const record = yield* readRecord(pendingView(new Map()), seq);
          if (record?.live !== true) continue;
          let all = true;
          for (const part of shape.checked) {
            if (!(yield* holds(part, record.manifest, seq, outbound))) {
              all = false;
              break;
            }
          }
          if (all) kept.add(seq);
        }
        return kept.build();
      }
      const found = new Postings.PostingsBuilder();
      yield* Stream.runForEach(
        engine.scan(shape.prefix, scanOptions(postingBound(shape.prefix, lo), postingBound(shape.prefix, hi), false)),
        (entry) => Effect.sync(() => found.add(seqOf(entry.key))),
      );
      const sealed = yield* sealedSegment(shape.prefix, Math.floor(lo / SEGMENT_SPAN), cache);
      if (sealed !== undefined) for (const seq of Postings.between(sealed, lo, hi)) found.add(seq);
      return found.build();
    });

  /** Identifiers handed on per step once a windowed read has fallen back to the whole answer. */
  const FALLBACK_STEP = 4096;

  /**
   * A query's identifiers after `after`, ascending, read a window at a time and
   * only as far as whoever consumes them goes.
   *
   * A query the bounded evaluation answers exactly is a small set already, and
   * is paged from. Otherwise a windowed query jumps to the next identifier any
   * of its lists holds and reads one window there, so a page deep into a large
   * collection costs about the cap and the page rather than the collection.
   *
   * A range or a prefix alone has no windowed form: it spans many values, each
   * in its own order. Given `within` — a list the query is known to be confined
   * to, such as a collection's own postings — the read is driven by that list
   * a window at a time instead, each candidate checked against the query.
   * Checks cost a record read each, which pays while the matches are a fair
   * share of the list and not when they are scattered thinly through it, so a
   * read spends at most the cap in checks: past that, the rest of it is the
   * query evaluated whole, once. A query with neither form is evaluated whole
   * from the start, as before.
   */
  const resolveAfter = (
    query: Query,
    after: number | undefined,
    within: Query | undefined,
  ): Stream.Stream<Seq, StoreError | LensesRebuilding> =>
    Stream.unwrap(Effect.gen(function* () {
      yield* lensesReady;
      const start = after === undefined ? 0 : after + 1;
      const bounded = yield* evaluateBounded(query, probeCap);
      if (bounded.kind === "exact") return Stream.fromIterable(Postings.between(bounded.postings, start, Number.MAX_SAFE_INTEGER));
      const driver = within === undefined ? undefined : windowedOf(within);
      const shape: Windowed | undefined = windowedOf(query)
        ?? (driver === undefined ? undefined : { kind: "and", drivers: [driver], checked: [query] });
      if (shape === undefined) {
        return Stream.fromIterableEffect(Effect.map(evaluate(query), (all) => Postings.between(all, start, Number.MAX_SAFE_INTEGER)));
      }
      const cache: SealedCache = new Map();
      const tally: Tally = { checks: 0 };
      let whole: Postings.Postings | undefined;
      return Stream.paginate(start, (from: number) =>
        Effect.gen(function* () {
          if (whole !== undefined || tally.checks > probeCap) {
            // Thinly scattered matches: the checks so far found too few.
            whole ??= yield* evaluate(query);
            const step: Array<Seq> = [];
            for (const seq of Postings.between(whole, from, Number.MAX_SAFE_INTEGER)) {
              step.push(seq);
              if (step.length === FALLBACK_STEP) break;
            }
            return [step, step.length < FALLBACK_STEP ? Option.none<number>() : Option.some(step.at(-1)! + 1)] as const;
          }
          const next = yield* nextFrom(shape, from, cache);
          if (next === undefined) return [[], Option.none<number>()] as const;
          const lo = next - (next % windowSize);
          const hi = lo + windowSize;
          const found = yield* windowOf(shape, lo, hi, cache, tally);
          return [[...Postings.between(found, Math.max(lo, from), hi)], hi > MAX_SEQ ? Option.none<number>() : Option.some(hi)] as const;
        }));
    }));

  /**
   * How an ordered read keeps to its `where`: by a set when the filter fits
   * under the cap, and otherwise by checking each row's manifest — a broad
   * filter passes most rows, so a page reads about what it returns either way.
   */
  type RowFilter =
    | { readonly kind: "exact"; readonly postings: Postings.Postings }
    | { readonly kind: "check"; readonly query: Query; readonly outbound: Map<string, ReadonlySet<number>> };

  const rowFilterFor = (where: Query | undefined): Effect.Effect<RowFilter | undefined, StoreError> =>
    where === undefined
      ? Effect.succeed(undefined)
      : Effect.map(evaluateBounded(where, probeCap), (bounded): RowFilter =>
        bounded.kind === "exact"
          ? { kind: "exact", postings: bounded.postings }
          : { kind: "check", query: where, outbound: new Map() });

  const passes = (filter: RowFilter | undefined, seq: number): Effect.Effect<boolean, StoreError> => {
    if (filter === undefined) return Effect.succeed(true);
    if (filter.kind === "exact") return Effect.succeed(Postings.has(filter.postings, seq));
    return Effect.flatMap(readRecord(pendingView(new Map()), seq), (record) =>
      record?.live === true ? holds(filter.query, record.manifest, seq, filter.outbound) : Effect.succeed(false));
  };

  const evaluate = (query: Query): Effect.Effect<Postings.Postings, StoreError> => {
    switch (query._tag) {
      case "Range": return rangePostings(query);
      case "Term": return postingsUnder(keys.termPrefix(query.field, query.term));
      case "TermPrefix": return postingsUnder(keys.termPrefixKey(query.field, query.prefix));
      case "Equals": return postingsUnder(keys.orderedValuePrefix(query.column, query.value));
      case "Edge": {
        const direction = query.direction ?? "outbound";
        return direction === "inbound"
          ? postingsUnder(keys.reverseEdgePrefix(query.edgeType, query.from))
          : postingsUnder(keys.edgePrefix(query.edgeType, query.from));
      }
      case "And": return Effect.map(Effect.forEach(query.of, evaluate), Postings.andAll);
      case "Or": return Effect.map(Effect.forEach(query.of, evaluate), Postings.orAll);
    }
  };

  const decodeOrderedCursor = (
    column: string,
    direction: "asc" | "desc",
    cursor: OrderedCursor,
  ): Effect.Effect<Uint8Array, ForeignCursor | CursorMismatch> =>
    Effect.gen(function* () {
      const malformed = new CursorMismatch({ reason: "the cursor is not one an ordered read produced" });
      const parsed = yield* Effect.try({
        try: (): unknown => JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
        catch: () => malformed,
      });
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
      if (!inPrefixRange(key, keys.orderedColumnPrefix(column))) return yield* malformed;
      return key;
    });

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
      let sealedFrom = from && keys.segmentPrefix(from);
      let sealedTo = to && keys.segmentPrefix(to);
      if (input.after !== undefined) {
        const last = yield* decodeOrderedCursor(input.column, direction, input.after);
        const valueBlobs = keys.segmentPrefix(last.subarray(0, last.length - SEQ_BYTES));
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
      const filter = yield* rowFilterFor(input.where);
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

  const readEvents = (
    options?: ReadEventsOptions,
  ): Effect.Effect<ReadonlyArray<DbEvent>, StoreError | ForeignCursor | CursorCompacted> =>
    Effect.gen(function* () {
      if (options?.after !== undefined && options.from !== undefined) {
        return yield* Effect.die(new TypeError("an event read takes `after` or `from`, not both"));
      }
      const cursor = options?.from ?? options?.after;
      const named = cursor === undefined ? 0 : yield* cursorPosition(partition, cursor);
      // Read from a position by reading after the one before it.
      const after = options?.from !== undefined ? Math.max(named - 1, 0) : named;
      const compactedTo = yield* readMeta(META_COMPACTED_TO);
      // A cursor from before the compaction point cannot be continued: the
      // events between it and here are gone. Saying so is the difference
      // between a follower knowing it must re-seed and one silently missing
      // writes it will never see again.
      if (cursor !== undefined && after < compactedTo) {
        return yield* new CursorCompacted({ partition, requested: after, compactedTo });
      }
      const limit = options?.limit ?? 1024;
      const out: DbEvent[] = [];
      // Positions are the keys, so the scan starts just past the cursor and
      // stops at the limit: a read costs what it returns, not the log behind it.
      yield* Stream.runForEach(
        engine.scan(keys.tag(Tag.Event), { from: keys.event(after + 1), limit }),
        (entry) =>
          Effect.flatMap(decodeOrDie("event.read", () => decodeEvent(entry.value)), (stored) =>
            Effect.sync(() => {
              out.push(toEvent(keys.positionOf(entry.key), stored));
            })),
      );
      return out;
    });

  /**
   * Apply events at the positions they hold in the partition's log on its
   * writer, in one transaction.
   *
   * A position already held is compared with what is there and skipped, and
   * refused when it differs; a position past the next is refused, because it
   * would leave a hole. The identifiers the events use are marked taken, so a
   * write accepted here later — after a move, or by a promoted follower —
   * cannot be handed one of them again.
   */
  const followMany = (batch: ReadonlyArray<DbEvent>) =>
    Effect.gen(function* () {
      const positioned = yield* Effect.forEach(batch, (event) =>
        Effect.map(cursorPosition(partition, event.cursor), (position) => ({ position, stored: storedOf(event) })));
      yield* commit((into) =>
        Effect.gen(function* () {
          let highest = 0;
          for (const { position, stored } of positioned) {
            const head = into.head();
            if (position <= head) {
              const held = yield* into.view.get(keys.event(position));
              // Compacted away here: there is nothing left to compare it with.
              if (held === undefined) continue;
              if (!equalBytes(held, encodeEvent(stored))) {
                return yield* new ReplicaDiverged({ partition, position });
              }
              continue;
            }
            if (position !== head + 1) {
              return yield* new EventGap({ partition, expected: head + 1, received: position });
            }
            const current = yield* readRecord(into.view, stored.seq);
            yield* into.append(stored);
            if (current === undefined || current.version < stored.version) {
              yield* applyEffects(into, current, stored, position);
            }
            highest = Math.max(highest, stored.seq);
          }
          if (highest > (yield* readMeta(META_NEXT_SEQ))) {
            into.view.put(keys.meta(META_NEXT_SEQ), u64Bytes(highest));
          }
        }));
    });

  const events: EventsApi = {
    read: (options) => Stream.fromIterableEffect(readEvents(options)),

    head: Effect.map(readMeta(META_HEAD), (position) =>
      position === 0 ? undefined : encodeCursor(partition, position)),

    apply: (event: AppliedEvent) =>
      commit((into) =>
        Effect.gen(function* () {
          // Idempotent by version, retracted records included: their version
          // outlives them, so a put older than the retraction changes nothing.
          const current = yield* readRecord(into.view, event.seq);
          if (current !== undefined && current.version >= event.version) return;
          const stored = storedOf(event);
          // The receiving store records the event in its own log as well as
          // projecting it. Without that a replica holds the right rows and an
          // empty history, so anything reading the log there — a projection, a
          // rebuild, a backup — sees nothing to replay.
          const position = yield* into.append(stored);
          yield* applyEffects(into, current, stored, position);
          // The identifier is taken here now, so nothing this partition hands
          // out later — after a restore, or once a replica is promoted — can
          // be it again.
          if (event.seq > (yield* readMeta(META_NEXT_SEQ))) {
            into.view.put(keys.meta(META_NEXT_SEQ), u64Bytes(event.seq));
          }
        })),

    follow: (event: DbEvent) => followMany([event]),

    followAll: (batch) => followMany(batch),
  };

  const recordsWhere = <A>(keep: (seq: number, record: StoredRecord) => A | undefined) =>
    Effect.gen(function* () {
      const out: A[] = [];
      yield* Stream.runForEach(engine.scan(keys.tag(Tag.Record)), (entry) =>
        Effect.flatMap(decodeOrDie("record.read", () => decodeRecord(entry.value)), (record) =>
          Effect.sync(() => {
            const kept = keep(seqOf(entry.key), record);
            if (kept !== undefined) out.push(kept);
          })));
      return out;
    });

  /**
   * Every record that exists and has a caller-facing name.
   *
   * A record without one is derived state rather than something a backup
   * should carry.
   */
  const liveRecords = recordsWhere((seq, record) =>
    record.live && record.identity !== undefined
      ? {
          seq: asSeq(seq),
          version: record.version,
          bytes: record.body,
          manifest: record.manifest,
          identity: record.identity,
        }
      : undefined);

  const manifestOf = (seq: Seq) =>
    Effect.map(readRecord(pendingView(new Map()), seq), (record) =>
      record?.live === true ? record.manifest : emptyManifest());

  /** Delete every key under the given tags, a bounded batch at a time. */
  const clearTags = (tags: ReadonlyArray<Tag>) =>
    Effect.forEach(tags, (tag) =>
      Effect.gen(function* () {
        for (;;) {
          const chunk = [...(yield* Stream.runCollect(engine.scan(keys.tag(tag), { limit: SEAL_BATCH })))];
          if (chunk.length === 0) return;
          yield* write(chunk.map((entry): KvWrite => ({ op: "delete", key: new Uint8Array(entry.key) })));
        }
      }), { discard: true });

  /**
   * Visit every entry under a prefix a bounded chunk at a time, each chunk read
   * before anything is written for it: writing into the keyspace a scan is
   * still walking would leave what the scan sees to the engine.
   */
  const inChunks = <E, R>(
    prefix: Uint8Array,
    from: Uint8Array | undefined,
    visit: (entry: { readonly key: Uint8Array; readonly value: Uint8Array }) => Effect.Effect<void, E, R>,
  ) =>
    Effect.gen(function* () {
      let next = from;
      for (;;) {
        const chunk = [...(yield* Stream.runCollect(
          engine.scan(prefix, { ...(next === undefined ? {} : { from: next }), limit: SEAL_BATCH }),
        ))].map((entry) => ({ key: new Uint8Array(entry.key), value: new Uint8Array(entry.value) }));
        for (const entry of chunk) yield* visit(entry);
        if (chunk.length < SEAL_BATCH) return;
        next = successorOf(chunk.at(-1)!.key);
      }
    });

  /** Batches of staged writes, committed whenever one grows past the batch size. */
  const batches = () => {
    let pending = new Map<string, KvWrite>();
    let view = pendingView(pending);
    return {
      view: () => view,
      size: () => pending.size,
      flush: Effect.gen(function* () {
        if (pending.size === 0) return;
        yield* write([...pending.values()]);
        pending = new Map<string, KvWrite>();
        view = pendingView(pending);
      }),
    };
  };

  /** Mark the lenses as being rebuilt or reindexed: from here they are refused until the work finishes. */
  const markLenses = (state: number) =>
    Effect.gen(function* () {
      yield* write([{ op: "put", key: keys.meta(META_LENSES), value: u64Bytes(state) }]);
      lenses = state;
    });

  /**
   * Re-derive the postings from the stored manifests.
   *
   * Works whether or not the log has been compacted, because a manifest records
   * exactly what its object contributed. It cannot detect a corrupt manifest,
   * which is what a full replay is for. Runs in bounded batches under the
   * writer, behind the lenses mark, so the partition is refused rather than
   * answered from half an index until the last batch clears it.
   */
  const reindexLenses = exclusive(Effect.gen(function* () {
    yield* markLenses(LENSES_REINDEXING);
    yield* clearTags(DERIVED_TAGS);
    const out = batches();
    let count = 0;
    yield* inChunks(keys.tag(Tag.Record), undefined, (entry) =>
      Effect.gen(function* () {
        const record = yield* decodeOrDie("record.read", () => decodeRecord(entry.value));
        if (!record.live) return;
        const seq = seqOf(entry.key);
        for (const key of postingsOf(record.manifest, seq).values()) out.view().put(key, EMPTY);
        for (const [column, value] of measuresOf(record.manifest)) out.view().put(keys.measure(column, seq), f64(value));
        count += 1;
        if (out.size() >= SEAL_BATCH) yield* out.flush;
      }));
    // The blobs went with the rest, so what is left is an unsealed live tier.
    out.view().put(keys.meta(META_SEALED), u64Bytes(0));
    out.view().put(keys.meta(META_SWEPT), u64Bytes(0));
    out.view().put(keys.meta(META_LENSES), u64Bytes(LENSES_READY));
    yield* out.flush;
    lenses = LENSES_READY;
    return count;
  }));

  /**
   * Replay the log into fresh lenses and records, in bounded batches.
   *
   * Replaying a truncated log would rebuild a partial index and report a count
   * as though it were whole — unless a snapshot covers everything that was cut,
   * in which case the snapshot plus the events after it are the whole history.
   * Without one, `reindexLenses` is the operation that still works, because it
   * reads state rather than history.
   */
  const rebuildLenses = exclusive(Effect.gen(function* () {
    const compactedTo = yield* readMeta(META_COMPACTED_TO);
    const snapshotAt = yield* readMeta(META_SNAPSHOT_AT);
    if (compactedTo > 0 && snapshotAt < compactedTo) {
      return yield* new LogCompacted({ partition, compactedTo });
    }
    yield* markLenses(LENSES_REBUILDING);
    // Every lens is dropped and re-derived; the log is the only input.
    yield* clearTags(LENS_TAGS);
    const out = batches();
    const counters: Counters = { records: 0, bytes: 0 };
    // The sealed tier was just dropped with the rest, so the replay rebuilds
    // into an unsealed partition: no blob can claim a posting, and no tombstone
    // is needed for one.
    const into = (): Projection => ({ view: out.view(), sealed: false, counters });

    // The snapshot first, then the events it does not cover.
    let restored = 0;
    if (snapshotAt > 0) {
      const snapshotId = yield* readMeta(META_SNAPSHOT_ID);
      yield* inChunks(keys.snapshotPrefix(snapshotId), undefined, (entry) =>
        Effect.gen(function* () {
          const record = yield* decodeOrDie("snapshot.read", () => decodeRecord(entry.value));
          if (!record.live) return;
          yield* project(into(), seqOf(entry.key), undefined, record);
          restored += 1;
          if (out.size() >= SEAL_BATCH) yield* out.flush;
        }));
    }
    let replayed = 0;
    yield* inChunks(keys.tag(Tag.Event), keys.event(snapshotAt + 1), (entry) =>
      Effect.gen(function* () {
        const event = yield* decodeOrDie("event.read", () => decodeEvent(entry.value));
        const current = yield* readRecord(out.view(), event.seq);
        replayed += 1;
        if (current !== undefined && current.version >= event.version) return;
        yield* applyEffects(into(), current, event, keys.positionOf(entry.key));
        if (out.size() >= SEAL_BATCH) yield* out.flush;
      }));
    // Counted from nothing, so the counters are what the replay produced.
    out.view().put(keys.meta(META_RECORDS), u64Bytes(counters.records));
    out.view().put(keys.meta(META_BYTES), u64Bytes(counters.bytes));
    out.view().put(keys.meta(META_SEALED), u64Bytes(0));
    out.view().put(keys.meta(META_SWEPT), u64Bytes(0));
    out.view().put(keys.meta(META_LENSES), u64Bytes(LENSES_READY));
    yield* out.flush;
    lenses = LENSES_READY;
    return restored + replayed;
  }));

  /**
   * Write the live records down as of a position, replacing the earlier
   * snapshot, without stopping the writer.
   *
   * The records are copied under a new snapshot id while writes carry on, then
   * the events logged since the copy began are applied to the copy by version:
   * the copy is then the partition as of the last of them, which is the
   * position it records. Only flipping to the new id takes the writer, so an
   * interrupted snapshot leaves the old one in force and its own half under an
   * id nothing names, which the next snapshot clears first.
   */
  const snapshot = Effect.gen(function* () {
    yield* lensesReady;
    const current = yield* readMeta(META_SNAPSHOT_ID);
    const id = current + 1;
    const stale = keys.snapshotPrefix(current);
    // Whatever an interrupted snapshot left under an id nothing names: every
    // snapshot key before the current id's range, and every one after it.
    const clearRange = (options: KvScanOptions) =>
      Effect.gen(function* () {
        for (;;) {
          const chunk = [...(yield* Stream.runCollect(engine.scan(keys.tag(Tag.Snapshot), { ...options, limit: SEAL_BATCH })))];
          if (chunk.length === 0) return;
          yield* exclusive(write(chunk.map((entry): KvWrite => ({ op: "delete", key: new Uint8Array(entry.key) }))));
        }
      });
    if (current === 0) {
      yield* clearRange({});
    } else {
      yield* clearRange({ to: stale });
      const after = prefixEnd(stale);
      if (after !== undefined) yield* clearRange({ from: after });
    }

    const mark = yield* readMeta(META_HEAD);
    let pending = new Map<string, KvWrite>();
    let records = 0;
    const flush = Effect.gen(function* () {
      if (pending.size === 0) return;
      const writes = [...pending.values()];
      pending = new Map<string, KvWrite>();
      yield* exclusive(write(writes));
    });
    yield* inChunks(keys.tag(Tag.Record), undefined, (entry) =>
      Effect.gen(function* () {
        if ((entry.value[0]! & 0x01) !== 0) return;
        pendingView(pending).put(keys.snapshot(id, seqOf(entry.key)), entry.value);
        records += 1;
        if (pending.size >= SEAL_BATCH) yield* flush;
      }));
    yield* flush;

    let position = mark;
    yield* inChunks(keys.tag(Tag.Event), keys.event(mark + 1), (entry) =>
      Effect.gen(function* () {
        const event = yield* decodeOrDie("event.read", () => decodeEvent(entry.value));
        const view = pendingView(pending);
        const key = keys.snapshot(id, event.seq);
        const held = yield* view.get(key);
        const heldVersion = held === undefined ? 0 : (yield* decodeOrDie("snapshot.read", () => decodeRecord(held))).version;
        position = keys.positionOf(entry.key);
        if (event.version <= heldVersion) return;
        if (event.kind === "put") {
          view.put(key, encodeRecord({
            live: true,
            version: event.version,
            ...(event.identity === undefined ? {} : { identity: event.identity }),
            manifest: event.manifest,
            body: event.body,
          }));
          if (held === undefined) records += 1;
        } else if (held !== undefined) {
          view.del(key);
          records -= 1;
        }
        if (pending.size >= SEAL_BATCH) yield* flush;
      }));
    yield* flush;

    yield* exclusive(Effect.gen(function* () {
      // A compaction past where the copy began would have taken events the
      // copy needed; the snapshot is refused rather than recorded short.
      if ((yield* readMeta(META_COMPACTED_TO)) > mark) {
        return yield* new StoreError({ op: "snapshot", cause: "the log was compacted while the snapshot was taken; take it again" });
      }
      yield* write([
        { op: "put", key: keys.meta(META_SNAPSHOT_ID), value: u64Bytes(id) },
        { op: "put", key: keys.meta(META_SNAPSHOT_AT), value: u64Bytes(position) },
      ]);
    }));

    if (current > 0) {
      for (;;) {
        const chunk = [...(yield* Stream.runCollect(engine.scan(stale, { limit: SEAL_BATCH })))];
        if (chunk.length === 0) break;
        yield* exclusive(write(chunk.map((entry): KvWrite => ({ op: "delete", key: new Uint8Array(entry.key) }))));
      }
    }
    return { records, position };
  });

  /** Finish a rebuild or reindex an interrupted process left marked, and say which it was. */
  const resumeMaintenance = Effect.gen(function* () {
    const state = yield* readMeta(META_LENSES);
    lenses = state;
    if (state === LENSES_REBUILDING) {
      yield* rebuildLenses;
      return "rebuild" as const;
    }
    if (state === LENSES_REINDEXING) {
      yield* reindexLenses;
      return "reindex" as const;
    }
    return undefined;
  });

  /**
   * Remove the whole partition in bounded batches.
   *
   * The revision goes last: every batch before it is checked against it, so
   * an owner fenced halfway stops there rather than deleting under a new one.
   */
  const removeAll = Effect.gen(function* () {
    const records = yield* readMeta(META_RECORDS);
    const kept = keyId(revisionKey);
    // One more than a batch per scan, so a scan that returns only the revision
    // has nothing else left to find.
    for (;;) {
      const chunk = [...(yield* Stream.runCollect(engine.scan(keys.prefix, { limit: SEAL_BATCH + 1 })))]
        .map((entry) => new Uint8Array(entry.key))
        .filter((key) => keyId(key) !== kept);
      if (chunk.length === 0) break;
      yield* write(chunk.map((key): KvWrite => ({ op: "delete", key })));
    }
    lenses = LENSES_READY;
    if (engine.conditionalWrite === undefined) {
      return yield* new StoreError({ op: "store.write", cause: "Engine has no conditional commit" });
    }
    const accepted = yield* engine.conditionalWrite([{ op: "delete", key: revisionKey }], conditions())
      .pipe(Effect.onError(() => Effect.sync(forget)));
    if (!accepted) {
      forget();
      yield* assertCurrent;
      return yield* new StoreError({ op: "store.conflict", cause: "Partition changed while it was being removed" });
    }
    revision = undefined;
    fence = null;
    return records;
  });

  const drop = exclusive(removeAll);

  /**
   * Record the map version that moved the partition away, then remove it.
   *
   * The version goes first, in a batch of its own checked like any other, so
   * there is no moment when the partition is partly removed and a call routed
   * by an older map would still be answered from it. It only ever rises: a
   * version no higher than the one held is already covered by it.
   */
  const relocate = (mapVersion: number) => exclusive(Effect.gen(function* () {
    if (!Number.isSafeInteger(mapVersion) || mapVersion < 1) {
      return yield* new StoreError({ op: "relocate", cause: `Map version ${mapVersion} is not a positive integer` });
    }
    const bytes = yield* raw.get(relocationKey);
    const stored = yield* decodeOrDie("relocation.read", () => counterOf(bytes));
    if (mapVersion > stored) {
      yield* write([{ op: "put", key: relocationKey, value: u64Bytes(mapVersion) }]);
    }
    relocatedAt = Math.max(mapVersion, stored);
    return yield* removeAll;
  }));

  const stats: Effect.Effect<PartitionStats, StoreError> = Effect.map(Effect.all({
    records: readMeta(META_RECORDS),
    bytes: readMeta(META_BYTES),
    head: readMeta(META_HEAD),
    compactedTo: readMeta(META_COMPACTED_TO),
    nextSeq: readMeta(META_NEXT_SEQ),
    seeding: Effect.map(readMeta(META_SEEDING), (state) => state > 0),
    incarnation: Effect.map(engine.get(incarnationKey), (bytes) => bytes === undefined ? undefined : toHex(bytes)),
  }), ({ incarnation, ...counted }) => incarnation === undefined ? counted : { ...counted, incarnation });

  const records = Stream.mapEffect(engine.scan(keys.tag(Tag.Record)), (entry) =>
    // Copied first: an engine may hand back a view of a buffer it reuses, and
    // the record outlives this step of the stream.
    Effect.map(decodeOrDie("record.read", () => decodeRecord(new Uint8Array(entry.value))), (record) =>
      ({ seq: asSeq(seqOf(entry.key)), record: record as RecordState })));

  /**
   * Fill this empty partition from a source partition, in bounded batches.
   *
   * The records are copied while the source keeps taking writes, so they are
   * not one moment; what makes the copy exact is what follows it. The log is
   * set at the source's compaction point as read before the copy began, and
   * every source event from there is then applied by `followAll`, by version:
   * an event older than the record copied changes nothing, and a newer one
   * brings it forward. A record is one value, so no copy of one is torn, and an
   * identifier is never reused, so nothing copied can be mistaken for something
   * else.
   *
   * The first batch marks the partition as being seeded and the last clears
   * the mark with the head, so a seed cut off between them is told apart from
   * a finished one (`stats.seeding`): the first must be copied again, the
   * second carried on from its head.
   *
   * Where the source has compacted, this partition's log will begin past its
   * start too, and `rebuildLenses` needs a snapshot covering what is missing.
   * The copy is that snapshot: records read from the compaction point on, which
   * the log after it, applied by version, brings to any later moment — the
   * same rule the copy itself relies on. So each live record copied is also
   * written as the first snapshot, recorded at the compaction point in the
   * batch that clears the mark; a seed cut off before then is copied again
   * whole, snapshot included.
   */
  const seed = (source: ObjectStoreApi): Effect.Effect<SeedResult, DbError | TenantNotEmpty> =>
    exclusiveWrite(Effect.gen(function* () {
      const held = [...(yield* Stream.runCollect(engine.scan(keys.prefix, { limit: 2 })))]
        .filter((entry) => compareKeys(entry.key, revisionKey) !== 0);
      if (held.length > 0) return yield* new TenantNotEmpty({ tenant: partition });

      const start = yield* source.stats;
      const snapshotted = start.compactedTo > 0;
      const counters: Counters = { records: 0, bytes: 0 };
      let pending = new Map<string, KvWrite>();
      let into: Projection = { view: pendingView(pending), sealed: false, counters };
      into.view.put(keys.meta(META_SEEDING), u64Bytes(1));
      // A copy is the same life of the partition, so it keeps the source's name for it.
      if (start.incarnation !== undefined) into.view.put(incarnationKey, fromHex(start.incarnation));
      let copied = 0;
      let highest = 0;
      const flush = Effect.gen(function* () {
        if (pending.size === 0) return;
        into.view.put(keys.meta(META_RECORDS), u64Bytes(counters.records));
        into.view.put(keys.meta(META_BYTES), u64Bytes(counters.bytes));
        yield* write([...pending.values()]);
        pending = new Map<string, KvWrite>();
        into = { view: pendingView(pending), sealed: false, counters };
      });

      yield* Stream.runForEach(source.records, ({ seq, record }) =>
        Effect.gen(function* () {
          if (record.live) yield* project(into, seq, undefined, record);
          else yield* retire(into, seq, undefined, record.version, record.retiredAt);
          if (record.live && snapshotted) into.view.put(keys.snapshot(SEED_SNAPSHOT_ID, seq), encodeRecord(record));
          copied += 1;
          highest = Math.max(highest, seq);
          if (pending.size >= SEAL_BATCH) yield* flush;
        }));

      const end = yield* source.stats;
      into.view.put(keys.meta(META_HEAD), u64Bytes(start.compactedTo));
      into.view.put(keys.meta(META_COMPACTED_TO), u64Bytes(start.compactedTo));
      into.view.put(keys.meta(META_NEXT_SEQ), u64Bytes(Math.max(end.nextSeq, highest)));
      if (snapshotted) {
        into.view.put(keys.meta(META_SNAPSHOT_ID), u64Bytes(SEED_SNAPSHOT_ID));
        into.view.put(keys.meta(META_SNAPSHOT_AT), u64Bytes(start.compactedTo));
      }
      into.view.del(keys.meta(META_SEEDING));
      yield* flush;
      return { records: copied, head: start.compactedTo };
    }));

  const api: ObjectStoreApi = {
    partition,
    generation,
    stats,
    records: Stream.unwrap(Effect.as(lensesReady, records)),
    scanRecords: ({ after, limit }) =>
      ready(Effect.gen(function* () {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEAL_BATCH) {
          return yield* Effect.die(new RangeError(`scanRecords limit ${limit} is outside 1..${SEAL_BATCH}`));
        }
        if (after !== undefined && after >= MAX_SEQ) return [];
        const page = engine.scan(keys.tag(Tag.Record), {
          ...(after === undefined ? {} : { from: keys.record(after + 1) }),
          limit,
        });
        return [...(yield* Stream.runCollect(Stream.mapEffect(page, (entry) =>
          Effect.map(decodeOrDie("record.read", () => decodeRecord(new Uint8Array(entry.value))), (record) =>
            ({ seq: asSeq(seqOf(entry.key)), record: record as RecordState })))))];
      })),
    seed: (source) => live(seed(source)),
    events,

    reading: (effect) =>
      Effect.flatMap(Effect.service(ReadSnapshots), (taken) =>
        taken.has(raw)
          ? effect
          : Effect.scoped(Effect.flatMap(raw.snapshot, (reader) =>
              Effect.provideService(effect, ReadSnapshots, new Map(taken).set(raw, reader))))),

    rebuildLenses: live(rebuildLenses),

    snapshot: live(snapshot),

    snapshotAt: readMeta(META_SNAPSHOT_AT),

    reindexLenses: live(reindexLenses),

    resumeMaintenance: live(resumeMaintenance),

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
     * have needed rather than skipping one it did. Each blob is written before
     * the live keys it absorbed and the tombstones it settled are deleted, in
     * batches of bounded size, so an interrupted seal leaves postings in both
     * tiers at worst — which the read already handles, because it reads both —
     * and never a tombstone gone while its blob still claims the posting. And
     * the additions land before the removals are read: both passes can touch
     * one segment, so a removal that read the blob as it was before the
     * additions would write back a blob missing them.
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
    sealPostings: live(exclusiveReady(Effect.gen(function* () {
      const swept = (yield* readMeta(META_SWEPT)) > 0;
      // Written before the first blob, so a removal arriving mid-seal writes a
      // tombstone it might not have needed rather than skipping one it did.
      yield* write([{ op: "put", key: keys.meta(META_SEALED), value: u64Bytes(1) }]);
      let examined = 0;

      const buffer = new SegmentBuffer();
      let batch: KvWrite[] = [];
      let segments = 0;
      let postings = 0;
      let openPrefix: Uint8Array | undefined;
      let openSegment = -1;
      // The live keys gathered into the open segment, deleted only if it seals.
      const gathered: Array<Uint8Array> = [];
      // Keys the open segment's blob settles once it is written: tombstones it
      // stops claiming, and the dirty mark that sent the seal to it.
      const settled: Array<Uint8Array> = [];
      let hadBlob = false;

      /** One more write, committing the batch whenever it is full. */
      const push = (entry: KvWrite) =>
        Effect.gen(function* () {
          batch.push(entry);
          if (batch.length >= SEAL_BATCH) {
            yield* write(batch);
            batch = [];
          }
        });

      /**
       * Write back the segment the buffer holds, then delete what it settles.
       *
       * The blob always goes first, so a batch can be cut anywhere after it: a
       * live key whose posting the blob now carries is in both tiers until its
       * deletion lands, which a read already handles, and a tombstone outlives
       * the blob bit it cancels, never the other way round. One segment's ids
       * are written once, whole — a blob written in two halves under one key
       * would keep only the second.
       *
       * A segment that ends up empty has its blob deleted rather than written
       * as an empty one, so a lens emptied by retractions costs nothing rather
       * than a key per segment it once spanned.
       */
      const flush = Effect.gen(function* () {
        if (openPrefix === undefined) return;
        const prefix = openPrefix;
        const segment = openSegment;
        openPrefix = undefined;
        openSegment = -1;
        if (!hadBlob && buffer.size < MIN_SEALED_POSTINGS) {
          // Too few to be worth a blob: they stay live keys, which a scan
          // reads directly. A blob for one or two postings still costs a key
          // of its own, and a decode on every read that passes it. A tombstone
          // for a blob that does not exist clears nothing and goes all the same.
          gathered.length = 0;
          for (const key of settled) yield* push({ op: "delete", key });
          settled.length = 0;
          return;
        }
        const key = keys.segment(prefix, segment);
        if (buffer.size === 0) {
          yield* push({ op: "delete", key });
        } else {
          const base = segment * SEGMENT_SPAN;
          yield* push({ op: "put", key, value: encodeSegment(buffer.ids(base), base) });
          segments += 1;
          postings += buffer.size;
        }
        for (const live of gathered) yield* push({ op: "delete", key: live });
        for (const done of settled) yield* push({ op: "delete", key: done });
        gathered.length = 0;
        settled.length = 0;
      });

      /**
       * Move to the segment a posting key belongs to, loading its blob.
       *
       * Every posting key ends in the identifier it records, so what precedes
       * it is the lens — the same slice for terms, columns and edges alike.
       */
      const openFor = (key: Uint8Array, id: number) =>
        Effect.gen(function* () {
          const prefix = key.subarray(0, key.length - SEQ_BYTES);
          const segment = segmentOf(id);
          if (openPrefix !== undefined
            && segment === openSegment
            && compareKeys(prefix, openPrefix) === 0) return;

          yield* flush;
          openPrefix = Uint8Array.from(prefix);
          openSegment = segment;
          buffer.reset();
          const existing = yield* engine.get(keys.segment(openPrefix, segment));
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
          yield* Stream.runForEach(engine.scan(keys.tag(tag)), (entry) => take(entry.key));
          yield* flush;
        }
      } else {
        // Only the groups written since the last seal. Each mark is cleared
        // after its group's blob, so an interrupted seal redoes exactly the
        // groups it did not finish.
        const marks = [...(yield* Stream.runCollect(engine.scan(keys.tag(Tag.Dirty))))]
          .map((entry) => new Uint8Array(entry.key));
        for (const mark of marks) {
          const { livePrefix, segment } = keys.liveOfDirty(mark);
          const base = segment * SEGMENT_SPAN;
          const at = (seq: number) => {
            const key = new Uint8Array(livePrefix.length + SEQ_BYTES);
            key.set(livePrefix);
            key.set(seqBytes(seq), livePrefix.length);
            return key;
          };
          const to = base + SEGMENT_SPAN > MAX_SEQ ? undefined : at(base + SEGMENT_SPAN);
          yield* Stream.runForEach(
            engine.scan(livePrefix, scanOptions(at(base), to, false)),
            (entry) => take(entry.key),
          );
          if (openPrefix !== undefined && openSegment === segment && compareKeys(openPrefix, livePrefix) === 0) {
            settled.push(mark);
          } else {
            yield* push({ op: "delete", key: mark });
          }
        }
        yield* flush;
      }
      // Both passes can reach the same segment, and pass two rewrites whatever
      // it reads — so pass one's blobs have to have landed, or the additions
      // they carry are dropped by the write that follows.
      if (batch.length > 0) {
        yield* write(batch);
        batch = [];
      }

      // Tombstones clear bits the blobs still claim, and go once the blob that
      // no longer claims them is written.
      yield* Stream.runForEach(engine.scan(keys.tag(Tag.Tombstone)), (entry) =>
        Effect.gen(function* () {
          const posting = keys.liveOfTombstone(entry.key);
          const id = seqOf(posting);
          yield* openFor(posting, id);
          buffer.remove(id % SEGMENT_SPAN);
          settled.push(new Uint8Array(entry.key));
        }));
      yield* flush;

      if (!swept) {
        // A sweep covers every mark written since the partition was sealed,
        // and it is only a sweep once it has finished: the flag goes last.
        const marks = [...(yield* Stream.runCollect(engine.scan(keys.tag(Tag.Dirty))))];
        for (const entry of marks) yield* push({ op: "delete", key: new Uint8Array(entry.key) });
        yield* push({ op: "put", key: keys.meta(META_SWEPT), value: u64Bytes(1) });
      }
      if (batch.length > 0) yield* write(batch);
      return { segments, postings, examined };
    }))),

    /**
     * Drop history that no longer describes anything reachable.
     *
     * Storage grows with writes rather than with live objects: a record updated
     * ten times keeps ten events forever, so a busy tenant outgrows memory on
     * history rather than on size. Compaction removes that, and the state left
     * behind is complete — every record, its manifest and its name — so nothing
     * a query or a reindex needs is in the part being removed.
     *
     * What is lost is the ability to replay from before the cut, which is why
     * cursors older than it are rejected rather than quietly continued. The
     * mark moves first, so from that moment a cursor before the cut is refused
     * rather than answered from a log with a hole in it; the events then go in
     * bounded batches, and an interrupted pass leaves only events behind the
     * mark, which the next pass finds and removes. Retired records whose
     * retraction is now behind the cut go too: nothing can replay an older
     * event for them any more.
     */
    compact: (options) =>
      exclusiveReady(Effect.gen(function* () {
        const keep = options?.keep ?? 0;
        if (!Number.isSafeInteger(keep) || keep < 0) {
          return yield* new StoreError({ op: "compact", cause: `keep must be a non-negative integer, not ${keep}` });
        }
        const head = yield* readMeta(META_HEAD);
        const compactedTo = yield* readMeta(META_COMPACTED_TO);
        const cut = head - keep;
        if (cut <= compactedTo) return { removed: 0, compactedTo };
        yield* write([{ op: "put", key: keys.meta(META_COMPACTED_TO), value: u64Bytes(cut) }]);

        let removed = 0;
        for (;;) {
          const chunk = [...(yield* Stream.runCollect(
            engine.scan(keys.tag(Tag.Event), { to: keys.event(cut + 1), limit: SEAL_BATCH }),
          ))];
          if (chunk.length === 0) break;
          yield* write(chunk.map((entry): KvWrite => ({ op: "delete", key: new Uint8Array(entry.key) })));
          removed += chunk.length;
        }

        for (;;) {
          const chunk = [...(yield* Stream.runCollect(
            engine.scan(keys.tag(Tag.Retired), { to: keys.retiredAfter(cut), limit: SEAL_BATCH }),
          ))];
          if (chunk.length === 0) break;
          const writes: KvWrite[] = [];
          for (const entry of chunk) {
            const seq = seqOf(entry.key);
            const record = yield* readRecord(pendingView(new Map()), seq);
            if (record !== undefined && !record.live && record.retiredAt <= cut) {
              writes.push({ op: "delete", key: keys.record(seq) });
            }
            writes.push({ op: "delete", key: new Uint8Array(entry.key) });
          }
          yield* write(writes);
        }
        return { removed, compactedTo: cut };
      })),

    compactedTo: readMeta(META_COMPACTED_TO),

    liveRecords: ready(liveRecords),
    manifestOf: (seq) => ready(manifestOf(seq)),

    lookup: (namespace, key) =>
      Effect.flatMap(Effect.andThen(lensesReady, engine.get(keys.identity(namespace, key))), (bytes) =>
        bytes === undefined
          ? Effect.succeed(undefined)
          : bytes.length === SEQ_BYTES
            ? Effect.succeed(asSeq(readSeqAt(bytes, 0)))
            : Effect.fail(new StoreError({ op: "identity.read", cause: "an identity names no identifier" }))),

    identityOf: (seq) =>
      Effect.map(ready(readRecord(pendingView(new Map()), seq)), (record) =>
        record?.live === true ? record.identity : undefined),

    scanIdentities: (input) =>
      Effect.gen(function* () {
        yield* lensesReady;
        const limit = input.limit ?? 100;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
          return yield* new StoreError({
            op: "identity.scan",
            cause: `limit must be an integer from 1 to 1000, not ${String(limit)}`,
          });
        }
        const prefix = input.prefix === undefined
          ? keys.identityPrefix(input.namespace)
          : keys.identityNamePrefix(input.namespace, input.prefix);
        const lower = input.lower === undefined ? undefined : keys.identity(input.namespace, input.lower);
        const upper = input.upper === undefined ? undefined : keys.identity(input.namespace, input.upper);
        const after = input.after === undefined ? undefined : keys.identity(input.namespace, input.after);
        // Ascending scans resume *at* the last identity and discard it below;
        // descending scans can use the engine's exclusive upper bound directly.
        // Binding the cursor into the physical range avoids rescanning the first
        // page forever when a namespace contains more than `limit` identities.
        const from = input.direction === "desc" || after === undefined
          ? lower
          : lower === undefined || compareKeys(after, lower) > 0 ? after : lower;
        const to = input.direction !== "desc" || after === undefined
          ? upper
          : upper === undefined || compareKeys(after, upper) < 0 ? after : upper;
        const entries = yield* Stream.runCollect(engine.scan(prefix, {
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          ...(input.direction === "desc" ? { reverse: true } : {}),
          // One extra may be consumed while excluding `after`.
          limit: Math.min(1001, limit + (input.after === undefined ? 0 : 1)),
        }));
        const out: Array<{ readonly key: string; readonly seq: Seq }> = [];
        for (const entry of entries) {
          const decoded = keys.decodeIdentity(entry.key);
          if (decoded.namespace !== input.namespace || decoded.key === input.after) continue;
          out.push({ key: decoded.key, seq: asSeq(readSeqAt(entry.value, 0)) });
          if (out.length === limit) break;
        }
        return out;
      }),

    reserve: (upTo) =>
      exclusiveWrite(Effect.gen(function* () {
        if (upTo > MAX_SEQ) return yield* new PartitionExhausted({ partition, resource: "identifiers", limit: MAX_SEQ });
        if (upTo <= (yield* readMeta(META_NEXT_SEQ))) return;
        yield* write([{ op: "put", key: keys.meta(META_NEXT_SEQ), value: u64Bytes(upTo) }]);
      })),

    nextSeq: exclusiveWrite(Effect.gen(function* () {
      const next = (yield* readMeta(META_NEXT_SEQ)) + 1;
      if (next > MAX_SEQ) return yield* new PartitionExhausted({ partition, resource: "identifiers", limit: MAX_SEQ });
      yield* write([{ op: "put", key: keys.meta(META_NEXT_SEQ), value: u64Bytes(next) }]);
      return asSeq(next);
    })),

    transact: (f) => commit((into) => f(txnFor(into))),

    fence: (move) =>
      exclusive(Effect.gen(function* () {
        yield* write([{ op: "put", key: keys.meta(META_FENCE), value: encodeFence(move) }]);
        fence = { from: move.from, to: move.to };
      })),

    writable: unfenced,

    read: (seq) =>
      Effect.map(ready(readRecord(pendingView(new Map()), seq)), (record) =>
        record?.live === true ? { seq, version: record.version, bytes: record.body } : undefined),

    resolve: (query, options) => {
      if (options === undefined) {
        return Stream.fromIterableEffect(Effect.map(ready(resolveSet(query)), Postings.iterate));
      }
      const page = resolveAfter(query, options.after === undefined ? undefined : Number(options.after), options.within);
      return options.limit === undefined ? page : Stream.take(page, options.limit);
    },

    ordered: (input) => ready(readOrdered(input)),

    extent: (column, where) =>
      Effect.gen(function* () {
        yield* lensesReady;
        // Everything before the null run: null sorts last and is not a value.
        const beforeNull = keys.orderedKindRange(column, null).start;
        const filter = yield* rowFilterFor(where);
        const end = (reverse: boolean) =>
          Effect.map(
            mergeOrdered({
              column, from: undefined, to: beforeNull,
              sealedFrom: undefined, sealedTo: keys.segmentPrefix(beforeNull),
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
        yield* lensesReady;
        const out = new Map<number, number>();
        yield* Stream.runForEach(engine.scan(keys.measurePrefix(column)), (entry) =>
          Effect.sync(() => {
            out.set(seqOf(entry.key), readF64(entry.value));
          }));
        return out;
      }),

    /**
     * The words a field holds a posting for.
     *
     * A live key is a live posting, so every word with one is listed. A word
     * known only to sealed blobs is listed when some blob posting survives that
     * word's own tombstones: a blob cannot be edited, so a word whose every
     * document has since lost it would otherwise be listed for as long as the
     * blob lasts — and offered to fuzzy search as a candidate matching nothing.
     */
    terms: (field, prefix = "") =>
      Effect.gen(function* () {
        yield* lensesReady;
        const startKey = keys.termPrefixKey(field, prefix);
        type TermKey = { readonly field: string; readonly term: string };
        const wanted = (parsed: TermKey | undefined): parsed is TermKey =>
          parsed !== undefined && parsed.field === field && parsed.term.startsWith(prefix);

        const terms = new Set<string>();
        yield* Stream.runForEach(engine.scan(startKey), (entry) =>
          Effect.sync(() => {
            const parsed = keys.readTermKey(entry.key);
            if (wanted(parsed)) terms.add(parsed.term);
          }));

        // Tombstones exist only beside sealed postings, keyed by the posting
        // they cancel, so each word's own are gathered before its blobs.
        const removed = new Map<string, Postings.PostingsBuilder>();
        yield* Stream.runForEach(engine.scan(keys.tombstonePrefix(startKey)), (entry) =>
          Effect.sync(() => {
            const posting = keys.liveOfTombstone(entry.key);
            const parsed = keys.readTermKey(posting);
            if (!wanted(parsed) || terms.has(parsed.term)) return;
            let builder = removed.get(parsed.term);
            if (builder === undefined) {
              builder = new Postings.PostingsBuilder();
              removed.set(parsed.term, builder);
            }
            builder.add(seqOf(posting));
          }));

        // Blobs come in key order, word then segment, so each word's run
        // arrives together and is judged once it is complete.
        let word: string | undefined;
        let segments: number[] = [];
        let containers: Postings.Container[] = [];
        const close = () => {
          if (word !== undefined && !terms.has(word)) {
            const blobs: Postings.Postings = { segments, containers };
            const gone = removed.get(word);
            if (Postings.size(gone === undefined ? blobs : Postings.andNot(blobs, gone.build())) > 0) terms.add(word);
          }
          segments = [];
          containers = [];
        };
        yield* Stream.runForEach(engine.scan(keys.segmentPrefix(startKey)), (entry) =>
          Effect.sync(() => {
            const parsed = keys.readTermKey(entry.key);
            if (!wanted(parsed)) return;
            if (parsed.term !== word) {
              close();
              word = parsed.term;
            }
            const container = containerOf(entry.value);
            if (container === undefined) return;
            segments.push(keys.segmentIndexOf(entry.key));
            containers.push(container);
          }));
        close();
        return [...terms].sort();
      }),
  };

  return { api: routedOnly(api, routable), drop, relocate };
};

/**
 * `api` with `check` run before every operation it offers — each effect,
 * stream, and function returning one, through nested objects — so a call a
 * router sent by a stale map is refused whichever door it came through.
 */
const routedOnly = (api: ObjectStoreApi, check: Effect.Effect<void, DbError>): ObjectStoreApi => {
  const wrap = (value: unknown): unknown => {
    if (Stream.isStream(value)) return Stream.unwrap(Effect.as(check, value));
    if (Effect.isEffect(value)) return Effect.andThen(check, value);
    if (typeof value === "function") {
      return (...args: ReadonlyArray<unknown>) => wrap((value as (...input: ReadonlyArray<unknown>) => unknown)(...args));
    }
    if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value).map(([name, member]) => [name, wrap(member)]));
    }
    return value;
  };
  return wrap(api) as ObjectStoreApi;
};

/**
 * The shard over an ordered key-value engine: the writer claim it holds, and
 * a handle for each partition that has been asked for.
 *
 * Takes a claim already made, which is what lets a caller hold a claim that
 * is no longer current; `openShardOverKv` is the way to open one for use.
 */
export const shardOverKv = (
  shard: ShardId,
  engine: KvEngine,
  claim: WriterClaim,
  options?: OpenShardOptions,
): ShardStoreApi => {
  const context: ShardContext = {
    shard, engine, claim,
    origin: options?.origin ?? "local",
    probeCap: options?.probeCap ?? PROBE_CAP,
  };
  const handles = new Map<PartitionKey, ReturnType<typeof openPartition>>();
  const handleOf = (partition: PartitionKey) => {
    let handle = handles.get(partition);
    if (handle === undefined) {
      handle = openPartition(context, partition);
      handles.set(partition, handle);
    }
    return handle;
  };

  return {
    shard: context.shard,
    generation: context.claim.generation,
    partition: (partition) => handleOf(partition).api,

    /**
     * Every partition with a key here, found by seeking from one partition's
     * range to the next. One read per partition, and nothing to keep in step:
     * a partition is listed exactly while it holds something.
     */
    partitions: Effect.gen(function* () {
      const out: PartitionKey[] = [];
      let from: Uint8Array | undefined;
      for (;;) {
        const first = [...(yield* Stream.runCollect(
          context.engine.scan(partitionSpace(), { ...(from === undefined ? {} : { from }), limit: 1 }),
        ))][0];
        if (first === undefined) break;
        const partition = partitionOf(first.key);
        out.push(partition);
        const end = prefixEnd(partitionPrefix(partition));
        if (end === undefined) break;
        from = end;
      }
      return out;
    }),

    drop: (partition) => handleOf(partition).drop,

    relocate: (partition, mapVersion) => handleOf(partition).relocate(mapVersion),
  };
};

export interface OpenShardOptions {
  /** The node recorded as the writer of every event this shard accepts. */
  readonly origin?: string;
  /**
   * How many postings one clause of a query may read before it is treated as
   * broad and checked per candidate instead (see `evaluateBounded`). 4096
   * unless given.
   */
  readonly probeCap?: number;
}

/**
 * Open a shard over an engine: claim the writer generation and mark a fresh
 * engine with the layout it holds.
 *
 * An engine written by another layout is refused, not upgraded. Nothing
 * carries compatibility for old data; recreate the database.
 */
export const openShardOverKv = (
  shard: ShardId,
  engine: KvEngine,
  options?: OpenShardOptions,
): Effect.Effect<ShardStoreApi, StoreError> =>
  Effect.gen(function* () {
    const claim = yield* claimGeneration(engine);
    const formatKey = shardMetaKey(SHARD_FORMAT);
    const format = yield* engine.get(formatKey);
    if (format === undefined) {
      // Anything beyond the claim just written means another layout's data.
      const held = yield* Stream.runCollect(
        engine.scan(new Uint8Array(0), { from: Uint8Array.of(0x01), limit: 1 }),
      );
      if ([...held].length > 0) {
        return yield* new StoreError({
          op: "format.open",
          cause: "This store was written by another layout, which is not supported. Recreate the database.",
        });
      }
      const accepted = yield* engine.conditionalWrite!([
        { op: "put", key: formatKey, value: u64Bytes(CURRENT_FORMAT) },
      ], [
        { key: shardMetaKey(SHARD_GENERATION), value: u64Bytes(claim.generation) },
        { key: shardMetaKey(SHARD_OWNER), value: claim.session },
        { key: formatKey, value: undefined },
      ]);
      if (!accepted) return yield* new StoreError({ op: "format.open", cause: "Writer or format changed while marking the store" });
    } else if (format.length !== 8 || readU64At(format, 0) !== CURRENT_FORMAT) {
      return yield* new StoreError({
        op: "format.open",
        cause: "This store was written by another layout, which is not supported. Recreate the database.",
      });
    }
    return shardOverKv(shard, engine, claim, options);
  });

/** Trusted shard activation; this is not root Fabric takeover authority. */
export const claimGeneration = Effect.fn("store.claimGeneration")(function*(engine: KvEngine): Effect.fn.Return<WriterClaim, StoreError> {
  if (engine.conditionalWrite === undefined || engine.coordination === undefined) {
    return yield* new StoreError({ op: "generation.claim", cause: "Engine cannot enforce conditional commits" });
  }
  const session = encoder.encode(crypto.randomUUID());
  const generationKey = shardMetaKey(SHARD_GENERATION);
  for (let attempt = 0; attempt < 32; attempt++) {
    const current = yield* engine.get(generationKey);
    const generation = yield* Effect.try({
      try: () => {
        const previous = counterOf(current);
        if (previous === Number.MAX_SAFE_INTEGER) throw new Error("Writer generation exhausted");
        return previous + 1;
      },
      catch: (cause) => new StoreError({ op: "generation.claim", cause }),
    });
    const accepted = yield* engine.conditionalWrite([
      { op: "put", key: generationKey, value: u64Bytes(generation) },
      { op: "put", key: shardMetaKey(SHARD_OWNER), value: session },
    ], [{ key: generationKey, value: current }]);
    if (accepted) return { generation, session };
  }
  return yield* new StoreError({ op: "generation.claim", cause: "Writer acquisition conflict limit exceeded" });
});
