import { Effect, Schema } from "effect";

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  op: Schema.String,
  cause: Schema.Defect(),
}) {}

export class PartitionUnavailable extends Schema.TaggedError<PartitionUnavailable>()(
  "PartitionUnavailable",
  {
    partition: Schema.String,
    reason: Schema.String,
  },
) {}

/**
 * Raised when a query would have to leave its partition.
 *
 * Cross-partition resolution is deliberately explicit rather than silent: the
 * cost is real and grows with the width of the widest predicate, so a caller
 * should have to ask for it.
 */
export class CrossPartitionQuery extends Schema.TaggedError<CrossPartitionQuery>()(
  "CrossPartitionQuery",
  {
    detail: Schema.String,
  },
) {}

/**
 * A migration was asked for that the caller has not finished describing.
 *
 * Raised before anything is activated or written. A new required field, a field
 * whose type changed, one that became required — none of these can be filled in
 * from the schemas alone, and guessing would write data nobody asked for.
 */
export class SchemaMigrationBlocked extends Schema.TaggedError<SchemaMigrationBlocked>()(
  "SchemaMigrationBlocked",
  {
    tenant: Schema.String,
    collection: Schema.String,
    from: Schema.Finite,
    to: Schema.Finite,
    unresolved: Schema.Array(Schema.String),
  },
) {}

/**
 * An idempotency key came back attached to a different request.
 *
 * A key stands for one operation and the outcome it had. Answering a different
 * request with that outcome would be worse than doing the work twice: the
 * caller would be told something happened that did not.
 */
/**
 * A message was emitted with an id the tenant's outbox already holds.
 *
 * Refused rather than replaced: a consumer that has the message may have acted
 * on it, and a second message under its id would be lost to every consumer
 * that deduplicates by id — which is what the id is for.
 */
export class MessageExists extends Schema.TaggedError<MessageExists>()("MessageExists", {
  id: Schema.String,
}) {}

/** A message that cannot be one: an empty or overlong topic or id, or a payload that is not JSON. */
export class InvalidMessage extends Schema.TaggedError<InvalidMessage>()("InvalidMessage", {
  reason: Schema.String,
}) {}

export class IdempotencyKeyReused extends Schema.TaggedError<IdempotencyKeyReused>()(
  "IdempotencyKeyReused",
  {
    tenant: Schema.String,
    key: Schema.String,
    detail: Schema.String,
  },
) {}

/**
 * A write arrived for a tenant whose records are being relocated.
 *
 * A move copies a tenant to another shard and then changes where it routes.
 * Between those two moments a write to the shard being left would land in
 * records nobody reads again, so the store refuses it — every change to the
 * fenced partition, whichever layer makes it. Reads are unaffected:
 * the source still holds the data until routing moves, and the target holds it
 * afterwards.
 */
export class TenantMoving extends Schema.TaggedError<TenantMoving>()("TenantMoving", {
  tenant: Schema.String,
  from: Schema.String,
  to: Schema.String,
}) {}

/**
 * A call reached a shard a tenant has left, routed by a map older than the move.
 *
 * Once a move has cleared the source, what is left there is empty, and an
 * empty answer would read as an empty tenant. The shard keeps the map version
 * that moved the tenant away instead, and refuses a call routed by any older
 * map: refresh routing to at least `mapVersion` and send the call again. It
 * names no shard to go to, because routing, not the shard left behind, says
 * where the tenant lives.
 */
export class TenantRelocated extends Schema.TaggedError<TenantRelocated>()("TenantRelocated", {
  partition: Schema.String,
  shard: Schema.String,
  /** The partition-map version that moved the tenant off this shard. */
  mapVersion: Schema.Finite,
  /** The map version the refused call was routed by. */
  routedBy: Schema.Finite,
}) {
  override get message() {
    return `"${this.partition}" left shard "${this.shard}" at partition-map version ${this.mapVersion}; ` +
      `this call was routed by version ${this.routedBy}. Refresh routing and retry.`;
  }
}

