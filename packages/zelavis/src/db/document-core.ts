/**
 * The documents API's shared core for one tenant: the store's operations as
 * the documents layer uses them, collections and documents read, transactions
 * checked, and the manifest a document is written with.
 */
import { Effect, Stream } from "effect";
import type { JsonObject } from "./json.js";
import {
  SchemaViolation,
  CollectionNotFound,
  IdempotencyKeyReused,
  TenantMoving,
  dieUnlessMoving,
  InvalidConstraint,
} from "./errors.js";
import type { DbError } from "./errors.js";
import { cellsFor, loadH3 } from "./spatial.js";
import { type VectorProjectionIndex } from "./vectors.js";
import { type IndexManifest, type Seq } from "./model.js";
import { type Query } from "./query.js";
import type { SchemasApi } from "./schemas.js";
import type { ObjectStoreApi, ResolveOptions, Txn } from "./store.js";
import type { TenantId } from "./topology.js";

import { hasValue } from "./document-definitions.js";
import { cellTermsFor, columnsFor, indexTuple, measuresFor, termsFor } from "./document-indexing.js";
import { type Analyzer, type Document, type MeasureDefinition, type ReferenceConstraint, type SpatialIndex } from "./document-model.js";
import { COLLECTION_MARKER, type Pending, RECEIPT_MARKER, type Receipt, type StoredCollection, type StoredIndex, claimOf, collectionColumn, collectionNs, collectionRecord, decode, documentNs, documentRecord, encode, idempotencyColumn, idempotencyNs, nameOf, readPath, receiptRecord } from "./document-records.js";

