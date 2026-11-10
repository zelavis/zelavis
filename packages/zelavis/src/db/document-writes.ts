/** The documents API's writes for one tenant: documents, collections and their declarations changed, checked inside the transaction that writes them. */
import { Effect, Stream } from "effect";
import type { JsonObject } from "./json.js";
import {
  CollectionExists,
  SchemaViolation,
  CollectionNotFound,
  DocumentConflict,
  DocumentNotFound,
  IndexExists,
  InvalidIndex,
  UniqueViolation,
  CheckViolation,
  InvalidConstraint,
  ConstraintExists,
  ReferenceViolation,
  UnembeddedCollection,
  VectorShapeMismatch,
} from "./errors.js";
import type { DbError } from "./errors.js";
import { decodeOrderedTuple } from "./keys.js";
import { isUsableVector, normalized } from "./vectors.js";
import { type Seq } from "./model.js";
import { equals } from "./query.js";
import type { OrderedCursor, Txn } from "./store.js";

import { describeFields, describeFilter, describeVector, edgeTypeFor, hasValue, normalizeAnalyzer, normalizeCheck, normalizeColumns, normalizeEdge, normalizeEmbedding, normalizeIndex, normalizeMeasure, normalizeReference, normalizeSpatial, sameFields, satisfiesCheck } from "./document-definitions.js";
import { covers, indexTuple, validateDocumentData } from "./document-indexing.js";
import { type Analyzer, type CheckConstraint, type DerivedDeclarationSet, type Document, type DocumentFilter, type DocumentWritten, type EdgeDefinition, type EmbeddingIndex, type MeasureDefinition, type ReferenceConstraint, type SpatialIndex } from "./document-model.js";
import { matches } from "./document-planner.js";
import { COLLECTION_MARKER, type Pending, RECEIPT_MARKER, type StoredCollection, type StoredIndex, claimOf, collectionColumn, collectionNs, collectionRecord, columnFor, decode, documentNs, documentRecord, encode, fingerprintOf, idempotencyColumn, indexColumnFor, nameOf, nothingPending, publicCollection, publicIndex, readPath, receiptRecord, setPath, validateName } from "./document-records.js";
import type { DocumentCore } from "./document-core.js";
import type { DocumentReads } from "./document-reads.js";
import type { DocumentsApi } from "./document-model.js";
import { recordMessages, settleMessages } from "./outbox.js";
import { deriveDeclarations, type DerivedDeclarations } from "./schema/semantics.js";
import { REDERIVING_NAMESPACE } from "./tenancy.js";

const withoutSkipped = ({ skipped: _skipped, ...declarations }: DerivedDeclarations): DerivedDeclarationSet => declarations;

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The declarations a document's postings derive from: what `mergeDerived` can change that a rewrite re-derives. */
const lensDeclarations = (collection: StoredCollection) => ({
  analyzer: collection.analyzer, spatial: collection.spatial, embedding: collection.embedding,
  measures: collection.measures ?? [], edges: collection.edges ?? [],
});

/** A derived set checked by the same rules as a hand-made declaration. */
const normalizeDerived = (collection: string, declarations: DerivedDeclarationSet) =>
  Effect.gen(function* () {
    const measures: Array<MeasureDefinition> = [];
    for (const measure of declarations.measures) measures.push(yield* normalizeMeasure(collection, measure));
    const edges: Array<EdgeDefinition> = [];
    for (const edge of declarations.edges) edges.push(yield* normalizeEdge(collection, edge));
    return {
      schemaVersion: declarations.schemaVersion,
      ...(declarations.analyzer === undefined ? {} : { analyzer: yield* normalizeAnalyzer(collection, declarations.analyzer) }),
      measures,
      edges,
      ...(declarations.spatial === undefined ? {} : { spatial: yield* normalizeSpatial(collection, declarations.spatial) }),
      ...(declarations.embedding === undefined ? {} : { embedding: yield* normalizeEmbedding(collection, declarations.embedding) }),
    } satisfies DerivedDeclarationSet;
  });

/**
 * A collection with its previous derivation replaced by the next one.
 *
 * A previously derived declaration is taken off only while it is still exactly
 * what was derived: one redeclared by hand since is the caller's, and stays.
 * The next derivation fills only what nothing declared by hand occupies. Pure,
 * so applying the same set twice gives the same record.
 */
const mergeDerived = (current: StoredCollection, next: DerivedDeclarationSet | undefined) => {
  const previous = current.derived;
  const skipped: Array<{ readonly path: string; readonly reason: string }> = [];
  const keepAnalyzer = previous?.analyzer !== undefined && sameJson(current.analyzer, previous.analyzer) ? undefined : current.analyzer;
  const keepSpatial = previous?.spatial !== undefined && sameJson(current.spatial, previous.spatial) ? undefined : current.spatial;
  const keepEmbedding = previous?.embedding !== undefined && sameJson(current.embedding, previous.embedding) ? undefined : current.embedding;
  const keepMeasures = (current.measures ?? []).filter((measure) =>
    !(previous?.measures ?? []).some((derived) => sameJson(derived, measure)));
  const keepEdges = (current.edges ?? []).filter((edge) =>
    !(previous?.edges ?? []).some((derived) => sameJson(derived, edge)));

  const declaredByHand = (path: string, what: string) =>
    skipped.push({ path, reason: `the collection declares its ${what} by hand` });
  let analyzer = keepAnalyzer;
  let derivedAnalyzer: Analyzer | undefined;
  if (next?.analyzer !== undefined) {
    if (analyzer === undefined) analyzer = derivedAnalyzer = next.analyzer;
    else for (const path of next.analyzer.fields) declaredByHand(path, "analyzer");
  }
  let spatial = keepSpatial;
  let derivedSpatial: SpatialIndex | undefined;
  if (next?.spatial !== undefined) {
    if (spatial === undefined) spatial = derivedSpatial = next.spatial;
    else for (const path of next.spatial.fields) declaredByHand(path, "spatial index");
  }
  let embedding = keepEmbedding;
  let derivedEmbedding: EmbeddingIndex | undefined;
  if (next?.embedding !== undefined) {
    if (embedding === undefined) embedding = derivedEmbedding = next.embedding;
    else declaredByHand(next.embedding.field, "embedding");
  }
  const measures = [...keepMeasures];
  const derivedMeasures: Array<MeasureDefinition> = [];
  for (const measure of next?.measures ?? []) {
    if (measures.some((other) => other.name === measure.name)) declaredByHand(measure.path, `measure "${measure.name}"`);
    else { measures.push(measure); derivedMeasures.push(measure); }
  }
  const edges = [...keepEdges];
  const derivedEdges: Array<EdgeDefinition> = [];
  for (const edge of next?.edges ?? []) {
    if (edges.some((other) => other.name === edge.name)) declaredByHand(edge.path, `edge "${edge.name}"`);
    else { edges.push(edge); derivedEdges.push(edge); }
  }
  const applied: DerivedDeclarationSet | undefined = next === undefined ? undefined : {
    schemaVersion: next.schemaVersion,
    ...(derivedAnalyzer === undefined ? {} : { analyzer: derivedAnalyzer }),
    measures: derivedMeasures,
    edges: derivedEdges,
    ...(derivedSpatial === undefined ? {} : { spatial: derivedSpatial }),
    ...(derivedEmbedding === undefined ? {} : { embedding: derivedEmbedding }),
  };
  const {
    analyzer: _analyzer, spatial: _spatial, embedding: _embedding, measures: _measures, edges: _edges,
    derived: _derived, ...rest
  } = current;
  const collection: StoredCollection = {
    ...rest,
    ...(analyzer === undefined ? {} : { analyzer }),
    ...(spatial === undefined ? {} : { spatial }),
    ...(embedding === undefined ? {} : { embedding }),
    ...(edges.length === 0 ? {} : { edges }),
    ...(measures.length === 0 ? {} : { measures }),
    ...(applied === undefined ? {} : { derived: applied }),
  };
  return {
    collection,
    applied: applied ?? { schemaVersion: previous?.schemaVersion ?? 1, measures: [], edges: [] },
    skipped,
  };
};


/**
 * More of the same batch, for this package's own use: a durable entity's message is marked finished, its state
 * written, in the transaction that commits what its handler wrote. Keyed by a symbol, so nothing that arrives as
 * JSON can carry it. It runs after the batch's changes and messages, and a failure refuses the whole batch.
 */
export const WRITE_ALONG: unique symbol = Symbol("zelavis.db.writeAlong");
export interface WriteAlongInput {
  /** Its failures refuse the batch and reach the caller of `write` untyped: the caller names and catches them. */
  readonly [WRITE_ALONG]?: (txn: Txn) => Effect.Effect<void, unknown>;
}