/**
 * A divided tenant was addressed as a whole.
 *
 * There is no one shard to answer for it, and answering from one part would
 * describe a fraction of the tenant as though it were all of it. Address a
 * part with `forPart`, or scatter over its parts.
 */
export class TenantDivided extends Schema.TaggedError<TenantDivided>()("TenantDivided", {
  tenant: Schema.String,
  parts: Schema.Array(Schema.String),
}) {
  // Thrown synchronously by `forTenant`, so it has to read on its own.
  override get message() {
    return `Tenant "${this.tenant}" is divided into ${this.parts.join(", ")}; use forPart, or scatter over its parts.`;
  }
}

/** A part was named that the tenant is not divided into, or a tenant that is not divided at all. */
export class UnknownPart extends Schema.TaggedError<UnknownPart>()("UnknownPart", {
  tenant: Schema.String,
  part: Schema.String,
  parts: Schema.Array(Schema.String),
}) {
  // Thrown synchronously by `forPart`, so it has to read on its own.
  override get message() {
    return this.parts.length === 0
      ? `Tenant "${this.tenant}" is not divided, so it has no part "${this.part}".`
      : `Tenant "${this.tenant}" has no part "${this.part}"; it is divided into ${this.parts.join(", ")}.`;
  }
}

/**
 * A move stopped because its copy did not match the source.
 *
 * Checked with writes fenced, just before routing would move, and the last
 * moment it can be: afterwards the source is cleared and a copy that came up
 * short would surface later as missing records, with nothing left to compare
 * against. Routing has not moved and the source is intact; the tenant stays
 * fenced until the move is resumed, which copies it again from scratch.
 */
export class TenantMoveFailed extends Schema.TaggedError<TenantMoveFailed>()("TenantMoveFailed", {
  tenant: Schema.String,
  from: Schema.String,
  to: Schema.String,
  reason: Schema.String,
}) {}

/**
 * A move routed a tenant to its new shard, but calls that reached the old shard
 * before routing moved were still running when the move stopped waiting.
 *
 * Routing has moved and the tenant takes writes on its new shard. The old
 * shard still holds the tenant, fenced, so those calls read whole data and any
 * write among them is refused; it is cleared once they finish, by resuming the
 * move.
 */
export class PlacementInUse extends Schema.TaggedError<PlacementInUse>()("PlacementInUse", {
  partition: Schema.String,
  shard: Schema.String,
  calls: Schema.Finite,
}) {}

/**
 * A scatter was pointed at a shard the partition map does not have.
 *
 * Reading the shards that do exist and staying quiet about the one that does
 * not would answer a narrower question than the caller asked, and look exactly
 * like the answer to the question they asked.
 */
export class UnknownShard extends Schema.TaggedError<UnknownShard>()("UnknownShard", {
  shard: Schema.String,
  known: Schema.Array(Schema.String),
}) {}

/**
 * A write arrived from a writer that is no longer current.
 *
 * Placement changes do not become safe merely because the stale and current
 * owners happen to share a Node. Only the current generation may append.
 */
export class WriterFenced extends Schema.TaggedError<WriterFenced>()("WriterFenced", {
  partition: Schema.String,
  claimed: Schema.Finite,
  current: Schema.Finite,
}) {}

/** A cursor was issued by a different partition than the one being read. */
export class ForeignCursor extends Schema.TaggedError<ForeignCursor>()("ForeignCursor", {
  expected: Schema.String,
  received: Schema.String,
}) {}

/**
 * A cursor handed to an ordered read it did not come from.
 *
 * A position in one order means nothing in another: continuing a descending
 * read of one column from a cursor left by an ascending read of another would
 * return a page that looks plausible and skips or repeats rows.
 */
export class CursorMismatch extends Schema.TaggedError<CursorMismatch>()("CursorMismatch", {
  reason: Schema.String,
}) {}

