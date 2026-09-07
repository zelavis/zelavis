import type { TenantId } from "./topology.js";

export const COLLECTION_NAMESPACE_PREFIX = "zv.collection/";
export const DOCUMENT_NAMESPACE_PREFIX = "doc/";
export const SCHEMA_NAMESPACE = "zv.schema";
export const ACTIVE_SCHEMA_NAMESPACE = "zv.schema.active";
export const CHECKPOINT_NAMESPACE = "zv.checkpoint";

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