/**
 * Documents recreated as they were in another database, for this package's own use: the data-layout migration inserts
 * each document with the version and times the earlier engine held, so a client holding a version read before the
 * migration is judged against the same number afterwards. Restarting at one would let a stale `expectedVersion` match
 * again once the document had been written that many times, and its write would overwrite newer data. One entry per
 * operation, read only for an Insert (an absent entry inserts as usual). Keyed by a symbol, so nothing that arrives as
 * JSON can carry it.
 */
export const CARRY_DOCUMENTS: unique symbol = Symbol("zelavis.db.carryDocuments");
export interface CarriedDocument {
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface CarryDocumentsInput {
  readonly [CARRY_DOCUMENTS]?: ReadonlyArray<CarriedDocument | undefined>;
}

/**
 * A collection recreated as it was in another database, for this package's own use: the data-layout migration creates
 * each collection with the creation time the earlier engine recorded, and stamps the creation's events `at` (the time of
 * the first event of the history it replays next), so the Tenant's log reads in time order. Keyed by a symbol, so nothing
 * that arrives as JSON can carry it.
 */
export const CARRY_COLLECTION: unique symbol = Symbol("zelavis.db.carryCollection");
export interface CarriedCollection {
  /** ISO 8601, as the earlier engine stored it. */
  readonly createdAt: string;
  /** Epoch milliseconds, a safe integer of at least 0. */
  readonly at: number;
}
export interface CarryCollectionInput {
  readonly [CARRY_COLLECTION]?: CarriedCollection;
}

/**
 * An earlier engine's document history, replayed for this package's own use by the data-layout migration: each change is
 * one event of that history, written as one event here, at its own time, with the version and times it carried. A replay
 * refuses nothing the earlier engine accepted — every change was judged by it under the rules of its time, and its
 * cascades are changes of their own — except data this engine cannot store; `Settle` then holds the final state to
 * today's constraints. Keyed by a symbol, so nothing that arrives as JSON can carry it.
 */
export const REPLAY_HISTORY: unique symbol = Symbol("zelavis.db.replayHistory");
export type ReplayedChange =
  | {
      readonly _tag: "Put";
      readonly collection: string;
      readonly id: string;
      readonly data: JsonObject;
      /** The document version the earlier engine wrote; never below the live document's. */
      readonly version: number;
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly expiresAt?: string;
      /** When the earlier engine accepted it, in epoch milliseconds. */
      readonly at: number;
    }
  | {
      readonly _tag: "Retract";
      readonly collection: string;
      readonly id: string;
      readonly at: number;
    };
export type ReplayRequest =
  /** 1 to 1000 changes, in history order, in one transaction. */
  | { readonly _tag: "Changes"; readonly changes: ReadonlyArray<ReplayedChange> }
  /** 1 to 1000 live documents of one collection, checked against its constraints; writes nothing. */
  | { readonly _tag: "Settle"; readonly collection: string; readonly ids: ReadonlyArray<string> };
export interface ReplayHistoryInput {
  readonly [REPLAY_HISTORY]?: ReplayRequest;
}

/** Changes one batch may carry, bounding what one transaction holds. */
const MAX_BATCH = 1000;

/** A record found by its name alone. */
const NO_POSTINGS = { terms: [], columns: [], measures: [], edges: [] };

const isStamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isTime = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));

const isCarriedDocument = (value: CarriedDocument): boolean =>
  Number.isSafeInteger(value.version) && value.version >= 1 &&
  typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt)) &&
  typeof value.updatedAt === "string" && !Number.isNaN(Date.parse(value.updatedAt));

const isCarriedCollection = (value: CarriedCollection): boolean =>
  typeof value === "object" && value !== null && isTime(value.createdAt) && isStamp(value.at);

const isReplayedChange = (value: ReplayedChange): boolean =>
  typeof value === "object" && value !== null && typeof value.collection === "string" && typeof value.id === "string" && isStamp(value.at)
  && (value._tag === "Retract"
    || (value._tag === "Put" && typeof value.data === "object" && value.data !== null && !Array.isArray(value.data)
      && Number.isSafeInteger(value.version) && value.version >= 1 && isTime(value.createdAt) && isTime(value.updatedAt)
      && (value.expiresAt === undefined || typeof value.expiresAt === "string")));

const isReplayRequest = (value: ReplayRequest): boolean =>
  typeof value === "object" && value !== null
  && ((value._tag === "Changes" && Array.isArray(value.changes) && value.changes.length >= 1 && value.changes.length <= MAX_BATCH
      && value.changes.every(isReplayedChange))
    || (value._tag === "Settle" && typeof value.collection === "string" && Array.isArray(value.ids)
      && value.ids.length >= 1 && value.ids.length <= MAX_BATCH && value.ids.every((id) => typeof id === "string")));