export const documentCore = (
  store: ObjectStoreApi,
  tenant: TenantId,
  schemas?: SchemasApi,
) => {
  /**
   * Reject the whole write when the data does not satisfy the active schema.
   *
   * All-or-nothing rather than partial: a document that half-matched would put
   * the lenses in a state no schema describes, and every reader after it would
   * have to cope with a shape that was never valid.
   */
  const enforceSchema = (collection: string, data: JsonObject) =>
    Effect.gen(function* () {
      if (schemas === undefined) return;
      const result = yield* schemas.validate(collection, data);
      if (!result.valid) {
        return yield* new SchemaViolation({
          collection,
          schemaVersion: result.schemaVersion,
          issues: result.issues,
        });
      }
    });


  // A store failure is not something a caller can act on: a fenced writer or an
  // unreadable file is the runtime's problem, not a decision. Converting them to
  // defects here keeps the domain error channel to what a caller can actually
  // respond to — a duplicate id, a missing collection, a stale version.
  const lookup = (namespace: string, key: string) => Effect.orDie(store.lookup(namespace, key));
  const readObject = (seq: Seq) => Effect.orDie(store.read(seq));
  const nextSeq = dieUnlessMoving(store.nextSeq);
  const resolveQuery = (query: Query, options?: ResolveOptions): Stream.Stream<Seq> =>
    Stream.orDie(store.resolve(query, options));
  const termsOf = (field: string, prefix?: string) => Effect.orDie(store.terms(field, prefix));
  const write = (f: (txn: Txn) => Effect.Effect<void, DbError>): Effect.Effect<void> =>
    Effect.orDie(store.transact(f));

  const projectionIndexes = new Map<string, VectorProjectionIndex>();

  /**
   * What a key was used for last time, if it has been used.
   *
   * A key that comes back attached to a different request is refused rather
   * than answered: replying with the stored outcome would tell a caller that
   * something happened which did not.
   */
  const receiptFor = (key: string, fingerprint: string, request: string) =>
    Effect.gen(function* () {
      const seq = yield* lookup(idempotencyNs(), key);
      if (seq === undefined) return undefined;
      const object = yield* readObject(seq);
      if (object === undefined) return undefined;
      const receipt = decode(object.bytes, receiptRecord);
      if (receipt.fingerprint !== fingerprint) {
        return yield* new IdempotencyKeyReused({
          tenant,
          key,
          detail: `first used for ${receipt.request}, now offered for ${request}`,
        });
      }
      return receipt;
    });

  /** The store's own failures: a caller cannot act on them, so they become defects. */
  const STORE_FAILURES: ReadonlySet<string> = new Set([
    "StoreError", "WriterFenced", "ForeignCursor", "CursorCompacted", "LogCompacted", "PartitionUnavailable",
  ]);

  /**
   * Run a change in one transaction, keeping the failures a caller can act on.
   *
   * A transaction holds the store's one writer, so what the change reads —
   * whether an id is taken, which version is current, whether a value is held
   * — stays true until its writes land, and a failure discards all of them.
   * Only the store's own failures become defects; a conflict or a violation
   * reaches the caller as itself.
   */
  const transactChecked = <A, E>(
    change: (txn: Txn) => Effect.Effect<A, E | DbError>,
  ): Effect.Effect<A, Exclude<E, DbError> | TenantMoving> =>
    store.transact(change).pipe(
      Effect.catch((error) =>
        STORE_FAILURES.has((error as { readonly _tag: string })._tag)
          ? Effect.die(error)
          : Effect.fail(error as Exclude<E, DbError> | TenantMoving)),
    );

  /**
   * Check and apply a change and, if the caller gave a key, record what it did
   * — in one transaction.
   *
   * Recording the receipt afterwards would leave a window in which the write
   * had happened and the key had not been noted, which is exactly the window a
   * retry falls into. The receipt is looked for before anything is allocated,
   * so a replay costs a lookup, and again inside the transaction, where a first
   * attempt running alongside cannot slip past it. A result `remember` declines
   * is not recorded: nothing happened worth replaying.
   */
  const commitOnce = <A, E>(
    key: string | undefined,
    fingerprint: string,
    request: string,
    change: (txn: Txn) => Effect.Effect<A, E | DbError>,
    remember: (result: A) => boolean = () => true,
  ): Effect.Effect<A, Exclude<E, DbError> | IdempotencyKeyReused | TenantMoving> =>
    Effect.gen(function* () {
      if (key === undefined) return yield* transactChecked(change);
      const seen = yield* receiptFor(key, fingerprint, request);
      if (seen !== undefined) return seen.result as A;
      const receiptSeq = yield* nextSeq;
      return yield* transactChecked<A, E | IdempotencyKeyReused>((txn) =>
        Effect.gen(function* () {
          const raced = yield* receiptFor(key, fingerprint, request);
          if (raced !== undefined) return raced.result as A;
          const result = yield* change(txn);
          if (remember(result)) {
            yield* rememberKey(txn, {
              key, fingerprint, request, result, at: new Date().toISOString(),
            }, receiptSeq);
          }
          return result;
        }));
    });

  const loadCollection = (name: string) =>
    Effect.gen(function* () {
      const seq = yield* lookup(collectionNs(), name);
      if (seq === undefined) return undefined;
      const object = yield* readObject(seq);
      return object === undefined ? undefined : decode(object.bytes, collectionRecord);
    });

  const requireCollection = (name: string) =>
    Effect.filterOrFail(
      loadCollection(name),
      (found): found is StoredCollection => found !== undefined,
      () => new CollectionNotFound({ name }),
    );

  const readDocument = (seq: Seq) =>
    Effect.map(readObject(seq), (o) => (o === undefined ? undefined : decode(o.bytes, documentRecord)));

  /**
   * Refuse early a change to a tenant that is being moved off this shard,
   * before work its commit would be refused for anyway. Costs nothing: the
   * store keeps whether its partition is fenced, and refuses the commit itself
   * whether or not this ran.
   */
  const assertNotMoving = dieUnlessMoving(store.writable);

  /**
   * H3, loaded once and kept.
   *
   * Resolved before a transaction rather than inside one: the manifest is built
   * under the store's writer, and taking an import there would put async work
   * in the one place that must stay short. A collection with no spatial fields
   * never loads it at all.
   */
  let h3: Parameters<typeof cellsFor>[0] | undefined;
  const spatialHandle = (spatial: SpatialIndex | undefined) =>
    Effect.gen(function* () {
      if (spatial === undefined) return undefined;
      if (h3 === undefined) h3 = yield* Effect.orDie(loadH3);
      return h3;
    });

  const transactOrDie = <A>(f: (txn: Txn) => Effect.Effect<A, DbError>): Effect.Effect<A> =>
    Effect.orDie(store.transact(f));

  const collectionPut = (txn: Txn, seq: Seq, collection: StoredCollection) =>
    txn.put(seq, encode(collection), {
      terms: [],
      columns: [[collectionColumn(), COLLECTION_MARKER]],
      measures: [],
      edges: [],
    }, { namespace: collectionNs(), key: collection.name });

  /**
   * Record on each target collection the references naming it, in the caller's
   * transaction. A target that does not exist cannot be named.
   *
   * One write per target, with all of its references at once: a read inside a
   * transaction sees what is committed, so a second write built on a second
   * read would drop what the first one added.
   */
  const linkTargets = (txn: Txn, from: string, references: ReadonlyArray<Required<ReferenceConstraint>>) =>
    Effect.gen(function* () {
      for (const name of new Set(references.map((reference) => reference.collection))) {
        const naming = references.filter((reference) => reference.collection === name);
        const targetSeq = yield* lookup(collectionNs(), name);
        const target = targetSeq === undefined ? undefined : yield* loadCollection(name);
        if (targetSeq === undefined || target === undefined) {
          return yield* new InvalidConstraint({
            collection: from, name: naming[0]!.name, reason: `there is no collection "${name}" to reference`,
          });
        }
        yield* collectionPut(txn, targetSeq, {
          ...target,
          referencedBy: [
            ...(target.referencedBy ?? []),
            ...naming.map((reference) => ({ collection: from, reference: reference.name })),
          ],
        });
      }
    });

  /** Remove a reference and its back-reference together, in the caller's transaction. */
  const unlinkReference = (txn: Txn, from: string, name: string) =>
    Effect.gen(function* () {
      const fromSeq = yield* lookup(collectionNs(), from);
      const source = fromSeq === undefined ? undefined : yield* loadCollection(from);
      const reference = source?.references?.find((candidate) => candidate.name === name);
      if (fromSeq === undefined || source === undefined || reference === undefined) return false;
      const unlinked = (record: StoredCollection): StoredCollection => ({
        ...record,
        referencedBy: (record.referencedBy ?? []).filter((back) => !(back.collection === from && back.reference === name)),
      });
      const remaining = { ...source, references: (source.references ?? []).filter((candidate) => candidate.name !== name) };
      if (reference.collection === from) {
        yield* collectionPut(txn, fromSeq, unlinked(remaining));
        return true;
      }
      yield* collectionPut(txn, fromSeq, remaining);
      const targetSeq = yield* lookup(collectionNs(), reference.collection);
      const target = targetSeq === undefined ? undefined : yield* loadCollection(reference.collection);
      if (targetSeq !== undefined && target !== undefined) yield* collectionPut(txn, targetSeq, unlinked(target));
      return true;
    });

  /** Every posting a document contributes: a column per scalar, and a tuple per index. */
  const manifestFor = (
    doc: Document,
    indexes: ReadonlyArray<StoredIndex>,
    analyzer?: Analyzer,
    spatial?: SpatialIndex,
    h3?: Parameters<typeof cellsFor>[0],
    edges: ReadonlyArray<readonly [string, Seq]> = [],
    measures: ReadonlyArray<MeasureDefinition> = [],
    columns?: ReadonlyArray<string>,
  ): IndexManifest => ({
    terms: [
      ...termsFor(doc.collection, analyzer, doc.data),
      ...cellTermsFor(doc.collection, spatial, h3, doc.data),
    ],
    columns: [
      ...columnsFor(doc.collection, doc.data, columns),
      ...indexes.map((index) => [index.column, indexTuple(index, doc.data)] as const),
    ],
    measures: measuresFor(doc.collection, measures, doc.data),
    edges: [...edges],
  });

  /** The document at an identifier, as this transaction leaves it. */
  const currentAt = (pending: Pending, seq: Seq): Effect.Effect<Document | undefined, DbError> =>
    pending.bySeq.has(Number(seq))
      ? Effect.succeed(pending.bySeq.get(Number(seq)) ?? undefined)
      : readDocument(seq);

  /** What a name addresses, as this transaction leaves it. */
  const currentNamed = (
    pending: Pending,
    collection: string,
    id: string,
  ): Effect.Effect<{ readonly seq: Seq; readonly document: Document | null } | undefined, DbError> =>
    Effect.gen(function* () {
      const written = pending.byName.get(nameOf(collection, id));
      if (written !== undefined) return written;
      const seq = yield* lookup(documentNs(collection), id);
      if (seq === undefined) return undefined;
      return { seq, document: (yield* readDocument(seq)) ?? null };
    });

  /** Record a document this transaction has written, and the unique values it takes. */
  const remember = (pending: Pending, collection: StoredCollection | undefined, doc: Document, seq: Seq) => {
    pending.bySeq.set(Number(seq), doc);
    pending.byName.set(nameOf(doc.collection, doc.id), { seq, document: doc });
    const held = nameOf(doc.collection, doc.id);
    for (const [key, holder] of pending.claimed) if (holder === held) pending.claimed.delete(key);
    for (const index of collection?.indexes ?? []) {
      if (index.unique !== true) continue;
      if (index.fields.some((field) => !hasValue(readPath(doc.data, field.path)))) continue;
      pending.claimed.set(claimOf(index.column, indexTuple(index, doc.data)), held);
    }
  };

  /** Record a document this transaction has retracted, and release what it held. */
  const forget = (pending: Pending, doc: Document, seq: Seq) => {
    pending.bySeq.set(Number(seq), null);
    pending.byName.set(nameOf(doc.collection, doc.id), { seq, document: null });
    const held = nameOf(doc.collection, doc.id);
    for (const [key, holder] of pending.claimed) if (holder === held) pending.claimed.delete(key);
  };

  /**
   * A completed write, remembered under the key the caller gave it.
   *
   * Written in the same transaction as the change it describes. Recording it
   * afterwards would leave a window where the write had happened and the key
   * had not been noted — precisely the window a retry falls into, and the one
   * direction of failure the key exists to prevent.
   */
  const rememberKey = (txn: Txn, receipt: Receipt, seq: Seq) =>
    txn.put(seq, encode(receipt), {
      terms: [],
      // Marked so a tenant's receipts can be swept without walking the shard;
      // they are the one thing here that accumulates with requests rather than
      // with data, so there has to be a way to let them go.
      columns: [[idempotencyColumn(), RECEIPT_MARKER]],
      measures: [],
      edges: [],
    }, { namespace: idempotencyNs(), key: receipt.key });

  return {
    store, tenant, schemas, enforceSchema, lookup, readObject, nextSeq, resolveQuery, termsOf, write,
    projectionIndexes, receiptFor, transactChecked, commitOnce, loadCollection, requireCollection,
    readDocument, assertNotMoving, spatialHandle, transactOrDie, collectionPut, linkTargets,
    unlinkReference, manifestFor, currentAt, currentNamed, remember, forget,
  };
};

export type DocumentCore = ReturnType<typeof documentCore>;
