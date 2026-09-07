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

/** Every failure the store contract can raise. */
export type DbError = StoreError | WriterFenced | ForeignCursor | PartitionUnavailable;