/** An order the store cannot serve from an index, refused rather than sorted in memory. */
export class UnsupportedOrdering extends Schema.TaggedError<UnsupportedOrdering>()(
  "UnsupportedOrdering",
  { reason: Schema.String },
) {}

/** An index definition that cannot be built: a bad name, no fields, or a field given twice. */
export class InvalidIndex extends Schema.TaggedError<InvalidIndex>()("InvalidIndex", {
  collection: Schema.String,
  name: Schema.String,
  reason: Schema.String,
}) {}

/** An index name already in use on the collection, over different fields. */
export class IndexExists extends Schema.TaggedError<IndexExists>()("IndexExists", {
  collection: Schema.String,
  name: Schema.String,
  reason: Schema.String,
}) {}

/** A second document with the values a unique index already has one document holding. */
export class UniqueViolation extends Schema.TaggedError<UniqueViolation>()("UniqueViolation", {
  collection: Schema.String,
  index: Schema.String,
  id: Schema.String,
  /** The document already holding them. */
  holder: Schema.String,
}) {}

/** A document a check constraint of its collection does not allow. */
export class CheckViolation extends Schema.TaggedError<CheckViolation>()("CheckViolation", {
  collection: Schema.String,
  id: Schema.String,
  check: Schema.String,
  reason: Schema.String,
}) {}

/**
 * A reference that does not hold: a document naming one that does not exist,
 * or a delete of a document others name under a reference that restricts it.
 */
export class ReferenceViolation extends Schema.TaggedError<ReferenceViolation>()("ReferenceViolation", {
  collection: Schema.String,
  id: Schema.String,
  reference: Schema.String,
  reason: Schema.String,
}) {}

/** A constraint definition that cannot be enforced as given. */
export class InvalidConstraint extends Schema.TaggedError<InvalidConstraint>()("InvalidConstraint", {
  collection: Schema.String,
  name: Schema.String,
  reason: Schema.String,
}) {}

/** A search asked of a collection that declares no analyzer, so it has no terms. */
export class UnanalyzedCollection extends Schema.TaggedError<UnanalyzedCollection>()(
  "UnanalyzedCollection",
  { collection: Schema.String },
) {}

/**
 * A query or an order named a field its collection does not index.
 *
 * A collection that declares `columns` indexes only those fields, which is what
 * keeps a wide document from writing an index entry per field. An equality, a
 * range or an order on any other field would have nothing to read but every
 * document in the collection, so it is refused rather than run as a scan.
 */
export class UnindexedField extends Schema.TaggedError<UnindexedField>()("UnindexedField", {
  collection: Schema.String,
  path: Schema.String,
}) {}

/** A spatial filter named a field the collection's index does not cover. */
export class UnindexedGeometry extends Schema.TaggedError<UnindexedGeometry>()("UnindexedGeometry", {
  collection: Schema.String,
  field: Schema.String,
}) {}

/** A similarity read on a collection that declares no embedding. */
export class UnembeddedCollection extends Schema.TaggedError<UnembeddedCollection>()(
  "UnembeddedCollection",
  { collection: Schema.String },
) {}

/** A vector whose shape the collection's embedding does not allow. */
export class VectorShapeMismatch extends Schema.TaggedError<VectorShapeMismatch>()("VectorShapeMismatch", {
  collection: Schema.String,
  id: Schema.String,
  field: Schema.String,
  reason: Schema.String,
}) {}

/** A similarity read whose own vector the collection's embedding does not admit. */
export class InvalidVectorQuery extends Schema.TaggedError<InvalidVectorQuery>()("InvalidVectorQuery", {
  collection: Schema.String,
  field: Schema.String,
  reason: Schema.String,
}) {}

/** A read asked for a measure the collection does not declare. */
export class UnknownMeasure extends Schema.TaggedError<UnknownMeasure>()("UnknownMeasure", {
  collection: Schema.String,
  name: Schema.String,
}) {}

