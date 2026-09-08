import type { TenantId } from "./topology.js";

export const COLLECTION_NAMESPACE_PREFIX = "zv.collection/";
export const DOCUMENT_NAMESPACE_PREFIX = "doc/";
export const SCHEMA_NAMESPACE = "zv.schema";
export const ACTIVE_SCHEMA_NAMESPACE = "zv.schema.active";
export const CHECKPOINT_NAMESPACE = "zv.checkpoint";

/**
 * Records what a completed write with an idempotency key did.
 *
 * Tenant-scoped like everything else, because the keys are the caller's own
 * strings and two tenants picking the same one is ordinary rather than an
 * error.
 */
export const IDEMPOTENCY_NAMESPACE_PREFIX = "zv.idempotency/";

/**
 * Marks a tenant on this shard as being relocated off it.
 *
 * Lives on the shard being left rather than in the topology, because the check
 * that has to see it is the write path, and the write path already has the
 * store in its hand.
 */
export const MOVE_FENCE_NAMESPACE = "zv.moving";

/** Records that a tenant holds data on this shard, so a shard can name its occupants. */
export const TENANT_NAMESPACE = "zv.tenant";
export const TENANT_COLUMN = "zv.tenant";
export const TENANT_MARKER = "\u0000tenant";

/**
 * Which tenant a stored record belongs to, from where it was written.
 *
 * Tenancy is carried by the namespace rather than a field, so this is the one
 * place that knows how to read it back. Records with no owner are either
 * derived — points, checkpoints — or not tenant data at all.
 */
export const tenantOf = (namespace: string, key: string): TenantId | undefined => {
  if (namespace.startsWith(COLLECTION_NAMESPACE_PREFIX)) {
    return namespace.slice(COLLECTION_NAMESPACE_PREFIX.length);
  }
  if (namespace.startsWith(IDEMPOTENCY_NAMESPACE_PREFIX)) {
    return namespace.slice(IDEMPOTENCY_NAMESPACE_PREFIX.length);
  }
  if (namespace.startsWith(DOCUMENT_NAMESPACE_PREFIX)) {
    const rest = namespace.slice(DOCUMENT_NAMESPACE_PREFIX.length);
    const split = rest.indexOf("/");
    return split < 0 ? undefined : rest.slice(0, split);
  }
  if (namespace === SCHEMA_NAMESPACE || namespace === ACTIVE_SCHEMA_NAMESPACE) {
    const split = key.indexOf("/");
    return split < 0 ? undefined : key.slice(0, split);
  }
  return undefined;
};

/**
 * State that is rebuilt rather than carried.
 *
 * A checkpoint is a position in one shard's log and means nothing against
 * another, so moving one would point a projection at an unrelated offset. Time
 * series points are written without identity and are replayable from the events
 * that produced them.
 */
export const isDerivedNamespace = (namespace: string): boolean =>
  namespace === CHECKPOINT_NAMESPACE;
