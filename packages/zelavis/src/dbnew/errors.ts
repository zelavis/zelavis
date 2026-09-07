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
 * A write arrived from a writer that is no longer current.
 *
 * Placement changes do not become safe merely because the stale and current
 * owners happen to share a Node. Only the current generation may append.
 */
export class WriterFenced extends Schema.TaggedError<WriterFenced>()("WriterFenced", {
  partition: Schema.String,
  claimed: Schema.Number,
  current: Schema.Number,
}) {}

/** A cursor was issued by a different partition than the one being read. */
export class ForeignCursor extends Schema.TaggedError<ForeignCursor>()("ForeignCursor", {
  expected: Schema.String,
  received: Schema.String,
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
  { collection: Schema.String, version: Schema.Number },
) {}

export class SchemaNotFound extends Schema.TaggedError<SchemaNotFound>()("SchemaNotFound", {
  collection: Schema.String,
  version: Schema.Number,
}) {}

/** A write did not satisfy the collection's active schema. */
export class SchemaViolation extends Schema.TaggedError<SchemaViolation>()("SchemaViolation", {
  collection: Schema.String,
  schemaVersion: Schema.Number,
  issues: Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String })),
}) {}

/** Every failure the store contract can raise. */
export type DbError = StoreError | WriterFenced | ForeignCursor | PartitionUnavailable;