export const documentWrites = (core: DocumentCore, reads: DocumentReads) => {
  const {
    store, enforceSchema, lookup, readObject, nextSeq, resolveQuery, write, projectionIndexes,
    receiptFor, transactChecked, commitOnce, loadCollection, requireCollection, readDocument,
    assertNotMoving, spatialHandle, transactOrDie, collectionPut, linkTargets, unlinkReference,
    manifestFor, currentAt, currentNamed, remember, forget,
  } = core;
  const { orderedPage, rebuildIndex, findDocuments } = reads;
  /**
   * Refuse a document its collection's constraints do not allow: a check it
   * fails, or values a unique index already has another document holding.
   * Called inside the transaction that writes the document, under the store's
   * one writer, so nothing it compares against can change before the write.
   */
  const enforceConstraints = (
    collection: StoredCollection | undefined,
    doc: Document,
    seq: Seq,
    pending: Pending,
  ): Effect.Effect<
    ReadonlyArray<readonly [string, Seq]>,
    CheckViolation | UniqueViolation | ReferenceViolation | VectorShapeMismatch | DbError
  > =>
    Effect.gen(function* () {
      const embedding = collection?.embedding;
      if (embedding !== undefined) {
        const wrong = describeVector(embedding, readPath(doc.data, embedding.field));
        if (wrong !== undefined) {
          return yield* new VectorShapeMismatch({
            collection: doc.collection, id: doc.id, field: embedding.field, reason: wrong,
          });
        }
      }
      for (const check of collection?.checks ?? []) {
        const failed = check.where.find((filter) => !satisfiesCheck(doc.data, filter));
        if (failed !== undefined) {
          return yield* new CheckViolation({
            collection: doc.collection, id: doc.id, check: check.name, reason: `${describeFilter(failed)} does not hold`,
          });
        }
      }
      for (const reference of collection?.references ?? []) {
        const value = readPath(doc.data, reference.path);
        if (value === undefined || value === null) continue;
        const refused = (reason: string) =>
          new ReferenceViolation({ collection: doc.collection, id: doc.id, reference: reference.name, reason });
        if (typeof value !== "string") {
          return yield* refused(`${reference.path} holds ${JSON.stringify(value)}, which is not a document id`);
        }
        // A document may name itself; it does not exist until this write lands.
        if (reference.collection === doc.collection && value === doc.id) continue;
        // Named in this transaction counts: an author and a post naming it can
        // be written together, and one deleted here no longer counts.
        const named = yield* currentNamed(pending, reference.collection, value);
        if (named === undefined || named.document === null) {
          return yield* refused(`there is no document "${value}" in "${reference.collection}"`);
        }
      }
      for (const index of collection?.indexes ?? []) {
        // A building index is checked once, whole, when it becomes ready.
        if (index.unique !== true || index.state !== "ready") continue;
        if (index.fields.some((field) => !hasValue(readPath(doc.data, field.path)))) continue;
        const tuple = indexTuple(index, doc.data);
        // Taken earlier in this transaction, which the postings do not show yet.
        const claimant = pending.claimed.get(claimOf(index.column, tuple));
        if (claimant !== undefined && claimant !== nameOf(doc.collection, doc.id)) {
          return yield* new UniqueViolation({
            collection: doc.collection, index: index.name, id: doc.id,
            holder: claimant.slice(claimant.indexOf("/") + 1),
          });
        }
        const holders = yield* Stream.runCollect(resolveQuery(equals(index.column, tuple)));
        for (const other of holders) {
          if (Number(other) === Number(seq)) continue;
          // A holder this transaction has deleted, or moved off the value, holds it no longer.
          const holder = yield* currentAt(pending, other);
          if (holder === undefined || indexTuple(index, holder.data) !== tuple) continue;
          return yield* new UniqueViolation({
            collection: doc.collection, index: index.name, id: doc.id, holder: holder.id,
          });
        }
      }
      // Resolved here because this is where a target is already being read
      // under the writer's one permit: the overlay counts, so a document and
      // the ones it links to can be written together.
      const edges: Array<readonly [string, Seq]> = [];
      for (const definition of collection?.edges ?? []) {
        const value = readPath(doc.data, definition.path);
        if (value === undefined || value === null) continue;
        const ids = Array.isArray(value) ? value : [value];
        const type = edgeTypeFor(doc.collection, definition.name);
        for (const id of ids) {
          const refused = (reason: string) =>
            new ReferenceViolation({
              collection: doc.collection, id: doc.id, reference: definition.name, reason,
            });
          if (typeof id !== "string") {
            return yield* refused(`${definition.path} holds ${JSON.stringify(id)}, which is not a document id`);
          }
          if (definition.collection === doc.collection && id === doc.id) {
            edges.push([type, seq]);
            continue;
          }
          const named = yield* currentNamed(pending, definition.collection, id);
          if (named === undefined || named.document === null) {
            return yield* refused(`there is no document "${id}" in "${definition.collection}"`);
          }
          edges.push([type, named.seq]);
        }
      }
      return edges;
    });

  /**
   * Write a document with every posting it contributes, its indexes' included,
   * once its collection's constraints allow it.
   *
   * The collection is read here, inside the transaction, and not by the
   * caller. A transaction holds the store's one writer, so an index or a check
   * added alongside this write was either recorded before it — and applies —
   * or after it, and what adds it reads this document. Read before the
   * transaction, the write could land between the two and escape both.
   *
   * A caller that has already read the record in this transaction passes it
   * rather than paying for it twice.
   */
  const documentPut = (
    txn: Txn,
    doc: Document,
    seq: Seq,
    pending: Pending,
    loaded?: StoredCollection,
  ) =>
    Effect.gen(function* () {
      const collection = loaded ?? (yield* loadCollection(doc.collection));
      const edges = yield* enforceConstraints(collection, doc, seq, pending);
      yield* putDocument(txn, doc, seq, pending, collection, edges);
    });

  /**
   * Write a document with the postings its collection's definition derives and
   * the given links, and remember it in the overlay. Checks nothing:
   * `documentPut` checks first, and a history replay checks the final state
   * with `Settle`.
   */
  const putDocument = (
    txn: Txn,
    doc: Document,
    seq: Seq,
    pending: Pending,
    collection: StoredCollection | undefined,
    edges: ReadonlyArray<readonly [string, Seq]>,
  ) =>
    Effect.gen(function* () {
      const cells = yield* spatialHandle(collection?.spatial);
      yield* txn.put(seq, encode(doc), manifestFor(
        doc, collection?.indexes ?? [], collection?.analyzer, collection?.spatial, cells, edges,
        collection?.measures ?? [], collection?.columns,
      ), {
        namespace: documentNs(doc.collection), key: doc.id,
      });
      remember(pending, collection, doc, seq);
      const proj = projectionIndexes.get(doc.collection);
      if (proj !== undefined && collection?.embedding !== undefined) {
        const held = readPath(doc.data, collection.embedding.field);
        if (isUsableVector(held) && held.length === collection.embedding.dimension) {
          const unit = collection.embedding.normalize === true;
          proj.add(Number(seq), unit ? normalized(held) : held);
        }
      }
    });

  const documentRetract = (txn: Txn, doc: Document, seq: Seq, pending: Pending) =>
    Effect.gen(function* () {
      yield* txn.retract(seq);
      forget(pending, doc, seq);
      const proj = projectionIndexes.get(doc.collection);
      if (proj !== undefined) {
        proj.remove(Number(seq));
      }
    });

  /**
   * A replayed document's links, re-derived and not re-checked, as `rewriteDocuments` does: every change of the history
   * was accepted once already, so a target not there at that moment of it leaves its link unposted. Read through the
   * batch's overlay, so a target written earlier in the batch counts and one retracted earlier does not.
   */
  const replayLinks = (collection: StoredCollection, doc: Document, seq: Seq, pending: Pending) =>
    Effect.gen(function* () {
      const links: Array<readonly [string, Seq]> = [];
      for (const definition of collection.edges ?? []) {
        const value = readPath(doc.data, definition.path);
        if (value === undefined || value === null) continue;
        const type = edgeTypeFor(doc.collection, definition.name);
        for (const id of Array.isArray(value) ? value : [value]) {
          if (typeof id !== "string") continue;
          if (definition.collection === doc.collection && id === doc.id) {
            links.push([type, seq]);
            continue;
          }
          const named = yield* currentNamed(pending, definition.collection, id);
          if (named !== undefined && named.document !== null) links.push([type, named.seq]);
        }
      }
      return links;
    });

  /** One replayed batch: each change one event, at its own time, in one transaction; see `REPLAY_HISTORY`. */
  const replayChanges = (changes: ReadonlyArray<ReplayedChange>) =>
    Effect.gen(function* () {
      for (const change of changes) {
        if (change._tag === "Put") yield* validateDocumentData(change.collection, change.data);
      }
      return yield* transactChecked((txn) =>
        Effect.gen(function* () {
          const pending = nothingPending();
          for (const change of changes) {
            const collection = yield* requireCollection(change.collection);
            const at = yield* currentNamed(pending, change.collection, change.id);
            const live = at === undefined || at.document === null ? undefined : { seq: at.seq, document: at.document };
            const stamped = txn.stampedAt(change.at);
            if (change._tag === "Retract") {
              if (live === undefined) {
                return yield* new DocumentNotFound({ collection: change.collection, id: change.id });
              }
              yield* documentRetract(stamped, live.document, live.seq, pending);
              continue;
            }
            if (live !== undefined && change.version < live.document.version) {
              return yield* new DocumentConflict({
                collection: change.collection, id: change.id,
                reason: `a replayed change moves version ${live.document.version} back to ${change.version}`,
              });
            }
            const seq = live?.seq ?? (yield* txn.allocate);
            const doc: Document = {
              id: change.id, collection: change.collection, data: change.data,
              createdAt: change.createdAt, updatedAt: change.updatedAt, version: change.version,
              ...(change.expiresAt === undefined ? {} : { expiresAt: change.expiresAt }),
            };
            yield* putDocument(stamped, doc, seq, pending, collection, yield* replayLinks(collection, doc, seq, pending));
          }
          return [] as ReadonlyArray<DocumentWritten>;
        }));
    });

  /**
   * Hold replayed documents to their collection's constraints as they stand now: what a replay did not check, because the
   * history it wrote passed through states the earlier engine accepted under the rules of their time. Inside a
   * transaction, under the store's one writer, like every check; it writes nothing.
   */
  const settleReplayed = (name: string, ids: ReadonlyArray<string>) =>
    transactChecked(() =>
      Effect.gen(function* () {
        const pending = nothingPending();
        const collection = yield* requireCollection(name);
        for (const id of ids) {
          const at = yield* currentNamed(pending, name, id);
          if (at === undefined || at.document === null) return yield* new DocumentNotFound({ collection: name, id });
          yield* enforceConstraints(collection, at.document, at.seq, pending);
        }
        return [] as ReadonlyArray<DocumentWritten>;
      }));

  /**
   * What deleting a document does to the documents naming it, each reference
   * deciding for its own: refuse the delete, delete them too, or clear the
   * field. All of it in the delete's own transaction, so either every
   * consequence lands with the delete or none does.
   *
   * Reads inside a transaction see what is committed, not what the
   * transaction has written so far, so the documents this one has already
   * cleared or deleted are carried alongside: a document cleared under two
   * references keeps both, and one reached twice down a cascade — a diamond,
   * or a cycle back to where it began — is deleted once.
   */
  const releaseReferences = (txn: Txn, deleted: Document, deletedSeq: Seq, pending: Pending) =>
    Effect.gen(function* () {
      forget(pending, deleted, deletedSeq);
      const release = (doc: Document): Effect.Effect<
        void,
        ReferenceViolation | SchemaViolation | CheckViolation | UniqueViolation | DbError
        | VectorShapeMismatch
      > =>
        Effect.gen(function* () {
          const named = yield* loadCollection(doc.collection);
          // Gathered per document that names this one, rather than per
          // reference: a document naming it through two fields is written once,
          // with both resolved. Written once per field, it would be checked in
          // between with the other field still naming a document this delete
          // has already taken away.
          const holders = new Map<number, {
            readonly seq: Seq;
            readonly holder: Document;
            readonly from: StoredCollection;
            readonly naming: Array<Required<ReferenceConstraint>>;
          }>();
          for (const back of named?.referencedBy ?? []) {
            const from = back.collection === doc.collection ? named : yield* loadCollection(back.collection);
            const reference = from?.references?.find((candidate) => candidate.name === back.reference);
            if (from === undefined || reference === undefined) continue;
            const found = yield* Stream.runCollect(
              resolveQuery(equals(columnFor(back.collection, reference.path), doc.id)),
            );
            for (const held of found) {
              const holder = yield* currentAt(pending, held);
              // Gone already in this transaction, or no longer naming it.
              if (holder === undefined || readPath(holder.data, reference.path) !== doc.id) continue;
              if (reference.onDelete === "restrict") {
                return yield* new ReferenceViolation({
                  collection: doc.collection, id: doc.id, reference: `${back.collection}.${reference.name}`,
                  reason: `"${holder.id}" in "${back.collection}" names it`,
                });
              }
              const gathered = holders.get(Number(held)) ?? { seq: held, holder, from, naming: [] };
              gathered.naming.push(reference);
              holders.set(Number(held), gathered);
            }
          }
          for (const [at, gathered] of holders) {
            // As it stands now, not as it stood when it was gathered: this
            // pass may have deleted it since — down a cascade from elsewhere —
            // or cleared the very field that named this document.
            const holder = yield* currentAt(pending, gathered.seq);
            if (holder === undefined) continue;
            const naming = gathered.naming.filter(
              (reference) => readPath(holder.data, reference.path) === doc.id);
            if (naming.length === 0) continue;
            // Deleting the document outranks clearing a field of it.
            if (naming.some((reference) => reference.onDelete === "cascade")) {
              forget(pending, holder, gathered.seq);
              yield* release(holder);
              yield* txn.retract(gathered.seq);
              continue;
            }
            let data = holder.data;
            for (const reference of naming) data = setPath(data, reference.path, null);
            yield* enforceSchema(gathered.from.name, data);
            // One change to the document however many of its fields this
            // delete clears: a version already moved here stays where it is.
            const cleared: Document = {
              ...holder, data, updatedAt: new Date().toISOString(),
              version: pending.bySeq.has(at) ? holder.version : holder.version + 1,
            };
            yield* documentPut(txn, cleared, gathered.seq, pending, gathered.from);
          }
        });
      yield* release(deleted);
    });

  /** Insert one document inside a transaction, under everything it must satisfy. */
  const applyInsert = (
    txn: Txn,
    pending: Pending,
    input: {
      readonly collection: string;
      readonly id: string;
      readonly data: JsonObject;
      readonly expiresAt?: string | null;
      readonly ttlMs?: number;
    },
    seq: Seq,
    carried?: CarriedDocument,
  ) =>
    Effect.gen(function* () {
      const collection = yield* requireCollection(input.collection);
      yield* validateDocumentData(input.collection, input.data);
      yield* enforceSchema(input.collection, input.data);
      const taken = yield* currentNamed(pending, input.collection, input.id);
      if (taken !== undefined && taken.document !== null) {
        return yield* new DocumentConflict({
          collection: input.collection, id: input.id, reason: "a document with this id already exists",
        });
      }
      const now = new Date().toISOString();
      const doc: Document = {
        id: input.id, collection: input.collection, data: input.data,
        createdAt: carried?.createdAt ?? now, updatedAt: carried?.updatedAt ?? now, version: carried?.version ?? 1,
        ...(input.ttlMs !== undefined
          ? { expiresAt: new Date(Date.now() + input.ttlMs).toISOString() }
          : typeof input.expiresAt === "string" ? { expiresAt: input.expiresAt } : {}),
      };
      yield* documentPut(txn, doc, seq, pending, collection);
      return doc;
    });

  const applyUpdate = (
    txn: Txn,
    pending: Pending,
    input: {
      readonly collection: string;
      readonly id: string;
      readonly data: JsonObject;
      readonly mode?: "merge" | "replace";
      readonly expectedVersion?: number;
      readonly precondition?: ReadonlyArray<DocumentFilter>;
      readonly expiresAt?: string | null;
      readonly ttlMs?: number;
    },
  ) =>
    Effect.gen(function* () {
      const at = yield* currentNamed(pending, input.collection, input.id);
      if (at === undefined || at.document === null) {
        return yield* new DocumentNotFound({ collection: input.collection, id: input.id });
      }
      const current = at.document;
      yield* expect(input.collection, current, input.expectedVersion, input.precondition);
      const data = (input.mode ?? "merge") === "replace" ? input.data : { ...current.data, ...input.data };
      yield* validateDocumentData(input.collection, data);
      yield* enforceSchema(input.collection, data);
      const next: Document = {
        ...current, data, updatedAt: new Date().toISOString(), version: current.version + 1,
        ...(input.ttlMs !== undefined
          ? { expiresAt: new Date(Date.now() + input.ttlMs).toISOString() }
          : "expiresAt" in input
          ? input.expiresAt === null || input.expiresAt === undefined
            ? { expiresAt: undefined }
            : { expiresAt: input.expiresAt }
          : {}),
      };
      yield* documentPut(txn, next, at.seq, pending);
      return next;
    });

  const applyDelete = (
    txn: Txn,
    pending: Pending,
    input: {
      readonly collection: string;
      readonly id: string;
      readonly expectedVersion?: number;
      readonly precondition?: ReadonlyArray<DocumentFilter>;
    },
  ) =>
    Effect.gen(function* () {
      const at = yield* currentNamed(pending, input.collection, input.id);
      // Not there, or already gone earlier in this transaction.
      if (at === undefined || at.document === null) return false;
      yield* expect(input.collection, at.document, input.expectedVersion, input.precondition);
      yield* releaseReferences(txn, at.document, at.seq, pending);
      yield* documentRetract(txn, at.document, at.seq, pending);
      return true;
    });

  /**
   * The conditions a caller put on a change, checked against the document as
   * it stands inside the transaction: a version, and filters its data must
   * match. Each is a compare-and-set, and holds only because nothing can write
   * the document between the check and the change.
   */
  const expect = (
    collection: string,
    current: Document,
    expectedVersion: number | undefined,
    precondition: ReadonlyArray<DocumentFilter> | undefined,
  ): Effect.Effect<void, DocumentConflict> => {
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      return Effect.fail(new DocumentConflict({
        collection, id: current.id, reason: `expected version ${expectedVersion}, found ${current.version}`,
      }));
    }
    const unmet = precondition?.find((filter) => !matches(current.data, filter));
    return unmet === undefined
      ? Effect.void
      : Effect.fail(new DocumentConflict({
        collection, id: current.id, reason: `the document does not match ${describeFilter(unmet)}`,
      }));
  };

  /**
   * Two documents holding the same values in every field of a unique index,
   * if any do. Equal tuples sit next to each other in the index, so this is
   * one ordered read of it; a tuple missing a value is not held to the index
   * and is passed over.
   */
  const duplicateIn = (index: StoredIndex) =>
    Effect.gen(function* () {
      const directions = index.fields.map((field) => field.direction);
      let previous: { readonly value: unknown; readonly seq: Seq } | undefined;
      let after: OrderedCursor | undefined;
      for (;;) {
        const page = yield* orderedPage({
          column: index.column, limit: 1000, ...(after === undefined ? {} : { after }),
        }).pipe(Effect.orDie);
        for (const row of page.rows) {
          if (previous !== undefined && row.value === previous.value &&
            decodeOrderedTuple(String(row.value), directions).every((value) => value !== undefined)) {
            return [previous.seq, row.seq] as const;
          }
          previous = { value: row.value, seq: row.seq };
        }
        if (page.next === undefined) return undefined;
        after = page.next;
      }
    });

  /** Documents a rewrite puts back per transaction, releasing the writer between them. */
  const REWRITE_CHUNK = 256;

  /**
   * Put every document of a collection back with the postings its indexes now
   * call for: what completes an index built over existing documents, and what
   * clears a dropped one's postings.
   *
   * Each document is read inside the transaction that rewrites it, under the
   * store's one writer, so a concurrent update is never overwritten with what
   * was read before it; and its bytes go back unchanged, so its version and
   * timestamps do not move. Rewriting a document that already has the right
   * postings writes the same ones again, so an interrupted rewrite is finished
   * by running it again.
   */
  const rewriteDocuments = (collection: string) =>
    Effect.gen(function* () {
      const seqs = [...(yield* Stream.runCollect(resolveQuery(equals(collectionColumn(), collection))))];
      let rewritten = 0;
      for (let at = 0; at < seqs.length; at += REWRITE_CHUNK) {
        rewritten += yield* transactOrDie((txn) =>
          Effect.gen(function* () {
            const record = yield* loadCollection(collection);
            const indexes = record?.indexes ?? [];
            const analyzer = record?.analyzer;
            const spatial = record?.spatial;
            const cells = yield* spatialHandle(spatial);
            const definitions = record?.edges ?? [];
            let written = 0;
            for (const seq of seqs.slice(at, at + REWRITE_CHUNK)) {
              const object = yield* readObject(seq);
              if (object === undefined) continue;
              const doc = decode(object.bytes, documentRecord);
              if (doc.collection !== collection) continue;
              // Re-derived, not re-checked: these documents were accepted
              // once already, so a target that has since gone leaves the link
              // unposted rather than failing a rewrite.
              const links: Array<readonly [string, Seq]> = [];
              for (const definition of definitions) {
                const value = readPath(doc.data, definition.path);
                if (value === undefined || value === null) continue;
                const type = edgeTypeFor(collection, definition.name);
                for (const id of Array.isArray(value) ? value : [value]) {
                  if (typeof id !== "string") continue;
                  if (definition.collection === collection && id === doc.id) {
                    links.push([type, seq]);
                    continue;
                  }
                  const at = yield* lookup(documentNs(definition.collection), id);
                  if (at !== undefined) links.push([type, at]);
                }
              }
              yield* txn.put(seq, object.bytes, manifestFor(
                doc, indexes, analyzer, spatial, cells, links, record?.measures ?? [], record?.columns,
              ), {
                namespace: documentNs(collection), key: doc.id,
              });
              written += 1;
            }
            return written;
          }));
      }
      return rewritten;
    });

  /** Where a collection's backfill mark stands, if it does: read inside the transaction that acts on it. */
  const rederivingAt = (collection: string) =>
    Effect.gen(function* () {
      const at = yield* lookup(REDERIVING_NAMESPACE, collection);
      return at === undefined || (yield* readObject(at)) === undefined ? undefined : at;
    });

  const operations = {
    createCollection: (input) =>
      Effect.gen(function* () {
        const carried = (input as CarryCollectionInput)[CARRY_COLLECTION];
        if (carried !== undefined && !isCarriedCollection(carried)) {
          return yield* Effect.die(new RangeError("A carried collection names its creation time and an event time."));
        }
        yield* assertNotMoving;
        yield* validateName(input.name);
        const existing = yield* loadCollection(input.name);
        if (existing !== undefined) return yield* new CollectionExists({ name: input.name });
        const indexes: Array<StoredIndex> = [];
        for (const definition of input.indexes ?? []) {
          const index = yield* normalizeIndex(input.name, definition);
          if (indexes.some((other) => other.name === index.name)) {
            return yield* new InvalidIndex({ collection: input.name, name: index.name, reason: "the name is given twice" });
          }
          indexes.push({ ...index, state: "ready", column: indexColumnFor(input.name, index.name) });
        }
        const checks: Array<CheckConstraint> = [];
        for (const definition of input.checks ?? []) {
          const check = yield* normalizeCheck(input.name, definition);
          if (checks.some((other) => other.name === check.name)) {
            return yield* new InvalidConstraint({ collection: input.name, name: check.name, reason: "the name is given twice" });
          }
          checks.push(check);
        }
        const references: Array<Required<ReferenceConstraint>> = [];
        for (const definition of input.references ?? []) {
          const reference = yield* normalizeReference(input.name, definition);
          if (references.some((other) => other.name === reference.name)) {
            return yield* new InvalidConstraint({ collection: input.name, name: reference.name, reason: "the name is given twice" });
          }
          references.push(reference);
        }
        const analyzer = input.analyzer === undefined
          ? undefined
          : yield* normalizeAnalyzer(input.name, input.analyzer);
        const spatial = input.spatial === undefined
          ? undefined
          : yield* normalizeSpatial(input.name, input.spatial);
        const embedding = input.embedding === undefined
          ? undefined
          : yield* normalizeEmbedding(input.name, input.embedding);
        const measures: Array<MeasureDefinition> = [];
        for (const definition of input.measures ?? []) {
          const declared = yield* normalizeMeasure(input.name, definition);
          if (measures.some((other) => other.name === declared.name)) {
            return yield* new InvalidConstraint({
              collection: input.name, name: declared.name, reason: "the name is given twice",
            });
          }
          measures.push(declared);
        }
        const edges: Array<EdgeDefinition> = [];
        for (const definition of input.edges ?? []) {
          const declared = yield* normalizeEdge(input.name, definition);
          if (edges.some((other) => other.name === declared.name)) {
            return yield* new InvalidConstraint({
              collection: input.name, name: declared.name, reason: "the name is given twice",
            });
          }
          edges.push(declared);
        }
        const columns = input.columns === undefined
          ? undefined
          : yield* normalizeColumns(input.name, input.columns, references);
        const collection: StoredCollection = {
          name: input.name,
          createdAt: carried?.createdAt ?? new Date().toISOString(),
          surface: input.surface ?? "database",
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
          ...(indexes.length === 0 ? {} : { indexes }),
          ...(checks.length === 0 ? {} : { checks }),
          ...(references.length === 0 ? {} : { references }),
          ...(analyzer === undefined ? {} : { analyzer }),
          ...(spatial === undefined ? {} : { spatial }),
          ...(embedding === undefined ? {} : { embedding }),
          ...(edges.length === 0 ? {} : { edges }),
          ...(measures.length === 0 ? {} : { measures }),
          ...(columns === undefined ? {} : { columns }),
        };
        // A schema activated before its collection existed declares on it now,
        // filling only what the input leaves undeclared, as an activation does.
        const active = yield* (core.schemas?.getActive(input.name) ?? Effect.succeed(undefined));
        const implied = active === undefined
          ? undefined
          : yield* normalizeDerived(input.name, withoutSkipped(deriveDeclarations(active.version, active.fields)));
        const declared = implied === undefined ? collection : mergeDerived(collection, implied).collection;
        const seq = yield* nextSeq;
        // The collection and the back-references its targets carry, together:
        // a delete in a target finds what names it from its own record.
        yield* transactChecked((txn) =>
          Effect.gen(function* () {
            const own = references
              .filter((reference) => reference.collection === input.name)
              .map((reference) => ({ collection: input.name, reference: reference.name }));
            // A carried collection's events, its targets' included, happened when the history it precedes began.
            const stamped = carried === undefined ? txn : txn.stampedAt(carried.at);
            yield* collectionPut(stamped, seq, own.length === 0 ? declared : { ...declared, referencedBy: own });
            yield* linkTargets(stamped, input.name, references.filter((reference) => reference.collection !== input.name));
          }));
        return publicCollection(declared);
      }),

    insert: (input) =>
      Effect.gen(function* () {
        yield* validateDocumentData(input.collection, input.data);
        const request = `insert into "${input.collection}"`;
        const fingerprint = fingerprintOf({
          op: "insert", collection: input.collection, id: input.id, data: input.data,
        });
        if (input.idempotencyKey !== undefined) {
          const seen = yield* receiptFor(input.idempotencyKey, fingerprint, request);
          if (seen !== undefined) return seen.result as Document;
        }
        // A generated id would differ on every retry, so a keyed insert without
        // one would store a second document and hand back the first.
        const id = input.id ?? crypto.randomUUID();
        // Allocated before the transaction, which cannot take the writer twice;
        // a refused insert leaves a gap, which nothing depends on not having.
        const seq = yield* nextSeq;
        return yield* commitOnce(input.idempotencyKey, fingerprint, request, (txn) =>
          Effect.gen(function* () {
            return yield* applyInsert(txn, nothingPending(), {
              collection: input.collection, id, data: input.data,
            }, seq);
          }));
      }),

    update: (input) =>
      Effect.gen(function* () {
        yield* validateDocumentData(input.collection, input.data);
        const request = `update "${input.collection}/${input.id}"`;
        const fingerprint = fingerprintOf({
          op: "update", collection: input.collection, id: input.id, data: input.data,
          mode: input.mode, expectedVersion: input.expectedVersion, precondition: input.precondition,
        });
        // The version, the conditions and the data merged into are all read in
        // the transaction that writes, so two updates cannot both build on the
        // same version and have one silently undo the other.
        return yield* commitOnce(input.idempotencyKey, fingerprint, request, (txn) =>
          Effect.gen(function* () {
            return yield* applyUpdate(txn, nothingPending(), input);
          }));
      }),

    delete: (input) =>
      Effect.gen(function* () {
        const request = `delete "${input.collection}/${input.id}"`;
        const fingerprint = fingerprintOf({
          op: "delete", collection: input.collection, id: input.id,
          expectedVersion: input.expectedVersion, precondition: input.precondition,
        });
        return yield* commitOnce(input.idempotencyKey, fingerprint, request, (txn) =>
          Effect.gen(function* () {
            return yield* applyDelete(txn, nothingPending(), input);
          }),
          // Nothing happened, so there is nothing to remember: a later retry
          // that finds the document present should delete it rather than
          // replay a "no" from when it was already gone.
          (deleted) => deleted);
      }),

    dropCollection: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        const collection = yield* loadCollection(input.name);
        if (collection === undefined) return yield* new CollectionNotFound({ name: input.name });

        // A reference from elsewhere is a promise this collection's absence
        // would break. Its own references to itself go with it.
        const foreign = (collection.referencedBy ?? [])
          .filter((back) => back.collection !== input.name);
        if (foreign.length > 0) {
          const naming = [...new Set(foreign.map((back) => back.collection))].join(", ");
          return yield* new ReferenceViolation({
            collection: input.name,
            id: "",
            reference: foreign[0]!.reference,
            reason: `${naming} still references it`,
          });
        }

        // Emptied a page at a time: one transaction holding every document of
        // a large collection is a transaction that may not fit.
        for (;;) {
          // Unfiltered and unordered, so no field needs an index.
          const page = yield* findDocuments({ collection: input.name, limit: 500 })
            .pipe(Effect.catchTag("UnindexedField", Effect.die));
          if (page.length === 0) break;
          yield* transactChecked((txn) =>
            Effect.gen(function* () {
              const pending = nothingPending();
              for (const document of page) {
                yield* applyDelete(txn, pending, { collection: input.name, id: document.id });
              }
            }));
        }

        yield* transactChecked((txn) =>
          Effect.gen(function* () {
            for (const reference of collection.references ?? []) {
              if (reference.collection === input.name) continue;
              yield* unlinkReference(txn, input.name, reference.name);
            }
            const seq = yield* lookup(collectionNs(), input.name);
            if (seq !== undefined) yield* txn.retract(seq);
          }));
        return true;
      }),

    createIndex: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        const definition = yield* normalizeIndex(input.collection, input);
        const seq = yield* lookup(collectionNs(), input.collection);
        if (seq === undefined) return yield* new CollectionNotFound({ name: input.collection });
        // Recorded first, as building: every write from here on carries it,
        // and the rewrite below adds every document written before.
        const recorded = yield* transactOrDie((txn) =>
          Effect.gen(function* () {
            const current = yield* loadCollection(input.collection);
            if (current === undefined) return undefined;
            const existing = current.indexes?.find((index) => index.name === definition.name);
            if (existing !== undefined) return existing;
            const index: StoredIndex = {
              ...definition,
              state: "building",
              column: indexColumnFor(input.collection, definition.name),
            };
            yield* collectionPut(txn, seq, { ...current, indexes: [...(current.indexes ?? []), index] });
            return index;
          }));
        if (recorded === undefined) return yield* new CollectionNotFound({ name: input.collection });
        if (!sameFields(recorded.fields, definition.fields) || (recorded.unique === true) !== definition.unique) {
          return yield* new IndexExists({
            collection: input.collection,
            name: definition.name,
            reason: `it is defined over ${describeFields(recorded.fields)}${recorded.unique === true ? ", unique" : ""}`,
          });
        }
        if (recorded.state === "ready") return publicIndex(recorded);
        // A building index found here may be one an earlier call did not
        // finish; rewriting is idempotent, so finishing it is running it again.
        yield* rewriteDocuments(input.collection);
        // Ready, or — for a unique index the documents already break — gone,
        // decided in one transaction: no write can slip a duplicate in between
        // the check and the index starting to refuse them.
        const outcome = yield* transactOrDie((txn) =>
          Effect.gen(function* () {
            const current = yield* loadCollection(input.collection);
            const indexes = current?.indexes ?? [];
            if (current === undefined || !indexes.some((index) => index.column === recorded.column)) {
              return { _tag: "dropped" } as const;
            }
            const clash = recorded.unique === true ? yield* duplicateIn(recorded) : undefined;
            if (clash !== undefined) {
              yield* collectionPut(txn, seq, {
                ...current,
                indexes: indexes.filter((index) => index.column !== recorded.column),
              });
              return { _tag: "duplicate", clash } as const;
            }
            yield* collectionPut(txn, seq, {
              ...current,
              indexes: indexes.map((index) =>
                index.column === recorded.column ? { ...index, state: "ready" as const } : index),
            });
            return { _tag: "ready" } as const;
          }));
        if (outcome._tag === "duplicate") {
          yield* rewriteDocuments(input.collection);
          const [first, second] = yield* Effect.forEach(outcome.clash, (held) => readDocument(held));
          return yield* new UniqueViolation({
            collection: input.collection, index: definition.name,
            id: second?.id ?? "?", holder: first?.id ?? "?",
          });
        }
        // Dropped while it was being built: what it was is all there is to say.
        return outcome._tag === "ready" ? { ...publicIndex(recorded), state: "ready" } : publicIndex(recorded);
      }),

    dropIndex: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        const seq = yield* lookup(collectionNs(), input.collection);
        if (seq === undefined) return yield* new CollectionNotFound({ name: input.collection });
        const dropped = yield* transactOrDie((txn) =>
          Effect.gen(function* () {
            const current = yield* loadCollection(input.collection);
            const indexes = current?.indexes ?? [];
            if (current === undefined || !indexes.some((index) => index.name === input.name)) return false;
            yield* collectionPut(txn, seq, {
              ...current,
              indexes: indexes.filter((index) => index.name !== input.name),
            });
            return true;
          }));
        // Nothing reads the postings once the index is gone — the column was
        // its alone — and each document's next write would drop them anyway.
        // Clearing them now is what returns the space.
        if (dropped) yield* rewriteDocuments(input.collection);
        return dropped;
      }),

    addCheck: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        const check = yield* normalizeCheck(input.collection, input);
        const seq = yield* lookup(collectionNs(), input.collection);
        if (seq === undefined) return yield* new CollectionNotFound({ name: input.collection });
        // Recorded first, so every write from here on is held to it; then the
        // documents already there are read against it. A write refused in
        // between was refused by a check its caller had asked for.
        const recorded = yield* transactOrDie((txn) =>
          Effect.gen(function* () {
            const current = yield* loadCollection(input.collection);
            if (current === undefined) return "missing" as const;
            if ((current.checks ?? []).some((other) => other.name === check.name)) return "exists" as const;
            yield* collectionPut(txn, seq, { ...current, checks: [...(current.checks ?? []), check] });
            return "added" as const;
          }));
        if (recorded === "missing") return yield* new CollectionNotFound({ name: input.collection });
        if (recorded === "exists") return yield* new ConstraintExists({ collection: input.collection, name: check.name });
        for (const held of yield* Stream.runCollect(resolveQuery(equals(collectionColumn(), input.collection)))) {
          const doc = yield* readDocument(held);
          const failed = doc === undefined ? undefined : check.where.find((filter) => !satisfiesCheck(doc.data, filter));
          if (doc === undefined || failed === undefined) continue;
          yield* transactOrDie((txn) =>
            Effect.gen(function* () {
              const current = yield* loadCollection(input.collection);
              if (current === undefined) return;
              yield* collectionPut(txn, seq, {
                ...current, checks: (current.checks ?? []).filter((other) => other.name !== check.name),
              });
            }));
          return yield* new CheckViolation({
            collection: input.collection, id: doc.id, check: check.name,
            reason: `${describeFilter(failed)} does not hold, so the check was not added`,
          });
        }
        return check;
      }),

    analyze: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        const analyzer = yield* normalizeAnalyzer(input.collection, input.analyzer);
        const seq = yield* lookup(collectionNs(), input.collection);
        if (seq === undefined) return yield* new CollectionNotFound({ name: input.collection });
        // Recorded first, so every write from here on analyzes this way; the
        // documents already there are then written back under it.
        const recorded = yield* transactOrDie((txn) =>
          Effect.gen(function* () {
            const current = yield* loadCollection(input.collection);
            if (current === undefined) return false;
            yield* collectionPut(txn, seq, { ...current, analyzer });
            return true;
          }));
        if (!recorded) return yield* new CollectionNotFound({ name: input.collection });
        return { analyzer, documents: yield* rewriteDocuments(input.collection) };
      }),

    setColumns: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        const seq = yield* lookup(collectionNs(), input.collection);
        if (seq === undefined) return yield* new CollectionNotFound({ name: input.collection });
        // Checked against the references inside the transaction that records
        // it, so a reference added meanwhile cannot be left reading nothing.
        const recorded = yield* transactChecked<
          { readonly columns: ReadonlyArray<string> | undefined } | undefined, InvalidConstraint
        >((txn) =>
          Effect.gen(function* () {
            const current = yield* loadCollection(input.collection);
            if (current === undefined) return undefined;
            const columns = input.columns === null
              ? undefined
              : yield* normalizeColumns(input.collection, input.columns, current.references ?? []);
            const { columns: _previous, ...rest } = current;
            yield* collectionPut(txn, seq, columns === undefined ? rest : { ...rest, columns });
            return { columns };
          }));
        if (recorded === undefined) return yield* new CollectionNotFound({ name: input.collection });
        return { columns: recorded.columns ?? null, documents: yield* rewriteDocuments(input.collection) };
      }),

    locate: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        const spatial = yield* normalizeSpatial(input.collection, input.spatial);
        const seq = yield* lookup(collectionNs(), input.collection);
        if (seq === undefined) return yield* new CollectionNotFound({ name: input.collection });
        const recorded = yield* transactOrDie((txn) =>
          Effect.gen(function* () {
            const current = yield* loadCollection(input.collection);
            if (current === undefined) return false;
            yield* collectionPut(txn, seq, { ...current, spatial });
            return true;
          }));
        if (!recorded) return yield* new CollectionNotFound({ name: input.collection });
        return { spatial, documents: yield* rewriteDocuments(input.collection) };
      }),

    embed: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        const embedding = yield* normalizeEmbedding(input.collection, input.embedding);
        const seq = yield* lookup(collectionNs(), input.collection);
        if (seq === undefined) return yield* new CollectionNotFound({ name: input.collection });
        // Recorded first, so every write from here on is held to the shape;
        // then the documents already there are read against it.
        const recorded = yield* transactOrDie((txn) =>
          Effect.gen(function* () {
            const current = yield* loadCollection(input.collection);
            if (current === undefined) return false;
            yield* collectionPut(txn, seq, { ...current, embedding });
            return true;
          }));
        if (!recorded) return yield* new CollectionNotFound({ name: input.collection });
        let documents = 0;
        for (const held of yield* Stream.runCollect(resolveQuery(equals(collectionColumn(), input.collection)))) {
          const doc = yield* readDocument(held);
          if (doc === undefined) continue;
          const wrong = describeVector(embedding, readPath(doc.data, embedding.field));
          if (wrong === undefined) {
            documents += 1;
            continue;
          }
          // Take it back off: a declaration that its own documents fail is
          // worse than none, because every later read would trust it.
          yield* transactOrDie((txn) =>
            Effect.gen(function* () {
              const current = yield* loadCollection(input.collection);
              if (current === undefined) return;
              const { embedding: _withdrawn, ...rest } = current;
              yield* collectionPut(txn, seq, rest);
            }));
          return yield* new VectorShapeMismatch({
            collection: input.collection, id: doc.id, field: embedding.field,
            reason: `${wrong}, so the embedding was not declared`,
          });
        }
        return { embedding, documents };
      }),

    declareFromSchema: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        const seq = yield* lookup(collectionNs(), input.collection);
        if (seq === undefined) return yield* new CollectionNotFound({ name: input.collection });
        // Normalized like a hand-made declaration, so a derived one is held to
        // the same rules and stored in the same shape.
        const wanted = yield* normalizeDerived(input.collection, input.declarations);
        // Postings are re-derived only when what they derive from changed: a
        // rewrite is one event per document, and one that changes no posting
        // would add them, and time-series points with them, for nothing. A
        // mark is committed with the declarations and stands until the
        // documents are written back, so a run cut off between the two is
        // finished by the next one, although that one finds the declarations
        // already as it wants them.
        const recorded = yield* transactOrDie((txn) =>
          Effect.gen(function* () {
            const current = yield* loadCollection(input.collection);
            if (current === undefined) return undefined;
            const merged = mergeDerived(current, wanted);
            const unfinished = yield* rederivingAt(input.collection);
            const rederive = unfinished !== undefined
              || !sameJson(lensDeclarations(current), lensDeclarations(merged.collection));
            yield* collectionPut(txn, seq, merged.collection);
            if (rederive && unfinished === undefined) {
              const at = (yield* lookup(REDERIVING_NAMESPACE, input.collection)) ?? (yield* txn.allocate);
              yield* txn.put(at, encode({ collection: input.collection }), NO_POSTINGS, {
                namespace: REDERIVING_NAMESPACE, key: input.collection,
              });
            }
            return { before: current, ...merged, rederive };
          }));
        if (recorded === undefined) return yield* new CollectionNotFound({ name: input.collection });
        /**
         * Take the mark off once the documents are written back, while the
         * collection still declares what this run left it declaring: another
         * run's declarations recorded meanwhile keep the mark for that run's
         * own backfill. A collection dropped meanwhile has nothing left to
         * write back.
         */
        const rederived = (left: StoredCollection | undefined) =>
          transactOrDie((txn) =>
            Effect.gen(function* () {
              const current = yield* loadCollection(input.collection);
              if (current !== undefined && left !== undefined
                && !(sameJson(lensDeclarations(current), lensDeclarations(left)) && sameJson(current.derived, left.derived))) return;
              const at = yield* rederivingAt(input.collection);
              if (at !== undefined) yield* txn.retract(at);
            }));
        const documents = recorded.rederive ? yield* rewriteDocuments(input.collection) : 0;
        const embedding = recorded.applied.embedding;
        if (embedding !== undefined) {
          for (const held of yield* Stream.runCollect(resolveQuery(equals(collectionColumn(), input.collection)))) {
            const doc = yield* readDocument(held);
            if (doc === undefined) continue;
            const wrong = describeVector(embedding, readPath(doc.data, embedding.field));
            if (wrong === undefined) continue;
            // The whole set comes back off, and the previous derivation goes
            // back on: an activation either applies everything it derived or
            // leaves the collection declared as it was.
            const withdrawn = yield* transactOrDie((txn) =>
              Effect.gen(function* () {
                const current = yield* loadCollection(input.collection);
                if (current === undefined) return undefined;
                const left = mergeDerived(current, recorded.before.derived).collection;
                yield* collectionPut(txn, seq, left);
                return left;
              }));
            if (recorded.rederive) {
              yield* rewriteDocuments(input.collection);
              yield* rederived(withdrawn);
            }
            return yield* new VectorShapeMismatch({
              collection: input.collection, id: doc.id, field: embedding.field,
              reason: `${wrong}, so the schema's declarations were not applied`,
            });
          }
        }
        if (recorded.rederive) yield* rederived(recorded.collection);
        return { applied: recorded.applied, skipped: recorded.skipped, documents };
      }),

    rebuildVectorIndex: (input) =>
      Effect.gen(function* () {
        const collection = yield* loadCollection(input.collection);
        if (collection === undefined) return yield* new CollectionNotFound({ name: input.collection });
        if (collection.embedding === undefined) return yield* new UnembeddedCollection({ collection: input.collection });
        return yield* rebuildIndex(input.collection, collection.embedding);
      }),

    dropVectorIndex: (input) =>
      Effect.gen(function* () {
        const collection = yield* loadCollection(input.collection);
        if (collection === undefined) return yield* new CollectionNotFound({ name: input.collection });
        return projectionIndexes.delete(input.collection);
      }),

    addReference: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        const reference = yield* normalizeReference(input.from, input);
        const seq = yield* lookup(collectionNs(), input.from);
        if (seq === undefined) return yield* new CollectionNotFound({ name: input.from });
        const recorded = yield* transactChecked((txn) =>
          Effect.gen(function* () {
            const current = yield* loadCollection(input.from);
            if (current === undefined) return "missing" as const;
            if ((current.references ?? []).some((other) => other.name === reference.name)) return "exists" as const;
            // A join reads the referencing field's own postings.
            if (!covers(current.columns, reference.path)) return "uncovered" as const;
            const withReference = { ...current, references: [...(current.references ?? []), reference] };
            if (reference.collection === input.from) {
              yield* collectionPut(txn, seq, {
                ...withReference,
                referencedBy: [...(current.referencedBy ?? []), { collection: input.from, reference: reference.name }],
              });
            } else {
              yield* collectionPut(txn, seq, withReference);
              yield* linkTargets(txn, input.from, [reference]);
            }
            return "added" as const;
          }));
        if (recorded === "missing") return yield* new CollectionNotFound({ name: input.from });
        if (recorded === "exists") return yield* new ConstraintExists({ collection: input.from, name: reference.name });
        if (recorded === "uncovered") {
          return yield* new InvalidConstraint({
            collection: input.from, name: reference.name,
            reason: `it reads ${reference.path}, which the collection's columns leave out; add it with setColumns first`,
          });
        }
        for (const held of yield* Stream.runCollect(resolveQuery(equals(collectionColumn(), input.from)))) {
          const doc = yield* readDocument(held);
          const value = doc === undefined ? undefined : readPath(doc.data, reference.path);
          if (doc === undefined || value === undefined || value === null) continue;
          const names = typeof value === "string" && (
            (reference.collection === input.from && value === doc.id) ||
            (yield* lookup(documentNs(reference.collection), value)) !== undefined);
          if (names) continue;
          yield* transactOrDie((txn) => unlinkReference(txn, input.from, reference.name));
          return yield* new ReferenceViolation({
            collection: input.from, id: doc.id, reference: reference.name,
            reason: `${reference.path} holds ${JSON.stringify(value)}, which names no document in "${reference.collection}", so the reference was not added`,
          });
        }
        return reference;
      }),

    dropReference: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        if ((yield* lookup(collectionNs(), input.collection)) === undefined) {
          return yield* new CollectionNotFound({ name: input.collection });
        }
        return yield* transactOrDie((txn) => unlinkReference(txn, input.collection, input.name));
      }),

    dropCheck: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        const seq = yield* lookup(collectionNs(), input.collection);
        if (seq === undefined) return yield* new CollectionNotFound({ name: input.collection });
        return yield* transactOrDie((txn) =>
          Effect.gen(function* () {
            const current = yield* loadCollection(input.collection);
            const checks = current?.checks ?? [];
            if (current === undefined || !checks.some((check) => check.name === input.name)) return false;
            yield* collectionPut(txn, seq, { ...current, checks: checks.filter((check) => check.name !== input.name) });
            return true;
          }));
      }),

    write: (input) =>
      Effect.gen(function* () {
        const replay = (input as ReplayHistoryInput)[REPLAY_HISTORY];
        if (replay !== undefined) {
          if (!isReplayRequest(replay) || !Array.isArray(input.operations) || input.operations.length !== 0
            || (input.emit ?? []).length !== 0 || input.idempotencyKey !== undefined
            || (input as WriteAlongInput)[WRITE_ALONG] !== undefined || (input as CarryDocumentsInput)[CARRY_DOCUMENTS] !== undefined) {
            return yield* Effect.die(new RangeError(`A history replay is one request of 1 to ${MAX_BATCH} changes or ids, and nothing else.`));
          }
          return replay._tag === "Changes" ? yield* replayChanges(replay.changes) : yield* settleReplayed(replay.collection, replay.ids);
        }
        const operations = input.operations;
        const emit = input.emit ?? [];
        const along = (input as WriteAlongInput)[WRITE_ALONG];
        const carry = (input as CarryDocumentsInput)[CARRY_DOCUMENTS];
        if (!Array.isArray(operations) || !Array.isArray(emit)
          || (operations.length + emit.length === 0 && along === undefined) || operations.length > MAX_BATCH) {
          return yield* Effect.die(
            new RangeError(`A batch takes 1 to ${MAX_BATCH} changes or messages, not ${operations?.length}.`),
          );
        }
        if (carry !== undefined && (!Array.isArray(carry) || carry.length !== operations.length
          || carry.some((entry) => entry !== undefined && !isCarriedDocument(entry)))) {
          return yield* Effect.die(new RangeError("Carried documents name one version and two times per operation."));
        }
        for (const operation of operations) {
          if (operation._tag !== "Delete") yield* validateDocumentData(operation.collection, operation.data);
        }
        // Settled before the transaction, like an insert's id: a message's id
        // and time are what it was emitted with, whenever the batch commits.
        const messages = yield* settleMessages(emit);
        const request = `write ${operations.length} documents${emit.length === 0 ? "" : ` and ${emit.length} messages`}`;
        const fingerprint = fingerprintOf(emit.length === 0 ? { op: "write", operations } : { op: "write", operations, emit });
        if (input.idempotencyKey !== undefined) {
          const seen = yield* receiptFor(input.idempotencyKey, fingerprint, request);
          if (seen !== undefined) return seen.result as ReadonlyArray<DocumentWritten>;
        }
        // Public ids are settled once. Dense identifiers are allocated by the
        // transaction itself, so a bulk insert is one commit rather than one
        // allocation commit per entry followed by the data commit.
        const ids = operations.map((operation) =>
          operation._tag === "Insert" ? operation.id ?? crypto.randomUUID() : operation.id);
        return yield* commitOnce(input.idempotencyKey, fingerprint, request, (txn) =>
          Effect.gen(function* () {
            // One overlay for the batch: each change sees what the ones before
            // it wrote, which is what makes them one change rather than several.
            const pending = nothingPending();
            const written: Array<DocumentWritten> = [];
            for (const [at, operation] of operations.entries()) {
              if (operation._tag === "Insert") {
                const document = yield* applyInsert(txn, pending, {
                  collection: operation.collection, id: ids[at]!, data: operation.data,
                  ...(operation.expiresAt === undefined ? {} : { expiresAt: operation.expiresAt }),
                  ...(operation.ttlMs === undefined ? {} : { ttlMs: operation.ttlMs }),
                }, yield* txn.allocate, carry?.[at]);
                written.push({ _tag: "Inserted", document });
                continue;
              }
              if (operation._tag === "Update") {
                written.push({ _tag: "Updated", document: yield* applyUpdate(txn, pending, operation) });
                continue;
              }
              if (operation._tag === "Upsert") {
                const current = yield* currentNamed(pending, operation.collection, operation.id);
                if (current === undefined || current.document === null) {
                  if (operation.expectedVersion !== undefined) {
                    return yield* new DocumentConflict({
                      collection: operation.collection,
                      id: operation.id,
                      reason: `expected version ${operation.expectedVersion}, but the document does not exist`,
                    });
                  }
                  const document = yield* applyInsert(txn, pending, operation, yield* txn.allocate);
                  written.push({ _tag: "Inserted", document });
                } else {
                  const document = yield* applyUpdate(txn, pending, {
                    ...operation,
                    mode: "replace",
                  });
                  written.push({ _tag: "Updated", document });
                }
                continue;
              }
              written.push({
                _tag: "Deleted", collection: operation.collection, id: operation.id,
                deleted: yield* applyDelete(txn, pending, operation),
              });
            }
            // In the same transaction as the changes: the outbox holds these
            // messages exactly when the store holds what they describe.
            yield* recordMessages(store, txn, messages);
            // Its failures are the caller's own (it names them), so they pass through untyped here.
            if (along !== undefined) yield* (along(txn) as Effect.Effect<void, never>);
            return written as ReadonlyArray<DocumentWritten>;
          }));
      }),

    rewrite: (input) =>
      Effect.gen(function* () {
        yield* assertNotMoving;
        const names: Array<string> = [];
        if (input?.collection === undefined) {
          for (const seq of yield* Stream.runCollect(
            resolveQuery(equals(collectionColumn(), COLLECTION_MARKER)),
          )) {
            const object = yield* readObject(seq);
            if (object !== undefined) names.push(decode(object.bytes, collectionRecord).name);
          }
        } else {
          yield* requireCollection(input.collection);
          names.push(input.collection);
        }
        let documents = 0;
        for (const name of names) documents += yield* rewriteDocuments(name);
        return { collections: names.length, documents };
      }),

    forgetIdempotencyKeys: (input) =>
      Effect.gen(function* () {
        const seqs = yield* Stream.runCollect(
          resolveQuery(equals(idempotencyColumn(), RECEIPT_MARKER)),
        );
        let forgotten = 0;
        for (const seq of seqs) {
          if (input?.before !== undefined) {
            const object = yield* readObject(seq);
            if (object === undefined) continue;
            if (decode(object.bytes, receiptRecord).at >= input.before) continue;
          }
          yield* write((txn) => txn.retract(seq));
          forgotten += 1;
        }
        return forgotten;
      }),
  // A new DocumentsApi operation is also named in the list below, or this half of the API is not checked against it.
  } satisfies Pick<DocumentsApi, "createCollection" | "insert" | "update" | "delete" | "dropCollection" | "createIndex" | "dropIndex" | "addCheck" | "analyze" | "setColumns" | "locate" | "embed" | "declareFromSchema" | "rebuildVectorIndex" | "dropVectorIndex" | "addReference" | "dropReference" | "dropCheck" | "write" | "rewrite" | "forgetIdempotencyKeys">;
  return { operations };
};