/** A read asked to follow an edge the collection does not declare. */
export class UnknownEdge extends Schema.TaggedError<UnknownEdge>()("UnknownEdge", {
  collection: Schema.String,
  name: Schema.String,
}) {}

/** A read asked about a reference the collection does not declare. */
export class UnknownReference extends Schema.TaggedError<UnknownReference>()("UnknownReference", {
  collection: Schema.String,
  name: Schema.String,
}) {}

/** A constraint name already in use on the collection. */
export class ConstraintExists extends Schema.TaggedError<ConstraintExists>()("ConstraintExists", {
  collection: Schema.String,
  name: Schema.String,
}) {}

export class InvalidCollectionName extends Schema.TaggedError<InvalidCollectionName>()(
  "InvalidCollectionName",
  { name: Schema.String, reason: Schema.String },
) {}

export class CollectionExists extends Schema.TaggedError<CollectionExists>()("CollectionExists", {
  name: Schema.String,
}) {}

export class CollectionNotFound extends Schema.TaggedError<CollectionNotFound>()(
  "CollectionNotFound",
  { name: Schema.String },
) {}

export class DocumentNotFound extends Schema.TaggedError<DocumentNotFound>()("DocumentNotFound", {
  collection: Schema.String,
  id: Schema.String,
}) {}

/** Duplicate insert, or a failed optimistic-concurrency guard. */
export class DocumentConflict extends Schema.TaggedError<DocumentConflict>()("DocumentConflict", {
  collection: Schema.String,
  id: Schema.String,
  reason: Schema.String,
}) {}

/** No cross-Tenant index has this name. */
export class CrossTenantIndexNotFound extends Schema.TaggedError<CrossTenantIndexNotFound>()(
  "CrossTenantIndexNotFound",
  { name: Schema.String },
) {}

/** A cross-Tenant index with this name already exists; drop it to define it differently. */
export class CrossTenantIndexExists extends Schema.TaggedError<CrossTenantIndexExists>()(
  "CrossTenantIndexExists",
  { name: Schema.String },
) {}

/** A cross-Tenant index definition that cannot be built as given. */
export class InvalidCrossTenantIndex extends Schema.TaggedError<InvalidCrossTenantIndex>()(
  "InvalidCrossTenantIndex",
  { name: Schema.String, reason: Schema.String },
) {}

export class ProjectionNotFound extends Schema.TaggedError<ProjectionNotFound>()(
  "ProjectionNotFound",
  { name: Schema.String },
) {}

/** A scalar document field cannot be represented by the ordered index. */
export class InvalidDocumentValue extends Schema.TaggedError<InvalidDocumentValue>()("InvalidDocumentValue", {
  collection: Schema.String,
  path: Schema.String,
  reason: Schema.String,
}) {}

export class SchemaVersionExists extends Schema.TaggedError<SchemaVersionExists>()(
  "SchemaVersionExists",
  { collection: Schema.String, version: Schema.Finite },
) {}

export class SchemaNotFound extends Schema.TaggedError<SchemaNotFound>()("SchemaNotFound", {
  collection: Schema.String,
  version: Schema.Finite,
}) {}

/** A write did not satisfy the collection's active schema. */
export class SchemaViolation extends Schema.TaggedError<SchemaViolation>()("SchemaViolation", {
  collection: Schema.String,
  schemaVersion: Schema.Finite,
  issues: Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String })),
}) {}

export class TimeSeriesNotFound extends Schema.TaggedError<TimeSeriesNotFound>()(
  "TimeSeriesNotFound",
  { name: Schema.String },
) {}

/**
 * A time series' mapper threw, or returned a point that cannot be stored — a
 * timestamp that is not one, a value that is not a finite number, a tag that
 * is not a string. Nothing of the batch holding that event is written, and the
 * series stays where its last committed batch left it, so fixing the mapper
 * and ingesting again picks up at that event.
 */
export class TimeSeriesMapFailed extends Schema.TaggedError<TimeSeriesMapFailed>()("TimeSeriesMapFailed", {
  series: Schema.String,
  eventId: Schema.String,
  reason: Schema.String,
}) {}

