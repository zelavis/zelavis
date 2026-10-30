import { Duration, Effect, Queue, Semaphore, Stream } from "effect";
import {
  arrayOf, isBoolean, isFiniteNumber, isString, isTimestamp, objectFields, optional, parseJson, type JsonValidator,
} from "../core/json-validation.js";
import { documentsFor, type DocumentsApi } from "./documents.js";
import type {
  Analyzer, Document, DocumentCursor, DocumentFilter, DocumentSort, DocumentWrite,
} from "./document-model.js";
import { documentRecord } from "./document-records.js";
import { covers } from "./document-indexing.js";
import {
  CrossTenantIndexExists, CrossTenantIndexNotFound, InvalidCrossTenantIndex, StoreError, UnindexedField,
  type CursorMismatch, type DbError, type InvalidVectorQuery, type UnanalyzedCollection, type UnembeddedCollection,
  type UnindexedGeometry, type UnknownEdge, type UnknownReference, type UnsupportedOrdering,
} from "./errors.js";
import type { DbEvent, EventCursor } from "./events.js";
import type { JsonObject } from "./json.js";
import type { PartitionKey } from "./model.js";
import { isReservedTenantId, isValidCollectionName, SERVICE_TENANT_PREFIX } from "./naming.js";
import type { ObjectStoreApi, ShardStoreApi } from "./store.js";
import { documentNamespace } from "./tenancy.js";
import { PART_SEPARATOR, type ShardId, type TenantId } from "./topology.js";

/**
 * Indexes that answer one question across every Tenant without asking each one.
 *
 * A Tenant is the unit of locality: everything it holds is on one shard, so a
 * query inside it is a local intersection. A question about every Tenant at
 * once — every listing priced under 10 000 — has no such shard, and `scatter`
 * answers it by asking all of them, which is right for an operator and wrong
 * for a page a visitor is waiting on. A cross-Tenant index is the other answer:
 * one collection's documents from every Tenant, copied into one partition of
 * its own and kept current from each Tenant's log, so a live query reads one
 * partition however many Tenants there are.
 *
 * What it holds is derived, never authoritative. Each Tenant partition's log is
 * read from a cursor kept per partition, and every batch of entries is written
 * in the same transaction as the cursor that batch reached, so a pass cut off
 * anywhere repeats nothing and skips nothing. Positions belong to the partition
 * and move with it, so a moved Tenant carries on from where it was. Where the
 * cursor can no longer be followed — the Tenant's log was compacted past it, or
 * the Tenant was removed and written again from nothing — the partition's
 * entries are derived again from its records rather than from its history.
 *
 * It is eventually consistent: a query answers as of the last refresh, which
 * runs shortly after a write in this process and on a sweep otherwise, and says
 * when that was. A Tenant whose entries are being derived again may show
 * stale entries until that finishes.
 *
 * The entries are documents of the index's own partition on the global shard,
 * so filters, ranges, ordering, text search and paging behave exactly as they
 * do on a Tenant's collection. That partition is not a Tenant: nothing routes
 * to it, `tenants` does not list it, and it never moves.
 *
 * Plugins' `service:` Tenants are never read: what a plugin keeps privately is
 * not the App's to search.
 */

export interface CrossTenantIndexDefinition {
  /** Letters, numbers, underscores and hyphens, like a collection name. */
  readonly name: string;
  /** The collection, by name, whose documents every Tenant contributes. */
  readonly collection: string;
  /**
   * The fields a query may filter, range over and order by, as dotted paths.
   * Every scalar field when omitted, which costs an index entry per field.
   */
  readonly columns?: ReadonlyArray<string>;
  /** Fields made searchable as text; see `Analyzer`. */
  readonly analyzer?: Analyzer;
}

export interface CrossTenantIndexSummary extends CrossTenantIndexDefinition {
  readonly createdAt: string;
  /** When the last refresh of every Tenant finished, in this process. Absent until one has. */
  readonly refreshedAt?: string;
  /** Tenant partitions the index is following. */
  readonly partitions: number;
  /** What the most recent refresh could not do, per partition. Empty when it did everything. */
  readonly failures: ReadonlyArray<{ readonly partition: PartitionKey; readonly error: string }>;
}

