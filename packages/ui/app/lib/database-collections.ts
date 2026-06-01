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