export class BackupTenantMismatch extends Schema.TaggedError<BackupTenantMismatch>()(
  "BackupTenantMismatch",
  { expected: Schema.String, received: Schema.String },
) {}

/**
 * A Tenant cannot be removed: it is reserved, divided into parts, mid-relocation, or holds nothing.
 *
 * Refused rather than half done: removal is the one operation that cannot be undone, so it never guesses.
 */
export class TenantNotDroppable extends Schema.TaggedError<TenantNotDroppable>()("TenantNotDroppable", {
  tenant: Schema.String,
  reason: Schema.String,
}) {}

/** Restoring over live data would orphan whatever the tenant already holds. */
export class TenantNotEmpty extends Schema.TaggedError<TenantNotEmpty>()("TenantNotEmpty", {
  tenant: Schema.String,
}) {}

/**
 * A restore named a mode it does not have.
 *
 * Refused rather than read as one of them: each mode does something different
 * to the data already there, and a guess is how a restore purges what it was
 * meant to keep or replays over what it was meant to refuse.
 */
export class InvalidRestoreMode extends Schema.TaggedError<InvalidRestoreMode>()("InvalidRestoreMode", {
  mode: Schema.String,
}) {}

export class BackupFormatUnsupported extends Schema.TaggedError<BackupFormatUnsupported>()(
  "BackupFormatUnsupported",
  { format: Schema.String },
) {}

export class PartitionMapInvalid extends Schema.TaggedError<PartitionMapInvalid>()(
  "PartitionMapInvalid",
  { version: Schema.Finite, reason: Schema.String },
) {}

/** A placement change would move a range that tenants are standing on. */
export class RangeNotEmpty extends Schema.TaggedError<RangeNotEmpty>()("RangeNotEmpty", {
  range: Schema.Finite,
  from: Schema.String,
  to: Schema.String,
  tenants: Schema.Array(Schema.String),
}) {}

export class PlacementCatalogInvalid extends Schema.TaggedError<PlacementCatalogInvalid>()(
  "PlacementCatalogInvalid",
  { version: Schema.Finite, reason: Schema.String },
) {}

/**
 * A tenant cannot be divided the way it was asked to be.
 *
 * Dividing is a routing decision and carries no data, so it is refused for a
 * tenant that already holds some: the records would stay under the undivided
 * key while every read went to a part that does not hold them.
 */
export class SubdivisionInvalid extends Schema.TaggedError<SubdivisionInvalid>()(
  "SubdivisionInvalid",
  { tenant: Schema.String, reason: Schema.String },
) {}

/**
 * A collection already has a placement class, and it is not the one asked for.
 *
 * Reclassifying is a relocation rather than a catalog edit, for the same reason
 * `topology.update` refuses an occupied range: the catalog carries routing and
 * no data, so the records would stay where they were while reads went elsewhere.
 */
export class PlacementImmutable extends Schema.TaggedError<PlacementImmutable>()(
  "PlacementImmutable",
  { collection: Schema.String, current: Schema.String, requested: Schema.String },
) {}

/**
 * A replicated collection holds something a copy cannot carry.
 *
 * Identity survives replication and identifiers do not: a replica reallocates
 * every `Seq` in its own dense space. Anything that names a record by `Seq` —
 * an edge, above all — would therefore point somewhere else on every copy, so
 * it is refused here rather than written wrong on every shard.
 */
export class ReplicationUnsupported extends Schema.TaggedError<ReplicationUnsupported>()(
  "ReplicationUnsupported",
  { collection: Schema.String, reason: Schema.String },
) {}

export class UnknownSystemView extends Schema.TaggedError<UnknownSystemView>()(
  "UnknownSystemView",
  { name: Schema.String },
) {}