export interface CrossTenantMatch {
  readonly tenant: TenantId;
  /** The part of a divided Tenant the document lives in. */
  readonly part?: string;
  readonly id: string;
  /** The document's version in its Tenant when it was indexed. */
  readonly version: number;
  readonly data: JsonObject;
  readonly updatedAt: string;
  readonly score?: number;
  readonly highlights?: Record<string, ReadonlyArray<string>>;
}

export interface CrossTenantQueryInput {
  readonly index: string;
  /** Filters on the source documents' fields, by the same paths and operators as a collection query. */
  readonly where?: ReadonlyArray<DocumentFilter>;
  /** Only these Tenants. */
  readonly tenants?: ReadonlyArray<TenantId>;
  readonly search?: string;
  readonly fuzzy?: boolean | number;
  readonly prefix?: boolean;
  readonly orderBy?: ReadonlyArray<DocumentSort>;
  /** Matches per page: 50 unless given, and at most 1000. */
  readonly limit?: number;
  readonly after?: DocumentCursor;
}

export interface CrossTenantQueryResult {
  readonly matches: ReadonlyArray<CrossTenantMatch>;
  /** Present only when another match follows. */
  readonly next?: DocumentCursor;
  /** When the index was last refreshed from every Tenant; absent until it has been. */
  readonly refreshedAt?: string;
}

export interface CrossTenantRefreshResult {
  readonly index: string;
  /** Tenant partitions looked at. */
  readonly partitions: number;
  /** Log entries read and applied. */
  readonly applied: number;
  /** Partitions whose entries were derived again from their records. */
  readonly rederived: number;
  /** Partitions that no longer exist, whose entries were removed. */
  readonly removed: number;
  readonly failures: ReadonlyArray<{ readonly partition: PartitionKey; readonly error: string }>;
}

export interface CrossTenantIndexesApi {
  /**
   * Create an index and fill it at the next refresh. Its definition is fixed:
   * drop it and define it again to change it.
   */
  readonly define: (
    definition: CrossTenantIndexDefinition,
  ) => Effect.Effect<CrossTenantIndexSummary, CrossTenantIndexExists | InvalidCrossTenantIndex>;
  readonly list: Effect.Effect<ReadonlyArray<CrossTenantIndexSummary>>;
  readonly get: (name: string) => Effect.Effect<CrossTenantIndexSummary, CrossTenantIndexNotFound>;
  /** Remove an index and everything it holds. The Tenants' own documents are untouched. */
  readonly drop: (name: string) => Effect.Effect<{ readonly name: string; readonly entries: number }, CrossTenantIndexNotFound>;
  /**
   * Bring an index, or every index, up to date with every Tenant now, rather
   * than waiting for the background refresh.
   */
  readonly refresh: (name?: string) => Effect.Effect<ReadonlyArray<CrossTenantRefreshResult>, CrossTenantIndexNotFound>;
  /** One page of matches from one partition, however many Tenants contributed them. */
  readonly query: (input: CrossTenantQueryInput) => Effect.Effect<
    CrossTenantQueryResult,
    | CrossTenantIndexNotFound | UnindexedField | CursorMismatch | UnsupportedOrdering | UnknownReference
    | UnanalyzedCollection | UnindexedGeometry | UnknownEdge | UnembeddedCollection | InvalidVectorQuery
  >;
}

export interface CrossTenantRefreshOptions {
  /** How long after a write the background refresh waits for more before it runs. 50 ms unless given. */
  readonly debounce?: Duration.Input;
  /**
   * How often every Tenant is visited whether or not anything was written in
   * this process: what finds writes made elsewhere, and Tenants removed.
   * One minute unless given.
   */
  readonly sweepInterval?: Duration.Input;
}

/** The partition, on the global shard, holding every index's definition. */
const REGISTRY_PARTITION = "zv.cti";
/** Each index's own partition, on the global shard. */
const indexPartition = (name: string) => `zv.cti.${name}`;

const DEFINITIONS = "definitions";
const ENTRIES = "entries";
const CURSORS = "cursors";

/** Log entries read, and so entries written, per transaction. */
const BATCH = 256;
/** Source records read per page when deriving a partition's entries from its records. */
const RECORD_PAGE = 256;
/** Entries read per page when sweeping or removing a partition's entries. */
const ENTRY_PAGE = 500;
/** Tenant partitions refreshed at once. */
const PARTITION_CONCURRENCY = 4;

const dec = new TextDecoder();

