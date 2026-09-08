import { Effect, Stream } from "effect";
import { CursorCompacted, ForeignCursor, LogCompacted, StoreError, WriterFenced } from "./errors.js";
import type { AppliedEvent, DbEvent, EventCursor } from "./events.js";
import {
  columnKey, columnPrefix, edgeKey, edgePrefix, eventKey, eventPrefix,
  identityBySeqKey, identityKey, manifestKey, measureKey, measurePrefix,
  metaKey, payloadKey, positionOf, seqOf, Tag, termKey, termPrefix,
} from "./keys.js";
import type { KvEngine, KvWrite } from "./kv.js";
import {
  asSeq, type IndexManifest, type ObjectIdentity, type PartitionKey, type Seq,
} from "./model.js";
import * as Postings from "./postings.js";
import type { Query } from "./query.js";
import type { EventsApi, ObjectStoreApi, Txn } from "./store.js";

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
 * What a rebuild drops and re-derives.
 *
 * Postings hold nothing a manifest does not already say, so they can be
 * reconstructed from state alone. That is what makes compaction possible: the
 * payloads, manifests and identities are already a snapshot, so the log is
 * history rather than the only way back to a working index.
 */
const DERIVED_TAGS = [Tag.Term, Tag.Column, Tag.Measure, Tag.Edge] as const;

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

  const unproject = (view: View, seq: Seq) =>
    Effect.gen(function* () {
      const stored = yield* view.get(manifestKey(seq));
      if (stored === undefined) return;
      const manifest = unjson<IndexManifest>(stored);
      for (const [field, term] of manifest.terms) view.del(termKey(field, term, seq));
      for (const [column, value] of manifest.columns) view.del(columnKey(column, value, seq));
      for (const [column] of manifest.measures) view.del(measureKey(column, seq));
      for (const [edgeType, to] of manifest.edges) view.del(edgeKey(edgeType, seq, to));
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
    identity?: ObjectIdentity,
  ) =>
    Effect.gen(function* () {
      yield* unproject(view, seq);
      view.put(payloadKey(seq), encodePayload(version, body));
      // A posting is a key with no value: the key itself is the fact.
      for (const [field, term] of manifest.terms) view.put(termKey(field, term, seq), EMPTY);
      for (const [column, value] of manifest.columns) view.put(columnKey(column, value, seq), EMPTY);
      for (const [column, value] of manifest.measures) view.put(measureKey(column, seq), f64(value));
      for (const [edgeType, to] of manifest.edges) view.put(edgeKey(edgeType, seq, to), EMPTY);
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
    Effect.gen(function* () {
      const pending = new Map<string, KvWrite>();
      const view = pendingView(pending);
      let position = yield* readMeta(META_NEXT_POSITION);

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
            yield* project(view, seq, version, bytes, manifest, identity);
          }),

        retract: (seq) =>
          Effect.gen(function* () {
            yield* assertCurrent;
            const version = yield* versionOf(view, seq);
            if (version === 0) return;
            append({
              generation, seq, kind: "retract", version: version + 1, at: Date.now(),
            });
            yield* unproject(view, seq);
            view.del(payloadKey(seq));
          }),
      };

      const result = yield* f(view, txn, append);
      view.put(metaKey(META_NEXT_POSITION), u32(position));
      // One batch: the whole transaction lands, or none of it does.
      yield* engine.write([...pending.values()]);
      return result;
    });

  const postingsUnder = (prefix: Uint8Array) =>
    Effect.gen(function* () {
      const builder = new Postings.PostingsBuilder();
      // Folded from the stream, so a wide posting list never becomes an array.
      yield* Stream.runForEach(engine.scan(prefix), (entry) =>
        Effect.sync(() => builder.add(seqOf(entry.key))));
      return builder.build();
    });

  const evaluate = (query: Query): Effect.Effect<Postings.Postings, StoreError> => {
    switch (query._tag) {
      case "Term": return postingsUnder(termPrefix(query.field, query.term));
      case "Equals": return postingsUnder(columnPrefix(query.column, query.value));
      case "Edge": return postingsUnder(edgePrefix(query.edgeType, query.from));
      case "And": return Effect.map(Effect.forEach(query.of, evaluate), Postings.andAll);
      case "Or": return Effect.map(Effect.forEach(query.of, evaluate), Postings.orAll);
    }
  };

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
          if (event._tag === "ObjectPut") {
            yield* project(view, event.seq, event.version, event.bytes, event.manifest, event.identity);
          } else {
            yield* unproject(view, event.seq);
            view.del(payloadKey(event.seq));
          }
        })),
  };

  return {
    partition,
    generation,
    events,

    rebuildLenses: Effect.gen(function* () {
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
      for (const { event } of stored) {
        if (event.kind === "put") {
          yield* project(view, asSeq(event.seq), event.version, bodyOf(event),
            event.manifest ?? emptyManifest(), event.identity);
        } else {
          yield* unproject(view, asSeq(event.seq));
          view.del(payloadKey(asSeq(event.seq)));
        }
      }
      yield* engine.write([...pending.values()]);
      return stored.length;
    }),

    /**
     * Re-derive the postings from the manifests.
     *
     * Works whether or not the log has been compacted, because a manifest
     * records exactly what its object contributed. It cannot detect a corrupt
     * manifest, which is what a full replay is for.
     */
    reindexLenses: Effect.gen(function* () {
      const pending = new Map<string, KvWrite>();
      const view = pendingView(pending);
      for (const tag of DERIVED_TAGS) {
        yield* Stream.runForEach(engine.scan(Uint8Array.from([tag])), (entry) =>
          Effect.sync(() => view.del(entry.key)));
      }
      let count = 0;
      const manifests: Array<{ seq: Seq; manifest: IndexManifest }> = [];
      yield* Stream.runForEach(engine.scan(Uint8Array.from([Tag.Manifest])), (entry) =>
        Effect.sync(() => {
          manifests.push({ seq: asSeq(readU32(entry.key, 1)), manifest: unjson(entry.value) });
        }));
      for (const { seq, manifest } of manifests) {
        for (const [field, term] of manifest.terms) view.put(termKey(field, term, seq), EMPTY);
        for (const [column, value] of manifest.columns) view.put(columnKey(column, value, seq), EMPTY);
        for (const [column, value] of manifest.measures) view.put(measureKey(column, seq), f64(value));
        for (const [edgeType, to] of manifest.edges) view.put(edgeKey(edgeType, seq, to), EMPTY);
        count += 1;
      }
      yield* engine.write([...pending.values()]);
      return count;
    }),

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
      Effect.gen(function* () {
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
      }),

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

    nextSeq: Effect.gen(function* () {
      const next = (yield* readMeta(META_NEXT_SEQ)) + 1;
      yield* engine.write([{ op: "put", key: metaKey(META_NEXT_SEQ), value: u32(next) }]);
      return asSeq(next);
    }),

    transact: (f) => commit((_view, txn) => f(txn)),

    read: (seq) =>
      Effect.map(engine.get(payloadKey(seq)), (bytes) =>
        bytes === undefined
          ? undefined
          : { seq, version: readU32(bytes), bytes: bytes.subarray(4) }),

    resolve: (query) => Stream.fromIterableEffect(Effect.map(evaluate(query), Postings.iterate)),

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

/** Claims the next writer generation, fencing whoever held the previous one. */
export const claimGeneration = (engine: KvEngine): Effect.Effect<number, StoreError> =>
  Effect.gen(function* () {
    const current = yield* engine.get(metaKey(META_GENERATION));
    const next = (current === undefined ? 0 : readU32(current)) + 1;
    yield* engine.write([{ op: "put", key: metaKey(META_GENERATION), value: u32(next) }]);
    return next;
  });