/** A cursor points into history that compaction has removed. */
export class CursorCompacted extends Schema.TaggedError<CursorCompacted>()("CursorCompacted", {
  partition: Schema.String,
  requested: Schema.Finite,
  compactedTo: Schema.Finite,
}) {}

/** A full replay was asked for on a log that no longer holds its beginning. */
export class LogCompacted extends Schema.TaggedError<LogCompacted>()("LogCompacted", {
  partition: Schema.String,
  compactedTo: Schema.Finite,
}) {}

/**
 * A partition has handed out every identifier, or used every log position, it
 * can.
 *
 * Identifiers are never reused, so a partition that creates and deletes
 * constantly runs through them faster than it grows. Refused rather than
 * wrapped: a wrapped identifier would name a record that already exists, and a
 * wrapped position an event already logged.
 */
export class PartitionExhausted extends Schema.TaggedError<PartitionExhausted>()("PartitionExhausted", {
  partition: Schema.String,
  resource: Schema.Literals(["identifiers", "log"]),
  limit: Schema.Finite,
}) {}

/**
 * A follower was handed an event past the next position in its log.
 *
 * Applying it would leave a hole that nothing ever fills, and the follower
 * would report a history it does not have.
 */
export class EventGap extends Schema.TaggedError<EventGap>()("EventGap", {
  partition: Schema.String,
  expected: Schema.Finite,
  received: Schema.Finite,
}) {}

/**
 * A follower already holds a different event at the position it was handed.
 *
 * Two logs that disagree about one position are two histories, and skipping
 * the event as a duplicate would hide that.
 */
export class ReplicaDiverged extends Schema.TaggedError<ReplicaDiverged>()("ReplicaDiverged", {
  partition: Schema.String,
  position: Schema.Finite,
}) {}

/**
 * A partition's lenses are being rebuilt or reindexed, or a run that was doing
 * so was interrupted and has not been resumed.
 *
 * Rebuilding runs in many batches under the partition's writer, so between the
 * first and the last its lenses — and, for a rebuild, its records — are partly
 * cleared. Reads and writes are refused for that time rather than answered from
 * half an index; reopening the database resumes an interrupted run.
 */
export class LensesRebuilding extends Schema.TaggedError<LensesRebuilding>()("LensesRebuilding", {
  partition: Schema.String,
  operation: Schema.Literals(["rebuild", "reindex"]),
}) {}

/** Every failure the store contract can raise. */
export type DbError =
  | StoreError
  | WriterFenced
  | ForeignCursor
  | CursorCompacted
  | LogCompacted
  | PartitionUnavailable
  | PartitionExhausted
  | LensesRebuilding
  | TenantRelocated
  | TenantMoving;

/**
 * Every store failure but a move's fence, which is the one a caller above the
 * store can act on. Keyed by tag so that a store failure added to `DbError`
 * without a place here does not compile.
 */
const STORE_DEFECTS: { readonly [Tag in Exclude<DbError, TenantMoving>["_tag"]]: true } = {
  StoreError: true,
  WriterFenced: true,
  ForeignCursor: true,
  CursorCompacted: true,
  LogCompacted: true,
  PartitionUnavailable: true,
  PartitionExhausted: true,
  LensesRebuilding: true,
  // The in-process router routes every call by the map in force, which is never
  // older than a move it made, so reaching a relocated partition here is a
  // broken invariant. A caller routing by a map of its own sees it typed, at
  // the store.
  TenantRelocated: true,
};

/**
 * A store's failures as defects, but for `TenantMoving`: a write refused while
 * its tenant is being moved is the caller's to see, and succeeds once routing
 * points at the new shard. Anything else a store fails with is a broken engine
 * or a broken invariant. Failures that are not the store's pass through.
 */
export const dieUnlessMoving = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, Exclude<DbError, TenantMoving>>, R> =>
  Effect.catch(effect, (error) =>
    Object.hasOwn(STORE_DEFECTS, error._tag)
      ? Effect.die(error)
      : Effect.fail(error as Exclude<E, Exclude<DbError, TenantMoving>>));