/** A Tenant partition this index reads: a Tenant, or a part of one; never reserved, never a plugin's. */
const eligible = (partition: PartitionKey): boolean =>
  !isReservedTenantId(partition) && !partition.startsWith(SERVICE_TENANT_PREFIX);

const tenantAndPart = (partition: PartitionKey): { tenant: TenantId; part?: string } => {
  const at = partition.indexOf(PART_SEPARATOR);
  return at === -1 ? { tenant: partition } : { tenant: partition.slice(0, at), part: partition.slice(at + 1) };
};

/** A partition never contains `/`, so the first one ends it. */
const entryId = (partition: PartitionKey, id: string) => `${partition}/${id}`;

const sourcePath = (path: string) => `doc.${path}`;

interface StoredCursor {
  /** Absent when the partition's log held nothing yet: read it from the start. */
  readonly cursor?: EventCursor;
  /** The life of the partition the cursor was read in (`PartitionStats.incarnation`). */
  readonly incarnation?: string;
}

const cursorOf = (data: JsonObject): StoredCursor => ({
  ...(typeof data.cursor === "string" ? { cursor: data.cursor as EventCursor } : {}),
  ...(typeof data.incarnation === "string" ? { incarnation: data.incarnation } : {}),
});

type StoredDefinition = CrossTenantIndexDefinition & { readonly createdAt: string };

const analyzerRecord = objectFields<Analyzer>({
  fields: arrayOf(isString), version: isFiniteNumber, fold: optional(isBoolean),
  stopWords: optional(arrayOf(isString)), minLength: optional(isFiniteNumber), language: optional(isString),
});
const isStoredDefinition: JsonValidator<StoredDefinition> = objectFields<StoredDefinition>({
  name: isString, collection: isString, columns: optional(arrayOf(isString)),
  analyzer: optional(analyzerRecord), createdAt: isTimestamp,
});

/** A stored definition, checked rather than trusted: it was written by an earlier process. */
const definitionOf = (document: Document): Effect.Effect<StoredDefinition> =>
  isStoredDefinition(document.data)
    ? Effect.succeed(document.data)
    : Effect.die(new Error(`The stored definition of cross-Tenant index "${document.id}" is malformed`));

const validate = (definition: CrossTenantIndexDefinition): Effect.Effect<void, InvalidCrossTenantIndex> => {
  const refuse = (reason: string) => Effect.fail(new InvalidCrossTenantIndex({ name: definition.name, reason }));
  if (!isValidCollectionName(definition.name)) return refuse("the name must be letters, numbers, underscores and hyphens, not starting with zv");
  if (!isValidCollectionName(definition.collection)) return refuse(`"${definition.collection}" is not a collection name`);
  const paths = [...(definition.columns ?? []), ...(definition.analyzer?.fields ?? [])];
  const bad = paths.find((path) => path.length === 0 || path.startsWith(".") || path.endsWith(".") || path.includes(".."));
  if (bad !== undefined) return refuse(`"${bad}" is not a field path`);
  if (definition.columns !== undefined && new Set(definition.columns).size !== definition.columns.length) {
    return refuse("a column is named twice");
  }
  return Effect.void;
};

/** The definition with only what it declares, so an index reads back as it was given. */
const normalized = (definition: CrossTenantIndexDefinition): CrossTenantIndexDefinition => ({
  name: definition.name,
  collection: definition.collection,
  ...(definition.columns === undefined ? {} : { columns: [...definition.columns] }),
  ...(definition.analyzer === undefined ? {} : { analyzer: definition.analyzer }),
});

