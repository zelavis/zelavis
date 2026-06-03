import type { DatabaseCollection } from "#/lib/runtime-api";

export const INTERNAL_DATABASE_COLLECTION_NAMES = new Set(["zelavis_system"]);

export function isInternalDatabaseCollection(name: string) {
  return INTERNAL_DATABASE_COLLECTION_NAMES.has(name);
}

export function filterUserDatabaseCollections(
  collections: readonly DatabaseCollection[],
) {
  return collections.filter((collection) => !isInternalDatabaseCollection(collection.name));
}

/**
 * Returns true if a collection belongs to Content Studio (i.e. was created as
 * a content type, not as a raw database table).
 *
 * Requires explicit `metadata.surface === "content-studio"`. Collections without
 * this metadata are excluded — there is no backward compatibility shim.
 */
export function isContentTypeDatabaseCollection(collection: DatabaseCollection) {
  return collection.metadata?.surface === "content-studio";
}
