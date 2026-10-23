/**
 * The names records are filed under inside a partition.
 *
 * A partition is one tenant — or one part of a divided tenant, or one of the
 * reserved partitions — and everything it stores lives in that partition's
 * own key range. So none of these names carries the tenant: two tenants'
 * `posts` are different collections because they are in different partitions,
 * not because their names differ.
 */
export const COLLECTION_NAMESPACE = "zv.collection";
export const DOCUMENT_NAMESPACE_PREFIX = "doc/";
export const SCHEMA_NAMESPACE = "zv.schema";
export const ACTIVE_SCHEMA_NAMESPACE = "zv.schema.active";
export const CHECKPOINT_NAMESPACE = "zv.checkpoint";

/**
 * Where each time series keeps its generation and how far into the log it has
 * read: a cursor too, so derived like a checkpoint, and rebuilt by the next
 * ingest after a restore rather than carried into a log it does not describe.
 */
export const TIME_SERIES_STATE_NAMESPACE = "zv.timeseries.state";

/** Where one collection's documents are named. */
export const documentNamespace = (collection: string): string => `${DOCUMENT_NAMESPACE_PREFIX}${collection}`;

/** Records what a completed write with an idempotency key did. */
export const IDEMPOTENCY_NAMESPACE = "zv.idempotency";

/** The tenant's outbox: one record per message, keyed by the message's id. */
export const OUTBOX_NAMESPACE = "zv.outbox";


/** The collection a record's name belongs to, for collections and their documents alike. */
export const collectionOfIdentity = (namespace: string, key: string): string | undefined =>
  namespace === COLLECTION_NAMESPACE
    ? key
    : namespace.startsWith(DOCUMENT_NAMESPACE_PREFIX)
      ? namespace.slice(DOCUMENT_NAMESPACE_PREFIX.length)
      : undefined;

/**
 * State that is rebuilt rather than carried by a backup.
 *
 * A checkpoint is a position in its partition's log. A move keeps those
 * positions, so it carries checkpoints with everything else; a restore starts a
 * new log, where an old position would point a projection at an unrelated
 * entry.
 */
export const isDerivedNamespace = (namespace: string): boolean =>
  namespace === CHECKPOINT_NAMESPACE || namespace === TIME_SERIES_STATE_NAMESPACE;