export const crossTenantIndexesOver = (options: {
  readonly globalShard: ShardStoreApi;
  readonly shards: ReadonlyMap<ShardId, ShardStoreApi>;
  readonly tenantsOn: (shard: ShardStoreApi) => Effect.Effect<ReadonlyArray<TenantId>>;
  /** A partition's store wherever routing places it now. */
  readonly routed: (partition: PartitionKey) => ObjectStoreApi;
}) => Effect.gen(function* () {
  const { globalShard, shards, tenantsOn, routed } = options;

  const internal = (partition: string): DocumentsApi =>
    documentsFor(globalShard.partition(partition), partition);

  const registry = internal(REGISTRY_PARTITION);
  const ensure = (documents: DocumentsApi, name: string, input: Parameters<DocumentsApi["createCollection"]>[0]) =>
    Effect.gen(function* () {
      if (yield* documents.collectionExists(name)) return;
      yield* Effect.orDie(documents.createCollection(input));
    });

  /** Every page of a collection, read through, for what is small or bounded by Tenants. */
  const everyDocument = (documents: DocumentsApi, collection: string, where?: ReadonlyArray<DocumentFilter>) =>
    Effect.gen(function* () {
      const out: Document[] = [];
      let after: DocumentCursor | undefined;
      for (;;) {
        const page = yield* Effect.orDie(documents.findPage({
          collection, limit: ENTRY_PAGE,
          ...(where === undefined ? {} : { where }),
          ...(after === undefined ? {} : { after }),
        }));
        out.push(...page.documents);
        if (page.next === undefined) return out;
        after = page.next;
      }
    });

  // Definitions are read once here and kept: this process is the database's
  // one writer, and every change to them goes through `define` and `drop`.
  // Nothing is written until the first index is defined, so a database with
  // none holds nothing of them.
  const definitions = new Map<string, StoredDefinition>();
  if (yield* registry.collectionExists(DEFINITIONS)) {
    for (const document of yield* everyDocument(registry, DEFINITIONS)) {
      definitions.set(document.id, yield* definitionOf(document));
    }
  }

  interface Status {
    refreshedAt?: string;
    partitions: number;
    failures: ReadonlyArray<{ readonly partition: PartitionKey; readonly error: string }>;
  }
  const status = new Map<string, Status>();
  /** One refresh, define or drop of an index at a time. */
  const locks = new Map<string, Semaphore.Semaphore>();
  const lockOf = (name: string) => {
    let lock = locks.get(name);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(name, lock);
    }
    return lock;
  };
  const registryLock = Semaphore.makeUnsafe(1);

  /** The index's own documents, its collections created if a crash came between define and the first refresh. */
  const indexDocuments = (definition: CrossTenantIndexDefinition) =>
    Effect.gen(function* () {
      const documents = internal(indexPartition(definition.name));
      yield* ensure(documents, ENTRIES, {
        name: ENTRIES,
        ...(definition.columns === undefined
          ? {}
          : { columns: ["partition", "tenant", "part", ...definition.columns.map(sourcePath)] }),
        ...(definition.analyzer === undefined
          ? {}
          : { analyzer: { ...definition.analyzer, fields: definition.analyzer.fields.map(sourcePath) } }),
      });
      yield* ensure(documents, CURSORS, { name: CURSORS, columns: [] });
      return documents;
    });

  const summaryOf = (definition: StoredDefinition): CrossTenantIndexSummary => {
    const held = status.get(definition.name);
    return {
      ...normalized(definition),
      createdAt: definition.createdAt,
      ...(held?.refreshedAt === undefined ? {} : { refreshedAt: held.refreshedAt }),
      partitions: held?.partitions ?? 0,
      failures: held?.failures ?? [],
    };
  };

  const require_ = (name: string) => {
    const definition = definitions.get(name);
    return definition === undefined ? Effect.fail(new CrossTenantIndexNotFound({ name })) : Effect.succeed(definition);
  };

  /** Every Tenant partition holding anything, on any shard. */
  const sourcePartitions = Effect.gen(function* () {
    const found = new Set<PartitionKey>();
    for (const shard of shards.values()) {
      for (const partition of yield* tenantsOn(shard)) if (eligible(partition)) found.add(partition);
    }
    return [...found].sort();
  });

  const entryFor = (partition: PartitionKey, document: Document, pass?: string): DocumentWrite => {
    const { tenant, part } = tenantAndPart(partition);
    return {
      _tag: "Upsert",
      collection: ENTRIES,
      id: entryId(partition, document.id),
      data: {
        partition, tenant, ...(part === undefined ? {} : { part }),
        id: document.id, version: document.version, updatedAt: document.updatedAt,
        ...(pass === undefined ? {} : { pass }),
        doc: document.data,
      },
    };
  };

  /**
   * One Tenant partition's index entries brought level with its log.
   *
   * Each batch of entries and the cursor it reached are one transaction, and
   * the cursor's version is checked in it, so a second refresher that raced
   * this one is refused rather than applying the same events again. A cursor
   * is followed only in the life of the partition it was read in: one removed
   * and written again has a new log whose positions begin over.
   */
  const syncPartition = (
    definition: CrossTenantIndexDefinition,
    documents: DocumentsApi,
    partition: PartitionKey,
  ) => Effect.gen(function* () {
    const store = routed(partition);
    const namespace = documentNamespace(definition.collection);
    const { incarnation, compactedTo, seeding, lineage } = yield* store.stats;
    let applied = 0;
    let rederived = false;
    // An unfinished branch refuses every read; its entries come once it is whole.
    if (seeding && lineage !== undefined) return { applied, rederived };

    /** The cursor record's own version, to check in the transaction that replaces it. */
    type Held = { readonly record: number } | undefined;

    const cursorWrite = (next: StoredCursor, held: Held): DocumentWrite => {
      const data = { ...next, ...(incarnation === undefined ? {} : { incarnation }) } as JsonObject;
      return held === undefined
        ? { _tag: "Insert", collection: CURSORS, id: partition, data }
        : { _tag: "Upsert", collection: CURSORS, id: partition, data, expectedVersion: held.record };
    };
    const heldAfter = (written: ReadonlyArray<{ readonly _tag: string; readonly document?: Document }>, held: Held): Held => {
      const last = written[written.length - 1];
      return last?.document === undefined ? held : { record: last.document.version };
    };

    /** Apply the log after `from`, a batch per transaction, to its end. */
    const replay = (from: StoredCursor, current: Held) =>
      Effect.gen(function* () {
        let position = from;
        let held = current;
        for (;;) {
          const events = [...(yield* Stream.runCollect(store.events.read({
            ...(position.cursor === undefined ? {} : { after: position.cursor }),
            limit: BATCH,
          })))];
          if (events.length === 0) return;
          // The last event for a document in the batch decides it: the log is
          // in order, so it is the newest.
          const latest = new Map<string, DbEvent>();
          for (const event of events) {
            if (event.identity?.namespace !== namespace) continue;
            latest.set(event.identity.key, event);
          }
          const writes: DocumentWrite[] = [];
          for (const [id, event] of latest) {
            if (event._tag === "ObjectPut") {
              writes.push(entryFor(partition, yield* decodeDocument(event.bytes)));
            } else if ((yield* Effect.orDie(documents.findById({ collection: ENTRIES, id: entryId(partition, id) }))) !== undefined) {
              writes.push({ _tag: "Delete", collection: ENTRIES, id: entryId(partition, id) });
            }
          }
          position = { cursor: events[events.length - 1]!.cursor };
          writes.push(cursorWrite(position, held));
          held = heldAfter(yield* Effect.orDie(documents.write({ operations: writes })), held);
          applied += latest.size;
          if (events.length < BATCH) return;
        }
      });

    /**
     * The partition's entries derived from its records, for when its log can
     * no longer be followed from the cursor, then the log after that.
     *
     * The head is read first and the records after it: a scan begun at a
     * position, followed by the log after it, is the partition as of the end
     * of that log. Entries the scan did not reach again are the partition's
     * deleted documents, and go. The cursor is cleared first, so a derivation
     * cut off anywhere is begun again rather than trusted.
     */
    const rederive = (current: Held) =>
      Effect.gen(function* () {
        rederived = true;
        if (current !== undefined) {
          yield* Effect.orDie(documents.write({
            operations: [{ _tag: "Delete", collection: CURSORS, id: partition, expectedVersion: current.record }],
          }));
        }
        const head = yield* store.events.head;
        const pass = crypto.randomUUID();

        let after: string | undefined;
        for (;;) {
          const page = yield* store.scanIdentities({
            namespace, limit: RECORD_PAGE, ...(after === undefined ? {} : { after }),
          });
          const writes: DocumentWrite[] = [];
          for (const { seq } of page) {
            const object = yield* store.read(seq);
            if (object === undefined) continue;
            writes.push(entryFor(partition, yield* decodeDocument(object.bytes), pass));
          }
          if (writes.length > 0) yield* Effect.orDie(documents.write({ operations: writes }));
          if (page.length < RECORD_PAGE) break;
          after = page[page.length - 1]!.key;
        }

        // Paged by identifier, so deleting what a page held does not move
        // what the next page starts from.
        let sweptAfter: DocumentCursor | undefined;
        for (;;) {
          const page = yield* Effect.orDie(documents.findPage({
            collection: ENTRIES, where: [{ path: "partition", value: partition }], limit: ENTRY_PAGE,
            ...(sweptAfter === undefined ? {} : { after: sweptAfter }),
          }));
          const stale = page.documents.filter((entry) => entry.data.pass !== pass);
          if (stale.length > 0) {
            yield* Effect.orDie(documents.write({
              operations: stale.map((entry): DocumentWrite => ({ _tag: "Delete", collection: ENTRIES, id: entry.id })),
            }));
          }
          if (page.next === undefined) break;
          sweptAfter = page.next;
        }

        const start: StoredCursor = head === undefined ? {} : { cursor: head };
        const held = heldAfter(yield* Effect.orDie(documents.write({ operations: [cursorWrite(start, undefined)] })), undefined);
        yield* replay(start, held);
      });

    const stored = yield* Effect.map(
      Effect.orDie(documents.findById({ collection: CURSORS, id: partition })),
      (document) => document === undefined ? undefined : { record: document.version, ...cursorOf(document.data) },
    );
    if (stored !== undefined && stored.incarnation === incarnation) {
      // Compacted past the cursor: the history it would read is gone.
      yield* replay(stored, { record: stored.record }).pipe(
        Effect.catchTag("CursorCompacted", () => Effect.flatMap(
          Effect.orDie(documents.findById({ collection: CURSORS, id: partition })),
          (latest) => rederive(latest === undefined ? undefined : { record: latest.version }),
        )),
      );
    } else if (stored === undefined && compactedTo === 0 && !(yield* hasEntries(documents, partition))) {
      // Nothing indexed yet and the whole log still there: read it from the start.
      yield* replay({}, undefined);
    } else {
      yield* rederive(stored === undefined ? undefined : { record: stored.record });
    }
    return { applied, rederived };
  });

  /** A document as its Tenant stored it; one that does not parse is a broken store, not a request to refuse. */
  const decodeDocument = (bytes: Uint8Array) =>
    Effect.try({
      try: () => parseJson(dec.decode(bytes), documentRecord, "document record"),
      catch: (cause) => new StoreError({ op: "crossTenantIndex.decode", cause }),
    }).pipe(Effect.orDie);

  const hasEntries = (documents: DocumentsApi, partition: PartitionKey) =>
    Effect.map(
      Effect.orDie(documents.findPage({ collection: ENTRIES, where: [{ path: "partition", value: partition }], limit: 1 })),
      (page) => page.documents.length > 0,
    );

  /** Remove what the index holds for a partition that no longer exists anywhere; the cursor last. */
  const removePartition = (documents: DocumentsApi, partition: PartitionKey) =>
    Effect.gen(function* () {
      for (;;) {
        const page = yield* documents.findPage({
          collection: ENTRIES, where: [{ path: "partition", value: partition }], limit: ENTRY_PAGE,
        });
        if (page.documents.length === 0) break;
        yield* documents.write({
          operations: page.documents.map((entry): DocumentWrite => ({ _tag: "Delete", collection: ENTRIES, id: entry.id })),
        });
      }
      if ((yield* documents.findById({ collection: CURSORS, id: partition })) !== undefined) {
        yield* documents.write({ operations: [{ _tag: "Delete", collection: CURSORS, id: partition }] });
      }
    }).pipe(Effect.orDie);

  const describe = (cause: unknown) =>
    typeof cause === "object" && cause !== null && "_tag" in cause ? String((cause as { _tag: unknown })._tag) : String(cause);

  /**
   * One pass over an index: every Tenant partition, or only `only` — the ones
   * written since the last pass — with removed Tenants found only by a full one.
   */
  const refreshOne = (name: string, only?: ReadonlySet<PartitionKey>) =>
    lockOf(name).withPermit(Effect.gen(function* () {
      const definition = definitions.get(name);
      if (definition === undefined) return undefined;
      const documents = yield* indexDocuments(definition);
      // A pass after writes visits only what was written, without listing
      // every shard; a partition written and then removed is found empty and
      // its entries go.
      const visit = only === undefined ? yield* sourcePartitions : [...only].filter(eligible).sort();
      const failures: Array<{ partition: PartitionKey; error: string }> = [];
      let applied = 0;
      let rederived = 0;
      yield* Effect.forEach(visit, (partition) =>
        syncPartition(definition, documents, partition).pipe(
          Effect.map((result) => {
            applied += result.applied;
            if (result.rederived) rederived += 1;
          }),
          // A Tenant that cannot be read now — being moved, or its lenses
          // being rebuilt — is said, and the others carry on.
          Effect.catch((error: DbError) => Effect.sync(() => {
            failures.push({ partition, error: describe(error) });
          })),
        ), { concurrency: PARTITION_CONCURRENCY, discard: true });

      let removed = 0;
      let followed = 0;
      if (only === undefined) {
        const live = new Set(visit);
        // A page of cursors at a time, so a sweep holds a page in memory
        // rather than one record per Tenant.
        let after: DocumentCursor | undefined;
        for (;;) {
          const page = yield* Effect.orDie(documents.findPage({
            collection: CURSORS, limit: ENTRY_PAGE, ...(after === undefined ? {} : { after }),
          }));
          for (const cursor of page.documents) {
            followed += 1;
            if (live.has(cursor.id)) continue;
            // Not listed may mean mid-move between two listings; only a
            // partition routing finds empty is gone.
            if ((yield* Effect.orDie(routed(cursor.id).events.head)) !== undefined) continue;
            yield* removePartition(documents, cursor.id);
            removed += 1;
            followed -= 1;
          }
          if (page.next === undefined) break;
          after = page.next;
        }
      }

      const previous = status.get(name);
      status.set(name, {
        ...(only === undefined
          ? (failures.length === 0 ? { refreshedAt: new Date().toISOString() } : {})
          : (previous?.refreshedAt === undefined ? {} : { refreshedAt: previous.refreshedAt })),
        partitions: only === undefined ? followed : previous?.partitions ?? 0,
        failures,
      });
      return { index: name, partitions: visit.length, applied, rederived, removed, failures };
    }));

  const dirty = new Set<PartitionKey>();
  /** A new index wants a full pass to fill it, whatever else woke the refresh. */
  let fullDue = false;
  const wake = yield* Queue.sliding<void>(1);

  const api: CrossTenantIndexesApi = {
    define: (input) =>
      registryLock.withPermit(Effect.gen(function* () {
        yield* validate(input);
        if (definitions.has(input.name)) return yield* new CrossTenantIndexExists({ name: input.name });
        const stored: StoredDefinition = { ...normalized(input), createdAt: new Date().toISOString() };
        yield* ensure(registry, DEFINITIONS, { name: DEFINITIONS });
        yield* indexDocuments(stored);
        yield* Effect.orDie(registry.write({
          operations: [{ _tag: "Insert", collection: DEFINITIONS, id: stored.name, data: stored as unknown as JsonObject }],
        }));
        definitions.set(stored.name, stored);
        fullDue = true;
        yield* Queue.offer(wake, undefined);
        return summaryOf(stored);
      })),

    list: Effect.sync(() => [...definitions.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map(summaryOf)),

    get: (name) => Effect.map(require_(name), summaryOf),

    drop: (name) =>
      registryLock.withPermit(Effect.gen(function* () {
        yield* require_(name);
        return yield* lockOf(name).withPermit(Effect.gen(function* () {
          // The entries go first and the definition last, so a drop cut off
          // part way leaves an index that is still listed and can be dropped
          // again, never entries nothing names.
          const entries = yield* Effect.orDie(globalShard.drop(indexPartition(name)));
          yield* Effect.orDie(registry.write({ operations: [{ _tag: "Delete", collection: DEFINITIONS, id: name }] }));
          definitions.delete(name);
          status.delete(name);
          return { name, entries };
        }));
      })),

    refresh: (name) =>
      Effect.gen(function* () {
        const names = name === undefined ? [...definitions.keys()].sort() : [(yield* require_(name)).name];
        const out: CrossTenantRefreshResult[] = [];
        for (const each of names) {
          const result = yield* refreshOne(each);
          if (result !== undefined) out.push(result);
        }
        return out;
      }),

    query: (input) =>
      Effect.gen(function* () {
        const definition = yield* require_(input.index);
        for (const path of [...(input.where ?? []).map((filter) => filter.path), ...(input.orderBy ?? []).map((sort) => sort.path)]) {
          const op = (input.where ?? []).find((filter) => filter.path === path)?.op;
          if (op === "search" || op === "phrase") continue;
          if (!covers(definition.columns, path)) return yield* new UnindexedField({ collection: definition.name, path });
        }
        const documents = yield* indexDocuments(definition);
        const where: DocumentFilter[] = (input.where ?? []).map((filter) => ({ ...filter, path: sourcePath(filter.path) }));
        if (input.tenants !== undefined) where.push({ path: "tenant", op: "in", value: [...input.tenants] });
        const page = yield* documents.findPage({
          collection: ENTRIES,
          ...(where.length === 0 ? {} : { where }),
          ...(input.search === undefined ? {} : { search: input.search }),
          ...(input.fuzzy === undefined ? {} : { fuzzy: input.fuzzy }),
          ...(input.prefix === undefined ? {} : { prefix: input.prefix }),
          ...(input.orderBy === undefined ? {} : { orderBy: input.orderBy.map((sort) => ({ ...sort, path: sourcePath(sort.path) })) }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.after === undefined ? {} : { after: input.after }),
        });
        const refreshedAt = status.get(definition.name)?.refreshedAt;
        return {
          matches: page.documents.map((entry): CrossTenantMatch => ({
            tenant: entry.data.tenant as string,
            ...(typeof entry.data.part === "string" ? { part: entry.data.part } : {}),
            id: entry.data.id as string,
            version: entry.data.version as number,
            data: entry.data.doc as JsonObject,
            updatedAt: entry.data.updatedAt as string,
            ...(entry.score === undefined ? {} : { score: entry.score }),
            ...(entry.highlights === undefined
              ? {}
              : { highlights: Object.fromEntries(Object.entries(entry.highlights).map(([path, snippets]) => [path.startsWith("doc.") ? path.slice(4) : path, snippets])) }),
          })),
          ...(page.next === undefined ? {} : { next: page.next }),
          ...(refreshedAt === undefined ? {} : { refreshedAt }),
        };
      }).pipe(Effect.catchTag("UnindexedField", (error) =>
        Effect.fail(new UnindexedField({ collection: input.index, path: error.path.startsWith("doc.") ? error.path.slice(4) : error.path })))),
  };

  /** Note a write to a Tenant partition, so the background refresh reads it soon. */
  const touched = (partition: PartitionKey): Effect.Effect<void> =>
    Effect.suspend(() =>
      definitions.size === 0 || !eligible(partition)
        ? Effect.void
        : Effect.andThen(Effect.sync(() => dirty.add(partition)), Queue.offer(wake, undefined)));

  /**
   * Keep every index current until the database's scope closes: shortly after
   * a write in this process, and on a sweep otherwise. A full pass runs first,
   * so an index catches up with whatever was written while it was closed.
   */
  /**
   * A wait that never keeps the host alive on its own. The refresh lives as
   * long as the database does, and a process that ends without closing its
   * database must still end rather than wait on an upkeep timer.
   */
  const idle = (duration: Duration.Input) =>
    Effect.callback<void>((resume) => {
      const timer = setTimeout(() => resume(Effect.void), Duration.toMillis(duration));
      (timer as { unref?: () => void }).unref?.();
      return Effect.sync(() => clearTimeout(timer));
    });

  const background = (refresh: CrossTenantRefreshOptions = {}) => {
    const debounce = refresh.debounce ?? "50 millis";
    const sweepInterval = refresh.sweepInterval ?? "1 minute";
    const pass = (only?: ReadonlySet<PartitionKey>) =>
      Effect.forEach([...definitions.keys()].sort(), (name) =>
        refreshOne(name, only).pipe(
          // A defect in one pass is recorded against that index and the loop
          // goes on; the next pass tries again.
          Effect.catchCause((cause) => Effect.sync(() => {
            const previous = status.get(name);
            status.set(name, {
              ...(previous?.refreshedAt === undefined ? {} : { refreshedAt: previous.refreshedAt }),
              partitions: previous?.partitions ?? 0,
              failures: [{ partition: "*", error: String(cause) }],
            });
          })),
        ), { discard: true });
    return Effect.gen(function* () {
      yield* pass();
      for (;;) {
        const woke = yield* Effect.race(Effect.as(Queue.take(wake), true), Effect.as(idle(sweepInterval), false));
        if (!woke) {
          dirty.clear();
          yield* pass();
          continue;
        }
        yield* idle(debounce);
        const only = new Set(dirty);
        dirty.clear();
        const full = fullDue;
        fullDue = false;
        yield* pass(full ? undefined : only);
      }
    });
  };

  return { api, touched, background };
});
