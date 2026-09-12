import { Schema } from "effect";

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
 * records nobody reads again, so it is refused instead. Reads are unaffected:
 * the source still holds the data until routing moves, and the target holds it
 * afterwards.
 */
export class TenantMoving extends Schema.TaggedError<TenantMoving>()("TenantMoving", {
  tenant: Schema.String,
  from: Schema.String,
  to: Schema.String,
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

/** A spatial filter named a field the collection's index does not cover. */
export class UnindexedGeometry extends Schema.TaggedError<UnindexedGeometry>()("UnindexedGeometry", {
  collection: Schema.String,
  field: Schema.String,
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

export class ProjectionNotFound extends Schema.TaggedError<ProjectionNotFound>()(
  "ProjectionNotFound",
  { name: Schema.String },
) {}

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

export class BackupTenantMismatch extends Schema.TaggedError<BackupTenantMismatch>()(
  "BackupTenantMismatch",
  { expected: Schema.String, received: Schema.String },
) {}

/** Restoring over live data would orphan whatever the tenant already holds. */
export class TenantNotEmpty extends Schema.TaggedError<TenantNotEmpty>()("TenantNotEmpty", {
  tenant: Schema.String,
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

/** Every failure the store contract can raise. */
export type DbError =
  | StoreError
  | WriterFenced
  | ForeignCursor
  | CursorCompacted
  | LogCompacted
  | PartitionUnavailable;
